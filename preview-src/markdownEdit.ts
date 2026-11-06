/*
 * Markdown formatting for the skill editor's prompt fields: each function
 * takes the text and the selection and answers one edit to apply, so the
 * rules are tested without a DOM. Leaf module: no imports.
 */

export interface TextEdit {
	/** The range of the original text that `text` replaces. */
	readonly start: number;
	readonly end: number;
	readonly text: string;
	/** The selection after the edit, in the new text. */
	readonly selectionStart: number;
	readonly selectionEnd: number;
}

/**
 * Wraps the selection in `marker` (`**`, `_`, `` ` ``), or unwraps it when it
 * is wrapped already — inside or just outside the selection. With nothing
 * selected, inserts the markers around `placeholder` and selects it.
 */
export function toggleInline(value: string, start: number, end: number, marker: string, placeholder: string): TextEdit {
	const m = marker.length;
	const selected = value.slice(start, end);
	if (value.slice(start - m, start) === marker && value.slice(end, end + m) === marker) {
		return { start: start - m, end: end + m, text: selected, selectionStart: start - m, selectionEnd: end - m };
	}
	if (selected.length >= 2 * m && selected.startsWith(marker) && selected.endsWith(marker)) {
		const inner = selected.slice(m, selected.length - m);
		return { start, end, text: inner, selectionStart: start, selectionEnd: start + inner.length };
	}
	// Spaces at the edges of a selection stay outside the markers: `** bold **` is not bold.
	const lead = /^\s*/.exec(selected)![0].length;
	const trail = selected.length === lead ? 0 : /\s*$/.exec(selected)![0].length;
	const core = selected.slice(lead, selected.length - trail) || placeholder;
	const text = selected.slice(0, lead) + marker + core + marker + selected.slice(selected.length - trail);
	const at = start + lead + m;
	return { start, end, text, selectionStart: at, selectionEnd: at + core.length };
}

export type LineKind = 'bullet' | 'number' | 'quote' | 'heading' | 'task';

const linePrefix: Record<LineKind, RegExp> = {
	bullet: /^(\s*)[-*+] (?!\[[ xX]\] )/,
	number: /^(\s*)\d+[.)] /,
	quote: /^(\s*)> ?/,
	heading: /^(\s*)#{1,6} /,
	task: /^(\s*)[-*+] \[[ xX]\] /,
};

/** Any list or block marker a line already starts with, so one kind replaces another. */
const anyPrefix = /^(\s*)(?:[-*+] \[[ xX]\] |[-*+] |\d+[.)] |> ?|#{1,6} )/;

/**
 * Puts a block marker in front of every line the selection touches, or takes
 * it away when every non-empty line has it already. Another marker a line has
 * is replaced, so a bullet list becomes a numbered one in one press.
 */
export function toggleLines(value: string, start: number, end: number, kind: LineKind): TextEdit {
	const from = start ? value.lastIndexOf('\n', start - 1) + 1 : 0;
	// A selection ending right after a line break does not take in the next line.
	const stopAt = end > start && value[end - 1] === '\n' ? end - 1 : end;
	const next = value.indexOf('\n', stopAt);
	const to = next < 0 ? value.length : next;
	const lines = value.slice(from, to).split('\n');
	const filled = lines.filter(line => line.trim());
	const remove = filled.length > 0 && filled.every(line => linePrefix[kind].test(line));
	let n = 0;
	const out = lines.map(line => {
		if (!line.trim() && lines.length > 1) {
			return line;
		}
		if (remove) {
			return line.replace(linePrefix[kind], '$1');
		}
		const [, indent = ''] = /^(\s*)/.exec(line)!;
		const rest = line.replace(anyPrefix, '$1').slice(indent.length);
		n++;
		const marker = kind === 'bullet' ? '- ' : kind === 'number' ? `${n}. ` : kind === 'quote' ? '> ' : kind === 'task' ? '- [ ] ' : '## ';
		return indent + marker + rest;
	});
	const text = out.join('\n');
	// One empty line: the caret goes after the marker, ready to type.
	if (lines.length === 1 && !lines[0].trim() && !remove) {
		return { start: from, end: to, text, selectionStart: from + text.length, selectionEnd: from + text.length };
	}
	const single = lines.length === 1 && start === end;
	if (single) {
		const caret = Math.max(from, Math.min(from + text.length, start + text.length - lines[0].length));
		return { start: from, end: to, text, selectionStart: caret, selectionEnd: caret };
	}
	return { start: from, end: to, text, selectionStart: from, selectionEnd: from + text.length };
}

/**
 * A fenced code block around the lines the selection touches, its fence longer
 * than any backtick run inside; with nothing selected an empty block, the
 * caret inside it.
 */
export function codeBlock(value: string, start: number, end: number): TextEdit {
	if (start === end) {
		const before = value.slice(0, start);
		const lead = before && !before.endsWith('\n') ? '\n' : '';
		const after = value.slice(end);
		const trail = after && !after.startsWith('\n') ? '\n' : '';
		const text = `${lead}\`\`\`\n\n\`\`\`${trail}`;
		const caret = start + lead.length + 4;
		return { start, end, text, selectionStart: caret, selectionEnd: caret };
	}
	const from = value.lastIndexOf('\n', start - 1) + 1;
	const stopAt = value[end - 1] === '\n' ? end - 1 : end;
	const next = value.indexOf('\n', stopAt);
	const to = next < 0 ? value.length : next;
	const body = value.slice(from, to);
	const longest = Math.max(0, ...Array.from(body.matchAll(/`+/g), run => run[0].length));
	const fence = '`'.repeat(Math.max(3, longest + 1));
	const text = `${fence}\n${body}\n${fence}`;
	return { start: from, end: to, text, selectionStart: from + fence.length + 1, selectionEnd: from + fence.length + 1 + body.length };
}

/**
 * A Markdown link: the selection as its text with `url` selected to be typed,
 * or — when the selection is an address — the address as its target with the
 * text selected.
 */
export function link(value: string, start: number, end: number): TextEdit {
	const selected = value.slice(start, end);
	if (/^https?:\/\/\S+$/i.test(selected.trim())) {
		const url = selected.trim();
		const text = `[text](${url})`;
		return { start, end, text, selectionStart: start + 1, selectionEnd: start + 5 };
	}
	const label = selected || 'text';
	const text = `[${label}](url)`;
	const at = start + label.length + 3;
	return selected
		? { start, end, text, selectionStart: at, selectionEnd: at + 3 }
		: { start, end, text, selectionStart: start + 1, selectionEnd: start + 1 + label.length };
}

/** The same placeholder rule as `fillPrompt` in `src/chat/toolbarText.ts` — written twice, the leaf rule. */
const placeholder = /\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g;

/** Every parameter name the texts use as `{{name}}`, first use first, each once. */
export function placeholderNames(...texts: readonly string[]): string[] {
	const names: string[] = [];
	for (const text of texts) {
		for (const match of text.matchAll(placeholder)) {
			if (!names.includes(match[1])) {
				names.push(match[1]);
			}
		}
	}
	return names;
}

/** The text cut at each `{{name}}`, for drawing the placeholders apart from the prose. */
export function splitPlaceholders(text: string): ({ text: string } | { param: string; raw: string })[] {
	const out: ({ text: string } | { param: string; raw: string })[] = [];
	let last = 0;
	for (const match of text.matchAll(placeholder)) {
		if (match.index! > last) {
			out.push({ text: text.slice(last, match.index) });
		}
		out.push({ param: match[1], raw: match[0] });
		last = match.index! + match[0].length;
	}
	if (last < text.length) {
		out.push({ text: text.slice(last) });
	}
	return out;
}
