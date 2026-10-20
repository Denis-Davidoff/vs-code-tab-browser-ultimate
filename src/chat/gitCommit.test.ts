import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { commitChanges, commitContext, type CommitGit } from './gitCommit.ts';

const exec = promisify(execFile);
async function inRepo(work: (git: CommitGit, folder: string) => Promise<void>, initial = true): Promise<void> {
	const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-browser-commit-test-'));
	const git: CommitGit = async args => (await exec('git', ['-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'user.name=Commit Test', '-c', 'user.email=commit@example.invalid', ...args], { cwd: folder })).stdout;
	try {
		await git(['init', '-b', 'main']);
		await git(['config', 'core.hooksPath', path.join(folder, '.git', 'hooks')]);
		if (initial) {
			await fs.writeFile(path.join(folder, 'a.txt'), 'before a\n');
			await fs.writeFile(path.join(folder, 'b.txt'), 'before b\n');
			await git(['add', '.']); await git(['commit', '-m', 'initial']);
		}
		await work(git, folder);
	} finally { await fs.rm(folder, { recursive: true, force: true }); }
}
const guard = () => {};
const phase = () => {};

test('Commit respects an existing staged selection and passes generated text as one literal argument', async () => {
	await inRepo(async (git, folder) => {
		await fs.writeFile(path.join(folder, 'a.txt'), 'after a\n');
		await git(['add', 'a.txt']);
		await fs.writeFile(path.join(folder, 'a.txt'), 'later unstaged a\n');
		await fs.writeFile(path.join(folder, 'b.txt'), 'unstaged b\n');
		await fs.writeFile(path.join(folder, 'untracked.txt'), 'new file\n');
		const message = 'fix: preserve `quotes` and $(literal)\n\nKeep the selected change.';
		const result = await commitChanges(git, async context => {
			assert.match(context, /after a/); assert.doesNotMatch(context, /later unstaged|unstaged b|new file/);
			return message;
		}, guard, phase);
		assert.equal(result.message, message);
		assert.equal((await git(['log', '-1', '--format=%B'])).trim(), message);
		assert.equal((await git(['show', 'HEAD:a.txt'])).trim(), 'after a');
		assert.match(await git(['status', '--porcelain']), / M a.txt/);
		assert.match(await git(['status', '--porcelain']), / M b.txt/);
		assert.match(await git(['status', '--porcelain']), /\?\? untracked.txt/);
	});
});

test('empty index stages tracked changes, deletions and new files before generating the message', async () => {
	await inRepo(async (git, folder) => {
		await fs.writeFile(path.join(folder, 'a.txt'), 'after a\n');
		await fs.rm(path.join(folder, 'b.txt'));
		await fs.writeFile(path.join(folder, 'new.txt'), 'new file\n');
		const phases: string[] = [];
		await commitChanges(git, async context => {
			assert.match(context, /a.txt/); assert.match(context, /b.txt/); assert.match(context, /new.txt/);
			return 'Update repository files';
		}, guard, p => phases.push(p));
		assert.deepEqual(phases, ['generating', 'committing']);
		assert.equal((await git(['status', '--porcelain'])).trim(), '');
	});
});

test('initial commits work without history; clean repositories never call the model', async () => {
	await inRepo(async (git, folder) => {
		await fs.writeFile(path.join(folder, 'first.txt'), 'first');
		await commitChanges(git, async () => 'Initial files', guard, phase);
		assert.equal((await git(['rev-list', '--count', 'HEAD'])).trim(), '1');
		await assert.rejects(commitChanges(git, async () => { assert.fail('model called for clean repo'); }, guard, phase), /No changes to commit/);
	}, false);
});

test('changes to the staged tree or branch during generation prevent a stale commit', async () => {
	for (const change of ['index', 'branch']) {
		await inRepo(async (git, folder) => {
			const head = await git(['rev-parse', 'HEAD']);
			await fs.writeFile(path.join(folder, 'a.txt'), 'after a');
			await assert.rejects(commitChanges(git, async () => {
				if (change === 'index') { await fs.writeFile(path.join(folder, 'b.txt'), 'after b'); await git(['add', 'b.txt']); }
				else { await git(['switch', '-c', 'other']); }
				return 'Message for the earlier snapshot';
			}, guard, phase), /staged files or branch changed/);
			assert.equal(await git(['rev-parse', 'HEAD']), head);
		});
	}
});

test('model errors preserve changes without committing and hook failures surface Git diagnostics', async () => {
	await inRepo(async (git, folder) => {
		const head = await git(['rev-parse', 'HEAD']);
		await fs.writeFile(path.join(folder, 'a.txt'), 'after a');
		await assert.rejects(commitChanges(git, async () => { throw new Error('Model quota exceeded'); }, guard, phase), /Model quota exceeded/);
		assert.equal(await git(['rev-parse', 'HEAD']), head);
		assert.match(await git(['diff', '--cached']), /after a/);
		if (process.platform !== 'win32') {
			await fs.writeFile(path.join(folder, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "Required formatting check failed" >&2\nexit 1\n', { mode: 0o700 });
			await assert.rejects(commitChanges(git, async () => 'Update a', guard, phase), /Required formatting check failed/);
			assert.equal(await git(['rev-parse', 'HEAD']), head);
		}
	});
});

test('commit context stays bounded and marks a truncated diff', () => {
	const context = commitContext('a'.repeat(50_000), 'x'.repeat(200_000), 'history'.repeat(1000));
	assert.ok(context.length <= 120_000);
	assert.match(context, /Diff truncated/);
});


test('a selected subdirectory still commits and describes staged files from the whole repository', async () => {
	await inRepo(async (git, folder) => {
		await fs.mkdir(path.join(folder, 'sub'));
		await git(['config', 'diff.relative', 'true']);
		await fs.writeFile(path.join(folder, 'a.txt'), 'updated from repository root');
		await git(['add', 'a.txt']);
		const nestedGit: CommitGit = args => git(['-C', path.join(folder, 'sub'), ...args]);
		await commitChanges(nestedGit, async context => {
			assert.match(context, /a.txt/);
			assert.match(context, /updated from repository root/);
			return 'Update root file';
		}, guard, phase);
		assert.equal((await git(['status', '--porcelain'])).trim(), '');
	});
});

test('explicit staged scope never silently adds unstaged files; explicit all scope includes both groups', async () => {
 await inRepo(async (git, folder) => {
  await fs.writeFile(path.join(folder, 'a.txt'), 'unstaged a');
  await assert.rejects(commitChanges(git, async () => 'must not run', guard, phase, 'staged'), /No staged changes/);
  assert.equal((await git(['diff', '--cached', '--name-only'])).trim(), '');
  await git(['add', 'a.txt']);
  await fs.writeFile(path.join(folder, 'b.txt'), 'unstaged b');
  await commitChanges(git, async context => {
   assert.match(context, /unstaged a/); assert.match(context, /unstaged b/);
   return 'Update both files';
  }, guard, phase, 'all');
  assert.equal((await git(['status', '--porcelain'])).trim(), '');
 });
});

test('commit context names the branch, where a task ID usually is', () => {
	assert.match(commitContext('M\ta.ts', 'diff', 'feat: x', 'feature/ABC-123-login\nignored'), /^Branch: feature\/ABC-123-login\n\n/);
	assert.doesNotMatch(commitContext('M\ta.ts', 'diff', 'feat: x', ''), /Branch:/);
});
