import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { branchCommand, parseGitBranches } from './gitBranchState.ts';

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
