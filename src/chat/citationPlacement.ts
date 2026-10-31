/** Keep citation controls out of Markdown link destinations and bare URL tokens.
 * The citation's validated source range stays unchanged; only its visual control
 * moves to the end of the link whose hidden destination contains that range.
 */
export function citationInsertionOffset(text: string, end: number, inlineLimit = 4000): number {
	const start = text.lastIndexOf('\n', end - 1) + 1;
	const next = text.indexOf('\n', end);
	const line = text.slice(start, next < 0 ? text.length : next);
	// The chat renders longer lines as plain text, with no Markdown links.
	if (line.length > inlineLimit) { return end; }
	const offset = end - start;
	const links = /\[([^\]]+)\]\((<[^>]+>|[^\s)]+)\)|((?:https?:\/\/|file:\/\/)[^\s<>()[\]`"]+)/g;
	for (const match of line.matchAll(links)) {
		const index = match.index!;
		if (match[2] !== undefined) {
			const labelEnd = index + 1 + match[1].length;
			if (offset > labelEnd && offset <= index + match[0].length) { return start + index + match[0].length; }
		} else {
			const url = match[3].replace(/[.,;:!?'*_]+$/, '');
			if (offset > index && offset <= index + url.length) { return start + index + url.length; }
		}
	}
	return end;
}
