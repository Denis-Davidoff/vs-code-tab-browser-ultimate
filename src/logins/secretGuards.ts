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
 * Whether a field is one the user fills in themselves, as `browser_forms` marks it:
 * a secret by `isSecretField`, or a
 * payment card's number, security code or expiry — by autocomplete token or by
 * name as a word. A page that talks an agent into typing a password or a card
 * into its own form has the value.
 */
export function isProtectedField(attributes: Readonly<Record<string, string | undefined>>): boolean {
	if (isSecretField(attributes)) {
		return true;
	}
	const autocomplete = (attributes.autocomplete ?? '').toLowerCase();
	if (/(^|\s)cc-(number|csc|exp|exp-month|exp-year)(\s|$)/.test(autocomplete)) {
		return true;
	}
	return [attributes.name, attributes.id].some(name => {
		// Hyphens read as underscores (`card-number`, `cc-number`), camelCase split first.
		const words = (name ?? '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/-/g, '_');
		return /(^|[^a-z])(cvv2?|cvc2?|csc|card_?(number|num|no)|cc_?(number|num|no|csc|cvv|cvc)|credit_?card(?!_?(holder|name|type|brand))(_?(number|num|no))?|security_?code)([^a-z]|$)/.test(words);
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
			// An escaped character is part of a name, never syntax: `\)` in
			// `:not(.a\)[type=radio])` is a class named `a)`. Decoded to a real
			// `)` it closed the `:not(` early, and the `[type=radio]` still inside
			// it read as pinning the compound — the value oracle again. Letters
			// decode, so `[val\75 e^=a]` is still `value`; punctuation does not.
			out += /[\s()[\],>+~:.#*|^$="'\\/]/.test(decoded) ? '_' : decoded.toLowerCase();
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

/**
 * The compound without the arguments of its functional pseudo-classes.
 *
 * Whatever sits inside `:not(…)`, `:is(…)`, `:where(…)` or `:has(…)` says
 * nothing about which element the compound itself selects — `:not([type=radio])`
 * is the opposite of pinning a radio — and reading a `[type=…]` from in there
 * let `input:not([type=radio])[value^="a"]` through to a password field.
 * Quoted text is already masked by `normalizeSelector`, so a bracket inside a
 * string cannot unbalance this.
 */
function topLevel(compound: string): string {
	let out = '';
	let depth = 0;
	for (const char of compound) {
		if (char === '(') {
			depth++;
		} else if (char === ')') {
			depth = Math.max(0, depth - 1);
		} else if (depth === 0) {
			out += char;
		}
	}
	return out;
}

function pinsPlainElement(whole: string): boolean {
	const compound = topLevel(whole);
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
 * The end tag of each raw-text element, found without regard to ASCII case —
 * `</STYLE` closes a `<style>` as `</style` does.
 *
 * A search, not `html.toLowerCase().indexOf(…)`: lowercasing the whole document
 * once per raw-text element made a page of many `<style>` tags quadratic (2.5 MB
 * with 20 000 of them held the extension host for 4.8 s), and lowercasing it
 * once outside the loop is wrong too — `toLowerCase` is not length-preserving
 * (`'İ'` becomes two code units), so an index found in the lowered copy points
 * past the tag in the original. `i` without `u` folds ASCII letters only, which
 * is how HTML compares tag names: under `u`, `ſ` (U+017F) would read as `s`.
 */
const rawTextEnd = new Map([...rawText].map(name => [name, new RegExp(`</${name}`, 'gi')]));

/** Where the end tag of raw-text element `name` begins at or after `from`, or -1. */
function rawTextClose(html: string, name: string, from: number): number {
	const pattern = rawTextEnd.get(name)!;
	pattern.lastIndex = from;
	return pattern.exec(html)?.index ?? -1;
}

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
			const closing = rawTextClose(html, name, i);
			const stop = closing === -1 ? html.length : closing;
			result += html.slice(i, stop);
			i = stop;
		}
	}
	return result;
}

/**
 * Index just past the `>` that closes a start tag begun before `from`, quotes
 * honoured — **only a quote that opens a value**, right after `=`. A quote
 * anywhere else is part of an attribute name (`<div a'="x">` is legal, and
 * `outerHTML` writes it back as it is): read as an opening quote, it ran on to
 * the next `'` in the document, past the `>`, and swallowed the password input
 * after it into this tag, unredacted.
 */
function tagEnd(html: string, from: number): number {
	// The tokenizer's own attribute states, cut down to what finds the `>`. An
	// `=` before any name character starts a *name* (`<div ='>` is the
	// attribute `='`), so it opens no value; treating every `=` as one let that
	// quote swallow the next password input too.
	let state: 'before' | 'name' | 'afterName' | 'beforeValue' | 'unquoted' | '"' | '\'' = 'before';
	for (let at = from; at < html.length; at++) {
		const char = html[at];
		const space = char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
		if (state === '"' || state === '\'') {
			if (char === state) {
				state = 'before';
			}
			continue;
		}
		if (char === '>') {
			return at + 1;
		}
		switch (state) {
			case 'before':
				state = space || char === '/' ? 'before' : 'name';
				break;
			case 'name':
				state = space ? 'afterName' : char === '/' ? 'before' : char === '=' ? 'beforeValue' : 'name';
				break;
			case 'afterName':
				state = space ? 'afterName' : char === '/' ? 'before' : char === '=' ? 'beforeValue' : 'name';
				break;
			case 'beforeValue':
				state = space ? 'beforeValue' : char === '"' || char === '\'' ? char : 'unquoted';
				break;
			case 'unquoted':
				state = space ? 'before' : 'unquoted';
				break;
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

/** Elements dropped from cleaned markup with everything inside them. */
const droppedWhole = new Set(['script', 'style', 'noscript']);
/** Void elements dropped from cleaned markup: they carry nothing a reader needs. */
const droppedVoid = new Set(['link', 'meta', 'base']);

interface AttributeSpan {
	readonly start: number;
	readonly end: number;
	readonly name: string;
	readonly value: string | undefined;
}

/**
 * The attributes of a start tag `tag` (`<name …>`), read with the tokenizer's
 * own states, the same ones {@link tagEnd} walks — never a regular expression
 * (#262, #506): a quote opens a value only after `=`, and an `=` before any
 * name character is part of the name.
 */
function attributeSpans(tag: string, from: number): AttributeSpan[] {
	const spans: AttributeSpan[] = [];
	const space = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
	let at = from;
	while (at < tag.length) {
		while (at < tag.length && (space(tag[at]) || tag[at] === '/')) {
			at++;
		}
		if (at >= tag.length || tag[at] === '>') {
			break;
		}
		const start = at++;
		while (at < tag.length && !space(tag[at]) && tag[at] !== '/' && tag[at] !== '>' && tag[at] !== '=') {
			at++;
		}
		const nameEnd = at;
		let probe = at;
		while (probe < tag.length && space(tag[probe])) {
			probe++;
		}
		if (tag[probe] !== '=') {
			spans.push({ start, end: nameEnd, name: tag.slice(start, nameEnd).toLowerCase(), value: undefined });
			continue;
		}
		at = probe + 1;
		while (at < tag.length && space(tag[at])) {
			at++;
		}
		let value: string;
		if (tag[at] === '"' || tag[at] === '\'') {
			const quote = tag[at];
			const close = tag.indexOf(quote, at + 1);
			const stop = close === -1 ? tag.length : close;
			value = tag.slice(at + 1, stop);
			at = close === -1 ? tag.length : close + 1;
		} else {
			const begin = at;
			while (at < tag.length && !space(tag[at]) && tag[at] !== '>') {
				at++;
			}
			value = tag.slice(begin, at);
		}
		spans.push({ start, end: at, name: tag.slice(start, nameEnd).toLowerCase(), value });
	}
	return spans;
}

/** An attribute cleaned markup leaves out: handlers, inline styles, data attributes. */
function droppedAttribute(name: string): boolean {
	return name.startsWith('on') || name.startsWith('data-') || name === 'style' || name === 'nonce' || name === 'integrity';
}

/** A start tag rebuilt from the attributes worth keeping, a secret's value dropped. */
function cleanTag(tag: string, name: string): string {
	const spans = attributeSpans(tag, name.length + 1);
	const attributes: Record<string, string> = {};
	for (const s of spans) {
		attributes[s.name] = s.value ?? '';
	}
	const secret = name === 'input' && 'value' in attributes && isSecretField(attributes);
	let out = `<${name}`;
	for (const s of spans) {
		if (droppedAttribute(s.name) || (secret && s.name === 'value')) {
			continue;
		}
		if (s.value !== undefined && s.value.length > 200 && /^\s*data:/i.test(s.value)) {
			out += ` ${s.name}="data:…"`;
			continue;
		}
		out += ` ${tag.slice(s.start, s.end)}`;
	}
	return out + (/\/\s*>$/.test(tag) ? '/>' : '>');
}

/**
 * Markup cut down for a model to read: comments, `script`, `style`,
 * `noscript`, `template` and `link`/`meta` gone with their contents, the inside
 * of an inline `svg` dropped (its paths are noise; the tag and its label stay),
 * event handlers, inline styles and `data-*` attributes removed, long `data:`
 * URLs shortened, secret values redacted as {@link redactSecretValues} does, and
 * blank lines outside `pre` and `textarea` squeezed.
 *
 * Read as HTML by the same scanner as the redaction — a `<` inside a comment,
 * CDATA or raw text is not a tag, a tag ends at the `>` its quotes allow —
 * so the page cannot hide markup from the cleaning by quoting it oddly.
 */
export function cleanHtml(html: string): string {
	let result = '';
	let i = 0;
	// Inside an `svg` (tag kept) or a `template` (tag dropped) nothing is copied;
	// nesting of the same element is counted so the right end tag closes it.
	let skip: 'svg' | 'template' | undefined;
	let svgDepth = 0;
	let preDepth = 0;
	const text = (chunk: string) => {
		if (svgDepth > 0) {
			return;
		}
		result += preDepth > 0 ? chunk : squeezeBlankLines(chunk);
	};
	while (i < html.length) {
		const open = html.indexOf('<', i);
		if (open === -1) {
			text(html.slice(i));
			break;
		}
		text(html.slice(i, open));
		if (html.startsWith('<!--', open)) {
			const end = html.indexOf('-->', open + 4);
			i = end === -1 ? html.length : end + 3;
			continue;
		}
		if (html.startsWith('<![CDATA[', open)) {
			const end = html.indexOf(']]>', open + 9);
			i = end === -1 ? html.length : end + 3;
			continue;
		}
		const close = /^<\/([a-zA-Z][^\s/>]*)/.exec(html.slice(open, open + 64))?.[1]?.toLowerCase();
		const name = close ? undefined : /^<([a-zA-Z][^\s/>]*)/.exec(html.slice(open, open + 64))?.[1]?.toLowerCase();
		if (!name && !close && !/^<[!/?]/.test(html.slice(open, open + 2))) {
			// A `<` that starts no tag is text, as the tokenizer reads it.
			text('<');
			i = open + 1;
			continue;
		}
		if (!name) {
			const gt = html.indexOf('>', open + 1);
			const stop = gt === -1 ? html.length : gt + 1;
			if (skip && close === skip) {
				svgDepth--;
				if (svgDepth === 0) {
					result += skip === 'svg' ? '</svg>' : '';
					skip = undefined;
				}
			} else if (close && svgDepth === 0) {
				if ((close === 'pre' || close === 'textarea') && preDepth > 0) {
					preDepth--;
				}
				result += `</${close}>`;
			} else if (!close && svgDepth === 0 && /^<!doctype/i.test(html.slice(open, open + 9))) {
				result += html.slice(open, stop);
			}
			i = stop;
			continue;
		}
		const end = tagEnd(html, open + name.length + 1);
		const tag = html.slice(open, end);
		const selfClosing = /\/\s*>$/.test(tag);
		i = end;
		if (droppedWhole.has(name) || name === 'plaintext' || rawText.has(name)) {
			if (name === 'plaintext') {
				break;
			}
			const closing = rawTextClose(html, name, i);
			if (closing === -1) {
				break;
			}
			const gt = html.indexOf('>', closing);
			i = gt === -1 ? html.length : gt + 1;
			if (!droppedWhole.has(name) && svgDepth === 0) {
				// An iframe, xmp, noembed or noframes: keep the element, not its raw text.
				result += cleanTag(tag, name) + `</${name}>`;
			}
			continue;
		}
		if (svgDepth > 0) {
			if (name === skip && !selfClosing) {
				svgDepth++;
			}
			continue;
		}
		if (name === 'template') {
			if (!selfClosing) {
				skip = 'template';
				svgDepth = 1;
			}
			continue;
		}
		if (droppedVoid.has(name)) {
			continue;
		}
		result += cleanTag(tag, name);
		if (name === 'svg' && !selfClosing) {
			skip = 'svg';
			svgDepth = 1;
		} else if ((name === 'pre' || name === 'textarea') && !selfClosing) {
			preDepth++;
		}
	}
	return result.trim();
}

/**
 * Runs of blank lines in text squeezed to one line break, without a regular
 * expression: `\s*\n\s*\n` backtracks quadratically over a long run of
 * spaces before a single newline, and the text is the page's.
 */
function squeezeBlankLines(chunk: string): string {
	if (!chunk.includes('\n')) {
		return chunk;
	}
	const lines = chunk.split('\n');
	const out: string[] = [];
	let blank = false;
	for (const line of lines) {
		if (line.trim() === '') {
			blank = true;
			continue;
		}
		out.push((blank && out.length ? '\n' : '') + line.trimEnd());
		blank = false;
	}
	if (!out.length) {
		return '\n';
	}
	// A line break at either end separates this text from the tag beside it.
	return (lines[0].trim() === '' ? '\n' : '') + out.join('\n') + (blank ? '\n' : '');
}
