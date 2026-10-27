/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The pure pieces of the chat's terminal tabs: how many, what they are called,
 * where they start, what the editor's settings say, and how a terminal's text
 * becomes context for a conversation. A leaf: no `vscode`, no relative value
 * import, so `npm test` loads it directly.
 */

import type { TerminalSettings } from './chatProtocol';

export const defaultTerminalLimit = 8;
export const maxTerminalLimit = 20;

/** `aiBrowser.chat.terminalLimit` as a whole number in range; anything else is the default (#184's rule). */
export function clampTerminalLimit(value: unknown): number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 1
		? Math.min(value, maxTerminalLimit)
		: defaultTerminalLimit;
}

/**
 * The smallest unused name: `Terminal 1`, `Terminal 2`, … — a closed one's
 * number comes back into use. With `bare` the first is the base alone
 * (`Claude Code`, then `Claude Code 2`).
 */
export function nextTerminalName(names: readonly string[], base: string, bare = false): string {
	const taken = new Set(names);
	for (let n = 1; ; n++) {
		const name = bare && n === 1 ? base : `${base} ${n}`;
		if (!taken.has(name)) { return name; }
	}
}

/** The longest name a user can give a terminal tab; a label, not a sentence. */
export const terminalNameLimit = 80;

/** A rename as the tab's name: one line, trimmed, cut by code point; empty is no rename. */
export function terminalName(raw: unknown): string {
	if (typeof raw !== 'string') { return ''; }
	const clean = raw.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
	return Array.from(clean).slice(0, terminalNameLimit).join('');
}

/** The first folder that is one, in the order given; `undefined` when none is. */
export function chooseTerminalCwd(candidates: readonly (string | undefined)[], isDirectory: (folder: string) => boolean): string | undefined {
	return candidates.find((folder): folder is string => !!folder && isDirectory(folder));
}

const fontFamilyItem = String.raw`(?:"[^"\\;{}<>@/*()\x00-\x1f\x7f]*"|'[^'\\;{}<>@/*()\x00-\x1f\x7f]*'|[\p{L}\p{N}_.-]+(?: [\p{L}\p{N}_.-]+)*)`;
const fontFamilyList = new RegExp(String.raw`^${fontFamilyItem}(?:\s*,\s*${fontFamilyItem})*$`, 'u');

/**
 * A font-family value that is safe to hand to xterm, which writes it unescaped into a
 * `<style>` element's text (and the chat page lets such a style through its CSP): a
 * comma-separated list of plain family names (letters, digits, `_`, `-`, `.`, single spaces)
 * or quoted names with no quote, backslash, `;`, braces, `<`, `>`, `@`, `/`, `*`, parentheses
 * or control character inside. Anything else is `undefined`, so the view keeps its default
 * rather than drawing a page-wide rule a workspace chose (#0 of the terminal review).
 *
 * **Written twice**: `preview-src/terminalTheme.ts` applies the same rule to the host's value
 * and to `--vscode-editor-font-family`, because the two builds cannot share code. Change
 * both, and the two tests that pin the accepted and refused lists.
 */
export function safeFontFamily(value: unknown): string | undefined {
	if (typeof value !== 'string') { return undefined; }
	const family = value.trim();
	if (!family || family.length > 500) { return undefined; }
	return fontFamilyList.test(family) ? family : undefined;
}

/**
 * The most of the clipboard `_pasteIntoTerminal` accepts. Chosen under `terminalInputLimit`
 * (`terminalTab.ts`, 1 000 000 units per `terminalInput` message) with room for the
 * bracketed-paste markers, so that anything accepted is fully writable even if it arrives as a
 * single message; the view also splits a large paste into slices of at most
 * `terminalInputSlice` units, which is what keeps one message small. A larger clipboard is
 * refused with a message, never accepted and then dropped (#3 of the terminal review).
 */
export const terminalPasteLimit = 990_000;

/** The most the view puts in one `terminalInput` message; written twice (`terminalFlow.ts` / the view's own constant). */
export const terminalInputSlice = 64 * 1024;

/**
 * Pasted text made safe to hand to a shell that has bracketed paste on. A paste is wrapped in
 * ESC[200~ … ESC[201~, and a clipboard holding its own ESC[201~ ends the bracket early, so the
 * rest runs as typed input (pastejacking). Every C0 control except tab, carriage return and
 * line feed goes — ESC above all — and DEL and the C1 range (0x80-0x9f, where 0x9b is a
 * one-unit CSI). With no ESC and no C1 left, no marker can remain, and removing characters
 * cannot make one, but the loop checks anyway rather than relying on that argument.
 */
export function sanitizePaste(text: string): string {
	const controls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
	let clean = text.replace(controls, '');
	for (let before = ''; before !== clean;) {
		before = clean;
		clean = clean.replace(controls, '').replace(/\x1b\[20[01]~/g, '');
	}
	return clean;
}

/**
 * `terminal.integrated.*`, as far as the view's xterm can use it. `get` answers
 * a key under `terminal.integrated.` (or `editor.fontFamily` for the font that
 * the terminal falls back on). A value out of range is left out: the view then
 * keeps its own default rather than drawing a 3-pixel font.
 */
export function readTerminalSettings(get: (key: string) => unknown): TerminalSettings {
	const number = (key: string, min: number, max: number): number | undefined => {
		const value = get(key);
		return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
	};
	// Workspace-settable and written into a style element by xterm: only a plain list of names passes.
	const fontFamily = safeFontFamily(get('terminal.integrated.fontFamily')) ?? safeFontFamily(get('editor.fontFamily'));
	const style = get('terminal.integrated.cursorStyle');
	const fontSize = number('terminal.integrated.fontSize', 6, 100);
	const lineHeight = number('terminal.integrated.lineHeight', 1, 3);
	const letterSpacing = number('terminal.integrated.letterSpacing', -5, 50);
	const scrollback = number('terminal.integrated.scrollback', 0, 100_000);
	const blink = get('terminal.integrated.cursorBlinking');
	const meta = get('terminal.integrated.macOptionIsMeta');
	return {
		...(fontFamily ? { fontFamily } : {}),
		...(fontSize !== undefined ? { fontSize } : {}),
		...(lineHeight !== undefined ? { lineHeight } : {}),
		...(letterSpacing !== undefined ? { letterSpacing } : {}),
		...(style === 'block' || style === 'underline' || style === 'line' ? { cursorStyle: style } : {}),
		...(typeof blink === 'boolean' ? { cursorBlink: blink } : {}),
		...(scrollback !== undefined ? { scrollback: Math.floor(scrollback) } : {}),
		...(typeof meta === 'boolean' ? { macOptionIsMeta: meta } : {}),
	};
}

/** The settings keys `readTerminalSettings` asks for, for the change watcher. */
export const terminalSettingKeys = [
	'terminal.integrated.fontFamily', 'terminal.integrated.fontSize', 'terminal.integrated.lineHeight',
	'terminal.integrated.letterSpacing', 'terminal.integrated.cursorStyle', 'terminal.integrated.cursorBlinking',
	'terminal.integrated.scrollback', 'terminal.integrated.macOptionIsMeta', 'editor.fontFamily',
] as const;

/**
 * Whether a panel whose last conversation was moved away is closed with it. Terminals are not
 * conversation tabs, but closing the panel disposes its provider and ends every shell in it, so
 * a panel that still owns one stays, with a fresh conversation (what `_removeTab` does). A
 * sidebar is never closed (#8 of the terminal review).
 */
export function closesEmptyPanel(conversations: number, terminals: number, isPanel: boolean): boolean {
	return conversations === 0 && terminals === 0 && isPanel;
}

/**
 * A setting's value as the user's own settings and the defaults give it — a workspace's
 * (`workspaceValue`, `workspaceFolderValue`) is ignored. For the shell profile settings: they
 * name a program and its arguments, so a repository's `.vscode/settings.json` that could set
 * them would be code execution on "New terminal" (#2 of the terminal review). VS Code's own
 * terminal honours them only in a trusted workspace; here they are ignored always, the
 * precedent being `aiBrowser.chat.claudePath` / `codexPath`, which are `application`-scoped for
 * the same reason (the terminal's profile keys are not ours to scope). Two plain objects (the
 * `profiles` map) are merged per key, user over default, as VS Code merges object settings;
 * a `null` entry of the user's removes the default one downstream, in `resolveShell`.
 */
export function userScopedSetting(inspected: { readonly defaultValue?: unknown; readonly globalValue?: unknown } | undefined): unknown {
	if (!inspected) { return undefined; }
	const { defaultValue, globalValue } = inspected;
	const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
	if (globalValue === undefined) { return defaultValue; }
	return plain(defaultValue) && plain(globalValue) ? { ...defaultValue, ...globalValue } : globalValue;
}

/** The platform's suffix in VS Code's `terminal.integrated.defaultProfile.*` and `.profiles.*`. */
export function profilePlatform(platform: NodeJS.Platform): 'osx' | 'linux' | 'windows' {
	return platform === 'darwin' ? 'osx' : platform === 'win32' ? 'windows' : 'linux';
}

/** The most of a terminal's text attached to a conversation; past it the newest lines are kept. */
export const terminalChatLimit = 200_000;

export interface TerminalChatText {
	/** What the chip shows: the lines carried. */
	readonly label: string;
	/** What the agent is given, framed as data. */
	readonly text: string;
	readonly lines: number;
	readonly cut: boolean;
}

/**
 * A terminal's selected text, or the last lines of its screen, as context for a
 * conversation. The text is a shell's output — a page's words, a log, a
 * command's error — so it is data: carried in a fence longer than any run of
 * backticks inside it (#176's rule), and cut at `terminalChatLimit` keeping the
 * newest lines, never half a surrogate pair. `undefined` when nothing is there.
 */
export function terminalChatText(raw: unknown, terminal: string, cwd: string): TerminalChatText | undefined {
	if (typeof raw !== 'string') { return undefined; }
	// Line ends as `\n`, trailing space off each line, blank lines at the end gone.
	let lines = raw.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').split('\n').map(line => line.replace(/[ \t]+$/, ''));
	while (lines.length && lines[lines.length - 1] === '') { lines.pop(); }
	while (lines.length && lines[0] === '') { lines.shift(); }
	if (!lines.length) { return undefined; }
	let cut = false;
	let text = lines.join('\n');
	if (text.length > terminalChatLimit) {
		cut = true;
		let start = text.length - terminalChatLimit;
		// Start after a line end where one is near, and never inside a surrogate pair.
		const newline = text.indexOf('\n', start);
		if (newline >= 0 && newline - start < 2_000) { start = newline + 1; }
		else if (/[\udc00-\udfff]/.test(text[start] ?? '')) { start += 1; }
		text = text.slice(start);
		lines = text.split('\n');
	}
	let longest = 2;
	for (const run of text.match(/`+/g) ?? []) { longest = Math.max(longest, run.length); }
	const fence = '`'.repeat(longest + 1);
	const header = `Output of the terminal ${JSON.stringify(terminal)} in ${JSON.stringify(cwd)}${cut ? ' (cut: only the newest lines are here)' : ''}:`;
	return {
		label: lines.length === 1 ? `${terminal} · 1 line` : `${terminal} · ${lines.length} lines`,
		text: `${header}\n${fence}text\n${text}\n${fence}`,
		lines: lines.length,
		cut,
	};
}
