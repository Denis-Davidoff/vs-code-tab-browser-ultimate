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

import type { AgentUsage, ChatModel, ToolKind, UsageWindow } from './chatProtocol';

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
}

export interface ToolUpdate {
	readonly output?: string;
	/** `output` continues what is there rather than replacing it — a streamed command. */
	readonly append?: boolean;
	readonly status?: 'done' | 'failed';
	readonly exitCode?: number;
	readonly input?: string;
	readonly added?: number;
	readonly removed?: number;
}

/** What a turn produced, in a form the chat view renders without knowing which agent spoke. */
export type AgentEvent =
	| { readonly type: 'text'; readonly text: string }
	/** A new message begins: the next text is a separate block, not a continuation. */
	| { readonly type: 'textBreak' }
	| { readonly type: 'thinking'; readonly text: string }
	| { readonly type: 'tool'; readonly id: string; readonly tool: ToolStart }
	| { readonly type: 'toolUpdate'; readonly id: string; readonly update: ToolUpdate }
	| { readonly type: 'session'; readonly id: string }
	| { readonly type: 'turnEnd'; readonly error?: string }
	| { readonly type: 'tokens'; readonly input: number; readonly output: number; readonly cached: number; readonly costUsd?: number; readonly cumulative: boolean }
	| { readonly type: 'limits'; readonly windows: readonly UsageWindow[] }
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
export function claudeEvents(message: Record<string, unknown>): AgentEvent[] {
	switch (message.type) {
		case 'system':
			if (message.subtype === 'init' && typeof message.session_id === 'string') {
				return [{ type: 'session', id: message.session_id }];
			}
			return [];

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
			if (message.parent_tool_use_id) {
				return [];
			}
			const content = isRecord(message.message) ? message.message.content : undefined;
			if (!Array.isArray(content)) {
				return [];
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
			return { kind: 'agent', name, detail: str('description'), input: str('prompt') };
		default:
			return { kind: 'other', name, detail: toolDetail(input), input: jsonBody(input) };
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
			const tool = item && typeof item.id === 'string' ? codexTool(item) : undefined;
			return tool ? [{ type: 'tool', id: item!.id as string, tool }] : [];
		}

		case 'item/completed': {
			const item = isRecord(p.item) ? p.item : undefined;
			const update = item ? codexToolResult(item) : undefined;
			return update && typeof item!.id === 'string' ? [{ type: 'toolUpdate', id: item!.id as string, update }] : [];
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
		case 'collabAgentToolCall':
		case 'subAgentActivity':
			return { kind: 'agent', name: 'Sub-agent', detail: typeof item.prompt === 'string' ? oneLine(item.prompt) : undefined };
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
		case 'collabAgentToolCall':
		case 'subAgentActivity':
			return { status };
		default:
			return undefined;
	}
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
