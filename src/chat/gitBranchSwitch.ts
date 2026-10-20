import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseGitStatus } from './gitStatus';

export type SwitchGit = (args: readonly string[]) => Promise<string>;
export interface SwitchDialogs {
	changes(status: string): Promise<'commit' | 'stash' | 'discard' | undefined>;
	commit(preview: string): Promise<string | undefined>;
	discard(preview: string): Promise<boolean>;
	offline(error: string): Promise<boolean>;
	localName(existing: string): Promise<string | undefined>;
	stashed?(stash: NonNullable<SwitchResult['stash']>): void | Promise<void>;
}
export interface SwitchResult {
	branch: string;
	note?: string;
	stash?: { hash: string; branch: string };
}

/** A branch switch is deliberately separate from merge/rebase conflict resolution. */
export async function assertSwitchReady(git: SwitchGit): Promise<void> {
	if ((await git(['diff', '--name-only', '--diff-filter=U', '-z'])).length) {
		throw new Error('Resolve existing conflicts before switching branches.');
	}
	for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG']) {
		const file = (await git(['rev-parse', '--path-format=absolute', '--git-path', name])).trim();
		if (await fs.stat(file).then(() => true, () => false)) {
			throw new Error('Finish or abort the current merge, rebase, cherry-pick, revert or bisect before switching branches.');
		}
	}
}

/** Snapshot both tracked contents and untracked files before asking about destructive actions. */
async function snapshot(git: SwitchGit): Promise<{ status: string; fingerprint: string; preview: string }> {
	const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']);
	const untracked = parseGitStatus(status).unstaged.filter(f => f.status === '?').map(f => f.path);
	const root = (await git(['rev-parse', '--show-toplevel'])).trim();
	const hashes: string[] = [];
	for (const file of untracked) {
		const absolute = path.join(root, file);
		const stat = await fs.lstat(absolute);
		if (stat.isSymbolicLink()) {
			hashes.push(JSON.stringify(['symlink', await fs.readlink(absolute)]));
		} else if (stat.isFile()) {
			hashes.push(JSON.stringify(['file', stat.mode & 0o111, await git(['hash-object', '--', file])]));
		} else { throw new Error(`Cannot snapshot untracked entry ${file}. Handle it separately before switching branches.`); }
	}
	const staged = await git(['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', '--no-color']);
	const unstaged = await git(['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-color']);
	const head = await git(['rev-parse', '--verify', 'HEAD']);
	const ref = await git(['symbolic-ref', '--quiet', 'HEAD']).catch(() => 'detached');
	return { status, fingerprint: JSON.stringify([status, hashes, staged, unstaged, head, ref]),
		preview: `Files (porcelain status):\n${status.split('\0').join('\n')}\n\nStaged diff:\n${staged}\n\nUnstaged diff:\n${unstaged}` };
}

export async function switchAndUpdate(git: SwitchGit, name: string, remote: boolean, dialogs: SwitchDialogs): Promise<SwitchResult | undefined> {
	await assertSwitchReady(git);
	const original = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim();
	const originalHead = (await git(['rev-parse', '--verify', 'HEAD'])).trim();
	let local = name;
	let create = false;
	let upstream = '';
	let remoteName = '';
	let missingUpstream = false;
	if (remote) {
		const remotes = (await git(['remote'])).trim().split('\n').filter(Boolean).sort((a, b) => b.length - a.length);
		remoteName = remotes.find(r => name.startsWith(`${r}/`)) ?? '';
		if (!remoteName) { throw new Error('The remote no longer exists. Refresh the branch list.'); }
		local = name.slice(remoteName.length + 1);
		upstream = `refs/remotes/${name}`;
		const existing = (await git(['for-each-ref', '--format=%(refname)%00%(upstream)', 'refs/heads/'])).trim().split('\n');
		const current = existing.find(line => line.split('\0')[0] === `refs/heads/${local}`);
		if (current && current.split('\0')[1] !== upstream) {
			const chosen = await dialogs.localName(local);
			if (!chosen) { return undefined; }
			local = chosen;
			if (existing.some(line => line.split('\0')[0] === `refs/heads/${local}`)) { throw new Error('That local branch already exists. Choose a different name.'); }
			create = true;
		} else { create = !current; }
	} else {
		const info = (await git(['for-each-ref', '--format=%(refname)%00%(upstream)%00%(upstream:remotename)', 'refs/heads/']))
			.split('\n').find(line => line.split('\0')[0] === `refs/heads/${local}`)?.split('\0');
		if (!info) { throw new Error('This branch no longer exists. Refresh the branch list.'); }
		upstream = info[1]; remoteName = info[2];
	}
	if (!local || local.startsWith('-') || /[\0\r\n]/.test(local)) { throw new Error('Invalid local branch name.'); }
	await git(['check-ref-format', `refs/heads/${local}`]);
	const worktrees = await git(['worktree', 'list', '--porcelain']);
	if (local !== original && worktrees.split('\n').includes(`branch refs/heads/${local}`)) {
		throw new Error(`Branch ${local} is checked out in another worktree.`);
	}
	let offline = false;
	if (remoteName && remoteName !== '.') {
		try { await git(['fetch', '--prune', '--', remoteName]); }
		catch (error) {
			if (!await dialogs.offline(error instanceof Error ? error.message : String(error))) { return undefined; }
			offline = true;
		}
	}
	if (upstream) {
		const exists = await git(['rev-parse', '--verify', `${upstream}^{commit}`]).then(() => true, () => false);
		if (!exists) {
			if (remote) { throw new Error('The upstream branch no longer exists. Refresh the branch list.'); }
			missingUpstream = true;
			upstream = '';
		}
	}
	await assertSwitchReady(git);
	if ((await git(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim() !== original
		|| (await git(['rev-parse', '--verify', 'HEAD'])).trim() !== originalHead) {
		throw new Error('The current branch changed while preparing the switch. Try again.');
	}
	const before = await snapshot(git);
	let stash: SwitchResult['stash'];
	if (before.status) {
		if (!original) { throw new Error('Create or switch to a named branch before saving changes from detached HEAD.'); }
		const submodules = (await git(['ls-files', '--stage', '-z'])).split('\0')
			.filter(line => line.startsWith('160000 ')).map(line => line.slice(line.indexOf('\t') + 1));
		const files = parseGitStatus(before.status);
		if ([...files.staged, ...files.unstaged].some(f => submodules.includes(f.path))) {
			throw new Error('Commit or stash submodule changes separately before switching branches.');
		}
		const choice = await dialogs.changes(before.preview);
		if (!choice) { return undefined; }
		let message: string | undefined;
		if (choice === 'commit') {
			message = (await dialogs.commit(before.preview))?.trim();
			if (!message) { return undefined; }
		}
		if (choice === 'discard' && !await dialogs.discard(before.preview)) { return undefined; }
		await assertSwitchReady(git);
		if ((await snapshot(git)).fingerprint !== before.fingerprint) {
			throw new Error('The branch or files changed while the dialog was open. Review them and try again.');
		}
		if (choice === 'commit') {
			await git(['add', '--all', '--', ':/']);
			await git(['commit', '-m', message!]);
		} else if (choice === 'stash') {
			const previousStash = (await git(['rev-parse', '--verify', 'refs/stash']).catch(() => '')).trim();
			await git(['stash', 'push', '--include-untracked', '-m', `AI Browser: ${original} before switching to ${local}`]);
			stash = { hash: (await git(['rev-parse', 'refs/stash'])).trim(), branch: original };
			if (stash.hash === previousStash) { throw new Error('No new stash was created. The files may have changed externally; review them before switching.'); }
			await dialogs.stashed?.(stash);
		} else {
			await git(['restore', '--source=HEAD', '--staged', '--worktree', '--', ':/']);
			// Explicit untracked paths only; never remove ignored or newly arrived files.
			for (const file of files.unstaged.filter(f => f.status === '?')) { await git(['clean', '-f', '--', `:(literal)${file.path}`]); }
		}
		if ((await snapshot(git)).status) { throw new Error('Some changes remain. They were not carried to the target branch.'); }
	}
	await git(create ? ['switch', '--no-overwrite-ignore', '--no-recurse-submodules', '--track', '-c', local, upstream, '--'] : ['switch', '--no-overwrite-ignore', '--no-recurse-submodules', '--no-guess', local, '--']);
	const result: SwitchResult = { branch: local, stash };
	if (missingUpstream) { result.note = 'The upstream branch no longer exists; switched to the local branch without remote updates.'; }
	else if (offline) { result.note = 'Switched using the local copy; remote updates were not fetched.'; }
	else if (!upstream) { result.note = 'No upstream configured; switched without remote updates.'; }
	else {
		try { await git(['-c', 'merge.autoStash=false', 'merge', '--ff-only', '--no-overwrite-ignore', '--no-edit', upstream]); }
		catch (error) { result.note = `Switched to ${local}, but could not fast-forward. No automatic merge or rebase was performed.\n${error instanceof Error ? error.message : String(error)}`; }
	}
	return result;
}
