/*
 * Touch geometry and per-device preferences of the terminal view.
 *
 * Pure on purpose (no DOM, no relative value imports, no enum or parameter
 * property: `npm test` runs it through Node's type stripping); `terminalTouchUi.ts`
 * and `terminalKeyBar.ts` read the DOM and call these.
 */

export interface Rect {
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
}

export interface Cell {
	readonly col: number;
	readonly row: number;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/**
 * The cell under a point of the screen: `rect` is the rendered screen
 * (`.xterm-screen`), a cell is a `cols`-th of its width and a `rows`-th of its
 * height. Clamped, so a finger just past the edge still names the edge cell.
 */
export function cellAt(rect: Rect, cols: number, rows: number, x: number, y: number): Cell {
	if (cols < 1 || rows < 1 || rect.width <= 0 || rect.height <= 0) { return { col: 0, row: 0 }; }
	const col = Math.floor(((x - rect.left) / rect.width) * cols);
	const row = Math.floor(((y - rect.top) / rect.height) * rows);
	return { col: clamp(col, 0, cols - 1), row: clamp(row, 0, rows - 1) };
}

// Kept at both ends of a word on top of the non-space run: none. Trimmed from its ends: quotes, brackets and sentence punctuation.
const leadingTrim = /^[("'`<[{]+/;
const closers: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{', '>': '<' };

/** Sentence punctuation and quotes off the end; a closing bracket only while it has no opener inside the word (`foo(bar)` stays whole). */
function trimTail(word: string): string {
	let out = word;
	while (out) {
		const last = out[out.length - 1];
		if (/["'`.,;:!?]/.test(last)) { out = out.slice(0, -1); continue; }
		const opener = closers[last];
		if (opener) {
			const opens = out.split(opener).length - 1;
			const closes = out.split(last).length - 1;
			if (closes > opens) { out = out.slice(0, -1); continue; }
		}
		break;
	}
	return out;
}

/**
 * The word at `col` of a line as `[start, length]`, or undefined on a space. A
 * word is a run of non-space characters — so a path, a URL or `--flag=value`
 * stays whole — minus the quotes, brackets and sentence punctuation around it.
 * Counted in characters: a line with double-width characters is shifted by their
 * second cells, which `translateToString` does not return.
 */
export function wordRange(line: string, col: number): readonly [number, number] | undefined {
	if (col < 0 || col >= line.length || /\s/.test(line[col])) { return undefined; }
	let start = col;
	let end = col;
	while (start > 0 && !/\s/.test(line[start - 1])) { start--; }
	while (end < line.length - 1 && !/\s/.test(line[end + 1])) { end++; }
	let word = line.slice(start, end + 1);
	const lead = leadingTrim.exec(word)?.[0].length ?? 0;
	word = word.slice(lead);
	start += lead;
	word = trimTail(word);
	// A touch on the trimmed punctuation next to a word still names that word.
	if (!word) { return undefined; }
	return [start, word.length];
}

export interface Selection {
	readonly col: number;
	readonly row: number;
	/** Cells, counted linearly across rows (xterm's `select(col, row, length)`). */
	readonly length: number;
}

/**
 * The selection between two touched cells, whichever is first, as `term.select`
 * takes it: the start cell in buffer coordinates (`viewportY` is the buffer row
 * at the top of the screen) and the length in cells across rows, both ends
 * included.
 */
export function selectionSpan(anchor: Cell, head: Cell, cols: number, viewportY: number): Selection {
	const forward = head.row > anchor.row || (head.row === anchor.row && head.col >= anchor.col);
	const start = forward ? anchor : head;
	const end = forward ? head : anchor;
	return {
		col: start.col,
		row: viewportY + start.row,
		length: (end.row - start.row) * cols + (end.col - start.col) + 1,
	};
}

/** A pinch: the font size scaled by how far the fingers moved apart, rounded and kept in range. */
export function pinchFontSize(base: number, startDistance: number, distance: number, min = 8, max = 28): number {
	if (!(startDistance > 0) || !(distance > 0)) { return clamp(Math.round(base), min, max); }
	return clamp(Math.round(base * (distance / startDistance)), min, max);
}

/**
 * A vertical drag as rows: how many whole cell heights it covered and what is left
 * to carry into the next move. Positive `dy` is a drag down.
 */
export function dragRows(dy: number, cellHeight: number, carry: number): { readonly rows: number; readonly carry: number } {
	if (!(cellHeight > 0)) { return { rows: 0, carry }; }
	const total = carry + dy;
	const rows = Math.trunc(total / cellHeight);
	return { rows, carry: total - rows * cellHeight };
}

export interface ViewportLike {
	readonly offsetLeft: number;
	readonly offsetTop: number;
	readonly width: number;
	readonly height: number;
}

export interface VisibleFrame {
	readonly top: number;
	readonly left: number;
	readonly width: number;
	readonly height: number;
}

/**
 * The part of the page the user can see while the soft keyboard is up, from
 * `window.visualViewport`. iOS Safari does not resize the layout viewport for the
 * keyboard; the page is laid over this frame instead (see `terminalKeyBar.ts`).
 */
export function visibleFrame(viewport: ViewportLike): VisibleFrame {
	return {
		top: Math.max(0, Math.round(viewport.offsetTop)),
		left: Math.max(0, Math.round(viewport.offsetLeft)),
		width: Math.max(0, Math.round(viewport.width)),
		height: Math.max(0, Math.round(viewport.height)),
	};
}

/* ------------------------------------------------------------------ per-device preferences */

export type KeyBarPref = 'auto' | 'on' | 'off';

export const keyBarStorageKey = 'aiBrowser.terminal.keyBar';
export const fontSizeStorageKey = 'aiBrowser.terminal.fontSize';
export const keyboardStorageKey = 'aiBrowser.terminal.keyboard';

export function parseKeyBarPref(raw: string | null | undefined): KeyBarPref {
	return raw === 'on' || raw === 'off' ? raw : 'auto';
}

/** The stored font size, or undefined: anything that is not a number in range is ignored, never clamped into a surprise. */
export function parseFontPref(raw: string | null | undefined, min = 8, max = 28): number | undefined {
	if (raw === null || raw === undefined || !/^\d{1,3}(\.\d+)?$/.test(raw)) { return undefined; }
	const value = Math.round(Number(raw));
	return value >= min && value <= max ? value : undefined;
}

/** Whether the soft keyboard is wanted: on unless the user hid it. */
export function parseKeyboardPref(raw: string | null | undefined): boolean {
	return raw !== 'hidden';
}

/**
 * Whether the key bar is shown. Width alone is never a reason: a narrow
 * desktop window has a physical keyboard. `auto` follows the primary pointer.
 */
export function keyBarVisible(pref: KeyBarPref, coarsePointer: boolean, canInput: boolean, terminalInFront: boolean): boolean {
	if (!canInput || !terminalInFront) { return false; }
	return pref === 'on' || (pref === 'auto' && coarsePointer);
}
