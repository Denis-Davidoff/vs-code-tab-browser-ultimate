/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * The files and folders of a chat's working directory, for the composer's
 * folder button: listed once when it opens, searched in the view.
 *
 * A walk of our own, not `git ls-files`: reading a repository's index runs its
 * `core.fsmonitor` command (breaks-silently #208), and the folder here is one
 * the user picked, which VS Code's workspace trust says nothing about. Nor
 * ripgrep from the editor's install: its path moves between releases and forks.
 * So the walk reads the root `.gitignore` and skips what it names, as well as
 * `.git` and `node_modules` always. Leaf module, under test.
 */

/** Listed at most; a monorepo has more, and the search still covers this many. */
export const workdirEntryLimit = 20_000;
/** Folders deeper than this are not entered. */
const depthLimit = 16;
/** The walk gives up after this long and answers what it has. */
const timeLimitMs = 3_000;

/** Never listed, whatever `.gitignore` says. */
const alwaysSkipped = new Set(['.git', 'node_modules', '.DS_Store']);

export interface WorkdirListing {
	/** Paths relative to the folder, `/`-separated; a folder ends with `/`. */
	readonly entries: readonly string[];
	/** Cut at `workdirEntryLimit`, at the depth limit or by the time limit. */
	readonly truncated: boolean;
}

/** Rules read from a `.gitignore` at most, and the longest pattern kept: it is the repository's text. */
const ruleLimit = 2_000;
const patternLimit = 500;

/** One glob character: a literal, `?`, or `*` (never past a `/`, which segments already split on). */
type GlobToken = { readonly kind: 'char'; readonly c: string } | { readonly kind: '?' } | { readonly kind: '*' };

interface IgnoreRule {
	/** The pattern's path segments; `null` is `**`, any number of segments. */
	readonly segments: readonly (readonly GlobToken[] | null)[];
	readonly anchored: boolean;
	readonly dirOnly: boolean;
}

/**
 * A `.gitignore`'s patterns as a test on a relative path, a subset of git's
 * rules: comments, blank lines, a trailing `/` for folders only, a leading or
 * inner `/` anchoring the pattern at the root, `*`, `?` and `**`, and `\`
 * escapes. A negation (`!`) is not modelled and is ignored — the cost is a file
 * left out of a picker, never one added to it.
 *
 * **Matched without regular expressions.** The file is the repository's, and a
 * glob turned into a backtracking pattern — `*a*a*a…*b` against a long name —
 * took longer than anyone waits, synchronously, on the extension host. Each
 * segment is matched with the two-pointer wildcard walk and `**` with a table
 * over segments, both polynomial whatever the text.
 */
export function ignoreMatcher(text: string): (relative: string, isDir: boolean) => boolean {
	const rules: IgnoreRule[] = [];
	for (let line of text.split(/\r?\n/)) {
		if (rules.length >= ruleLimit) {
			break;
		}
		// Trailing spaces are not part of the pattern unless escaped; leading ones are.
		while (line.endsWith(' ') && !line.endsWith('\\ ')) {
			line = line.slice(0, -1);
		}
		if (!line || line.length > patternLimit || line.startsWith('#') || line.startsWith('!')) {
			continue;
		}
		const dirOnly = line.endsWith('/');
		if (dirOnly) {
			line = line.slice(0, -1);
		}
		const anchored = line.includes('/');
		if (line.startsWith('/')) {
			line = line.slice(1);
		}
		if (!line) {
			continue;
		}
		const segments = line.split('/').filter(Boolean).map(seg => seg === '**' ? null : tokens(seg));
		rules.push({ segments, anchored, dirOnly });
	}
	return (relative, isDir) => {
		const parts = relative.split('/').filter(Boolean);
		return rules.some(r => (!r.dirOnly || isDir) && (r.anchored
			? matchSegments(r.segments, parts)
			// Unanchored, a pattern is a name, matched at any depth.
			: r.segments.length === 1 && r.segments[0] !== null && parts.length > 0 && matchGlob(r.segments[0], parts[parts.length - 1])));
	};
}

function tokens(glob: string): GlobToken[] {
	const out: GlobToken[] = [];
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === '\\' && i + 1 < glob.length) {
			out.push({ kind: 'char', c: glob[++i] });
		} else if (c === '*') {
			// `**` inside a segment is a `*`; runs of them are one.
			if (out[out.length - 1]?.kind !== '*') {
				out.push({ kind: '*' });
			}
		} else if (c === '?') {
			out.push({ kind: '?' });
		} else {
			out.push({ kind: 'char', c });
		}
	}
	return out;
}

/** The classic wildcard walk: backs up only to the last `*`, so it is O(pattern × text). */
function matchGlob(pattern: readonly GlobToken[], text: string): boolean {
	let p = 0;
	let t = 0;
	let star = -1;
	let mark = 0;
	while (t < text.length) {
		const token = pattern[p];
		if (token && (token.kind === '?' || (token.kind === 'char' && token.c === text[t]))) {
			p++;
			t++;
		} else if (token?.kind === '*') {
			star = p++;
			mark = t;
		} else if (star >= 0) {
			p = star + 1;
			t = ++mark;
		} else {
			return false;
		}
	}
	while (pattern[p]?.kind === '*') {
		p++;
	}
	return p === pattern.length;
}

/** Segments against segments, `**` standing for any number of them: a table, O(pattern × path). */
function matchSegments(pattern: readonly (readonly GlobToken[] | null)[], parts: readonly string[]): boolean {
	// can[i][j]: the first i pattern segments match the first j path segments.
	let row = new Array<boolean>(parts.length + 1).fill(false);
	row[0] = true;
	for (const seg of pattern) {
		const next = new Array<boolean>(parts.length + 1).fill(false);
		for (let j = 0; j <= parts.length; j++) {
			if (seg === null) {
				next[j] = row[j] || (j > 0 && next[j - 1]);
			} else if (j > 0) {
				next[j] = row[j - 1] && matchGlob(seg, parts[j - 1]);
			}
		}
		row = next;
	}
	return row[parts.length];
}

/**
 * Lists `root` breadth first, so a cut listing keeps the shallow entries —
 * the ones a search for a name is most likely after. Symbolic links are
 * listed and never entered: a link can lead out of the folder, or round in a
 * loop. A folder that cannot be read is skipped.
 */
export async function listWorkdir(root: string, now: () => number = Date.now): Promise<WorkdirListing> {
	let ignored: (relative: string, isDir: boolean) => boolean = () => false;
	const deadline = now() + timeLimitMs;
	const text = await beforeDeadline(readFile(path.join(root, '.gitignore'), 'utf8'), deadline, now);
	if (typeof text === 'string') {
		ignored = ignoreMatcher(text);
	}
	const entries: string[] = [];
	let truncated = false;
	let level: string[] = [''];
	for (let depth = 0; level.length; depth++) {
		if (depth >= depthLimit) {
			truncated = true;
			break;
		}
		const next: string[] = [];
		for (const dir of level) {
			if (entries.length >= workdirEntryLimit || now() > deadline) {
				truncated = true;
				return { entries, truncated };
			}
			// Bounded: a folder on a mount that stopped answering would hold the
			// whole listing — and the folder button — behind it.
			const children = await beforeDeadline(readdir(path.join(root, dir), { withFileTypes: true }), deadline, now);
			if (children === 'late') {
				return { entries, truncated: true };
			}
			if (!children) {
				continue;
			}
			children.sort((a, b) => a.name.localeCompare(b.name));
			for (const child of children) {
				if (now() > deadline) {
					return { entries, truncated: true };
				}
				if (alwaysSkipped.has(child.name)) {
					continue;
				}
				const relative = dir + child.name;
				const isDir = child.isDirectory();
				if (ignored(relative, isDir)) {
					continue;
				}
				if (entries.length >= workdirEntryLimit) {
					return { entries, truncated: true };
				}
				entries.push(isDir ? `${relative}/` : relative);
				if (isDir) {
					next.push(`${relative}/`);
				}
			}
		}
		level = next;
	}
	return { entries, truncated };
}

/** `work`'s answer, `undefined` when it failed, or `'late'` when the deadline came first. */
async function beforeDeadline<T>(work: Promise<T>, deadline: number, now: () => number): Promise<T | undefined | 'late'> {
	const left = deadline - now();
	if (left <= 0) {
		work.catch(() => undefined);
		return 'late';
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work.catch(() => undefined),
			new Promise<'late'>(resolve => { timer = setTimeout(() => resolve('late'), left); }),
		]);
	} finally {
		clearTimeout(timer);
	}
}
