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
		const line = raw.trim();
		if (covering.has(line)) {
			ignored = true;
		} else if (negating.has(line)) {
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
