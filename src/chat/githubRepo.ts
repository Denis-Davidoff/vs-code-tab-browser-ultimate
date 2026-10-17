/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A GitHub repository as the chat's folder button takes it: what the user
 * types, read into an owner and a name, and the names and addresses built from
 * them. Leaf module, under test.
 *
 * **Only `github.com`, and only an address of our own making.** What is typed
 * is read for an owner and a name and nothing else, and the clone address is
 * built from those two: a URL handed to `git clone` as typed could name any
 * host, or one of git's transports that runs a program (`ext::`).
 */

export interface RepoRef {
	readonly owner: string;
	readonly name: string;
}

/** GitHub's own rules: an owner is letters, digits and inner hyphens; a name adds `.` and `_`. */
const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const namePattern = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * `owner/repo`, `https://github.com/owner/repo` (with `.git`, a trailing `/`,
 * or a path into the repository after it), `github.com/owner/repo`, or
 * `git@github.com:owner/repo.git`. Anything else is undefined.
 */
export function parseRepo(typed: string): RepoRef | undefined {
	let text = typed.trim();
	const ssh = /^git@github\.com:(.+)$/i.exec(text);
	if (ssh) {
		text = ssh[1];
	} else {
		text = text.replace(/^https?:\/\//i, '').replace(/^(?:www\.)?github\.com\//i, '');
		if (/^[^/]*\.[^/]*\//.test(text) || text.includes(':')) {
			// Another host, or a scheme left over.
			return undefined;
		}
	}
	const [owner, rawName] = text.split(/[/?#]/).filter(Boolean);
	if (!owner || !rawName) {
		return undefined;
	}
	const name = rawName.replace(/\.git$/i, '');
	if (!ownerPattern.test(owner) || owner.endsWith('-') || !namePattern.test(name) || name === '.' || name === '..') {
		return undefined;
	}
	return { owner, name };
}

export function repoSlug(repo: RepoRef): string {
	return `${repo.owner}/${repo.name}`;
}

/** What `git clone` is given: https, so the user's own credential helper answers for a private one. */
export function cloneUrl(repo: RepoRef): string {
	return `https://github.com/${repo.owner}/${repo.name}.git`;
}

/**
 * A branch name the user typed, or undefined when git would not take it, or it
 * would read as an option. Empty is "the default branch", which the caller
 * tells apart before asking.
 */
export function validBranch(typed: string): string | undefined {
	const branch = typed.trim();
	if (!branch || branch.length > 200 || branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/')
		|| branch.endsWith('.lock') || branch.endsWith('.') || branch.includes('..') || branch.includes('@{') || branch.includes('//')
		|| !/^[A-Za-z0-9._/-]+$/.test(branch)) {
		return undefined;
	}
	return branch;
}

/** The branch a separate copy works on: ours, dated, and unique enough for one machine. */
export function workBranchName(now: Date, unique: string): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
	return `ai-browser/${stamp}-${unique.replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase()}`;
}

/** The page that opens a pull request from `head` into `base`. */
export function compareUrl(repo: RepoRef, base: string, head: string): string {
	return `https://github.com/${repo.owner}/${repo.name}/compare/${encodeURI(base)}...${encodeURI(head)}?expand=1`;
}

/** `origin/main` from `git symbolic-ref --short refs/remotes/origin/HEAD`, as `main`. */
export function defaultBranchOf(symbolicRef: string): string | undefined {
	const ref = symbolicRef.trim();
	return ref.startsWith('origin/') && ref.length > 'origin/'.length ? ref.slice('origin/'.length) : undefined;
}
