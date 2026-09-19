/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { codexEntries, codexRangeDeletable, codexUnterminated } from './codexToml.ts';
import { codexEntryCarriesToken } from './mcpClientState.ts';
import {
	codexRetiredTables, codexOurTables, mergeAuthorization, parseInlineTable, removeCodexTables,
	repairClaudeJson, repairCodexToml, spliceCodexTables,
} from './mcpRepair.ts';

const token = 'ourtoken0000000000000000000000000000000000000000000000000000abcd';
const foreign = 'theirs000000000000000000000000000000000000000000000000000000beef';
const url = 'http://127.0.0.1:43117/mcp';
const endpoint = { url, token, name: 'ai-browser' };

const repairToml = (text: string, name = 'ai-browser') =>
	repairCodexToml(text, codexEntries(text), { ...endpoint, name },
		(from, to) => codexRangeDeletable(text, from, to));

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

/*
 * Pruning entries whose project is gone.
 *
 * The safety of this rests entirely on *which* tokens the caller declares missing
 * — that is a filesystem question answered in `missingWorkspaceTokens` — so what
 * is worth pinning down here is the file surgery: that a stale table goes whole,
 * that a live one is untouched however much it looks like ours, and that the
 * repair still sees a correct file afterwards.
 */
suite('codexRetiredTables / removeCodexTables', () => {

	const retired = 'gone00000000000000000000000000000000000000000000000000000000aaaa';

	const prune = (text: string, tokens: string[], keep = token) => {
		const entries = codexEntries(text);
		return removeCodexTables(text, entries, codexRetiredTables(entries, new Set(tokens), keep),
			(from, to) => codexRangeDeletable(text, from, to));
	};

	test('removes a retired entry whole, sub-table and all', () => {
		const before = [
			'[mcp_servers.other]',
			'url = "http://example/mcp"',
			'',
			'[mcp_servers.ai-browser-old-abc123]',
			'url = "http://127.0.0.1:43110/mcp"',
			'startup_timeout_sec = 30',
			'',
			'[mcp_servers.ai-browser-old-abc123.env_http_headers]',
			`Authorization = "Bearer ${retired}"`,
			'',
		].join('\n');

		const result = prune(before, [retired]);
		assert.ok(result.changed);
		assert.deepStrictEqual(result.removed, ['ai-browser-old-abc123']);
		assert.ok(!result.text.includes('ai-browser-old-abc123'));
		assert.ok(!result.text.includes('startup_timeout_sec'));
		assert.ok(result.text.includes('[mcp_servers.other]'));
	});

	test('leaves an entry whose token is not declared retired', () => {
		const before = [
			'[mcp_servers.ai-browser-live-def456]',
			'url = "http://127.0.0.1:43111/mcp"',
			`http_headers = { Authorization = "Bearer ${foreign}" }`,
			'',
		].join('\n');

		assert.strictEqual(prune(before, [retired]).changed, false);
	});

	test('an empty retired set changes nothing', () => {
		const before = [
			'[mcp_servers.ai-browser-old-abc123]',
			`http_headers = { Authorization = "Bearer ${retired}" }`,
			'',
		].join('\n');

		assert.strictEqual(prune(before, []).changed, false);
	});

	test('prunes the retired entry and still repairs ours in the same file', () => {
		const before = [
			'# my servers',
			'[mcp_servers.ai-browser-old-abc123]',
			'url = "http://127.0.0.1:43110/mcp"',
			`http_headers = { Authorization = "Bearer ${retired}" }`,
			'',
			'[mcp_servers.ai-browser]',
			'url = "http://127.0.0.1:43999/mcp"',
			`http_headers = { Authorization = "Bearer ${token}" }`,
			'',
		].join('\n');

		const pruned = prune(before, [retired]);
		assert.deepStrictEqual(pruned.removed, ['ai-browser-old-abc123']);

		const repaired = repairToml(pruned.text);
		assert.ok(repaired.changed);
		assert.ok(repaired.text.includes(`url = "${url}"`));
		assert.ok(!repaired.text.includes('43999'));
		assert.ok(!repaired.text.includes(retired));
		// The header comment is not part of any table, so it stays where it is.
		assert.ok(repaired.text.startsWith('# my servers'));
	});

	test('never touches our own entry, even when our own token is declared retired', () => {
		// The guard that matters, and the one the old version of this test only
		// claimed to exercise: it passed `[retired, foreign]`, so `token` never
		// reached the function and the live table would in fact have been
		// removed. `missingWorkspaceTokens` refuses to declare our own token missing,
		// but this function is the one that deletes, so it refuses too.
		const before = [
			'[mcp_servers.ai-browser]',
			'url = "http://127.0.0.1:43110/mcp"',
			`http_headers = { Authorization = "Bearer ${token}" }`,
			'',
		].join('\n');

		const entries = codexEntries(before);
		assert.deepStrictEqual(codexRetiredTables(entries, new Set([token]), token), []);
		assert.strictEqual(prune(before, [token, retired, foreign]).changed, false);
	});

	test('a retired sibling goes while our own entry stays, in one file', () => {
		const before = [
			'[mcp_servers.ai-browser-old-abc123]',
			`http_headers = { Authorization = "Bearer ${retired}" }`,
			'',
			'[mcp_servers.ai-browser]',
			`http_headers = { Authorization = "Bearer ${token}" }`,
			'',
		].join('\n');

		const result = prune(before, [retired, token]);
		assert.deepStrictEqual(result.removed, ['ai-browser-old-abc123']);
		assert.ok(result.text.includes(`Bearer ${token}`));
	});

	test('keeps the file\'s CRLF line endings', () => {
		const before = [
			'[mcp_servers.other]',
			'url = "http://example/mcp"',
			'',
			'[mcp_servers.ai-browser-old-abc123]',
			`http_headers = { Authorization = "Bearer ${retired}" }`,
			'',
		].join('\r\n');

		const result = prune(before, [retired]);
		assert.ok(result.changed);
		assert.ok(result.text.includes('\r\n'));
		assert.ok(!/[^\r]\n/.test(result.text));
	});

	test('collapses the blank line the removed table left behind', () => {
		const before = [
			'[mcp_servers.ai-browser-old-abc123]',
			`http_headers = { Authorization = "Bearer ${retired}" }`,
			'',
			'[mcp_servers.other]',
			'url = "http://example/mcp"',
			'',
		].join('\n');

		const result = prune(before, [retired]);
		assert.strictEqual(result.text, '[mcp_servers.other]\nurl = "http://example/mcp"\n');
	});

	test('two retired projects go in one pass', () => {
		const second = 'gone11111111111111111111111111111111111111111111111111111111beef';
		const before = [
			'[mcp_servers.ai-browser-a-aaaaaa]',
			`http_headers = { Authorization = "Bearer ${retired}" }`,
			'',
			'[mcp_servers.ai-browser-b-bbbbbb]',
			`http_headers = { Authorization = "Bearer ${second}" }`,
			'',
			'[mcp_servers.other]',
			'url = "http://example/mcp"',
			'',
		].join('\n');

		const result = prune(before, [retired, second]);
		assert.deepStrictEqual(
			[...result.removed].sort(), ['ai-browser-a-aaaaaa', 'ai-browser-b-bbbbbb']);
		assert.strictEqual(result.text, '[mcp_servers.other]\nurl = "http://example/mcp"\n');
	});
});

/*
 * The shape that emptied a user's whole global Codex config.
 *
 * `codexEntries` keeps a table open across continuation lines, which is right
 * for identifying one. An unclosed `[` never closes, so the table's range runs
 * to end of file — and once a value is left open the parser stops recognising
 * headers at all, so the tables about to be removed are not even in `entries`.
 * Deleting that range took every other MCP server and the live entry of the
 * window doing the deleting, and reported the one name it meant to remove.
 */
suite('removeCodexTables refuses a range that covers other tables', () => {

	const retired = 'gone00000000000000000000000000000000000000000000000000000000aaaa';

	const wipe = [
		'# Codex configuration',
		'model = "gpt-5"',
		'',
		'[mcp_servers.ai-browser-oldproj-a1b2c3]',
		`http_headers = { Authorization = "Bearer ${retired}" }`,
		'enabled_tools = [',
		'',
		'[mcp_servers.github]',
		'command = "npx"',
		'',
		`[mcp_servers.ai-browser]`,
		`http_headers = { Authorization = "Bearer ${token}" }`,
		'',
	].join('\n');

	test('an unclosed value leaves every other server alone', () => {
		const entries = codexEntries(wipe);
		const result = removeCodexTables(wipe, entries, codexRetiredTables(entries, new Set([retired]), token),
			(from, to) => codexRangeDeletable(wipe, from, to));

		assert.strictEqual(result.changed, false);
		assert.deepStrictEqual(result.removed, []);
		assert.strictEqual(result.text, wipe);
	});

	test('the same file with the bracket closed prunes normally', () => {
		const sound = wipe.replace('enabled_tools = [', 'enabled_tools = []');
		const entries = codexEntries(sound);
		const result = removeCodexTables(sound, entries, codexRetiredTables(entries, new Set([retired]), token),
			(from, to) => codexRangeDeletable(sound, from, to));

		assert.deepStrictEqual(result.removed, ['ai-browser-oldproj-a1b2c3']);
		assert.ok(result.text.includes('[mcp_servers.github]'));
		assert.ok(result.text.includes(`Bearer ${token}`));
	});

	test('a multi-line array inside a retired table is still removed whole', () => {
		const text = [
			'[mcp_servers.ai-browser-old-abc123]',
			`http_headers = { Authorization = "Bearer ${retired}" }`,
			'enabled_tools = [',
			'  "a",',
			'  "b",',
			']',
			'',
			'[mcp_servers.other]',
			'url = "http://example/mcp"',
			'',
		].join('\n');

		const entries = codexEntries(text);
		const result = removeCodexTables(text, entries, codexRetiredTables(entries, new Set([retired]), token),
			(from, to) => codexRangeDeletable(text, from, to));

		assert.deepStrictEqual(result.removed, ['ai-browser-old-abc123']);
		assert.ok(!result.text.includes('enabled_tools'));
		assert.ok(result.text.includes('[mcp_servers.other]'));
	});
});

/*
 * A refusal has to be distinguishable from "nothing to do".
 *
 * Both leave the text identical, and only one of them means the tables are
 * still in the file. A caller that records a completion marker on the strength of a completed
 * run needs the difference: a marker laid on a refusal takes the folder out of
 * the scan for good while its table sits there.
 */
suite('removeCodexTables reports a refusal', () => {

	const odd = 'odd000000000000000000000000000000000000000000000000000000000abcd';
	const plain = 'pln000000000000000000000000000000000000000000000000000000000beef';

	// The odd table comes *after* the plain one on purpose. An unclosed value
	// makes every later line read as continuation, so the parser can only still
	// see the tables above it — which is exactly what makes "stands off one
	// entry without blocking the rest" a real scenario rather than a contrived
	// one.
	const file = [
		'[mcp_servers.ai-browser-plain-222222]',
		`http_headers = { Authorization = "Bearer ${plain}" }`,
		'',
		'[mcp_servers.ai-browser-odd-111111]',
		`http_headers = { Authorization = "Bearer ${odd}" }`,
		'enabled_tools = [',
		'',
		'[mcp_servers.other]',
		'url = "http://example/mcp"',
		'',
	].join('\n');

	test('nothing to do is not a refusal', () => {
		const entries = codexEntries(file);
		const result = removeCodexTables(file, entries, [],
			(from, to) => codexRangeDeletable(file, from, to));

		assert.strictEqual(result.changed, false);
		assert.strictEqual(result.refused, false);
	});

	test('one odd table stands off without blocking the others', () => {
		const entries = codexEntries(file);
		const names = codexRetiredTables(entries, new Set([odd, plain]), token);
		const result = removeCodexTables(file, entries, names,
			(from, to) => codexRangeDeletable(file, from, to));

		assert.strictEqual(result.refused, true);
		assert.deepStrictEqual(result.removed, ['ai-browser-plain-222222']);
		// The one it declined is still there; the one it took is gone.
		assert.ok(result.text.includes(odd));
		assert.ok(!result.text.includes(plain));
		// And the unrelated server the odd table's range ran over is untouched.
		assert.ok(result.text.includes('[mcp_servers.other]'));
	});

	test('a refusal that removes nothing still says so', () => {
		const entries = codexEntries(file);
		const names = codexRetiredTables(entries, new Set([odd]), token);
		const result = removeCodexTables(file, entries, names,
			(from, to) => codexRangeDeletable(file, from, to));

		assert.strictEqual(result.changed, false);
		assert.strictEqual(result.refused, true);
		assert.deepStrictEqual(result.removed, []);
	});

	// The regression this rule was rewritten for. `  [3, 4]` — the last element
	// of a nested array, written without a trailing comma — is a whole line that
	// *looks* like a table header, and the textual guard this replaced refused
	// the table because of it. That refusal was not merely a missed prune: it
	// propagated to `complete`, so the folder was never marked as handled and
	// the entry could never be removed on any later run either.
	test('a nested array is not mistaken for a table header', () => {
		const nested = [
			'[mcp_servers.ai-browser-nested-333333]',
			`http_headers = { Authorization = "Bearer ${odd}" }`,
			'matrix = [',
			'  [1, 2],',
			'  [3, 4]',
			']',
			'',
			'[mcp_servers.other]',
			'url = "http://example/mcp"',
			'',
		].join('\n');

		const entries = codexEntries(nested);
		const names = codexRetiredTables(entries, new Set([odd]), token);
		const result = removeCodexTables(nested, entries, names,
			(from, to) => codexRangeDeletable(nested, from, to));

		assert.strictEqual(result.refused, false);
		assert.deepStrictEqual(result.removed, ['ai-browser-nested-333333']);
		assert.ok(!result.text.includes(odd));
		// The array went with its own table, and the neighbour stayed.
		assert.ok(!result.text.includes('matrix'));
		assert.ok(result.text.includes('[mcp_servers.other]'));
	});
});
suite('repairCodexToml refuses a range it may not delete', () => {

	// It deletes whole line ranges too — a duplicate of ours, and a header
	// sub-table folded into the inline form — and did so with no range check at
	// all, trusting the caller's document-wide guard. A range can hide another
	// table's header while the document still balances, and an unrelated server
	// was removed with `collapsed` naming only our own old entry.
	test('a duplicate whose range hides a foreign table is left alone', () => {
		const text = [
			'[mcp_servers.tab-browser]',
			`http_headers = { Authorization = "Bearer ${token}" }`,
			'enabled_tools = [',
			'[mcp_servers.github]',
			'command = "docker"',
			']',
			'',
			'[mcp_servers.ai-browser]',
			'url = "http://127.0.0.1:43110/mcp"',
			`http_headers = { Authorization = "Bearer ${token}" }`,
			'',
		].join('\n');

		// The document balances, so the caller's own guard does not fire.
		assert.strictEqual(codexUnterminated(text), false);

		const result = repairCodexToml(text, codexEntries(text), { ...endpoint, name: 'ai-browser' },
			(from, to) => codexRangeDeletable(text, from, to));

		assert.strictEqual(result.changed, false, 'the whole repair stands down');
		assert.strictEqual(result.text, text);
		assert.ok(result.text.includes('[mcp_servers.github]'));
	});

	test('an ordinary duplicate is still collapsed', () => {
		const text = [
			'[mcp_servers.tab-browser]',
			'url = "http://127.0.0.1:43110/mcp"',
			`http_headers = { Authorization = "Bearer ${token}" }`,
			'',
			'[mcp_servers.ai-browser]',
			'url = "http://127.0.0.1:43110/mcp"',
			`http_headers = { Authorization = "Bearer ${token}" }`,
			'',
		].join('\n');

		const result = repairCodexToml(text, codexEntries(text), { ...endpoint, name: 'ai-browser' },
			(from, to) => codexRangeDeletable(text, from, to));

		assert.strictEqual(result.changed, true);
		assert.deepStrictEqual(result.collapsed, ['tab-browser']);
		assert.ok(!result.text.includes('[mcp_servers.tab-browser]'));
	});
});

suite('repairCodexToml does not write a key it is also keeping', () => {

	// The `url`-absent branch emitted `http_headers` unconditionally while
	// leaving the existing one exactly where it was — neither removed nor
	// replaced — so the table defined the key twice, which is TOML that does not
	// parse. That ran unattended at window start, took every other MCP server in
	// `~/.codex/config.toml` with it, and still reported the port as updated.
	// Reachable by commenting out a `url` line by hand to disable an endpoint;
	// the connect path heals that shape, which is why it stayed invisible.
	const headerLines = (text: string) =>
		text.split('\n').filter(line => line.startsWith('http_headers'));

	test('an existing inline http_headers is replaced, not written a second time', () => {
		const text = [
			'[mcp_servers.ai-browser]',
			'# url = "http://127.0.0.1:43110/mcp"',
			`http_headers = { Authorization = "Bearer ${token}", X-Org = "acme" }`,
			'startup_timeout_sec = 30',
			'',
		].join('\n');

		const result = repairToml(text);

		assert.strictEqual(result.changed, true);
		assert.strictEqual(headerLines(result.text).length, 1, 'exactly one http_headers key');
		assert.ok(headerLines(result.text)[0].includes(`Bearer ${token}`));
		assert.ok(headerLines(result.text)[0].includes('X-Org'), "the user's own header survives");
		assert.ok(result.text.includes(`url = "${url}"`));
		assert.ok(result.text.includes('startup_timeout_sec = 30'));
	});

	test('a header sub-table is updated in place, not duplicated inline', () => {
		const text = [
			'[mcp_servers.ai-browser]',
			'startup_timeout_sec = 30',
			'',
			'[mcp_servers.ai-browser.http_headers]',
			`Authorization = "Bearer ${token}"`,
			'',
		].join('\n');

		const result = repairToml(text);

		assert.strictEqual(result.changed, true);
		assert.strictEqual(headerLines(result.text).length, 0, 'no inline table beside the sub-table');
		assert.strictEqual(
			result.text.split('\n').filter(line => line === '[mcp_servers.ai-browser.http_headers]').length,
			1, 'the sub-table is declared exactly once');
		assert.ok(result.text.includes(`url = "${url}"`));
	});

	test('a table carrying neither still gets both lines', () => {
		const text = [
			'[mcp_servers.ai-browser]',
			`description = "${token}"`,
			'',
		].join('\n');

		const result = repairToml(text);

		assert.ok(result.text.includes(`url = "${url}"`));
		assert.strictEqual(headerLines(result.text).length, 1);
	});
});

suite('spliceCodexTables', () => {

	// The interactive Connect Codex write, and the only one of the three
	// deleters with no coverage at all. It is also the one whose refusal is
	// `undefined` rather than a flag, which is the distinction that matters: the
	// caller writes the file back and reports success if a refusal ever looks
	// like "nothing to do".
	const table = ['[mcp_servers.ai-browser]', `url = "${url}"`, 'http_headers = { }'];
	const always = () => true;
	const never = () => false;

	test('a refusal is undefined, never the input unchanged', () => {
		const lines = ['[mcp_servers.ai-browser]', 'url = "http://127.0.0.1:43110/mcp"', ''];

		assert.strictEqual(spliceCodexTables(lines, [[0, 2]], table, never), undefined);
	});

	test('the range check is actually consulted', () => {
		const lines = ['[mcp_servers.ai-browser]', 'url = "old"', ''];
		const asked: [number, number][] = [];

		spliceCodexTables(lines, [[0, 2]], table, (from, to) => {
			asked.push([from, to]);
			return true;
		});

		assert.deepStrictEqual(asked, [[0, 2]]);
	});

	test('one refused range stands off the whole splice', () => {
		const lines = ['a', 'b', 'c', 'd'];

		const result = spliceCodexTables(lines, [[0, 1], [2, 3]], table,
			(from) => from === 0);

		assert.strictEqual(result, undefined, 'not a partial splice');
	});

	test('the new table lands where the first old one was, not at the bottom', () => {
		const lines = [
			'[mcp_servers.ai-browser]',
			'url = "http://127.0.0.1:43110/mcp"',
			'',
			'[mcp_servers.other]',
			'command = "npx"',
			'',
		];

		const result = spliceCodexTables(lines, [[0, 3]], table, always);

		assert.ok(result);
		assert.strictEqual(result[0], '[mcp_servers.ai-browser]');
		assert.ok(result.indexOf('[mcp_servers.other]') > result.indexOf(`url = "${url}"`));
	});

	test('several ranges are removed and the table placed at the first of them', () => {
		const lines = [
			'[mcp_servers.keep]',
			'command = "npx"',
			'[mcp_servers.tab-browser]',
			'url = "old"',
			'[mcp_servers.ai-browser]',
			'url = "older"',
		];

		const result = spliceCodexTables(lines, [[2, 4], [4, 6]], table, always);

		assert.ok(result);
		assert.ok(!result.includes('[mcp_servers.tab-browser]'));
		assert.strictEqual(result.filter(line => line === '[mcp_servers.ai-browser]').length, 1);
		assert.ok(result.includes('[mcp_servers.keep]'));
		assert.strictEqual(result.indexOf('[mcp_servers.ai-browser]'), 2, 'at the first removed range');
	});

	test('with nothing to remove the table is appended, one blank line away', () => {
		const lines = ['[mcp_servers.other]', 'command = "npx"'];

		const result = spliceCodexTables(lines, [], table, always);

		assert.deepStrictEqual(result, [...lines, '', ...table]);
	});

	test('an existing trailing blank is not doubled', () => {
		const lines = ['[mcp_servers.other]', 'command = "npx"', ''];

		const result = spliceCodexTables(lines, [], table, always);

		assert.deepStrictEqual(result, [...lines, ...table]);
	});

	test('an empty file gets the table alone', () => {
		assert.deepStrictEqual(spliceCodexTables([], [], table, always), [...table]);
	});
});
