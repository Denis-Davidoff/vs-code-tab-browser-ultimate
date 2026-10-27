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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentInfo, AgentQuestion, AgentUsage, ApprovalKind, ChatCommand, ChatModel, CommandGroup, QuestionAnswers, ToolKind, UsageWindow } from './chatProtocol';

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

/* ---------------------------------------------------------------- skills and commands */

/**
 * Claude Code's built-in commands that the chat leaves out of the palette:
 * each one changes something the chat shows or owns, behind its back —
 * `/model` and `/effort` would leave the pills naming a model the next message
 * does not use, `/clear` empties the CLI's context while the thread stays on
 * screen (the palette's own Clear conversation does both), `/rename` names a
 * session the chat names itself — or is a CLI terminal feature with no meaning
 * here. They still work when typed; they are only not offered.
 */
/** Longest command name kept, and longest description or hint, in characters. */
const maxCommandName = 200;
const maxCommandText = 500;

/** A command's text cut to `maxCommandText` code points, so a surrogate pair is never split. */
function cut(text: string): string {
	const points = Array.from(text);
	return points.length > maxCommandText ? `${points.slice(0, maxCommandText).join('')}…` : text;
}

const hiddenClaudeCommands = new Set(['clear', 'model', 'effort', 'fast', 'rename', 'color', 'focus', 'heapdump', 'resume', 'exit', 'quit', 'login', 'logout', 'output-style']);

/**
 * Claude Code's skills and commands, from the `initialize` control response.
 *
 * Each entry is `{ name, description, argumentHint, builtin? }`. Where a
 * non-built-in command comes from is only said at the end of its description,
 * in parentheses — measured on 2.1.301: `(user)` for `~/.claude/skills` and
 * `~/.claude/commands`, `(project)` for the project's `.claude/`, `(claude.ai
 * sync)` for skills synced from claude.ai; any other tag, or a `plugin:` name,
 * is read as a plugin; no tag at all as the user's own. The tag is taken off
 * the description it labels. A built-in's parentheses are part of its sentence
 * (`(resumable with /resume)`) and stay. Names starting with `__` and commands
 * "… sessions only" are internal.
 *
 * **A description is the project's own text, passed through uncut**, so it is
 * read with nothing that backtracks: the tag is matched against the last 200
 * characters with an anchored pattern (an unanchored `\s*` before it took 7 s
 * on 100 000 spaces, on the extension host), and what is kept is cut to
 * `maxCommandText`. It is posted to the view with every state.
 */
export function claudeCommands(initialize: unknown): ChatCommand[] {
	const commands = isRecord(initialize) ? initialize.commands : undefined;
	if (!Array.isArray(commands)) {
		return [];
	}
	const out: ChatCommand[] = [];
	const seen = new Set<string>();
	for (const c of commands) {
		if (!isRecord(c) || typeof c.name !== 'string' || !c.name || c.name.startsWith('__') || seen.has(c.name)) {
			continue;
		}
		const name = c.name.replace(/^\//, '');
		if (name.length > maxCommandName) {
			continue;
		}
		let description = typeof c.description === 'string' ? c.description.trim() : '';
		const hint = typeof c.argumentHint === 'string' && c.argumentHint.trim() ? c.argumentHint.trim() : undefined;
		let group: CommandGroup;
		let plugin: string | undefined;
		if (c.builtin === true) {
			if (hiddenClaudeCommands.has(name) || /\bsessions only\)\s*$/.test(description)) {
				continue;
			}
			group = 'builtin';
		} else {
			const tail = description.slice(-200);
			const tag = /\(([^()]+)\)$/.exec(tail);
			const source = tag?.[1].trim();
			if (tag) {
				description = description.slice(0, description.length - tail.length + tag.index).trim();
			}
			if (source === 'user') {
				group = 'user';
			} else if (source === 'project') {
				group = 'project';
			} else if (source === 'claude.ai sync') {
				group = 'synced';
			} else if (source || name.includes(':')) {
				group = 'plugin';
				plugin = name.includes(':') ? name.slice(0, name.indexOf(':')) : source;
			} else {
				group = 'user';
			}
		}
		seen.add(c.name);
		out.push({ name, insert: `/${name}`, description: cut(description) || undefined, hint: hint && cut(hint), group, plugin });
	}
	return sortCommands(out);
}

/**
 * Codex's skills, from `skills/list` (measured on codex-cli 0.162.0-alpha.17.2).
 *
 * The answer is `{ data: [{ cwd, skills, errors }] }`, one entry per folder
 * asked about. A skill has `name`, `description`, `path` (its `SKILL.md`),
 * `scope` — `repo` for the project's `.agents/skills` and `.codex/skills`,
 * `user` for `~/.codex/skills`, `~/.agents/skills` and plugins, `system` for
 * the ones Codex ships — `enabled`, `pluginId` (`pdf@openai-primary-runtime`)
 * and an optional `interface` with a `displayName` and a `shortDescription`.
 * A plugin's skill is named `<plugin>:<skill>`. A disabled skill is left out,
 * as Codex's own picker leaves it out.
 */
export function codexSkills(list: unknown): ChatCommand[] {
	const data = isRecord(list) ? list.data : undefined;
	if (!Array.isArray(data)) {
		return [];
	}
	const out: ChatCommand[] = [];
	const seen = new Set<string>();
	for (const entry of data) {
		const skills = isRecord(entry) ? entry.skills : undefined;
		if (!Array.isArray(skills)) {
			continue;
		}
		for (const s of skills) {
			if (!isRecord(s) || typeof s.name !== 'string' || !s.name || s.name.length > maxCommandName || /\s/.test(s.name) || s.enabled === false || seen.has(s.name)) {
				continue;
			}
			const face = isRecord(s.interface) ? s.interface : {};
			const pluginId = typeof s.pluginId === 'string' && s.pluginId ? s.pluginId : undefined;
			const group: CommandGroup = s.scope === 'repo' ? 'project'
				: s.scope === 'system' || s.scope === 'admin' ? 'system'
					: pluginId ? 'plugin' : 'user';
			const title = typeof face.displayName === 'string' && face.displayName.trim() && face.displayName.trim() !== s.name ? face.displayName.trim() : undefined;
			const description = [face.shortDescription, s.shortDescription, s.description]
				.find((d): d is string => typeof d === 'string' && d.trim() !== '')?.trim();
			seen.add(s.name);
			out.push({
				name: s.name, insert: `$${s.name}`, title: title && cut(title), description: description && cut(description), group,
				plugin: group === 'plugin' ? pluginId?.split('@')[0] : undefined,
				path: typeof s.path === 'string' && s.path ? s.path : undefined,
			});
		}
	}
	return sortCommands(out);
}

const groupOrder: readonly CommandGroup[] = ['project', 'user', 'plugin', 'synced', 'system', 'builtin'];

/** By group, then by plugin, then by name — the order the palette shows them in. */
function sortCommands(commands: ChatCommand[]): ChatCommand[] {
	return commands.sort((a, b) =>
		groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group)
		|| (a.plugin ?? '').localeCompare(b.plugin ?? '')
		|| a.name.localeCompare(b.name));
}

/**
 * The skills a Codex message names as `$name`, as the `skill` input items
 * that go with it — the explicit form Codex's own composer sends, beside the
 * `$name` it leaves in the text. Measured: the text alone usually works too,
 * since the model is told the skills exist and opens the file itself; the item
 * is what makes it certain. A name counts only as a whole word after `$`, at
 * the start or after white space, and only once.
 */
export function codexSkillItems(text: string, skills: readonly ChatCommand[]): { type: 'skill'; name: string; path: string }[] {
	const out: { type: 'skill'; name: string; path: string }[] = [];
	for (const s of skills) {
		if (!s.path || out.some(o => o.name === s.name)) {
			continue;
		}
		const escaped = s.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		if (new RegExp(`(^|\\s)\\$${escaped}(?=$|[\\s.,;!?)])`).test(text)) {
			out.push({ type: 'skill', name: s.name, path: s.path });
		}
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
	/** The limits of the whole plan, not of one model: only those send a message to extra usage. */
	const planWide: UsageWindow[] = [];
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
			const window = {
				label: claudeLimitLabel(row),
				usedPercent: row.percent,
				resetsAt: isoTime(row.resets_at),
			};
			usage.windows.push(window);
			// A model's own weekly limit (`weekly_scoped`, `scope.model`) used up
			// leaves the other models on the plan.
			if (row.scope === null || row.scope === undefined) {
				planWide.push(window);
			}
		}
	} else {
		for (const [key, label] of [['five_hour', '5-hour limit'], ['seven_day', 'Weekly limit']] as const) {
			const w = limits[key];
			if (isRecord(w) && typeof w.utilization === 'number') {
				const window = { label, usedPercent: w.utilization, resetsAt: isoTime(w.resets_at) };
				usage.windows.push(window);
				planWide.push(window);
			}
		}
	}
	const extra = limits && isRecord(limits.extra_usage) ? limits.extra_usage : undefined;
	// Spending extra usage now: it is on, its own cap is not reached, and a limit
	// of the whole plan is — which is when Claude Code bills past the plan. A
	// guess: measured on 2.1.301, `get_usage` says only whether it is on, and
	// reads a point higher than the turn's own report (85 against 0.84), so 100
	// here can be 99 there. Whether a turn spends it comes with
	// `rate_limit_event`'s `isUsingOverage` (`claudeRateLimit`), which outranks
	// this (`LimitState.turnSaid`).
	const usingCredits = extra?.is_enabled === true && extra.spend_limit_reached !== true && planWide.some(w => w.usedPercent >= 100);
	if (extra?.is_enabled === true) {
		const spend = limits && isRecord(limits.spend) && isRecord(limits.spend.used) ? limits.spend.used : undefined;
		const amount = spend && typeof spend.amount_minor === 'number' && typeof spend.exponent === 'number'
			? `${(spend.amount_minor / 10 ** spend.exponent).toFixed(spend.exponent)} ${typeof spend.currency === 'string' ? spend.currency : ''}`.trim()
			: undefined;
		usage.notes.push(amount ? `Extra usage is on — ${amount} used this month.` : 'Extra usage is on.');
		if (usingCredits) {
			usage.notes.push('A plan limit is reached: messages now spend usage credits (extra usage).');
		}
	}
	return { agent: 'claude', ...usage, usingCredits };
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
 * The windows in a Claude Code `rate_limit_event`. Measured on 2.1.301: sent
 * after a turn's first model request, not before it, and not on every turn.
 *
 * **Its `utilization` is a fraction, not a percentage** — 0.06 means 6%, while
 * `get_usage` reports the same window on a 0–100 scale. Read with the other
 * function's scale and every bar shows 0%.
 */
export function claudeRateLimitWindows(event: unknown): UsageWindow[] | undefined {
	return claudeRateLimit(event)?.windows;
}

/**
 * A `rate_limit_event` whole: its windows, and whether this turn spends extra
 * usage — `isUsingOverage`, measured on 2.1.301 beside `overageStatus` and
 * `overageEnabled`. Absent when the event carries no windows.
 */
export function claudeRateLimit(event: unknown): { windows: UsageWindow[]; usingCredits?: boolean } | undefined {
	const info = isRecord(event) && isRecord(event.rate_limit_info) ? event.rate_limit_info : undefined;
	const windows = info && isRecord(info.unifiedWindows) ? info.unifiedWindows : undefined;
	if (!windows) {
		return undefined;
	}
	const usingCredits = typeof info?.isUsingOverage === 'boolean' ? info.isUsingOverage : undefined;
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
	return { windows: out, usingCredits };
}

/**
 * Codex's plan usage, from `account/rateLimits/read` or the
 * `account/rateLimits/updated` notification — both carry `rateLimits`, and the
 * read adds `rateLimitsByLimitId` when there is more than one limit.
 * `usedPercent` is 0–100 and `resetsAt` is in seconds.
 */
/**
 * `named`: whether the windows are named after their limit. Undefined: when
 * the answer lists several. The `updated` notification carries one limit, and
 * its backend says whether the last read listed several.
 */
export function codexUsage(response: unknown, plan?: string, named?: boolean): AgentUsage {
	const windows: UsageWindow[] = [];
	const notes: string[] = [];
	let usingCredits = false;
	if (!isRecord(response)) {
		return { agent: 'codex', plan, windows, notes, error: 'Codex returned no usage.' };
	}
	// `ordinaryUsageAllowed` false: the plan's own usage is used up (the read
	// carries it; the `updated` notification does not, and a limit at 100 %
	// stands in for it there).
	const ordinaryBlocked = response.ordinaryUsageAllowed === false;
	const byId = isRecord(response.rateLimitsByLimitId) ? Object.values(response.rateLimitsByLimitId) : [];
	const limits = byId.length ? byId : [response.rateLimits];
	named ??= limits.length > 1;
	for (const limit of limits) {
		if (!isRecord(limit)) {
			continue;
		}
		if (!plan && typeof limit.planType === 'string') {
			plan = limit.planType;
		}
		// Measured on 0.162: the main limit's `limitName` is null, its `limitId`
		// "codex"; the id keeps two unnamed limits from sharing a label.
		const name = typeof limit.limitName === 'string' && limit.limitName ? limit.limitName
			: typeof limit.limitId === 'string' && limit.limitId ? limit.limitId : '';
		const prefix = named && name ? `${name} · ` : '';
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
		// Past a limit with credits to spend, and no spend cap reached: Codex
		// goes on by spending them. Read from the schema of 0.162 and a read with
		// nothing spent; a session that actually spends credits was not measured.
		const full = (w: unknown) => isRecord(w) && typeof w.usedPercent === 'number' && w.usedPercent >= 100;
		const reached = ordinaryBlocked || !!limit.rateLimitReachedType || full(limit.primary) || full(limit.secondary);
		if (reached && (credits?.hasCredits === true || credits?.unlimited === true) && limit.spendControlReached !== true) {
			usingCredits = true;
		}
	}
	if (usingCredits) {
		notes.push('A plan limit is reached: Codex now spends credits.');
	}
	return { agent: 'codex', plan, windows, notes, usingCredits };
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
	| { readonly type: 'turnEnd'; readonly error?: string; readonly tooLong?: boolean }
	/** `models`: the models that actually answered the turn, when they are not the one picked (Gemini's Auto). */
	| { readonly type: 'tokens'; readonly input: number; readonly output: number; readonly cached: number; readonly costUsd?: number; readonly cumulative: boolean; readonly models?: readonly string[] }
	| { readonly type: 'limits'; readonly windows: readonly UsageWindow[]; readonly usingCredits?: boolean }
	/**
	 * How full the conversation's context window is: `used` tokens the next
	 * request will carry, out of `window`. Either may come alone — Claude Code
	 * reports the size with each reply and the window only at the turn's end.
	 * `compacted`: the conversation was just compacted and its new size is not
	 * known until the next request reports one.
	 */
	| { readonly type: 'context'; readonly used?: number; readonly window?: number; readonly compacted?: boolean }
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
 *
 * `context` keeps the conversation's own model between messages — from `init`
 * and the main agent's replies — so the turn's `result`, which lists every
 * model the turn used (sub-agents included), names the right context window.
 */
export function claudeEvents(message: Record<string, unknown>, tasks?: Map<string, string>, context?: { model?: string; nestedAgents?: Set<string> }): AgentEvent[] {
	switch (message.type) {
		case 'system': {
			if (message.subtype === 'init' && typeof message.session_id === 'string') {
				if (context && typeof message.model === 'string') {
					context.model = message.model;
				}
				return [{ type: 'session', id: message.session_id }];
			}
			if (message.subtype === 'compact_boundary') {
				return claudeCompacted(message);
			}
			const events = claudeTaskEvents(message, tasks);
			for (const event of events) {
				if (event.type === 'toolUpdate' && event.update.status) { context?.nestedAgents?.delete(event.id); }
			}
			return events;
		}

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
				const events: AgentEvent[] = [];
				for (const block of content.filter(isRecord)) {
					if (block.type !== 'tool_use' || typeof block.name !== 'string') { continue; }
					events.push({ type: 'agentCall', parentId, name: block.name, detail: toolDetail(block.input) });
					const tool = claudeTool(block.name, block.input);
					if (tool.kind === 'agent' && typeof block.id === 'string') {
						if (context) { (context.nestedAgents ??= new Set()).add(block.id); }
						// Background, so the turn's end does not settle it while its
						// parent works on; `parentId` ends it with the parent.
						events.push({ type: 'tool', id: block.id, tool: { ...tool, agent: { ...tool.agent, background: true, parentId } } });
					}
				}
				return events;
			}
			// A command the CLI answers itself — `/usage`, `/agents`, `/context`,
			// `/mcp` — streams nothing: its whole answer is this one message, from
			// the model `<synthetic>` (measured, 2.1.301). Text is otherwise read
			// from the deltas only, so without this the chat showed no answer at all.
			if (isRecord(message.message) && message.message.model === '<synthetic>') {
				// An API error ("Prompt is too long") comes the same way, flagged, and
				// the turn's `result` then carries the same text as its error — read
				// both and the chat said it twice.
				if (message.is_api_error_message === true) {
					return [];
				}
				const texts = content.filter(isRecord)
					.filter(block => block.type === 'text' && typeof block.text === 'string' && block.text !== '')
					.map(block => block.text as string);
				return texts.length ? [{ type: 'textBreak' }, { type: 'text', text: texts.join('\n\n') }] : [];
			}
			// `AskUserQuestion` gets no row: its card in the chat is the question
			// and holds the answer, and its result finds no row to update.
			const events: AgentEvent[] = content
				.filter(isRecord)
				.filter(block => block.type === 'tool_use' && typeof block.name === 'string' && typeof block.id === 'string' && block.name !== 'AskUserQuestion')
				.map(block => ({ type: 'tool' as const, id: block.id as string, tool: claudeTool(block.name as string, block.input) }));
			// Each of the main agent's replies carries that one request's usage:
			// everything it read plus what it wrote is what the next request
			// carries. The turn's `result` adds up every request of the turn, so it
			// would count the conversation once per tool round.
			const used = isRecord(message.message) ? claudeContextUsed(message.message.usage) : undefined;
			if (used !== undefined) {
				if (context && isRecord(message.message) && typeof message.message.model === 'string') {
					context.model = message.message.model;
				}
				events.push({ type: 'context', used });
			}
			return events;
		}

		case 'user': {
			const content = isRecord(message.message) ? message.message.content : undefined;
			if (!Array.isArray(content)) {
				return [];
			}
			return content
				.filter(isRecord)
				.filter(block => block.type === 'tool_result' && typeof block.tool_use_id === 'string' && (!message.parent_tool_use_id || context?.nestedAgents?.has(block.tool_use_id)))
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
					context?.nestedAgents?.delete(block.tool_use_id as string);
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
			const limit = claudeRateLimit(message);
			return limit && (limit.windows.length || limit.usingCredits !== undefined)
				? [{ type: 'limits', windows: limit.windows, usingCredits: limit.usingCredits }]
				: [];
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
			const window = claudeContextWindow(message.modelUsage, context?.model);
			if (window !== undefined) {
				events.push({ type: 'context', window });
			}
			const failed = message.is_error === true || (typeof message.subtype === 'string' && message.subtype !== 'success');
			// Over the context: Claude Code compacts on its own right after this
			// error, so the chat sends the prompt again (`ChatTab`, `tooLongRetryMs`).
			const tooLong = failed && promptTooLong(message);
			events.push(tooLong ? { type: 'turnEnd', error: resultError(message), tooLong: true } : { type: 'turnEnd', error: failed ? resultError(message) : undefined });
			return events;
		}

		default:
			return [];
	}
}

/** The context one Claude request used: input, both cache halves, and its own output. */
function claudeContextUsed(usage: unknown): number | undefined {
	if (!isRecord(usage) || typeof usage.input_tokens !== 'number') {
		return undefined;
	}
	const used = num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens) + num(usage.output_tokens);
	return used > 0 ? used : undefined;
}

/**
 * The context window of the conversation's model, from `result.modelUsage`
 * (`{ "<model>": { contextWindow, … } }`, measured on 2.1.301). The map lists
 * every model the turn used, sub-agents' included, so it is read for the
 * model the conversation runs on; with that unknown, only a map of one entry
 * answers — guessing among several could name a sub-agent's smaller window.
 */
export function claudeContextWindow(modelUsage: unknown, model: string | undefined): number | undefined {
	if (!isRecord(modelUsage)) {
		return undefined;
	}
	const windowOf = (entry: unknown) => isRecord(entry) && typeof entry.contextWindow === 'number' && entry.contextWindow > 0 ? entry.contextWindow : undefined;
	if (model && model in modelUsage) {
		return windowOf(modelUsage[model]);
	}
	const entries = Object.values(modelUsage);
	return entries.length === 1 ? windowOf(entries[0]) : undefined;
}

/**
 * `system` / `compact_boundary`: the conversation was compacted — by `/compact`
 * or by Claude Code on its own (`trigger: auto`). **`post_tokens` is the
 * summary alone, not the context**: measured on 2.1.301, a compaction from
 * 21 279 reported 2 220, and the next request carried 25 726 — the system
 * prompt and the tools come back on top of the summary. So the size is left
 * unknown (`compacted`) until that request reports it.
 */
function claudeCompacted(message: Record<string, unknown>): AgentEvent[] {
	const meta = isRecord(message.compact_metadata) ? message.compact_metadata : {};
	const before = typeof meta.pre_tokens === 'number' ? meta.pre_tokens : undefined;
	const after = typeof meta.post_tokens === 'number' ? meta.post_tokens : undefined;
	return [
		{ type: 'context', compacted: true },
		{ type: 'notice', text: compactedNotice(before, after) },
	];
}

function compactedNotice(before: number | undefined, summary: number | undefined): string {
	const n = (value: number) => value.toLocaleString('en-US');
	return before !== undefined && summary !== undefined
		? `Conversation compacted: ${n(before)} tokens of context became a ${n(summary)}-token summary.`
		: 'Conversation compacted.';
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
		case 'Workflow': {
			// A workflow orchestrates agents in the background and is a task of its own
			// (`task_type: local_workflow`), so it is listed with the agents. The script
			// is not shown: its `meta.name` / `description` are what names it.
			const script = str('script') ?? '';
			const meta = (key: string) => new RegExp(`\\b${key}\\s*:\\s*(['"])([^'"\\n]{1,200})\\1`).exec(script.slice(0, 4000))?.[2];
			const title = str('name') ?? meta('name') ?? (str('scriptPath')?.split('/').pop());
			const description = str('description') ?? meta('description');
			return {
				kind: 'agent', name, detail: title ? oneLine(title) : 'Workflow', input: description,
				agent: { type: 'workflow', background: true },
			};
		}
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
const agentTaskTypes = new Set(['local_agent', 'remote_agent', 'local_workflow']);

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
				type: message.task_type === 'local_workflow' ? 'workflow' : typeof message.subagent_type === 'string' ? message.subagent_type : undefined,
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

/**
 * Over the context. `terminal_reason` says so on 2.1.301; a result that ends a
 * turn Claude Code is auto-compacting carries only the text, so that is read too.
 */
function promptTooLong(message: Record<string, unknown>): boolean {
	if (message.terminal_reason === 'prompt_too_long') { return true; }
	const text = typeof message.result === 'string' ? message.result
		: Array.isArray(message.errors) ? message.errors.map(String).join('\n') : '';
	return /^\s*prompt is too long\b/i.test(text);
}

function resultError(message: Record<string, unknown>): string {
	// A conversation past the model's context: the CLI says so and stops, and
	// every later message in it fails the same way until it is shortened.
	const tooLong = promptTooLong(message)
		? ' Send /compact to have the agent shorten this conversation, or start a new chat.'
		: '';
	if (typeof message.result === 'string' && message.result) {
		return message.result + tooLong;
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
			// `thread/compact/start`, or Codex compacting on its own: the context
			// it starts again from comes with the `thread/tokenUsage/updated`
			// just before (measured: 16 067 → 11 043 on 0.162.0-alpha.17.2).
			if (item?.type === 'contextCompaction') {
				return [{ type: 'notice', text: compactedNotice(undefined, undefined) }];
			}
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
			const usage = isRecord(p.tokenUsage) ? p.tokenUsage : {};
			const total = isRecord(usage.total) ? usage.total : undefined;
			const events: AgentEvent[] = total
				? [{ type: 'tokens', input: num(total.inputTokens), output: num(total.outputTokens), cached: num(total.cachedInputTokens), cumulative: true }]
				: [];
			// `last` is the latest request alone — what the context holds now;
			// after a compaction it is the compacted size with no input at all, so
			// `totalTokens` is the field to read, not the sum of the parts.
			const last = isRecord(usage.last) && typeof usage.last.totalTokens === 'number' ? usage.last.totalTokens : undefined;
			const window = typeof usage.modelContextWindow === 'number' && usage.modelContextWindow > 0 ? usage.modelContextWindow : undefined;
			if (last !== undefined || window !== undefined) {
				events.push({ type: 'context', used: last, window });
			}
			return events;
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
export function codexSubAgentEvents(item: Record<string, unknown>, parentId?: string): AgentEvent[] {
	const id = typeof item.agentThreadId === 'string' ? item.agentThreadId : undefined;
	if (!id) {
		return [];
	}
	switch (item.kind) {
		case 'started': {
			const path = typeof item.agentPath === 'string' ? item.agentPath : undefined;
			const name = path?.split('/').filter(Boolean).pop()?.replace(/[_-]+/g, ' ').trim();
			// Background: an agent's thread can outlive the turn that started it.
			// Stop and an app-server exit settle it (`CodexSession`), as does its
			// parent agent ending (`parentId`, for an agent an agent started).
			return [{ type: 'tool', id, tool: { kind: 'agent', name: 'Agent', detail: name ? oneLine(name) : undefined, agent: { type: path, threadId: id, background: true, ...(parentId ? { parentId } : {}) } } }];
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
				return codexSubAgentEvents(item, threadId);
			}
			const tool = item ? codexTool(item) : undefined;
			const detail = tool?.kind === 'command' ? tool.input || tool.detail : tool?.detail;
			return tool ? [{ type: 'agentCall', parentId: threadId, name: tool.name, detail: detail ? oneLine(detail) : undefined }] : [];
		}
		case 'item/completed':
			return item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()
				? [{ type: 'toolUpdate', id: threadId, update: { agent: { summary: clip(item.text) } } }]
				: [];
		case 'turn/completed': {
			const turn = isRecord(p.turn) ? p.turn : {};
			if (turn.status === 'failed') {
				const message = isRecord(turn.error) && typeof turn.error.message === 'string' ? clip(turn.error.message) : 'The agent turn failed.';
				return [{ type: 'toolUpdate', id: threadId, update: { status: 'failed', output: message, agent: { summary: message } } }];
			}
			return turn.status === 'interrupted' ? [{ type: 'toolUpdate', id: threadId, update: { status: 'stopped' } }] : [];
		}
		case 'error': {
			// A recoverable transport retry is not a terminal agent failure.
			if (p.willRetry === true) { return []; }
			const message = isRecord(p.error) && typeof p.error.message === 'string' ? clip(p.error.message) : undefined;
			return message ? [{ type: 'toolUpdate', id: threadId, update: { status: 'failed', output: message, agent: { summary: message } } }] : [];
		}
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
				// A spawn starts a child; only its own completion/state report ends it,
				// even when the parent returns without calling wait.
				agent: { type: 'spawnAgent', background: true, model: typeof item.model === 'string' ? item.model : undefined, threadId: threads[0] },
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
	const diffs = changes.map(changeDiff).filter(Boolean);
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

/**
 * One change's `diff`, its lines marked when Codex gives a new or deleted file
 * as plain content: Codex's own log keeps an added file as `content`, not as
 * a patch, and a card (and its diff tab, `diffSides`) read unmarked lines as
 * unchanged — a new file showed nothing added. Only an `add` or `delete` that
 * does not already read as a unified diff is marked, so a patch Codex does
 * send for one is left as it is. Not measured against the app-server's own
 * `add` yet.
 */
function changeDiff(change: Record<string, unknown>): string {
	const diff = typeof change.diff === 'string' ? change.diff : '';
	const kind = isRecord(change.kind) ? change.kind.type : change.kind;
	if (!diff || (kind !== 'add' && kind !== 'delete') || /^(@@|diff --git |--- )/.test(diff)) {
		return diff;
	}
	const mark = kind === 'add' ? '+' : '-';
	return diff.replace(/\r?\n$/, '').split(/\r?\n/).map(line => mark + line).join('\n');
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
	/** The MCP server, for `what: 'mcp'`. */
	readonly server?: string;
	readonly title: string;
	readonly detail?: string;
	/** `what: 'question'`: the questions the agent asks, answered with `AgentSession.answer`'s `answers`. */
	readonly questions?: readonly AgentQuestion[];
	/** A headline for the card in place of the category's own ("Run this command?" would misdescribe typing into a terminal). */
	readonly ask?: string;
	/**
	 * Set for one of our `terminal_*` tools (`ourToolClass`): which tool, its
	 * arguments as the CLI gave them when they could be read, and whether it
	 * only looks. The chat answers a read without a card (the pin is the
	 * consent) and mints the one-shot grant (`terminalGrants.ts`) that lets an
	 * input run once it is approved.
	 */
	readonly terminal?: TerminalApproval;
}

export interface TerminalApproval {
	readonly tool: string;
	/** The arguments the CLI showed; `undefined` when it gave none that could be read (Gemini's title that is not JSON). */
	readonly args?: Readonly<Record<string, unknown>>;
	/** `terminal_list` / `_read` / `_wait`: nothing is typed. */
	readonly read?: true;
}

/** Bounds on what an agent's question brings in: it is the model's text, shown whole otherwise. */
const questionLimits = { questions: 10, options: 30, question: 4000, label: 200, description: 600, header: 80, answer: 4000 } as const;

function capText(value: unknown, limit: number): string {
	const text = typeof value === 'string' ? value.trim() : '';
	return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** One option of a question, in either CLI's shape: `{ label, description }`. */
function questionOptions(value: unknown): AgentQuestion['options'] {
	const out: { label: string; description?: string }[] = [];
	for (const option of Array.isArray(value) ? value : []) {
		const label = isRecord(option) ? oneLine(String(option.label ?? ''), questionLimits.label) : typeof option === 'string' ? oneLine(option, questionLimits.label) : '';
		if (!label || out.some(o => o.label === label)) {
			continue;
		}
		const description = isRecord(option) && typeof option.description === 'string' ? capText(option.description, questionLimits.description) : '';
		out.push(description ? { label, description } : { label });
		if (out.length >= questionLimits.options) {
			break;
		}
	}
	return out;
}

/** A card title for a set of questions: the first one's header, or what it asks. */
function questionsTitle(questions: readonly AgentQuestion[]): string {
	const first = questions[0];
	const title = first?.header || (first ? oneLine(first.question, 120) : '');
	return questions.length > 1 ? `${title} (+${questions.length - 1} more)` : title || 'Question';
}

/**
 * Claude Code's `AskUserQuestion`, which reaches us as `can_use_tool` with
 * `requires_user_interaction: true` (measured, 2.1.301): `input.questions[]` of
 * `{ question, header, options: [{ label, description }], multiSelect }`. The
 * CLI's own UI always offers an answer of the user's own words, so `other` is
 * always on. Ids are the questions' indexes: the answer goes back keyed by the
 * question's text, which `claudeApprovalAnswer` looks up again in the input.
 */
export function claudeQuestions(input: unknown): AgentQuestion[] {
	const list = isRecord(input) && Array.isArray(input.questions) ? input.questions : [];
	const out: AgentQuestion[] = [];
	list.slice(0, questionLimits.questions).forEach((q, index) => {
		if (!isRecord(q) || typeof q.question !== 'string' || !q.question.trim()) {
			return;
		}
		const header = capText(q.header, questionLimits.header);
		out.push({
			id: String(index),
			...(header ? { header } : {}),
			question: capText(q.question, questionLimits.question),
			options: questionOptions(q.options),
			multiSelect: q.multiSelect === true,
			other: true,
		});
	});
	return out;
}

/**
 * Codex's `item/tool/requestUserInput` (codex-cli 0.162, measured; the tool is
 * on in the default mode only with the `default_mode_request_user_input`
 * feature, which the chat's threads set): `questions[]` of `{ id, header,
 * question, options: [{ label, description }] | null, isOther, isSecret }`.
 * No options means an answer in the user's own words.
 */
export function codexQuestions(params: Record<string, unknown>): AgentQuestion[] {
	const out: AgentQuestion[] = [];
	for (const q of Array.isArray(params.questions) ? params.questions.slice(0, questionLimits.questions) : []) {
		if (!isRecord(q) || typeof q.id !== 'string' || !q.id || typeof q.question !== 'string' || !q.question.trim() || out.some(o => o.id === q.id)) {
			continue;
		}
		const options = questionOptions(q.options);
		const header = capText(q.header, questionLimits.header);
		out.push({
			id: q.id,
			...(header ? { header } : {}),
			question: capText(q.question, questionLimits.question),
			options,
			multiSelect: false,
			other: q.isOther === true || !options.length,
			...(q.isSecret === true ? { secret: true } : {}),
		});
	}
	return out;
}

/**
 * The answers a user sent from the view, kept only where they fit the
 * questions: a known id, at most one value unless several may be chosen, and a
 * value that is one of the options unless the user's own words are taken.
 * Anything else is dropped, so what reaches the CLI is what the card offered.
 */
export function validAnswers(questions: readonly AgentQuestion[], answers: unknown): QuestionAnswers {
	const out: Record<string, string[]> = {};
	if (!isRecord(answers)) {
		return out;
	}
	for (const q of questions) {
		if (!Object.prototype.hasOwnProperty.call(answers, q.id)) {
			continue;
		}
		const raw = answers[q.id];
		const values: string[] = [];
		for (const value of Array.isArray(raw) ? raw : []) {
			if (typeof value !== 'string') {
				continue;
			}
			const text = q.secret ? value : value.trim();
			if (!text || text.length > questionLimits.answer || values.includes(text)) {
				continue;
			}
			if (!q.other && !q.options.some(o => o.label === text)) {
				continue;
			}
			values.push(text);
		}
		const kept = q.multiSelect ? values : values.slice(0, 1);
		if (kept.length) {
			out[q.id] = kept;
		}
	}
	return out;
}

/**
 * Whether a path the agent names is outside the project — the "Files outside
 * the project" category, which decides whether Auto for "Files in the project"
 * lets it through, so every way out of the folder counts:
 * - **no project** (`root` undefined: no local folder open) — everything is
 *   outside; the CLI then works in the home directory, and "inside" would have
 *   been all of it, `~/.ssh` included;
 * - **`~`**, which the CLI expands to the home directory itself and
 *   `path.resolve` reads as a folder named `~`; any other `~name` is outside;
 * - **a symlink** inside the folder that leads out of it: decided on real
 *   paths — the longest part of the path that exists, resolved — so
 *   `<project>/homelink/.zshrc` is outside when `homelink` is a link to `~`;
 * - `..` out of it, and a name that only starts like the folder (`/w-old`).
 * A path that cannot be made sense of is outside: this is the cautious side.
 */
export function outsideProject(root: string | undefined, file: string): boolean {
	if (!root) {
		return true;
	}
	let target = file;
	if (target === '~' || target.startsWith('~/') || (process.platform === 'win32' && target.startsWith('~\\'))) {
		target = path.join(os.homedir(), target.slice(1));
	} else if (target.startsWith('~')) {
		return true;
	}
	const base = realish(path.resolve(root));
	const full = realish(path.resolve(root, target));
	if (base === undefined || full === undefined) {
		return true;
	}
	const rel = path.relative(base, full);
	return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

/** How many symlinks one path may pass through before it counts as a loop — the kernel's own order of magnitude. */
const symlinkHops = 40;

/**
 * Where a write to `full` would really land: resolved component by component,
 * as the kernel does, so a symlink anywhere on the way is followed — **a
 * dangling one included**. `realpath` fails on a link whose target does not
 * exist yet, and taking its name as written read `<project>/dangling ->
 * ../outside/x` as inside the project while a Write through it creates the
 * file outside. So a component that does not resolve is `lstat`ed: a link is
 * read and its target resolved in its place (relative to the link's real
 * directory, which is what the kernel resolves it against), a name that does
 * not exist ends the walk with the rest as written (a new file is normal), and
 * anything else — a loop, too many hops, an error that is not "no such file",
 * a file used as a directory — answers `undefined`, which the caller reads as
 * outside: the cautious side.
 */
function realish(full: string): string | undefined {
	try {
		return fs.realpathSync.native(full);
	} catch {
		// Something on the way does not exist or does not resolve; walk it.
	}
	const split = (from: string): string[] => from.split(process.platform === 'win32' ? /[\\/]/ : '/').filter(p => p && p !== '.');
	const parts = (from: string): string[] => split(from.slice(path.parse(from).root.length));
	const realRoot = (of: string): string | undefined => {
		try {
			return fs.realpathSync.native(path.parse(of).root);
		} catch {
			return undefined;
		}
	};
	let resolved = realRoot(full);
	const pending = parts(full);
	let hops = 0;
	while (resolved !== undefined && pending.length) {
		const part = pending.shift() as string;
		if (part === '..') {
			// `resolved` is a real path, so its parent is too.
			resolved = path.dirname(resolved);
			continue;
		}
		const next = path.join(resolved, part);
		try {
			resolved = fs.realpathSync.native(next);
			continue;
		} catch {
			// Look at what is there instead.
		}
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(next);
		} catch (error) {
			if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
				return path.join(next, ...pending);
			}
			return undefined;
		}
		if (!stat.isSymbolicLink() || ++hops > symlinkHops) {
			return undefined;
		}
		let link: string;
		try {
			link = fs.readlinkSync(next);
		} catch {
			return undefined;
		}
		if (path.isAbsolute(link)) {
			resolved = realRoot(link);
		}
		// Not normalised: `..` in a link is taken against the real directory, as the kernel does.
		pending.unshift(...(path.isAbsolute(link) ? parts(link) : split(link)));
	}
	return resolved;
}

/**
 * The path a file tool of Claude Code's names, whichever field it uses — and
 * an absolute or `~` search pattern of `Glob` / `Grep`, which names where it
 * looks as surely as a path does.
 */
function claudePath(input: Record<string, unknown>): string | undefined {
	for (const key of ['file_path', 'notebook_path', 'path']) {
		if (typeof input[key] === 'string' && input[key]) {
			return input[key] as string;
		}
	}
	for (const key of ['pattern', 'glob']) {
		const value = input[key];
		if (typeof value === 'string' && (path.isAbsolute(value) || value.startsWith('~'))) {
			// The fixed part before the first wildcard is where it looks.
			const fixed = value.split(/[*?[{]/)[0];
			return fixed || value;
		}
	}
	return undefined;
}

/**
 * The MCP server this extension runs, as the chat hands it to both CLIs: the
 * same name as `mcpServerName` in `mcpClientState.ts`, written twice since a
 * leaf module may not import another. Also the per-project name Connect Codex
 * once wrote into the global config, `ai-browser-<slug>-<6 hex>` — and only that
 * shape: any `ai-browser-…` would let somebody else's server, named so, be
 * answered by the approval menu's AI Browser mode as if it were the browser.
 */
function isBrowserServer(name: string): boolean {
	return name === 'ai-browser' || /^ai-browser-.+-[0-9a-f]{6}$/.test(name);
}

/**
 * Our server's tools that act on the chat rather than on the page: they stop
 * an agent, hold a queue, keep the computer awake. Filed under a category of
 * their own, "Chat control", or AI Browser on Auto would let an agent stop
 * the conversations beside it without a card. The names are `chatToolNames`
 * in `src/mcp/chatTools.ts`, written twice since a leaf may not import it.
 */
export const chatControlTools: ReadonlySet<string> = new Set(['chat_keep_awake', 'chat_pause', 'chat_resume', 'chat_stop_agent']);

/**
 * Our `terminal_*` tools, `terminalInputToolNames` / `terminalReadToolNames` in
 * `src/mcp/terminalTools.ts`, written twice since a leaf may not import it (a
 * test reads that file). The two that type are command execution: the Terminal
 * category, a card with the exact text, and a one-shot grant. The three that
 * look are answered without a card, as the pin is the consent, and still follow
 * Terminal's Deny.
 */
export const terminalInputTools: ReadonlySet<string> = new Set(['terminal_send', 'terminal_key']);
export const terminalReadTools: ReadonlySet<string> = new Set(['terminal_list', 'terminal_read', 'terminal_wait']);

/**
 * Every tool of our server that is not chat control or a terminal tool, each
 * named: the category AI Browser means a page, the code editor, or a read of
 * the chat. **Fail closed**: a name that is in none of the lists is `other`,
 * never AI Browser. The category used to be the default for any new tool, so
 * the next one added — a terminal that types, say — would have run on AI
 * Browser's Auto with no card on all three CLIs. A test reads the tool files and
 * fails when a tool they register is missing here, which is the moment to
 * decide what it is.
 */
const browserServerTools: ReadonlySet<string> = new Set([
	'browser_annotations_add', 'browser_annotations_clear', 'browser_annotations_get', 'browser_annotations_list', 'browser_annotations_remove',
	'browser_click', 'browser_console', 'browser_drag', 'browser_fill', 'browser_frames', 'browser_hover', 'browser_html',
	'browser_inspect_element', 'browser_navigate', 'browser_press',
	'browser_recording_pause', 'browser_recording_resume', 'browser_recording_start', 'browser_recording_status', 'browser_recording_stop',
	'browser_replace_text', 'browser_restore_text', 'browser_screenshot', 'browser_scroll', 'browser_select_tab', 'browser_selected_element',
	'browser_snapshot', 'browser_state', 'browser_tabs', 'browser_text', 'browser_text_segments', 'browser_type', 'browser_wait_for',
	'editor_context', 'editor_definition', 'editor_references', 'editor_reveal', 'editor_symbols',
	// The chat's reads, which any token holder may make.
	'chat_state', 'chat_agents', 'chat_usage',
]);

/** The category of one of our own server's tools, and for a terminal tool which kind. */
export function ourToolClass(tool: string): { readonly what: ApprovalKind; readonly terminal?: 'input' | 'read' } {
	if (terminalInputTools.has(tool)) {
		return { what: 'command', terminal: 'input' };
	}
	if (terminalReadTools.has(tool)) {
		return { what: 'command', terminal: 'read' };
	}
	if (chatControlTools.has(tool)) {
		return { what: 'chat' };
	}
	return { what: browserServerTools.has(tool) ? 'browser' : 'other' };
}

/** A string for a card with every character that is not plain shown as its code, so what is read is what is typed. */
function visibleLine(text: string): string {
	return text.replace(new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]', 'g'),
		c => `\\u{${c.charCodeAt(0).toString(16).toUpperCase()}}`);
}

/**
 * The card for `terminal_send` / `terminal_key`: the exact text or keys, under
 * a headline that says what they do. Which terminal is not known here, only its
 * id; the chat adds the name and folder. `args` undefined — the CLI showed none
 * that could be read — falls back to what it did show.
 */
function terminalInputCard(id: string, tool: string, args: Readonly<Record<string, unknown>> | undefined, shown: string | undefined): ApprovalRequest {
	const terminal: TerminalApproval = { tool, ...(args ? { args } : {}) };
	if (tool === 'terminal_key') {
		const keys = args && Array.isArray(args.keys) && args.keys.every(k => typeof k === 'string') ? args.keys as string[] : undefined;
		const risky = keys?.some(k => /enter|return|ctrl|\^/i.test(k));
		return {
			id, what: 'command', ask: 'Press keys in a terminal?', terminal,
			title: keys ? keys.map(k => oneLine(k, 40)).join(' → ') : 'Press keys',
			detail: keys
				? 'Presses these keys in order.' + (risky ? ' Enter runs whatever is on the command line, a command recalled with Up included; Ctrl-C and Ctrl-D end what is running.' : '')
				: shown,
		};
	}
	const text = args && (typeof args.text === 'string' || (typeof args.text === 'number' && Number.isFinite(args.text))) ? String(args.text) : args && args.text === undefined && args.terminalId !== undefined ? '' : undefined;
	if (text === undefined) {
		return { id, what: 'command', ask: 'Type into a terminal?', title: 'Type into a terminal', detail: shown, terminal };
	}
	const enter = args?.enter !== false;
	const trailing = /\s+$/.exec(text)?.[0].length ?? 0;
	return {
		id, what: 'command', ask: 'Type into a terminal?', terminal,
		title: (visibleLine(whole(text)) || '(empty)') + (enter ? '  ⏎' : ''),
		detail: [
			enter ? 'Types the line and presses Enter: the shell runs it as you.' : 'Types the text without pressing Enter.',
			trailing ? `The text ends with ${trailing} space or line-break character${trailing === 1 ? '' : 's'}.` : undefined,
		].filter(Boolean).join(' '),
	};
}

/**
 * An approval of one of our own server's tools, from what each CLI gave:
 * `args` are the arguments when they could be read, `shown` the text it showed
 * for them when not.
 */
function ourToolApproval(id: string, tool: string, args: Readonly<Record<string, unknown>> | undefined, shown: string | undefined): ApprovalRequest {
	const cls = ourToolClass(tool);
	if (cls.terminal === 'input') {
		return terminalInputCard(id, tool, args, shown);
	}
	if (cls.terminal === 'read') {
		return { id, what: 'command', title: tool, ...(shown !== undefined ? { detail: shown } : {}), terminal: { tool, ...(args ? { args } : {}), read: true } };
	}
	return { id, what: cls.what, title: tool, ...(shown !== undefined ? { detail: shown } : {}) };
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
const claudeWebTools = new Set(['WebFetch', 'WebSearch']);

/**
 * Claude Code's `can_use_tool` control request, sent when it runs with
 * `--permission-prompt-tool stdio` and a tool needs the user's yes. Measured on
 * 2.1.301: `{ subtype: 'can_use_tool', tool_name, display_name, input,
 * description, permission_suggestions, blocked_path, tool_use_id }`; an MCP
 * tool is named `mcp__<server>__<tool>`. `root` is the project folder —
 * undefined when no local folder is open — which decides whether a file tool's
 * path is inside the project; so does `blocked_path`, the path the CLI itself
 * says the question is about.
 */
export function claudeApproval(id: string, request: Record<string, unknown>, root: string | undefined): ApprovalRequest {
	const tool = typeof request.tool_name === 'string' ? request.tool_name : '';
	const input = isRecord(request.input) ? request.input : {};
	const description = typeof request.description === 'string' ? oneLine(request.description, 300) : undefined;
	const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
	if (tool === 'Bash') {
		const command = typeof input.command === 'string' ? input.command : '';
		return { id, what: 'command', title: whole(command) || 'Bash', detail: description };
	}
	if (!mcp && tool === 'SandboxNetworkAccess') {
		// The sandbox asking to open the network for a host is Codex's
		// `networkApprovalContext` in Claude Code's words: the Internet category.
		const host = typeof input.host === 'string' ? input.host : '';
		return { id, what: 'web', title: host ? `Network access: ${whole(host)}` : tool, detail: description ?? argumentLines(input) };
	}
	if (!mcp && typeof input.command === 'string' && !claudeEditTools.has(tool) && !claudeWebTools.has(tool) && tool !== 'AskUserQuestion') {
		// Bash is not the only tool that runs a command: 2.1.301 has `PowerShell`
		// (its permission rule reads `command`) and `Monitor`. Under Other tools
		// they escaped the Terminal category's Deny and Ask, and the card showed
		// the model's description of the command instead of the command (#380).
		return { id, what: 'command', title: whole(input.command) || tool, detail: description ? `${tool} — ${description}` : tool };
	}
	if (mcp) {
		const [, server, name] = mcp;
		const args = argumentLines(input);
		// `mcp__<server>__<tool>` cannot be split for sure when either half holds
		// `__` itself: `mcp__ai-browser__fs__write_file` read as our server and
		// its Auto answered a filesystem server's write, and `team__deploy` was
		// filed under `team`, whose "Always" then covered it. Such a name names
		// no category it can be trusted with, so it is asked under Other tools.
		// Counted over the whole name, overlaps included: `mcp__ai-browser___x`
		// is our server's `_x` or the server `ai-browser_`'s `x` (Claude Code
		// turns `ai-browser.` into that), and the lazy split above picks ours.
		const rest = tool.slice('mcp__'.length);
		if (rest.indexOf('__') !== rest.lastIndexOf('__')) {
			return { id, what: 'other', title: tool, detail: args };
		}
		return isBrowserServer(server)
			? ourToolApproval(id, name, input, args)
			: { id, what: 'mcp', server, title: name, detail: args };
	}
	if (claudeWebTools.has(tool)) {
		const target = typeof input.url === 'string' ? input.url : typeof input.query === 'string' ? input.query : '';
		return { id, what: 'web', title: whole(target) || tool, detail: tool === 'WebFetch' && typeof input.prompt === 'string' ? oneLine(input.prompt, 300) : tool };
	}
	const file = claudePath(input);
	const blocked = typeof request.blocked_path === 'string' && request.blocked_path ? request.blocked_path : undefined;
	const outside = (!!file && outsideProject(root, file)) || (!!blocked && outsideProject(root, blocked));
	if (claudeEditTools.has(tool)) {
		// A file tool with no path is not something "inside" can be promised for.
		return { id, what: outside || !file ? 'outside' : 'edit', title: file || tool, detail: tool };
	}
	if (tool === 'AskUserQuestion') {
		const questions = claudeQuestions(input);
		if (questions.length) {
			return { id, what: 'question', title: questionsTitle(questions), questions };
		}
	}
	const name = typeof request.display_name === 'string' && request.display_name ? request.display_name : tool || 'Tool';
	// Reading or searching asks only outside the project; that is what it is.
	if (outside) {
		return { id, what: 'outside', title: file ?? blocked ?? name, detail: name };
	}
	// The arguments are what Allow runs, so they are always shown; the model's
	// description goes above them, never in their place (#380).
	const args = argumentLines(input);
	return { id, what: 'other', title: name, detail: description && args ? `${description}\n\n${args}` : description ?? args };
}

/** What the model reads when the user leaves its questions unanswered. */
export const questionSkipped = 'The user did not answer these questions. Continue with your best judgement, and say which choice you made.';

/**
 * What `can_use_tool` is answered with: the input as it was, or a refusal the
 * model reads. An `AskUserQuestion` (`answers` given) is answered by allowing
 * it with `answers` added to its input — keyed by each question's text, several
 * choices joined with ", " — which the CLI hands the model as "Your questions
 * have been answered: …" (measured, 2.1.301). Skipped, it is a refusal that
 * tells the model to go on without the answer.
 */
export function claudeApprovalAnswer(input: unknown, allow: boolean, answers?: QuestionAnswers, question = false): Record<string, unknown> {
	const given = isRecord(input) ? input : {};
	if (allow && answers) {
		const list = Array.isArray(given.questions) ? given.questions : [];
		const byText: Record<string, string> = {};
		for (const [id, values] of Object.entries(answers)) {
			const q = list[Number(id)];
			if (isRecord(q) && typeof q.question === 'string' && values.length) {
				byText[q.question] = values.join(', ');
			}
		}
		return { behavior: 'allow', updatedInput: { ...given, answers: byText } };
	}
	if (question && !allow) {
		return { behavior: 'deny', message: questionSkipped };
	}
	return allow
		? { behavior: 'allow', updatedInput: given }
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
export function codexApproval(id: string, method: string, params: Record<string, unknown>, files: readonly string[] = [], root?: string): ApprovalRequest | undefined {
	const reason = typeof params.reason === 'string' && params.reason ? oneLine(params.reason, 300) : undefined;
	switch (method) {
		case 'item/commandExecution/requestApproval':
		case 'execCommandApproval': {
			const raw = Array.isArray(params.command) ? strings(params.command).join(' ') : typeof params.command === 'string' ? params.command : '';
			const network = isRecord(params.networkApprovalContext) ? params.networkApprovalContext : undefined;
			// Opening the network for a command is the internet's category, not the
			// terminal's; typing into a running command is the terminal's.
			if (network) {
				const host = typeof network.host === 'string' ? network.host : undefined;
				return {
					id, what: 'web',
					title: `Network access${host ? `: ${host}` : ''}`,
					detail: [raw && whole(unwrapShell(raw)), reason].filter(Boolean).join('\n') || undefined,
				};
			}
			if (params.kind === 'writeStdin') {
				return { id, what: 'command', title: 'Input to a running command', detail: [raw && whole(unwrapShell(raw)), reason].filter(Boolean).join('\n') || undefined };
			}
			return { id, what: 'command', title: whole(unwrapShell(raw)) || 'Command', detail: reason };
		}
		case 'item/fileChange/requestApproval':
		case 'applyPatchApproval': {
			// The v2 request names only its item; the paths are on the
			// `fileChange` item that started just before, which the caller keeps.
			// Every path the patch writes: the files it changes and where a move
			// takes one (`move_path`), which is a write as surely as an edit is.
			const named = isRecord(params.fileChanges) ? codexPatchPaths(params.fileChanges) : files;
			const grantRoot = typeof params.grantRoot === 'string' && params.grantRoot ? params.grantRoot : undefined;
			const grant = grantRoot ? `Write access to everything under ${grantRoot} for this conversation` : undefined;
			// Writes under a root of their own, to a file outside the project, or
			// to files nobody can name, are outside it; no folder, nothing is inside.
			const outside = !!grantRoot || !named.length || named.some(file => outsideProject(root, file));
			return { id, what: outside ? 'outside' : 'edit', title: named.length ? named.join('\n') : 'Apply the edit', detail: [grant, reason].filter(Boolean).join('\n') || undefined };
		}
		case 'mcpServer/elicitation/request': {
			const meta = isRecord(params._meta) ? params._meta : {};
			if (meta.codex_approval_kind !== 'mcp_tool_call') {
				return undefined;
			}
			const server = typeof params.serverName === 'string' ? params.serverName : '';
			const message = typeof params.message === 'string' ? params.message : '';
			const named = /tool "([^"]+)"/.exec(message)?.[1];
			const name = named ?? (typeof meta.tool_title === 'string' ? meta.tool_title : 'Tool');
			const args = argumentLines(meta.tool_params);
			// Our tool with no name to read is filed under Chat control: a title
			// says nothing for sure, and the stricter category costs a card.
			return isBrowserServer(server)
				? named
					? ourToolApproval(id, named, isRecord(meta.tool_params) ? meta.tool_params : undefined, args)
					: { id, what: 'chat', title: name, detail: args }
				: { id, what: 'mcp', server, title: name, detail: args };
		}
		case 'item/tool/requestUserInput': {
			const questions = codexQuestions(params);
			return questions.length ? { id, what: 'question', title: questionsTitle(questions), questions } : undefined;
		}
		default:
			return undefined;
	}
}

/**
 * The paths a Codex patch writes, from either shape it comes in: the legacy
 * `fileChanges` map (path → change, `move_path` on an update) or the v2
 * `fileChange` item's `changes` list (`path`, `kind.move_path`).
 */
export function codexPatchPaths(changes: unknown): string[] {
	const out: string[] = [];
	const moved = (change: unknown) => {
		if (!isRecord(change)) {
			return;
		}
		const kind = isRecord(change.kind) ? change.kind : undefined;
		for (const value of [change.move_path, kind?.move_path]) {
			if (typeof value === 'string' && value) {
				out.push(value);
			}
		}
	};
	if (Array.isArray(changes)) {
		for (const change of changes) {
			if (isRecord(change) && typeof change.path === 'string') {
				out.push(change.path);
			}
			moved(change);
		}
	} else if (isRecord(changes)) {
		for (const [file, change] of Object.entries(changes)) {
			out.push(file);
			moved(change);
		}
	}
	return [...new Set(out)];
}

/**
 * The result a Codex approval is answered with. A command's refusal is
 * `decline` — the turn goes on and the model is told — unless the request lists
 * its decisions without it, when only `cancel` (which ends the turn) refuses.
 */
export function codexApprovalAnswer(method: string, params: Record<string, unknown>, allow: boolean, answers?: QuestionAnswers): Record<string, unknown> {
	switch (method) {
		case 'item/tool/requestUserInput': {
			// `{ answers: { <question id>: { answers: [...] } } }`; skipped, no
			// answers at all, which the model reads as the user not answering.
			const out: Record<string, { answers: readonly string[] }> = {};
			for (const [id, values] of Object.entries(allow && answers ? answers : {})) {
				if (values.length) {
					out[id] = { answers: values };
				}
			}
			return { answers: out };
		}
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

/* ---------------------------------------------------------------- gemini */

/*
 * Gemini CLI, driven over ACP — the Agent Client Protocol, `gemini --acp`:
 * JSON-RPC 2.0 over stdio, one object per line. Measured on gemini-cli 0.64.0
 * (2026-10-20), the samples in `agentProtocol.test.ts` are those answers.
 *
 * - `session/new { cwd, mcpServers }` answers with the session id, the models
 *   (`models.availableModels[{ modelId, name, description }]`, `currentModelId`)
 *   and the modes — so the model list costs no prompt. An
 *   `available_commands_update` follows on its own.
 * - `session/prompt` answers when the turn ends, with `stopReason` and the
 *   turn's `usage`; everything in between is a `session/update` notification.
 * - A tool that needs a yes is a `tool_call` (`status: pending`) and then a
 *   `session/request_permission` request, answered with one of its options.
 */

/** The models `session/new` lists; `auto` (Gemini CLI routes per request) is the default. */
export function geminiModels(session: unknown): ChatModel[] {
	const models = isRecord(session) && isRecord(session.models) ? session.models : {};
	const current = typeof models.currentModelId === 'string' ? models.currentModelId : undefined;
	const out: ChatModel[] = [];
	for (const m of Array.isArray(models.availableModels) ? models.availableModels : []) {
		if (!isRecord(m) || typeof m.modelId !== 'string' || !m.modelId || out.some(o => o.id === m.modelId)) {
			continue;
		}
		const label = typeof m.name === 'string' && m.name.trim() ? oneLine(m.name, 80) : m.modelId;
		const description = typeof m.description === 'string' && m.description.trim() ? capText(m.description, 300) : undefined;
		out.push({ id: m.modelId, label, ...(description ? { description } : {}), efforts: [], isDefault: m.modelId === current });
	}
	if (out.length && !out.some(m => m.isDefault)) {
		out[0] = { ...out[0], isDefault: true };
	}
	return out;
}

/**
 * Commands Gemini CLI handles itself over ACP, from `available_commands_update`.
 * Only the top-level ones: `memory show` and the like are typed after their
 * parent. `restore` is left out — it resets the conversation and its files to
 * a checkpoint, under a chat that does not know it happened (the reason
 * `hiddenClaudeCommands` exists). Custom `.toml` commands and skills are not
 * handled over ACP in 0.64 (read in its source), so none are listed.
 */
export function geminiCommands(update: unknown): ChatCommand[] {
	const list = isRecord(update) && Array.isArray(update.availableCommands) ? update.availableCommands : [];
	const out: ChatCommand[] = [];
	for (const c of list) {
		if (!isRecord(c) || typeof c.name !== 'string') {
			continue;
		}
		const name = c.name.trim();
		if (!/^[a-z][\w:-]{0,60}$/i.test(name) || name === 'restore' || out.some(o => o.name === name)) {
			continue;
		}
		const description = typeof c.description === 'string' ? capText(c.description, 500) : undefined;
		out.push({ name, insert: `/${name}`, ...(description ? { description } : {}), group: 'builtin' });
	}
	return out;
}

/** `browser_state (ai-browser MCP Server)`: the tool and its server, as Gemini titles an MCP call with no arguments. */
function geminiMcpTitle(title: string): { server: string; tool: string } | undefined {
	const match = /^(.+?) \((.+) MCP Server\)$/.exec(title);
	return match ? { tool: match[1], server: match[2] } : undefined;
}

/** Gemini's own spelling of an MCP tool's name: `generateValidName` in gemini-cli. */
function geminiToolName(part: string): string {
	return part.replace(/[^a-zA-Z0-9_\-.:]/g, '_');
}

/**
 * Whether a Gemini tool call is an MCP tool, and whose. **Never from the title
 * alone**: a shell command's title is the command, and an MCP tool with a
 * `command` argument is titled by it too, so `rm -rf ~ # (ai-browser MCP Server)`
 * read as the browser and Terminal's rule was skipped. What the model cannot
 * write is the tool's kind (MCP tools are `other`) and the call's id,
 * `<registered name>__call_<n>` (or `<name>-<ms>-<n>`), where an MCP tool is
 * registered as `mcp_<server>_<tool>`. The title only splits that name into
 * server and tool, and only when it agrees with it: `<tool> (<server> MCP
 * Server)` with no arguments, `<tool>(<args>)` with them (then the server is
 * what the id leaves). A name that cannot be split comes back with no server,
 * which the approval menu asks about under Other tools.
 */
function geminiMcpCall(call: Record<string, unknown>): { server?: string; tool: string } | undefined {
	if (call.kind !== undefined && call.kind !== 'other') {
		return undefined;
	}
	const id = typeof call.toolCallId === 'string' ? call.toolCallId : '';
	const name = /^(mcp_.+)(?:__call_\d+|-\d+-\d+)$/.exec(id)?.[1];
	if (!name) {
		return undefined;
	}
	const title = typeof call.title === 'string' ? call.title : '';
	const titled = geminiMcpTitle(title);
	if (titled && name === `mcp_${geminiToolName(titled.server)}_${geminiToolName(titled.tool)}`) {
		return titled;
	}
	const ours = /^mcp_(ai-browser(?:-.+-[0-9a-f]{6})?)_((?:browser|editor|chat|terminal)_[a-z_]+)$/.exec(name);
	if (ours) {
		return { server: ours[1], tool: ours[2] };
	}
	const tool = /^([A-Za-z0-9_.:-]+)\(/.exec(title)?.[1];
	const suffix = tool ? `_${geminiToolName(tool)}` : '';
	if (tool && name.endsWith(suffix) && name.length > 'mcp_'.length + suffix.length) {
		return { server: name.slice('mcp_'.length, -suffix.length), tool };
	}
	return { tool: name };
}

/**
 * The arguments of a Gemini MCP call from its title, which is all it says of
 * them: the JSON itself, or `<tool>(<JSON>)`. `undefined` when the title is
 * neither — then nothing but the title can be shown, and an approval is matched
 * by what was typed next rather than by what was shown (`terminalGrants.ts`).
 * Not measured on a call with long arguments: whether Gemini cuts the title is
 * unknown, so a cut one simply does not parse.
 */
function geminiToolArguments(title: string, tool: string): Record<string, unknown> | undefined {
	const inner = title.startsWith(`${tool}(`) && title.endsWith(')') ? title.slice(tool.length + 1, -1) : title;
	try {
		const parsed: unknown = JSON.parse(inner);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** The paths a Gemini tool call names: its `locations`, and the file of each diff. */
function geminiPaths(call: Record<string, unknown>): string[] {
	const out: string[] = [];
	for (const location of Array.isArray(call.locations) ? call.locations : []) {
		if (isRecord(location) && typeof location.path === 'string' && location.path) {
			out.push(location.path);
		}
	}
	for (const item of Array.isArray(call.content) ? call.content : []) {
		if (isRecord(item) && item.type === 'diff' && typeof item.path === 'string' && item.path) {
			out.push(item.path);
		}
	}
	return [...new Set(out)];
}

/** The text items of a tool call's content, joined: a command's description, an MCP tool's result. */
function geminiText(call: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const item of Array.isArray(call.content) ? call.content : []) {
		if (isRecord(item) && item.type === 'content' && isRecord(item.content) && item.content.type === 'text' && typeof item.content.text === 'string') {
			parts.push(item.content.text);
		}
	}
	return parts.join('\n');
}

/**
 * A unified diff from the `diff` items of an edit — `{ path, oldText, newText }`,
 * whole files. The lines both sides share at the start and the end are left out
 * and the rest is one hunk: enough for the card's counts and its first lines,
 * and for `diffSides` to rebuild the two halves of the change.
 */
function geminiDiff(call: Record<string, unknown>): { input?: string; added?: number; removed?: number } {
	const diffs: string[] = [];
	let added = 0;
	let removed = 0;
	for (const item of Array.isArray(call.content) ? call.content : []) {
		if (!isRecord(item) || item.type !== 'diff' || typeof item.newText !== 'string') {
			continue;
		}
		const before = typeof item.oldText === 'string' && item.oldText ? item.oldText.replace(/\r?\n$/, '').split(/\r?\n/) : [];
		const after = item.newText ? item.newText.replace(/\r?\n$/, '').split(/\r?\n/) : [];
		let start = 0;
		while (start < before.length && start < after.length && before[start] === after[start]) {
			start++;
		}
		let end = 0;
		while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) {
			end++;
		}
		const gone = before.slice(start, before.length - end);
		const come = after.slice(start, after.length - end);
		removed += gone.length;
		added += come.length;
		const file = typeof item.path === 'string' ? item.path : '';
		diffs.push([
			`--- ${file}`, `+++ ${file}`,
			`@@ -${start + 1},${gone.length} +${start + 1},${come.length} @@`,
			...gone.map(line => `-${line}`), ...come.map(line => `+${line}`),
		].join('\n'));
	}
	return diffs.length ? { input: clip(diffs.join('\n')), added, removed } : {};
}

/** A Gemini tool call as the chat's row. */
function geminiTool(call: Record<string, unknown>): ToolStart {
	const title = typeof call.title === 'string' ? call.title : '';
	const paths = geminiPaths(call);
	const mcp = geminiMcpCall(call);
	if (mcp) {
		return { kind: 'mcp', name: mcp.server ? `${mcp.server} · ${mcp.tool}` : mcp.tool };
	}
	switch (call.kind) {
		case 'execute':
			// `[current working directory …] (what it is for)`: the description is the summary.
			return { kind: 'command', name: 'Terminal', detail: /\(([^()]*)\)\s*$/.exec(geminiText(call))?.[1] || undefined, input: title || undefined };
		case 'read':
			return { kind: 'read', name: 'Read', detail: paths[0] ?? (title || undefined) };
		case 'edit':
		case 'delete':
		case 'move':
			return { kind: 'edit', name: 'Edit', detail: paths.length === 1 ? paths[0] : paths.length ? `${paths.length} files` : title || undefined, ...geminiDiff(call) };
		case 'search':
			return { kind: 'search', name: 'Search', detail: title ? oneLine(title) : undefined };
		case 'fetch':
			return { kind: 'web', name: 'Fetch', detail: title ? oneLine(title) : undefined };
		default:
			return { kind: 'other', name: title ? oneLine(title, 80) : 'Tool' };
	}
}

/**
 * One `session/update` of Gemini CLI. Its text is streamed as
 * `agent_message_chunk`, its thoughts as `agent_thought_chunk` (a whole
 * thought at a time, `**Subject**\nbody`), a tool as `tool_call` then
 * `tool_call_update`, and the context's fill as `usage_update { used, size }`
 * after each request. A command's output is not sent (measured: a
 * `run_shell_command` completes with empty `content`), so a command row shows
 * its command alone. `user_message_chunk` is the history `session/load` replays,
 * which the chat already has.
 */
export function geminiEvents(update: unknown): AgentEvent[] {
	const u = isRecord(update) ? update : {};
	switch (u.sessionUpdate) {
		case 'agent_message_chunk':
			return isRecord(u.content) && u.content.type === 'text' && typeof u.content.text === 'string' && u.content.text
				? [{ type: 'text', text: u.content.text }]
				: [];
		case 'agent_thought_chunk':
			return isRecord(u.content) && u.content.type === 'text' && typeof u.content.text === 'string' && u.content.text.trim()
				? [{ type: 'thinking', text: `${u.content.text.trim()}\n\n` }]
				: [];
		case 'tool_call': {
			if (typeof u.toolCallId !== 'string') {
				return [];
			}
			const events: AgentEvent[] = [{ type: 'tool', id: u.toolCallId, tool: geminiTool(u) }];
			// A replayed call arrives finished.
			const done = geminiToolUpdate(u);
			return done.status ? [...events, { type: 'toolUpdate', id: u.toolCallId, update: done }] : events;
		}
		case 'tool_call_update':
			return typeof u.toolCallId === 'string' ? [{ type: 'toolUpdate', id: u.toolCallId, update: geminiToolUpdate(u) }] : [];
		case 'usage_update': {
			const used = typeof u.used === 'number' && u.used >= 0 ? u.used : undefined;
			const window = typeof u.size === 'number' && u.size > 0 ? u.size : undefined;
			return used !== undefined || window !== undefined ? [{ type: 'context', used, window }] : [];
		}
		default:
			return [];
	}
}

function geminiToolUpdate(u: Record<string, unknown>): ToolUpdate {
	const status = u.status === 'completed' ? 'done' as const : u.status === 'failed' ? 'failed' as const : undefined;
	const text = geminiText(u);
	// A command's text is its working directory and description, never its
	// output — except the reason it failed ("… was canceled by the user").
	const output = u.kind === 'execute' && status !== 'failed' ? undefined : text || undefined;
	const diff = u.kind === 'edit' || u.kind === 'delete' || u.kind === 'move' ? geminiDiff(u) : {};
	return {
		...(output !== undefined ? { output: clip(output) } : {}),
		...(status ? { status } : {}),
		...(diff.input !== undefined ? diff : {}),
	};
}

/**
 * The turn's end, from `session/prompt`'s answer: `stopReason` and `usage`
 * (`inputTokens` with the cached part inside it, `cachedReadTokens`,
 * `outputTokens`, `thoughtTokens`). The tokens are the turn's own; thinking
 * counts as output, as Claude Code's does.
 *
 * `_meta.quota.model_usage` names each model a request of the turn ran on (read
 * in 0.64's `acpSession.ts`, `buildPromptResponse`) — with Auto, the model it
 * chose, which nothing else reports. Passed on only when it is not simply
 * `chosen`, the model picked in the chat, so a turn on a named model adds nothing.
 */
export function geminiTurnEnd(result: unknown, chosen?: string): AgentEvent[] {
	const r = isRecord(result) ? result : {};
	const usage = isRecord(r.usage) ? r.usage : undefined;
	const quota = isRecord(r._meta) && isRecord(r._meta.quota) ? r._meta.quota : undefined;
	const used = [...new Set((Array.isArray(quota?.model_usage) ? quota.model_usage : [])
		.map(u => isRecord(u) && typeof u.model === 'string' ? oneLine(u.model, 80) : '')
		.filter(Boolean))].slice(0, 4);
	const models = used.length && used.some(m => m !== chosen) ? { models: used } : {};
	const events: AgentEvent[] = usage
		? [{ type: 'tokens', input: num(usage.inputTokens), output: num(usage.outputTokens) + num(usage.thoughtTokens), cached: num(usage.cachedReadTokens), cumulative: false, ...models }]
		: [];
	switch (r.stopReason) {
		case 'cancelled':
			events.push({ type: 'turnEnd', error: 'Stopped.' });
			break;
		// Read in 0.64's `acpSession.ts`: `max_tokens` is `ContextWindowWillOverflow`
		// — the next request would not fit the context window — not the output limit.
		case 'max_tokens':
			events.push({ type: 'turnEnd', error: 'The conversation no longer fits the model\'s context window, so Gemini CLI stopped the turn. Start a new chat.' });
			break;
		// Both `MaxSessionTurns` and `LoopDetected` end the turn this way.
		case 'max_turn_requests':
			events.push({ type: 'turnEnd', error: 'Gemini CLI stopped the turn: it reached its limit of model requests, or found the model repeating itself. Send the message again, rephrase it, or pick another model.' });
			break;
		case 'refusal':
			events.push({ type: 'turnEnd', error: 'The model refused to answer.' });
			break;
		default:
			events.push({ type: 'turnEnd' });
	}
	return events;
}

/** The command that opens `gemini` in a terminal, named in the advice below. */
const geminiTerminalCommand = '“Open Gemini CLI in Terminal” (the command palette, or the Gemini CLI menu on a browser tab)';

/**
 * A Gemini CLI error as the chat says it: what happened, in Gemini's words,
 * and what to do. `code` is the JSON-RPC error's: Gemini answers a failed turn
 * with the HTTP status of the model request (429, 403, 404, 500 — read in its
 * `acpSession.ts`, and measured: an unknown model is `500 "models/… is not
 * found"`), and its own refusals with -32000 (credentials) or -32603, whose
 * real text is in `data.details` — the message is only "Internal error".
 */
export function geminiErrorText(code: number | undefined, message: string, details?: string): string {
	// Inside parentheses below, so without its own closing full stop.
	const said = ((details && details.trim()) || message.trim() || 'Gemini CLI refused the request').replace(/\.$/, '');
	if (code === -32000) {
		return `Gemini CLI is not signed in, or its credentials were refused (${said}). Sign in with ${geminiTerminalCommand}, then send the message again.`;
	}
	// Gemini CLI's own test for a quota that waiting does not fix (`TerminalQuotaError`
	// in 0.64; Gemini Code Assist reads the same words). Over ACP it survives only
	// as a 499 or 503 — a 429 is rewritten to "Rate limit exceeded" whatever it was.
	if (/exhausted your capacity|capacity exceeded|MODEL_CAPACITY_EXHAUSTED|quota will reset/i.test(said)) {
		const reset = /reset after ([^.()]{1,60})/i.exec(said)?.[1]?.trim();
		return `The quota for this Gemini model is used up${reset ? ` until it resets after ${reset}` : ' for now'} (${said}). Pick another model and send the message again.`;
	}
	if (code === 429 || /rate limit|quota|resource.?exhausted/i.test(said)) {
		// Gemini CLI sends every 429 as this one sentence, so it may be the day's quota as well as a short limit.
		return `Gemini's rate limit or quota is used up (${said}). Wait a little and send the message again; if it keeps failing, the day's quota for this model may be spent — pick another model.`;
	}
	if (code === 404 || /not found|not supported for generateContent/i.test(said)) {
		return `This model is not available to your Gemini account (${said}). Pick another model and send the message again.`;
	}
	if (code === 401 || code === 403) {
		return `Gemini refused the request (${said}). The account or API key may not have access to this model: pick another, or sign in again with ${geminiTerminalCommand}.`;
	}
	if (code === 400) {
		return `Gemini refused the request as invalid (${said}).`;
	}
	if (code !== undefined && code >= 500 && code < 600) {
		return `Gemini's service failed (${said}). Send the message again in a moment; if it keeps failing, pick another model.`;
	}
	return said;
}

/**
 * Why a `gemini` process could not start or ended, in words that say what to
 * do. `reason` is `JsonLineProcess`'s: the exit and the last lines of stderr.
 */
export function geminiExitText(reason: string, starting: boolean): string {
	reason = reason.trim().replace(/\.$/, '');
	if (/env: .?node.?: No such file|node: (command )?not found/i.test(reason)) {
		return `Gemini CLI needs Node.js 20 or later, and none was found next to it or on PATH (${reason}). Install Node.js, or set aiBrowser.chat.geminiPath to a copy that can run.`;
	}
	if (/ENOENT|EACCES/.test(reason)) {
		return `Gemini CLI could not be started (${reason}). Refresh the agents, or set aiBrowser.chat.geminiPath.`;
	}
	// Gemini CLI's fatal exit codes (`FatalError` subclasses in 0.64's core).
	switch (/exited with code (\d+)/.exec(reason)?.[1]) {
		case '41':
			return `Gemini CLI is not signed in, or its credentials were refused (${reason}). Sign in with ${geminiTerminalCommand}, then send the message again.`;
		case '52':
			return `Gemini CLI could not read its settings (${reason}). Fix the settings file it names — run ${geminiTerminalCommand} to see it — then send the message again.`;
		case '55':
			return `Gemini CLI refused to run in a folder it does not trust (${reason}). Trust it in Gemini CLI (${geminiTerminalCommand}) — or, for a repository the chat fetched, with “Trust this repository's settings…” under the folder button — then send the message again.`;
	}
	return starting
		? `Gemini CLI could not start (${reason}). If its settings are malformed it says so there: run ${geminiTerminalCommand} to see.`
		: `Gemini CLI stopped (${reason}). The next message starts it again and resumes this conversation.`;
}

/**
 * Gemini CLI's `session/request_permission`: `{ toolCall, options }`, the tool
 * call shaped as its `tool_call` update was. Sorted into the approval menu's
 * categories the way Claude Code's and Codex's are: a command by its `kind`,
 * an MCP tool by its kind and call id, never its title alone (`geminiMcpCall`), a file by
 * whether every path it names is inside the project.
 */
export function geminiApproval(id: string, params: Record<string, unknown>, root: string | undefined): ApprovalRequest {
	const call = isRecord(params.toolCall) ? params.toolCall : {};
	const title = typeof call.title === 'string' ? call.title : '';
	const text = geminiText(call);
	const mcp = geminiMcpCall(call);
	if (mcp) {
		// The arguments, as the title spells them, when the title is not just the tool's name.
		const args = title && !geminiMcpTitle(title) && title !== mcp.tool ? { detail: whole(title) } : {};
		return !mcp.server
			? { id, what: 'other', title: oneLine(mcp.tool, 200), ...args }
			: isBrowserServer(mcp.server)
				? ourToolApproval(id, mcp.tool, geminiToolArguments(title, mcp.tool), args.detail)
				: { id, what: 'mcp', server: mcp.server, title: mcp.tool, ...args };
	}
	const paths = geminiPaths(call);
	const outside = paths.some(file => outsideProject(root, file));
	switch (call.kind) {
		case 'execute':
			return { id, what: 'command', title: whole(title) || 'Command', detail: text ? whole(text) : undefined };
		case 'fetch':
			return { id, what: 'web', title: whole(title) || 'Fetch', detail: text ? whole(text) : undefined };
		case 'edit':
		case 'delete':
		case 'move':
			// Nothing named is nothing "inside" can be promised for.
			return { id, what: outside || !paths.length ? 'outside' : 'edit', title: paths.length ? paths.join('\n') : whole(title) || 'Edit', detail: title ? whole(title) : undefined };
		default:
			if (outside) {
				return { id, what: 'outside', title: paths.join('\n'), detail: title ? whole(title) : undefined };
			}
			return { id, what: 'other', title: title ? oneLine(title, 200) : 'Tool', detail: text ? whole(text) : undefined };
	}
}

/**
 * The answer to a permission request: the option it offered for allowing once
 * (`proceed_once`), or for rejecting (`cancel`). Never an "always" option —
 * the approval menu keeps that choice — and, with no fitting option, the
 * request's own `cancelled` outcome. Gemini has no "deny and go on": a reject
 * is reported to the model as the tool cancelled by the user, and the turn
 * goes on (measured).
 */
export function geminiApprovalAnswer(params: Record<string, unknown>, allow: boolean): Record<string, unknown> {
	const options = Array.isArray(params.options) ? params.options.filter(isRecord) : [];
	const pick = allow
		? options.find(o => o.optionId === 'proceed_once') ?? options.find(o => o.kind === 'allow_once')
		: options.find(o => o.kind === 'reject_once') ?? options.find(o => o.optionId === 'cancel') ?? options.find(o => o.kind === 'reject_always');
	return typeof pick?.optionId === 'string'
		? { outcome: { outcome: 'selected', optionId: pick.optionId } }
		: { outcome: { outcome: 'cancelled' } };
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
