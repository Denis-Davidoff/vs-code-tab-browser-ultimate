/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Keeping password values away from the assistants. No imports, so `npm test`
 * loads this directly.
 *
 * Why this is needed at all: **React writes a controlled input's value into its
 * `value` attribute**, passwords included (measured with React 19.2, and after a
 * saved login is filled as well as after typing). So on a React page the
 * password sits in the markup, where two kinds of tool reach it — anything that
 * returns markup, and anything that takes a selector, since
 * `input[type=password][value^="a"]` matching or not is a one-character answer.
 *
 * Every rule here is the only copy: markup is redacted in the extension, after
 * it leaves the page, never by code running in the page.
 */

/**
 * Whether an `<input>` with these attributes holds a secret.
 *
 * By type, by autocomplete token, and by name — the last because a "show
 * password" button turns the field into `type=text`, and a field so toggled
 * still holds the password.
 *
 * **The name is matched as a word**, camelCase split first. An unanchored
 * `pass` caught `passenger_count`, `passport_number`, `compass_heading` and
 * `bypass_cache`, and `browser_html` reported those filled fields as empty — on
 * the tool a model uses to check a page against itself.
 */
export function isSecretField(attributes: Readonly<Record<string, string | undefined>>): boolean {
	const type = (attributes.type ?? '').trim().toLowerCase();
	const autocomplete = (attributes.autocomplete ?? '').toLowerCase();
	if (type === 'password' || /(^|\s)(current-password|new-password|one-time-code)(\s|$)/.test(autocomplete)) {
		return true;
	}
	return [attributes.name, attributes.id].some(name => {
		const words = (name ?? '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
		return /(^|[^a-z])(pass(word|wd|code|phrase)?|pwd|pin)([^a-z]|$)/.test(words);
	});
}

/**
 * A selector reduced to what a selector engine sees, for the questions below:
 * comments gone, escapes decoded and strings kept apart.
 *
 * **Comments are the reason this is a tokenizer and not a regular expression.**
 * CSS drops a comment between tokens, so `[value/**\/^="a"]` is the same
 * selector as `[value^="a"]` — and it got past the first version of the guard,
 * the one-character oracle it was written to close. A comment is removed only
 * outside a string, or `[title="/*"][value^=a][title="*\/"]` would have a
 * string's text read as a comment and the comparison between hidden. A string's
 * content is kept, with anything structural in it replaced, so it can still be
 * read as a value (`[type="radio"]`) without ever looking like syntax.
 */
export function normalizeSelector(selector: string): string {
	let out = '';
	for (let i = 0; i < selector.length;) {
		const char = selector[i];
		if (char === '/' && selector[i + 1] === '*') {
			const end = selector.indexOf('*/', i + 2);
			i = end === -1 ? selector.length : end + 2;
			out += ' ';
			continue;
		}
		if (char === '"' || char === '\'') {
			let content = '';
			i++;
			while (i < selector.length && selector[i] !== char) {
				if (selector[i] === '\\' && i + 1 < selector.length) {
					const [decoded, length] = decodeEscape(selector, i);
					content += decoded;
					i += length;
				} else {
					content += selector[i++];
				}
			}
			i++;
			out += `"${content.toLowerCase().replace(/["'[\]()>+~,\\\s]/g, '_')}"`;
			continue;
		}
		if (char === '\\' && i + 1 < selector.length) {
			const [decoded, length] = decodeEscape(selector, i);
			out += decoded.toLowerCase();
			i += length;
			continue;
		}
		out += char.toLowerCase();
		i++;
	}
	return out;
}

/** A CSS escape at `at` (which holds the backslash): what it stands for, and how many characters it takes. */
function decodeEscape(text: string, at: number): [string, number] {
	const hex = /^[0-9a-fA-F]{1,6}/.exec(text.slice(at + 1, at + 7));
	if (hex) {
		const code = parseInt(hex[0], 16);
		const decoded = code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '�';
		const trailing = /[ \t\n\r\f]/.test(text[at + 1 + hex[0].length] ?? '') ? 1 : 0;
		return [decoded, 1 + hex[0].length + trailing];
	}
	return [text[at + 1], 2];
}

/** Elements that never hold a typed secret, so comparing their `value` reveals nothing. */
const plainTags = new Set(['option', 'button', 'li', 'data', 'param', 'meter', 'progress', 'output', 'select']);
const plainInputTypes = new Set(['radio', 'checkbox', 'submit', 'button', 'reset', 'image', 'range', 'color', 'file']);

/**
 * Whether a selector compares a field's `value` attribute with something.
 *
 * Any operator, not only the prefix ones: an exact `[value="hunter2"]` is a
 * dictionary attack one guess at a time. `[value]` on its own is allowed —
 * presence tells nothing. And so is a comparison on an element that never holds
 * a typed secret, which is how models pick radio buttons and options:
 * `option[value="us"]`, `input[type=radio][value=pro]`, `button[value=delete]`.
 * Refusing those too was the first version's cost, and it fell on ordinary
 * work. What decides is the compound the comparison sits in — so
 * `form:has(input[value^="a"]) button` is still refused, its comparison being
 * on an `input` of no stated type.
 */
export function comparesFieldValue(selector: string): boolean {
	const text = normalizeSelector(selector).replace(/\[[^\]]*\]/g, group => group.replace(/\s+/g, ''));
	const comparison = /\[(?:[\w*-]*\|)?value[~|^$*]?=[^\]]*\]/g;
	for (let match = comparison.exec(text); match; match = comparison.exec(text)) {
		if (!pinsPlainElement(compoundAround(text, match.index, match.index + match[0].length))) {
			return true;
		}
	}
	return false;
}

/** The compound selector containing `[start, end)`: out to the nearest combinator, comma or bracket at its own level. */
function compoundAround(text: string, start: number, end: number): string {
	const boundary = /[\s>+~,()]/;
	let from = start;
	for (let depth = 0; from > 0; from--) {
		const char = text[from - 1];
		if (char === ']' || char === ')') {
			depth++;
		} else if ((char === '[' || char === '(') && depth > 0) {
			depth--;
		} else if (depth === 0 && boundary.test(char)) {
			break;
		}
	}
	let to = end;
	for (let depth = 0; to < text.length; to++) {
		const char = text[to];
		if (char === '[' || (char === '(' && depth >= 0 && text.slice(Math.max(0, to - 8), to).includes(':'))) {
			depth++;
		} else if ((char === ']' || char === ')') && depth > 0) {
			depth--;
		} else if (depth === 0 && boundary.test(char)) {
			break;
		}
	}
	return text.slice(from, to);
}

function pinsPlainElement(compound: string): boolean {
	const tag = /^([a-z][\w-]*)/.exec(compound)?.[1];
	if (tag && plainTags.has(tag)) {
		return true;
	}
	if (tag && tag !== 'input' && tag !== 'textarea' && !tag.includes('-')) {
		// Another built-in element: it carries a value attribute only if the page
		// put one there, and it is not where a typed or filled password lives. A
		// custom element (`sl-input`, `md-outlined-text-field`) may well be, so it
		// is treated like an input.
		return true;
	}
	const type = /\[(?:[\w*-]*\|)?type=(?:"([^"]*)"|([^\]\s]*?))(?:[is])?\]/.exec(compound);
	const value = type ? (type[1] ?? type[2] ?? '') : undefined;
	return value !== undefined && plainInputTypes.has(value);
}

/** Elements whose content is raw text: a `<` inside them is not a tag. */
const rawText = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);

/**
 * The same markup with the `value` attribute removed from every input that
 * holds a secret.
 *
 * **It reads the markup as HTML, not as text with tags in it.** The first
 * version looked for `<input` anywhere, so a script containing
 * `const x = '<input data-x="';` opened a quote that swallowed the next real
 * input — and its password went out unredacted. Comments, CDATA sections and
 * the raw-text elements (`script`, `style`, …) are copied through without being
 * scanned for tags; a tag is read with its quotes honoured rather than cut at
 * the first `>`, since whether `>` is escaped inside a value depends on the
 * serializer's version.
 */
export function redactSecretValues(html: string): string {
	let result = '';
	let i = 0;
	while (i < html.length) {
		const open = html.indexOf('<', i);
		if (open === -1) {
			result += html.slice(i);
			break;
		}
		result += html.slice(i, open);
		if (html.startsWith('<!--', open)) {
			const end = html.indexOf('-->', open + 4);
			const stop = end === -1 ? html.length : end + 3;
			result += html.slice(open, stop);
			i = stop;
			continue;
		}
		if (html.startsWith('<![CDATA[', open)) {
			const end = html.indexOf(']]>', open + 9);
			const stop = end === -1 ? html.length : end + 3;
			result += html.slice(open, stop);
			i = stop;
			continue;
		}
		const name = /^<([a-zA-Z][^\s/>]*)/.exec(html.slice(open, open + 64))?.[1]?.toLowerCase();
		if (!name) {
			// `</x>`, `<!doctype>`, `<?…>` or a stray `<`: nothing to redact in it.
			const close = html.indexOf('>', open + 1);
			const stop = close === -1 ? html.length : close + 1;
			result += html.slice(open, stop);
			i = stop;
			continue;
		}
		const end = tagEnd(html, open + name.length + 1);
		const tag = html.slice(open, end);
		result += name === 'input' ? redactTag(tag) : tag;
		i = end;
		if (rawText.has(name)) {
			if (name === 'plaintext') {
				result += html.slice(i);
				break;
			}
			const closing = html.toLowerCase().indexOf(`</${name}`, i);
			const stop = closing === -1 ? html.length : closing;
			result += html.slice(i, stop);
			i = stop;
		}
	}
	return result;
}

/** Index just past the `>` that closes a start tag begun before `from`, quotes honoured. */
function tagEnd(html: string, from: number): number {
	let quote: string | undefined;
	for (let at = from; at < html.length; at++) {
		const char = html[at];
		if (quote) {
			if (char === quote) {
				quote = undefined;
			}
		} else if (char === '"' || char === '\'') {
			quote = char;
		} else if (char === '>') {
			return at + 1;
		}
	}
	return html.length;
}

const attributePattern = /\s([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function redactTag(tag: string): string {
	const attributes: Record<string, string> = {};
	for (const found of tag.matchAll(attributePattern)) {
		attributes[found[1].toLowerCase()] = found[2] ?? found[3] ?? found[4] ?? '';
	}
	if (!('value' in attributes) || !isSecretField(attributes)) {
		return tag;
	}
	return tag.replace(attributePattern, (whole, name: string) => name.toLowerCase() === 'value' ? '' : whole);
}
