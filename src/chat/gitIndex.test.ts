import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { changeGitIndex } from './gitIndex.ts';
import { parseGitStatus } from './gitStatus.ts';

async function repository(work: (git: (args: readonly string[]) => Promise<string>, folder: string) => Promise<void>, initial = true): Promise<void> {
	const folder = mkdtempSync(path.join(os.tmpdir(), 'ai-browser-index-'));
	const git = async (args: readonly string[]) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'user.name=Index Test', '-c', 'user.email=index@example.invalid', '-c', `core.hooksPath=${os.devNull}`, ...args], { cwd: folder, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
	try {
		await git(['init', '-b', 'main']);
		if (initial) {
			writeFileSync(path.join(folder, 'a.txt'), 'before a');
			writeFileSync(path.join(folder, 'b.txt'), 'before b');
			await git(['add', '.']); await git(['commit', '-m', 'initial']);
		}
		await work(git, folder);
	} finally { rmSync(folder, { recursive: true, force: true }); }
}
const statusArgs = ['status', '--porcelain=v1', '-z', '--untracked-files=all'];

test('stage/unstage an individual file from a subdirectory without changing other files', async () => {
	await repository(async (git, folder) => {
		mkdirSync(path.join(folder, 'sub'));
		const nested = (args: readonly string[]) => git(['-C', path.join(folder, 'sub'), ...args]);
		writeFileSync(path.join(folder, 'a.txt'), 'after a'); writeFileSync(path.join(folder, 'b.txt'), 'after b');
		await changeGitIndex(nested, parseGitStatus(await nested(statusArgs)), 'stage', 'a.txt');
		assert.equal((await git(['diff', '--cached', '--name-only'])).trim(), 'a.txt');
		writeFileSync(path.join(folder, 'a.txt'), 'later working change');
		await changeGitIndex(nested, parseGitStatus(await nested(statusArgs)), 'unstage', 'a.txt');
		assert.equal((await git(['diff', '--cached', '--name-only'])).trim(), '');
		assert.equal(readFileSync(path.join(folder, 'a.txt'), 'utf8'), 'later working change');
		assert.equal(readFileSync(path.join(folder, 'b.txt'), 'utf8'), 'after b');
	});
});

test('group actions stage additions/modifications/deletions and undo only the index', async () => {
	await repository(async (git, folder) => {
		writeFileSync(path.join(folder, 'a.txt'), 'after a'); rmSync(path.join(folder, 'b.txt'));
		writeFileSync(path.join(folder, 'new.txt'), 'new');
		await changeGitIndex(git, parseGitStatus(await git(statusArgs)), 'stage');
		assert.equal(parseGitStatus(await git(statusArgs)).staged.length, 3);
		await changeGitIndex(git, parseGitStatus(await git(statusArgs)), 'unstage');
		assert.equal((await git(['diff', '--cached', '--name-only'])).trim(), '');
		assert.equal(readFileSync(path.join(folder, 'a.txt'), 'utf8'), 'after a');
		assert.equal(readFileSync(path.join(folder, 'new.txt'), 'utf8'), 'new');
		assert.equal(parseGitStatus(await git(statusArgs)).unstaged.length, 3);
	});
});

test('unstaging a rename restores both index paths without restoring the working file', async () => {
	await repository(async (git, folder) => {
		renameSync(path.join(folder, 'a.txt'), path.join(folder, 'renamed.txt'));
		await git(['add', '--all']);
		const status = parseGitStatus(await git(statusArgs));
		assert.equal(status.staged[0].originalPath, 'a.txt');
		await changeGitIndex(git, status, 'unstage', 'renamed.txt');
		assert.equal((await git(['diff', '--cached', '--name-only'])).trim(), '');
		assert.equal(readFileSync(path.join(folder, 'renamed.txt'), 'utf8'), 'before a');
	});
});

test('unstage works before the first commit and preserves newer unstaged contents', async () => {
	await repository(async (git, folder) => {
		writeFileSync(path.join(folder, 'first.txt'), 'first version');
		await changeGitIndex(git, parseGitStatus(await git(statusArgs)), 'stage');
		writeFileSync(path.join(folder, 'first.txt'), 'newer working version');
		await changeGitIndex(git, parseGitStatus(await git(statusArgs)), 'unstage');
		assert.equal((await git(['ls-files'])).trim(), '');
		assert.equal(readFileSync(path.join(folder, 'first.txt'), 'utf8'), 'newer working version');
	}, false);
});

test('file actions treat wildcard filenames literally and reject paths absent from the selected group', async () => {
	await repository(async (git, folder) => {
		const literal = '*[1].txt';
		writeFileSync(path.join(folder, literal), 'literal'); writeFileSync(path.join(folder, 'x1.txt'), 'other');
		await changeGitIndex(git, parseGitStatus(await git(statusArgs)), 'stage', literal);
		assert.equal((await git(['diff', '--cached', '--name-only'])).trim(), literal);
		await assert.rejects(changeGitIndex(git, parseGitStatus(await git(statusArgs)), 'stage', '../outside'), /no longer in that group/);
		assert.equal((await git(['diff', '--cached', '--name-only'])).trim(), literal);
	});
});
