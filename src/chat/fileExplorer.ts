/*---------------------------------------------------------------------------------------------
 *  The Files tab's rules: paths inside the working folder, names for a pasted copy,
 *  sorting. Leaf module, no `vscode`, under test.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';

/** One entry of a listed folder, as the view draws it. */
export interface FileEntry {
	readonly name: string;
	readonly dir: boolean;
	readonly link?: boolean;
	readonly size?: number;
	readonly mtime?: number;
	/** Uncommitted changes: `M` changed, `A` added, `U` untracked (a folder: what is inside it). */
	readonly git?: 'M' | 'A' | 'U';
}

/**
 * The Git mark of each entry of one folder, from `git status --porcelain=v1 -z` (paths from the
 * repository root) and that folder's path from the root (`''` for the root, `/` separated).
 * A folder is new only when everything changed inside it is new.
 */
export function gitMarks(porcelain: string, prefix: string): Map<string, 'M' | 'A' | 'U'> {
	const marks = new Map<string, 'M' | 'A' | 'U'>();
	const base = prefix ? (prefix.endsWith('/') ? prefix : `${prefix}/`) : '';
	const parts = porcelain.split('\0');
	for (let i = 0; i < parts.length; i++) {
		const item = parts[i];
		if (item.length < 4) { continue; }
		const code = item.slice(0, 2);
		const file = item.slice(3);
		if (code[0] === 'R' || code[0] === 'C') { i++; }
		if (code[0] === 'D' && code[1] === ' ') { continue; } // gone from the folder
		if (!file.startsWith(base)) { continue; }
		const rest = file.slice(base.length).replace(/\/$/, '');
		if (!rest) { continue; }
		const slash = rest.indexOf('/');
		const name = slash < 0 ? rest : rest.slice(0, slash);
		const mark: 'M' | 'A' | 'U' = code === '??' ? 'U' : code[0] === 'A' ? 'A' : 'M';
		const before = marks.get(name);
		if (slash < 0 || before === undefined) { marks.set(name, mark); }
		else if (before !== mark) { marks.set(name, 'M'); }
	}
	return marks;
}

/** At most this many entries of one folder are sent. */
export const maxListed = 2000;

/** Never listed: git's own store. */
export const hiddenNames: ReadonlySet<string> = new Set(['.git']);

/**
 * `relative` (forward slashes, '' for the root) resolved under `root`, or
 * undefined when it is malformed or leads out of it. Lexical only; the host
 * checks real paths as well.
 */
export function resolveInside(root: string, relative: string): string | undefined {
	if (typeof relative !== 'string' || relative.length > 4096 || /[\0\n\r]/.test(relative)) { return undefined; }
	if (path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) { return undefined; }
	const target = path.resolve(root, relative);
	const inside = path.relative(root, target);
	if (inside.startsWith('..') || path.isAbsolute(inside)) { return undefined; }
	return target;
}

/** True when `target` is `root` or below it. */
export function isInside(root: string, target: string): boolean {
	const inside = path.relative(root, target);
	return !inside.startsWith('..') && !path.isAbsolute(inside);
}

/** `report.md` → `report copy.md`, `report copy 2.md`, …; the first name `taken` does not hold. */
export function copyName(name: string, taken: (candidate: string) => boolean): string {
	if (!taken(name)) { return name; }
	const dot = name.lastIndexOf('.');
	const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
	for (let n = 1; n < 1000; n++) {
		const candidate = `${stem} copy${n === 1 ? '' : ` ${n}`}${ext}`;
		if (!taken(candidate)) { return candidate; }
	}
	return `${stem} copy ${Date.now()}${ext}`;
}

/** Folders first, then by name as a person reads it (`file2` before `file10`). */
export function sortEntries(entries: FileEntry[]): FileEntry[] {
	return entries.sort((a, b) => a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}
