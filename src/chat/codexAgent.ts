/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { JsonLineProcess, withTimeout } from './agentProcess';
import { codexAgentThreadEvents, codexApproval, codexApprovalAnswer, codexEvents, codexPatchPaths, codexModels, codexSkillItems, codexSkills, codexUsage, type AgentEvent } from './agentProtocol';
import type { AgentBackend, AgentSession, BrowserServer, TurnInput } from './agents';
import type { AgentUsage, ChatCommand, ChatModel, QuestionAnswers } from './chatProtocol';

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
 * **Approvals are asked in the chat.** `approvalPolicy: 'untrusted'` asks before
 * any command Codex does not know to be read-only, and `approvalsReviewer:
 * 'user'` sends the question to us — measured: with the reviewer left to the
 * user's config, Codex's own auto-review answered an MCP tool call by itself and
 * nothing reached the chat. `sandbox: 'workspace-write'` lets an approved
 * command change the workspace; `read-only` failed it with "Operation not
 * permitted" after the yes. Each question is a server request, answered when
 * the user decides, and `serverRequest/resolved` withdraws one Codex no longer
 * needs.
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

/**
 * These override the user's own Codex configuration for the chat's threads —
 * a `sandbox_mode = "read-only"` in `config.toml` included. **With no project
 * the working directory is the home directory** — no folder open
 * (`ChatViewProvider._windowCwd`), or the home directory picked with the folder
 * button (`ChatTab.projectRoot`) — and `workspace-write` there would make all of
 * it writable, `~/.ssh` and the shell's rc files with it; such a thread stays
 * `read-only`, so an approved command that writes fails rather than reaching them.
 */
function threadSettings(root: string | undefined) {
	return { sandbox: root ? 'workspace-write' : 'read-only', approvalPolicy: 'untrusted', approvalsReviewer: 'user' } as const;
}

interface Pending {
	readonly resolve: (value: unknown) => void;
	readonly reject: (err: Error) => void;
}

/** A question Codex asked and the chat has not answered: what to answer it with, and whose it is. */
interface Asked {
	readonly requestId: unknown;
	readonly method: string;
	readonly params: Record<string, unknown>;
	readonly session: CodexSession;
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
	/** Threads of agents a conversation's turn started, to the session they belong to. */
	private readonly _agentThreads = new Map<string, CodexSession>();
	/**
	 * The running turn of threads nobody has claimed yet. An agent's thread can
	 * report its `turn/started` before the parent's `subAgentActivity` binds it,
	 * and without the turn id that agent could not be stopped on its own.
	 * Bounded: a thread that is never claimed is not ours to keep.
	 */
	private readonly _unclaimedTurns = new Map<string, string>();
	private readonly _all = new Set<CodexSession>();
	private _plan: string | undefined;
	private _disposed = false;
	/** Calls that need the server for a moment — detection, a usage read. */
	private _holds = 0;
	private _idleTimer: ReturnType<typeof setTimeout> | undefined;
	/** Open questions by the id the chat knows them under: `<generation>:<request id>`. */
	private readonly _asked = new Map<string, Asked>();

	constructor(
		private readonly _binary: string,
		private readonly _cwd: () => string,
		private readonly _browserServer: () => BrowserServer | undefined = () => undefined,
	) { }

	/**
	 * A thread's `config` override: the browser server, so the thread has the
	 * browser tools whether or not Connect Codex wrote a config — under the bare
	 * name it replaces a project `.codex/config.toml` entry rather than adding a
	 * second (measured: one `ai-browser`, ready) — and the questions feature.
	 */
	public threadConfig(): Record<string, unknown> {
		const server = this._browserServer();
		return {
			// `request_user_input` — a question with choices, asked in the chat
			// and waited on — is offered in the default mode only with this
			// feature (codex-cli 0.162, measured: without it the model said it had
			// no such tool, or asked in plain text and slept waiting for a reply).
			// An older CLI that does not know the feature starts the thread anyway.
			features: { default_mode_request_user_input: true },
			...(server ? { mcp_servers: { 'ai-browser': { url: server.url, http_headers: { Authorization: `Bearer ${server.token}` } } } } : {}),
		};
	}

	/** Answers a question; one already answered, withdrawn, or of another session is ignored. */
	public answer(id: string, allow: boolean, session: CodexSession, answers?: QuestionAnswers): void {
		const asked = this._asked.get(id);
		if (!asked || asked.session !== session) {
			return;
		}
		this._asked.delete(id);
		this._process?.send({ jsonrpc: '2.0', id: asked.requestId, result: codexApprovalAnswer(asked.method, asked.params, allow, answers) });
	}

	/** Every open question is withdrawn — the process ended, or the session went. */
	private _withdraw(which: (asked: Asked) => boolean, answer: boolean): void {
		for (const [id, asked] of [...this._asked]) {
			if (which(asked)) {
				this._asked.delete(id);
				if (answer) {
					this._process?.send({ jsonrpc: '2.0', id: asked.requestId, result: codexApprovalAnswer(asked.method, asked.params, false) });
				}
				asked.session.emit({ type: 'approvalDone', id });
			}
		}
	}

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

	private _skills: ChatCommand[] | undefined;

	public get knownCommands(): readonly ChatCommand[] | undefined {
		return this._skills;
	}

	/**
	 * `skills/list` for the project folder, re-scanned from disk
	 * (`forceReload`) so a skill added since shows up.
	 */
	public commands(): Promise<ChatCommand[]> {
		return this._held(async () => {
			await this.ready();
			const skills = codexSkills(await this.request('skills/list', { cwds: [this._cwd()], forceReload: true }));
			this._skills = skills;
			return skills;
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

	public openSession(cwd: string, resume?: string, _priorCostUsd?: number, root?: string, _readDirs?: readonly string[], _ownSettings?: boolean): AgentSession {
		const session = new CodexSession(this, cwd, root, resume, () => this._forget(session));
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
			this._withdraw(() => true, false);
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

	/** An agent `session`'s thread started: its own thread's events go to that session as the agent's. */
	public bindAgent(threadId: string, session: CodexSession): void {
		if (!this._sessions.has(threadId)) {
			this._agentThreads.set(threadId, session);
			const turn = this._unclaimedTurns.get(threadId);
			if (turn) {
				this._unclaimedTurns.delete(threadId);
				session.notifyAgent(threadId, 'turn/started', { threadId, turn: { id: turn } });
			}
		}
	}

	private _forget(session: CodexSession): void {
		// Refused rather than left open: the turn is being interrupted, and a
		// question nobody will answer would hold it until then.
		this._withdraw(asked => asked.session === session, true);
		this._all.delete(session);
		for (const [id, s] of this._sessions) {
			if (s === session) {
				this._sessions.delete(id);
			}
		}
		for (const [id, s] of this._agentThreads) {
			if (s === session) {
				this._agentThreads.delete(id);
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
		if (method === 'serverRequest/resolved') {
			const key = `${this._generation}:${String(params.requestId)}`;
			const asked = this._asked.get(key);
			if (asked) {
				this._asked.delete(key);
				asked.session.emit({ type: 'approvalDone', id: key });
			}
			return;
		}
		const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
		const session = threadId ? this._sessions.get(threadId) : undefined;
		const agentOf = threadId && !session ? this._agentThreads.get(threadId) : undefined;

		// A request from Codex to us — every one of them needs an answer, or the
		// turn waits on it for ever. One from an agent's thread is told to the
		// chat that agent belongs to.
		if (id !== undefined && id !== null) {
			this._answer(id, method, params, session ?? agentOf);
			return;
		}

		if (method === 'account/rateLimits/updated') {
			const usage = codexUsage(params, this._plan);
			for (const s of this._all) {
				s.emit({ type: 'limits', windows: usage.windows });
			}
			return;
		}
		if (agentOf && threadId) {
			agentOf.notifyAgent(threadId, method, params);
			return;
		}
		if (!session && threadId && (method === 'turn/started' || method === 'turn/completed')) {
			const turn = params.turn as { id?: unknown } | undefined;
			if (method === 'turn/started' && typeof turn?.id === 'string') {
				this._unclaimedTurns.set(threadId, turn.id);
				if (this._unclaimedTurns.size > 32) {
					this._unclaimedTurns.delete(this._unclaimedTurns.keys().next().value!);
				}
			} else {
				this._unclaimedTurns.delete(threadId);
			}
		}
		session?.notify(method, params);
	}

	private _answer(id: unknown, method: string, params: Record<string, unknown>, session: CodexSession | undefined): void {
		const key = `${this._generation}:${String(id)}`;
		const request = codexApproval(key, method, params, session?.filesOf(params.itemId), session?.root);
		if (request) {
			if (!session) {
				// Nobody to ask: a thread no conversation holds any more.
				this._process?.send({ jsonrpc: '2.0', id, result: codexApprovalAnswer(method, params, false) });
				return;
			}
			this._asked.set(key, { requestId: id, method, params, session });
			session.emit({ type: 'approval', request });
			return;
		}
		if (method === 'mcpServer/elicitation/request') {
			// A server asking the user to fill in a form: not something the chat
			// can show yet, and declining it lets the tool call go on.
			this._process?.send({ jsonrpc: '2.0', id, result: { action: 'decline', content: null } });
			return;
		}
		this._process?.send({ jsonrpc: '2.0', id, error: { code: -32601, message: `${method} is not supported by AI Browser.` } });
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
	/** Paths of the latest `fileChange` items, by item id; bounded. */
	private readonly _changes = new Map<string, string[]>();

	private readonly _onEvent = new vscode.EventEmitter<AgentEvent>();
	public readonly onEvent = this._onEvent.event;

	constructor(
		private readonly _backend: CodexBackend,
		private readonly _cwd: string,
		private readonly _root: string | undefined,
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

	public answer(id: string, allow: boolean, answers?: QuestionAnswers): void {
		this._backend.answer(id, allow, this, answers);
	}

	/** The project folder, undefined with none open: what an edit outside the project is decided by. */
	public get root(): string | undefined {
		return this._root;
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
		// `/compact` is Codex's own command in its TUI, and the app-server's is a
		// request of its own, `thread/compact/start` — sent to the model as text
		// it would only be a sentence about compacting. It runs as a turn
		// (`turn/started`, a `contextCompaction` item, `turn/completed`), never
		// inside another, so one sent during a turn waits for that turn's end.
		const compact = input.text.trim() === '/compact' && !input.images.length;
		if (compact && this._running) {
			await this._turnEnded();
			if (this._disposed) {
				return;
			}
		}
		const items: unknown[] = [];
		if (input.text) {
			items.push({ type: 'text', text: input.text, text_elements: [] });
			// A `$skill` the message names goes with it as a `skill` item, the way
			// Codex's own composer sends it.
			items.push(...codexSkillItems(input.text, this._backend.knownCommands ?? []));
		}
		for (const image of input.images) {
			items.push({ type: 'image', url: `data:${image.mediaType};base64,${image.base64}` });
		}

		// A message sent after Stop must not be steered into the turn being
		// interrupted — Codex refuses it, or drops it with that turn. It waits
		// for the stopped turn to end and starts a turn of its own. The same for
		// a compaction's turn: the app-server answers a steer into one with
		// "cannot steer a compact turn" (in the 0.162 binary), and before its
		// `turn/started` there is no id to steer by at all, so the send would
		// start a second turn beside it.
		if (this._running && (this._stopping || this._compactTurn)) {
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
			if (compact) {
				// Answered with `{}`: the turn's id arrives with `turn/started`, which
				// `notify` records — and which interrupts it there if Stop came first.
				this._compacting = true;
				this._compactTurn = true;
				await this._backend.request('thread/compact/start', { threadId });
				// Answered, and no turn follows — nothing to compact, or an error
				// notification instead: without this the session read as running
				// for good, every later message waiting on a turn that never ends.
				if (this._compacting && !this._disposed) {
					const watch = setTimeout(() => {
						if (this._compacting && this._running && !this._disposed) {
							this._compacting = false;
							this._compactTurn = false;
							this._stopRequested = false;
							this._running = false;
							this.emit({ type: 'turnEnd', error: vscode.l10n.t("Codex did not start compacting the conversation.") });
							this._releaseTurnWaiters();
						}
					}, compactStartWaitMs);
					watch.unref?.();
				}
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
			this._compacting = false;
			this._compactTurn = false;
			throw err;
		}
	}

	/** A `thread/compact/start` was sent and its turn has not reported its id yet. */
	private _compacting = false;
	/** The running turn is a compaction, from the request to its end: it takes no further input. */
	private _compactTurn = false;

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
			await this._backend.request('thread/resume', { threadId: this._threadId, cwd: this._cwd, ...threadSettings(this._root), config: this._backend.threadConfig() });
		} else {
			const started = await this._backend.request('thread/start', { cwd: this._cwd, model, ...threadSettings(this._root), config: this._backend.threadConfig() }) as { thread?: { id?: unknown } };
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

	/** Binds the thread of an agent this conversation's turn started, so its events reach the chat. */
	private _watchAgent(method: string, params: Record<string, unknown>): void {
		const item = params.item as Record<string, unknown> | undefined;
		if (method === 'item/started' && item?.type === 'subAgentActivity' && item.kind === 'started' && typeof item.agentThreadId === 'string') {
			this._backend.bindAgent(item.agentThreadId, this);
		}
	}

	/** The running turn of each agent thread of this conversation, for `stopAgent`. */
	private readonly _agentTurns = new Map<string, string>();

	/**
	 * An agent's thread runs turns of its own; interrupting the one running stops
	 * that agent and nothing else. Its `subAgentActivity` then reports it
	 * `interrupted` on the parent's thread.
	 */
	public async stopAgent(_rowId: string, threadId: string | undefined): Promise<void> {
		const turnId = threadId ? this._agentTurns.get(threadId) : undefined;
		if (!threadId || !turnId) {
			throw new Error(vscode.l10n.t("The agent is not running a turn right now."));
		}
		await this._backend.request('turn/interrupt', { threadId, turnId });
	}

	/** An event of an agent's own thread: the agent's row, never the reply. */
	public notifyAgent(threadId: string, method: string, params: Record<string, unknown>): void {
		// An agent's patch is asked about in this conversation too.
		this._noteChanges(method, params);
		if (method === 'turn/started' || method === 'turn/completed') {
			const turn = params.turn as { id?: unknown } | undefined;
			if (method === 'turn/started' && typeof turn?.id === 'string') {
				this._agentTurns.set(threadId, turn.id);
			} else {
				this._agentTurns.delete(threadId);
			}
		}
		this._watchAgent(method, params);
		for (const event of codexAgentThreadEvents(threadId, method, params)) {
			this.emit(event);
		}
	}

	/** The paths a `fileChange` item touches, for the approval that names only the item. */
	public filesOf(itemId: unknown): string[] {
		return typeof itemId === 'string' ? this._changes.get(itemId) ?? [] : [];
	}

	private _noteChanges(method: string, params: Record<string, unknown>): void {
		const item = params.item as { type?: unknown; id?: unknown; changes?: unknown } | undefined;
		if (method !== 'item/started' || item?.type !== 'fileChange' || typeof item.id !== 'string' || !Array.isArray(item.changes)) {
			return;
		}
		// Where a move takes a file is written too (`kind.move_path`).
		this._changes.set(item.id, codexPatchPaths(item.changes));
		if (this._changes.size > 32) {
			this._changes.delete(this._changes.keys().next().value!);
		}
	}

	public notify(method: string, params: Record<string, unknown>): void {
		this._watchAgent(method, params);
		this._noteChanges(method, params);
		if (method === 'turn/started') {
			const turn = params.turn as { id?: unknown } | undefined;
			if (typeof turn?.id === 'string') {
				this._turnId = turn.id;
				// A compaction has no id of its own to stop by until now: Stop
				// pressed while it was being asked for is honoured here.
				if (this._compacting) {
					this._compacting = false;
					if (this._stopRequested && this._threadId) {
						this._stopRequested = false;
						this._stopping = true;
						this._backend.request('turn/interrupt', { threadId: this._threadId, turnId: turn.id }).catch(() => { /* turn/completed reports it */ });
					}
				}
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
				this._compactTurn = false;
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
		this._compacting = false;
		this._compactTurn = false;
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
		// Its agents too: their threads live in the app-server the other tabs
		// share, and once this session is gone nothing shows or stops them.
		for (const [threadId, turnId] of this._agentTurns) {
			this._backend.request('turn/interrupt', { threadId, turnId }).catch(() => { /* already over */ });
		}
		this._agentTurns.clear();
		this._disposed = true;
		this._releaseTurnWaiters();
		this._onEvent.dispose();
		this._onDispose();
	}
}

/** How long a compaction may take to report its turn before the session stops waiting for it. */
const compactStartWaitMs = 30_000;

function extensionVersion(): string {
	return vscode.extensions.getExtension('DenysDavydov.tab-browser-ultimate')?.packageJSON?.version ?? '0.0.0';
}
