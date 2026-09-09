/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { codexEntries, scanLine } from './codexToml.ts';

suite('scanLine', () => {

	test('a # inside a string is not a comment', () => {
		const { code } = scanLine('url = "http://127.0.0.1:43110/mcp#frag"');
		assert.ok(code.startsWith('url = '));
		assert.ok(!code.includes('frag'), 'string contents are blanked, not kept');
	});

	test('brackets inside strings do not open an array', () => {
		assert.strictEqual(scanLine('name = "[mcp_servers.x]"').depth, 0);
	});

	test('reports an unclosed array so later lines are treated as continuation', () => {
		assert.strictEqual(scanLine('enabled_tools = [').depth, 1);
		assert.strictEqual(scanLine('  "a", "b",').depth, 0);
		assert.strictEqual(scanLine(']').depth, -1);
	});

	test('opens and closes triple-quoted strings', () => {
		assert.strictEqual(scanLine('note = """').multiline, '"""');
		assert.strictEqual(scanLine('still prose', '"""').multiline, '"""');
		assert.strictEqual(scanLine('done"""', '"""').multiline, undefined);
	});

	test('extra closing quotes belong to the content', () => {
		assert.strictEqual(scanLine('end""""', '"""').multiline, undefined);
		assert.strictEqual(scanLine('end"""""', '"""').multiline, undefined);
	});

	test('triple quotes inside a literal string open nothing', () => {
		assert.strictEqual(scanLine('note = \'use """ for prose\'').multiline, undefined);
	});
});

suite('codexEntries', () => {

	test('finds a table and its values', () => {
		const entries = codexEntries([
			'[mcp_servers.ai-browser]',
			'url = "http://127.0.0.1:43110/mcp/abc"',
		].join('\n'));

		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0].name, 'ai-browser');
		assert.strictEqual(entries[0].values.get('url'), 'http://127.0.0.1:43110/mcp/abc');
		assert.strictEqual(entries[0].firstLine, 0);
		assert.strictEqual(entries[0].endLine, 2);
	});

	test('a trailing comment is not part of the value', () => {
		const [entry] = codexEntries('[mcp_servers.x]\nurl = "http://h/mcp" # ours\n');
		assert.strictEqual(entry.values.get('url'), 'http://h/mcp');
	});

	test('a comment above the next table is left to that table', () => {
		const entries = codexEntries([
			'[mcp_servers.ours]',
			'url = "http://a"',
			'',
			'# someone else, do not touch',
			'[mcp_servers.theirs]',
			'url = "http://b"',
		].join('\n'));

		assert.strictEqual(entries.length, 2);
		// endLine stops after the last key, so the comment stays outside.
		assert.strictEqual(entries[0].endLine, 2);
		assert.strictEqual(entries[1].name, 'theirs');
	});

	test('a table header inside a multi-line value is prose', () => {
		const entries = codexEntries([
			'[mcp_servers.real]',
			'instructions = """',
			'[mcp_servers.fake]',
			'url = "http://nope"',
			'"""',
			'url = "http://real"',
		].join('\n'));

		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0].name, 'real');
		assert.strictEqual(entries[0].values.get('url'), 'http://real');
		assert.strictEqual(entries[0].values.get('nope'), undefined);
	});

	test('a multi-line array does not end the table', () => {
		const [entry] = codexEntries([
			'[mcp_servers.ours]',
			'enabled_tools = [',
			'  "browser_state",',
			']',
			'url = "http://a"',
		].join('\n'));

		assert.strictEqual(entry.values.get('url'), 'http://a');
	});

	test('a non-mcp table ends ours', () => {
		const entries = codexEntries([
			'[mcp_servers.ours]',
			'url = "http://a"',
			'[history]',
			'persistence = "none"',
		].join('\n'));

		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0].endLine, 2);
	});

	test('records the line of each key for surgical edits', () => {
		const [entry] = codexEntries([
			'# header',
			'[mcp_servers.ours]',
			'name = "x"',
			'url = "http://a"',
		].join('\n'));

		assert.strictEqual(entry.valueLines.get('url'), 3);
	});

	test('quoted table names are unquoted', () => {
		const [entry] = codexEntries('[mcp_servers."ai-browser-abc123"]\nurl = "http://a"\n');
		assert.strictEqual(entry.name, 'ai-browser-abc123');
	});

	test('an empty file yields nothing', () => {
		assert.deepStrictEqual(codexEntries(''), []);
	});
});
