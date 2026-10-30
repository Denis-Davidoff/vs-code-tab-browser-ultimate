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

/** Bare `1` is a list starter; other bare numbers remain ordinary prose. */
export function composerListItem(line: string): ComposerListItem | undefined {
	const letter = /^([ \t]*)([a-zA-Z][.)])([ \t]+)(.*)$/.exec(line);
	if (letter) {
		const ch = letter[2][0];
		return { indent: letter[1], marker: letter[2], number: ch.toLowerCase().charCodeAt(0) - 96, alpha: ch === ch.toLowerCase() ? 'lower' : 'upper',
			delimiter: letter[2][1], content: letter[4], prefixLength: letter[1].length + letter[2].length + letter[3].length };
	}
	const match = /^([ \t]*)([-*+]|\d{1,6}[.)]|1)([ \t]+|$)(.*)$/.exec(line);
	if (!match) { return undefined; }
	const ordered = /^\d/.test(match[2]);
	return { indent: match[1], marker: match[2], ...(ordered ? { number: parseInt(match[2], 10) } : {}),
		delimiter: ordered ? (/[.)]$/.test(match[2]) ? match[2].slice(-1) : '.') : '',
		content: match[4], prefixLength: match[1].length + match[2].length + match[3].length };
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
		const text = lines.map(line => {
			if (!line.trim()) { deltas.push(0); return line; }
			const remove = shift ? (/^\t/.test(line) ? 1 : /^ {1,2}/.exec(line)?.[0].length ?? 0) : 0;
			deltas.push(shift ? -remove : 2);
			return shift ? line.slice(remove) : `  ${line}`;
		}).join('\n');
		return { start: lineStart, end: blockEnd, text,
			selectionStart: Math.max(lineStart, start + deltas[0]), selectionEnd: Math.max(lineStart, end + deltas.reduce((a, b) => a + b, 0)) };
	}
	if (shift) { return undefined; }
	if (start < lineStart + item.prefixLength) { return { start, end, text: '\n', selectionStart: start + 1, selectionEnd: start + 1 }; }
	if (!item.content.trim() && start === end) {
		if (item.marker === '1') {
			const text = `${item.indent}1. `;
			return { start: lineStart, end: stop, text, selectionStart: lineStart + text.length, selectionEnd: lineStart + text.length };
		}
		const text = item.indent.startsWith('\t') ? item.indent.slice(1) : item.indent.slice(Math.min(2, item.indent.length));
		// Nested empty items return to their parent level before leaving the list entirely.
		let marker = composerMarker(item, item.number ?? 0);
		if (item.indent) {
			const spaces = text.replace(/\t/g, '    ').length;
			for (const line of value.slice(0, lineStart).split('\n').reverse()) {
				const previous = composerListItem(line);
				if (!previous) { continue; }
				const previousSpaces = previous.indent.replace(/\t/g, '    ').length;
				if (previousSpaces < spaces) { break; }
				if (previousSpaces === spaces) {
					marker = composerMarker(previous, (previous.number ?? 0) + 1);
					break;
				}
			}
		}
		const replacement = item.indent ? `${text}${marker} ` : '';
		return { start: lineStart, end: stop, text: replacement, selectionStart: lineStart + replacement.length, selectionEnd: lineStart + replacement.length };
	}
	const marker = composerMarker(item, (item.number ?? 0) + 1);
	const text = `\n${item.indent}${marker} `;
	const leading = /^[ \t]+/.exec(value.slice(end, stop))?.[0].length ?? 0;
	return { start, end: end + leading, text, selectionStart: start + text.length, selectionEnd: start + text.length };
}

/** Convert a freshly typed `1 ` to canonical Markdown without interpreting years or decimal numbers. */
export function composerListStarter(value: string, caret: number): ComposerEdit | undefined {
	const start = caret ? value.lastIndexOf('\n', caret - 1) + 1 : 0;
	if (insideComposerFence(value, start)) { return undefined; }
	const before = value.slice(start, caret);
	if (!/^[ \t]*1 $/.test(before)) { return undefined; }
	return { start: caret - 1, end: caret, text: '. ', selectionStart: caret + 1, selectionEnd: caret + 1 };
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
