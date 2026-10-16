/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { JsonLineProcess, withTimeout } from './agentProcess';
import { codexEvents, codexModels, codexUsage, type AgentEvent } from './agentProtocol';
import type { AgentBackend, AgentSession, TurnInput } from './agents';
import type { AgentUsage, ChatModel } from './chatProtocol';

/**
 * Codex, driven as its own VS Code extension drives it: `codex app-server`,
 * JSON-RPC 2.0 over stdio.
 *
 * **One process serves every conversation in the window**, each a `thread`.
 * `thread/start` makes one, `turn/start` sends a message, `turn/steer` adds to
 * a running turn, `turn/interrupt` stops it. The model and the effort are
 * parameters of `turn/start`, so unlike Claude Code a change costs nothing.
 * Notifications name their `threadId`, which is how they are routed.
 *
 * The protocol is versioned with the CLI, and its schema can be generated from
 * whatever is installed: `codex app-server generate-json-schema --out <dir>`.
 * Read that rather than guessing a field.
 *
 * **Threads are read-only, and every approval is declined.** `sandbox:
 * 'read-only'` with `approvalPolicy: 'on-request'` means Codex asks before it
 * changes anything, and nothing here can answer yes yet — the decline is
 * reported in the chat so it is not silent. Approvals in the chat are the next
 * step.
 *
 * **`summary: 'auto'` on every turn**, or Codex sends no reasoning at all: the
 * `reasoning` item arrives empty. With it, `item/reasoning/summaryTextDelta`
 * streams the summary the chat shows as "Thinking".
 */
const requestTimeoutMs = 30_000;

/**
 * How long the app-server stays up once nothing needs it. Detection and the
 * usage popup start it and are done within a second; a conversation keeps it
 * up for as long as the chat holds that conversation. Thirty seconds spares a
 * restart when the user sends the first message right after opening the chat,
 * and still means the server does not outlive what it was started for.
 */
const idleShutdownMs = 30_000;

const threadSettings = { sandbox: 'read-only', approvalPolicy: 'on-request' } as const;

interface Pending {
	readonly resolve: (value: unknown) => void;
	readonly reject: (err: Error) => void;
}

export class CodexBackend implements AgentBackend {
	public readonly id = 'codex' as const;

	private _process: JsonLineProcess | undefined;
	private _ready: Promise<void> | undefined;
	/** Bumped on every start, so a session can tell that its thread is no longer loaded. */
	private _generation = 0;
	private _nextId = 0;
	private readonly _pending = new Map<number, Pending>();
	private readonly _sessions = new Map<string, CodexSession>();
	private readonly _all = new Set<CodexSession>();
	private _plan: string | undefined;
	private _disposed = false;
	/** Calls that need the server for a moment — detection, a usage read. */
	private _holds = 0;
	private _idleTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly _binary: string, private readonly _cwd: () => string) { }

	public get generation(): number {
		return this._generation;
	}

	public models(): Promise<ChatModel[]> {
		return this._held(async () => {
			await this.ready();
			const account = await this.request('account/read', {}) as { account?: { planType?: unknown } | null; requiresOpenaiAuth?: unknown };
			if (!account?.account && account?.requiresOpenaiAuth === true) {
				throw new Error(vscode.l10n.t("Codex is not signed in. Run `codex login` in a terminal, then refresh."));
			}
			this._plan = typeof account?.account?.planType === 'string' ? account.account.planType : undefined;
			return codexModels(await this.request('model/list', {}));
		});
	}

	public async usage(): Promise<AgentUsage> {
		try {
			return await this._held(async () => {
				await this.ready();
				return codexUsage(await this.request('account/rateLimits/read', undefined), this._plan);
			});
		} catch (err) {
			return { agent: 'codex', windows: [], notes: [], error: err instanceof Error ? err.message : String(err) };
		}
	}

	/** Keeps the server up for the length of `work`, and lets it go idle afterwards. */
	private async _held<T>(work: () => Promise<T>): Promise<T> {
		this._holds++;
		this._cancelIdle();
		try {
			return await work();
		} finally {
			this._holds--;
			this._releaseIfIdle();
		}
	}

	/**
	 * Schedules the shutdown of a server nothing needs: no conversation holds a
	 * session and no detection or usage read is running. Detection used to leave
	 * the app-server up for the rest of the window, a signed-out Codex included,
	 * for a user who might never chat with Codex at all.
	 */
	private _releaseIfIdle(): void {
		if (this._disposed || this._holds > 0 || this._all.size > 0 || !this._process) {
			return;
		}
		this._cancelIdle();
		this._idleTimer = setTimeout(() => {
			this._idleTimer = undefined;
			if (this._holds === 0 && this._all.size === 0) {
				this._shutdown();
			}
		}, idleShutdownMs);
	}

	private _cancelIdle(): void {
		if (this._idleTimer) {
			clearTimeout(this._idleTimer);
			this._idleTimer = undefined;
		}
	}

	private _shutdown(): void {
		const process = this._process;
		this._process = undefined;
		this._ready = undefined;
		process?.dispose();
	}

	public openSession(cwd: string, resume?: string): AgentSession {
		const session = new CodexSession(this, cwd, resume, () => this._forget(session));
		this._all.add(session);
		this._cancelIdle();
		return session;
	}

	/** Starts the app-server if it is not running, and waits for its handshake. */
	public ready(): Promise<void> {
		if (this._disposed) {
			return Promise.reject(new Error('Closed.'));
		}
		if (this._process && !this._process.exited && this._ready) {
			return this._ready;
		}
		const process = new JsonLineProcess(this._binary, ['app-server'], this._cwd());
		this._process = process;
		this._generation++;
		process.onMessage(message => this._receive(message));
		process.onExit(reason => {
			if (process !== this._process) {
				return;
			}
			this._process = undefined;
			this._ready = undefined;
			const error = new Error(reason ?? 'Codex exited.');
			for (const pending of this._pending.values()) {
				pending.reject(error);
			}
			this._pending.clear();
			for (const session of this._all) {
				session.processEnded(error.message);
			}
		});
		const ready = this.request('initialize', { clientInfo: { name: 'ai-browser', title: 'AI Browser', version: extensionVersion() } })
			.then(() => process.send({ jsonrpc: '2.0', method: 'initialized' }));
		this._ready = ready;
		// **A server that did not complete the handshake is ended, not
		// abandoned.** Clearing only `_ready` left the process alive, and the
		// next `ready()` started another one over it — each Refresh, usage read
		// or message against a CLI that refuses `initialize` added a process
		// that lived until the extension host exited.
		ready.catch(() => {
			if (this._ready === ready) {
				this._ready = undefined;
			}
			if (this._process === process) {
				this._process = undefined;
			}
			process.dispose();
		});
		return ready;
	}

	public request(method: string, params: unknown): Promise<unknown> {
		const process = this._process;
		if (!process || process.exited) {
			return Promise.reject(new Error('Codex is not running.'));
		}
		const id = ++this._nextId;
		const answer = new Promise<unknown>((resolve, reject) => this._pending.set(id, { resolve, reject }));
		process.send({ jsonrpc: '2.0', id, method, params });
		return withTimeout(answer, requestTimeoutMs, `Codex (${method})`).finally(() => this._pending.delete(id));
	}

	public bind(threadId: string, session: CodexSession): void {
		this._sessions.set(threadId, session);
	}

	private _forget(session: CodexSession): void {
		this._all.delete(session);
		for (const [id, s] of this._sessions) {
			if (s === session) {
				this._sessions.delete(id);
			}
		}
		this._releaseIfIdle();
	}

	private _receive(message: Record<string, unknown>): void {
		const id = message.id;
		const method = typeof message.method === 'string' ? message.method : undefined;

		// A reply to one of ours.
		if (typeof id === 'number' && !method) {
			const pending = this._pending.get(id);
			if (pending) {
				const error = message.error as { message?: unknown } | undefined;
				if (error) {
					pending.reject(new Error(typeof error.message === 'string' ? error.message : 'Codex refused the request.'));
				} else {
					pending.resolve(message.result);
				}
			}
			return;
		}
		if (!method) {
			return;
		}
		const params = (message.params ?? {}) as Record<string, unknown>;
		const session = typeof params.threadId === 'string' ? this._sessions.get(params.threadId) : undefined;

		// A request from Codex to us — every one of them needs an answer, or the
		// turn waits on it for ever.
		if (id !== undefined && id !== null) {
			this._answer(id, method, params, session);
			return;
		}

		if (method === 'account/rateLimits/updated') {
			const usage = codexUsage(params, this._plan);
			for (const s of this._all) {
				s.emit({ type: 'limits', windows: usage.windows });
			}
			return;
		}
		session?.notify(method, params);
	}

	private _answer(id: unknown, method: string, params: Record<string, unknown>, session: CodexSession | undefined): void {
		const reply = (result: unknown) => this._process?.send({ jsonrpc: '2.0', id, result });
		switch (method) {
			case 'item/commandExecution/requestApproval':
			case 'item/fileChange/requestApproval': {
				const what = typeof params.command === 'string' ? params.command : typeof params.reason === 'string' ? params.reason : undefined;
				session?.emit({
					type: 'notice',
					text: what
						? vscode.l10n.t("Codex asked for approval ({0}). Approvals are not supported in AI Browser yet, so it was declined.", what)
						: vscode.l10n.t("Codex asked for approval. Approvals are not supported in AI Browser yet, so it was declined."),
				});
				reply({ decision: 'decline' });
				return;
			}
			case 'execCommandApproval':
			case 'applyPatchApproval':
				session?.emit({ type: 'notice', text: vscode.l10n.t("Codex asked for approval. Approvals are not supported in AI Browser yet, so it was declined.") });
				reply({ decision: 'denied' });
				return;
			default:
				this._process?.send({ jsonrpc: '2.0', id, error: { code: -32601, message: `${method} is not supported by AI Browser.` } });
		}
	}

	public dispose(): void {
		this._disposed = true;
		this._cancelIdle();
		for (const session of [...this._all]) {
			session.dispose();
		}
		this._shutdown();
	}
}

class CodexSession implements AgentSession {
	private _threadId: string | undefined;
	/** The app-server generation the thread is loaded in; a restarted server has to resume it. */
	private _loadedIn = 0;
	private _turnId: string | undefined;
	private _running = false;
	private _stopping = false;
	/** Stop pressed before the turn had an id; honoured as soon as it has one. */
	private _stopRequested = false;
	private _disposed = false;
	/**
	 * Sends run one at a time. Two at once was a real defect: a second message
	 * sent before the first turn had an id took the start branch again, and
	 * before the thread existed it started a second thread — two turns streaming
	 * into one chat, Stop reaching one of them, and only one thread saved.
	 * Queued behind the first, the second finds a turn to steer.
	 */
	private _queue: Promise<void> = Promise.resolve();

	private readonly _onEvent = new vscode.EventEmitter<AgentEvent>();
	public readonly onEvent = this._onEvent.event;

	constructor(
		private readonly _backend: CodexBackend,
		private readonly _cwd: string,
		resume: string | undefined,
		private readonly _onDispose: () => void,
	) {
		this._threadId = resume;
	}

	public get ref(): string | undefined {
		return this._threadId;
	}

	public get running(): boolean {
		return this._running;
	}

	public send(input: TurnInput, model: string, effort: string | undefined): Promise<void> {
		const run = this._queue.then(() => this._send(input, model, effort));
		this._queue = run.catch(() => { /* reported to this send's caller */ });
		return run;
	}

	private async _send(input: TurnInput, model: string, effort: string | undefined): Promise<void> {
		if (this._disposed) {
			return;
		}
		const items: unknown[] = [];
		if (input.text) {
			items.push({ type: 'text', text: input.text, text_elements: [] });
		}
		for (const image of input.images) {
			items.push({ type: 'image', url: `data:${image.mediaType};base64,${image.base64}` });
		}

		// A message sent after Stop must not be steered into the turn being
		// interrupted — Codex refuses it, or drops it with that turn. It waits
		// for the stopped turn to end and starts a turn of its own.
		if (this._running && this._stopping) {
			await this._turnEnded();
			if (this._disposed) {
				return;
			}
		}
		if (this._running && this._turnId && this._threadId) {
			await this._backend.request('turn/steer', { threadId: this._threadId, expectedTurnId: this._turnId, input: items });
			return;
		}

		this._running = true;
		this._stopRequested = false;
		try {
			await this._backend.ready();
			// Each await is a point where the chat may have moved on: New Chat,
			// another chat from the history, a different agent — all of which
			// dispose this session — or Stop. Nothing may start after that.
			if (this._disposed || this._stopRequested) {
				this._finishStartup();
				return;
			}
			const threadId = await this._thread(model);
			if (this._disposed || this._stopRequested) {
				this._finishStartup();
				return;
			}
			const started = await this._backend.request('turn/start', { threadId, input: items, model, effort: effort ?? null, summary: 'auto' }) as { turn?: { id?: unknown } };
			const turnId = typeof started?.turn?.id === 'string' ? started.turn.id : undefined;
			if (this._disposed || this._stopRequested) {
				// The turn began while the request was on its way; it is stopped
				// rather than left to run to the end on the user's quota, unseen.
				if (turnId) {
					this._backend.request('turn/interrupt', { threadId, turnId }).catch(() => { /* already over */ });
				}
				if (this._disposed) {
					this._running = false;
				} else {
					this._stopping = true;
					this._turnId = turnId;
				}
				return;
			}
			if (turnId && this._running) {
				this._turnId = turnId;
			}
		} catch (err) {
			this._running = false;
			throw err;
		}
	}

	private _turnWaiters: (() => void)[] = [];

	/** Resolves when the running turn ends — by `turn/completed`, a crash, or dispose. */
	private _turnEnded(): Promise<void> {
		return this._running ? new Promise(resolve => this._turnWaiters.push(resolve)) : Promise.resolve();
	}

	private _releaseTurnWaiters(): void {
		const waiters = this._turnWaiters;
		this._turnWaiters = [];
		waiters.forEach(resolve => resolve());
	}

	/** A start abandoned before any turn existed: report it ended, so the chat stops waiting. */
	private _finishStartup(): void {
		this._running = false;
		this._stopRequested = false;
		this.emit({ type: 'turnEnd', error: 'Stopped.' });
		this._releaseTurnWaiters();
	}

	private async _thread(model: string): Promise<string> {
		if (this._threadId && this._loadedIn === this._backend.generation) {
			return this._threadId;
		}
		if (this._threadId) {
			await this._backend.request('thread/resume', { threadId: this._threadId, cwd: this._cwd, ...threadSettings });
		} else {
			const started = await this._backend.request('thread/start', { cwd: this._cwd, model, ...threadSettings }) as { thread?: { id?: unknown } };
			if (typeof started?.thread?.id !== 'string') {
				throw new Error('Codex did not start a conversation.');
			}
			this._threadId = started.thread.id;
			this.emit({ type: 'session', id: started.thread.id });
		}
		if (!this._disposed) {
			this._backend.bind(this._threadId, this);
		}
		this._loadedIn = this._backend.generation;
		return this._threadId;
	}

	public stop(): void {
		if (!this._running) {
			return;
		}
		if (!this._threadId || !this._turnId) {
			// Still starting: the start path sees this at its next step.
			this._stopRequested = true;
			return;
		}
		this._stopping = true;
		this._backend.request('turn/interrupt', { threadId: this._threadId, turnId: this._turnId }).catch(() => { /* turn/completed reports it */ });
	}

	public notify(method: string, params: Record<string, unknown>): void {
		if (method === 'turn/started') {
			const turn = params.turn as { id?: unknown } | undefined;
			if (typeof turn?.id === 'string') {
				this._turnId = turn.id;
			}
			return;
		}
		// A completion for a turn other than the one running — a late answer to
		// an interrupted turn of a session reopened on the same thread — must not
		// end the newer one.
		if (method === 'turn/completed') {
			const turn = params.turn as { id?: unknown } | undefined;
			if (typeof turn?.id === 'string' && this._turnId && turn.id !== this._turnId) {
				return;
			}
		}
		for (const event of codexEvents(method, params)) {
			if (event.type === 'turnEnd') {
				this._running = false;
				this._turnId = undefined;
				const stopped = this._stopping;
				this._stopping = false;
				this.emit(stopped ? { type: 'turnEnd', error: 'Stopped.' } : event);
				this._releaseTurnWaiters();
				continue;
			}
			this.emit(event);
		}
	}

	public processEnded(reason: string): void {
		const stopped = this._stopping || this._stopRequested;
		this._stopping = false;
		this._stopRequested = false;
		if (this._running) {
			this._running = false;
			this._turnId = undefined;
			this.emit({ type: 'turnEnd', error: stopped ? 'Stopped.' : reason });
		}
		this._releaseTurnWaiters();
	}

	public emit(event: AgentEvent): void {
		if (!this._disposed) {
			this._onEvent.fire(event);
		}
	}

	public dispose(): void {
		if (this._disposed) {
			return;
		}
		this.stop();
		this._disposed = true;
		this._releaseTurnWaiters();
		this._onEvent.dispose();
		this._onDispose();
	}
}

function extensionVersion(): string {
	return vscode.extensions.getExtension('DenysDavydov.tab-browser-ultimate')?.packageJSON?.version ?? '0.0.0';
}
