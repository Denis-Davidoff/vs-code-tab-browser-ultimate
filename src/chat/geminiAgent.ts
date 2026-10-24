/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { chatCapability } from '../core/chatCapability';
import * as path from 'path';
import * as vscode from 'vscode';
import { JsonLineProcess, withTimeout } from './agentProcess';
import { geminiApproval, geminiApprovalAnswer, geminiCommands, geminiErrorText, geminiEvents, geminiExitText, geminiModels, geminiTurnEnd, type AgentEvent } from './agentProtocol';
import type { AgentBackend, AgentSession, BrowserServer, TurnInput } from './agents';
import type { AgentUsage, ChatCommand, ChatModel, QuestionAnswers } from './chatProtocol';

/**
 * Gemini CLI, driven over ACP: `gemini --acp`, JSON-RPC 2.0 over stdio — the
 * protocol Zed and the other ACP clients drive it with. The readers are in
 * `agentProtocol.ts`; everything here was measured on gemini-cli 0.64.0.
 *
 * **One process per conversation**, like Claude Code: `initialize`, then
 * `session/new` (or `session/load` for a conversation reopened from the
 * history), then a `session/prompt` per turn, answered when the turn ends.
 * The model is `session/set_model` on the live session, so a change costs no
 * restart. Gemini has no effort setting over ACP.
 *
 * **A second prompt sent during a turn aborts the first** (read in its
 * source: `pendingPrompt?.abort()`), so a message sent while Gemini works
 * waits here and goes as a turn of its own the moment the running one ends,
 * announced with `autoTurn` — the shape the chat already handles for Claude
 * Code's messages answered by a turn of their own.
 *
 * **The process is started with `GEMINI_CLI_NO_RELAUNCH`.** Otherwise
 * `gemini` relaunches itself as a child `node --max-old-space-size=…`, and
 * both ignore SIGTERM (measured): every conversation closed left two node
 * processes behind. With it there is one, and SIGTERM ends it. The binary's own
 * folder goes first on `PATH`, because the npm install is a script run with
 * `#!/usr/bin/env node`, and VS Code started from the Dock does not have an
 * nvm `node` on its `PATH`.
 *
 * **Folder trust decides whether the browser tools arrive.** In a folder
 * Gemini does not trust, the MCP servers handed to `session/new` are never
 * connected (measured: no request reached the server), and its project
 * settings are not loaded either. `--skip-trust` trusts the folder for that
 * process — the consent picking a local folder already is, as for Claude
 * Code. A folder fetched from GitHub and not trusted yet (`ownSettings`
 * false) is started with trust **forbidden** (`GEMINI_CLI_TRUST_WORKSPACE=false`):
 * its `.gemini/settings.json` hooks are shell commands, so it goes without the
 * browser tools until the user trusts it in the chat.
 */
const requestTimeoutMs = 30_000;
/** How long the probe waits for `available_commands_update` after `session/new`. */
const commandsWaitMs = 1_500;
/**
 * How long a turn may go without a single update before the chat says why it
 * may be waiting. Gemini CLI retries a failed model request on its own — up to
 * ten times, each waiting about a minute for an answer — and says nothing of it
 * over ACP (measured on 0.64 with `gemini-3.8-flash`, which Auto picks and
 * which did not answer for that account: `fetch failed sending request` in
 * `--debug`, nothing on stdout). Without this the chat showed "thinking" for
 * ten minutes and more with no error.
 */
const silenceNoticeMs = 45_000;

/** The binary's own folder first on `PATH`: an npm install is a `#!/usr/bin/env node` script. */
export function geminiPath(binary: string): string {
	return [path.dirname(binary), process.env.PATH].filter(Boolean).join(path.delimiter);
}

/**
 * How a process is told about folder trust: `true` trusts the folder for that
 * process (`--skip-trust`), `false` forbids it whatever Gemini's own registry
 * says (`GEMINI_CLI_TRUST_WORKSPACE=false`, read before the registry), and
 * `undefined` leaves the decision to Gemini — only the trust probe asks so.
 *
 * `false` is not the same as leaving the flag out, and the difference was a
 * hole: a repository fetched from GitHub sits under the user's home, and a
 * home trusted in Gemini ("Trust folder" on `~`) covers it — so a folder whose
 * settings this extension holds back loaded its hooks anyway.
 */
type Trust = boolean | undefined;

function processArgs(trust: Trust): string[] {
	return ['--acp', ...(trust === true ? ['--skip-trust'] : [])];
}

/**
 * What a chat process is started with; see the comment above. **`SURFACE` is
 * deliberately not set**: in 0.64 it is not only telemetry — `createContentGenerator`
 * builds the User-Agent of every model request from it. Unset, Gemini CLI sees
 * `VSCODE_PID` (inherited from VS Code's processes) and identifies as
 * `CloudCodeVSCode/… proxy_client=geminicli`; any other value makes it
 * `GeminiCLI/<version>/<model> (…; <surface>)`, and what the service does
 * differently for that is unmeasured.
 */
function processEnv(binary: string, trust: Trust): Record<string, string> {
	return {
		GEMINI_CLI_NO_RELAUNCH: 'true',
		PATH: geminiPath(binary),
		...(trust === false ? { GEMINI_CLI_TRUST_WORKSPACE: 'false' } : {}),
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

/** `session/new` refused for want of credentials: JSON-RPC -32000, measured with no key and no login. */
function signedOut(err: unknown): boolean {
	return err instanceof RpcError && err.code === -32000;
}

class RpcError extends Error {
	constructor(message: string, public readonly code: number | undefined, public readonly details?: string) {
		super(message);
	}
}

/** Any failure as the chat says it: Gemini's own refusals through `geminiErrorText`, the rest as they are. */
function userError(err: unknown): Error {
	if (err instanceof RpcError) {
		return new Error(geminiErrorText(err.code, err.message, err.details));
	}
	return err instanceof Error ? err : new Error(String(err));
}

/**
 * One `gemini --acp` process: requests and their answers, the agent's own
 * requests to us, and its notifications.
 */
class AcpConnection implements vscode.Disposable {
	private readonly _process: JsonLineProcess;
	private _nextId = 0;
	private readonly _pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
	private _closed = false;

	constructor(
		binary: string,
		cwd: string,
		trust: Trust,
		/** A `session/update`'s `params`. */
		private readonly _onUpdate: (params: Record<string, unknown>) => void,
		/** A permission request; answered later through `respond`. */
		private readonly _onPermission: (id: unknown, params: Record<string, unknown>) => void,
		/** The process ended; the reason when it did not end cleanly. */
		private readonly _onExit: (reason: string) => void,
	) {
		this._process = new JsonLineProcess(binary, processArgs(trust), cwd, processEnv(binary, trust));
		this._process.onMessage(message => this._receive(message));
		this._process.onExit(reason => {
			this._closed = true;
			const error = new Error(reason ?? 'Gemini CLI exited.');
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
			return Promise.reject(new Error('Gemini CLI is not running.'));
		}
		const id = ++this._nextId;
		const answer = new Promise<unknown>((resolve, reject) => this._pending.set(id, { resolve, reject }));
		this._process.send({ jsonrpc: '2.0', id, method, params });
		const bounded = timeoutMs === null ? answer : withTimeout(answer, timeoutMs, `Gemini CLI (${method})`);
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
				const error = message.error as { message?: unknown; code?: unknown; data?: { details?: unknown } } | undefined;
				if (error) {
					const details = typeof error.data?.details === 'string' ? error.data.details : undefined;
					pending.reject(new RpcError(typeof error.message === 'string' ? error.message : 'Gemini CLI refused the request.', typeof error.code === 'number' ? error.code : undefined, details));
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
	binary: string, cwd: string, trust: Trust,
	onUpdate: (params: Record<string, unknown>) => void,
	onPermission: (id: unknown, params: Record<string, unknown>) => void,
	onExit: (reason: string) => void,
): Promise<AcpConnection> {
	const connection = new AcpConnection(binary, cwd, trust, onUpdate, onPermission, onExit);
	try {
		await connection.request('initialize', {
			protocolVersion: 1,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
			clientInfo: { name: 'ai-browser', title: 'AI Browser', version: extensionVersion() },
		});
		return connection;
	} catch (err) {
		// A process that ended before answering — no `node`, a broken settings
		// file, a binary that is not Gemini CLI — says why on stderr, which the
		// exit reason carries; one that answers nothing in time is left as is.
		const exited = connection.closed;
		connection.dispose();
		throw exited ? new Error(geminiExitText(err instanceof Error ? err.message : String(err), true)) : userError(err);
	}
}

/**
 * Whether Gemini CLI trusts `folder`, in its own judgement — the registry it
 * keeps (`~/.gemini/trustedFolders.json`, a parent's rule included), VS Code's
 * workspace trust when its companion extension is connected, its environment.
 * None of that is read here: the answer is asked of Gemini, so it is the one
 * its own terminal session will act on.
 *
 * ACP has no question for it, but one request answers it exactly: switching
 * the new session to `autoEdit`, which Gemini refuses in a folder it does not
 * trust ("Cannot enable privileged approval modes in an untrusted folder",
 * measured on 0.64 in both directions, and with `GEMINI_CLI_TRUST_WORKSPACE=false`).
 * The mode goes back to `default` at once, and the process ends; no prompt is
 * sent, so it costs nothing. `undefined`: no answer — not signed in (session/new
 * refused), a CLI that does not take the request, a timeout.
 */
export async function geminiTrustsFolder(binary: string, folder: string): Promise<GeminiFolderState> {
	let connection: AcpConnection | undefined;
	try {
		connection = await connect(binary, folder, undefined, () => { }, (id, params) => connection?.respond(id, geminiApprovalAnswer(params, false)), () => { });
		let session: { sessionId?: unknown } | undefined;
		try {
			session = await connection.request('session/new', { cwd: folder, mcpServers: [] }) as typeof session;
		} catch (err) {
			return signedOut(err) ? 'signedOut' : 'unknown';
		}
		const sessionId = session?.sessionId;
		if (typeof sessionId !== 'string') {
			return 'unknown';
		}
		try {
			await connection.request('session/set_mode', { sessionId, modeId: 'autoEdit' });
		} catch (err) {
			return err instanceof RpcError && /untrusted folder/i.test(`${err.details ?? ''} ${err.message}`) ? 'untrusted' : 'unknown';
		}
		await connection.request('session/set_mode', { sessionId, modeId: 'default' }).catch(() => undefined);
		return 'trusted';
	} catch {
		// Not started at all: no `node`, a malformed settings file. The terminal
		// the caller offers shows Gemini's own reason.
		return 'unknown';
	} finally {
		connection?.dispose();
	}
}

/** What `geminiTrustsFolder` found out; `unknown` when Gemini could not be asked. */
export type GeminiFolderState = 'trusted' | 'untrusted' | 'signedOut' | 'unknown';

export class GeminiBackend implements AgentBackend {
	public get running(): boolean { return [...this._sessions].some(session => session.running); }
	public readonly id = 'gemini' as const;
	private readonly _sessions = new Set<GeminiSession>();
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
	 * A short-lived process in the project folder: `session/new` lists the
	 * models, and the commands come right after it. Trust is forbidden, so
	 * nothing of the folder's own configuration is loaded for a listing — even
	 * where Gemini's registry trusts it. No prompt is sent, so it costs nothing.
	 */
	public async models(): Promise<ChatModel[]> {
		const { models, commands } = await this._probe();
		this._commands = commands;
		return models;
	}

	public async commands(cwd?: string): Promise<ChatCommand[]> {
		const { commands } = await this._probe(cwd);
		this._commands = commands;
		return commands;
	}

	private async _probe(cwd = this._cwd()): Promise<{ models: ChatModel[]; commands: ChatCommand[] }> {
		if (this._disposed) {
			throw new Error('Closed.');
		}
		let commands: ChatCommand[] = [];
		let heard: (() => void) | undefined;
		const listed = new Promise<void>(resolve => { heard = resolve; });
		const connection = await connect(this._binary, cwd, false, params => {
			const update = params.update as Record<string, unknown> | undefined;
			if (update?.sessionUpdate === 'available_commands_update') {
				commands = geminiCommands(update);
				heard?.();
			}
		}, (id, params) => connection.respond(id, geminiApprovalAnswer(params, false)), () => heard?.());
		try {
			const session = await connection.request('session/new', { cwd, mcpServers: [] }).catch(err => {
				if (signedOut(err)) {
					throw new Error(vscode.l10n.t("Gemini CLI is not signed in ({0}). Sign in with “Open Gemini CLI in Terminal” (the command palette), then press Refresh Agents.", err.message.trim().replace(/\.$/, '')));
				}
				throw userError(err);
			});
			await Promise.race([listed, new Promise(resolve => setTimeout(resolve, commandsWaitMs))]);
			return { models: geminiModels(session), commands };
		} finally {
			connection.dispose();
		}
	}

	/** Gemini CLI reports no plan limits over ACP; only the tokens and the context, per conversation. */
	public async usage(): Promise<AgentUsage> {
		return {
			agent: 'gemini', windows: [],
			notes: [vscode.l10n.t("Gemini CLI does not report plan limits to other programs. The tokens and the context of this chat are counted here.")],
		};
	}

	public openSession(cwd: string, resume?: string, _priorCostUsd?: number, root?: string, _readDirs?: readonly string[], ownSettings = true, chatId?: string): AgentSession {
		const browserServer = () => { const server = this._browserServer(); return server ? { ...server, chatId } : undefined; };
		const session = new GeminiSession(this._binary, cwd, root, resume, ownSettings, browserServer, () => this._sessions.delete(session));
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
	readonly resolve: (sent: boolean) => void;
	/** Refused with the reason it will not go: the chat shows it beside the message. */
	readonly reject: (err: Error) => void;
}

class GeminiSession implements AgentSession {
	private _connection: AcpConnection | undefined;
	/** Bumped with each process, so a question's id names the process that asked it. */
	private _generation = 0;
	private _sessionId: string | undefined;
	/** The session id is one the running process has loaded or made. */
	private _loaded = false;
	private _model: string | undefined;
	private _running = false;
	/** Stop came before the prompt was sent; the start path sees it at its next step. */
	private _stopRequested = false;
	/** `session/cancel` was sent for the running prompt. */
	private _stopping = false;
	/** The running turn's prompt has been sent: from here a Stop is `session/cancel`. */
	private _prompting = false;
	/** `session/load` replays the history as updates, which the chat already has. */
	private _replaying = false;
	/** The running turn has shown anything at all: text, a thought, a tool. */
	private _said = false;
	private _disposed = false;
	private _warnedUntrusted = false;
	/** Fires when the running prompt has heard nothing for `silenceNoticeMs`. */
	private _silence: ReturnType<typeof setTimeout> | undefined;
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
		/** The folder may load its own settings: trusted for this process, else trust is forbidden. */
		private readonly _trust: boolean,
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

	public send(input: TurnInput, model: string, _effort: string | undefined): Promise<boolean> {
		if (this._disposed) {
			return Promise.resolve(false);
		}
		if (this._running) {
			return new Promise((resolve, reject) => this._queue.push({ input, model, resolve, reject }));
		}
		return this._start(input, model);
	}

	/** Starts a turn; resolves once its prompt is sent, rejects when it could not be. */
	private async _start(input: TurnInput, model: string): Promise<boolean> {
		this._running = true;
		this._stopRequested = false;
		this._stopping = false;
		this._prompting = false;
		this._said = false;
		let connection: AcpConnection;
		try {
			connection = await this._ready(model);
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
		this._watchSilence();
		connection.request('session/prompt', { sessionId: this._sessionId, prompt }, null).then(
			result => {
				if (this._connection === connection) {
					this._finishTurn(geminiTurnEnd(result, this._model));
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

	/** The process, the session, and the model, each made ready if they are not. */
	private async _ready(model: string): Promise<AcpConnection> {
		let connection = this._connection;
		if (!connection || connection.closed) {
			const generation = ++this._generation;
			connection = await connect(
				this._binary, this._cwd, this._trust,
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
			this._model = undefined;
		}
		try {
			if (!this._loaded) {
				await this._openSession(connection);
			}
			if (model && model !== this._model) {
				await connection.request('session/set_model', { sessionId: this._sessionId, modelId: model });
				this._model = model;
			}
		} catch (err) {
			// The process went while the session was being made ready: said the way
			// `_processEnded` says it, which leaves this turn to `_start`.
			throw connection.closed ? new Error(geminiExitText(err instanceof Error ? err.message : String(err), false)) : err;
		}
		return connection;
	}

	private async _openSession(connection: AcpConnection): Promise<void> {
		const servers = this._trust ? mcpServers(this._browserServer()) : [];
		if (!this._trust && this._browserServer() && !this._warnedUntrusted) {
			this._warnedUntrusted = true;
			this.emit({ type: 'notice', text: vscode.l10n.t("This folder's own settings are held back until you trust them (the folder button), so Gemini CLI runs it as an untrusted folder — and without the browser tools, which it does not connect there.") });
		}
		const fail = (err: unknown) => userError(err);
		if (this._sessionId) {
			this._replaying = true;
			try {
				const loaded = await connection.request('session/load', { sessionId: this._sessionId, cwd: this._cwd, mcpServers: servers }, 120_000);
				this._model = currentModel(loaded);
				this._loaded = true;
				return;
			} catch (err) {
				if (signedOut(err)) {
					throw fail(err);
				}
				// A session Gemini no longer has — removed, or kept under another
				// project — is not worth refusing the message over.
				this.emit({ type: 'notice', text: vscode.l10n.t("Gemini CLI could not resume the earlier conversation ({0}); this message starts a new one.", err instanceof Error ? err.message : String(err)) });
			} finally {
				this._replaying = false;
			}
		}
		let started: unknown;
		try {
			started = await connection.request('session/new', { cwd: this._cwd, mcpServers: servers });
		} catch (err) {
			throw fail(err);
		}
		const id = (started as { sessionId?: unknown } | undefined)?.sessionId;
		if (typeof id !== 'string' || !id) {
			throw new Error('Gemini CLI did not start a conversation.');
		}
		this._sessionId = id;
		this._model = currentModel(started);
		this._loaded = true;
		this.emit({ type: 'session', id });
	}

	private _update(params: Record<string, unknown>): void {
		if (this._replaying || params.sessionId !== this._sessionId) {
			return;
		}
		if (this._prompting && this._asked.size === 0) {
			this._watchSilence();
		}
		for (const event of geminiEvents(params.update)) {
			if (event.type === 'text' || event.type === 'thinking' || event.type === 'tool') {
				this._said = true;
			}
			this.emit(event);
		}
	}

	/** (Re)starts the silence watch of the running prompt; see `silenceNoticeMs`. */
	private _watchSilence(): void {
		this._clearSilence();
		this._silence = setTimeout(() => {
			this._silence = undefined;
			if (!this._prompting || this._disposed) {
				return;
			}
			const model = this._model && this._model !== 'auto' ? this._model : undefined;
			this.emit({
				type: 'notice', text: model
					? vscode.l10n.t("Gemini CLI has not answered for {0} s. It retries a failing model request on its own, silently, for several minutes — {1} may not be answering for your account. Wait, or press Stop and pick another model.", Math.round(silenceNoticeMs / 1000), model)
					: vscode.l10n.t("Gemini CLI has not answered for {0} s. It retries a failing model request on its own, silently, for several minutes — the model Auto chose may not be answering for your account. Wait, or press Stop and pick a model by name.", Math.round(silenceNoticeMs / 1000)),
			});
		}, silenceNoticeMs);
	}

	private _clearSilence(): void {
		if (this._silence) {
			clearTimeout(this._silence);
			this._silence = undefined;
		}
	}

	private _ask(requestId: unknown, params: Record<string, unknown>): void {
		this._clearSilence();
		const id = `${this._generation}:${String(requestId)}`;
		if (this._disposed || this._stopping || params.sessionId !== this._sessionId) {
			this._connection?.respond(requestId, { outcome: { outcome: 'cancelled' } });
			return;
		}
		this._asked.set(id, { requestId, params });
		this.emit({ type: 'approval', request: geminiApproval(id, params, this._root) });
	}

	public answer(id: string, allow: boolean, _answers?: QuestionAnswers): void {
		const asked = this._asked.get(id);
		if (!asked) {
			return;
		}
		this._asked.delete(id);
		this._connection?.respond(asked.requestId, geminiApprovalAnswer(asked.params, allow));
		if (this._prompting && this._asked.size === 0) {
			this._watchSilence();
		}
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
	 * The turn is over: its tokens and its end, then the next message that
	 * waited for it, as a turn of its own. A Stop ends the running turn only —
	 * the messages queued behind it still go, as they do for Claude Code.
	 */
	private _finishTurn(events: readonly AgentEvent[]): void {
		const stopped = this._stopping;
		this._clearSilence();
		this._stopping = false;
		this._prompting = false;
		this._withdrawAll(false);
		this._running = false;
		// Gemini ends a turn whose response was empty, blocked for safety or
		// recitation, or a malformed tool call as an ordinary `end_turn` (read in
		// its `acpSession.ts`): with nothing on screen it read as the chat hanging.
		if (!stopped && !this._said && events.some(e => e.type === 'turnEnd' && !e.error)) {
			this.emit({ type: 'notice', text: vscode.l10n.t("Gemini CLI ended the turn without a reply — an empty or blocked response. Send the message again, rephrase it, or pick another model.") });
		}
		for (const event of events) {
			this.emit(event.type === 'turnEnd' && stopped ? { type: 'turnEnd', error: 'Stopped.' } : event);
		}
		const next = this._disposed ? undefined : this._queue.shift();
		if (!next) {
			return;
		}
		this.emit({ type: 'autoTurn' });
		// Its turn has begun in the chat (`autoTurn`), so a failure ends that turn
		// with the reason rather than refusing the send a second time.
		this._start(next.input, next.model).then(next.resolve, err => {
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
		// ACP: the client answers its open questions as cancelled after the
		// `session/cancel` — the turn waits on them otherwise (measured: a Stop
		// with a question open never ended the turn).
		connection.notify('session/cancel', { sessionId: this._sessionId });
		this._withdrawAll(true);
	}

	private _processEnded(reason: string): void {
		this._clearSilence();
		this._connection = undefined;
		this._loaded = false;
		this._withdrawAll(false);
		// Only a turn whose prompt went out is this to end. Before that, `_start`
		// is still awaiting `_ready`, whose request this exit rejects, and it
		// reports the failure itself — refusing the send, or, for a queued turn,
		// ending it. Ending it here too put the same error in the chat twice.
		if (this._running && this._prompting) {
			const stopped = this._stopping || this._stopRequested;
			this._stopping = false;
			this._stopRequested = false;
			this._running = false;
			this._prompting = false;
			this.emit({ type: 'turnEnd', error: stopped ? 'Stopped.' : geminiExitText(reason, false) });
		}
		this._dropQueue(vscode.l10n.t("Not sent: Gemini CLI stopped before this message's turn. Send it again."));
	}

	/**
	 * Lets go of the messages waiting for a turn: refused with `reason` — they
	 * were never sent, and the chat must not show them as sent — or, without
	 * one, given up quietly (the session is closing with its tab).
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
		this._clearSilence();
		this._dropQueue();
		this._asked.clear();
		this._generation++;
		this._connection?.dispose();
		this._connection = undefined;
		this._onEvent.dispose();
		this._onDispose();
	}
}

/** The model a `session/new` or `session/load` answer says is in use. */
function currentModel(answer: unknown): string | undefined {
	const models = (answer as { models?: { currentModelId?: unknown } } | undefined)?.models;
	return typeof models?.currentModelId === 'string' ? models.currentModelId : undefined;
}

function extensionVersion(): string {
	return vscode.extensions.getExtension('DenysDavydov.tab-browser-ultimate')?.packageJSON?.version ?? '0.0.0';
}
