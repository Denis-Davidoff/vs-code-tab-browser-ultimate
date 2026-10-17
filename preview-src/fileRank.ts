/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Searching the working folder's files for the chat's folder button. Paths are
 * relative and `/`-separated, a folder ending with `/`. Leaf module, under test.
 */

/** The last segment of a path, without a folder's trailing `/`. */
export function baseName(entry: string): string {
	const trimmed = entry.endsWith('/') ? entry.slice(0, -1) : entry;
	return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/** How deep a path is: 0 for an entry of the folder itself. */
export function depth(entry: string): number {
	const trimmed = entry.endsWith('/') ? entry.slice(0, -1) : entry;
	let n = 0;
	for (const c of trimmed) {
		if (c === '/') {
			n++;
		}
	}
	return n;
}

/**
 * How well `entry` matches `query` (lower case, trimmed), lower is better:
 * the name starting with it, the name holding it, the path holding it, every
 * word of it somewhere in the path, its letters in order in the name. A query
 * with a `/` in it is about the path, so only the path tests apply. No match
 * is undefined.
 */
export function rankPath(entry: string, query: string): number | undefined {
	if (!query) {
		return 0;
	}
	const lower = entry.toLowerCase();
	const name = baseName(lower);
	if (!query.includes('/')) {
		if (name.startsWith(query)) {
			return 0;
		}
		if (name.includes(query)) {
			return 1;
		}
	}
	if (lower.includes(query)) {
		return 2;
	}
	const words = query.split(/\s+/).filter(Boolean);
	if (words.length > 1 && words.every(w => lower.includes(w))) {
		return 3;
	}
	return !query.includes('/') && !/\s/.test(query) && inOrder(name, query) ? 4 : undefined;
}

/** Every character of `query` in `text`, in order: `cv` finds `chatView.ts`. */
function inOrder(text: string, query: string): boolean {
	let at = 0;
	for (const c of query) {
		at = text.indexOf(c, at);
		if (at < 0) {
			return false;
		}
		at++;
	}
	return true;
}

/**
 * The best `limit` entries for `query`, best first; ties go to the shallower,
 * then the shorter path. Without a query, the folder's own entries, folders
 * first.
 */
export function searchPaths(entries: readonly string[], query: string, limit: number): string[] {
	if (!query) {
		return entries.filter(e => depth(e) === 0)
			.sort((a, b) => Number(b.endsWith('/')) - Number(a.endsWith('/')) || a.localeCompare(b))
			.slice(0, limit);
	}
	const ranked: { entry: string; r: number; d: number }[] = [];
	for (const entry of entries) {
		const r = rankPath(entry, query);
		if (r !== undefined) {
			ranked.push({ entry, r, d: depth(entry) });
		}
	}
	ranked.sort((a, b) => a.r - b.r || a.d - b.d || a.entry.length - b.entry.length || a.entry.localeCompare(b.entry));
	return ranked.slice(0, limit).map(x => x.entry);
}
