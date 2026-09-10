/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { codexEntries } from './codexToml.ts';
import { codexEntryCarriesToken } from './mcpClientState.ts';
import {
	codexOurTables, mergeAuthorization, parseInlineTable, repairClaudeJson, repairCodexToml,
} from './mcpRepair.ts';

const token = 'ourtoken0000000000000000000000000000000000000000000000000000abcd';
const foreign = 'theirs000000000000000000000000000000000000000000000000000000beef';
const url = 'http://127.0.0.1:43117/mcp';
const endpoint = { url, token, name: 'ai-browser' };

const repairToml = (text: string, name = 'ai-browser') =>
	repairCodexToml(text, codexEntries(text), { ...endpoint, name });

suite('repairClaudeJson', () => {

	test('corrects the port of an entry carrying our token', () => {
		const before = JSON.stringify({
			mcpServers: {
				'ai-browser': {
					type: 'http',
					url: 'http://127.0.0.1:43110/mcp',
					headers: { Authorization: `Bearer ${token}` },
				},
			},
		}, null, 2) + '\n';

		const result = repairClaudeJson(before, endpoint);
		assert.ok(result.changed);
		assert.strictEqual(JSON.parse(result.text).mcpServers['ai-browser'].url, url);
	});

	test('leaves other people\'s servers alone', () => {
		const before = JSON.stringify({
			mcpServers: {
				'someone-else': { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer other' } },
				'ai-browser': { type: 'http', url: 'http://127.0.0.1:43110/mcp', headers: { Authorization: `Bearer ${token}` } },
			},
		}, null, 2) + '\n';

		const after = JSON.parse(repairClaudeJson(before, endpoint).text);
		assert.deepStrictEqual(after.mcpServers['someone-else'], {
			type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer other' },
		});
	});

	test('an entry under our name but with a foreign token is not ours', () => {
		// It belongs to another workspace — very likely a file copied between
		// projects. Rewriting it would point that project at this window.
		const before = JSON.stringify({
			mcpServers: {
				'ai-browser': { type: 'http', url: 'http://127.0.0.1:43110/mcp', headers: { Authorization: `Bearer ${foreign}` } },
			},
		}, null, 2) + '\n';

		assert.strictEqual(repairClaudeJson(before, endpoint).changed, false);
	});

	test('collapses entries left behind by earlier releases', () => {
		const before = JSON.stringify({
			mcpServers: {
				'tab-browser': { type: 'http', url: `http://127.0.0.1:43111/mcp/${token}` },
				'ai-browser': { type: 'http', url: 'http://127.0.0.1:43110/mcp', headers: { Authorization: `Bearer ${token}` } },
			},
		}, null, 2) + '\n';

		const result = repairClaudeJson(before, endpoint);
		assert.deepStrictEqual(result.collapsed, ['tab-browser']);
		assert.deepStrictEqual(Object.keys(JSON.parse(result.text).mcpServers), ['ai-browser']);
	});

	test('an already correct file is left byte-identical', () => {
		// Repair runs on every start; rewriting an unchanged file would show up
		// as a spurious change in the user's working tree every time.
		const before = JSON.stringify({
			mcpServers: {
				'ai-browser': { type: 'http', url, headers: { Authorization: `Bearer ${token}` } },
			},
		}, null, 2) + '\n';

		const result = repairClaudeJson(before, endpoint);
		assert.strictEqual(result.changed, false);
		assert.strictEqual(result.text, before);
	});

	test('an unparsable file is refused, not rebuilt', () => {
		assert.strictEqual(repairClaudeJson('{ this is not json', endpoint).changed, false);
	});

	test('a file with no entry of ours is untouched', () => {
		const before = JSON.stringify({ mcpServers: { other: { url: 'http://x/' } } }, null, 2);
		assert.strictEqual(repairClaudeJson(before, endpoint).changed, false);
	});
});

suite('codexOurTables', () => {

	test('matches on the token, whether in a header or in the URL path', () => {
		const text = [
			`[mcp_servers.by-header]`,
			`url = "http://127.0.0.1:1/mcp"`,
			`http_headers = { Authorization = "Bearer ${token}" }`,
			``,
			`[mcp_servers.by-path]`,
			`url = "http://127.0.0.1:2/mcp/${token}"`,
			``,
			`[mcp_servers.not-ours]`,
			`url = "http://127.0.0.1:3/mcp"`,
			`http_headers = { Authorization = "Bearer ${foreign}" }`,
			``,
		].join('\n');

		assert.deepStrictEqual(codexOurTables(codexEntries(text), token), ['by-header', 'by-path']);
	});

	test('a sub-table drags in its parent', () => {
		const text = [
			`[mcp_servers.ours]`,
			`url = "http://127.0.0.1:1/mcp"`,
			``,
			`[mcp_servers.ours.http_headers]`,
			`Authorization = "Bearer ${token}"`,
			``,
		].join('\n');

		assert.deepStrictEqual(codexOurTables(codexEntries(text), token), ['ours', 'ours.http_headers']);
	});
});

suite('repairCodexToml', () => {

	test('corrects the port in place', () => {
		const before = [
			`[mcp_servers.ai-browser]`,
			`url = "http://127.0.0.1:43110/mcp"`,
			`http_headers = { Authorization = "Bearer ${token}" }`,
			``,
		].join('\n');

		const result = repairToml(before);
		assert.ok(result.changed);
		assert.ok(result.text.includes(`url = "${url}"`));
	});

	test('a quoted key is edited, never duplicated', () => {
		// The corrupting shape: the token is visible in a bare `url`, so the
		// table is recognised as ours, while `"http_headers"` is quoted. Read as
		// absent, it was *added* a second time — two definitions of one key,
		// which is TOML that does not parse, so every MCP server in the file
		// went with it, unattended, at window start.
		const before = [
			`[mcp_servers.ai-browser]`,
			`url = "http://127.0.0.1:49999/mcp/${token}"`,
			`"http_headers" = { X-Org = "acme" }`,
			``,
		].join('\n');

		const result = repairToml(before);
		assert.ok(result.changed);

		const headerLines = result.text.split('\n').filter(line => /http_headers/.test(line));
		assert.strictEqual(headerLines.length, 1, 'one definition of http_headers');
		assert.ok(headerLines[0].includes(`Authorization = "Bearer ${token}"`), 'ours is set');
		assert.ok(headerLines[0].includes('X-Org'), "the user's header survives");
		assert.ok(result.text.includes(`url = "${url}"`));
	});

	test('keeps keys the user added to our table', () => {
		// The reason this is line surgery and not a table rewrite: repair runs
		// unattended, and silently dropping someone's settings is not a repair.
		const before = [
			`# why this table is here`,
			`[mcp_servers.ai-browser]`,
			`url = "http://127.0.0.1:43110/mcp"`,
			`http_headers = { Authorization = "Bearer ${token}" }`,
			`startup_timeout_sec = 90.0`,
			``,
		].join('\n');

		const after = repairToml(before).text;
		assert.ok(after.includes('startup_timeout_sec = 90.0'));
		assert.ok(after.includes('# why this table is here'));
	});

	test('leaves neighbouring tables and their comments alone', () => {
		const before = [
			`[mcp_servers.someone-else]`,
			`command = "/bin/thing"`,
			``,
			`# ours`,
			`[mcp_servers.ai-browser]`,
			`url = "http://127.0.0.1:43110/mcp"`,
			`http_headers = { Authorization = "Bearer ${token}" }`,
			``,
			`[other.section]`,
			`key = "value"`,
			``,
		].join('\n');

		const after = repairToml(before).text;
		assert.ok(after.includes('command = "/bin/thing"'));
		assert.ok(after.includes('[other.section]'));
		assert.ok(after.includes('key = "value"'));
	});

	test('migrates the old token-in-URL form to a header', () => {
		const before = [
			`[mcp_servers.tab-browser-thing]`,
			`url = "http://127.0.0.1:43110/mcp/${token}"`,
			``,
		].join('\n');

		const after = repairToml(before).text;
		assert.ok(after.includes(`url = "${url}"`), after);
		assert.ok(after.includes(`http_headers = { Authorization = "Bearer ${token}" }`), after);
		assert.ok(after.includes('[mcp_servers.ai-browser]'), after);
	});

	test('removes a duplicate of ours rather than leaving two tool lists', () => {
		const before = [
			`[mcp_servers.tab-browser]`,
			`url = "http://127.0.0.1:43111/mcp/${token}"`,
			``,
			`[mcp_servers.ai-browser]`,
			`url = "http://127.0.0.1:43110/mcp"`,
			`http_headers = { Authorization = "Bearer ${token}" }`,
			``,
		].join('\n');

		const result = repairToml(before);
		assert.deepStrictEqual(result.collapsed, ['tab-browser']);
		assert.ok(!result.text.includes('tab-browser'), result.text);
		assert.strictEqual(result.text.match(/\[mcp_servers\./g)?.length, 1);
	});

	test('a header sub-table is kept and updated, not flattened away', () => {
		// Converting it to an inline table was lossy: any other header the user
		// had put in there went with it. Only the authorization is ours, and
		// the token has to already be ours or the entry is not recognisable as
		// ours in the first place — a stale *token* is out of scope by design.
		const before = [
			`[mcp_servers.ai-browser]`,
			`url = "http://127.0.0.1:43110/mcp"`,
			``,
			`[mcp_servers.ai-browser.http_headers]`,
			`Authorization = "Bearer ${token}"`,
			`X-Org = "acme"`,
			``,
		].join('\n');

		const after = repairToml(before).text;
		assert.ok(after.includes(`url = "${url}"`), after);
		assert.ok(after.includes('[mcp_servers.ai-browser.http_headers]'), after);
		assert.ok(after.includes('X-Org = "acme"'), after);
		// No second set of credentials alongside it.
		assert.ok(!after.includes('http_headers = {'), after);
	});

	test('a table with a foreign token is not ours to touch', () => {
		const before = [
			`[mcp_servers.ai-browser-other-abc123]`,
			`url = "http://127.0.0.1:43110/mcp"`,
			`http_headers = { Authorization = "Bearer ${foreign}" }`,
			``,
		].join('\n');

		assert.strictEqual(repairToml(before).changed, false);
	});

	test('an already correct file is left byte-identical', () => {
		const before = [
			`[mcp_servers.ai-browser]`,
			`url = "${url}"`,
			`http_headers = { Authorization = "Bearer ${token}" }`,
			``,
		].join('\n');

		const result = repairToml(before);
		assert.strictEqual(result.changed, false);
		assert.strictEqual(result.text, before);
	});

	test('CRLF survives', () => {
		const before = [
			`[mcp_servers.ai-browser]`,
			`url = "http://127.0.0.1:43110/mcp"`,
			`http_headers = { Authorization = "Bearer ${token}" }`,
			``,
		].join('\r\n');

		const after = repairToml(before).text;
		assert.ok(after.includes('\r\n'));
		assert.ok(!/[^\r]\n/.test(after), 'a bare LF crept in');
	});

	test('a file with nothing of ours is untouched', () => {
		const before = `[mcp_servers.other]\nurl = "http://127.0.0.1:1/mcp"\n`;
		assert.strictEqual(repairToml(before).changed, false);
	});
});

suite('repair leaves other people\'s entries alone under a name clash', () => {

	test('Codex: the rename is skipped when the target name is not ours', () => {
		// Our token sits in `tab-browser`; `ai-browser` belongs to someone else.
		// Renaming ours would produce two [mcp_servers.ai-browser] headers —
		// TOML that does not parse, taking every MCP server down with it.
		const before = [
			`[mcp_servers.tab-browser]`,
			`url = "http://127.0.0.1:43110/mcp"`,
			`http_headers = { Authorization = "Bearer ${token}" }`,
			``,
			`[mcp_servers.ai-browser]`,
			`url = "http://127.0.0.1:9999/mcp"`,
			`http_headers = { Authorization = "Bearer ${foreign}" }`,
			``,
		].join('\n');

		const after = repairToml(before).text;
		assert.strictEqual(after.match(/\[mcp_servers\.ai-browser\]/g)?.length, 1, after);
		assert.ok(after.includes('[mcp_servers.tab-browser]'), after);
		assert.ok(after.includes(`url = "${url}"`), after);
		// The stranger is untouched, port and token both.
		assert.ok(after.includes('url = "http://127.0.0.1:9999/mcp"'), after);
		assert.ok(after.includes(`Bearer ${foreign}`), after);
	});

	test('Claude: a foreign entry under our name is not overwritten', () => {
		const before = JSON.stringify({
			mcpServers: {
				'tab-browser': { type: 'http', url: 'http://127.0.0.1:43110/mcp', headers: { Authorization: `Bearer ${token}` } },
				'ai-browser': { type: 'http', url: 'http://127.0.0.1:9999/mcp', headers: { Authorization: `Bearer ${foreign}` } },
			},
		}, null, 2) + '\n';

		const after = JSON.parse(repairClaudeJson(before, endpoint).text);
		assert.strictEqual(after.mcpServers['ai-browser'].headers.Authorization, `Bearer ${foreign}`);
		assert.strictEqual(after.mcpServers['tab-browser'].url, url);
	});
});

suite('repair preserves what it does not own', () => {

	test('Codex: a multi-line url value is replaced whole', () => {
		// Replacing only the key's first line would strand the continuation and
		// the closing delimiter as garbage that no longer parses.
		const before = [
			`[mcp_servers.ai-browser]`,
			`url = """`,
			`http://127.0.0.1:43110/mcp"""`,
			`http_headers = { Authorization = "Bearer ${token}" }`,
			``,
		].join('\n');

		const after = repairToml(before).text;
		assert.ok(!after.includes('"""'), after);
		assert.ok(!after.includes('43110'), after);
		assert.strictEqual(after.match(/^url = /gm)?.length, 1, after);
	});

	test('Codex: a sub-table of ours that is not http_headers stays', () => {
		const before = [
			`[mcp_servers.ai-browser]`,
			`url = "http://127.0.0.1:43110/mcp"`,
			`http_headers = { Authorization = "Bearer ${token}" }`,
			``,
			`[mcp_servers.ai-browser.env_http_headers]`,
			`X-Trace = "TRACE_ID"`,
			``,
		].join('\n');

		const after = repairToml(before).text;
		assert.ok(after.includes('[mcp_servers.ai-browser.env_http_headers]'), after);
		assert.ok(after.includes('X-Trace = "TRACE_ID"'), after);
	});

	test('Claude: keys the user added to our entry survive', () => {
		const before = JSON.stringify({
			mcpServers: {
				'ai-browser': {
					type: 'http',
					url: 'http://127.0.0.1:43110/mcp',
					headers: { Authorization: `Bearer ${token}`, 'X-Trace': 'on' },
					timeout: 120,
				},
			},
		}, null, 2) + '\n';

		const entry = JSON.parse(repairClaudeJson(before, endpoint).text).mcpServers['ai-browser'];
		assert.strictEqual(entry.timeout, 120);
		assert.strictEqual(entry.headers['X-Trace'], 'on');
		assert.strictEqual(entry.url, url);
	});

	test('Claude: a lower-case authorization header is not left beside ours', () => {
		const before = JSON.stringify({
			mcpServers: {
				'ai-browser': { type: 'http', url: 'http://127.0.0.1:43110/mcp', headers: { authorization: `Bearer ${token}` } },
			},
		}, null, 2) + '\n';

		const headers = JSON.parse(repairClaudeJson(before, endpoint).text).mcpServers['ai-browser'].headers;
		assert.deepStrictEqual(Object.keys(headers), ['Authorization']);
	});
});

suite('the two ownership rules agree', () => {

	// `codexOurTables` decides what the repair rewrites; `codexEntryCarriesToken`
	// decides what the check reports. They live in different leaf modules and
	// cannot share code, so disagreement would mean the same entry is silently
	// rewritten by one and reported as a stranger to delete by the other.
	const cases: Record<string, string> = {
		'header form': `[mcp_servers.a]\nurl = "http://h/mcp"\nhttp_headers = { Authorization = "Bearer ${token}" }\n`,
		'token in path': `[mcp_servers.a]\nurl = "http://h/mcp/${token}"\n`,
		'sub-table': `[mcp_servers.a]\nurl = "http://h/mcp"\n\n[mcp_servers.a.http_headers]\nAuthorization = "Bearer ${token}"\n`,
		'env var name only': `[mcp_servers.a]\nurl = "http://h/mcp"\nbearer_token_env_var = "FOO"\n`,
		'foreign token': `[mcp_servers.a]\nurl = "http://h/mcp"\nhttp_headers = { Authorization = "Bearer ${foreign}" }\n`,
		'nothing at all': `[mcp_servers.a]\nurl = "http://h/mcp"\n`,
	};

	for (const [name, text] of Object.entries(cases)) {
		test(name, () => {
			const entries = codexEntries(text);
			const byRepair = codexOurTables(entries, token).includes('a');
			const byCheck = codexEntryCarriesToken(entries[0], entries, token);
			assert.strictEqual(byRepair, byCheck, `${name}: repair ${byRepair}, check ${byCheck}`);
		});
	}
});

suite('repair carries the whole entry across a rename', () => {

	test('sub-tables follow the parent to the new name', () => {
		// Left behind, `[mcp_servers.tab-browser.env_http_headers]` implicitly
		// recreates `mcp_servers.tab-browser` — so the settings are lost to the
		// real server and a second, urlless one appears in their place.
		const before = [
			`[mcp_servers.tab-browser]`,
			`url = "http://127.0.0.1:43110/mcp"`,
			`http_headers = { Authorization = "Bearer ${token}" }`,
			``,
			`[mcp_servers.tab-browser.env_http_headers]`,
			`X-Trace = "TRACE_ID"`,
			``,
		].join('\n');

		const after = repairToml(before).text;
		assert.ok(!after.includes('tab-browser'), after);
		assert.ok(after.includes('[mcp_servers.ai-browser.env_http_headers]'), after);
		assert.ok(after.includes('X-Trace = "TRACE_ID"'), after);
	});
});

suite('repair keeps headers it did not put there', () => {

	test('an extra inline header survives', () => {
		const before = [
			`[mcp_servers.ai-browser]`,
			`url = "http://127.0.0.1:43110/mcp"`,
			`http_headers = { Authorization = "Bearer ${token}", X-Org = "acme" }`,
			``,
		].join('\n');

		const after = repairToml(before).text;
		assert.ok(after.includes('X-Org = "acme"'), after);
		assert.ok(after.includes(`Authorization = "Bearer ${token}"`), after);
	});

	test('an already correct entry with extra headers is left byte-identical', () => {
		// The regression this guards: the rewrite dropped X-Org on every start,
		// even with the URL already right.
		const before = [
			`[mcp_servers.ai-browser]`,
			`url = "${url}"`,
			`http_headers = { Authorization = "Bearer ${token}", X-Org = "acme" }`,
			``,
		].join('\n');

		assert.strictEqual(repairToml(before).changed, false);
	});

	test('a sub-table beside an inline table is folded in, not dropped', () => {
		// Two sets of headers on one server is the ambiguous shape; the
		// sub-table goes, but its keys come across.
		const before = [
			`[mcp_servers.ai-browser]`,
			`url = "http://127.0.0.1:43110/mcp"`,
			`http_headers = { Authorization = "Bearer ${token}" }`,
			``,
			`[mcp_servers.ai-browser.http_headers]`,
			`X-Org = "acme"`,
			``,
		].join('\n');

		const after = repairToml(before).text;
		assert.ok(!after.includes('[mcp_servers.ai-browser.http_headers]'), after);
		assert.ok(after.includes('X-Org'), after);
		assert.ok(after.includes(`Authorization = "Bearer ${token}"`), after);
	});
});

suite('parseInlineTable and mergeAuthorization', () => {

	test('a comma inside a quoted value is not a separator', () => {
		const pairs = parseInlineTable('{ Authorization = "Bearer a", X-Note = "one, two" }');
		assert.deepStrictEqual(pairs.map(p => p.key), ['Authorization', 'X-Note']);
		assert.strictEqual(pairs[1].value, '"one, two"');
	});

	test('an = inside a quoted value does not split the pair', () => {
		const pairs = parseInlineTable('{ X-Q = "a=b" }');
		assert.deepStrictEqual(pairs, [{ key: 'X-Q', value: '"a=b"' }]);
	});

	test('only the authorization changes, whatever its case', () => {
		const out = mergeAuthorization('{ authorization = "Bearer old", X-Org = "acme" }', [], token);
		assert.ok(out.includes(`authorization = "Bearer ${token}"`), out);
		assert.ok(out.includes('X-Org = "acme"'), out);
		assert.ok(!out.includes('Bearer old'), out);
	});

	test('an absent authorization is added, and carried keys do not overwrite', () => {
		const out = mergeAuthorization('{ X-Org = "keep" }', [{ key: 'X-Org', value: '"drop"' }], token);
		assert.ok(out.includes('X-Org = "keep"'), out);
		assert.ok(!out.includes('"drop"'), out);
		assert.ok(out.includes(`Authorization = "Bearer ${token}"`), out);
	});
});
