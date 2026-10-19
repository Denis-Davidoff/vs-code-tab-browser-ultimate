import { requestCommitMessage } from './commitMessage';
import { requestTitle } from './autoTitle';
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs, writeFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { JsonLineProcess, withTimeout } from './agentProcess';
import { claudeApproval, claudeApprovalAnswer, claudeCommands, claudeEvents, claudeModels, claudeUsage, type AgentEvent } from './agentProtocol';
import type { AgentBackend, AgentSession, BrowserServer, TurnInput } from './agents';
import type { AgentUsage, ChatCommand, ChatModel, QuestionAnswers } from './chatProtocol';
import { existingPrivateTempDirectory, privateTempDirectory } from '../core/safeFiles';
import { generateUuid } from '../core/uuid';

/**
 * Claude Code, driven as its own VS Code extension drives it:
 * `claude -p --input-format stream-json --output-format stream-json --verbose`.
 *
 * Turns are `{ type: 'user', message }` lines on stdin; the process stays up
 * between them, so one process is one conversation. Everything else — the
 * model list, usage, interrupting — is a `control_request` on the same pipe,
 * answered by a `control_response` carrying the same `request_id`.
 *
 * **The model and the effort are fixed for the life of a process**, because
 * `--effort` is a launch flag. A change takes effect at the next message: the
 * process is stopped and a new one started with `--resume <session id>`, which
 * keeps the conversation. Measured: a resumed process continues the session.
 *
 * **Permissions are asked in the chat.** `--permission-prompt-tool stdio` makes
 * the CLI send a `can_use_tool` control request whenever a tool needs a yes —
 * the same question its terminal would ask — and the answer goes back as the
 * `control_response`. Without the flag `-p` refused every such tool outright,
 * the browser tools included. A question the CLI no longer needs (a Stop, the
 * turn interrupted) is withdrawn with `control_cancel_request`. Measured on
 * 2.1.301: allow runs the tool, deny reaches the model as the tool's error.
 */
// `--thinking-display summarized` is what makes thinking visible at all: without
// it no `thinking` block is streamed, even when the model thinks. Measured on
// Sonnet 5.5 and on Haiku 4.5, which has no adaptive thinking and still takes it.
const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--thinking-display', 'summarized', '--permission-mode', 'default', '--permission-prompt-tool', 'stdio'];

const controlTimeoutMs = 20_000;
/** How long detection's process is kept for the plan's usage after the models are in. */
const usageProbeWaitMs = 8_000;

/**
 * Where the `--mcp-config` files go: the private temp directory, `0700`, made
 * once per extension host. Cached, so a send waits on it only the first time
 * — after that the await is an already-settled promise, and nothing the user
 * does can land between it and the send counting its turn.
 */
let configDir: Promise<string | undefined> | undefined;

function browserConfigDir(): Promise<string | undefined> {
	configDir ??= privateTempDirectory('chat').catch(() => undefined);
	return configDir;
}

/**
 * Removes `--mcp-config` files whose process is gone: each is written for one
 * CLI process and removed when it exits, so one left behind means the
 * extension host that wrote it ended first. The host's pid is in the name, and
 * a file is removed only once that pid no longer runs. **Not by age**: a chat
 * tab can stay open for days, and a sweep at a day old removed the file of a
 * process still running — harmless to it, since the CLI reads the file once,
 * but a session that started its next process from a cached path then failed
 * with "MCP config file not found" on every message (the first version).
 */
export async function sweepBrowserConfigs(): Promise<void> {
	const dir = await existingPrivateTempDirectory('chat');
	if (!dir) {
		return;
	}
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return;
	}
	await Promise.all(names.map(async name => {
		const owner = /^mcp-(\d+)-[0-9a-f-]+\.json$/.exec(name);
		if (!owner || hostRuns(Number(owner[1]))) {
			return;
		}
		try {
			const file = path.join(dir, name);
			if ((await fs.lstat(file)).isFile()) {
				await fs.unlink(file);
			}
		} catch {
			// Gone already.
		}
	}));
}

/** Whether a process with this pid exists; `EPERM` means it does, as somebody else's. */
function hostRuns(pid: number): boolean {
	if (pid === process.pid) {
		return true;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** Request and response correlation over a process's control channel. */
class ControlChannel implements vscode.Disposable {
	private readonly _pending = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
	private readonly _subscriptions: vscode.Disposable[] = [];
	/** Permission questions asked and not yet answered, by request id, with the tool and input they were about. */
	private readonly _asked = new Map<string, { readonly tool: unknown; readonly input: unknown }>();

	/**
	 * `onAsk` hears a permission question, `onWithdraw` that the CLI no longer
	 * needs the answer. Without `onAsk` — the short-lived detection probe, which
	 * never runs a tool — a question is refused as before.
	 */
	constructor(
		private readonly _process: JsonLineProcess,
		private readonly _onAsk?: (id: string, request: Record<string, unknown>) => void,
		private readonly _onWithdraw?: (id: string) => void,
	) {
		this._subscriptions.push(_process.onMessage(message => this._receive(message)));
		this._subscriptions.push(_process.onExit(reason => this._failAll(reason ?? 'Claude Code exited.')));
	}

	public request(subtype: string, extra: Record<string, unknown> = {}): Promise<unknown> {
		const id = generateUuid();
		const answer = new Promise<unknown>((resolve, reject) => this._pending.set(id, { resolve, reject }));
		this._process.send({ type: 'control_request', request_id: id, request: { subtype, ...extra } });
		return withTimeout(answer, controlTimeoutMs, `Claude Code (${subtype})`).finally(() => this._pending.delete(id));
	}

	private _receive(message: Record<string, unknown>): void {
		if (message.type === 'control_response') {
			const response = message.response as Record<string, unknown> | undefined;
			const pending = typeof response?.request_id === 'string' ? this._pending.get(response.request_id) : undefined;
			if (pending) {
				if (response?.subtype === 'error') {
					pending.reject(new Error(typeof response.error === 'string' ? response.error : 'Claude Code refused the request.'));
				} else {
					pending.resolve(response?.response);
				}
			}
			return;
		}
		if (message.type === 'control_cancel_request' && typeof message.request_id === 'string') {
			if (this._asked.delete(message.request_id)) {
				this._onWithdraw?.(message.request_id);
			}
			return;
		}
		const request = message.request as Record<string, unknown> | undefined;
		if (message.type === 'control_request' && typeof message.request_id === 'string' && request?.subtype === 'can_use_tool' && this._onAsk) {
			this._asked.set(message.request_id, { tool: request.tool_name, input: request.input });
			this._onAsk(message.request_id, request);
			return;
		}
		// The CLI asks the host other things too — an SDK-side MCP call, a hook.
		// Nothing here is registered for them, so each is refused at once: an
		// unanswered request would hang the turn.
		if (message.type === 'control_request' && typeof message.request_id === 'string') {
			this._process.send({
				type: 'control_response',
				response: { subtype: 'error', request_id: message.request_id, error: 'Not supported by AI Browser.' },
			});
		}
	}

	/** Answers a permission question; a question already answered or withdrawn is ignored. */
	public answer(id: string, allow: boolean, answers?: QuestionAnswers): void {
		const asked = this._asked.get(id);
		if (!asked) {
			return;
		}
		this._asked.delete(id);
		const question = asked.tool === 'AskUserQuestion';
		const response = claudeApprovalAnswer(asked.input, allow, question ? answers : undefined, question);
		this._process.send({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });
	}

	/** Questions still open, which end with the channel. */
	public get asked(): readonly string[] {
		return [...this._asked.keys()];
	}

	private _failAll(reason: string): void {
		for (const pending of this._pending.values()) {
			pending.reject(new Error(reason));
		}
		this._pending.clear();
	}

	public dispose(): void {
		this._subscriptions.forEach(s => s.dispose());
		this._failAll('Closed.');
	}
}

/**
 * A folder the extension fetched from GitHub and the user has not trusted:
 * only the user's own settings, and only the MCP servers given with
 * `--mcp-config`. `-p` skips Claude Code's own trust dialog, so without these
 * the repository's `.claude/settings.json` hooks — shell commands — ran on the
 * first process started there (measured on 2.1.301: a `SessionStart` hook on an
 * `initialize` alone; with these, nothing). Its skills and CLAUDE.md are still
 * read: text, not code.
 */
const projectSettingsOff = ['--setting-sources=user', '--strict-mcp-config'];

export class ClaudeBackend implements AgentBackend {
	public readonly id = 'claude' as const;
	private readonly _sessions = new Set<ClaudeSession>();
	/** Detection's processes kept for the usage answer; ended with the backend. */
	private readonly _lent = new Set<() => void>();
	private _disposed = false;

	constructor(
		private readonly _binary: string,
		private readonly _cwd: () => string,
		private readonly _browserServer: () => BrowserServer | undefined = () => undefined,
		private readonly _ownSettings: () => boolean = () => true,
		/** A plan read whole; the chat keeps its limit line from these. */
		private readonly _sawUsage: (usage: AgentUsage) => void = () => { },
	) { }

	private _commands: ChatCommand[] | undefined;

	public get knownCommands(): readonly ChatCommand[] | undefined {
		return this._commands;
	}

	/**
	 * The `initialize` answer carries the skills and commands too, so they are
	 * kept from here. The plan's usage is asked of the same process, so the
	 * chat knows how near a limit is before the first message without starting
	 * another one: detection does not wait for it, and the process is kept for
	 * the answer, at most `usageProbeWaitMs`.
	 */
	public async models(): Promise<ChatModel[]> {
		const probe = this._probe();
		const initialize = probe.control.request('initialize');
		// Guarded whole: a throw while reading the answer would otherwise escape
		// the `void` below as an unhandled rejection (#93).
		const usage = probe.control.request('get_usage').then(response => { this._seen(claudeUsage(response)); }).catch(() => undefined);
		let lent = false;
		try {
			const answer = await initialize;
			this._commands = claudeCommands(answer);
			if (!this._disposed) {
				lent = true;
				this._lent.add(probe.close);
				void Promise.race([usage, new Promise(resolve => setTimeout(resolve, usageProbeWaitMs))]).finally(() => {
					this._lent.delete(probe.close);
					probe.close();
				});
			}
			return claudeModels(answer);
		} finally {
			if (!lent) {
				probe.close();
			}
		}
	}

	/**
	 * Asked of a short-lived process in the project folder, not of a live
	 * session: a second `initialize` on a running conversation is not
	 * something the CLI is known to take.
	 */
	public async commands(): Promise<ChatCommand[]> {
		const commands = await this._withProbe(async control => claudeCommands(await control.request('initialize')));
		this._commands = commands;
		return commands;
	}

	/**
	 * Plan usage. Asked of a live session when there is one — the answer is the
	 * same and it saves a start-up — and of a short-lived process otherwise.
	 * `liveOnly`: never start a process for it; the chat's own checks after a
	 * turn ask this way, the `U` popup does not.
	 */
	public async usage(liveOnly = false): Promise<AgentUsage> {
		try {
			const live = [...this._sessions].find(s => s.control);
			if (!live?.control && liveOnly) {
				return { agent: 'claude', windows: [], notes: [], error: 'No conversation is running.' };
			}
			const response = live?.control
				? await live.control.request('get_usage')
				: await this._withProbe(control => control.request('get_usage'));
			return this._seen(claudeUsage(response));
		} catch (err) {
			return { agent: 'claude', windows: [], notes: [], error: err instanceof Error ? err.message : String(err) };
		}
	}

	public generateCommitMessage(model: string, effort: string | undefined, context: string, signal: AbortSignal): Promise<string> {
		return requestCommitMessage(this._binary, this.id, model, effort, context, signal);
	}

	public generateTitle(model: ChatModel, context: string, signal: AbortSignal, purpose?: 'branch'): Promise<string | undefined> {
		return requestTitle(this._binary, this.id, model, context, signal, purpose);
	}

	public openSession(cwd: string, resume?: string, priorCostUsd?: number, root?: string, readDirs?: readonly string[], ownSettings = true, chatId?: string): AgentSession {
		const browserServer = () => { const server = this._browserServer(); return server ? { ...server, chatId } : undefined; };
		const session = new ClaudeSession(this._binary, cwd, root, resume, priorCostUsd ?? 0, browserServer, () => this._sessions.delete(session), readDirs ?? [], ownSettings);
		this._sessions.add(session);
		return session;
	}

	private _seen(usage: AgentUsage): AgentUsage {
		if (!usage.error && !this._disposed) {
			try {
				this._sawUsage(usage);
			} catch {
				// The chat's bookkeeping; the read itself succeeded.
			}
		}
		return usage;
	}

	private async _withProbe<T>(use: (control: ControlChannel) => Promise<T>): Promise<T> {
		const probe = this._probe();
		try {
			return await use(probe.control);
		} finally {
			probe.close();
		}
	}

	private _probe(): { control: ControlChannel; close: () => void } {
		// The skills listing starts a process in the tab in front's folder, and a
		// `SessionStart` hook runs on that alone — measured, with nothing sent.
		const process = new JsonLineProcess(this._binary, this._ownSettings() ? args : [...args, ...projectSettingsOff], this._cwd());
		const control = new ControlChannel(process);
		return {
			control,
			close: () => {
				control.dispose();
				process.dispose();
			},
		};
	}

	public dispose(): void {
		this._disposed = true;
		for (const close of [...this._lent]) {
			close();
		}
		this._lent.clear();
		for (const session of [...this._sessions]) {
			session.dispose();
		}
	}
}

class ClaudeSession implements AgentSession {
	private _process: JsonLineProcess | undefined;
	private _control: ControlChannel | undefined;
	private _launched: { model: string; effort: string | undefined } | undefined;
	private _sessionId: string | undefined;
	/** Task id to the call it belongs to, from `task_started`; read for `task_updated`. */
	private readonly _tasks = new Map<string, string>();
	/** The conversation's own model, for the context window `result` names; see `claudeEvents`. */
	private readonly _context: { model?: string } = {};
	/** Calls that are agents, the only ones whose background state holds the process. */
	private readonly _agentTools = new Set<string>();
	private _toldWaiting = false;
	/** Messages sent whose `result` has not arrived; the CLI queues them in order. */
	private _pendingTurns = 0;
	/**
	 * Background agents still running, by their call's id. They outlive the turn
	 * that started them, so the process must not be restarted for a model or
	 * effort change while any is alive — the restart would end them.
	 */
	private readonly _agents = new Set<string>();
	private _stopping = false;
	/**
	 * `total_cost_usd` is cumulative, so each turn is the difference from the
	 * last figure. **And a process started with `--resume` does not count from
	 * zero**: it restores the session's cost ledger from the transcript —
	 * measured, a resumed process's first turn reported 0.0039 where the turn
	 * itself cost about 0.0018, the rest being the earlier process's. So the
	 * baseline of a resumed process is the session's cost so far, and a figure
	 * below it (a ledger that was not restored) is taken as the turn's own.
	 */
	private _processCost = 0;
	private _sessionCost: number;
	private _disposed = false;

	private readonly _onEvent = new vscode.EventEmitter<AgentEvent>();
	public readonly onEvent = this._onEvent.event;

	constructor(
		private readonly _binary: string,
		private readonly _cwd: string,
		private readonly _root: string | undefined,
		resume: string | undefined,
		priorCostUsd: number,
		private readonly _browserServer: () => BrowserServer | undefined,
		private readonly _onDispose: () => void,
		private readonly _readDirs: readonly string[] = [],
		private readonly _ownSettings = true,
	) {
		this._sessionId = resume;
		this._sessionCost = priorCostUsd;
	}

	public get ref(): string | undefined {
		return this._sessionId;
	}

	public get running(): boolean {
		return this._pendingTurns > 0;
	}

	public get control(): ControlChannel | undefined {
		return this._process?.exited ? undefined : this._control;
	}

	public async send(input: TurnInput, model: string, effort: string | undefined): Promise<void> {
		if (this._disposed) {
			return;
		}
		// Before anything below looks at the process: two sends that both wait
		// here resume in order, and the second then finds the process the first
		// started rather than starting another.
		const dir = this._browserServer() ? await browserConfigDir() : undefined;
		if (this._disposed) {
			return;
		}
		// A different model or effort needs a new process — but never in the
		// middle of a turn, where the message joins the running one instead.
		const changed = this._launched?.model !== model || this._launched?.effort !== effort;
		if (this._process && !this.running && !this._agents.size && changed) {
			this._stopProcess();
		} else if (this._process && changed && this._agents.size && !this._toldWaiting) {
			// A restart would end the agents still working; the change waits for
			// them, and the user is told rather than left to wonder.
			this._toldWaiting = true;
			this._onEvent.fire({ type: 'notice', text: vscode.l10n.t("The new model or effort applies once the background agents have finished.") });
		}
		if (!this._process || this._process.exited) {
			this._start(model, effort, dir);
		}

		const content: unknown[] = input.images.map(image => ({
			type: 'image',
			source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
		}));
		if (input.text) {
			content.push({ type: 'text', text: input.text });
		}
		// **A message sent during a turn is not a turn of its own, or not always.**
		// Measured on 2.1.301: one that arrives while a tool runs is taken into
		// the running turn at the next tool boundary — one `result` for both —
		// and one that arrives during the final text gets a turn of its own,
		// announced by `status: requesting` after the first `result`. Counting
		// every message as a turn left the count at one after a merged message:
		// the chat read as working for ever. So only an idle send starts a turn,
		// and a following turn is taken from `requesting` (`autoTurn`).
		if (this._pendingTurns === 0) {
			this._pendingTurns = 1;
		}
		this._process!.send({
			type: 'user',
			message: { role: 'user', content },
			parent_tool_use_id: null,
			session_id: this._sessionId ?? '',
		});
	}

	/**
	 * Claude Code's own `stop_task` control request, which takes the task id —
	 * `task_started` gave it beside the call's id, kept in `_tasks`. The task's
	 * `task_notification` then ends the row like any other ending.
	 */
	public async stopAgent(rowId: string): Promise<void> {
		const taskId = [...this._tasks].find(([, call]) => call === rowId)?.[0];
		if (!taskId || !this._control) {
			throw new Error(vscode.l10n.t("Claude Code has not reported this agent as a task."));
		}
		await this._control.request('stop_task', { task_id: taskId });
	}

	public stop(): void {
		if (!this.running || !this._control) {
			return;
		}
		this._stopping = true;
		const process = this._process;
		this._control.request('interrupt').catch(() => {
			// The CLI did not take the interrupt; ending the process is the only
			// stop left, and `--resume` brings the conversation back. **Only that
			// process, and only while a turn is still pending on it**: the
			// rejection can come 20 s later, or from the channel being closed by
			// a model change — by then this may be a new process with a new turn
			// that nobody asked to stop.
			if (this._process === process && this._pendingTurns > 0) {
				this._stopProcess();
			}
		});
	}

	public answer(id: string, allow: boolean, answers?: QuestionAnswers): void {
		this._control?.answer(id, allow, answers);
	}

	/**
	 * A config file naming the browser server, for `--mcp-config`, written for
	 * one process and removed when it exits. A file and not the JSON as an
	 * argument: the token would be in the process list, which every local user
	 * can read. `0600`, in the private temp directory, the extension host's pid in
	 * the name for `sweepBrowserConfigs`. Passed this way the server replaces a
	 * project `.mcp.json` entry of the same name rather than being listed twice
	 * (measured: one `ai-browser`, `source: dynamic`). Read from the server at
	 * every start, so a moved port reaches the next process.
	 */
	private _writeBrowserConfig(dir: string | undefined): string | undefined {
		const server = this._browserServer();
		if (!dir || !server) {
			return undefined;
		}
		const file = path.join(dir, `mcp-${process.pid}-${generateUuid()}.json`);
		try {
			writeFileSync(file, JSON.stringify({ mcpServers: { 'ai-browser': { type: 'http', url: server.url, headers: { Authorization: `Bearer ${server.token}`, ...(server.chatId ? { 'X-AI-Browser-Chat': server.chatId } : {}) } } } }), { mode: 0o600, flag: 'wx' });
			return file;
		} catch {
			return undefined;
		}
	}

	private _start(model: string, effort: string | undefined, dir: string | undefined): void {
		const config = this._writeBrowserConfig(dir);
		const launch = [...args, '--model', model];
		if (effort) {
			launch.push('--effort', effort);
		}
		if (this._sessionId) {
			launch.push('--resume', this._sessionId);
		}
		if (config) {
			launch.push('--mcp-config', config);
		}
		// With `=`: the option is variadic, and a value after a space would take
		// the arguments that follow it as more folders.
		for (const dir of this._readDirs) {
			launch.push(`--add-dir=${dir}`);
		}
		if (!this._ownSettings) {
			launch.push(...projectSettingsOff);
		}
		const process = new JsonLineProcess(this._binary, launch, this._cwd);
		if (config) {
			// Every process, current or not: the file is this process's alone.
			process.onExit(() => { void fs.unlink(config).catch(() => { /* swept */ }); });
		}
		this._process = process;
		this._control = new ControlChannel(
			process,
			(id, request) => { if (process === this._process) { this._onEvent.fire({ type: 'approval', request: claudeApproval(id, request, this._root) }); } },
			id => { if (process === this._process) { this._onEvent.fire({ type: 'approvalDone', id }); } },
		);
		this._launched = { model, effort };
		this._processCost = this._sessionId ? this._sessionCost : 0;

		process.onMessage(message => {
			if (process !== this._process) {
				return;
			}
			for (const event of claudeEvents(message, this._tasks, this._context)) {
				this._handle(event);
			}
		});
		process.onExit(reason => {
			if (process !== this._process) {
				return;
			}
			this._process = undefined;
			this._withdrawAll();
			this._control?.dispose();
			this._control = undefined;
			this._endAgents();
			if (this._pendingTurns > 0) {
				this._pendingTurns = 0;
				this._onEvent.fire({ type: 'turnEnd', error: this._stopping ? 'Stopped.' : reason ?? 'Claude Code exited.' });
			}
			this._stopping = false;
		});
	}

	private _handle(event: AgentEvent): void {
		switch (event.type) {
			case 'session':
				this._sessionId = event.id;
				break;
			case 'autoTurn':
				// `status: requesting` comes at the start of every request of the
				// main agent; it is a turn of its own only when nothing was sent.
				if (this._pendingTurns > 0) {
					return;
				}
				this._pendingTurns = 1;
				break;
			case 'tool':
				// An agent an agent started lives and ends inside its parent: the
				// parent is what holds a model change back and what a process exit
				// ends, and the chat ends the child with it (`parentId`).
				if (event.tool.kind === 'agent' && !event.tool.agent?.parentId) {
					this._agentTools.add(event.id);
					// Asked for in the background: counted from the call, so a process
					// that goes before the launch is confirmed still reports it ended.
					if (event.tool.agent?.background) {
						this._agents.add(event.id);
					}
				}
				break;
			case 'toolUpdate': {
				const agent = event.update.agent;
				if (event.update.status) {
					this._agents.delete(event.id);
					this._toldWaiting &&= this._agents.size > 0;
				} else if (agent?.background && this._agentTools.has(event.id)) {
					// Only an agent call: a background shell is a task too, and a dev
					// server that never ends would hold the model for good.
					this._agents.add(event.id);
				}
				break;
			}
			case 'tokens':
				if (event.costUsd !== undefined) {
					const turnCost = event.costUsd >= this._processCost ? event.costUsd - this._processCost : event.costUsd;
					this._processCost = event.costUsd;
					this._sessionCost += turnCost;
					this._onEvent.fire({ ...event, costUsd: turnCost });
					return;
				}
				break;
			case 'turnEnd':
				this._pendingTurns = Math.max(0, this._pendingTurns - 1);
				// **A stop is for the turn it was pressed during, not for the queue
				// behind it.** Measured: the interrupt is acknowledged at once, the
				// interrupted turn ends `error_during_execution`, and a message
				// queued behind it still runs and ends `success`. Carrying the flag
				// on reported that answered message as "Stopped.".
				if (this._stopping) {
					this._stopping = false;
					this._onEvent.fire({ type: 'turnEnd', error: 'Stopped.' });
					return;
				}
				break;
		}
		this._onEvent.fire(event);
	}

	/** Background agents end with the process that runs them; their rows are told so. */
	private _endAgents(): void {
		const agents = [...this._agents];
		this._agents.clear();
		if (!this._disposed) {
			for (const id of agents) {
				this._onEvent.fire({ type: 'toolUpdate', id, update: { status: 'stopped' } });
			}
		}
	}

	/** Questions the process asked die with it; the chat is told, so no card waits for ever. */
	private _withdrawAll(): void {
		for (const id of this._control?.asked ?? []) {
			if (!this._disposed) {
				this._onEvent.fire({ type: 'approvalDone', id });
			}
		}
	}

	private _stopProcess(): void {
		this._endAgents();
		this._toldWaiting = false;
		this._withdrawAll();
		const process = this._process;
		this._process = undefined;
		this._control?.dispose();
		this._control = undefined;
		process?.dispose();
		// The exit handler ignores a process that is no longer current, so a
		// turn ended this way is ended here.
		if (this._pendingTurns > 0) {
			this._pendingTurns = 0;
			this._stopping = false;
			if (!this._disposed) {
				this._onEvent.fire({ type: 'turnEnd', error: 'Stopped.' });
			}
		}
	}

	public dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._stopProcess();
		this._onEvent.dispose();
		this._onDispose();
	}
}
