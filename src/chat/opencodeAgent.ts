/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { chatCapability } from '../core/chatCapability';
import * as vscode from 'vscode';
import { JsonLineProcess, withTimeout } from './agentProcess';
import { openrouterApproval, outsideProject, type AgentEvent } from './agentProtocol';
import type { AgentBackend, AgentSession, BrowserServer, TurnInput } from './agents';
import type { AgentId, AgentUsage, ChatCommand, ChatModel, QuestionAnswers } from './chatProtocol';
import {
	OpencodeUpdates, opencodeApproval, opencodeApprovalAnswer, opencodeCommands, opencodeConfigOptions, opencodeCurrentModel,
	opencodeEffortLevels, opencodeEffortOption, opencodeErrorText, opencodeExitText, opencodeModels, opencodePermissionConfig, opencodeTurnEnd,
} from './opencodeProtocol';

/**
 * OpenCode, driven over ACP: `opencode acp`, JSON-RPC 2.0 over stdio. The readers
 * are in `opencodeProtocol.ts`; everything here was measured on OpenCode 2.1.1.
 *
 * **One process per conversation**, like Gemini CLI: `initialize`, then
 * `session/resume` (or `session/new`), then a `session/prompt` per turn. The
 * ACP session id *is* OpenCode's own session id, so `opencode -s <id>` in a
 * terminal continues the same conversation, and it is what `ref` stores.
 * `opencode acp` starts a child `opencode serve --stdio`; closing stdin ends
 * both, which `dispose` does first.
 *
 * - **A model or an effort is `session/set_config_option`** on the live session
 *   (no restart); the effort option exists only for a model with variants, so
 *   its id and levels are read from the answer of the model change.
 * - **A second `session/prompt` during a turn is refused** (measured), so a
 *   message sent while OpenCode works waits here and goes as a turn of its own,
 *   announced with `autoTurn` — Gemini's shape.
 * - **Approvals are imposed by us.** OpenCode's default configuration runs shell
 *   and edits without asking, so every process gets `OPENCODE_CONFIG_CONTENT`
 *   (`opencodePermissionConfig`), which outranks the project's and the user's
 *   rules: everything asks, and the chat's approval menu answers. A rejected
 *   question ends the turn (measured) — the chat is told so, not "Stopped.".
 * - **A folder whose own settings are held back** (`ownSettings` false — a GitHub
 *   repository not trusted yet) gets `OPENCODE_DISABLE_PROJECT_CONFIG`, since
 *   OpenCode loads a project's `opencode.json` and plugins, which can run code.
 *   The model-listing probe never loads a project's configuration either.
 */
const requestTimeoutMs = 30_000;
/** How long the probe waits for `available_commands_update` after `session/new`. */
const commandsWaitMs = 1_500;
/** A probe measures the efforts of at most this many models (each is one cheap request; a signed-in account can list hundreds). */
const probeModelLimit = 200;

/** `session/new` and the prompt refused for want of credentials: JSON-RPC -32000 (`auth_required`). */
function signedOut(err: unknown): boolean {
	return err instanceof RpcError && err.code === -32000;
}

class RpcError extends Error {
	constructor(message: string, public readonly code: number | undefined, public readonly errorName?: string) {
		super(message);
	}
}

/** Any failure as the chat says it: OpenCode's own refusals through `opencodeErrorText`, the rest as they are. */
function userError(err: unknown): Error {
	if (err instanceof RpcError) {
		return new Error(opencodeErrorText(err.code, err.message, err.errorName));
	}
	return err instanceof Error ? err : new Error(String(err));
}

/** What a process is started with: the permission configuration, and the project's own configuration held back when it must be. */
function processEnv(ownSettings: boolean): Record<string, string> {
	return {
		OPENCODE_CONFIG_CONTENT: opencodePermissionConfig,
		...(ownSettings ? {} : { OPENCODE_DISABLE_PROJECT_CONFIG: 'true' }),
	};
}

/** The browser server as ACP's `mcpServers` entry: an HTTP server and its headers, as a list. */
function mcpServers(server: BrowserServer | undefined): unknown[] {
	if (!server) {
		return [];
	}
	const headers = [{ name: 'Authorization', value: `Bearer ${server.token}` }];
	if (server.chatId) {
		headers.push({ name: 'X-AI-Browser-Chat', value: chatCapability(server.chatId) });
	}
	return [{ type: 'http', name: 'ai-browser', url: server.url, headers }];
}

/** One `opencode acp` process: requests and their answers, the agent's own requests to us, and its notifications. */
class AcpConnection implements vscode.Disposable {
	private readonly _process: JsonLineProcess;
	private _nextId = 0;
	private readonly _pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
	private _closed = false;

	constructor(
		binary: string,
		cwd: string,
		ownSettings: boolean,
		private readonly _onUpdate: (params: Record<string, unknown>) => void,
		private readonly _onPermission: (id: unknown, params: Record<string, unknown>) => void,
		private readonly _onExit: (reason: string) => void,
	) {
		this._process = new JsonLineProcess(binary, ['acp'], cwd, processEnv(ownSettings));
		this._process.onMessage(message => this._receive(message));
		this._process.onExit(reason => {
			this._closed = true;
			const error = new Error(reason ?? 'OpenCode exited.');
			for (const pending of this._pending.values()) {
				pending.reject(error);
			}
			this._pending.clear();
			this._onExit(error.message);
		});
	}

	public get closed(): boolean {
		return this._closed || this._process.exited;
	}

	/** `timeoutMs` null: no deadline — a prompt is answered when its turn ends. */
	public request(method: string, params: unknown, timeoutMs: number | null = requestTimeoutMs): Promise<unknown> {
		if (this.closed) {
			return Promise.reject(new Error('OpenCode is not running.'));
		}
		const id = ++this._nextId;
		const answer = new Promise<unknown>((resolve, reject) => this._pending.set(id, { resolve, reject }));
		this._process.send({ jsonrpc: '2.0', id, method, params });
		const bounded = timeoutMs === null ? answer : withTimeout(answer, timeoutMs, `OpenCode (${method})`);
		return bounded.finally(() => this._pending.delete(id));
	}

	public notify(method: string, params: unknown): void {
		this._process.send({ jsonrpc: '2.0', method, params });
	}

	public respond(id: unknown, result: unknown): void {
		this._process.send({ jsonrpc: '2.0', id, result });
	}

	private _receive(message: Record<string, unknown>): void {
		const id = message.id;
		const method = typeof message.method === 'string' ? message.method : undefined;
		if (typeof id === 'number' && !method) {
			const pending = this._pending.get(id);
			if (pending) {
				const error = message.error as { message?: unknown; code?: unknown; data?: { errorName?: unknown } } | undefined;
				if (error) {
					pending.reject(new RpcError(
						typeof error.message === 'string' ? error.message : 'OpenCode refused the request.',
						typeof error.code === 'number' ? error.code : undefined,
						typeof error.data?.errorName === 'string' ? error.data.errorName : undefined,
					));
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
		if (id !== undefined && id !== null) {
			if (method === 'session/request_permission') {
				this._onPermission(id, params);
				return;
			}
			// `fs/*` and `terminal/*` are only asked of a client that declared them,
			// which this one does not; anything else is refused rather than left
			// for the turn to wait on.
			this._process.send({ jsonrpc: '2.0', id, error: { code: -32601, message: `${method} is not supported by AI Browser.` } });
			return;
		}
		if (method === 'session/update') {
			this._onUpdate(params);
		}
	}

	public dispose(): void {
		this._closed = true;
		this._process.endInput();
		this._process.dispose();
	}
}

/** Starts a process and completes the ACP handshake; the process is ended if it does not. */
async function connect(
	binary: string, cwd: string, ownSettings: boolean,
	onUpdate: (params: Record<string, unknown>) => void,
	onPermission: (id: unknown, params: Record<string, unknown>) => void,
	onExit: (reason: string) => void,
): Promise<AcpConnection> {
	const connection = new AcpConnection(binary, cwd, ownSettings, onUpdate, onPermission, onExit);
	try {
		await connection.request('initialize', {
			protocolVersion: 1,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
			clientInfo: { name: 'ai-browser', title: 'AI Browser', version: extensionVersion() },
		});
		return connection;
	} catch (err) {
		// A process that ended before answering says why on stderr, which the exit
		// reason carries; one that answers nothing in time is left as is.
		const exited = connection.closed;
		connection.dispose();
		throw exited ? new Error(opencodeExitText(err instanceof Error ? err.message : String(err), true)) : userError(err);
	}
}

export class OpencodeBackend implements AgentBackend {
	public get running(): boolean { return [...this._sessions].some(session => session.running); }
	public readonly id = 'opencode' as const satisfies AgentId;
	private readonly _sessions = new Set<OpencodeSession>();
	private _commands: ChatCommand[] | undefined;
	private _disposed = false;

	constructor(
		private readonly _binary: string,
		private readonly _cwd: () => string,
		private readonly _browserServer: () => BrowserServer | undefined = () => undefined,
	) { }

	public get knownCommands(): readonly ChatCommand[] | undefined {
		return this._commands;
	}

	/**
	 * A short-lived process in the project folder: `session/new` lists the models
	 * and the commands come right after it; the model is then switched through the
	 * list on that session to read each model's efforts, which OpenCode reports only
	 * for the model in use. No prompt is sent, so it costs nothing, and the session
	 * is deleted again. The project's own configuration is never loaded for it.
	 */
	public async models(): Promise<ChatModel[]> {
		const { models, commands } = await this._probe();
		this._commands = commands;
		return models;
	}

	public async commands(cwd?: string): Promise<ChatCommand[]> {
		const { commands } = await this._probe(cwd, false);
		this._commands = commands;
		return commands;
	}

	private async _probe(cwd = this._cwd(), withEfforts = true): Promise<{ models: ChatModel[]; commands: ChatCommand[] }> {
		if (this._disposed) {
			throw new Error('Closed.');
		}
		let commands: ChatCommand[] = [];
		let heard: (() => void) | undefined;
		const listed = new Promise<void>(resolve => { heard = resolve; });
		const connection = await connect(this._binary, cwd, false, params => {
			const update = params.update as Record<string, unknown> | undefined;
			if (update?.sessionUpdate === 'available_commands_update') {
				commands = opencodeCommands(update);
				heard?.();
			}
		}, (id, params) => connection.respond(id, opencodeApprovalAnswer(params, false)), () => heard?.());
		try {
			const session = await connection.request('session/new', { cwd, mcpServers: [] }).catch(err => {
				if (signedOut(err)) {
					throw new Error(vscode.l10n.t("OpenCode is not signed in ({0}). Run `opencode auth login` in a terminal, then press Refresh Agents.", userError(err).message));
				}
				throw userError(err);
			}) as { sessionId?: unknown };
			await Promise.race([listed, new Promise(resolve => setTimeout(resolve, commandsWaitMs))]);
			const efforts = new Map<string, readonly string[]>();
			const options = opencodeConfigOptions(session).find(o => o.id === 'model');
			if (withEfforts && options && typeof session.sessionId === 'string') {
				for (const model of options.options.slice(0, probeModelLimit)) {
					try {
						const answer = await connection.request('session/set_config_option', { sessionId: session.sessionId, configId: 'model', value: model.value });
						const levels = opencodeEffortLevels(opencodeEffortOption(answer));
						if (levels.length) {
							efforts.set(model.value, levels);
						}
					} catch {
						// A model that cannot be selected here simply lists without efforts.
					}
				}
			}
			if (typeof session.sessionId === 'string') {
				await connection.request('session/delete', { sessionId: session.sessionId }, 5_000).catch(() => undefined);
			}
			const models = opencodeModels(session, efforts);
			if (!models.length) {
				throw new Error(vscode.l10n.t("OpenCode lists no models: no provider is set up. Run `opencode auth login` in a terminal, then press Refresh Agents."));
			}
			return { models, commands };
		} finally {
			connection.dispose();
		}
	}

	/** OpenCode reports no plan limits over ACP; only the tokens and the context, per conversation. */
	public async usage(): Promise<AgentUsage> {
		return {
			agent: 'opencode', windows: [],
			notes: [vscode.l10n.t("OpenCode does not report plan limits to other programs. The tokens and the context of this chat are counted here.")],
		};
	}

	public openSession(cwd: string, resume?: string, _priorCostUsd?: number, root?: string, _readDirs?: readonly string[], ownSettings = true, chatId?: string): AgentSession {
		const browserServer = () => { const server = this._browserServer(); return server ? { ...server, chatId } : undefined; };
		const session = new OpencodeSession(this._binary, cwd, root, resume, ownSettings, browserServer, () => this._sessions.delete(session));
		this._sessions.add(session);
		return session;
	}

	public dispose(): void {
		this._disposed = true;
		for (const session of [...this._sessions]) {
			session.dispose();
		}
	}
}

interface Queued {
	readonly input: TurnInput;
	readonly model: string;
	readonly effort: string | undefined;
	readonly resolve: (sent: boolean) => void;
	/** Refused with the reason it will not go: the chat shows it beside the message. */
	readonly reject: (err: Error) => void;
}

class OpencodeSession implements AgentSession {
	private _connection: AcpConnection | undefined;
	/** Bumped with each process, so a question's id names the process that asked it. */
	private _generation = 0;
	private _sessionId: string | undefined;
	/** The session id is one the running process has resumed or made. */
	private _loaded = false;
	/** The latest `configOptions` the process answered with: the model in use and the effort option of that model. */
	private _options: unknown;
	private _running = false;
	/** Stop came before the prompt was sent; the start path sees it at its next step. */
	private _stopRequested = false;
	/** `session/cancel` was sent for the running prompt. */
	private _stopping = false;
	/** The running turn's prompt has been sent: from here a Stop is `session/cancel`. */
	private _prompting = false;
	/** The user answered Deny during this turn: OpenCode ends the turn for it. */
	private _denied = false;
	/** `session/load` replays the history as updates, which the chat already has. */
	private _replaying = false;
	private _disposed = false;
	private _updates = new OpencodeUpdates();
	private readonly _queue: Queued[] = [];
	/** Open permission questions by the id the chat knows them under. */
	private readonly _asked = new Map<string, { readonly requestId: unknown; readonly params: Record<string, unknown> }>();

	private readonly _onEvent = new vscode.EventEmitter<AgentEvent>();
	public readonly onEvent = this._onEvent.event;

	constructor(
		private readonly _binary: string,
		private readonly _cwd: string,
		private readonly _root: string | undefined,
		resume: string | undefined,
		/** The folder may load its own configuration; false: it is held back for this process. */
		private readonly _ownSettings: boolean,
		private readonly _browserServer: () => BrowserServer | undefined,
		private readonly _onDispose: () => void,
	) {
		this._sessionId = resume;
	}

	public get ref(): string | undefined {
		return this._sessionId;
	}

	public get running(): boolean {
		return this._running;
	}

	public send(input: TurnInput, model: string, effort: string | undefined): Promise<boolean> {
		if (this._disposed) {
			return Promise.resolve(false);
		}
		if (this._running) {
			return new Promise((resolve, reject) => this._queue.push({ input, model, effort, resolve, reject }));
		}
		return this._start(input, model, effort);
	}

	/** Starts a turn; resolves once its prompt is sent, rejects when it could not be. */
	private async _start(input: TurnInput, model: string, effort: string | undefined): Promise<boolean> {
		this._running = true;
		this._stopRequested = false;
		this._stopping = false;
		this._prompting = false;
		this._denied = false;
		let connection: AcpConnection;
		try {
			connection = await this._ready(model, effort);
		} catch (raw) {
			const err = userError(raw);
			this._running = false;
			this._stopRequested = false;
			// Nothing will end a turn for the messages that waited behind this one:
			// each is told it was not sent, rather than shown as sent.
			this._dropQueue(err.message);
			throw err;
		}
		if (this._disposed || this._stopRequested) {
			this._finishTurn([{ type: 'turnEnd', error: 'Stopped.' }]);
			return false;
		}
		const prompt: unknown[] = [];
		if (input.text) {
			prompt.push({ type: 'text', text: input.text });
		}
		for (const image of input.images) {
			prompt.push({ type: 'image', mimeType: image.mediaType, data: image.base64 });
		}
		this._prompting = true;
		this._updates.turnStarted();
		connection.request('session/prompt', { sessionId: this._sessionId, prompt }, null).then(
			result => {
				if (this._connection === connection) {
					this._finishTurn(opencodeTurnEnd(result, { stopped: this._stopping, denied: this._denied }));
				}
			},
			err => {
				// A process that ended is `_processEnded`'s to report.
				if (this._connection === connection && !connection.closed) {
					this._finishTurn([{ type: 'turnEnd', error: this._stopping ? 'Stopped.' : userError(err).message }]);
				}
			},
		);
		return true;
	}

	/** The process, the session, the model and the effort, each made ready if they are not. */
	private async _ready(model: string, effort: string | undefined): Promise<AcpConnection> {
		let connection = this._connection;
		if (!connection || connection.closed) {
			const generation = ++this._generation;
			this._updates = new OpencodeUpdates();
			connection = await connect(
				this._binary, this._cwd, this._ownSettings,
				params => { if (this._generation === generation) { this._update(params); } },
				(id, params) => { if (this._generation === generation) { this._ask(id, params); } },
				reason => { if (this._generation === generation) { this._processEnded(reason); } },
			);
			if (this._disposed || this._generation !== generation) {
				connection.dispose();
				throw new Error('Closed.');
			}
			this._connection = connection;
			this._loaded = false;
			this._options = undefined;
		}
		try {
			if (!this._loaded) {
				await this._openSession(connection);
			}
			if (model && model !== opencodeCurrentModel(this._options)) {
				await this._setOption(connection, 'model', model);
			}
			// The effort option belongs to the model now in use: asked for, or put back to `default`.
			const option = opencodeEffortOption(this._options);
			if (option) {
				const wanted = effort && option.options.some(o => o.value === effort) ? effort : 'default';
				if (wanted !== option.currentValue && option.options.some(o => o.value === wanted)) {
					await this._setOption(connection, option.id, wanted);
				}
			}
		} catch (err) {
			// The process went while the session was being made ready: said the way
			// `_processEnded` says it, which leaves this turn to `_start`.
			throw connection.closed ? new Error(opencodeExitText(err instanceof Error ? err.message : String(err), false)) : err;
		}
		return connection;
	}

	/** `session/set_config_option`; its answer is the whole list again, with the options the new value brings. */
	private async _setOption(connection: AcpConnection, configId: string, value: string): Promise<void> {
		this._options = await connection.request('session/set_config_option', { sessionId: this._sessionId, configId, value });
	}

	private async _openSession(connection: AcpConnection): Promise<void> {
		const servers = mcpServers(this._browserServer());
		if (this._sessionId) {
			for (const method of ['session/resume', 'session/load']) {
				// `session/resume` replays nothing; `session/load` replays the history, which the chat has.
				this._replaying = method === 'session/load';
				try {
					this._options = await connection.request(method, { sessionId: this._sessionId, cwd: this._cwd, mcpServers: servers }, 120_000);
					this._loaded = true;
					return;
				} catch (err) {
					if (signedOut(err)) {
						throw userError(err);
					}
					if (err instanceof RpcError && err.code === -32601) {
						continue;
					}
					// A session OpenCode no longer has is not worth refusing the message over.
					this.emit({ type: 'notice', text: vscode.l10n.t("OpenCode could not resume the earlier conversation ({0}); this message starts a new one.", err instanceof Error ? err.message : String(err)) });
					break;
				} finally {
					this._replaying = false;
				}
			}
		}
		let started: unknown;
		try {
			started = await connection.request('session/new', { cwd: this._cwd, mcpServers: servers });
		} catch (err) {
			throw userError(err);
		}
		const id = (started as { sessionId?: unknown } | undefined)?.sessionId;
		if (typeof id !== 'string' || !id) {
			throw new Error('OpenCode did not start a conversation.');
		}
		this._sessionId = id;
		this._options = started;
		this._loaded = true;
		this.emit({ type: 'session', id });
	}

	private _update(params: Record<string, unknown>): void {
		if (this._replaying || params.sessionId !== this._sessionId) {
			return;
		}
		for (const event of this._updates.events(params.update)) {
			this.emit(event);
		}
	}

	private _ask(requestId: unknown, params: Record<string, unknown>): void {
		const id = `${this._generation}:${String(requestId)}`;
		if (this._disposed || this._stopping || params.sessionId !== this._sessionId) {
			this._connection?.respond(requestId, { outcome: { outcome: 'cancelled' } });
			return;
		}
		this._asked.set(id, { requestId, params });
		this.emit({ type: 'approval', request: opencodeApproval(id, params, this._root, { outsideProject, ourToolCard: openrouterApproval }) });
	}

	public answer(id: string, allow: boolean, _answers?: QuestionAnswers): void {
		const asked = this._asked.get(id);
		if (!asked) {
			return;
		}
		this._asked.delete(id);
		if (!allow) {
			this._denied = true;
		}
		this._connection?.respond(asked.requestId, opencodeApprovalAnswer(asked.params, allow));
	}

	/** Every open question is closed: answered as cancelled when the process can still hear it. */
	private _withdrawAll(answer: boolean): void {
		for (const [id, asked] of [...this._asked]) {
			this._asked.delete(id);
			if (answer) {
				this._connection?.respond(asked.requestId, { outcome: { outcome: 'cancelled' } });
			}
			this.emit({ type: 'approvalDone', id });
		}
	}

	/**
	 * The turn is over: its tokens and its end, then the next message that waited
	 * for it, as a turn of its own. A Stop ends the running turn only — the messages
	 * queued behind it still go, as they do for Claude Code and Gemini.
	 */
	private _finishTurn(events: readonly AgentEvent[]): void {
		this._stopping = false;
		this._prompting = false;
		this._withdrawAll(false);
		this._running = false;
		for (const event of events) {
			this.emit(event);
		}
		const next = this._disposed ? undefined : this._queue.shift();
		if (!next) {
			return;
		}
		this.emit({ type: 'autoTurn' });
		// Its turn has begun in the chat (`autoTurn`), so a failure ends that turn
		// with the reason rather than refusing the send a second time.
		this._start(next.input, next.model, next.effort).then(next.resolve, err => {
			next.resolve(false);
			this.emit({ type: 'turnEnd', error: err instanceof Error ? err.message : String(err) });
		});
	}

	public stop(): void {
		if (!this._running) {
			return;
		}
		const connection = this._connection;
		if (!connection || connection.closed || !this._prompting) {
			this._stopRequested = true;
			return;
		}
		this._stopping = true;
		// The prompt returns `cancelled` within milliseconds, with a question open
		// too (measured); answering the open ones as cancelled keeps the CLI's own
		// bookkeeping tidy, as for Gemini.
		connection.notify('session/cancel', { sessionId: this._sessionId });
		this._withdrawAll(true);
	}

	private _processEnded(reason: string): void {
		this._connection = undefined;
		this._loaded = false;
		this._options = undefined;
		this._withdrawAll(false);
		// Only a turn whose prompt went out is this to end. Before that, `_start`
		// is still awaiting `_ready`, whose request this exit rejects, and it
		// reports the failure itself.
		if (this._running && this._prompting) {
			const stopped = this._stopping || this._stopRequested;
			this._stopping = false;
			this._stopRequested = false;
			this._running = false;
			this._prompting = false;
			this.emit({ type: 'turnEnd', error: stopped ? 'Stopped.' : opencodeExitText(reason, false) });
		}
		this._dropQueue(vscode.l10n.t("Not sent: OpenCode stopped before this message's turn. Send it again."));
	}

	/**
	 * Lets go of the messages waiting for a turn: refused with `reason` — they were
	 * never sent, and the chat must not show them as sent — or, without one, given
	 * up quietly (the session is closing with its tab).
	 */
	private _dropQueue(reason?: string): void {
		for (const queued of this._queue.splice(0)) {
			if (reason) {
				queued.reject(new Error(reason));
			} else {
				queued.resolve(false);
			}
		}
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
		this._disposed = true;
		this._dropQueue();
		this._asked.clear();
		this._generation++;
		this._connection?.dispose();
		this._connection = undefined;
		this._onEvent.dispose();
		this._onDispose();
	}
}

function extensionVersion(): string {
	return vscode.extensions.getExtension('DenysDavydov.tab-browser-ultimate')?.packageJSON?.version ?? '0.0.0';
}
