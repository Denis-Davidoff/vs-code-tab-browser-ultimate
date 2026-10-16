/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { JsonLineProcess, withTimeout } from './agentProcess';
import { claudeEvents, claudeModels, claudeUsage, type AgentEvent } from './agentProtocol';
import type { AgentBackend, AgentSession, TurnInput } from './agents';
import type { AgentUsage, ChatModel } from './chatProtocol';
import { generateUuid } from './uuid';

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
 * **Permissions: none are granted.** There is no `--permission-prompt-tool`,
 * so in `-p` mode every tool call that needs approval is refused and the model
 * is told so. Approvals in the chat itself are the next step.
 */
// `--thinking-display summarized` is what makes thinking visible at all: without
// it no `thinking` block is streamed, even when the model thinks. Measured on
// Sonnet 5.5 and on Haiku 4.5, which has no adaptive thinking and still takes it.
const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--thinking-display', 'summarized', '--permission-mode', 'default'];

const controlTimeoutMs = 20_000;

/** Request and response correlation over a process's control channel. */
class ControlChannel implements vscode.Disposable {
	private readonly _pending = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
	private readonly _subscriptions: vscode.Disposable[] = [];

	constructor(private readonly _process: JsonLineProcess) {
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
		// The CLI asks the host things too — a permission prompt, an SDK-side
		// MCP call, a hook. Nothing here is registered for any of them, so each
		// is refused at once: an unanswered request would hang the turn.
		if (message.type === 'control_request' && typeof message.request_id === 'string') {
			this._process.send({
				type: 'control_response',
				response: { subtype: 'error', request_id: message.request_id, error: 'Not supported by AI Browser.' },
			});
		}
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

export class ClaudeBackend implements AgentBackend {
	public readonly id = 'claude' as const;
	private readonly _sessions = new Set<ClaudeSession>();

	constructor(private readonly _binary: string, private readonly _cwd: () => string) { }

	public async models(): Promise<ChatModel[]> {
		return this._withProbe(async control => claudeModels(await control.request('initialize')));
	}

	/**
	 * Plan usage. Asked of a live session when there is one — the answer is the
	 * same and it saves a start-up — and of a short-lived process otherwise.
	 */
	public async usage(): Promise<AgentUsage> {
		try {
			const live = [...this._sessions].find(s => s.control);
			const response = live?.control
				? await live.control.request('get_usage')
				: await this._withProbe(control => control.request('get_usage'));
			return claudeUsage(response);
		} catch (err) {
			return { agent: 'claude', windows: [], notes: [], error: err instanceof Error ? err.message : String(err) };
		}
	}

	public openSession(cwd: string, resume?: string, priorCostUsd?: number): AgentSession {
		const session = new ClaudeSession(this._binary, cwd, resume, priorCostUsd ?? 0, () => this._sessions.delete(session));
		this._sessions.add(session);
		return session;
	}

	private async _withProbe<T>(use: (control: ControlChannel) => Promise<T>): Promise<T> {
		const process = new JsonLineProcess(this._binary, args, this._cwd());
		const control = new ControlChannel(process);
		try {
			return await use(control);
		} finally {
			control.dispose();
			process.dispose();
		}
	}

	public dispose(): void {
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
	/** Messages sent whose `result` has not arrived; the CLI queues them in order. */
	private _pendingTurns = 0;
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
		resume: string | undefined,
		priorCostUsd: number,
		private readonly _onDispose: () => void,
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
		// A different model or effort needs a new process — but never in the
		// middle of a turn, where the message joins the running one instead.
		if (this._process && !this.running && (this._launched?.model !== model || this._launched?.effort !== effort)) {
			this._stopProcess();
		}
		if (!this._process || this._process.exited) {
			this._start(model, effort);
		}

		const content: unknown[] = input.images.map(image => ({
			type: 'image',
			source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
		}));
		if (input.text) {
			content.push({ type: 'text', text: input.text });
		}
		this._pendingTurns++;
		this._process!.send({
			type: 'user',
			message: { role: 'user', content },
			parent_tool_use_id: null,
			session_id: this._sessionId ?? '',
		});
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

	private _start(model: string, effort: string | undefined): void {
		const launch = [...args, '--model', model];
		if (effort) {
			launch.push('--effort', effort);
		}
		if (this._sessionId) {
			launch.push('--resume', this._sessionId);
		}
		const process = new JsonLineProcess(this._binary, launch, this._cwd);
		this._process = process;
		this._control = new ControlChannel(process);
		this._launched = { model, effort };
		this._processCost = this._sessionId ? this._sessionCost : 0;

		process.onMessage(message => {
			if (process !== this._process) {
				return;
			}
			for (const event of claudeEvents(message)) {
				this._handle(event);
			}
		});
		process.onExit(reason => {
			if (process !== this._process) {
				return;
			}
			this._process = undefined;
			this._control?.dispose();
			this._control = undefined;
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

	private _stopProcess(): void {
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
