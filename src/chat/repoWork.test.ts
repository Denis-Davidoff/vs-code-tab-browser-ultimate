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
	test(`remove managed copy with ${detached ? 'detached HEAD' : 'attached branch'}`, async () => {
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
			assert.equal(git(['branch', '--list', 'work']).trim().length > 0, detached);
			assert.equal(existsSync(join(base, '.git')), true);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
}
