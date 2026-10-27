/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * "Insert into terminal": what the user picked from the terminal's Insert menu (a page address, an
 * element, a screenshot, a file, a selection, a video, a dropped or pasted file) turned into the
 * bytes written to the PTY. This is the USER typing through the UI, never an agent: no approval
 * card, and never an Enter — the terminal agent (Claude Code, Codex CLI) or the shell waits for the
 * user to send it.
 *
 * - Text items go in as text; a binary item as its absolute path (both CLIs take an image path).
 * - Every control character goes (`sanitize`, the paste rule of `terminalLogic.ts`, passed in so this
 *   stays a leaf): a page title or an element's markup must not be able to end a bracketed paste or
 *   type a key of its own.
 * - Wrapped in ESC[200~ … ESC[201~ only when the program asked for bracketed paste (DECSET 2004);
 *   otherwise line breaks would each submit a line, so a multi-line item becomes one line there.
 * - A path with spaces or quotes is single-quoted, as a shell and both CLIs read it.
 *
 * A leaf: no `vscode`, no relative value import, so `npm test` loads it directly.
 */

export type TerminalInsertKind = 'page' | 'element' | 'screenshot' | 'file' | 'selection' | 'video' | 'annotation';

export const terminalInsertKinds: readonly TerminalInsertKind[] = ['page', 'element', 'screenshot', 'file', 'selection', 'video', 'annotation'];

export function isTerminalInsertKind(value: unknown): value is TerminalInsertKind {
	return typeof value === 'string' && (terminalInsertKinds as readonly string[]).includes(value);
}

/** The most one insert writes; a larger item is refused rather than cut. */
export const terminalInsertLimit = 200_000;

/** What the host materialised: text, or files on disk to name by path. */
export type TerminalInsertItem =
	| { readonly text: string }
	| { readonly paths: readonly string[] };

/** A path as a shell reads it: bare when it holds only safe characters, single-quoted otherwise. */
export function quotePath(p: string): string {
	if (/^[\w@%+=:,./~-]+$/.test(p)) { return p; }
	return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * The bytes for the PTY, or `undefined` when nothing is left or it is too long. A trailing space after
 * paths, so the next thing the user types is a separate word; never a line break at the end.
 */
export function terminalInsertPayload(item: TerminalInsertItem, bracketed: boolean, sanitize: (text: string) => string): string | undefined {
	const isPaths = 'paths' in item;
	let body = sanitize(isPaths ? item.paths.map(quotePath).join(' ') : item.text);
	// Without bracketed paste every line break is Enter: fold the item onto one line.
	body = bracketed ? body.replace(/\r\n?/g, '\n').replace(/\n+$/, '') : body.replace(/\s*[\r\n]+\s*/g, ' ').trimEnd();
	if (isPaths && body) { body += ' '; }
	if (!body.trim() || body.length > terminalInsertLimit) { return undefined; }
	return bracketed ? `\x1b[200~${body}\x1b[201~` : body;
}
