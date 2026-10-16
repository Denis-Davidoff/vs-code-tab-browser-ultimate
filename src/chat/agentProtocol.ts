/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Reading what the Claude Code and Codex CLIs say, for the chat view.
 *
 * Both are driven the way their own VS Code extensions drive them: a child
 * process speaking one JSON object per line. Claude Code is
 * `claude -p --input-format stream-json --output-format stream-json`, with a
 * control channel (`control_request` / `control_response`) for everything that
 * is not a turn. Codex is `codex app-server`, JSON-RPC 2.0. Neither protocol is
 * public, so everything that interprets their output lives here, in one leaf
 * module with no `vscode` and no relative value imports, which `npm test` loads
 * directly. **The tests run on recorded samples**, so they guard these readers
 * against our own edits, not against a CLI release: a field a new CLI renames
 * still passes and shows up as an empty dropdown. Re-measure after updating
 * either CLI, and refresh the samples.
 *
 * Every shape below was read from a live CLI: Claude Code 2.1.301 and
 * codex-cli 0.145.0, on 2026-10-16. Every reader is defensive on purpose: a
 * field that is missing or of the wrong type is skipped, never thrown on,
 * because the next CLI release may well rename it.
 */

import type { AgentInfo, AgentUsage, ApprovalKind, ChatModel, ToolKind, UsageWindow } from './chatProtocol';

/* --------------------------------------------------------------- framing */

/**
 * Splits a byte stream into lines.
 *
 * A chunk from a pipe ends wherever the OS chose, so a line can arrive in two
 * halves and two lines in one chunk. A `\r` before the `\n` is dropped: a CLI
 * built for Windows may write one.
 */
export class LineSplitter {
	private _rest = '';

	push(chunk: string): string[] {
		const text = this._rest + chunk;
		const parts = text.split('\n');
		this._rest = parts.pop() ?? '';
		return parts
			.map(line => line.endsWith('\r') ? line.slice(0, -1) : line)
			.filter(line => line.trim() !== '');
	}
}

/** One line as an object, or `undefined` for anything that is not a JSON object. */
export function parseLine(line: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(line);
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/* ---------------------------------------------------------------- models */

/**
 * Claude Code's models, from the `initialize` control response.
 *
 * Each entry carries `value` (what `--model` takes: an alias such as `opus`, or
 * a full id), `displayName`, `description`, and — only for models that have one
 * — `supportsEffort` with `supportedEffortLevels`. The list is taken as the CLI
 * gives it, `Default (recommended)` included, since it is the same list the
 * CLI's own picker shows.
 */
export function claudeModels(initialize: unknown): ChatModel[] {
	const models = isRecord(initialize) ? initialize.models : undefined;
	if (!Array.isArray(models)) {
		return [];
	}
	const out: ChatModel[] = [];
	for (const m of models) {
		if (!isRecord(m) || typeof m.value !== 'string' || !m.value) {
			continue;
		}
		const efforts = m.supportsEffort === true ? strings(m.supportedEffortLevels) : [];
		out.push({
			id: m.value,
			label: typeof m.displayName === 'string' && m.displayName ? m.displayName : m.value,
			description: typeof m.description === 'string' ? m.description : undefined,
			efforts,
			// Claude Code does not say which level it uses when none is passed.
			defaultEffort: efforts.includes('high') ? 'high' : efforts[Math.floor((efforts.length - 1) / 2)],
			isDefault: m.value === 'default',
		});
	}
	return out;
}

/**
 * Codex's models, from `model/list`.
 *
 * `supportedReasoningEfforts` is a list of `{ reasoningEffort, description }`
 * and `defaultReasoningEffort` names one of them. A `hidden` model is one the
 * Codex picker leaves out, and so does this.
 */
export function codexModels(list: unknown): ChatModel[] {
	const data = isRecord(list) ? list.data : undefined;
	if (!Array.isArray(data)) {
		return [];
	}
	const out: ChatModel[] = [];
	for (const m of data) {
		if (!isRecord(m) || m.hidden === true) {
			continue;
		}
		const id = typeof m.model === 'string' && m.model ? m.model : typeof m.id === 'string' ? m.id : '';
		if (!id) {
			continue;
		}
		const efforts = Array.isArray(m.supportedReasoningEfforts)
			? m.supportedReasoningEfforts
				.map(e => isRecord(e) && typeof e.reasoningEffort === 'string' ? e.reasoningEffort : undefined)
				.filter((e): e is string => !!e)
			: [];
		const defaultEffort = typeof m.defaultReasoningEffort === 'string' && efforts.includes(m.defaultReasoningEffort)
			? m.defaultReasoningEffort
			: undefined;
		out.push({
			id,
			label: typeof m.displayName === 'string' && m.displayName ? m.displayName : id,
			description: typeof m.description === 'string' ? m.description : undefined,
			efforts,
			defaultEffort,
			isDefault: m.isDefault === true,
		});
	}
	return out;
}

/* ----------------------------------------------------------------- usage */

/**
 * A rate-limit window named by its length, the way both CLIs describe theirs.
 *
 * Codex reports a window only as `windowDurationMins`; 300 and 10080 are the
 * two seen in practice.
 */
export function windowLabel(minutes: number): string {
	if (minutes === 300) {
		return '5-hour limit';
	}
	if (minutes === 10080) {
		return 'Weekly limit';
	}
	if (minutes % 1440 === 0) {
		return `${minutes / 1440}-day limit`;
	}
	if (minutes % 60 === 0) {
		return `${minutes / 60}-hour limit`;
	}
	return `${minutes}-minute limit`;
}

/**
 * Claude Code's subscription usage, from the `get_usage` control response.
 *
 * Its own SDK calls this `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`,
 * which is fair warning. Two shapes are read: `rate_limits.limits[]` (one row
 * per limit, `percent` 0–100, `resets_at` ISO) and, failing that, the older
 * `rate_limits.five_hour` / `seven_day` (`utilization` 0–100).
 */
export function claudeUsage(response: unknown): AgentUsage {
	const usage: { plan?: string; windows: UsageWindow[]; notes: string[] } = { windows: [], notes: [] };
	if (!isRecord(response)) {
		return { agent: 'claude', ...usage, error: 'Claude Code returned no usage.' };
	}
	if (typeof response.subscription_type === 'string') {
		usage.plan = response.subscription_type;
	}
	const limits = isRecord(response.rate_limits) ? response.rate_limits : undefined;
	if (response.rate_limits_available === false || !limits) {
		usage.notes.push('Plan limits are not available for this account (an API key has none).');
	} else if (Array.isArray(limits.limits)) {
		for (const row of limits.limits) {
			if (!isRecord(row) || typeof row.percent !== 'number') {
				continue;
			}
			usage.windows.push({
				label: claudeLimitLabel(row),
				usedPercent: row.percent,
				resetsAt: isoTime(row.resets_at),
			});
		}
	} else {
		for (const [key, label] of [['five_hour', '5-hour limit'], ['seven_day', 'Weekly limit']] as const) {
			const w = limits[key];
			if (isRecord(w) && typeof w.utilization === 'number') {
				usage.windows.push({ label, usedPercent: w.utilization, resetsAt: isoTime(w.resets_at) });
			}
		}
	}
	const extra = limits && isRecord(limits.extra_usage) ? limits.extra_usage : undefined;
	if (extra?.is_enabled === true) {
		const spend = limits && isRecord(limits.spend) && isRecord(limits.spend.used) ? limits.spend.used : undefined;
		const amount = spend && typeof spend.amount_minor === 'number' && typeof spend.exponent === 'number'
			? `${(spend.amount_minor / 10 ** spend.exponent).toFixed(spend.exponent)} ${typeof spend.currency === 'string' ? spend.currency : ''}`.trim()
			: undefined;
		usage.notes.push(amount ? `Extra usage is on — ${amount} used this month.` : 'Extra usage is on.');
	}
	return { agent: 'claude', ...usage };
}

function claudeLimitLabel(row: Record<string, unknown>): string {
	const scope = isRecord(row.scope) && isRecord(row.scope.model) && typeof row.scope.model.display_name === 'string'
		? row.scope.model.display_name
		: undefined;
	switch (row.kind) {
		case 'session': return '5-hour limit';
		case 'weekly_all': return 'Weekly limit';
		case 'weekly_scoped': return scope ? `Weekly · ${scope}` : 'Weekly (scoped)';
		default: return typeof row.kind === 'string' ? row.kind.replace(/_/g, ' ') : 'Limit';
	}
}

/**
 * The windows in a Claude Code `rate_limit_event`, sent before every turn.
 *
 * **Its `utilization` is a fraction, not a percentage** — 0.06 means 6%, while
 * `get_usage` reports the same window on a 0–100 scale. Read with the other
 * function's scale and every bar shows 0%.
 */
export function claudeRateLimitWindows(event: unknown): UsageWindow[] | undefined {
	const info = isRecord(event) && isRecord(event.rate_limit_info) ? event.rate_limit_info : undefined;
	const windows = info && isRecord(info.unifiedWindows) ? info.unifiedWindows : undefined;
	if (!windows) {
		return undefined;
	}
	const out: UsageWindow[] = [];
	for (const [key, label] of [['five_hour', '5-hour limit'], ['seven_day', 'Weekly limit']] as const) {
		const w = windows[key];
		if (isRecord(w) && typeof w.utilization === 'number') {
			out.push({
				label,
				usedPercent: Math.round(w.utilization * 1000) / 10,
				resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : undefined,
			});
		}
	}
	return out;
}

/**
 * Codex's plan usage, from `account/rateLimits/read` or the
 * `account/rateLimits/updated` notification — both carry `rateLimits`, and the
 * read adds `rateLimitsByLimitId` when there is more than one limit.
 * `usedPercent` is 0–100 and `resetsAt` is in seconds.
 */
export function codexUsage(response: unknown, plan?: string): AgentUsage {
	const windows: UsageWindow[] = [];
	const notes: string[] = [];
	if (!isRecord(response)) {
		return { agent: 'codex', plan, windows, notes, error: 'Codex returned no usage.' };
	}
	const byId = isRecord(response.rateLimitsByLimitId) ? Object.values(response.rateLimitsByLimitId) : [];
	const limits = byId.length ? byId : [response.rateLimits];
	const named = limits.length > 1;
	for (const limit of limits) {
		if (!isRecord(limit)) {
			continue;
		}
		if (!plan && typeof limit.planType === 'string') {
			plan = limit.planType;
		}
		const prefix = named && typeof limit.limitName === 'string' && limit.limitName ? `${limit.limitName} · ` : '';
		for (const key of ['primary', 'secondary']) {
			const w = limit[key];
			if (isRecord(w) && typeof w.usedPercent === 'number') {
				windows.push({
					label: prefix + (typeof w.windowDurationMins === 'number' ? windowLabel(w.windowDurationMins) : key),
					usedPercent: w.usedPercent,
					resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : undefined,
				});
			}
		}
		const credits = isRecord(limit.credits) ? limit.credits : undefined;
		if (credits?.unlimited === true) {
			notes.push('Credits: unlimited.');
		} else if (credits?.hasCredits === true && typeof credits.balance === 'string') {
			notes.push(`Credits: ${credits.balance} left.`);
		}
		if (limit.rateLimitReachedType) {
			notes.push('A limit has been reached.');
		}
	}
	return { agent: 'codex', plan, windows, notes };
}

/* ---------------------------------------------------------------- events */

/** A tool call as the chat renders it, whichever agent made it. */
export interface ToolStart {
	readonly kind: ToolKind;
	/** The tool's own name: `Bash`, `Read`, `Terminal`, `ai-browser · browser_click`. */
	readonly name: string;
	/** One line beside the name: the file, the pattern, Bash's own description. */
	readonly detail?: string;
	/** The body's IN row: the command, a diff, the arguments. */
	readonly input?: string;
	readonly added?: number;
	readonly removed?: number;
	readonly agent?: Partial<AgentInfo>;
}

export interface ToolUpdate {
	readonly output?: string;
	/** `output` continues what is there rather than replacing it — a streamed command. */
	readonly append?: boolean;
	readonly status?: 'done' | 'failed' | 'stopped';
	readonly exitCode?: number;
	readonly input?: string;
	readonly added?: number;
	readonly removed?: number;
	/** Merged into the row's `agent`. */
	readonly agent?: Partial<Omit<AgentInfo, 'calls'>>;
}

/** What a turn produced, in a form the chat view renders without knowing which agent spoke. */
export type AgentEvent =
	| { readonly type: 'text'; readonly text: string }
	/** A new message begins: the next text is a separate block, not a continuation. */
	| { readonly type: 'textBreak' }
	| { readonly type: 'thinking'; readonly text: string }
	| { readonly type: 'tool'; readonly id: string; readonly tool: ToolStart }
	| { readonly type: 'toolUpdate'; readonly id: string; readonly update: ToolUpdate }
	/** A tool call made by an agent the chat's agent started, under the row `parentId`. */
	| { readonly type: 'agentCall'; readonly parentId: string; readonly name: string; readonly detail?: string }
	/** Codex: the agents' own states, by the thread each runs in. */
	| { readonly type: 'agentStates'; readonly states: readonly { readonly threadId: string; readonly status: 'running' | 'done' | 'failed' | 'stopped'; readonly message?: string }[] }
	/** Claude Code began a turn of its own — an agent it started has finished, and it is answering that. */
	| { readonly type: 'autoTurn' }
	| { readonly type: 'session'; readonly id: string }
	| { readonly type: 'turnEnd'; readonly error?: string }
	| { readonly type: 'tokens'; readonly input: number; readonly output: number; readonly cached: number; readonly costUsd?: number; readonly cumulative: boolean }
	| { readonly type: 'limits'; readonly windows: readonly UsageWindow[] }
	/** The agent asks before using a tool; answered through `AgentSession.answer`. */
	| { readonly type: 'approval'; readonly request: ApprovalRequest }
	/** The CLI withdrew a question it had asked — a Stop, an interrupted turn. */
	| { readonly type: 'approvalDone'; readonly id: string }
	| { readonly type: 'notice'; readonly text: string };

/** Tool output kept per call; a `cat` of a large file is not worth keeping whole. */
export const toolOutputLimit = 20_000;

/**
 * One line of `claude --output-format stream-json`.
 *
 * With `--include-partial-messages`, text and thinking arrive as `stream_event`
 * / `content_block_delta` (`text_delta`, `thinking_delta`), and the complete
 * `assistant` message follows with the same text again — so text is taken from
 * the deltas only, and the `assistant` message only for its `tool_use` blocks.
 * A tool's result comes back in a `user` message as a `tool_result` block with
 * the same id. `result` ends the turn; its `usage` covers that turn alone and
 * `total_cost_usd` the whole process (measured: 0.0018, then 0.0037 for two
 * equal turns), which is why the cost is reported as cumulative and the tokens
 * are not.
 */
export function claudeEvents(message: Record<string, unknown>, tasks?: Map<string, string>): AgentEvent[] {
	switch (message.type) {
		case 'system':
			if (message.subtype === 'init' && typeof message.session_id === 'string') {
				return [{ type: 'session', id: message.session_id }];
			}
			return claudeTaskEvents(message, tasks);

		case 'stream_event': {
			const event = isRecord(message.event) ? message.event : undefined;
			// A sub-agent's stream carries its parent's tool id; its text is not the reply.
			if (!event || message.parent_tool_use_id) {
				return [];
			}
			if (event.type === 'content_block_start' && isRecord(event.content_block) && event.content_block.type === 'text') {
				return [{ type: 'textBreak' }];
			}
			const delta = isRecord(event.delta) ? event.delta : undefined;
			if (event.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
				return [{ type: 'text', text: delta.text }];
			}
			if (event.type === 'content_block_delta' && delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
				return [{ type: 'thinking', text: delta.thinking }];
			}
			return [];
		}

		case 'assistant': {
			const content = isRecord(message.message) ? message.message.content : undefined;
			if (!Array.isArray(content)) {
				return [];
			}
			// An agent's own calls carry its parent's tool id: they belong on that
			// agent's row, not in the conversation.
			if (typeof message.parent_tool_use_id === 'string') {
				const parentId = message.parent_tool_use_id;
				return content
					.filter(isRecord)
					.filter(block => block.type === 'tool_use' && typeof block.name === 'string')
					.map(block => ({ type: 'agentCall' as const, parentId, name: block.name as string, detail: toolDetail(block.input) }));
			}
			return content
				.filter(isRecord)
				.filter(block => block.type === 'tool_use' && typeof block.name === 'string' && typeof block.id === 'string')
				.map(block => ({ type: 'tool' as const, id: block.id as string, tool: claudeTool(block.name as string, block.input) }));
		}

		case 'user': {
			if (message.parent_tool_use_id) {
				return [];
			}
			const content = isRecord(message.message) ? message.message.content : undefined;
			if (!Array.isArray(content)) {
				return [];
			}
			return content
				.filter(isRecord)
				.filter(block => block.type === 'tool_result' && typeof block.tool_use_id === 'string')
				.map(block => {
					// A background agent's call answers at once with "Async agent
					// launched": the agent is only starting, so the row stays running
					// and its end comes from `task_notification`.
					const launched = isRecord(message.tool_use_result) && message.tool_use_result.status === 'async_launched';
					if (launched) {
						const r = message.tool_use_result as Record<string, unknown>;
						return {
							type: 'toolUpdate' as const,
							id: block.tool_use_id as string,
							update: { agent: { background: true, model: typeof r.resolvedModel === 'string' ? r.resolvedModel : undefined } },
						};
					}
					const failed = block.is_error === true;
					const text = resultText(block.content);
					// A failed Bash result starts with Claude Code's own "Exit code N"
					// line; it is the footer's, not the output's.
					const exit = failed ? /^Exit code (\d+)\r?\n/.exec(text) : undefined;
					return {
						type: 'toolUpdate' as const,
						id: block.tool_use_id as string,
						update: exit
							? { output: clip(text.slice(exit[0].length)), status: 'failed' as const, exitCode: Number(exit[1]) }
							: { output: clip(text), status: failed ? 'failed' as const : 'done' as const },
					};
				});
		}

		case 'rate_limit_event': {
			const windows = claudeRateLimitWindows(message);
			return windows?.length ? [{ type: 'limits', windows }] : [];
		}

		case 'result': {
			const events: AgentEvent[] = [];
			const usage = isRecord(message.usage) ? message.usage : undefined;
			if (usage) {
				const read = num(usage.cache_read_input_tokens);
				events.push({
					type: 'tokens',
					input: num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + read,
					output: num(usage.output_tokens),
					cached: read,
					costUsd: typeof message.total_cost_usd === 'number' ? message.total_cost_usd : undefined,
					cumulative: false,
				});
			}
			const failed = message.is_error === true || (typeof message.subtype === 'string' && message.subtype !== 'success');
			events.push({ type: 'turnEnd', error: failed ? resultError(message) : undefined });
			return events;
		}

		default:
			return [];
	}
}

/**
 * How a Claude Code tool call reads on its row. Bash shows its own
 * `description` beside the name and the command in the body, as Claude Code's
 * panel does; Edit and Write show a diff.
 */
export function claudeTool(name: string, input: unknown): ToolStart {
	const i = isRecord(input) ? input : {};
	const str = (key: string) => typeof i[key] === 'string' ? i[key] as string : undefined;
	if (name.startsWith('mcp__')) {
		const [, server, ...tool] = name.split('__');
		return { kind: 'mcp', name: `${server} · ${tool.join('__')}`, input: jsonBody(input) };
	}
	switch (name) {
		case 'Bash':
			return { kind: 'command', name, detail: str('description'), input: str('command') };
		case 'Read':
			return { kind: 'read', name, detail: str('file_path') };
		case 'Write': {
			const lines = (str('content') ?? '').split('\n');
			return { kind: 'edit', name, detail: str('file_path'), input: lines.map(l => `+${l}`).join('\n'), added: lines.length, removed: 0 };
		}
		case 'Edit': {
			const removed = (str('old_string') ?? '').split('\n');
			const added = (str('new_string') ?? '').split('\n');
			return {
				kind: 'edit', name, detail: str('file_path'),
				input: [...removed.map(l => `-${l}`), ...added.map(l => `+${l}`)].join('\n'),
				added: added.length, removed: removed.length,
			};
		}
		case 'MultiEdit':
		case 'NotebookEdit':
			return { kind: 'edit', name, detail: str('file_path') ?? str('notebook_path') };
		case 'Grep':
		case 'Glob':
			return { kind: 'search', name, detail: [str('pattern') && `"${str('pattern')}"`, str('path')].filter(Boolean).join(' in ') };
		case 'WebFetch':
			return { kind: 'web', name, detail: str('url') };
		case 'WebSearch':
			return { kind: 'web', name, detail: str('query') };
		case 'Task':
		case 'Agent':
			return {
				kind: 'agent', name, detail: str('description'), input: str('prompt'),
				agent: { type: str('subagent_type'), background: i.run_in_background === true ? true : undefined },
			};
		default:
			return { kind: 'other', name, detail: toolDetail(input), input: jsonBody(input) };
	}
}

/**
 * Claude Code's reports on the agents its agent starts, measured on 2.1.301:
 * `task_started` (the call's `tool_use_id`, `subagent_type`, `is_backgrounded`,
 * the prompt), `task_progress` (`usage.total_tokens`, `tool_uses`,
 * `duration_ms`, `last_tool_name`) and `task_notification` (the final
 * `status`, a `summary`, the same usage). `task_updated` names only the task
 * id, with what changed in `patch`; a foreground agent moved to the background
 * arrives there as `patch.is_backgrounded` (the CLI's own schema says so), and
 * `tasks` — task id to the call's id, kept from `task_started` by the caller —
 * is how it finds the row. Tasks are not only agents: a background shell and
 * a Bash call running past two seconds are tasks too (`task_type`
 * `local_bash`), so `task_started` reads only the agent types, and the chat
 * applies agent fields to agent rows only. A background agent outlives the turn that started it:
 * its turn's `result` arrives first, and when the agent finishes the CLI
 * begins a turn of its own — `status: requesting` with nothing sent — to
 * answer it.
 */
/** The task types that are agents; anything else (`local_bash`, …) is not shown as one. */
const agentTaskTypes = new Set(['local_agent', 'remote_agent']);

function claudeTaskEvents(message: Record<string, unknown>, tasks?: Map<string, string>): AgentEvent[] {
	const id = typeof message.tool_use_id === 'string' ? message.tool_use_id : undefined;
	const taskId = typeof message.task_id === 'string' ? message.task_id : undefined;
	const usage = isRecord(message.usage) ? message.usage : undefined;
	const counts = usage ? {
		tokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
		toolUses: typeof usage.tool_uses === 'number' ? usage.tool_uses : undefined,
		durationMs: typeof usage.duration_ms === 'number' ? usage.duration_ms : undefined,
	} : {};
	switch (message.subtype) {
		case 'status':
			return message.status === 'requesting' ? [{ type: 'autoTurn' }] : [];
		case 'task_started':
			if (typeof message.task_type === 'string' && !agentTaskTypes.has(message.task_type)) {
				return [];
			}
			if (id && taskId) {
				tasks?.set(taskId, id);
			}
			return id ? [{ type: 'toolUpdate', id, update: { agent: {
				type: typeof message.subagent_type === 'string' ? message.subagent_type : undefined,
				background: message.is_backgrounded === true ? true : undefined,
			} } }] : [];
		case 'task_updated': {
			const row = taskId ? tasks?.get(taskId) : undefined;
			return row && isRecord(message.patch) && message.patch.is_backgrounded === true
				? [{ type: 'toolUpdate', id: row, update: { agent: { background: true } } }]
				: [];
		}
		case 'task_progress':
			return id ? [{ type: 'toolUpdate', id, update: { agent: {
				...counts, lastTool: typeof message.last_tool_name === 'string' ? message.last_tool_name : undefined,
			} } }] : [];
		case 'task_notification': {
			if (!id) {
				return [];
			}
			const status = taskStatus(message.status);
			// A stopped task's `summary` is only its description (measured: "Run
			// timed step loop" for an agent stopped mid-loop), not a report.
			const summary = status !== 'stopped' && typeof message.summary === 'string' ? clip(message.summary) : undefined;
			return [{ type: 'toolUpdate', id, update: { status, output: summary, agent: { ...counts, summary } } }];
		}
		default:
			return [];
	}
}

/** A task's or a Codex agent's end state, in the row's terms. */
function taskStatus(status: unknown): 'done' | 'failed' | 'stopped' {
	switch (status) {
		case 'completed':
			return 'done';
		case 'killed':
		case 'stopped':
		case 'cancelled':
		case 'interrupted':
		case 'shutdown':
			return 'stopped';
		default:
			return 'failed';
	}
}

function resultText(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map(part => isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : isRecord(part) && part.type === 'image' ? '[image]' : '')
			.filter(Boolean)
			.join('\n');
	}
	return '';
}

function resultError(message: Record<string, unknown>): string {
	if (typeof message.result === 'string' && message.result) {
		return message.result;
	}
	if (Array.isArray(message.errors) && message.errors.length) {
		return message.errors.map(String).join('\n');
	}
	return typeof message.subtype === 'string' ? message.subtype.replace(/_/g, ' ') : 'The turn failed.';
}

/**
 * One Codex app-server notification.
 *
 * Text arrives as `item/agentMessage/delta`, and **each `agentMessage` item is
 * its own block** — Codex sends a short commentary ("I'll run both commands…")
 * and the final answer as two items, and run together they read as one
 * sentence. A tool is an `item/started` with one of the item types, updated by
 * `item/commandExecution/outputDelta` and finished by `item/completed`.
 * Reasoning arrives as `item/reasoning/summaryTextDelta`, but only when the
 * turn asks for summaries (`summary: 'auto'` on `turn/start`). `turn/completed`
 * carries the turn's `status`; `thread/tokenUsage/updated.total` is the whole
 * thread so far, hence `cumulative`.
 */
export function codexEvents(method: string, params: unknown): AgentEvent[] {
	const p = isRecord(params) ? params : {};
	switch (method) {
		case 'item/agentMessage/delta':
			return typeof p.delta === 'string' ? [{ type: 'text', text: p.delta }] : [];

		case 'item/reasoning/summaryTextDelta':
			return typeof p.delta === 'string' ? [{ type: 'thinking', text: p.delta }] : [];

		case 'item/reasoning/summaryPartAdded':
			return typeof p.summaryIndex === 'number' && p.summaryIndex > 0 ? [{ type: 'thinking', text: '\n\n' }] : [];

		case 'item/commandExecution/outputDelta':
			return typeof p.itemId === 'string' && typeof p.delta === 'string'
				? [{ type: 'toolUpdate', id: p.itemId, update: { output: p.delta, append: true } }]
				: [];

		case 'item/started': {
			const item = isRecord(p.item) ? p.item : undefined;
			if (item?.type === 'agentMessage') {
				return [{ type: 'textBreak' }];
			}
			if (item?.type === 'subAgentActivity') {
				return codexSubAgentEvents(item);
			}
			const tool = item && typeof item.id === 'string' ? codexTool(item) : undefined;
			return tool ? [{ type: 'tool', id: item!.id as string, tool }] : [];
		}

		case 'item/completed': {
			const item = isRecord(p.item) ? p.item : undefined;
			const update = item ? codexToolResult(item) : undefined;
			const events: AgentEvent[] = update && typeof item!.id === 'string' ? [{ type: 'toolUpdate', id: item!.id as string, update }] : [];
			const states = item?.type === 'collabAgentToolCall' ? codexAgentStates(item.agentsStates) : [];
			return states.length ? [...events, { type: 'agentStates', states }] : events;
		}

		case 'turn/completed': {
			const turn = isRecord(p.turn) ? p.turn : {};
			if (turn.status === 'failed') {
				const error = isRecord(turn.error) && typeof turn.error.message === 'string' ? turn.error.message : 'The turn failed.';
				return [{ type: 'turnEnd', error }];
			}
			return [{ type: 'turnEnd', error: turn.status === 'interrupted' ? 'Stopped.' : undefined }];
		}

		case 'thread/tokenUsage/updated': {
			const total = isRecord(p.tokenUsage) && isRecord(p.tokenUsage.total) ? p.tokenUsage.total : undefined;
			return total
				? [{ type: 'tokens', input: num(total.inputTokens), output: num(total.outputTokens), cached: num(total.cachedInputTokens), cumulative: true }]
				: [];
		}

		case 'error': {
			// `willRetry` means Codex is already trying again; the turn goes on.
			const error = isRecord(p.error) && typeof p.error.message === 'string' ? p.error.message : undefined;
			return error && p.willRetry !== true ? [{ type: 'notice', text: error }] : [];
		}

		default:
			return [];
	}
}

/**
 * An agent Codex started, as Codex reports it — measured on codex-cli
 * 0.162.0-alpha.17.2, where no `collabAgentToolCall` `spawnAgent` item is sent
 * at all: a `subAgentActivity` item on the parent's thread with `kind`
 * `started` / `interacted` / `interrupted` / `completed`, the agent's own
 * thread id and its `agentPath` (`/root/read_a`, a name the model chose). It
 * carries no prompt. The row is keyed by the agent's thread id, which is how
 * the agent's own events (`codexAgentThreadEvents`) find it, and each report
 * arrives as both `item/started` and `item/completed`, so only the first is
 * read.
 */
export function codexSubAgentEvents(item: Record<string, unknown>): AgentEvent[] {
	const id = typeof item.agentThreadId === 'string' ? item.agentThreadId : undefined;
	if (!id) {
		return [];
	}
	switch (item.kind) {
		case 'started': {
			const path = typeof item.agentPath === 'string' ? item.agentPath : undefined;
			const name = path?.split('/').filter(Boolean).pop()?.replace(/[_-]+/g, ' ').trim();
			return [{ type: 'tool', id, tool: { kind: 'agent', name: 'Agent', detail: name ? oneLine(name) : undefined, agent: { type: path, threadId: id } } }];
		}
		case 'completed':
			return [{ type: 'toolUpdate', id, update: { status: 'done' } }];
		case 'interrupted':
			return [{ type: 'toolUpdate', id, update: { status: 'stopped' } }];
		default:
			return [];
	}
}

/**
 * What an agent Codex started does, read from its own thread: every
 * notification of that thread arrives on the same app-server, under the
 * agent's thread id. Its tool items become the card's tool calls, its total
 * tokens the card's, its last message the report, and an agent it starts in
 * turn a row of its own. None of it is the reply.
 */
export function codexAgentThreadEvents(threadId: string, method: string, params: unknown): AgentEvent[] {
	const p = isRecord(params) ? params : {};
	const item = isRecord(p.item) ? p.item : undefined;
	switch (method) {
		case 'item/started': {
			if (item?.type === 'subAgentActivity') {
				return codexSubAgentEvents(item);
			}
			const tool = item ? codexTool(item) : undefined;
			const detail = tool?.kind === 'command' ? tool.input || tool.detail : tool?.detail;
			return tool ? [{ type: 'agentCall', parentId: threadId, name: tool.name, detail: detail ? oneLine(detail) : undefined }] : [];
		}
		case 'item/completed':
			return item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()
				? [{ type: 'toolUpdate', id: threadId, update: { agent: { summary: clip(item.text) } } }]
				: [];
		case 'turn/completed':
			// An agent stopped on its own (`stopAgent`) ends here; the parent's
			// `subAgentActivity` may say `interrupted` as well, and either ends the row.
			return isRecord(p.turn) && p.turn.status === 'interrupted' ? [{ type: 'toolUpdate', id: threadId, update: { status: 'stopped' } }] : [];
		case 'thread/tokenUsage/updated': {
			const total = isRecord(p.tokenUsage) && isRecord(p.tokenUsage.total) ? p.tokenUsage.total : undefined;
			return total && typeof total.totalTokens === 'number'
				? [{ type: 'toolUpdate', id: threadId, update: { agent: { tokens: total.totalTokens } } }]
				: [];
		}
		default:
			return [];
	}
}

/**
 * The command a Codex `commandExecution` ran, without the shell around it.
 * Codex reports `/bin/zsh -lc 'echo hi && cat a.txt'`; the part worth reading is
 * what is inside the quotes.
 */
export function unwrapShell(command: string): string {
	const match = /^(?:\S*\/)?(?:ba|z|fi)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim());
	if (!match) {
		return command;
	}
	return match[1] === "'" ? match[2].replace(/'\\''/g, "'") : match[2].replace(/\\(["\\$`])/g, '$1');
}

function codexTool(item: Record<string, unknown>): ToolStart | undefined {
	switch (item.type) {
		case 'commandExecution': {
			const command = unwrapShell(typeof item.command === 'string' ? item.command : '');
			return { kind: 'command', name: 'Terminal', detail: commandSummary(item.commandActions), input: command };
		}
		case 'fileChange': {
			const changes = Array.isArray(item.changes) ? item.changes.filter(isRecord) : [];
			const files = changes.map(c => typeof c.path === 'string' ? c.path : '').filter(Boolean);
			return { kind: 'edit', name: 'Edit', detail: files.length === 1 ? files[0] : files.length ? `${files.length} files` : undefined, ...diffOf(changes) };
		}
		case 'mcpToolCall':
			return { kind: 'mcp', name: [item.server, item.tool].filter(v => typeof v === 'string').join(' · ') || 'MCP tool', input: jsonBody(item.arguments) };
		case 'dynamicToolCall':
			return { kind: 'mcp', name: typeof item.tool === 'string' ? item.tool : 'Tool', input: jsonBody(item.arguments) };
		case 'webSearch':
			return { kind: 'web', name: 'Web search', detail: typeof item.query === 'string' ? oneLine(item.query) : undefined };
		case 'imageView':
			return { kind: 'read', name: 'View image', detail: typeof item.path === 'string' ? item.path : undefined };
		case 'collabAgentToolCall': {
			// Only a spawn is an agent; `wait`, `sendInput`, `resumeAgent` and
			// `closeAgent` talk to one, and their news is in `agentsStates`.
			if (item.tool !== 'spawnAgent') {
				return undefined;
			}
			const prompt = typeof item.prompt === 'string' ? item.prompt : undefined;
			const threads = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter((t): t is string => typeof t === 'string') : [];
			return {
				kind: 'agent', name: 'Agent', detail: prompt ? oneLine(prompt.split('\n')[0]) : undefined, input: prompt,
				// Not `background`: Codex's parent normally `wait`s for its agents
				// inside the turn, and nothing measured says a state arrives after
				// it — so the turn's end settles the row like any other tool's.
				agent: { type: 'spawnAgent', model: typeof item.model === 'string' ? item.model : undefined, threadId: threads[0] },
			};
		}
		default:
			return undefined;
	}
}

function codexToolResult(item: Record<string, unknown>): ToolUpdate | undefined {
	const status = item.status === 'failed' || item.status === 'declined' ? 'failed' as const : 'done' as const;
	switch (item.type) {
		case 'commandExecution':
			return {
				output: clip(typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ''),
				status,
				exitCode: typeof item.exitCode === 'number' ? item.exitCode : undefined,
			};
		case 'fileChange': {
			const changes = Array.isArray(item.changes) ? item.changes.filter(isRecord) : [];
			return { status, ...diffOf(changes) };
		}
		case 'mcpToolCall':
		case 'dynamicToolCall': {
			const error = isRecord(item.error) && typeof item.error.message === 'string' ? item.error.message : undefined;
			const content = isRecord(item.result) ? item.result.content : item.contentItems;
			return { output: clip(error ?? resultText(content)), status: error || item.success === false ? 'failed' : status };
		}
		case 'webSearch':
		case 'imageView':
			return { status };
		case 'collabAgentToolCall': {
			if (item.tool !== 'spawnAgent') {
				return undefined;
			}
			// A completed spawn is an agent that has started, not one that has
			// finished: only a failed spawn ends the row here.
			const threads = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter((t): t is string => typeof t === 'string') : [];
			return item.status === 'failed' ? { status: 'failed' } : { agent: { threadId: threads[0] } };
		}
		default:
			return undefined;
	}
}

/**
 * Codex's `agentsStates`: thread id → `{ status, message }`, where status is
 * `pendingInit`, `running`, `interrupted`, `completed`, `errored`, `shutdown`
 * or `notFound`. Read from the app-server schema; not measured live.
 */
function codexAgentStates(value: unknown): { threadId: string; status: 'running' | 'done' | 'failed' | 'stopped'; message?: string }[] {
	if (!isRecord(value)) {
		return [];
	}
	return Object.entries(value).filter(([, v]) => isRecord(v)).map(([threadId, v]) => {
		const state = v as Record<string, unknown>;
		const status = state.status === 'running' || state.status === 'pendingInit' ? 'running' as const : taskStatus(state.status);
		return { threadId, status, message: typeof state.message === 'string' ? clip(state.message) : undefined };
	});
}

/** "Read a.txt, listed files" — from the actions Codex parsed out of a command. */
function commandSummary(actions: unknown): string | undefined {
	if (!Array.isArray(actions) || !actions.length) {
		return undefined;
	}
	const parts = actions.filter(isRecord).map(a => {
		switch (a.type) {
			case 'read': return typeof a.name === 'string' ? `Read ${a.name}` : 'Read a file';
			case 'listFiles': return 'Listed files';
			case 'search': return typeof a.query === 'string' ? `Searched for "${a.query}"` : 'Searched';
			default: return undefined;
		}
	});
	// One action Codex could not classify means the summary would mislead.
	return parts.every(Boolean) ? parts.join(', ') : undefined;
}

function diffOf(changes: Record<string, unknown>[]): { input?: string; added?: number; removed?: number } {
	const diffs = changes.map(c => typeof c.diff === 'string' ? c.diff : '').filter(Boolean);
	if (!diffs.length) {
		return {};
	}
	let added = 0;
	let removed = 0;
	for (const line of diffs.join('\n').split('\n')) {
		if (line.startsWith('+') && !line.startsWith('+++')) {
			added++;
		} else if (line.startsWith('-') && !line.startsWith('---')) {
			removed++;
		}
	}
	return { input: clip(diffs.join('\n')), added, removed };
}

function jsonBody(value: unknown): string | undefined {
	if (value === undefined || value === null || (isRecord(value) && !Object.keys(value).length)) {
		return undefined;
	}
	try {
		return clip(JSON.stringify(value, null, 2));
	} catch {
		return undefined;
	}
}

function clip(text: string): string {
	return text.length > toolOutputLimit ? `${text.slice(0, toolOutputLimit)}\n…` : text;
}

/**
 * The one argument of a Claude Code tool call worth showing on its row: the
 * command for Bash, the path for Read and Edit, the pattern for Grep, and so on.
 */
export function toolDetail(input: unknown): string | undefined {
	if (!isRecord(input)) {
		return undefined;
	}
	for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']) {
		const value = input[key];
		if (typeof value === 'string' && value.trim()) {
			return oneLine(value);
		}
	}
	return undefined;
}

/* -------------------------------------------------------------- versions */

/**
 * The version a CLI prints for `--version`: `2.1.301 (Claude Code)`,
 * `codex-cli 0.162.0-alpha.17.2`. The first dotted number is taken, with any
 * pre-release tag after it.
 */
export function parseCliVersion(output: string): string | undefined {
	return /\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?/.exec(output)?.[0];
}

/**
 * Orders two CLI versions, newest first when used with `sort`: a positive
 * result means `b` is newer.
 *
 * **Newer wins even when it is a pre-release.** The copy inside the Codex
 * extension is an alpha (`0.162.0-alpha.17.2`) and it is the one the server
 * gives the current models to: the `codex` 0.145.0 on `PATH` was offered only
 * the 5.6 generation, every one described as "Older". So the numbers decide,
 * and a pre-release only loses to the same release without a tag.
 */
export function compareCliVersions(a: string | undefined, b: string | undefined): number {
	if (!a || !b) {
		return a ? -1 : b ? 1 : 0;
	}
	const [coreA, preA] = splitVersion(a);
	const [coreB, preB] = splitVersion(b);
	for (let i = 0; i < Math.max(coreA.length, coreB.length); i++) {
		const diff = (coreB[i] ?? 0) - (coreA[i] ?? 0);
		if (diff) {
			return diff;
		}
	}
	if (preA !== preB) {
		return preA === undefined ? -1 : preB === undefined ? 1 : 0;
	}
	return 0;
}

function splitVersion(version: string): [number[], string | undefined] {
	const dash = version.indexOf('-');
	const core = (dash < 0 ? version : version.slice(0, dash)).split('.').map(n => parseInt(n, 10) || 0);
	return [core, dash < 0 ? undefined : version.slice(dash + 1)];
}

/* ---------------------------------------------------------------- titles */

/** A chat's title: the first line of its first message, cut to fit a list row. */
export function chatTitle(text: string, limit = 60): string {
	const line = text.split('\n').map(l => l.trim()).find(l => l) ?? '';
	if (!line) {
		return 'New chat';
	}
	return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

/* --------------------------------------------------------------- approvals */

/**
 * A question an agent asks before it uses a tool, as the chat shows it. `id` is
 * the CLI's own request id, which is what the answer is sent back under.
 */
export interface ApprovalRequest {
	readonly id: string;
	readonly what: ApprovalKind;
	readonly title: string;
	readonly detail?: string;
}

/**
 * The MCP server this extension runs, as the chat hands it to both CLIs: the
 * same name as `mcpServerName` in `mcpClientState.ts`, written twice since a
 * leaf module may not import another. Also the per-project name Connect Codex
 * once wrote into the global config, `ai-browser-<slug>-<6 hex>` — and only that
 * shape: any `ai-browser-…` would let somebody else's server, named so, be
 * answered by the Auto toggle as if it were the browser.
 */
function isBrowserServer(name: string): boolean {
	return name === 'ai-browser' || /^ai-browser-.+-[0-9a-f]{6}$/.test(name);
}

/**
 * What a question shows must be what the answer allows, so a command and a
 * tool's arguments are shown whole, line breaks included — the card scrolls.
 * Folding lines into one read `echo done` + `rm -rf build` as one harmless
 * `echo`, and a cut hid the tail that would run. Bounded only far past
 * anything a person reads, with the cut said in words.
 */
const approvalTextLimit = 100_000;

function whole(value: string): string {
	const text = value.replace(/\s+$/, '');
	return text.length > approvalTextLimit
		? `${text.slice(0, approvalTextLimit)}\n… ${text.length - approvalTextLimit} more characters not shown — deny it if you cannot see what it does.`
		: text;
}

/** A tool's arguments, one per line: `selector: #email`, `value: Hello`. */
function argumentLines(input: unknown): string | undefined {
	if (!isRecord(input)) {
		return undefined;
	}
	const parts = Object.entries(input).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
	return parts.length ? whole(parts.join('\n')) : undefined;
}

const claudeEditTools = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Claude Code's `can_use_tool` control request, sent when it runs with
 * `--permission-prompt-tool stdio` and a tool needs the user's yes. Measured on
 * 2.1.301: `{ subtype: 'can_use_tool', tool_name, display_name, input,
 * description, permission_suggestions, blocked_path, tool_use_id }`; an MCP
 * tool is named `mcp__<server>__<tool>`.
 */
export function claudeApproval(id: string, request: Record<string, unknown>): ApprovalRequest {
	const tool = typeof request.tool_name === 'string' ? request.tool_name : '';
	const input = isRecord(request.input) ? request.input : {};
	const description = typeof request.description === 'string' ? oneLine(request.description, 300) : undefined;
	const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
	if (tool === 'Bash') {
		const command = typeof input.command === 'string' ? input.command : '';
		return { id, what: 'command', title: whole(command) || 'Bash', detail: description };
	}
	if (mcp) {
		const [, server, name] = mcp;
		const args = argumentLines(input);
		return isBrowserServer(server)
			? { id, what: 'browser', title: name, detail: args }
			: { id, what: 'other', title: name, detail: [server, args].filter(Boolean).join('\n') };
	}
	if (claudeEditTools.has(tool)) {
		const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : '';
		return { id, what: 'edit', title: file || tool, detail: tool };
	}
	const name = typeof request.display_name === 'string' && request.display_name ? request.display_name : tool || 'Tool';
	return { id, what: 'other', title: name, detail: description ?? argumentLines(input) };
}

/** What `can_use_tool` is answered with: the input as it was, or a refusal the model reads. */
export function claudeApprovalAnswer(input: unknown, allow: boolean): Record<string, unknown> {
	return allow
		? { behavior: 'allow', updatedInput: isRecord(input) ? input : {} }
		: { behavior: 'deny', message: 'The user declined this in the AI Browser chat.' };
}

/**
 * The approvals Codex's app-server asks for (codex-cli 0.162, measured with
 * `approvalPolicy: 'untrusted'` and `approvalsReviewer: 'user'`): a command
 * (`item/commandExecution/requestApproval`), a patch
 * (`item/fileChange/requestApproval`), and an MCP tool, which comes as an
 * `mcpServer/elicitation/request` whose `_meta.codex_approval_kind` is
 * `mcp_tool_call` — "Allow the ai-browser MCP server to run tool …?". The two
 * legacy methods take the same questions in the older shape. Anything else is
 * not an approval and answers `undefined`.
 */
export function codexApproval(id: string, method: string, params: Record<string, unknown>, files: readonly string[] = []): ApprovalRequest | undefined {
	const reason = typeof params.reason === 'string' && params.reason ? oneLine(params.reason, 300) : undefined;
	switch (method) {
		case 'item/commandExecution/requestApproval':
		case 'execCommandApproval': {
			const raw = Array.isArray(params.command) ? strings(params.command).join(' ') : typeof params.command === 'string' ? params.command : '';
			const network = isRecord(params.networkApprovalContext) ? params.networkApprovalContext : undefined;
			// Typing into a running command, or opening the network for it, is not
			// "a terminal command" the Auto toggle was asked to cover: it asks.
			if (params.kind === 'writeStdin' || network) {
				const host = network && typeof network.host === 'string' ? network.host : undefined;
				return {
					id, what: 'other',
					title: network ? `Network access${host ? `: ${host}` : ''}` : 'Input to a running command',
					detail: [raw && whole(unwrapShell(raw)), reason].filter(Boolean).join('\n') || undefined,
				};
			}
			return { id, what: 'command', title: whole(unwrapShell(raw)) || 'Command', detail: reason };
		}
		case 'item/fileChange/requestApproval':
		case 'applyPatchApproval': {
			// The v2 request names only its item; the paths are on the
			// `fileChange` item that started just before, which the caller keeps.
			const named = isRecord(params.fileChanges) ? Object.keys(params.fileChanges) : files;
			const root = typeof params.grantRoot === 'string' && params.grantRoot ? `Write access to everything under ${params.grantRoot} for this conversation` : undefined;
			return { id, what: 'edit', title: named.length ? named.join('\n') : 'Apply the edit', detail: [root, reason].filter(Boolean).join('\n') || undefined };
		}
		case 'mcpServer/elicitation/request': {
			const meta = isRecord(params._meta) ? params._meta : {};
			if (meta.codex_approval_kind !== 'mcp_tool_call') {
				return undefined;
			}
			const server = typeof params.serverName === 'string' ? params.serverName : '';
			const message = typeof params.message === 'string' ? params.message : '';
			const name = /tool "([^"]+)"/.exec(message)?.[1] ?? (typeof meta.tool_title === 'string' ? meta.tool_title : 'Tool');
			const args = argumentLines(meta.tool_params);
			return isBrowserServer(server)
				? { id, what: 'browser', title: name, detail: args }
				: { id, what: 'other', title: name, detail: [server, args].filter(Boolean).join('\n') };
		}
		default:
			return undefined;
	}
}

/**
 * The result a Codex approval is answered with. A command's refusal is
 * `decline` — the turn goes on and the model is told — unless the request lists
 * its decisions without it, when only `cancel` (which ends the turn) refuses.
 */
export function codexApprovalAnswer(method: string, params: Record<string, unknown>, allow: boolean): Record<string, unknown> {
	switch (method) {
		case 'item/commandExecution/requestApproval': {
			if (allow) {
				return { decision: 'accept' };
			}
			const offered = Array.isArray(params.availableDecisions) ? params.availableDecisions : undefined;
			return { decision: !offered || offered.includes('decline') ? 'decline' : 'cancel' };
		}
		case 'item/fileChange/requestApproval':
			return { decision: allow ? 'accept' : 'decline' };
		case 'mcpServer/elicitation/request':
			return { action: allow ? 'accept' : 'decline', content: null };
		default:
			return { decision: allow ? 'approved' : 'denied' };
	}
}

/* --------------------------------------------------------------- helpers */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v !== '') : [];
}

function num(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isoTime(value: unknown): number | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const t = Date.parse(value);
	return Number.isNaN(t) ? undefined : t;
}

function oneLine(value: string, limit = 120): string {
	const line = value.replace(/\s+/g, ' ').trim();
	return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}
