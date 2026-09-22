/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, test } from 'node:test';
import {
	existingPrivateTempDirectory, privateTempDirectory, resetPrivateTempDirectory, writeExclusive, writeFileAtomic,
} from './safeFiles.ts';

const posix = process.platform !== 'win32';

async function scratch(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), 'ai-browser-safe-test-'));
}

/** Runs `body` with `os.tmpdir()` pointed at a scratch directory. */
async function withTmpdir<T>(body: (tmp: string) => Promise<T>): Promise<T> {
	const tmp = await scratch();
	const saved = process.env.TMPDIR;
	process.env.TMPDIR = tmp;
	try {
		return await body(tmp);
	} finally {
		if (saved === undefined) {
			delete process.env.TMPDIR;
		} else {
			process.env.TMPDIR = saved;
		}
	}
}

const modeOf = async (p: string) => (await fs.stat(p)).mode & 0o777;

suite('privateTempDirectory', { skip: !posix }, () => {

	test('creates a per-user root that only this user can enter', () => withTmpdir(async tmp => {
		const dir = await privateTempDirectory('screenshots');
		assert.strictEqual(path.dirname(path.dirname(dir)), tmp);
		assert.strictEqual(await modeOf(path.dirname(dir)), 0o700);
	}));

	// Somebody else created the predictable root first and pointed it at a
	// directory of their choosing: it must not be used.
	test('a planted symlink at the root is not followed', () => withTmpdir(async tmp => {
		const decoy = await scratch();
		await fs.symlink(decoy, path.join(tmp, `ai-browser-${process.getuid!()}`));
		const dir = await privateTempDirectory('reports');
		assert.ok(!dir.startsWith(path.join(tmp, `ai-browser-${process.getuid!()}`)));
		assert.deepStrictEqual(await fs.readdir(decoy), []);
		assert.strictEqual(await modeOf(path.dirname(dir)), 0o700);
	}));

	test('a root that others can enter is not used', () => withTmpdir(async tmp => {
		resetPrivateTempDirectory();
		const root = path.join(tmp, `ai-browser-${process.getuid!()}`);
		await fs.mkdir(root);
		await fs.chmod(root, 0o777);
		const dir = await privateTempDirectory('x');
		assert.ok(!dir.startsWith(root));
		resetPrivateTempDirectory();
	}));

	// A fresh substitute per call put every file in a directory of its own,
	// so the sweep never found anything to retire.
	test('the substitute root is made once, not per call', () => withTmpdir(async tmp => {
		resetPrivateTempDirectory();
		const root = path.join(tmp, `ai-browser-${process.getuid!()}`);
		await fs.mkdir(root);
		await fs.chmod(root, 0o755);
		const first = await privateTempDirectory('screenshots');
		const second = await privateTempDirectory('screenshots');
		assert.strictEqual(first, second);
		assert.strictEqual(await existingPrivateTempDirectory('screenshots'), first);
		resetPrivateTempDirectory();
	}));

	test('looking for the directory does not create it', () => withTmpdir(async tmp => {
		resetPrivateTempDirectory();
		assert.strictEqual(await existingPrivateTempDirectory('reports'), undefined);
		assert.deepStrictEqual(await fs.readdir(tmp), []);
	}));
});

suite('writeExclusive', () => {

	test('a second write in the same second gets its own file', async () => {
		const dir = await scratch();
		const first = await writeExclusive(dir, 'element-css-div-143207.md', 'one');
		const second = await writeExclusive(dir, 'element-css-div-143207.md', 'two');
		assert.notStrictEqual(first, second);
		assert.strictEqual(path.basename(second), 'element-css-div-143207-2.md');
		assert.strictEqual(await fs.readFile(first, 'utf8'), 'one');
		assert.strictEqual(await fs.readFile(second, 'utf8'), 'two');
	});

	test('a symlink at the name is never written through', { skip: !posix }, async () => {
		const dir = await scratch();
		const victim = path.join(await scratch(), 'victim');
		await fs.writeFile(victim, 'keep');
		await fs.symlink(victim, path.join(dir, 'shot.png'));
		await writeExclusive(dir, 'shot.png', 'page content');
		assert.strictEqual(await fs.readFile(victim, 'utf8'), 'keep');
	});

	test('the file is private', { skip: !posix }, async () => {
		const file = await writeExclusive(await scratch(), 'a.md', 'x');
		assert.strictEqual(await modeOf(file), 0o600);
	});
});

suite('writeFileAtomic', () => {

	test('replaces the contents and leaves no temp file', async () => {
		const dir = await scratch();
		const file = path.join(dir, 'config.toml');
		await fs.writeFile(file, 'old');
		await writeFileAtomic(file, 'new');
		assert.strictEqual(await fs.readFile(file, 'utf8'), 'new');
		assert.deepStrictEqual(await fs.readdir(dir), ['config.toml']);
	});

	test('an existing file keeps its mode, a new one is private', { skip: !posix }, async () => {
		const dir = await scratch();
		const existing = path.join(dir, 'a');
		await fs.writeFile(existing, 'x');
		await fs.chmod(existing, 0o640);
		await writeFileAtomic(existing, 'y');
		assert.strictEqual(await modeOf(existing), 0o640);

		const fresh = path.join(dir, 'b');
		await writeFileAtomic(fresh, 'y');
		assert.strictEqual(await modeOf(fresh), 0o600);
	});

	// A link to a config that does not exist yet is how a dotfiles repo is
	// wired in before first use; `realpath` fails on it, and the fallback
	// replaced the link with a regular file.
	test('a dangling link is kept, and its target created', { skip: !posix }, async () => {
		const repo = await scratch();
		const real = path.join(repo, 'argv.json');
		const home = await scratch();
		const link = path.join(home, 'argv.json');
		await fs.symlink('../' + path.basename(repo) + '/argv.json', link);

		await writeFileAtomic(link, '{}');
		assert.ok((await fs.lstat(link)).isSymbolicLink());
		assert.strictEqual(await fs.readFile(real, 'utf8'), '{}');
	});

	// `rename` asks the directory, not the file; a config made read-only on
	// purpose must refuse the way a plain write did.
	test('a read-only target is refused, and left as it was', { skip: !posix || process.getuid?.() === 0 }, async () => {
		const dir = await scratch();
		const file = path.join(dir, 'config.toml');
		await fs.writeFile(file, 'keep');
		await fs.chmod(file, 0o444);
		await assert.rejects(writeFileAtomic(file, 'new'), { code: 'EACCES' });
		assert.strictEqual(await fs.readFile(file, 'utf8'), 'keep');
		assert.deepStrictEqual(await fs.readdir(dir), ['config.toml']);
	});

	// Dotfiles setups link the config into a repository; replacing the link
	// with a regular file would detach it from there.
	test('a symlinked config is written through and stays a link', { skip: !posix }, async () => {
		const repo = await scratch();
		const real = path.join(repo, 'config.toml');
		await fs.writeFile(real, 'old');
		const home = await scratch();
		const link = path.join(home, 'config.toml');
		await fs.symlink(real, link);

		await writeFileAtomic(link, 'new');
		assert.ok((await fs.lstat(link)).isSymbolicLink());
		assert.strictEqual(await fs.readFile(real, 'utf8'), 'new');
		assert.deepStrictEqual(await fs.readdir(repo), ['config.toml']);
	});
});
