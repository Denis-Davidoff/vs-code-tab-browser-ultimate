/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A diff card's text as the two sides VS Code's diff editor compares: what
 * was there before and what is there after.
 *
 * A leaf module with no `vscode` and no relative value imports, so `npm test`
 * loads it directly (see "Recipe for the next feature" in CLAUDE.md).
 */

/** Put in both sides where one hunk ends and the next begins: the lines between them are not in the diff. */
export const hunkGap = '⋯';

/**
 * Before and after, from what the chat shows: a unified diff (Codex's
 * `fileChange`, with `@@` hunks and context lines), or Claude Code's `-` / `+`
 * lines with no hunk at all. A `-` line is before only, a `+` line after only,
 * a context line (a leading space, or nothing to mark it) both. File headers
 * (`diff --git`, `---`, `+++`, `index …`) and "\ No newline at end of file"
 * are left out; a second hunk is set off by `hunkGap` in both sides, so the
 * editor does not read two distant places as one.
 */
export function diffSides(diff: string): { before: string; after: string } {
	const before: string[] = [];
	const after: string[] = [];
	const lines = diff.split(/\r?\n/);
	let inHunk = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith('@@')) {
			if (before.length || after.length) {
				before.push(hunkGap);
				after.push(hunkGap);
			}
			inHunk = true;
			continue;
		}
		// Headers only outside a hunk: inside one, `--- x` is a removed line
		// that begins with two dashes. And `---` / `+++` only as the pair a file
		// header is: Claude Code's Edit has no hunk, and its removed SQL comment
		// `-- note` arrives as `--- note`.
		if (!inHunk && /^(diff --git |index |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(line)) {
			continue;
		}
		if (!inHunk && line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
			i++;
			continue;
		}
		if (line.startsWith('\\')) {
			continue;
		}
		if (line.startsWith('+')) {
			after.push(line.slice(1));
		} else if (line.startsWith('-')) {
			before.push(line.slice(1));
		} else {
			const text = line.startsWith(' ') ? line.slice(1) : line;
			before.push(text);
			after.push(text);
		}
	}
	return { before: before.join('\n'), after: after.join('\n') };
}
