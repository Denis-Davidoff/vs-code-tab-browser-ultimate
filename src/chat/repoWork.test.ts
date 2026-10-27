import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import type * as RepoWork from './repoWork.ts';

for (const detached of [false, true]) {
	test(`remove managed copy preserves an unowned branch with ${detached ? 'detached HEAD' : 'attached branch'}`, async () => {
		const scratch = mkdtempSync(join(tmpdir(), 'repo-remove-test-'));
		try {
			// Load the production modules as CommonJS, as the extension does.
			for (const name of ['repoWork', 'githubRepo']) {
				const source = readFileSync(resolve('src/chat', `${name}.ts`), 'utf8');
				writeFileSync(join(scratch, `${name}.js`), transpileModule(source, {
					compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
				}).outputText);
			}
			const require = createRequire(join(scratch, 'fixture.cjs'));
			const { removeStoredCopy, isOurWorktree } = require('./repoWork.js') as typeof RepoWork;
			const storage = join(scratch, 'storage');
			const base = join(storage, 'github/owner/repo/base');
			const copies = join(storage, 'github/owner/repo/copies');
			const copy = join(copies, 'work');
			mkdirSync(base, { recursive: true });
			mkdirSync(copies, { recursive: true });
			const git = (args: string[], cwd = base) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
			git(['init']);
			git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'Initial']);
			git(['worktree', 'add', '-b', 'work', copy]);
			if (detached) { git(['checkout', '--detach'], copy); }
			assert.equal(await isOurWorktree(storage, { owner: 'owner', name: 'repo' }, copy), true);
			await removeStoredCopy('git', storage, copy);
			assert.equal(existsSync(copy), false);
			assert.ok(!git(['worktree', 'list', '--porcelain']).includes(copy));
			// A branch not created for this generated copy must survive its worktree's removal.
			assert.equal(git(['branch', '--list', 'work']).trim().length > 0, true);
			assert.equal(existsSync(join(base, '.git')), true);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
}

test('push sends the branch checked out now, not the one the chat recorded', async () => {
	const scratch = mkdtempSync(join(tmpdir(), 'repo-push-test-'));
	const saved = { ...process.env };
	try {
		for (const name of ['repoWork', 'githubRepo']) {
			const source = readFileSync(resolve('src/chat', `${name}.ts`), 'utf8');
			writeFileSync(join(scratch, `${name}.js`), transpileModule(source, {
				compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
			}).outputText);
		}
		const require = createRequire(join(scratch, 'fixture.cjs'));
		const { pushCopy } = require('./repoWork.js') as typeof RepoWork;
		Object.assign(process.env, { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' });
		const remote = join(scratch, 'remote.git');
		const copy = join(scratch, 'copy');
		const git = (args: string[], cwd = copy) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
		execFileSync('git', ['init', '--bare', '--initial-branch=main', remote]);
		execFileSync('git', ['clone', remote, copy], { stdio: 'pipe' });
		git(['checkout', '-b', 'main']);
		git(['commit', '--allow-empty', '-m', 'Initial']);
		git(['push', 'origin', 'main']);
		git(['checkout', '-b', 'ai-browser/recorded']);
		// An agent moves the copy to another branch, then changes a file.
		git(['checkout', '-b', 'feature']);
		writeFileSync(join(copy, 'work.txt'), 'new work\n');
		assert.equal(await pushCopy('git', copy, 'main', 'Work'), 'feature');
		assert.match(git(['log', '--format=%s', 'refs/heads/feature'], remote), /^Work$/m);
		assert.equal(git(['branch', '--list', 'ai-browser/recorded'], remote).trim(), '');
		git(['checkout', '--detach']);
		await assert.rejects(pushCopy('git', copy, 'main', 'Work'), /detached/);
	} finally {
		process.env = saved;
		rmSync(scratch, { recursive: true, force: true });
	}
});
