/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Report text and file names. No imports at all, so `npm test` can load it.
 */

export type PathKind = 'css' | 'cssLocation' | 'xpath';

/**
 * What separates the page from the selector picked on it.
 *
 * Three things had to be true at once, and each one eliminated a candidate.
 *
 * It must not be legal inside either half, or the string cannot be split back
 * apart. That rules out the `[page: …]` form this started as: `[…]` is valid CSS
 * attribute-selector syntax, so a bracketed suffix reads as part of the chain —
 * to a person, to a model, and to anything that pastes the whole string into
 * `querySelector`. It also rules out `>>`, which is Playwright's own chaining
 * operator, and `page=… css=…`, where the key order becomes part of the contract
 * because the selector contains spaces and so has to come last.
 *
 * It must carry direction, because the two halves are not interchangeable. An
 * arrow says which way to read; `@` only works with the selector first ("input
 * @ that page"), and putting the page first while keeping it says the opposite
 * of what is meant.
 *
 * And the **spaces are part of it**. `CSS.escape` emits code points at or above
 * U+0080 unchanged, so an id containing an arrow survives into the selector
 * unescaped — but it escapes every non-alphanumeric ASCII character, the space
 * included, so ` → ` with its spaces cannot occur inside the selector half. A
 * bare `→` is not a separator; the padded one is.
 */
export const locationSeparator = ' → ';

/**
 * Joins the address of a page to a selector picked on it.
 *
 * The page comes first because that is the order the pair is used in: navigate,
 * then find. Everything before the separator is an argument for
 * `browser_navigate`, everything after it an argument for
 * `document.querySelector`.
 *
 * A URL-less tab (nothing has committed yet) yields the bare selector rather
 * than a dangling separator — half an answer beats a malformed one.
 */
export function withLocation(path: string, url: string | undefined): string {
	return url ? `${url}${locationSeparator}${path}` : path;
}

/**
 * Wraps a one-liner as Markdown inline code.
 *
 * The delimiter is grown past the longest backtick run inside the value, on the
 * same reasoning as {@link fenced}: a URL may legally carry a backtick in its
 * query string, and a single-backtick wrapper around one closes early, leaving
 * the tail of the address as prose. A value that begins or ends with a backtick
 * is padded with spaces, which CommonMark strips back off when both sides have
 * one.
 */
export function inlineCode(value: string): string {
	let longest = 0;
	for (const run of value.match(/`+/g) ?? []) {
		longest = Math.max(longest, run.length);
	}
	const delimiter = '`'.repeat(longest + 1);
	const pad = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
	return `${delimiter}${pad}${value}${pad}${delimiter}`;
}

/**
 * Wraps page content in a fenced block whose fence is always one backtick
 * longer than the longest run inside it.
 *
 * Page content routinely contains backticks — template literals in inline
 * scripts, Markdown in a CMS preview — and a three-backtick fence around them
 * closes early, after which the rest of the report is read as Markdown by
 * whatever consumes it.
 */
export function fenced(content: string, language: string): string {
	let longest = 0;
	for (const run of content.match(/`+/g) ?? []) {
		longest = Math.max(longest, run.length);
	}
	const fence = '`'.repeat(Math.max(3, longest + 1));
	return `${fence}${language}\n${content}\n${fence}`;
}

/** Lowercase, non-alphanumerics collapsed to `-`, trimmed to a sane length. */
export function slugify(value: string): string {
	const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
	return slug || 'element';
}

/** `HHMMSS` of local time — enough to keep two reports in one session apart. */
export function stamp(now: Date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function pathLabel(kind: PathKind): string {
	switch (kind) {
		case 'css': return 'CSS selector';
		case 'cssLocation': return 'Page address and CSS selector';
		case 'xpath': return 'XPath';
	}
}

/**
 * The fence language, which is not simply the kind.
 *
 * A `cssLocation` body is a selector *and* a URL joined by ` → `, so it is not
 * valid CSS; labelling it `css` invites a reader — a syntax highlighter or a
 * model — to parse it as a rule and fail on the tail.
 */
function fenceLanguage(kind: PathKind): string {
	switch (kind) {
		case 'css': return 'css';
		case 'cssLocation': return 'text';
		case 'xpath': return 'xpath';
	}
}

/** Lowercase, hyphenated token for a file name; the kind itself is camelCase. */
function fileToken(kind: PathKind | 'element'): string {
	return kind === 'cssLocation' ? 'css-location' : kind;
}

/**
 * A one-line selector still travels as a file: both assistants accept a file,
 * and only one of them has any way to accept text at all.
 */
export function formatPathReport(
	descriptor: string,
	kind: PathKind,
	path: string,
	url: string | undefined,
	embeddedIn?: string,
): string {
	const lines = [
		`# ${pathLabel(kind)} of \`${descriptor}\``,
		url
			? `${pathLabel(kind)} of an element on ${url}`
			: `${pathLabel(kind)} of an element in the integrated browser`,
	];
	// Asked of the body, not of the kind. `withLocation` yields the bare selector
	// when the tab has no URL to give — nothing has committed yet — and a
	// `Format:` line promising a separator that the fenced block below does not
	// contain describes the one thing a report must not get wrong.
	if (kind === 'cssLocation' && path.includes(locationSeparator)) {
		// Spelled out because the reader is usually a model: without it the
		// combined line invites a paste of the whole string into
		// `querySelector`, separator and address included.
		lines.push(`Format: \`<page url>${locationSeparator}<css selector>\``);
	}
	if (embeddedIn) {
		// The pair above addresses the frame's own document, which is the only
		// way it resolves with one `querySelector`. Where it came from is still
		// worth saying, and the report has room for it where the one-liner does
		// not.
		lines.push(`Picked inside a frame embedded in ${embeddedIn}.`);
	}
	lines.push(fenced(path, fenceLanguage(kind)));
	return `${lines.join('\n\n')}\n`;
}

/** Wraps the element context so the file reads as a document, not a fragment. */
export function formatElementReport(markdown: string, descriptor: string): string {
	return `# Element context of \`${descriptor}\`\n\n${markdown.trimEnd()}\n`;
}

export function reportFileName(
	kind: PathKind | 'element',
	descriptor: string,
	now: Date = new Date(),
): string {
	return `element-${fileToken(kind)}-${slugify(descriptor)}-${stamp(now)}.md`;
}
