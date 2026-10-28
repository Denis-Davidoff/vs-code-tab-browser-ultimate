/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { chatCapability } from '../core/chatCapability';
import { privateTempDirectory, writeFileAtomic } from '../core/safeFiles';
import type { AgentBackend, AgentSession, BrowserServer, TurnInput } from './agents';
import { JsonLineProcess, withTimeout } from './agentProcess';
import { claudeApproval, outsideProject, type AgentEvent } from './agentProtocol';
import type { AgentId, AgentUsage, ChatCommand, ChatModel, QuestionAnswers } from './chatProtocol';
import {
	PiEventReader, isCompactRequest, piArgs, piCommands, piContextWindow, piErrorText, piExitText, piGateExtension, piGateLoaded,
	piGateRequest, piGateTool, piIsDialog, piMcpEnv, piModels, piResponseError, piSignedOut, piSignedOutText, piState,
	piUiResponse, splitPiModel,
} from './piProtocol';

/**
 * Pi (`pi --mode rpc`) as a chat agent. The protocol readers and everything
 * measured about it are in `piProtocol.ts`; this file is the processes.
 *
 * **Pi has no permission system.** Run bare, it executes `bash`, `edit` and
 * `write` the moment the model asks. The only honest way to put the chat's
 * approval menu in front of it is an extension Pi loads (`-e`): its `tool_call`
 * handler asks through `ctx.ui.confirm`, which RPC mode turns into an
 * `extension_ui_request` we answer. So the gate is **always loaded**, and the
 * session proves it did load (`get_commands` lists `aib-gate`) before it sends
 * a prompt: a Pi that ran without the gate would run every tool unasked, so
 * the turn is refused instead. One notice per conversation says all of this.
 *
 * **One process per conversation**, like Claude Code and Gemini: `--session-id`
 * gives it exactly the id we mint (so the `ref` exists before the first
 * message, and `pi --session <ref>` resumes it in a terminal); a model or
 * thinking change goes through `set_model` / `set_thinking_level` on the live
 * process, no restart.
 *
 * **Not measured live** (marked again where it matters): a steer sent while the
 * final answer streams, a queue left unconsumed at `agent_settled` (resent as a
 * turn of its own, from the documentation of `clear_queue`), images in `prompt`,
 * and the gate against the real AI Browser MCP server (the script
 * `scripts/test-pi.mjs` does it against a fake one).
 */

const piAgentId = 'pi' as const satisfies AgentId;

const requestMs = 20_000;
const probeMs = 15_000;
const abortKillMs = 5_000;

/** A model or login problem the user can act on, thrown to the chat as a plain message. */
class PiError extends Error { }

/* ----------------------------------------------------------------- locating */

/** Folders that may hold the `node` the `pi` launcher script needs; VS Code started from the Dock has none on its PATH. */
function nodeDirs(): string[] {
	const home = os.homedir();
	const dirs = [path.join(home, '.local', 'share', 'pi-node', 'current', 'bin')];
	try {
		const base = path.join(home, '.nvm', 'versions', 'node');
		for (const v of fs.readdirSync(base).sort().reverse()) { dirs.push(path.join(base, v, 'bin')); }
	} catch { /* no nvm */ }
	dirs.push(path.join(home, '.npm-global', 'bin'), '/opt/homebrew/bin', '/usr/local/bin');
	return dirs.filter(dir => { try { return fs.statSync(path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node')).isFile(); } catch { return false; } });
}

/** The binary's folder, then a `node`'s, in front of the inherited PATH. */
export function piPath(binary: string): string {
	return [path.dirname(binary), ...nodeDirs(), process.env.PATH ?? ''].filter(Boolean).join(path.delimiter);
}

/** The gate extension on disk: private directory, `0600`, named by its text so a change of the text is a new file. */
async function gateFile(): Promise<string> {
	const dir = await privateTempDirectory('shared', 'runtime', 'pi');
	const name = `ai-browser-gate-${crypto.createHash('sha256').update(piGateExtension).digest('hex').slice(0, 12)}.ts`;
	const file = path.join(dir, name);
	let same = false;
	try { same = fs.readFileSync(file, 'utf8') === piGateExtension; } catch { /* absent */ }
	if (!same) { await writeFileAtomic(file, piGateExtension, 0o600, false); }
	return file;
}

/* --------------------------------------------------------------------- RPC */

type Waiting = { resolve: (response: Record<string, unknown>) => void; reject: (err: Error) => void };

/** One Pi process with request/response correlation; everything else goes to `onOther`. */
class PiRpc {
	private _next = 1;
	private readonly _waiting = new Map<string, Waiting>();
	private _exited = false;

	constructor(public readonly process: JsonLineProcess, onOther: (message: Record<string, unknown>) => void, onExit: (reason: string | undefined) => void) {
		process.onMessage(message => {
			if (message.type === 'response' && typeof message.id === 'string') {
				const waiting = this._waiting.get(message.id);
				if (waiting) { this._waiting.delete(message.id); waiting.resolve(message); }
				return;
			}
			onOther(message);
		});
		process.onExit(reason => {
			this._exited = true;
			for (const waiting of [...this._waiting.values()]) { waiting.reject(new Error(reason ?? 'Pi stopped.')); }
			this._waiting.clear();
			onExit(reason);
		});
	}

	public get exited(): boolean { return this._exited; }

	public request(command: Record<string, unknown>, ms = requestMs): Promise<Record<string, unknown>> {
		if (this._exited) { return Promise.reject(new Error('Pi stopped.')); }
		const id = `aib-${this._next++}`;
		const answer = new Promise<Record<string, unknown>>((resolve, reject) => this._waiting.set(id, { resolve, reject }));
		this.process.send({ ...command, id });
		return withTimeout(answer, ms, `Pi (${String(command.type)})`).catch(err => { this._waiting.delete(id); throw err; });
	}

	/** A request that must succeed; Pi's own words are the error. */
	public async ok(command: Record<string, unknown>, ms = requestMs): Promise<Record<string, unknown>> {
		const response = await this.request(command, ms);
		const error = piResponseError(response);
		if (error) { throw new PiError(error); }
		return response;
	}
}

/* ----------------------------------------------------------------- backend */

export interface PiOptions {
	/** Read AGENTS.md / CLAUDE.md into the system prompt. Off by default: they cost this repository's chat 225k tokens (83 % of the window) on one turn, measured. */
	readonly contextFiles?: boolean;
}

export class PiBackend implements AgentBackend {
	public readonly id = piAgentId;
	private readonly _sessions = new Set<PiSession>();
	private _commands: ChatCommand[] | undefined;
	private _disposed = false;

	public get running(): boolean { return [...this._sessions].some(s => s.running); }
	public get knownCommands(): readonly ChatCommand[] | undefined { return this._commands; }

	constructor(
		private readonly _binary: string,
		private readonly _cwd: () => string,
		private readonly _browserServer: () => BrowserServer | undefined = () => undefined,
		private readonly _options: PiOptions = {},
	) { }

	/**
	 * A short-lived process: `get_state` and `get_available_models`, with no
	 * extension and no prompt, so it costs nothing and loads none of the
	 * folder's own files. Signed out is told by Pi itself: model `unknown` and
	 * no models (measured). `pi -p` is not used — it hangs.
	 */
	public async models(): Promise<ChatModel[]> {
		const probe = await this._probe(this._cwd(), false);
		this._commands = probe.commands;
		return probe.models;
	}

	public async commands(cwd?: string, ownSettings = true): Promise<ChatCommand[]> {
		const probe = await this._probe(cwd ?? this._cwd(), ownSettings);
		this._commands = probe.commands;
		return probe.commands;
	}

	private async _probe(cwd: string, ownSettings: boolean): Promise<{ models: ChatModel[]; commands: ChatCommand[] }> {
		if (this._disposed) { throw new Error('Closed.'); }
		const proc = new JsonLineProcess(this._binary, piArgs({ noSession: true, noApprove: !ownSettings, contextFiles: false }), cwd, { PATH: piPath(this._binary) });
		const rpc = new PiRpc(proc, () => undefined, () => undefined);
		try {
			const state = await rpc.ok({ type: 'get_state' }, probeMs);
			const list = await rpc.ok({ type: 'get_available_models' }, probeMs);
			const models = piModels(list.data, piState(state)?.model);
			if (piSignedOut(state, models)) { throw new PiError(piSignedOutText); }
			const commands = piCommands((await rpc.request({ type: 'get_commands' }, probeMs).catch((): Record<string, unknown> => ({}))).data);
			return { models, commands };
		} catch (err) {
			if (err instanceof PiError) { throw err; }
			throw new Error(piExitText(err instanceof Error ? err.message : String(err), true));
		} finally {
			proc.endInput();
			proc.dispose();
		}
	}

	/** Pi reports no plan limits over RPC; the cost of each request is counted per turn. */
	public async usage(): Promise<AgentUsage> {
		return {
			agent: piAgentId, windows: [],
			notes: [vscode.l10n.t('Pi does not report plan limits to other programs. The tokens, the cost and the context of this chat are counted here.')],
		};
	}

	public openSession(cwd: string, resume?: string, _priorCostUsd?: number, root?: string, _readDirs?: readonly string[], ownSettings = true, chatId?: string): AgentSession {
		const server = () => { const s = this._browserServer(); return s ? { ...s, chatId } : undefined; };
		const session = new PiSession(this._binary, cwd, root, resume, ownSettings, !!this._options.contextFiles, server, () => this._sessions.delete(session));
		this._sessions.add(session);
		return session;
	}

	public dispose(): void {
		this._disposed = true;
		for (const session of [...this._sessions]) { session.dispose(); }
		this._sessions.clear();
	}
}

/* ----------------------------------------------------------------- session */

class PiSession implements AgentSession {
	private readonly _onEvent = new vscode.EventEmitter<AgentEvent>();
	public readonly onEvent = this._onEvent.event;

	private _ref: string | undefined;
	private _rpc: PiRpc | undefined;
	private _starting: Promise<PiRpc> | undefined;
	private _starting_proc: JsonLineProcess | undefined;
	private _running = false;
	private _disposed = false;
	private _stopRequested = false;
	private _noticed = false;
	/** Counts the runs, so a delayed kill after a Stop only ever ends the run that was stopped (#350). */
	private _runs = 0;
	/** The run whose turnEnd has been emitted: every path ends a run at most once, whichever gets there first. */
	private _endedRun = 0;
	private _chain: Promise<unknown> = Promise.resolve();
	private _model: string | undefined;
	private _effort: string | undefined;
	private readonly _reader = new PiEventReader();
	/** Gate questions waiting for the user, by the chat's approval id. */
	private readonly _asked = new Map<string, { rpc: PiRpc; requestId: string }>();
	/** Steered texts Pi has not shown as user messages yet; see `_settled`. */
	private _steered: TurnInput[] = [];
	private _queueLength = 0;

	constructor(
		private readonly _binary: string,
		private readonly _cwd: string,
		private readonly _root: string | undefined,
		resume: string | undefined,
		private readonly _ownSettings: boolean,
		private readonly _contextFiles: boolean,
		private readonly _browserServer: () => BrowserServer | undefined,
		private readonly _onDispose: () => void,
	) {
		this._ref = resume;
	}

	public get ref(): string | undefined { return this._ref; }
	public get running(): boolean { return this._running; }

	private _emit(event: AgentEvent): void {
		if (this._disposed) { return; }
		if (event.type === 'turnEnd') {
			if (this._endedRun === this._runs) { return; }
			this._endedRun = this._runs;
		}
		this._onEvent.fire(event);
	}

	/** Ends `run` once; false when it already ended or a newer run has begun. */
	private _endRun(run: number, error?: string): boolean {
		if (this._disposed || run !== this._runs || this._endedRun === run) { return false; }
		this._emit(error === undefined ? { type: 'turnEnd' } : { type: 'turnEnd', error });
		return true;
	}

	public send(input: TurnInput, model: string, effort: string | undefined): Promise<boolean> {
		// One send at a time: two at once would start two processes, or steer a turn that has no id yet.
		const run = this._chain.then(() => this._send(input, model, effort));
		this._chain = run.catch(() => undefined);
		return run;
	}

	private async _send(input: TurnInput, model: string, effort: string | undefined): Promise<boolean> {
		if (this._disposed) { return false; }
		const images = input.images.map(i => ({ type: 'image', data: i.base64, mimeType: i.mediaType }));
		if (this._running && this._rpc && !this._rpc.exited) {
			// Measured: a steer lands after the current turn's tool calls and before the next model request.
			// Not measured: one sent while the final answer streams (see `_settled`).
			this._steered.push(input);
			const response = await this._rpc.request({ type: 'steer', message: input.text, ...(images.length ? { images } : {}) });
			const error = piResponseError(response);
			if (error) { this._steered.pop(); throw new PiError(piErrorText(error)); }
			return true;
		}
		const parts = splitPiModel(model);
		if (!parts) { throw new PiError(vscode.l10n.t('Pick a Pi model first (press Refresh Agents if none are listed).')); }
		this._stopRequested = false;
		this._running = true;
		const run = ++this._runs;
		this._reader.reset();
		let rpc: PiRpc;
		try {
			rpc = await this._ensure(model, effort);
			if (this._stopRequested || this._disposed) {
				// A Stop that landed while the process was starting: the chat waits for this turn's end (Codex's `_finishStartup`).
				this._running = false;
				this._reader.reset();
				this._endRun(run, 'Stopped.');
				return false;
			}
			await this._apply(rpc, model, effort);
			if (isCompactRequest(input.text) && !images.length) { await this._compact(rpc, run); return true; }
			const response = await rpc.request({ type: 'prompt', message: input.text, ...(images.length ? { images } : {}) }, 30_000);
			const error = piResponseError(response);
			if (error) { throw new PiError(piErrorText(error)); }
			return true;
		} catch (err) {
			// The process ended mid-request: `_processEnded` already ended this run, and reporting it again would show it twice.
			if (this._endedRun === run && this._runs === run) { this._running = false; return false; }
			this._running = false;
			this._reader.reset();
			if (err instanceof PiError) { throw err; }
			throw new Error(piExitText(err instanceof Error ? err.message : String(err), !this._rpc));
		}
	}

	/** Starts the process the first time (or after it ended), proves the gate loaded, and tells the user once. */
	private _ensure(model: string, effort: string | undefined): Promise<PiRpc> {
		if (this._rpc && !this._rpc.exited) { return Promise.resolve(this._rpc); }
		this._starting ??= this._start(model, effort).finally(() => { this._starting = undefined; });
		return this._starting;
	}

	private async _start(model: string, effort: string | undefined): Promise<PiRpc> {
		const parts = splitPiModel(model)!;
		const fresh = !this._ref;
		const sessionId = this._ref ?? crypto.randomUUID();
		const extension = await gateFile();
		if (this._disposed) { throw new PiError('Closed.'); }
		const server = this._browserServer();
		const args = piArgs({
			provider: parts.provider, modelId: parts.id, thinking: effort, sessionId, extension,
			noApprove: !this._ownSettings, contextFiles: this._contextFiles,
		});
		const env = {
			PATH: piPath(this._binary),
			...piMcpEnv(server ? { url: server.url, token: server.token } : undefined, server?.chatId ? chatCapability(server.chatId) : undefined, undefined),
		};
		const proc = new JsonLineProcess(this._binary, args, this._cwd, env);
		// Not yet `_rpc`: `dispose` ends it from here, or a window closing mid-start leaves it until its handshake times out.
		this._starting_proc = proc;
		const rpc = new PiRpc(proc, message => this._message(rpc, message), reason => this._processEnded(rpc, reason));
		try {
			const state = await rpc.ok({ type: 'get_state' }, probeMs);
			if (this._stopRequested || this._disposed) { throw new PiError('Stopped.'); }
			// The gate is the only approval there is: without it Pi would run every tool unasked.
			const commands = await rpc.ok({ type: 'get_commands' }, probeMs);
			if (!piGateLoaded(commands.data)) {
				throw new PiError(vscode.l10n.t('Pi did not load the AI Browser approval gate, and without it every tool would run unasked, so nothing was sent. Update Pi, or report this.'));
			}
			const current = piState(state)?.model;
			if (!current || current.id === 'unknown') { throw new PiError(piSignedOutText); }
			this._reader.window = piContextWindow(current);
			this._model = model;
			this._effort = effort;
		} catch (err) {
			rpc.process.endInput();
			rpc.process.dispose();
			throw err;
		} finally {
			if (this._starting_proc === proc) { this._starting_proc = undefined; }
		}
		this._rpc = rpc;
		this._ref = sessionId;
		if (fresh) { this._emit({ type: 'session', id: sessionId }); }
		if (!this._noticed) {
			this._noticed = true;
			this._emit({ type: 'notice', text: vscode.l10n.t('Pi has no permission system of its own, so AI Browser asks about every tool it uses through the approval menu (Auto, Ask or Deny by category). Pi is started without AGENTS.md and CLAUDE.md: they cost this much context on one turn, and your own project instructions are not applied.') });
		}
		return rpc;
	}

	/** A model or thinking change on the live process; none of them restarts it. */
	private async _apply(rpc: PiRpc, model: string, effort: string | undefined): Promise<void> {
		const parts = splitPiModel(model)!;
		if (model !== this._model) {
			const response = await rpc.ok({ type: 'set_model', provider: parts.provider, modelId: parts.id });
			this._model = model;
			this._reader.window = piContextWindow(response.data) ?? this._reader.window;
		}
		if (effort && effort !== this._effort) {
			await rpc.ok({ type: 'set_thinking_level', level: effort });
			this._effort = effort;
		}
	}

	private async _compact(rpc: PiRpc, run: number): Promise<void> {
		try {
			await rpc.ok({ type: 'compact' }, 120_000);
			this._endRun(run);
		} catch (err) {
			// The process ended meanwhile (or the run already ended): `_processEnded` reported it.
			if (this._rpc !== rpc || this._endedRun === run) { return; }
			const text = err instanceof Error ? err.message : String(err);
			// Measured: "Nothing to compact (session too small)" is a refusal, not a failure of the chat.
			if (run === this._runs) { this._emit(/nothing to compact/i.test(text) ? { type: 'notice', text } : { type: 'notice', text: piErrorText(text) }); }
			this._endRun(run);
		} finally {
			if (this._runs === run) { this._running = false; }
		}
	}

	/* ---- what Pi sends ---------------------------------------------------------------- */

	private _message(rpc: PiRpc, message: Record<string, unknown>): void {
		if (this._disposed) { return; }
		if (message.type === 'extension_ui_request') { this._dialog(rpc, message); return; }
		if (message.type === 'queue_update') {
			const n = (v: unknown) => Array.isArray(v) ? v.length : 0;
			this._queueLength = n(message.steering) + n(message.followUp);
			return;
		}
		if (message.type === 'message_start' && isUser(message.message)) {
			// The steered message is now in the conversation.
			const text = userText(message.message);
			const at = this._steered.findIndex(s => s.text === text);
			if (at >= 0) { this._steered.splice(at, 1); }
		}
		if (message.type === 'agent_settled') { this._settled(rpc, message.aborted === true); return; }
		for (const event of this._reader.read(message)) { this._emit(event); }
	}

	/**
	 * The run ended. A message steered too late to be consumed would sit in
	 * Pi's queue for the next run: it is taken out and sent as a turn of its
	 * own, announced with `autoTurn` as Gemini's queued messages are. **Not
	 * measured** — no steer was observed to miss its turn; this follows the
	 * documentation of `clear_queue`.
	 */
	private _settled(rpc: PiRpc, aborted: boolean): void {
		this._running = false;
		this._withdrawAll(false);
		const leftover = aborted ? [] : this._steered.splice(0);
		this._steered = [];
		for (const event of this._reader.settle(aborted)) { this._emit(event); }
		if (leftover.length && this._queueLength > 0 && !this._disposed) {
			this._queueLength = 0;
			let run: number | undefined;
			const fail = (error: string): void => {
				// A process that ended meanwhile has been reported by `_processEnded`; a stale rpc says nothing more.
				if (this._rpc !== rpc || this._disposed) { return; }
				run ??= ++this._runs;
				if (this._runs === run) { this._running = false; }
				this._endRun(run, error);
			};
			void rpc.request({ type: 'clear_queue' }).then(() => {
				if (this._rpc !== rpc || this._disposed) { return undefined; }
				this._emit({ type: 'autoTurn' });
				this._running = true;
				run = ++this._runs;
				const text = leftover.map(l => l.text).join('\n\n');
				return rpc.request({ type: 'prompt', message: text }, 30_000);
			}).then(response => {
				if (!response) { return; }
				const error = piResponseError(response);
				if (error) { fail(piErrorText(error)); }
			}).catch(() => fail('A message sent while Pi was finishing was not delivered. Send it again.'));
		} else {
			this._steered = [];
		}
	}

	private _dialog(rpc: PiRpc, message: Record<string, unknown>): void {
		const gate = piGateRequest(message);
		if (!gate) {
			// A dialog of some other extension has nobody to answer it: cancelled, never guessed.
			if (piIsDialog(message)) { rpc.process.send(piUiResponse(String(message.id), 'cancel')); return; }
			for (const event of this._reader.read(message)) { this._emit(event); }
			return;
		}
		const mapped = piGateTool(gate.tool, gate.input);
		// Reads inside the project are never asked about (what Claude Code does too); outside it they are a card of their own.
		if (mapped.readOnly && mapped.path !== undefined && !outsideProject(this._root, mapped.path)) {
			rpc.process.send(piUiResponse(gate.requestId, true));
			return;
		}
		const id = `pi:${gate.requestId}`;
		this._asked.set(id, { rpc, requestId: gate.requestId });
		this._emit({ type: 'approval', request: claudeApproval(id, { tool_name: mapped.toolName, input: mapped.input }, this._root) });
	}

	public answer(id: string, allow: boolean, _answers?: QuestionAnswers): void {
		const asked = this._asked.get(id);
		if (!asked) { return; }
		this._asked.delete(id);
		asked.rpc.process.send(piUiResponse(asked.requestId, allow));
	}

	/** Answers every open question no, and closes its card when nobody answered it. */
	private _withdrawAll(emit = true): void {
		for (const [id, asked] of [...this._asked]) {
			this._asked.delete(id);
			asked.rpc.process.send(piUiResponse(asked.requestId, false));
			if (emit) { this._emit({ type: 'approvalDone', id }); }
		}
	}

	private _processEnded(rpc: PiRpc, reason: string | undefined): void {
		// A process that ended while still starting (not yet `_rpc`) is `_send`'s to report: it rejects with the reason, and a turnEnd here too would show the error twice (#514).
		const established = this._rpc === rpc;
		if (established) { this._rpc = undefined; }
		if (this._disposed) { return; }
		if (!established) { this._withdrawAll(true); return; }
		const wasRunning = this._running;
		this._running = false;
		this._withdrawAll(true);
		this._steered = [];
		if (wasRunning) {
			const stopped = this._stopRequested;
			this._reader.reset();
			this._endRun(this._runs, stopped ? 'Stopped.' : piExitText(reason ?? 'The process ended.', false));
		}
	}

	/* ---- stop and dispose ------------------------------------------------------------- */

	public stop(): void {
		this._stopRequested = true;
		const rpc = this._rpc;
		if (!rpc || rpc.exited || !this._running) { return; }
		this._reader.stopping = true;
		this._withdrawAll(true);
		// The queue is taken out first, or a steered message would be the next thing Pi does after the abort.
		void rpc.request({ type: 'clear_queue' }, 3000).catch(() => undefined).then(() => rpc.request({ type: 'abort' }, 5000)).catch(() => undefined);
		const run = this._runs;
		const timer = setTimeout(() => {
			// Only the process this stop was about, and only if that same run is still going (#350).
			if (this._rpc === rpc && this._running && this._runs === run) { rpc.process.kill(); }
		}, abortKillMs);
		timer.unref?.();
	}

	public dispose(): void {
		if (this._disposed) { return; }
		this._withdrawAll(false);
		this._disposed = true;
		const rpc = this._rpc;
		this._rpc = undefined;
		if (rpc) { rpc.process.endInput(); rpc.process.dispose(); }
		if (this._starting_proc) { this._starting_proc.endInput(); this._starting_proc.dispose(); this._starting_proc = undefined; }
		this._onEvent.dispose();
		this._onDispose();
	}
}

function isUser(message: unknown): message is Record<string, unknown> {
	return typeof message === 'object' && message !== null && (message as Record<string, unknown>).role === 'user';
}

function userText(message: Record<string, unknown>): string {
	const content = message.content;
	if (typeof content === 'string') { return content; }
	return Array.isArray(content)
		? content.map(part => typeof part === 'object' && part && typeof (part as Record<string, unknown>).text === 'string' ? (part as Record<string, unknown>).text as string : '').join('')
		: '';
}
