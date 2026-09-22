/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { ignoresConfigToml, withConfigTomlRule } from './gitignoreRule.ts';

suite('ignoresConfigToml', () => {

	test('recognises the shapes that name the file from its own directory', () => {
		for (const line of ['config.toml', '/config.toml', '*', '*.toml', '  config.toml  ']) {
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
