/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * OpenCode, driven over ACP (`opencode acp`): the readers. A leaf module — no
 * `vscode`, no relative value imports — so `npm test` loads it directly; what it
 * needs from `agentProtocol.ts` as values (`outsideProject`, the card of one of
 * our own tools) is handed in by the caller (`ApprovalHelpers`).
 *
 * Everything here was measured on OpenCode 2.1.1 (macOS arm64, 2026-10-27); the
 * samples in `opencodeProtocol.test.ts` are those answers. What differs from
 * Gemini CLI, the other ACP agent, and costs a reader each:
 *
 * - **Models, efforts and the mode are `configOptions`, not `models` / `modes`**,
 *   and a model is changed with `session/set_config_option` (there is no
 *   `session/set_model`). An `effort` option exists only for a model that has
 *   variants, and appears in the answer of the model change — its id is dynamic,
 *   so the options are re-read after every change.
 * - **Tool calls start empty.** `tool_call` has `rawInput: {}` and `title` equal
 *   to the tool's name; the real input comes with the first `tool_call_update`.
 *   `OpencodeUpdates` therefore holds a call back until it has something to show.
 * - **A command's output is sent** (unlike Gemini's), with the exit code in
 *   `rawOutput.metadata.exit`.
 * - **Every MCP call is one `execute` tool** ("code mode"): the model writes
 *   JavaScript, `tools["ai-browser"].browser_state()`, and the approval for it is
 *   a request for `execute` with that code. `opencodeCodeCalls` reads which tools
 *   the code calls, and refuses to call code anything else does (fail closed).
 * - **A rejected permission ends the whole turn** (`stopReason: cancelled`), where
 *   Gemini goes on. The chat must not show that as the user's Stop.
 * - **The token counts are the turn's and exclude the cache**: `totalTokens` is
 *   `inputTokens + cachedReadTokens + outputTokens + thoughtTokens`.
 */

import type { AgentEvent, ApprovalRequest, ToolStart, ToolUpdate } from './agentProtocol';
import type { ChatCommand, ChatModel } from './chatProtocol';

/* ---------------------------------------------------------------- helpers */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function oneLine(value: string, limit = 120): string {
	const line = value.replace(/\s+/g, ' ').trim();
	return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

const outputLimit = 20_000;
function clip(text: string): string {
	return text.length > outputLimit ? `${text.slice(0, outputLimit)}\n…` : text;
}

const approvalTextLimit = 100_000;
/** What a card shows must be what Allow runs: whole, with only a cut far past anything read, said in words. */
function whole(value: string): string {
	const text = value.replace(/\s+$/, '');
	return text.length > approvalTextLimit
		? `${text.slice(0, approvalTextLimit)}\n… ${text.length - approvalTextLimit} more characters not shown — deny it if you cannot see what it does.`
		: text;
}

/* ------------------------------------------------------- config options */

interface ConfigOption {
	readonly id: string;
	readonly category?: string;
	readonly currentValue?: string;
	readonly options: readonly { readonly value: string; readonly name: string; readonly description?: string }[];
}

/** The select options of a `session/new` / `set_config_option` answer (`{ configOptions: [...] }`). */
export function opencodeConfigOptions(answer: unknown): ConfigOption[] {
	const list = isRecord(answer) && Array.isArray(answer.configOptions) ? answer.configOptions : [];
	const out: ConfigOption[] = [];
	for (const o of list) {
		if (!isRecord(o) || typeof o.id !== 'string' || o.type !== 'select' || !Array.isArray(o.options)) {
			continue;
		}
		const options: ConfigOption['options'][number][] = [];
		for (const v of o.options) {
			if (isRecord(v) && typeof v.value === 'string' && v.value) {
				options.push({
					value: v.value,
					name: typeof v.name === 'string' && v.name.trim() ? oneLine(v.name, 80) : v.value,
					...(typeof v.description === 'string' && v.description.trim() ? { description: oneLine(v.description, 300) } : {}),
				});
			}
		}
		out.push({ id: o.id, ...(typeof o.category === 'string' ? { category: o.category } : {}), ...(typeof o.currentValue === 'string' ? { currentValue: o.currentValue } : {}), options });
	}
	return out;
}

/** The model option (`id: 'model'`), whose values are `<provider>/<model>`. */
export function opencodeModelOption(answer: unknown): ConfigOption | undefined {
	return opencodeConfigOptions(answer).find(o => o.id === 'model' || o.category === 'model');
}

/** The reasoning-effort option of the model now in use, which exists only for a model with variants; its id is the CLI's. */
export function opencodeEffortOption(answer: unknown): ConfigOption | undefined {
	return opencodeConfigOptions(answer).find(o => o.category === 'thought_level');
}

/** The model now in use, from any answer that carries the options. */
export function opencodeCurrentModel(answer: unknown): string | undefined {
	return opencodeModelOption(answer)?.currentValue;
}

/** The effort values worth offering: the option's own, without `default` (which is "leave it to the model"). */
export function opencodeEffortLevels(option: ConfigOption | undefined): string[] {
	return option ? option.options.map(o => o.value).filter(v => v !== 'default') : [];
}

/**
 * The models of a `session/new` answer. `efforts` are what a probe measured per
 * model (`id` → levels): the CLI reports them only for the model in use, so the
 * list on its own has none.
 */
export function opencodeModels(answer: unknown, efforts: ReadonlyMap<string, readonly string[]> = new Map()): ChatModel[] {
	const option = opencodeModelOption(answer);
	const out: ChatModel[] = [];
	for (const o of option?.options ?? []) {
		if (out.some(m => m.id === o.value)) {
			continue;
		}
		out.push({
			id: o.value, label: o.name, ...(o.description ? { description: o.description } : {}),
			efforts: [...(efforts.get(o.value) ?? [])], isDefault: o.value === option?.currentValue,
		});
	}
	if (out.length && !out.some(m => m.isDefault)) {
		out[0] = { ...out[0], isDefault: true };
	}
	return out;
}

/** The commands OpenCode lists (`available_commands_update`); `compact` is not offered — its turn was not measured. */
export function opencodeCommands(update: unknown): ChatCommand[] {
	const list = isRecord(update) && Array.isArray(update.availableCommands) ? update.availableCommands : [];
	const out: ChatCommand[] = [];
	for (const c of list) {
		if (!isRecord(c) || typeof c.name !== 'string') {
			continue;
		}
		const name = c.name.trim();
		if (!/^[a-z][\w:-]{0,60}$/i.test(name) || name === 'compact' || out.some(o => o.name === name)) {
			continue;
		}
		const description = typeof c.description === 'string' && c.description.trim() ? oneLine(c.description, 500) : undefined;
		out.push({ name, insert: `/${name}`, ...(description ? { description } : {}), group: 'builtin' });
	}
	return out;
}

/* ------------------------------------------------------ code-mode calls */

export interface CodeCall {
	readonly server: string;
	readonly tool: string;
	/** The call's argument as JSON, when it is a plain JSON object literal. */
	readonly args?: Readonly<Record<string, unknown>>;
}

/**
 * Identifiers that let a script reach beyond the `tools` object. Their presence
 * anywhere — a string included — makes the code unreadable: the cheap direction.
 */
const escapes = /\b(?:fetch|require|import|eval|Function|process|globalThis|window|self|XMLHttpRequest|WebSocket|EventSource|Deno|Bun|constructor|__proto__|prototype|Reflect|Proxy|Worker|child_process)\b/;

const toolRef = /\btools\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(["'])([^"'\\\n]+)\2\s*\])\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(["'])([^"'\\\n]+)\5\s*\])\s*\(/g;

/** A `\u…` or `\x…` outside a string or template literal: an escaped identifier (`t\u006fols`, `\u0066etch`) that the name tests above cannot see. */
function hasIdentifierEscape(code: string): boolean {
	for (let i = 0; i < code.length; i++) {
		const ch = code[i];
		if (ch === '"' || ch === '\'' || ch === '`') {
			for (i++; i < code.length && code[i] !== ch; i++) {
				if (code[i] === '\\') {
					i++;
				}
			}
		} else if (ch === '\\') {
			return true;
		}
	}
	return false;
}

/** The balanced `( … )` text that opens at `open`, or undefined (strings and template literals are skipped over). */
function balanced(code: string, open: number): string | undefined {
	let depth = 0;
	for (let i = open; i < code.length; i++) {
		const ch = code[i];
		if (ch === '"' || ch === '\'' || ch === '`') {
			for (i++; i < code.length && code[i] !== ch; i++) {
				if (code[i] === '\\') {
					i++;
				}
			}
		} else if (ch === '(') {
			depth++;
		} else if (ch === ')' && --depth === 0) {
			return code.slice(open + 1, i);
		}
	}
	return undefined;
}

/**
 * Which tools a code-mode script calls — `tools.<server>.<tool>(…)` or
 * `tools["<server>"].<tool>(…)` — or `undefined` when the script does anything
 * else with `tools` or reaches for something that could act beyond it. **The
 * count of `tools` in the text must equal the count of calls found**, so an
 * alias (`const t = tools`), a computed name or a call through a variable is not
 * read; the caller then treats the script as running code, which it is.
 */
export function opencodeCodeCalls(code: string): CodeCall[] | undefined {
	if (escapes.test(code) || hasIdentifierEscape(code)) {
		return undefined;
	}
	const calls: CodeCall[] = [];
	for (const m of code.matchAll(toolRef)) {
		const server = m[1] ?? m[3];
		const tool = m[4] ?? m[6];
		const text = balanced(code, m.index + m[0].length - 1)?.trim();
		let args: Record<string, unknown> | undefined;
		if (text) {
			try {
				const parsed: unknown = JSON.parse(text);
				args = isRecord(parsed) ? parsed : undefined;
			} catch {
				args = undefined;
			}
		}
		calls.push({ server, tool, ...(args ? { args } : {}) });
	}
	const mentions = code.match(/\btools\b/g)?.length ?? 0;
	return calls.length && calls.length === mentions ? calls : undefined;
}

/** Our own server, as `mcpServers` names it (`ai-browser`) or a per-project name. */
function isBrowserServer(name: string): boolean {
	return name === 'ai-browser' || /^ai-browser-.+-[0-9a-f]{6}$/.test(name);
}

/* ---------------------------------------------------------------- tools */

function paths(call: Record<string, unknown>): string[] {
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

function text(call: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const item of Array.isArray(call.content) ? call.content : []) {
		if (isRecord(item) && item.type === 'content' && isRecord(item.content) && item.content.type === 'text' && typeof item.content.text === 'string') {
			parts.push(item.content.text);
		}
	}
	return parts.join('\n');
}

function rawInput(call: Record<string, unknown>): Record<string, unknown> {
	return isRecord(call.rawInput) ? call.rawInput : {};
}

/** A unified diff of `{ oldText, newText }` pairs (whole files or strings): shared lines at both ends left out, one hunk. */
function diffOf(items: readonly { path: string; oldText?: string | null; newText: string }[]): { input?: string; added?: number; removed?: number } {
	const diffs: string[] = [];
	let added = 0;
	let removed = 0;
	for (const item of items) {
		const before = item.oldText ? item.oldText.replace(/\r?\n$/, '').split(/\r?\n/) : [];
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
		diffs.push([
			`--- ${item.path}`, `+++ ${item.path}`,
			`@@ -${start + 1},${gone.length} +${start + 1},${come.length} @@`,
			...gone.map(line => `-${line}`), ...come.map(line => `+${line}`),
		].join('\n'));
	}
	return diffs.length ? { input: clip(diffs.join('\n')), added, removed } : {};
}

/** The diff of an edit: the `diff` items when the call carries them, else what its input says (`write`: content; `edit`: oldString → newString). */
function editDiff(call: Record<string, unknown>): { input?: string; added?: number; removed?: number } {
	const items: { path: string; oldText?: string | null; newText: string }[] = [];
	for (const item of Array.isArray(call.content) ? call.content : []) {
		if (isRecord(item) && item.type === 'diff' && typeof item.newText === 'string') {
			items.push({ path: typeof item.path === 'string' ? item.path : '', oldText: typeof item.oldText === 'string' ? item.oldText : null, newText: item.newText });
		}
	}
	if (items.length) {
		return diffOf(items);
	}
	const input = rawInput(call);
	const file = typeof input.path === 'string' ? input.path : typeof input.filePath === 'string' ? input.filePath : paths(call)[0] ?? '';
	if (typeof input.oldString === 'string' && typeof input.newString === 'string') {
		return diffOf([{ path: file, oldText: input.oldString, newText: input.newString }]);
	}
	if (typeof input.content === 'string') {
		return diffOf([{ path: file, oldText: null, newText: input.content }]);
	}
	return {};
}

/** Whether the call is OpenCode's code-mode `execute` tool, which every MCP call goes through. */
function isCodeMode(call: Record<string, unknown>): boolean {
	return call.name === 'execute' && (call.kind === undefined || call.kind === 'other') && typeof rawInput(call).code === 'string';
}

function toolRow(call: Record<string, unknown>): ToolStart {
	const input = rawInput(call);
	const title = typeof call.title === 'string' ? call.title : '';
	const file = paths(call)[0];
	if (isCodeMode(call)) {
		const code = String(input.code);
		const calls = opencodeCodeCalls(code);
		if (calls) {
			const first = `${calls[0].server} · ${calls[0].tool}`;
			return { kind: 'mcp', name: calls.length > 1 ? `${first} (+${calls.length - 1})` : first, input: clip(code) };
		}
		return { kind: 'command', name: 'Script', input: clip(code) };
	}
	switch (call.kind) {
		case 'execute': {
			const command = typeof input.command === 'string' ? input.command : title;
			return { kind: 'command', name: 'Terminal', detail: typeof input.description === 'string' && input.description ? oneLine(input.description) : undefined, input: command && command !== call.name ? command : undefined };
		}
		case 'read':
			return { kind: 'read', name: 'Read', detail: file ?? (title && title !== 'read' ? title : undefined) };
		case 'edit':
		case 'delete':
		case 'move':
			return { kind: 'edit', name: 'Edit', detail: file ?? (title || undefined), ...editDiff(call) };
		case 'search':
			return { kind: 'search', name: 'Search', detail: typeof input.pattern === 'string' ? oneLine(input.pattern) : title ? oneLine(title) : undefined };
		case 'fetch':
			return { kind: 'web', name: 'Fetch', detail: typeof input.url === 'string' ? oneLine(input.url) : title ? oneLine(title) : undefined };
		default:
			return { kind: 'other', name: typeof call.name === 'string' && call.name ? oneLine(call.name, 80) : title ? oneLine(title, 80) : 'Tool' };
	}
}

function toolUpdate(call: Record<string, unknown>): ToolUpdate {
	const status = call.status === 'completed' ? 'done' as const : call.status === 'failed' ? 'failed' as const : undefined;
	const body = text(call);
	const metadata = isRecord(call.rawOutput) && isRecord(call.rawOutput.metadata) ? call.rawOutput.metadata : undefined;
	const exit = typeof metadata?.exit === 'number' ? metadata.exit : undefined;
	const diff = call.kind === 'edit' || call.kind === 'delete' || call.kind === 'move' ? editDiff(call) : {};
	return {
		...(body ? { output: clip(body) } : {}),
		...(status ? { status } : {}),
		...(exit !== undefined ? { exitCode: exit } : {}),
		...(diff.input !== undefined ? diff : {}),
	};
}

/**
 * The stream of one OpenCode conversation as chat events. Stateful in one way
 * only: a `tool_call` arrives with an empty `rawInput`, so the row is held back
 * until an update brings the input (or the call ends), and a call's fields are
 * merged as its updates arrive. One instance per conversation.
 */
export class OpencodeUpdates {
	private readonly _calls = new Map<string, { merged: Record<string, unknown>; shown: boolean }>();
	private _retry: number | undefined;

	public events(update: unknown): AgentEvent[] {
		const u = isRecord(update) ? update : {};
		switch (u.sessionUpdate) {
			case 'agent_message_chunk':
				return isRecord(u.content) && u.content.type === 'text' && typeof u.content.text === 'string' && u.content.text
					? [{ type: 'text', text: u.content.text }]
					: [];
			case 'agent_thought_chunk':
				return isRecord(u.content) && u.content.type === 'text' && typeof u.content.text === 'string' && u.content.text.trim()
					? [{ type: 'thinking', text: u.content.text }]
					: [];
			case 'tool_call':
			case 'tool_call_update':
				return this._tool(u);
			case 'usage_update': {
				const used = typeof u.used === 'number' && u.used >= 0 ? u.used : undefined;
				const window = typeof u.size === 'number' && u.size > 0 ? u.size : undefined;
				return used !== undefined || window !== undefined ? [{ type: 'context', used, window }] : [];
			}
			case 'session_info_update':
				return this._info(u);
			default:
				return [];
		}
	}

	/** A turn's retry state is its own: a new turn starts counting again. */
	public turnStarted(): void {
		this._retry = undefined;
	}

	private _info(u: Record<string, unknown>): AgentEvent[] {
		const meta = isRecord(u._meta) ? u._meta : {};
		if (!('opencode/retry' in meta)) {
			return [];
		}
		const retry = meta['opencode/retry'];
		if (!isRecord(retry)) {
			return [];
		}
		const attempt = num(retry.attempt);
		if (attempt === this._retry) {
			return [];
		}
		this._retry = attempt;
		const error = isRecord(retry.error) ? retry.error : {};
		const why = typeof error.message === 'string' && error.message ? oneLine(error.message, 200) : 'the provider did not answer';
		return [{ type: 'notice', text: `OpenCode is retrying the model request (attempt ${attempt || 1}): ${why}. It keeps trying on its own for a minute or more — wait, or press Stop.` }];
	}

	private _tool(u: Record<string, unknown>): AgentEvent[] {
		const id = u.toolCallId;
		if (typeof id !== 'string') {
			return [];
		}
		const known = this._calls.get(id);
		const merged: Record<string, unknown> = { ...(known?.merged ?? {}) };
		for (const [key, value] of Object.entries(u)) {
			// An empty `rawInput` or `locations` on a later update never erases what an earlier one said.
			if (key === 'sessionUpdate' || value === undefined || (Array.isArray(value) && !value.length && merged[key] !== undefined)) {
				continue;
			}
			if (key === 'rawInput' && isRecord(value) && !Object.keys(value).length && merged[key] !== undefined) {
				continue;
			}
			merged[key] = value;
		}
		const entry = known ?? { merged, shown: false };
		entry.merged = merged;
		this._calls.set(id, entry);
		const done = merged.status === 'completed' || merged.status === 'failed';
		// A shell call's first `rawInput` is only its working directory (measured): not yet a command to show.
		const haveInput = Object.keys(rawInput(merged)).some(key => key !== 'cwd');
		const events: AgentEvent[] = [];
		if (!entry.shown) {
			if (!haveInput && !done) {
				return [];
			}
			entry.shown = true;
			events.push({ type: 'tool', id, tool: toolRow(merged) });
			const first = toolUpdate(merged);
			if (first.status || first.output) {
				events.push({ type: 'toolUpdate', id, update: first });
			}
		} else {
			const update = toolUpdate({ ...u, kind: merged.kind });
			// An edit's diff may arrive only at the end; a late input fills the IN row.
			if (update.output || update.status || update.input !== undefined || update.exitCode !== undefined) {
				events.push({ type: 'toolUpdate', id, update });
			}
		}
		if (done) {
			this._calls.delete(id);
		}
		return events;
	}
}

/* ----------------------------------------------------------------- turn */

export interface TurnContext {
	/** Our own Stop was sent for this turn. */
	readonly stopped?: boolean;
	/** The user answered Deny to a permission question during this turn. */
	readonly denied?: boolean;
}

/**
 * The turn's end, from `session/prompt`'s answer. The tokens are the turn's own,
 * and OpenCode's `inputTokens` excludes the cached part (`totalTokens` is the
 * four counts added), so the chat's "sent" is input plus cache; thinking counts
 * as output, as it does for Claude Code.
 */
export function opencodeTurnEnd(result: unknown, ctx: TurnContext = {}): AgentEvent[] {
	const r = isRecord(result) ? result : {};
	const usage = isRecord(r.usage) ? r.usage : undefined;
	const events: AgentEvent[] = usage
		? [{ type: 'tokens', input: num(usage.inputTokens) + num(usage.cachedReadTokens), output: num(usage.outputTokens) + num(usage.thoughtTokens), cached: num(usage.cachedReadTokens), cumulative: false }]
		: [];
	switch (r.stopReason) {
		case 'cancelled':
			if (ctx.stopped) {
				events.push({ type: 'turnEnd', error: 'Stopped.' });
			} else if (ctx.denied) {
				// OpenCode ends the whole turn when a permission is refused (measured); it is the
				// answer the user gave, not a Stop and not a failure.
				events.push({ type: 'notice', text: 'You denied a tool call. OpenCode ends the turn when one is refused — send a message to go on.' }, { type: 'turnEnd' });
			} else {
				events.push({ type: 'turnEnd', error: 'Stopped.' });
			}
			break;
		case 'max_tokens':
			events.push({ type: 'turnEnd', error: 'The conversation no longer fits the model\'s context window, so OpenCode stopped the turn. Start a new chat.' });
			break;
		case 'max_turn_requests':
			events.push({ type: 'turnEnd', error: 'OpenCode stopped the turn: it reached its limit of model requests. Send the message again, rephrase it, or pick another model.' });
			break;
		case 'refusal':
			events.push({ type: 'turnEnd', error: 'The model refused to answer.' });
			break;
		default:
			events.push({ type: 'turnEnd' });
	}
	return events;
}

/* -------------------------------------------------------------- failures */

const loginAdvice = 'run `opencode auth login` in a terminal (or `opencode acp --login`), then send the message again';

/**
 * A JSON-RPC failure of OpenCode as the chat says it. Measured: `-32000` is
 * `auth_required` (a provider that rejected its key: "Authentication required:
 * provider authentication required"); `-32602` is a model or session it does not
 * know; `-32603` carries the real text after `Internal error: ` and, for a
 * provider failure, `data.errorName` (`provider.rate-limit`).
 */
export function opencodeErrorText(code: number | undefined, message: string, errorName?: string): string {
	const said = oneLine(message.replace(/^(?:Internal error|Invalid params|Authentication required): ?/i, ''), 300) || 'no details';
	if (code === -32000 || /authentication required/i.test(message)) {
		return `OpenCode could not sign in to the model's provider (${said}). To fix it, ${loginAdvice}.`;
	}
	if (errorName === 'provider.rate-limit' || /rate.?limit|\b429\b/i.test(message)) {
		return `The model's provider is rate limiting OpenCode (${said}). OpenCode already retried on its own: wait a while and send again, or pick another model.`;
	}
	if (code === -32602 && /model not found/i.test(message)) {
		return `OpenCode does not know this model (${said}). Pick another model, or refresh the agents.`;
	}
	if (code === -32602 && /session not found/i.test(message)) {
		return `OpenCode no longer has this conversation (${said}).`;
	}
	if (errorName && /^provider\./.test(errorName)) {
		return `The model's provider failed (${errorName}: ${said}). Send the message again, or pick another model.`;
	}
	if (/already has an active/i.test(message)) {
		return 'OpenCode is still working on the previous message. Wait for it to end, or press Stop.';
	}
	return `OpenCode refused the request: ${said}.`;
}

/** Why an `opencode` process could not start or ended, in words that say what to do. */
export function opencodeExitText(reason: string, starting: boolean): string {
	const said = oneLine(reason, 300) || 'no details';
	if (/ENOENT|not found|no such file/i.test(reason)) {
		return `OpenCode could not be started (${said}). Install it (https://opencode.ai) or set aiBrowser.chat.opencodePath, then refresh the agents.`;
	}
	if (/EACCES|permission denied/i.test(reason)) {
		return `OpenCode could not be started (${said}): the file is not executable. Fix its permissions or set aiBrowser.chat.opencodePath.`;
	}
	if (/auth|login|credential|api key/i.test(reason)) {
		return `OpenCode is not signed in (${said}). To fix it, ${loginAdvice}.`;
	}
	return starting
		? `OpenCode could not start (${said}). If its configuration is malformed it says so there: run \`opencode\` in a terminal to see.`
		: `OpenCode stopped (${said}). The next message starts it again and resumes this conversation.`;
}

/* ------------------------------------------------------------- approvals */

/** What the caller hands in from `agentProtocol.ts`, which a leaf may not import. */
export interface ApprovalHelpers {
	/** `outsideProject(root, file)`. */
	readonly outsideProject: (root: string | undefined, file: string) => boolean;
	/** `openrouterApproval(id, tool, args, raw)`: the card of one of our own server's tools, classified by `ourToolClass`. */
	readonly ourToolCard: (id: string, tool: string, args: Readonly<Record<string, unknown>> | undefined, raw: string) => ApprovalRequest;
}

/** How dangerous a card is, for choosing among the calls of one script: the lowest rank is shown. */
function rank(card: ApprovalRequest): number {
	if (card.terminal && !card.terminal.read) {
		return 0;
	}
	if (card.what === 'chat') {
		return 1;
	}
	if (card.what === 'mcp' || card.what === 'other') {
		return 2;
	}
	return card.terminal ? 4 : 3;
}

/**
 * The card for a code-mode script. Every call it makes is classified as the
 * other agents' MCP calls are (our own server by `ourToolClass`, any other
 * server as its own row, OpenCode's built-ins as Other tools) and the card is
 * the most dangerous of them; the whole script is its detail. A script that does
 * anything else than call tools is a command — the Terminal category — whatever
 * it says it is for. The server-side one-shot grant of the terminal tools
 * remains the real gate for a `terminal_send` hidden in a script.
 */
function codeCard(id: string, code: string, helpers: ApprovalHelpers): ApprovalRequest {
	const calls = opencodeCodeCalls(code);
	if (!calls) {
		return { id, what: 'command', ask: 'Run this script?', title: 'Script', detail: whole(code) };
	}
	const cards = calls.map((call): ApprovalRequest => {
		if (call.server === 'opencode') {
			return { id, what: 'other', title: `opencode · ${call.tool}` };
		}
		return isBrowserServer(call.server)
			? helpers.ourToolCard(id, call.tool, call.args, whole(code))
			: { id, what: 'mcp', server: call.server, title: call.tool };
	});
	const worst = cards.reduce((a, b) => rank(b) < rank(a) ? b : a);
	const title = calls.length > 1 ? `${worst.title} (+${calls.length - 1} more calls)` : worst.title;
	return { ...worst, id, title, detail: calls.length > 1 || worst.detail === undefined ? whole(code) : worst.detail };
}

/**
 * OpenCode's `session/request_permission`: `{ toolCall, options }`, the tool call
 * shaped as its `tool_call` update, with a `diff` item for an edit. Sorted like
 * the other agents' questions: a command by its `kind`, an MCP call by reading
 * its script, a file by whether every path is inside the project.
 */
export function opencodeApproval(id: string, params: Record<string, unknown>, root: string | undefined, helpers: ApprovalHelpers): ApprovalRequest {
	const call = isRecord(params.toolCall) ? params.toolCall : {};
	const title = typeof call.title === 'string' ? call.title : '';
	const input = rawInput(call);
	if (isCodeMode(call)) {
		return codeCard(id, String(input.code), helpers);
	}
	const where = paths(call);
	const outside = where.some(file => helpers.outsideProject(root, file));
	switch (call.kind) {
		case 'execute': {
			const command = typeof input.command === 'string' ? input.command : title;
			return { id, what: 'command', title: whole(command) || 'Command', detail: typeof input.description === 'string' && input.description ? whole(input.description) : undefined };
		}
		case 'fetch':
			return { id, what: 'web', title: whole(typeof input.url === 'string' ? input.url : title) || 'Fetch' };
		case 'edit':
		case 'delete':
		case 'move':
			return { id, what: outside || !where.length ? 'outside' : 'edit', title: where.length ? where.join('\n') : whole(title) || 'Edit', detail: title ? whole(title) : undefined };
		default:
			if (outside) {
				return { id, what: 'outside', title: where.join('\n'), detail: title ? whole(title) : undefined };
			}
			return { id, what: 'other', title: oneLine(typeof call.name === 'string' && call.name ? call.name : title || 'Tool', 200), detail: title && title !== call.name ? whole(title) : undefined };
	}
}

/**
 * The answer to a permission request: its `allow_once` option (`once`) or
 * `reject_once` (`reject`). Never an "always" option — the approval menu keeps
 * that choice — and, with no fitting option, the request's own `cancelled`
 * outcome. Either refusal ends the turn (measured).
 */
export function opencodeApprovalAnswer(params: Record<string, unknown>, allow: boolean): Record<string, unknown> {
	const options = Array.isArray(params.options) ? params.options.filter(isRecord) : [];
	const pick = allow
		? options.find(o => o.kind === 'allow_once') ?? options.find(o => o.optionId === 'once')
		: options.find(o => o.kind === 'reject_once') ?? options.find(o => o.optionId === 'reject');
	return typeof pick?.optionId === 'string'
		? { outcome: { outcome: 'selected', optionId: pick.optionId } }
		: { outcome: { outcome: 'cancelled' } };
}

/**
 * The configuration handed to every `opencode acp` through `OPENCODE_CONFIG_CONTENT`:
 * everything asks, so the chat's approval menu is the one authority (the default
 * config runs shell and edits unasked — measured), except reading and searching
 * inside the project, which OpenCode itself still asks about for a path outside
 * it (`/etc/hosts` was asked, measured). The environment's config outranks a
 * project's and the user's `allow` rules (measured), which means a user's own
 * `deny` rule becomes a question too — the menu's Deny answers it.
 */
export const opencodePermissionConfig = JSON.stringify({ permission: {
	'*': 'ask',
	// Not a bare `allow`: that replaces OpenCode's own rule that asks before reading a `.env` file (measured on 2.1.1 with a
	// fake provider calling `read` on `.env`: bare `allow` read it with no question, this form asks).
	read: { '*': 'allow', '*.env': 'ask', '*.env.*': 'ask', '*.env.example': 'allow' },
	grep: 'allow', glob: 'allow', list: 'allow',
} });
