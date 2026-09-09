/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Report text and file names. No imports at all, so `npm test` can load it.
 */

export type PathKind = 'css' | 'xpath';

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
	return kind === 'css' ? 'CSS selector' : 'XPath';
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
): string {
	const lines = [
		`# ${pathLabel(kind)} of \`${descriptor}\``,
		url
			? `${pathLabel(kind)} of an element on ${url}`
			: `${pathLabel(kind)} of an element in the integrated browser`,
		fenced(path, kind === 'css' ? 'css' : 'xpath'),
	];
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
	return `element-${kind}-${slugify(descriptor)}-${stamp(now)}.md`;
}
