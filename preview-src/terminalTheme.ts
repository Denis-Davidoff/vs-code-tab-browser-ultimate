/*
 * The terminal's colours and options, from what the webview is given.
 *
 * The webview receives every registered colour as `--vscode-<id>`, so the
 * editor's terminal theme (`terminal.ansiRed`, `terminalCursor.foreground`, …)
 * is available as CSS variables. `terminal.background` has no default and may be
 * absent, hence the fallbacks. Pure: `read` is `getComputedStyle(body).getPropertyValue`.
 */

import type { TerminalSettings } from '../src/chat/chatProtocol';

/** xterm's `ITheme`, the colours this view sets. */
export interface TerminalThemeColors {
	background?: string;
	foreground?: string;
	cursor?: string;
	cursorAccent?: string;
	selectionBackground?: string;
	selectionForeground?: string;
	selectionInactiveBackground?: string;
	black?: string; red?: string; green?: string; yellow?: string; blue?: string; magenta?: string; cyan?: string; white?: string;
	brightBlack?: string; brightRed?: string; brightGreen?: string; brightYellow?: string; brightBlue?: string; brightMagenta?: string; brightCyan?: string; brightWhite?: string;
}

const ansiNames = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'] as const;

function first(read: (variable: string) => string, ...variables: string[]): string | undefined {
	for (const variable of variables) {
		const value = read(variable).trim();
		if (value) { return value; }
	}
	return undefined;
}

/** A background with no transparency: xterm draws on it, and a see-through one shows the page behind. */
export function opaqueColor(color: string): string {
	const hex = /^#([0-9a-f]{3})[0-9a-f]$/i.exec(color) ?? /^#([0-9a-f]{6})[0-9a-f]{2}$/i.exec(color);
	if (hex) { return `#${hex[1]}`; }
	const rgba = /^rgba\(\s*([^,]+),\s*([^,]+),\s*([^,]+),[^)]*\)$/i.exec(color);
	return rgba ? `rgb(${rgba[1]}, ${rgba[2]}, ${rgba[3]})` : color;
}

export function terminalTheme(read: (variable: string) => string): TerminalThemeColors {
	const theme: TerminalThemeColors = {};
	const set = (key: keyof TerminalThemeColors, value: string | undefined) => { if (value) { theme[key] = value; } };
	const background = first(read, '--vscode-terminal-background', '--vscode-sideBar-background', '--vscode-editor-background');
	set('background', background && opaqueColor(background));
	set('foreground', first(read, '--vscode-terminal-foreground', '--vscode-editor-foreground', '--vscode-foreground'));
	set('cursor', first(read, '--vscode-terminalCursor-foreground', '--vscode-terminal-foreground', '--vscode-foreground'));
	set('cursorAccent', first(read, '--vscode-terminalCursor-background'));
	set('selectionBackground', first(read, '--vscode-terminal-selectionBackground', '--vscode-editor-selectionBackground'));
	set('selectionForeground', first(read, '--vscode-terminal-selectionForeground'));
	set('selectionInactiveBackground', first(read, '--vscode-terminal-inactiveSelectionBackground'));
	for (const name of ansiNames) {
		set(name.toLowerCase() as keyof TerminalThemeColors, first(read, `--vscode-terminal-ansi${name}`));
		set(`bright${name}` as keyof TerminalThemeColors, first(read, `--vscode-terminal-ansiBright${name}`));
	}
	return theme;
}

/** xterm's own option names and ranges. */
export interface TerminalOptions {
	readonly fontFamily: string;
	readonly fontSize: number;
	readonly lineHeight: number;
	readonly letterSpacing: number;
	readonly cursorStyle: 'block' | 'underline' | 'bar';
	readonly cursorBlink: boolean;
	readonly scrollback: number;
	readonly macOptionIsMeta: boolean;
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

const fontNameCharacter = /^[\p{L}\p{N} _.,+-]$/u;

/**
 * A `font-family` value that is safe to hand to xterm, or undefined. xterm's DOM
 * renderer writes the string unescaped into the text of a `<style>` element, and
 * `terminalCsp.ts` gives every such element the page's nonce, so a workspace's
 * `terminal.integrated.fontFamily` of `monospace; } .approval button { … } .x{`
 * would be CSS for the whole chat. Accepted: a comma-separated list of names,
 * each either bare (letters, digits, space, `_ . + -`) or quoted with `'` or `"`
 * around the same characters, and nothing else — no `; { } < > \ ( ) / : @ !`, no
 * control character, no unbalanced quote. Written twice: the host
 * (`readTerminalSettings`, `terminalLogic.ts`) applies the same rule before the
 * value leaves the extension host, and the view applies it again on what it
 * reads from its own page (the editor's font variable included).
 */
export function safeFontFamily(value: string | undefined): string | undefined {
	const text = value?.trim();
	if (!text || text.length > 500) { return undefined; }
	let quote: string | undefined;
	let named = false;
	for (const ch of text) {
		if (quote) {
			// Inside quotes the other quote character is just a character.
			if (ch === quote) { quote = undefined; } else if (ch !== '\'' && ch !== '"' && !fontNameCharacter.test(ch)) { return undefined; }
		} else if (ch === '\'' || ch === '"') {
			quote = ch;
		} else if (!fontNameCharacter.test(ch)) {
			return undefined;
		}
		if (ch !== ' ' && ch !== ',') { named = true; }
	}
	return quote === undefined && named ? text : undefined;
}

/**
 * The editor's `terminal.integrated.*` settings as xterm's options. An absent
 * font follows the editor's (`--vscode-editor-font-*`), a value out of range
 * is clamped and not refused: a setting the editor already accepted must not
 * leave a terminal that cannot be drawn.
 */
export function terminalOptions(settings: TerminalSettings, editorFont: { readonly family?: string; readonly size?: number } = {}): TerminalOptions {
	return {
		fontFamily: safeFontFamily(settings.fontFamily) ?? safeFontFamily(editorFont.family) ?? 'monospace',
		fontSize: Math.round(clamp(settings.fontSize, 6, 100, clamp(editorFont.size, 6, 100, 13))),
		lineHeight: clamp(settings.lineHeight, 1, 3, 1),
		letterSpacing: clamp(settings.letterSpacing, 0, 20, 0),
		cursorStyle: settings.cursorStyle === 'line' ? 'bar' : settings.cursorStyle === 'underline' ? 'underline' : 'block',
		cursorBlink: settings.cursorBlink === true,
		scrollback: Math.round(clamp(settings.scrollback, 0, 100000, 1000)),
		macOptionIsMeta: settings.macOptionIsMeta === true,
	};
}
