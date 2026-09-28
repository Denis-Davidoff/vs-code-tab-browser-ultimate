/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Pure formatting, deliberately with **no relative imports**. That is what lets
 * `npm test` load this file directly under Node's type stripping — a module
 * that imports a sibling by an extensionless specifier cannot be loaded that
 * way, and adding the extension would break the emitting tsconfig. Keep it
 * dependency-free so the output format stays under test.
 *
 * The layout is a port of `createElementContextValue` / `formatElementPath`
 * from microsoft/vscode
 * (`vs/workbench/contrib/browserView/electron-browser/features/browserEditorChatFeatures.ts`,
 * 1.134.0-1325-gaa7291eba7d), so what we copy matches what the built-in
 * browser attaches to chat.
 */

export interface ElementAncestor {
	readonly tagName: string;
	readonly id?: string;
	readonly classNames?: string[];
}

export interface ElementData {
	readonly outerHTML: string;
	readonly computedStyle: string;
	readonly ancestors: ElementAncestor[];
	readonly dimensions: { top: number; left: number; width: number; height: number };
}

/** `tag#id.class.class`, the notation used for both the path and the title. */
export function formatAncestor(ancestor: ElementAncestor): string {
	const id = ancestor.id ? `#${ancestor.id}` : '';
	const classes = ancestor.classNames?.length ? `.${ancestor.classNames.join('.')}` : '';
	return `${ancestor.tagName}${id}${classes}`;
}

/**
 * A fence longer than the longest backtick run inside `content`.
 *
 * The same rule as `fenced` in `reportFormat.ts`, **written twice on purpose**:
 * this module may not take a relative value import (see the header). Outer
 * HTML and matched CSS are the page's own text, and a fixed three-backtick
 * fence closed early on any page that contains one — a `<pre>` of Markdown, a
 * template literal, `content: "```"` — after which the rest of the page was
 * read as Markdown in the report an assistant is handed (item 176).
 */
function fence(content: string, language: string): string {
	let longest = 0;
	for (const run of content.match(/`+/g) ?? []) {
		longest = Math.max(longest, run.length);
	}
	const marks = '`'.repeat(Math.max(3, longest + 1));
	return `${marks}${language}\n${content}\n${marks}`;
}

export function renderElementMarkdown(data: ElementData, url: string | undefined): string {
	const sections: string[] = [];
	sections.push('Attached Element Context from Integrated Browser');

	// The element itself is the last entry of `ancestors`.
	const self = data.ancestors.at(-1);
	if (self) {
		sections.push(`Element: ${formatAncestor(self)}`);
	}

	if (url) {
		sections.push(`URL: ${url}`);
	}

	if (data.ancestors.length) {
		sections.push(`HTML Path: ${data.ancestors.map(formatAncestor).join(' > ')}`);
	}

	sections.push(`Outer HTML:\n${fence(data.outerHTML, 'html')}`);

	const { top, left, width, height } = data.dimensions;
	sections.push(
		`Dimensions:\n- top: ${Math.round(top)}px\n- left: ${Math.round(left)}px` +
		`\n- width: ${Math.round(width)}px\n- height: ${Math.round(height)}px`
	);

	sections.push(`CSS:\n${fence(data.computedStyle, 'css')}`);

	return sections.join('\n\n');
}
