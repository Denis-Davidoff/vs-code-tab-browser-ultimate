/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { codexEntries, codexRangeDeletable, codexUnterminated, scanLine } from './codexToml.ts';

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

	test('a quoted key is the same key', () => {
		// TOML says `"url" = …` and `url = …` are one key, and reading the
		// quoted form as *absent* is what let the repair write a second `url`
		// beside it — two definitions of one key, which is TOML that does not
		// parse, taking every MCP server in the file with it.
		const [entry] = codexEntries([
			'[mcp_servers.ours]',
			'"url" = "http://a"',
			"'http_headers' = { Authorization = \"Bearer t\" }",
		].join('\n'));

		assert.strictEqual(entry.values.get('url'), 'http://a');
		assert.strictEqual(entry.valueLines.get('url'), 1);
		assert.strictEqual(entry.values.get('http_headers'), '{ Authorization = "Bearer t" }');
	});

	test('a `#` inside a quoted key is still not a comment', () => {
		const [entry] = codexEntries('[mcp_servers.ours]\n"ur#l" = "http://a"\n');
		assert.strictEqual(entry.values.get('ur#l'), 'http://a');
	});

	test('an empty file yields nothing', () => {
		assert.deepStrictEqual(codexEntries(''), []);
	});
});

suite('codexUnterminated', () => {

	test('a well-formed file terminates', () => {
		assert.strictEqual(codexUnterminated([
			'[mcp_servers.a]', 'url = "http://x/mcp"', 'enabled_tools = ["a", "b"]', '',
		].join('\n')), false);
	});

	test('a multi-line array that closes terminates', () => {
		assert.strictEqual(codexUnterminated([
			'[mcp_servers.a]', 'enabled_tools = [', '  "a",', ']', '',
		].join('\n')), false);
	});

	test('an unclosed array does not', () => {
		assert.strictEqual(codexUnterminated([
			'[mcp_servers.a]', 'enabled_tools = [', '  "a",', '',
		].join('\n')), true);
	});

	test('an unclosed triple-quoted string does not', () => {
		assert.strictEqual(codexUnterminated([
			'[mcp_servers.a]', 'instructions = """', 'hello', '',
		].join('\n')), true);
	});

	test('a `[` inside a string is not structural', () => {
		assert.strictEqual(codexUnterminated([
			'[mcp_servers.a]', 'url = "http://x/mcp?a[b]"', 'note = "["', '',
		].join('\n')), false);
	});
});

suite('codexRangeDeletable', () => {

	// The regression it was written for. `  [3, 4]` is the last element of a
	// nested array, written without a trailing comma — well-formed TOML, and a
	// whole line that looks exactly like a table header.
	const nested = [
		'[mcp_servers.a]',
		'matrix = [',
		'  [1, 2],',
		'  [3, 4]',
		']',
		'',
		'[mcp_servers.b]',
		'url = "http://x/mcp"',
		'',
	].join('\n');

	test('a nested array is not mistaken for a table header', () => {
		assert.strictEqual(codexRangeDeletable(nested, 0, 5), true);
	});

	test('a range holding a second table is refused', () => {
		assert.strictEqual(codexRangeDeletable(nested, 0, 8), false);
	});

	// The other half of the rule, and the case a purely structural check is
	// blind to: once a value is left open, every later line reads as
	// continuation, so the real header below becomes invisible. The range never
	// closing is what catches it.
	test('a range that never closes is refused', () => {
		const open = [
			'[mcp_servers.a]',
			'enabled_tools = [',
			'',
			'[mcp_servers.someone-else]',
			'url = "http://x/mcp"',
			'',
		].join('\n');

		assert.strictEqual(codexRangeDeletable(open, 0, 6), false);
	});

	test('an ordinary table is deletable', () => {
		const plain = ['[mcp_servers.a]', 'url = "http://x/mcp"', ''].join('\n');
		assert.strictEqual(codexRangeDeletable(plain, 0, 2), true);
	});
});

suite('an escaped quote does not close a multi-line basic string', () => {

	// `\"""` is an escaped quote followed by two ordinary ones: content, not the
	// delimiter. Two of them on a line rebalance a scanner that ignores the
	// backslash, so the document reads as well-formed while prose inside the
	// string is reported as structure — and the repair would rewrite it.
	const text = [
		'[mcp_servers.ai-browser]',
		'url = "http://127.0.0.1:43110/mcp"',
		'notes = """say \\""" here',
		'[mcp_servers.not-a-real-table]',
		'still inside the string \\""" end"""',
		'',
	].join('\n');

	test('prose inside the string is not read as a table', () => {
		assert.deepStrictEqual(codexEntries(text).map(e => e.name), ['ai-browser']);
	});

	test('the document still terminates', () => {
		assert.strictEqual(codexUnterminated(text), false);
	});

	test('an escaped backslash still lets the delimiter close', () => {
		// `\\` is an escaped backslash, so the `"""` after it really does close.
		const closes = ['[mcp_servers.a]', 'note = """x\\\\"""', ''].join('\n');
		assert.strictEqual(codexUnterminated(closes), false);
	});

	test('a literal string treats a backslash as content', () => {
		const literal = ["[mcp_servers.a]", "note = '''x\\'''", ''].join('\n');
		assert.strictEqual(codexUnterminated(literal), false);
	});
});
suite('a deletion range never covers another table', () => {

	// CR-18. An unclosed `[` *before* a foreign header hides it from a purely
	// structural scan, and a later `]` rebalances the range so it ends at depth
	// zero — satisfying both halves of the old rule. The foreign server was
	// deleted and the confirmation named only the entry it meant to remove.
	test('a header hidden inside an unclosed array still stands the range off', () => {
		const text = [
			'[mcp_servers.ai-browser-old-abc123]',
			'enabled_tools = [',
			'[mcp_servers.someone-elses-server]',
			'url = "http://example.com/mcp"',
			']',
			'',
		].join('\n');

		assert.strictEqual(codexUnterminated(text), false, 'the document itself balances');
		assert.strictEqual(codexRangeDeletable(text, 0, 5), false);
	});

	// The same wound through the other door: `[`/`]` and `{`/`}` used to share
	// one counter, so a missing `}` was cancelled by a stray `]` — two ordinary
	// typos — and the whole document read as well-formed.
	test('an unclosed brace is not cancelled by a stray bracket', () => {
		const text = [
			'[mcp_servers.ai-browser-oldproj-abc123]',
			'http_headers = { Authorization = "Bearer x"',
			'',
			'[mcp_servers.github]',
			'args = ["run"]]',
			'',
		].join('\n');

		assert.strictEqual(codexUnterminated(text), true);
	});

	test('a brace and a bracket are counted apart', () => {
		assert.strictEqual(codexUnterminated('a = {\n'), true, 'unclosed inline table');
		assert.strictEqual(codexUnterminated('a = [\n'), true, 'unclosed array');
		assert.strictEqual(codexUnterminated('a = { b = 1 }\nc = [1]\n'), false, 'both balanced');
	});

	test('a credible header is refused wherever it hides', () => {
		const inString = [
			'[mcp_servers.a]',
			'note = """',
			'[mcp_servers.looks-real]',
			'"""',
			'',
		].join('\n');
		// A false refusal, and the deliberate direction: one untidied entry
		// beats deleting a table this parser cannot prove is prose.
		assert.strictEqual(codexRangeDeletable(inString, 0, 4), false);
	});

	test('array content that merely looks bracketed is still deletable', () => {
		const text = [
			'[mcp_servers.a]',
			'matrix = [',
			'  [1, 2],',
			'  [3, 4]',
			']',
			'',
		].join('\n');

		assert.strictEqual(codexRangeDeletable(text, 0, 5), true);
	});
});
