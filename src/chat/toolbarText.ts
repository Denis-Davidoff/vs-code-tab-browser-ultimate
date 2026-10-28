/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The chat's toolbar skills as text: what a stored or sent skill may look
 * like, the prompt with its parameters filled in, the agent's own way of
 * writing a skill, and the result markers of a clipboard run.
 *
 * A leaf module with no `vscode` and no relative value imports, so `npm test`
 * loads it directly (see "Recipe for the next feature" in CLAUDE.md).
 */

import type { ChatCommand, ToolbarColors, ToolbarNotify, ToolbarParam, ToolbarSkill, ToolbarStep } from './chatProtocol';

/**
 * As typed after `/` or `$`: lower case, no spaces, like a CLI's own skills
 * (`one-more-review`, `pdf:pdf`) — asked for.
 */
export const toolbarNameShape = /^[a-z0-9][a-z0-9:._-]{0,63}$/;

/** The colours a toolbar skill can take besides `#rrggbb`: the theme's chart colours, so every theme has them. */
export const toolbarColors = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
const hexColor = /^#[0-9a-f]{6}$/i;
const paramNameShape = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;
const iconShape = /^[a-z0-9-]{1,60}$/;

export const toolbarLimits = {
	skills: 30,
	prompt: 20_000,
	/** Prompts after the first: a chain is a few steps, not a script. */
	followUps: 9,
	check: 2_000,
	label: 40,
	tooltip: 200,
	params: 10,
	maxLength: 10_000,
	options: 30,
	option: 100,
	/** A notification's own text, before its placeholders are filled in. */
	notifyText: 500,
} as const;

/**
 * A skill as it may be stored, from whatever the view sent or `globalState`
 * held: trimmed, cut to the limits, and refused — with the reason — when it
 * cannot be run as it is. The host is the one that decides; the editor's own
 * checks are a convenience.
 */
export function validToolbarSkill(raw: unknown): ToolbarSkill | string {
	if (!isRecord(raw)) {
		return 'Not a skill.';
	}
	const id = typeof raw.id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(raw.id) ? raw.id : undefined;
	if (!id) {
		return 'The skill has no id.';
	}
	// Lower-cased rather than refused: a skill saved before names had to be
	// lower case is kept, under the name it can now be typed as.
	const name = typeof raw.name === 'string' ? raw.name.trim().toLowerCase() : '';
	if (!toolbarNameShape.test(name)) {
		return 'The name is a single word of lower-case letters, digits, "-", "_", ":" or ".", at most 64 characters — no spaces.';
	}
	const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
	if (!prompt) {
		return 'The prompt is empty.';
	}
	if (prompt.length > toolbarLimits.prompt) {
		return `The prompt is longer than ${toolbarLimits.prompt} characters.`;
	}
	const followUps: ToolbarStep[] = [];
	for (const item of Array.isArray(raw.followUps) ? raw.followUps : []) {
		const step = validStep(item, followUps.length + 2);
		if (typeof step === 'string') {
			return step;
		}
		if (step) {
			followUps.push(step);
		}
	}
	if (followUps.length > toolbarLimits.followUps) {
		return `A skill sends at most ${toolbarLimits.followUps + 1} prompts.`;
	}
	const result = raw.result === 'clipboard' || raw.result === 'silent' || raw.result === 'toast' ? raw.result : 'chat';
	const notify = validNotify(raw.notify);
	if (typeof notify === 'string') {
		return notify;
	}
	const agents = raw.agents === 'claude' || raw.agents === 'codex' || raw.agents === 'gemini' || raw.agents === 'openrouter' || raw.agents === 'opencode' || raw.agents === 'pi' ? raw.agents : 'all';
	const icon = typeof raw.icon === 'string' && iconShape.test(raw.icon) ? raw.icon : 'sparkle';
	const colors = validColors(raw.colors, raw.color);
	const label = text(raw.label, toolbarLimits.label);
	const tooltip = text(raw.tooltip, toolbarLimits.tooltip);
	const params: ToolbarParam[] = [];
	for (const p of Array.isArray(raw.params) ? raw.params : []) {
		const param = validParam(p);
		if (typeof param === 'string') {
			return param;
		}
		if (params.some(q => q.name === param.name)) {
			return `Two parameters are named "${param.name}".`;
		}
		params.push(param);
	}
	if (params.length > toolbarLimits.params) {
		return `A skill takes at most ${toolbarLimits.params} parameters.`;
	}
	return { id, name, prompt, followUps: followUps.length ? followUps : undefined, result, notify, agents, icon, label, tooltip, colors, params };
}

/** None, ours, or the user's own text — which may not be empty, or the notification would say nothing. */
function validNotify(raw: unknown): ToolbarNotify | string | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	if (raw.mode === 'auto') {
		return { mode: 'auto' };
	}
	if (raw.mode !== 'text') {
		return undefined;
	}
	const value = typeof raw.text === 'string' ? raw.text.trim() : '';
	if (!value) {
		return 'The notification text is empty.';
	}
	if (value.length > toolbarLimits.notifyText) {
		return `The notification text is longer than ${toolbarLimits.notifyText} characters.`;
	}
	return { mode: 'text', text: value };
}

/**
 * A notification's own text with its placeholders filled in: `{{skill}}`,
 * `{{status}}`, `{{message}}`, `{{result}}` and the skill's parameters, by
 * name. A placeholder naming none of them is left as written, as in a prompt.
 * The values are put in as they are — the caller makes the whole safe for a
 * notification (`plainInNotification`), since a result is a model's text.
 */
export function notificationText(template: string, values: Readonly<Record<string, string>>): string {
	return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g,
		(whole, name: string) => Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole);
}

/**
 * One prompt after the first: an empty one is dropped rather than refused (a
 * row the editor left blank). An empty check is no check.
 */
function validStep(raw: unknown, number: number): ToolbarStep | string | undefined {
	const from = isRecord(raw) ? raw : { prompt: raw };
	const prompt = typeof from.prompt === 'string' ? from.prompt.trim() : '';
	if (!prompt) {
		return undefined;
	}
	if (prompt.length > toolbarLimits.prompt) {
		return `Prompt ${number} is longer than ${toolbarLimits.prompt} characters.`;
	}
	const check = typeof from.check === 'string' ? from.check.trim() : '';
	if (check.length > toolbarLimits.check) {
		return `The check before prompt ${number} is longer than ${toolbarLimits.check} characters.`;
	}
	return check ? { prompt, check } : { prompt };
}

/** One colour, as the host keeps it: a theme colour by name or `#rrggbb`, nothing else reaching CSS. */
function validColor(value: unknown): string | undefined {
	return typeof value === 'string' && ((toolbarColors as readonly string[]).includes(value) || hexColor.test(value))
		? value.toLowerCase() : undefined;
}

/**
 * The label, border and icon colours. A skill saved when there was one colour
 * (`color`, which tinted the label and the icon) is read as those two.
 */
function validColors(raw: unknown, legacy: unknown): ToolbarColors | undefined {
	const from = isRecord(raw) ? raw : { text: legacy, icon: legacy };
	const colors = { text: validColor(from.text), border: validColor(from.border), icon: validColor(from.icon) };
	return colors.text || colors.border || colors.icon ? colors : undefined;
}

function validParam(raw: unknown): ToolbarParam | string {
	if (!isRecord(raw)) {
		return 'A parameter is malformed.';
	}
	const name = typeof raw.name === 'string' ? raw.name.trim() : '';
	if (!paramNameShape.test(name)) {
		return `"${name.slice(0, 40)}" is not a parameter name: a letter or "_", then letters, digits, "_" or "-", at most 32.`;
	}
	const type = raw.type === 'number' || raw.type === 'choice' ? raw.type : 'text';
	const maxLength = type === 'text' && typeof raw.maxLength === 'number' && Number.isInteger(raw.maxLength)
		&& raw.maxLength >= 1 && raw.maxLength <= toolbarLimits.maxLength ? raw.maxLength : undefined;
	const options = type === 'choice'
		? (Array.isArray(raw.options) ? raw.options : [])
			.filter((o): o is string => typeof o === 'string')
			.map(o => o.trim())
			.filter((o, i, all) => o !== '' && o.length <= toolbarLimits.option && all.indexOf(o) === i)
			.slice(0, toolbarLimits.options)
		: undefined;
	if (type === 'choice' && !options?.length) {
		return `The choice "${name}" lists no values.`;
	}
	const preset = text(raw.preset, maxLength ?? toolbarLimits.maxLength);
	if (preset !== undefined) {
		const problem = valueProblem({ name, type, maxLength, options }, preset);
		if (problem) {
			return `The preset of "${name}": ${problem}`;
		}
	}
	return { name, type, maxLength, preset, options };
}

/** Why a value does not fit its parameter, or undefined when it does. */
export function valueProblem(param: ToolbarParam, value: string): string | undefined {
	const v = value.trim();
	if (!v) {
		return 'a value is needed.';
	}
	if (param.type === 'number' && !/^-?\d+(\.\d+)?$/.test(v)) {
		return 'a number is needed.';
	}
	if (param.type === 'choice' && !param.options?.includes(v)) {
		return `one of ${(param.options ?? []).join(', ')}.`;
	}
	if (param.maxLength !== undefined && Array.from(v).length > param.maxLength) {
		return `at most ${param.maxLength} characters.`;
	}
	return undefined;
}

/** A step of a skill run, filled in: its prompt, and the check made before it, if any. */
export interface FilledStep {
	readonly text: string;
	readonly check?: string;
}

/**
 * Every step of the skill, the first and its follow-ups in order, with each
 * `{{param}}` in a prompt or a check replaced by its value — or the first
 * problem with a value. A placeholder naming no parameter is left as written.
 */
export function fillPrompt(skill: ToolbarSkill, values: Readonly<Record<string, unknown>>): { steps: FilledStep[] } | { error: string } {
	const filled: Record<string, string> = {};
	for (const param of skill.params) {
		const raw = values[param.name];
		const value = typeof raw === 'string' ? raw : '';
		const problem = valueProblem(param, value);
		if (problem) {
			return { error: `${param.name}: ${problem}` };
		}
		filled[param.name] = value.trim();
	}
	const fill = (text: string) => text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g,
		(whole, name: string) => Object.prototype.hasOwnProperty.call(filled, name) ? filled[name] : whole);
	return {
		steps: [{ text: fill(skill.prompt) }, ...(skill.followUps ?? []).map(step => step.check
			? { text: fill(step.prompt), check: fill(step.check) }
			: { text: fill(step.prompt) })],
	};
}

/**
 * The prompt with each skill it names written the way the agent it runs on
 * reads one — `/name` for Claude Code, `$name` for Codex — so a toolbar skill
 * offered to every agent works on either. Only a name that agent lists, as a
 * whole word at the start or after white space, is rewritten.
 */
export function adaptSigils(text: string, commands: readonly ChatCommand[]): string {
	const byName = new Map(commands.map(c => [c.name, c.insert]));
	return text.replace(/(^|\s)[/$]([^\s]+)/g, (whole, lead: string, token: string) => {
		const name = token.replace(/[.,;:!?)]+$/, '');
		const insert = byName.get(name);
		return insert ? `${lead}${insert}${token.slice(name.length)}` : whole;
	});
}

export const nextYes = '<<<NEXT:YES>>>';
export const nextNo = '<<<NEXT:NO>>>';

/**
 * A step's prompt when the step after it has a check: the agent is asked to
 * judge it once its work is done and to end with one of two marker lines,
 * which `nextDecision` reads. The check is the user's own words, filled with
 * the skill's parameters like the prompts.
 */
export function withNextDecision(prompt: string, check: string): string {
	return `${prompt}\n\nWhen you have finished the task above, check this: ${check}\nThen end your reply with a line of its own: ${nextYes} if the check passes, ${nextNo} if it does not. Write exactly one of the two, once, as the last line.`;
}

/**
 * The agent's answer to `withNextDecision`: the last marker line of the reply
 * — the last, as with the result markers, since a reply quoting the
 * instruction names both. Undefined when it wrote neither, which the caller
 * treats as "stop": going on was not asked for.
 */
export function nextDecision(reply: string): boolean | undefined {
	const lines = reply.split(/\r?\n/).map(line => line.trim().replace(/^[`*_]+|[`*_]+$/g, ''));
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i] === nextYes) {
			return true;
		}
		if (lines[i] === nextNo) {
			return false;
		}
	}
	return undefined;
}

/**
 * Whether the next step runs, once the one before it is over. Without a check,
 * always. With one, only when that step ended without an error — an
 * interrupted or failed step judged nothing — and the agent answered yes. The
 * reason is said when it does not.
 */
export function stepGate(check: string | undefined, error: string | undefined, reply: string): { go: true } | { go: false; why: string } {
	if (!check) {
		return { go: true };
	}
	if (error) {
		return { go: false, why: 'the step before it ended with an error, so the check was not made' };
	}
	const answer = nextDecision(reply);
	return answer === true ? { go: true }
		: answer === false ? { go: false, why: 'the check did not pass' }
			: { go: false, why: 'the agent did not say whether the check passed' };
}

export const resultStart = '<<<RESULT';
export const resultEnd = 'RESULT>>>';

/**
 * A clipboard run's prompt: the instruction before the prompt and again after
 * it. Once, at the end, it lost to the prompt's own wording — a skill named in
 * the prompt brings its own output format — and the model answered without
 * markers, so the whole reply, preamble and closing remarks included, went to
 * the clipboard. Markers rather than a code fence or JSON: a fence closes on
 * any code block inside the result, and JSON makes the model escape every
 * line break and quote of a multi-line text; the markers need neither.
 */
export function withResultMarkers(prompt: string, to: 'clipboard' | 'notification' = 'clipboard'): string {
	const where = to === 'clipboard'
		? { done: 'copied to the clipboard', kept: 'copied' }
		: { done: 'shown to the user in a short notification', kept: 'shown' };
	const rule = `put the final result, and nothing else, between a line ${resultStart} and a line ${resultEnd}, each marker on a line of its own. Everything between them is ${where.done} exactly as it stands, so do not wrap it in a code fence or add any comment inside; anything you say outside the markers is not ${where.kept}.`;
	return `This task runs in the background and its result is ${where.done}. When you are done, ${rule}\n\n${prompt}\n\nRemember: ${rule}`;
}

/** Where a clipboard result was found. */
export type ResultSource = 'markers' | 'fence';

/**
 * The part of a reply to copy: the text between the last pair of result
 * markers — the last, because a model quoting the instruction writes them
 * twice — without the line breaks that frame it and without a code fence
 * wrapping all of it; failing that, the last fenced code block of the reply,
 * which is where a model that ignored the markers usually puts the thing
 * asked for. Undefined when the reply has neither, and the caller copies it
 * whole.
 */
export function extractResult(reply: string): { text: string; source: ResultSource } | undefined {
	// A marker is a line of its own, as the prompt asks: a result that talks
	// about the markers — a commit message for this very feature did — names
	// them inside a sentence, and searching the text for them started the copy
	// there (#414). A pair written inline is still read when no line is one.
	const lines = reply.split(/\r?\n/);
	const endLine = lines.map(line => line.trim()).lastIndexOf(resultEnd);
	const startLine = endLine < 0 ? -1 : lines.slice(0, endLine).map(line => line.trim()).lastIndexOf(resultStart);
	if (startLine >= 0) {
		const inner = lines.slice(startLine + 1, endLine).join('\n');
		return { text: unwrapFence(inner) ?? inner, source: 'markers' };
	}
	const end = reply.lastIndexOf(resultEnd);
	const start = end < 0 ? -1 : reply.lastIndexOf(resultStart, end);
	if (start >= 0) {
		const inner = reply.slice(start + resultStart.length, end).replace(/^[ \t]*\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
		return { text: unwrapFence(inner) ?? inner, source: 'markers' };
	}
	const blocks = fencedBlocks(reply);
	const last = blocks[blocks.length - 1];
	return last !== undefined && last.trim() ? { text: last, source: 'fence' } : undefined;
}

/** The inside of `text` when all of it is one fenced block, else undefined. */
function unwrapFence(text: string): string | undefined {
	const trimmed = text.trim();
	const blocks = fencedBlocks(trimmed);
	if (blocks.length !== 1) {
		return undefined;
	}
	const lines = trimmed.split(/\r?\n/);
	const open = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0]);
	const close = lines[lines.length - 1].trim();
	return open && lines.length >= 2 && close[0] === open[1][0] && /^(`{3,}|~{3,})$/.test(close) && close.length >= open[1].length
		? blocks[0] : undefined;
}

/**
 * The contents of every fenced code block, in order: a line opening with
 * three or more backticks or tildes, closed by a line of at least as many of
 * the same character — so a shorter fence inside a longer one is content.
 * A block left open runs to the end, as Markdown reads it.
 */
function fencedBlocks(text: string): string[] {
	const out: string[] = [];
	let fence: string | undefined;
	let body: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (fence === undefined) {
			const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
			if (open && !(open[1][0] === '`' && line.slice(open[0].length).includes('`'))) {
				fence = open[1];
				body = [];
			}
			continue;
		}
		const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
		if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
			out.push(body.join('\n'));
			fence = undefined;
			continue;
		}
		body.push(line);
	}
	if (fence !== undefined) {
		out.push(body.join('\n'));
	}
	return out;
}

function text(value: unknown, limit: number): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.replace(/\s+/g, ' ').trim();
	return trimmed ? Array.from(trimmed).slice(0, limit).join('') : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
