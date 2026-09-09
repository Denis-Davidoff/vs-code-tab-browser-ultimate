/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Surgical edits to `argv.json`, the file that grants proposed APIs.
 *
 * It is JSONC, not JSON: the editor ships it with a header of warnings and a
 * commented-out example for every supported switch. So `JSON.parse` plus
 * `JSON.stringify` is not an option — it would hand the user back a file with
 * every comment gone, including the "PLEASE DO NOT CHANGE WITHOUT
 * UNDERSTANDING THE IMPACT" notice. Everything here therefore splices text and
 * leaves the rest of the file byte-for-byte alone.
 *
 * No relative imports, so `npm test` can load this module directly.
 */

/**
 * Blanks comments and string *contents*, keeping length and every offset.
 *
 * Structural questions get asked of the mask; values are read from the
 * original text at the offsets the mask found. The distinction is the same one
 * `codexToml.ts` draws between `code` and `text`, and it matters for the same
 * reason: the file we are editing is full of commented-out examples, and
 * `// "enable-proposed-api": ["someone.else"]` must not read as a live key.
 * Deciding that with `indexOf` alone appends a second, real key below the
 * example and the two then disagree.
 */
export function maskJsonc(text: string): string {
	const out = text.split('');
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		const next = text[i + 1];
		if (c === '"') {
			// A string: blank the contents, keep both quotes so the mask still
			// shows where a key begins and ends.
			i++;
			while (i < text.length && text[i] !== '"') {
				if (text[i] === '\\') {
					out[i] = ' ';
					i++;
					if (i < text.length) {
						out[i] = ' ';
						i++;
					}
					continue;
				}
				out[i] = ' ';
				i++;
			}
			i++;
			continue;
		}
		if (c === '/' && next === '/') {
			while (i < text.length && text[i] !== '\n') {
				out[i] = ' ';
				i++;
			}
			continue;
		}
		if (c === '/' && next === '*') {
			while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
				if (text[i] !== '\n') {
					out[i] = ' ';
				}
				i++;
			}
			// The closing `*/` itself.
			for (let j = i; j < Math.min(i + 2, text.length); j++) {
				out[j] = ' ';
			}
			i += 2;
			continue;
		}
		i++;
	}
	return out.join('');
}

/** Where the live `"key"` sits in `text`, or -1. Comments do not count. */
function findLiveKey(text: string, key: string): number {
	const mask = maskJsonc(text);
	const needle = `"${key}"`;
	// The mask blanks string contents, so search for a quoted run of the right
	// length and confirm the original spells our key there.
	const blanked = `"${' '.repeat(key.length)}"`;
	let from = 0;
	for (;;) {
		const at = mask.indexOf(blanked, from);
		if (at < 0) {
			return -1;
		}
		if (text.startsWith(needle, at)) {
			return at;
		}
		from = at + 1;
	}
}

/** Offset of the top-level `{`, ignoring the comment header. -1 if there is none. */
function findRootBrace(text: string): number {
	return maskJsonc(text).indexOf('{');
}

export interface GrantResult {
	/** The file to write. Unchanged when `changed` is false. */
	readonly text: string;
	readonly changed: boolean;
	/**
	 * Set when nothing needed doing because the id was already listed — the
	 * caller reports "already configured" rather than "written".
	 */
	readonly alreadyListed: boolean;
}

/** Written when `argv.json` does not exist yet, or holds nothing usable. */
function freshFile(extensionId: string): string {
	return `{\n\t"enable-proposed-api": [\n\t\t${JSON.stringify(extensionId)}\n\t]\n}\n`;
}

/**
 * Adds `extensionId` to `enable-proposed-api`, preserving comments and layout.
 *
 * Handles the four shapes the file actually comes in: absent or blank, a live
 * key with an array to append to, a live key already naming us, and no key at
 * all (the common case — the shipped file has the switch only as a comment).
 */
export function grantProposedApi(source: string, extensionId: string): GrantResult {
	const root = findRootBrace(source);
	if (root < 0) {
		// No object at all: an empty file, or one the user has emptied. A file
		// of pure comments loses them here, and that is the honest trade — the
		// alternative is refusing to help at all.
		return { text: freshFile(extensionId), changed: true, alreadyListed: false };
	}

	const keyAt = findLiveKey(source, 'enable-proposed-api');
	if (keyAt < 0) {
		return { text: insertKey(source, root, extensionId), changed: true, alreadyListed: false };
	}

	const mask = maskJsonc(source);
	const open = mask.indexOf('[', keyAt);
	const close = open < 0 ? -1 : mask.indexOf(']', open);
	if (open < 0 || close < 0) {
		// The key is there but not as an array (`true`, a string, a truncated
		// edit). Replacing a value we do not understand risks losing someone
		// else's grant, so this is reported rather than guessed at.
		throw new Error(`"enable-proposed-api" in argv.json is not an array — fix it by hand, then try again.`);
	}

	const inner = source.slice(open + 1, close);
	let listed: unknown[];
	try {
		listed = JSON.parse(`[${inner}]`);
	} catch {
		throw new Error(`"enable-proposed-api" in argv.json could not be read — fix it by hand, then try again.`);
	}
	if (listed.includes(extensionId)) {
		return { text: source, changed: false, alreadyListed: true };
	}

	const entry = JSON.stringify(extensionId);
	const addition = listed.length === 0 ? entry : `, ${entry}`;
	// Append inside the brackets, after the last element rather than at `close`,
	// so a multi-line array keeps its closing bracket on its own line.
	const tail = inner.length - inner.trimEnd().length;
	const insertAt = close - tail;
	return {
		text: source.slice(0, insertAt) + addition + source.slice(insertAt),
		changed: true,
		alreadyListed: false,
	};
}

/** Inserts the property as the first entry of the root object. */
function insertKey(source: string, root: number, extensionId: string): string {
	const mask = maskJsonc(source);
	// Is the object empty? Look for anything other than whitespace before `}`.
	const closeAt = mask.lastIndexOf('}');
	const bodyIsEmpty = closeAt > root && source.slice(root + 1, closeAt).trim() === ''
		&& mask.slice(root + 1, closeAt).trim() === '';

	const indent = detectIndent(source, mask, root);
	const property = `"enable-proposed-api": [${JSON.stringify(extensionId)}]`;
	if (bodyIsEmpty) {
		return `${source.slice(0, root + 1)}\n${indent}${property}\n${source.slice(closeAt)}`;
	}
	// A non-empty object needs our comma, and it has to be ours rather than the
	// next entry's: the following line may be a comment, so appending a comma
	// to whatever comes next is not safe.
	return `${source.slice(0, root + 1)}\n${indent}${property},\n${source.slice(root + 1)}`;
}

/** Copies the file's own indentation for the first real property. */
function detectIndent(source: string, mask: string, root: number): string {
	const rest = mask.slice(root + 1);
	const match = /\n([ \t]+)\S/.exec(rest);
	if (match) {
		const at = root + 1 + (match.index ?? 0);
		const real = /\n([ \t]+)/.exec(source.slice(at));
		return real?.[1] ?? '\t';
	}
	return '\t';
}
