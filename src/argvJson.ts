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

interface ArrayRange {
	/** Offset of `[`. */
	readonly open: number;
	/** Offset of the matching `]`. */
	readonly close: number;
}

/**
 * The bracket range of the array that is *this key's own value*.
 *
 * Scanning forward for the next `[` from the key is not the same thing, and the
 * difference is a corrupted file: given
 * `{"enable-proposed-api": true, "js-flags": ["--x"]}` the loose search finds
 * the **neighbour's** array and appends our id into it, reporting success. The
 * "not an array" guard never fires, someone else's setting is silently
 * rewritten, and the grant is still missing.
 *
 * So the value is read where it actually starts: after the key's colon. Nesting
 * is tracked, because an element may itself be an array.
 */
function valueArrayRange(mask: string, keyAt: number): ArrayRange | undefined {
	const colon = mask.indexOf(':', keyAt);
	if (colon < 0) {
		return undefined;
	}
	let at = colon + 1;
	while (at < mask.length && /\s/.test(mask[at])) {
		at++;
	}
	if (mask[at] !== '[') {
		return undefined;
	}
	const open = at;
	let depth = 0;
	for (let i = open; i < mask.length; i++) {
		if (mask[i] === '[') {
			depth++;
		} else if (mask[i] === ']') {
			depth--;
			if (depth === 0) {
				return { open, close: i };
			}
		}
	}
	return undefined;
}

interface ArrayEntry {
	readonly value: string;
	/** Offset just past this entry's closing quote, where an append belongs. */
	readonly endsAt: number;
}

/**
 * The string entries of a JSONC array, with the position of each.
 *
 * `JSON.parse` on the raw text cannot do this: `argv.json` is JSONC, so
 * `["other.ext",]` and `["other.ext" // ours\n]` are both legal and both make
 * `JSON.parse` throw. That threw on a *correct* file, and the fallout was worse
 * than a refusal — the state check treats an unreadable value as "grant
 * missing", so an editor that was already configured pulsed `Enable Browser
 * API` forever.
 *
 * Returns `undefined` for anything that is not a flat list of strings. That is
 * deliberate: this array holds extension ids, so another shape is something we
 * do not model, and rewriting what we cannot read is how other people's grants
 * get lost.
 */
function arrayEntries(source: string, range: ArrayRange): ArrayEntry[] | undefined {
	const entries: ArrayEntry[] = [];
	let i = range.open + 1;
	while (i < range.close) {
		const c = source[i];
		if (/\s/.test(c) || c === ',') {
			i++;
			continue;
		}
		if (c === '/' && source[i + 1] === '/') {
			while (i < range.close && source[i] !== '\n') {
				i++;
			}
			continue;
		}
		if (c === '/' && source[i + 1] === '*') {
			const endsAt = source.indexOf('*/', i + 2);
			if (endsAt < 0 || endsAt > range.close) {
				return undefined;
			}
			i = endsAt + 2;
			continue;
		}
		if (c !== '"') {
			// A number, an object, a nested array, `true` — not our shape.
			return undefined;
		}
		let j = i + 1;
		while (j < range.close && source[j] !== '"') {
			j += source[j] === '\\' ? 2 : 1;
		}
		if (source[j] !== '"') {
			return undefined;
		}
		let value: unknown;
		try {
			value = JSON.parse(source.slice(i, j + 1));
		} catch {
			return undefined;
		}
		if (typeof value !== 'string') {
			return undefined;
		}
		entries.push({ value, endsAt: j + 1 });
		i = j + 1;
	}
	return entries;
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
	const range = valueArrayRange(mask, keyAt);
	if (!range) {
		// The key is there but its value is not an array (`true`, a string, a
		// truncated edit). Replacing a value we do not understand risks losing
		// someone else's grant, so this is reported rather than guessed at.
		throw new Error(`"enable-proposed-api" in argv.json is not an array — fix it by hand, then try again.`);
	}

	const entries = arrayEntries(source, range);
	if (!entries) {
		throw new Error(`"enable-proposed-api" in argv.json could not be read — fix it by hand, then try again.`);
	}
	if (entries.some(e => e.value === extensionId)) {
		return { text: source, changed: false, alreadyListed: true };
	}

	const entry = JSON.stringify(extensionId);
	const last = entries[entries.length - 1];
	// Append immediately after the last element rather than before the closing
	// bracket. Anything between the two may be a trailing comma (which would
	// make ours a second one) or a line comment (which would swallow the id).
	const insertAt = last ? last.endsAt : range.open + 1;
	const addition = last ? `, ${entry}` : entry;
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
