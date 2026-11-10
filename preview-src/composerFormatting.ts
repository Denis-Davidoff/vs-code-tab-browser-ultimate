export interface ComposerListItem {
	readonly indent: string;
	readonly marker: string;
	readonly number?: number;
	/** `a.` / `A)` lists: `number` is the letter's place in the alphabet. */
	readonly alpha?: 'lower' | 'upper';
	readonly delimiter: string;
	readonly content: string;
	readonly prefixLength: number;
}

/** List markers require an explicit delimiter after a number or letter. */
export function composerListItem(line: string): ComposerListItem | undefined {
	const letter = /^([ \t]*)([a-zA-Z][.)])([ \t]+)(.*)$/.exec(line);
	if (letter) {
		const ch = letter[2][0];
		return { indent: letter[1], marker: letter[2], number: ch.toLowerCase().charCodeAt(0) - 96, alpha: ch === ch.toLowerCase() ? 'lower' : 'upper',
			delimiter: letter[2][1], content: letter[4], prefixLength: letter[1].length + letter[2].length + letter[3].length };
	}
	const match = /^([ \t]*)([-*+]|\d{1,6}[.)])([ \t]+|$)(.*)$/.exec(line);
	if (!match) { return undefined; }
	const ordered = /^\d/.test(match[2]);
	return { indent: match[1], marker: match[2], ...(ordered ? { number: parseInt(match[2], 10) } : {}),
		delimiter: ordered ? match[2].slice(-1) : '',
		content: match[4], prefixLength: match[1].length + match[2].length + match[3].length };
}

/**
 * An ordered list starts only at `1` or `a`/`A`: an item with a later number or
 * letter is a list item only when it continues a list of the same kind (number
 * or letter case, and delimiter) at the same indent above it. Blank lines and
 * deeper-nested items between are skipped. `above` is the lines before the
 * item's line, nearest last.
 */
export function composerListContinues(above: readonly string[], item: ComposerListItem): boolean {
	return continuesAt(above, above.length, item, new Map());
}

/**
 * `composerListContinues` for every line of one text, sharing what it learns: `continues(index, item)`
 * answers for the item on `lines[index]`. Asked line by line, as a sent prompt is drawn, a flat list
 * costs one look back per line; the plain function would walk back to item 1 from every line, copying
 * the lines above at each step, which made a 3 000-item list take seconds on every redraw.
 */
export function composerListChecker(lines: readonly string[]): (index: number, item: ComposerListItem) => boolean {
	const memo = new Map<number, boolean>();
	return (index, item) => continuesAt(lines, index, item, memo);
}

/** Whether `item` continues a list in `lines[0 .. end)`; `memo` holds the answer for list items already judged, by line. */
function continuesAt(lines: readonly string[], end: number, item: ComposerListItem, memo: Map<number, boolean>): boolean {
	if (item.number === undefined || item.number === 1) { return true; }
	const width = (indent: string) => indent.replace(/\t/g, '    ').length;
	const own = width(item.indent);
	for (let i = end - 1; i >= 0; i--) {
		if (!lines[i].trim()) { continue; }
		const prior = composerListItem(lines[i]);
		if (!prior) { return false; }
		const depth = width(prior.indent);
		if (depth > own) { continue; }
		if (depth < own) { return false; }
		if (prior.number === undefined || prior.alpha !== item.alpha || prior.delimiter !== item.delimiter || prior.number >= item.number) { return false; }
		let valid = memo.get(i);
		if (valid === undefined) { valid = continuesAt(lines, i, prior, memo); memo.set(i, valid); }
		return valid;
	}
	return false;
}

/** The number an ordered `item` takes where it stands: one past the same list's item above, else 1. */
function composerNumberAt(above: readonly string[], item: ComposerListItem): number {
	const width = (indent: string) => indent.replace(/\t/g, '    ').length;
	const own = width(item.indent);
	for (let i = above.length - 1; i >= 0; i--) {
		if (!above[i].trim()) { continue; }
		const prior = composerListItem(above[i]);
		if (!prior || width(prior.indent) < own) { return 1; }
		if (width(prior.indent) > own) { continue; }
		const same = prior.number !== undefined && prior.alpha === item.alpha && prior.delimiter === item.delimiter;
		return same ? prior.number! + 1 : 1;
	}
	return 1;
}

/** The marker of item `n` of the list `item` belongs to; a letter list stops at z. */
export function composerMarker(item: ComposerListItem, n: number): string {
	if (item.number === undefined) { return item.marker; }
	if (!item.alpha) { return `${n}${item.delimiter}`; }
	const ch = String.fromCharCode(96 + Math.min(26, Math.max(1, n)));
	return `${item.alpha === 'upper' ? ch.toUpperCase() : ch}${item.delimiter}`;
}

export interface ComposerEdit {
	readonly start: number;
	readonly end: number;
	readonly text: string;
	readonly selectionStart: number;
	readonly selectionEnd: number;
}

function insideComposerFence(value: string, offset: number): boolean {
	let fence: string | undefined;
	for (const line of value.slice(0, offset).split('\n')) {
		const marker = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1];
		if (!marker) { continue; }
		if (!fence) { fence = marker; }
		else if (marker[0] === fence[0] && marker.length >= fence.length) { fence = undefined; }
	}
	return !!fence;
}

/** The line above (ignoring blank lines) is an unindented-or-nested list item. */
function insideComposerList(value: string, lineStart: number): boolean {
	const lines = value.slice(0, Math.max(0, lineStart - 1)).split('\n').reverse();
	for (const line of lines) {
		if (!line.trim()) { continue; }
		const item = composerListItem(line);
		if (!item) { return false; }
		if (!item.indent) { return true; }
	}
	return false;
}

/** Keep list editing independent of the DOM; callers apply one edit and dispatch input. */
export function composerListEdit(value: string, start: number, end: number, key: 'Enter' | 'Tab', shift = false): ComposerEdit | undefined {
	const lineStart = start ? value.lastIndexOf('\n', start - 1) + 1 : 0;
	if (insideComposerFence(value, lineStart)) { return undefined; }
	const lineEnd = value.indexOf('\n', start);
	const stop = lineEnd < 0 ? value.length : lineEnd;
	const line = value.slice(lineStart, stop);
	const item = composerListItem(line);
	if (!item) { return undefined; }
	if (key === 'Tab') {
		const last = value.indexOf('\n', Math.max(start, end - 1));
		const blockEnd = last < 0 ? value.length : last;
		const lines = value.slice(lineStart, blockEnd).split('\n');
		if (lines.some(line => line.trim() && !composerListItem(line))) { return undefined; }
		const deltas: number[] = [];
		// A moved ordered item takes the number its new place gives it: 1 (or a)
		// starting a nested list, the next one continuing the list it joins.
		const above = lineStart ? value.slice(0, lineStart - 1).split('\n') : [];
		const text = lines.map(line => {
			if (!line.trim()) { deltas.push(0); above.push(line); return line; }
			const remove = shift ? (/^\t/.test(line) ? 1 : /^ {1,2}/.exec(line)?.[0].length ?? 0) : 0;
			let moved = shift ? line.slice(remove) : `  ${line}`;
			const item = composerListItem(moved);
			if (item?.number !== undefined && moved !== line) {
				const marker = composerMarker(item, composerNumberAt(above, item));
				moved = item.indent + marker + moved.slice(item.indent.length + item.marker.length);
			}
			deltas.push(moved.length - line.length);
			above.push(moved);
			return moved;
		}).join('\n');
		return { start: lineStart, end: blockEnd, text,
			selectionStart: Math.max(lineStart, start + deltas[0]), selectionEnd: Math.max(lineStart, end + deltas.reduce((a, b) => a + b, 0)) };
	}
	// An indented line stays ordinary input; Tab can still adjust list indentation.
	// A line typed with leading whitespace does not start a list; it continues one
	// only when it is nested inside a list item above it (Tab made the indent).
	if (shift || (item.indent && !insideComposerList(value, lineStart))) { return undefined; }
	// Enter starts an ordered list only from 1 or a; Tab may still shift any item.
	if (!composerListContinues(lineStart ? value.slice(0, lineStart - 1).split('\n') : [], item)) { return undefined; }
	if (start < lineStart + item.prefixLength) { return { start, end, text: '\n', selectionStart: start + 1, selectionEnd: start + 1 }; }
	if (!item.content.trim() && start === end) {
		return { start: lineStart, end: stop, text: '', selectionStart: lineStart, selectionEnd: lineStart };
	}
	const marker = composerMarker(item, (item.number ?? 0) + 1);
	const text = `\n${item.indent}${marker} `;
	const leading = /^[ \t]+/.exec(value.slice(end, stop))?.[0].length ?? 0;
	return { start, end: end + leading, text, selectionStart: start + text.length, selectionEnd: start + text.length };
}

export interface ComposerLink { readonly start: number; readonly end: number; readonly text: string; readonly url: string }

export function composerLinks(text: string): ComposerLink[] {
	const links: ComposerLink[] = [];
	const pattern = /\b(?:https?:\/{1,2}|www\.)[^\s<>"'`]+/gi;
	for (const match of text.matchAll(pattern)) {
		const counts: Record<string, number> = {};
		for (const character of match[0]) { if ('(){}[]'.includes(character)) { counts[character] = (counts[character] ?? 0) + 1; } }
		const pairs: Record<string, string> = { ')': '(', '}': '{', ']': '[' };
		let end = match[0].length;
		while (end) {
			const last = match[0][end - 1];
			if (/[.,;:!?]/.test(last)) { end--; }
			else if (pairs[last] && (counts[last] ?? 0) > (counts[pairs[last]] ?? 0)) { counts[last]--; end--; }
			else { break; }
		}
		const raw = match[0].slice(0, end);
		try {
			const url = new URL(/^www\./i.test(raw) ? `https://${raw}` : raw.replace(/^(https?):\/{1,2}/i, '$1://'));
			if (!url.hostname || !['http:', 'https:'].includes(url.protocol)) { continue; }
			links.push({ start: match.index!, end: match.index! + raw.length, text: raw, url: url.href });
		} catch { /* An unfinished address is still ordinary editable text. */ }
	}
	return links;
}
