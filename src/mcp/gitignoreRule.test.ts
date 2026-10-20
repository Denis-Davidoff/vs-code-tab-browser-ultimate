/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { ignoresConfigToml, withConfigTomlRule } from './gitignoreRule.ts';

suite('ignoresConfigToml', () => {

	test('recognises the shapes that name the file from its own directory', () => {
		for (const line of ['config.toml', '/config.toml', '*', '*.toml', 'config.toml  ']) {
			assert.strictEqual(ignoresConfigToml(`${line}\n`), true, line);
		}
	});

	// An existing `.codex/.gitignore` used to be taken as protection whatever
	// it said, leaving the token-bearing file free to be committed.
	test('a gitignore about something else does not cover it', () => {
		assert.strictEqual(ignoresConfigToml('cache/\nlogs/\n'), false);
		assert.strictEqual(ignoresConfigToml(''), false);
		assert.strictEqual(ignoresConfigToml('# config.toml\n'), false);
	});

	// Both read as protective while git leaves the file unignored.
	test('a leading space is part of the pattern, as in git', () => {
		assert.strictEqual(ignoresConfigToml(' config.toml\n'), false);
		assert.strictEqual(ignoresConfigToml('config.toml  \n'), true);
	});

	// Git drops unescaped trailing spaces and nothing else; each of these was
	// measured with `git check-ignore` (git 2.54).
	test('only unescaped trailing spaces are dropped, as in git', () => {
		assert.strictEqual(ignoresConfigToml('config.toml   \n'), true);
		assert.strictEqual(ignoresConfigToml('config.toml   \r\n'), true);
		assert.strictEqual(ignoresConfigToml('config.toml\t\n'), false);
		assert.strictEqual(ignoresConfigToml('config.toml \t\n'), false);
		assert.strictEqual(ignoresConfigToml('config.toml\t \n'), false);
		assert.strictEqual(ignoresConfigToml('*\t\n'), false);
		assert.strictEqual(ignoresConfigToml('config.toml\\ \n'), false);
		assert.strictEqual(ignoresConfigToml('config.toml\\  \n'), false);
		assert.strictEqual(withConfigTomlRule('config.toml\t\n'), 'config.toml\t\nconfig.toml\n');
	});

	test('a negation is still read as re-including, whatever whitespace trails it', () => {
		assert.strictEqual(ignoresConfigToml('config.toml\n!config.toml\t\n'), false);
		assert.strictEqual(ignoresConfigToml('config.toml\n!config.toml   \n'), false);
	});

	test('a negation it does not model is read as re-including the file', () => {
		for (const line of ['!config.*', '!*', '!c*', '!**/config.toml']) {
			assert.strictEqual(ignoresConfigToml(`config.toml\n${line}\n`), false, line);
		}
		assert.strictEqual(withConfigTomlRule('config.toml\n!config.*\n'), 'config.toml\n!config.*\nconfig.toml\n');
	});

	test('the last matching line wins, as in git', () => {
		assert.strictEqual(ignoresConfigToml('*\n!config.toml\n'), false);
		assert.strictEqual(ignoresConfigToml('!config.toml\nconfig.toml\n'), true);
	});
});

suite('withConfigTomlRule', () => {

	test('appends one line and keeps everything else', () => {
		assert.strictEqual(withConfigTomlRule('cache/\n'), 'cache/\nconfig.toml\n');
		assert.strictEqual(withConfigTomlRule('cache/'), 'cache/\nconfig.toml\n');
		assert.strictEqual(withConfigTomlRule(''), 'config.toml\n');
	});

	test('keeps CRLF', () => {
		assert.strictEqual(withConfigTomlRule('cache/\r\n'), 'cache/\r\nconfig.toml\r\n');
	});

	test('leaves a file that already covers it alone', () => {
		assert.strictEqual(withConfigTomlRule('config.toml\n'), undefined);
	});
});
