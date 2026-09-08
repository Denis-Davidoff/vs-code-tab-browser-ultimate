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

	sections.push(`Outer HTML:\n\`\`\`html\n${data.outerHTML}\n\`\`\``);

	const { top, left, width, height } = data.dimensions;
	sections.push(
		`Dimensions:\n- top: ${Math.round(top)}px\n- left: ${Math.round(left)}px` +
		`\n- width: ${Math.round(width)}px\n- height: ${Math.round(height)}px`
	);

	sections.push(`CSS:\n\`\`\`css\n${data.computedStyle}\n\`\`\``);

	return sections.join('\n\n');
}
