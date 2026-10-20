/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Keeping the Codex project config out of git from its own `.gitignore`. No
 * imports at all, so `npm test` can load it.
 */

/** Lines in `.codex/.gitignore` that ignore `config.toml` beside it. */
const covering = new Set(['config.toml', '/config.toml', '*', '/*', '*.toml', '/*.toml']);
/** Lines that un-ignore it again. */
const negating = new Set(['!config.toml', '!/config.toml', '!*.toml', '!/*.toml']);

/**
 * A `.gitignore` line with its trailing spaces removed, the way git removes
 * them (`trim_trailing_spaces` in git's `dir.c`): **unescaped spaces only.**
 *
 * A tab is part of the pattern, and so is a space after a backslash. Stripping
 * `[ \t]+` read `config.toml<TAB>` as `config.toml` — covered — while
 * `git check-ignore` answers "not ignored", which is the leaking direction:
 * the token-bearing file is then left free for `git add`. An escaped space
 * stays escaped here (`config.toml\ `), so it matches none of the shapes above
 * and reads as "not covered", as git agrees: it names a file "config.toml ".
 */
function trimTrailingSpaces(line: string): string {
	let end = line.length;
	let lastSpace: number | undefined;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === ' ') {
			lastSpace ??= i;
		} else {
			lastSpace = undefined;
			if (ch === '\\') {
				// The next character is escaped, whatever it is: never trimmed.
				i++;
			}
		}
	}
	if (lastSpace !== undefined) {
		end = lastSpace;
	}
	return line.slice(0, end);
}

/**
 * Does this `.codex/.gitignore` leave `config.toml` ignored?
 *
 * Read the way git reads it: in order, the last matching line wins, so a
 * `!config.toml` after a `*` puts the file back in play. Only the literal
 * shapes that can name this file from its own directory are recognised; a
 * pattern this does not model reads as "not covered", which costs one
 * redundant line rather than a token in a commit.
 */
export function ignoresConfigToml(gitignore: string): boolean {
	let ignored = false;
	for (const raw of gitignore.split(/\r?\n/)) {
		// Git keeps leading spaces as part of the pattern, so ` config.toml`
		// names a file called " config.toml" — reading it trimmed called a file
		// covered that git leaves free for `git add`. At the other end it drops
		// only what `trimTrailingSpaces` drops.
		const line = trimTrailingSpaces(raw);
		if (covering.has(line)) {
			ignored = true;
		} else if (negating.has(line) || line.startsWith('!')) {
			// **Any negation we cannot read counts as one that re-includes the
			// file.** `!config.*`, `!*`, `!c*` all do, and only the literal four
			// were modelled, so the rule above them was trusted. The cost of the
			// conservative reading is one redundant line appended after it.
			ignored = false;
		}
	}
	return ignored;
}

/**
 * The file with a `config.toml` rule appended, or `undefined` when it already
 * ignores it. Keeps the file's newline style and every existing line.
 */
export function withConfigTomlRule(gitignore: string): string | undefined {
	if (ignoresConfigToml(gitignore)) {
		return undefined;
	}
	const newline = /\r\n/.test(gitignore) ? '\r\n' : '\n';
	const base = gitignore === '' || gitignore.endsWith('\n') ? gitignore : gitignore + newline;
	return `${base}config.toml${newline}`;
}
