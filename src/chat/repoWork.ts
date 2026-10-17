/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { cloneUrl, defaultBranchOf, repoSlug, type RepoRef } from './githubRepo';

/**
 * The git work behind the chat's GitHub repositories — see "The working
 * folder" in CLAUDE.md.
 *
 * **One clone per repository, kept in the extension's storage, with no
 * checkout of its own** (`<storage>/github/<owner>/<name>/base`), blobless so
 * a large repository arrives in seconds and its files are fetched as they are
 * read. Everything the chat works in or reads is a worktree of it: a separate
 * copy on a branch of ours (`copies/`), or a read-only checkout of a branch
 * (`refs/`). So two tabs on one repository share its history and never each
 * other's files, and nothing is ever written into the user's own project.
 *
 * **Git runs only in folders this extension made**, whose `.git/config` is
 * git's own default — never in a folder a repository chose, where reading the
 * index runs its `core.fsmonitor` (#208). The one exception is a clone into a
 * folder the user picked, which `git clone` creates itself.
 *
 * No prompt ever waits: `GIT_TERMINAL_PROMPT=0`, so a private repository the
 * user's credential helper cannot answer for fails with git's own message
 * instead of hanging on a terminal nobody sees.
 */

/** A clone or a fetch can be slow; past this it is ended and reported. */
const networkTimeoutMs = 10 * 60_000;
const localTimeoutMs = 60_000;

export class GitError extends Error { }

/** Runs git; rejects with the last lines of what it said on stderr. */
export function runGit(git: string, args: readonly string[], cwd: string | undefined, timeoutMs = localTimeoutMs): Promise<string> {
	return new Promise((resolve, reject) => {
		// `core.fsmonitor` off whatever a config says: it names a program git runs
		// when it reads the index, and a worktree's `.git` is a file the agent
		// working in it can rewrite (#208).
		execFile(git, ['-c', 'core.fsmonitor=false', ...args], {
			cwd,
			timeout: timeoutMs,
			maxBuffer: 64 * 1024 * 1024,
			windowsHide: true,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C' },
		}, (error, stdout, stderr) => {
			if (error) {
				const said = String(stderr).trim().split('\n').slice(-4).join('\n');
				const killed = (error as { killed?: boolean }).killed;
				reject(new GitError(killed ? `git ${args[0]} took too long and was stopped.` : said || error.message));
				return;
			}
			resolve(String(stdout));
		});
	});
}

/** Operations on one repository run one at a time: a fetch and a worktree add on one clone must not overlap. */
const chains = new Map<string, Promise<unknown>>();

function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
	const previous = chains.get(key) ?? Promise.resolve();
	const next = previous.then(work, work);
	chains.set(key, next.catch(() => undefined));
	return next;
}

function repoDir(storage: string, repo: RepoRef): string {
	return path.join(storage, 'github', repo.owner.toLowerCase(), repo.name.toLowerCase());
}

async function exists(file: string): Promise<boolean> {
	return fs.stat(file).then(() => true, () => false);
}

/**
 * A branch name as a folder name: one level, nothing git or a file system
 * minds, and a few characters of its hash — `feat/x` and `feat-x` read the
 * same once flattened, and two branches must never share a checkout.
 */
function branchFolder(branch: string): string {
	const readable = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 72) || 'branch';
	return `${readable}-${createHash('sha256').update(branch).digest('hex').slice(0, 6)}`;
}

/**
 * Whether `folder` is still a worktree of this repository's clone in storage:
 * its `.git` a file pointing into `base/.git/worktrees/`. Read here, without
 * git — a copy that was removed and made again as a plain folder (a transcript
 * written into it) sent git searching upwards for a repository, which could be
 * the home directory's; and the agent can rewrite the `.git` file to point at
 * a repository of its own choosing.
 */
export async function isOurWorktree(storage: string, repo: RepoRef, folder: string): Promise<boolean> {
	try {
		const marker = path.join(folder, '.git');
		if (!(await fs.lstat(marker)).isFile()) {
			return false;
		}
		const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await fs.readFile(marker, 'utf8'))?.[1];
		if (!pointer) {
			return false;
		}
		const worktrees = await fs.realpath(path.join(repoDir(storage, repo), 'base', '.git', 'worktrees'));
		const target = await fs.realpath(path.resolve(folder, pointer));
		return path.dirname(target) === worktrees;
	} catch {
		return false;
	}
}

/**
 * The repository's clone, made or brought up to date, and the branch asked
 * for — the default one when `branch` is undefined — checked to exist there.
 */
async function prepare(git: string, storage: string, repo: RepoRef, branch: string | undefined): Promise<{ base: string; branch: string }> {
	const dir = repoDir(storage, repo);
	const base = path.join(dir, 'base');
	if (await exists(path.join(base, '.git')) || await exists(path.join(base, 'HEAD'))) {
		await runGit(git, ['fetch', '--prune', 'origin'], base, networkTimeoutMs);
	} else {
		await fs.rm(base, { recursive: true, force: true });
		await fs.mkdir(dir, { recursive: true });
		try {
			await runGit(git, ['clone', '--filter=blob:none', '--no-checkout', '--', cloneUrl(repo), base], dir, networkTimeoutMs);
		} catch (err) {
			// A name that does not exist, or no access: nothing is left behind for it.
			await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
			throw err;
		}
	}
	let target = branch;
	if (!target) {
		// The remote's HEAD as the clone recorded it; refreshed, since it can move.
		await runGit(git, ['remote', 'set-head', 'origin', '--auto'], base, networkTimeoutMs).catch(() => undefined);
		target = defaultBranchOf(await runGit(git, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], base).catch(() => ''));
		if (!target) {
			throw new GitError(`Could not tell the default branch of ${repoSlug(repo)}; name a branch.`);
		}
	}
	try {
		await runGit(git, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${target}`], base);
	} catch {
		throw new GitError(`${repoSlug(repo)} has no branch ${target}.`);
	}
	return { base, branch: target };
}

/**
 * A separate copy to work in: a worktree of the clone on a new branch of
 * ours (`workBranch`), taken from `branch` (the default one when undefined).
 */
export function makeCopy(git: string, storage: string, repo: RepoRef, branch: string | undefined, workBranch: string): Promise<{ path: string; base: string }> {
	return serial(repoSlug(repo).toLowerCase(), async () => {
		const ready = await prepare(git, storage, repo, branch);
		const copy = path.join(repoDir(storage, repo), 'copies', branchFolder(workBranch));
		if (await exists(copy)) {
			throw new GitError(`${copy} is already there.`);
		}
		await fs.mkdir(path.dirname(copy), { recursive: true });
		await runGit(git, ['worktree', 'add', '-b', workBranch, '--', copy, `origin/${ready.branch}`], ready.base);
		return { path: copy, base: ready.branch };
	});
}

/**
 * A checkout of `branch` to read, one per branch, brought to the remote's
 * latest each time it is asked for. Detached: nothing is meant to be
 * committed there, and anything left in it is thrown away by the update.
 */
export function makeReference(git: string, storage: string, repo: RepoRef, branch: string | undefined): Promise<{ path: string; branch: string }> {
	return serial(repoSlug(repo).toLowerCase(), async () => {
		const ready = await prepare(git, storage, repo, branch);
		const checkout = path.join(repoDir(storage, repo), 'refs', branchFolder(ready.branch));
		if (await isOurWorktree(storage, repo, checkout)) {
			await runGit(git, ['checkout', '--detach', '--force', `origin/${ready.branch}`], checkout);
			// As the comment above says: whatever was left in it goes.
			await runGit(git, ['clean', '-ffdx', '--quiet'], checkout);
		} else {
			await fs.rm(checkout, { recursive: true, force: true });
			await runGit(git, ['worktree', 'prune'], ready.base).catch(() => undefined);
			await fs.mkdir(path.dirname(checkout), { recursive: true });
			await runGit(git, ['worktree', 'add', '--detach', '--', checkout, `origin/${ready.branch}`], ready.base);
		}
		return { path: checkout, branch: ready.branch };
	});
}

/**
 * A clone into a folder of the user's: `dest` itself when it is empty or not
 * there yet. Its own clone, full: this is the user's project from here on.
 */
export async function cloneInto(git: string, repo: RepoRef, branch: string | undefined, dest: string): Promise<void> {
	await fs.mkdir(path.dirname(dest), { recursive: true });
	await runGit(git, ['clone', ...(branch ? ['--branch', branch] : []), '--', cloneUrl(repo), dest], path.dirname(dest), networkTimeoutMs);
}

/** Whether `folder` is an empty directory; a folder that is not there counts as not empty. */
export async function isEmptyFolder(folder: string): Promise<boolean> {
	try {
		const dir = await fs.opendir(folder);
		const first = await dir.read();
		await dir.close();
		return first === null;
	} catch {
		return false;
	}
}

/** What a separate copy changed from the branch it was taken from: the status, then the diff. */
export async function copyChanges(git: string, copy: string, base: string): Promise<string> {
	const status = (await runGit(git, ['status', '--short', '--branch'], copy)).trimEnd();
	const diff = (await runGit(git, ['diff', '--stat', '--patch', `origin/${base}`, '--'], copy)).trimEnd();
	const untracked = (await runGit(git, ['ls-files', '--others', '--exclude-standard'], copy)).trim();
	return [
		status,
		untracked ? `\nNew files, not in the diff below:\n${untracked.split('\n').map(f => `  ${f}`).join('\n')}` : '',
		diff ? `\n${diff}` : '\nNo changes to tracked files.',
	].join('\n');
}

/**
 * Commits whatever the copy holds uncommitted, with `message`, and pushes its
 * branch. Rejects when there is nothing ahead of the base to push.
 */
export async function pushCopy(git: string, copy: string, base: string, branch: string, message: string): Promise<void> {
	if ((await runGit(git, ['status', '--porcelain'], copy)).trim()) {
		await runGit(git, ['add', '--all'], copy);
		await runGit(git, ['commit', '--quiet', '-m', message], copy);
	}
	const ahead = Number((await runGit(git, ['rev-list', '--count', `origin/${base}..HEAD`], copy)).trim());
	if (!ahead) {
		throw new GitError('There is nothing to push: the copy has no changes from the branch it was taken from.');
	}
	await runGit(git, ['push', '--set-upstream', 'origin', `${branch}:${branch}`], copy, networkTimeoutMs);
}

/** Removes a separate copy and its local branch; what was pushed stays on GitHub. */
export function removeCopy(git: string, storage: string, repo: RepoRef, copy: string, branch: string): Promise<void> {
	return serial(repoSlug(repo).toLowerCase(), async () => {
		const base = path.join(repoDir(storage, repo), 'base');
		await runGit(git, ['worktree', 'remove', '--force', '--', copy], base).catch(async () => {
			// A worktree whose folder is already gone: forget it.
			await fs.rm(copy, { recursive: true, force: true });
			await runGit(git, ['worktree', 'prune'], base);
		});
		await runGit(git, ['branch', '-D', branch], base).catch(() => undefined);
	});
}
