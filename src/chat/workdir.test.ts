/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ignoreMatcher, listWorkdir } from './workdir.ts';

describe('ignoreMatcher', () => {
	test('an unanchored name matches at any depth', () => {
		const ignored = ignoreMatcher('dist\n*.log\n');
		assert.ok(ignored('dist', true));
		assert.ok(ignored('packages/a/dist', true));
		assert.ok(ignored('a/b/debug.log', false));
		assert.ok(!ignored('distance.ts', false));
	});

	test('a leading or inner slash anchors at the root', () => {
		const ignored = ignoreMatcher('/out\nmedia/index.js\n');
		assert.ok(ignored('out', true));
		assert.ok(!ignored('src/out', true));
		assert.ok(ignored('media/index.js', false));
		assert.ok(!ignored('x/media/index.js', false));
	});

	test('a trailing slash is for folders only', () => {
		const ignored = ignoreMatcher('build/\n');
		assert.ok(ignored('build', true));
		assert.ok(!ignored('build', false));
	});

	test('** spans folders; comments, blanks and negations are skipped', () => {
		const ignored = ignoreMatcher('# comment\n\n!keep.log\na/**/z\n');
		assert.ok(ignored('a/z', false));
		assert.ok(ignored('a/b/c/z', false));
		assert.ok(!ignored('keep.log', false));
	});

	test('? is one character, escapes are literal', () => {
		const ignored = ignoreMatcher('file?.txt\n\\#hash\n');
		assert.ok(ignored('file1.txt', false));
		assert.ok(!ignored('file10.txt', false));
		assert.ok(ignored('#hash', false));
	});
});

describe('listWorkdir', () => {
	let root: string;

	before(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), 'workdir-test-'));
		await mkdir(path.join(root, 'src', 'deep'), { recursive: true });
		await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
		await mkdir(path.join(root, '.git'), { recursive: true });
		await mkdir(path.join(root, 'out'), { recursive: true });
		await writeFile(path.join(root, '.gitignore'), 'out/\n*.log\n');
		await writeFile(path.join(root, 'README.md'), '');
		await writeFile(path.join(root, 'debug.log'), '');
		await writeFile(path.join(root, 'src', 'a.ts'), '');
		await writeFile(path.join(root, 'src', 'deep', 'b.ts'), '');
		await writeFile(path.join(root, 'out', 'a.js'), '');
		await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), '');
		await symlink(os.tmpdir(), path.join(root, 'link'));
	});

	after(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test('lists breadth first, folders with a slash, skipping what is ignored', async () => {
		const listing = await listWorkdir(root);
		assert.deepStrictEqual(listing.entries, ['.gitignore', 'link', 'README.md', 'src/', 'src/a.ts', 'src/deep/', 'src/deep/b.ts']);
		assert.strictEqual(listing.truncated, false);
	});

	test('a walk past its time answers what it has, marked cut', async () => {
		let t = 0;
		const listing = await listWorkdir(root, () => (t += 2_000));
		assert.strictEqual(listing.truncated, true);
	});

	test('a folder that cannot be read lists nothing', async () => {
		const listing = await listWorkdir(path.join(root, 'missing'));
		assert.deepStrictEqual(listing.entries, []);
	});
});

describe('ignoreMatcher on hostile patterns', () => {
	test('a pattern that backtracks a regular expression answers at once', () => {
		const ignored = ignoreMatcher('*a*a*a*a*a*a*a*a*a*a*a*a*b\na/**/**/**/**/**/**/z\n');
		const started = Date.now();
		assert.ok(!ignored('a'.repeat(5_000), false));
		assert.ok(!ignored(`a/${'x/'.repeat(200)}y`, false));
		assert.ok(Date.now() - started < 1_000);
	});

	test('a trailing escaped space is part of the pattern', () => {
		const ignored = ignoreMatcher('name\\ \nother   \n');
		assert.ok(ignored('name ', false));
		assert.ok(ignored('other', false));
	});
});
