import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { branchCommand, branchRefFormat, parseGitBranches, parseRemoteUrls, parseTrack, publishRemote, pushesDefaultBranch } from './gitBranchState.ts';

test('branch list distinguishes local, remote and symbolic refs and preserves slashes', () => {
	deepStrictEqual(parseGitBranches('refs/heads/feature/ui\n', [
		'refs/heads/feature/ui\0', 'refs/heads/main\0',
		'refs/remotes/origin/HEAD\0refs/remotes/origin/main',
		'refs/remotes/origin/feature/ui\0', '',
	].join('\n')), { current: 'feature/ui', branches: [
		{ name: 'feature/ui', remote: false }, { name: 'main', remote: false },
		{ name: 'origin/feature/ui', remote: true },
	] });
	deepStrictEqual(parseGitBranches('', ''), { current: '', branches: [] });
});

test('branch operations create, switch and delete without losing unmerged work', () => {
	const folder = mkdtempSync(path.join(os.tmpdir(), 'ai-browser-branches-'));
	const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=' + os.devNull,
		'-c', 'commit.gpgsign=false', '-c', 'user.name=Branch Test', '-c', 'user.email=branch@example.invalid', ...args],
		{ cwd: folder, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	try {
		git('init', '-b', 'main');
		git('commit', '--allow-empty', '-m', 'initial');
		git(...branchCommand('create', 'feature/example'));
		strictEqual(git('branch', '--show-current'), 'feature/example');
		throws(() => git(...branchCommand('delete', 'feature/example')));
		writeFileSync(path.join(folder, 'feature.txt'), 'work');
		git('add', '.'); git('commit', '-m', 'feature');
		git(...branchCommand('switch', 'main'));
		throws(() => git(...branchCommand('delete', 'feature/example')));
		git(...branchCommand('create', 'disposable'));
		git(...branchCommand('switch', 'main'));
		git(...branchCommand('delete', 'disposable'));
		strictEqual(git('branch', '--list', 'disposable'), '');
		git(...branchCommand('switch', 'feature/example'));
		writeFileSync(path.join(folder, 'feature.txt'), 'uncommitted work');
		throws(() => git(...branchCommand('switch', 'main')));
		strictEqual(git('branch', '--show-current'), 'feature/example');
		git('restore', 'feature.txt');
		git(...branchCommand('switch', 'main'));
		git('config', 'remote.origin.url', '.');
		git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
		git('update-ref', 'refs/remotes/origin/remote-work', 'HEAD');
		git(...branchCommand('switch', 'origin/remote-work', true));
		strictEqual(git('branch', '--show-current'), 'remote-work');
		strictEqual(git('rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/remote-work');
		throws(() => branchCommand('delete', 'origin/remote-work', true));
		throws(() => git('check-ref-format', 'refs/heads/@{-1}'));
	} finally { rmSync(folder, { recursive: true, force: true }); }
});

test('the current branch carries its upstream and how far apart they are', () => {
	const refs = [
		'refs/heads/feature/x\0\0refs/remotes/origin/feature/x\0origin\0[ahead 2, behind 1]',
		'refs/heads/main\0\0refs/remotes/origin/main\0origin\0',
		'refs/remotes/origin/HEAD\0refs/remotes/origin/main\0\0\0',
		'refs/remotes/origin/feature/x\0\0\0\0',
	].join('\n');
	const state = parseGitBranches('refs/heads/feature/x', refs, 'remote.origin.url git@github.com:o/n.git\nremote.fork.url https://github.com/me/n.git\n');
	deepStrictEqual(state.upstream, { remote: 'origin', branch: 'feature/x', ahead: 2, behind: 1, gone: false, tracking: 'refs/remotes/origin/feature/x' });
	deepStrictEqual(state.remotes, [{ name: 'origin', url: 'git@github.com:o/n.git', defaultBranch: 'main' }, { name: 'fork', url: 'https://github.com/me/n.git' }]);
	strictEqual(parseGitBranches('refs/heads/main', refs).upstream?.ahead, 0);
	strictEqual(parseGitBranches('refs/heads/main', refs).remotes, undefined);
	deepStrictEqual(parseGitBranches('refs/heads/main', refs, '').remotes, []);
});

test('a branch tracking a local branch, or a remote with slashes in the branch, reads right', () => {
	strictEqual(parseGitBranches('refs/heads/a', 'refs/heads/a\0\0refs/heads/main\0.\0').upstream, undefined);
	deepStrictEqual(parseGitBranches('refs/heads/a', 'refs/heads/a\0\0refs/remotes/up/team/a\0up\0[gone]').upstream,
		{ remote: 'up', branch: 'team/a', ahead: 0, behind: 0, gone: true, tracking: 'refs/remotes/up/team/a' });
	// A fetch refspec mapping into another namespace: the name on the remote is `remoteref`'s.
	deepStrictEqual(parseGitBranches('refs/heads/a', 'refs/heads/a\0\0refs/remotes/up/mirror/dev\0up\0\0refs/heads/dev').upstream,
		{ remote: 'up', branch: 'dev', ahead: 0, behind: 0, gone: false, tracking: 'refs/remotes/up/mirror/dev' });
});

test('track, remote urls, the remote to publish to and the default branch', () => {
	deepStrictEqual(parseTrack('[ahead 3]'), { ahead: 3, behind: 0, gone: false });
	deepStrictEqual(parseTrack('[behind 12]'), { ahead: 0, behind: 12, gone: false });
	deepStrictEqual(parseTrack(''), { ahead: 0, behind: 0, gone: false });
	deepStrictEqual(parseRemoteUrls('remote.a.url x\nremote.a.url y\nremote.b.c.url z'), [{ name: 'a', url: 'x' }, { name: 'b.c', url: 'z' }]);
	// Credentials never leave the host with the state; an ssh user is no credential.
	deepStrictEqual(parseRemoteUrls('remote.a.url https://me:ghp_secret@github.com/o/n.git\nremote.b.url git@github.com:o/n.git'),
		[{ name: 'a', url: 'https://github.com/o/n.git' }, { name: 'b', url: 'git@github.com:o/n.git' }]);
	strictEqual(publishRemote(['up', 'origin']), 'origin');
	strictEqual(publishRemote(['up']), 'up');
	strictEqual(publishRemote(['up', 'fork']), undefined);
	strictEqual(publishRemote(['up', 'fork'], 'fork'), 'fork');
	strictEqual(publishRemote(['up'], 'other'), undefined);
	strictEqual(pushesDefaultBranch('main'), true);
	strictEqual(pushesDefaultBranch('main', 'develop'), false);
	strictEqual(pushesDefaultBranch('develop', 'develop'), true);
});

test('the ref format reads a real repository with an upstream', () => {
	const root = mkdtempSync(path.join(os.tmpdir(), 'ai-browser-upstream-'));
	const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=' + os.devNull,
		'-c', 'commit.gpgsign=false', '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args],
		{ cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
	try {
		const remote = path.join(root, 'remote.git');
		const work = path.join(root, 'work');
		git(root, 'init', '--bare', '-b', 'main', remote);
		git(root, 'clone', remote, work);
		git(work, 'commit', '--allow-empty', '-m', 'one');
		git(work, 'push', '-u', 'origin', 'main');
		git(work, 'commit', '--allow-empty', '-m', 'two');
		git(work, 'switch', '-c', 'side');
		const read = () => parseGitBranches(git(work, 'symbolic-ref', 'HEAD'),
			git(work, 'for-each-ref', `--format=${branchRefFormat}`, 'refs/heads/', 'refs/remotes/'),
			git(work, 'config', '--get-regexp', '^remote\\..*\\.url$'));
		strictEqual(read().upstream, undefined);
		deepStrictEqual(read().remotes?.map(r => r.name), ['origin']);
		git(work, 'switch', 'main');
		deepStrictEqual(read().upstream, { remote: 'origin', branch: 'main', ahead: 1, behind: 0, gone: false, tracking: 'refs/remotes/origin/main' });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
