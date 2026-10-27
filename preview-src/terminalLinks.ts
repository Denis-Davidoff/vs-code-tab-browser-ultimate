/*
 * URLs printed in a terminal, as xterm's link provider needs them.
 *
 * Pure on purpose (no DOM, no relative value imports, no enum or parameter
 * property: `npm test` runs it through Node's type stripping). Only http and
 * https are ever links: the text is whatever a program printed, a shell or an
 * agent's tool included, so a `file:` or `command:` address in it is never
 * made clickable. The host validates the address again (`openLink`) — this is
 * the view's half of one rule, written twice.
 */

export interface LinkSpan {
	/** Index of the first character in the text. */
	readonly start: number;
	/** Index after the last character. */
	readonly end: number;
	readonly url: string;
}

/** A longer logical line (wrapped rows joined) is not searched: a minified bundle printed on one line is not a list of links. */
export const maxLinkLine = 4000;
export const maxLinkLength = 2000;

const candidate = /https?:\/\/[^\s<>"'`\u0000-\u001f\u007f-\u009f]+/gi;

const closers: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };

/** Punctuation that ends a sentence rather than an address; a closing bracket only while it has no opener inside the address. */
function trimmedEnd(url: string): string {
	let out = url;
	while (out.length > 0) {
		const last = out[out.length - 1];
		if (/[.,;:!?*]/.test(last) || last === '\'' || last === '"') { out = out.slice(0, -1); continue; }
		const opener = closers[last];
		if (opener && out.split(last).length - 1 > out.split(opener).length - 1) { out = out.slice(0, -1); continue; }
		break;
	}
	return out;
}

/** An address that may be opened: http or https with a host, and no credentials. */
export function linkableUrl(text: string): string | undefined {
	if (text.length > maxLinkLength) { return undefined; }
	let url: URL;
	try { url = new URL(text); } catch { return undefined; }
	if (url.protocol !== 'http:' && url.protocol !== 'https:') { return undefined; }
	if (!url.hostname || url.username || url.password) { return undefined; }
	return url.href;
}

/** The links in `text`, in order. */
export function findLinks(text: string): LinkSpan[] {
	if (text.length > maxLinkLine) { return []; }
	const spans: LinkSpan[] = [];
	candidate.lastIndex = 0;
	for (let match = candidate.exec(text); match; match = candidate.exec(text)) {
		const raw = trimmedEnd(match[0]);
		const url = linkableUrl(raw);
		if (url) { spans.push({ start: match.index, end: match.index + raw.length, url: raw }); }
	}
	return spans;
}

export interface CellRange {
	/** 1-based, as xterm's `IBufferRange`. */
	readonly start: { readonly x: number; readonly y: number };
	readonly end: { readonly x: number; readonly y: number };
}

/**
 * The cells a span covers. `cells[i]` is the cell, counted from the first row of
 * the joined text and across rows (`row * cols + col`), where character `i` of the
 * text sits — characters and cells differ for double-width ones. `firstRow` is the
 * 1-based buffer row of the first row.
 */
export function spanToRange(span: LinkSpan, cells: readonly number[], cols: number, firstRow: number): CellRange | undefined {
	const first = cells[span.start];
	const last = cells[span.end - 1];
	if (first === undefined || last === undefined || cols < 1) { return undefined; }
	return {
		start: { x: (first % cols) + 1, y: firstRow + Math.floor(first / cols) },
		end: { x: (last % cols) + 1, y: firstRow + Math.floor(last / cols) },
	};
}

/** Whether a range touches the 1-based buffer row `y`. */
export function rangeCoversRow(range: CellRange, y: number): boolean {
	return range.start.y <= y && y <= range.end.y;
}
