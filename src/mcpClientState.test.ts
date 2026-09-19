/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import {
	bestState, claudeClientState, claudeLocalScopeShadows, codexClientState, codexOurEntries,
	codexStrangers,
} from './mcpClientState.ts';
import { codexEntries } from './codexToml.ts';

/** The check reads files; these functions take the parsed tables. */
const parse = (...texts: string[]) => texts.map(codexEntries);

const url = 'http://127.0.0.1:43110/mcp';
const token = 'abc123';
const urlWithToken = `${url}/${token}`;

function claudeConfig(entry: unknown): string {
	return JSON.stringify({ mcpServers: { 'ai-browser': entry } });
}

suite('bestState', () => {

	test('a config is judged by its best entry', () => {
		assert.strictEqual(bestState(['none', 'thisServer', 'staleToken']), 'thisServer');
		assert.strictEqual(bestState(['otherServer', 'staleToken']), 'staleToken');
		assert.strictEqual(bestState(['disabled', 'none']), 'disabled');
		assert.strictEqual(bestState([]), 'none');
	});
});

suite('claudeClientState', () => {

	test('recognises this server with a matching bearer token', () => {
		const text = claudeConfig({ type: 'http', url, headers: { Authorization: `Bearer ${token}` } });
		assert.strictEqual(claudeClientState(text, url, token), 'thisServer');
	});

	test('a token from another workspace is stale, not absent', () => {
		const text = claudeConfig({ type: 'http', url, headers: { Authorization: 'Bearer somebodyelse' } });
		assert.strictEqual(claudeClientState(text, url, token), 'staleToken');
	});

	test('a different port is another server', () => {
		const text = claudeConfig({ type: 'http', url: 'http://127.0.0.1:43111/mcp' });
		assert.strictEqual(claudeClientState(text, url, token), 'otherServer');
	});

	test('enabled:false wins over the url', () => {
		const text = claudeConfig({ url, enabled: false, headers: { Authorization: `Bearer ${token}` } });
		assert.strictEqual(claudeClientState(text, url, token), 'disabled');
	});

	test('a token in the path counts when there is no header', () => {
		assert.strictEqual(claudeClientState(claudeConfig({ url: urlWithToken }), url, token), 'thisServer');
	});

	test('an environment placeholder is trusted, since its value is not ours to read', () => {
		const text = claudeConfig({ url, headers: { Authorization: 'Bearer ${AI_BROWSER_TOKEN}' } });
		assert.strictEqual(claudeClientState(text, url, token), 'thisServer');
	});

	test('a lowercase authorization header is honoured', () => {
		const text = claudeConfig({ url, headers: { authorization: `Bearer ${token}` } });
		assert.strictEqual(claudeClientState(text, url, token), 'thisServer');
	});

	test('no entry, no file and unparsable json are all none', () => {
		assert.strictEqual(claudeClientState('{"mcpServers":{}}', url, token), 'none');
		assert.strictEqual(claudeClientState('{}', url, token), 'none');
		assert.strictEqual(claudeClientState('', url, token), 'none');
		assert.strictEqual(claudeClientState('{ broken', url, token), 'none');
	});

	test('other servers in the file are ignored', () => {
		const text = JSON.stringify({
			mcpServers: {
				'someone-else': { url: 'http://example.test/mcp' },
				'ai-browser': { url, headers: { Authorization: `Bearer ${token}` } },
			},
		});
		assert.strictEqual(claudeClientState(text, url, token), 'thisServer');
	});
});

suite('codexClientState', () => {

	test('recognises the token-in-url form', () => {
		const text = `[mcp_servers.ai-browser]\nurl = "${urlWithToken}"\n`;
		assert.strictEqual(codexClientState(parse(text), url, urlWithToken, token), 'thisServer');
	});

	test('the same endpoint with a named env var is accepted', () => {
		const text = `[mcp_servers.ai-browser]\nurl = "${url}"\nbearer_token_env_var = "AI_BROWSER_TOKEN"\n`;
		assert.strictEqual(codexClientState(parse(text), url, urlWithToken, token), 'thisServer');
	});

	test('the same endpoint with no credentials at all is stale', () => {
		const text = `[mcp_servers.ai-browser]\nurl = "${url}"\n`;
		assert.strictEqual(codexClientState(parse(text), url, urlWithToken, token), 'staleToken');
	});

	test('a header carrying our token is our entry', () => {
		const text = `[mcp_servers.ai-browser]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer ${token}" }\n`;
		assert.strictEqual(codexClientState(parse(text), url, urlWithToken, token), 'thisServer');
	});

	test("a header carrying somebody else's token is stale", () => {
		// The accident this state exists for: a config copied from another
		// project has the right URL and the wrong token. Counting *any* header
		// as credentials reported it as correctly configured and suppressed the
		// reconnect advice, while every call answered 401 — which reads as a
		// broken server. The Claude side always compared the token; only Codex
		// trusted the shape.
		const text = `[mcp_servers.ai-browser]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer someone-else" }\n`;
		assert.strictEqual(codexClientState(parse(text), url, urlWithToken, token), 'staleToken');
	});

	test('headers without any authorization are not credentials', () => {
		const text = `[mcp_servers.ai-browser]\nurl = "${url}"\nhttp_headers = { X-Org = "acme" }\n`;
		assert.strictEqual(codexClientState(parse(text), url, urlWithToken, token), 'staleToken');
	});

	test('an authorization we cannot read is trusted, not condemned', () => {
		// A false "reconnect" sends the user to fix a file that is already
		// right, which is the worse of the two errors.
		const text = [
			`[mcp_servers.ai-browser]`,
			`url = "${url}"`,
			`http_headers = { Authorization = """Bearer ${token}""" }`,
		].join('\n');
		assert.strictEqual(codexClientState(parse(text), url, urlWithToken, token), 'thisServer');
	});

	test('a header sub-table is judged by its authorization too', () => {
		const ours = [
			`[mcp_servers.ai-browser]`,
			`url = "${url}"`,
			`[mcp_servers.ai-browser.http_headers]`,
			`Authorization = "Bearer ${token}"`,
		].join('\n');
		const theirs = ours.replace(`Bearer ${token}`, 'Bearer someone-else');

		assert.strictEqual(codexClientState(parse(ours), url, urlWithToken, token), 'thisServer');
		assert.strictEqual(codexClientState(parse(theirs), url, urlWithToken, token), 'staleToken');
	});

	test('a different port carrying our token is our own stale entry', () => {
		// The token is what separates the two: this entry was written by this
		// window and only the port has moved, so "another server" would send
		// the user off to delete a perfectly good entry of their own.
		const text = '[mcp_servers.ai-browser]\nurl = "http://127.0.0.1:49999/mcp/abc123"\n';
		assert.strictEqual(codexClientState(parse(text), url, urlWithToken, token), 'wrongPort');
	});

	test('a different port with someone else\'s token is another server', () => {
		const text = '[mcp_servers.ai-browser]\nurl = "http://127.0.0.1:49999/mcp/zzz999"\n';
		assert.strictEqual(codexClientState(parse(text), url, urlWithToken, token), 'otherServer');
	});

	test('the project file wins over the global one for the same name', () => {
		const project = `[mcp_servers.ai-browser]\nurl = "${urlWithToken}"\n`;
		const global = '[mcp_servers.ai-browser]\nurl = "http://127.0.0.1:1/mcp"\n';
		assert.strictEqual(codexClientState(parse(project, global), url, urlWithToken, token), 'thisServer');
	});

	test('a global entry under another name still counts', () => {
		const global = `[mcp_servers.ai-browser-proj-abc123]\nurl = "${urlWithToken}"\n`;
		assert.strictEqual(codexClientState(parse('', global), url, urlWithToken, token), 'thisServer');
	});

	test('disabled is reported', () => {
		const text = `[mcp_servers.ai-browser]\nurl = "${urlWithToken}"\nenabled = false\n`;
		assert.strictEqual(codexClientState(parse(text), url, urlWithToken, token), 'disabled');
	});

	test('an empty config is none', () => {
		assert.strictEqual(codexClientState(parse('', ''), url, urlWithToken, token), 'none');
	});
});

suite('codexOurEntries', () => {

	test('lists every distinct entry pointing at us', () => {
		const project = `[mcp_servers.ai-browser]\nurl = "${urlWithToken}"\n`;
		const global = `[mcp_servers.ai-browser-proj-abc123]\nurl = "${urlWithToken}"\n`;
		assert.deepStrictEqual(
			codexOurEntries(parse(project, global), url),
			['ai-browser', 'ai-browser-proj-abc123']);
	});

	test('skips disabled entries and other servers', () => {
		const text = [
			`[mcp_servers.ours]`, `url = "${urlWithToken}"`,
			`[mcp_servers.off]`, `url = "${urlWithToken}"`, 'enabled = false',
			'[mcp_servers.theirs]', 'url = "http://example.test/mcp"',
		].join('\n');
		assert.deepStrictEqual(codexOurEntries(parse(text), url), ['ours']);
	});

	test('a shadowed name is counted once, the way Codex loads it', () => {
		const project = `[mcp_servers.ai-browser]\nurl = "${urlWithToken}"\n`;
		assert.deepStrictEqual(codexOurEntries(parse(project, project), url), ['ai-browser']);
	});
});

suite('codexClientState: credential forms', () => {

	test('inline http_headers counts as credentials', () => {
		const text = `[mcp_servers.ai-browser]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer ${token}" }\n`;
		assert.strictEqual(codexClientState(parse(text), url, urlWithToken, token), 'thisServer');
	});

	test('an http_headers sub-table counts too', () => {
		// Codex also accepts `[mcp_servers.<name>.http_headers]`, which the parser
		// reports as a separate entry whose name carries the suffix.
		const text = [
			'[mcp_servers.ai-browser]',
			`url = "${url}"`,
			'[mcp_servers.ai-browser.http_headers]',
			`Authorization = "Bearer ${token}"`,
		].join('\n');
		assert.strictEqual(codexClientState(parse(text), url, urlWithToken, token), 'thisServer');
	});

	test('a sub-table does not count as a server of its own', () => {
		const text = [
			'[mcp_servers.ai-browser]',
			`url = "${url}"`,
			'http_headers = { Authorization = "Bearer x" }',
			'[mcp_servers.ai-browser.http_headers]',
			`Authorization = "Bearer ${token}"`,
		].join('\n');
		assert.deepStrictEqual(codexOurEntries(parse(text), url), ['ai-browser']);
	});

	test('env-var credentials are still trusted', () => {
		const text = `[mcp_servers.ai-browser]\nurl = "${url}"\nbearer_token_env_var = "AI_BROWSER_TOKEN"\n`;
		assert.strictEqual(codexClientState(parse(text), url, urlWithToken, token), 'thisServer');
	});

	test('the endpoint with no credentials at all is still stale', () => {
		const text = `[mcp_servers.ai-browser]\nurl = "${url}"\n`;
		assert.strictEqual(codexClientState(parse(text), url, urlWithToken, token), 'staleToken');
	});
});

suite('claudeClientState: wrongPort', () => {

	// `wrongPort` exists because reporting our own moved entry as `otherServer`
	// advises deleting a perfectly good entry of the user's own. The Codex side
	// has had both arms tested since that fix; the Claude side had only the
	// `otherServer` one, which is the half that was already right.
	test('our token on a moved port is wrongPort, not otherServer', () => {
		const text = claudeConfig({
			type: 'http',
			url: 'http://127.0.0.1:49999/mcp',
			headers: { Authorization: `Bearer ${token}` },
		});

		assert.strictEqual(claudeClientState(text, url, token), 'wrongPort');
	});

	test('another token on a moved port is still otherServer', () => {
		const text = claudeConfig({
			type: 'http',
			url: 'http://127.0.0.1:49999/mcp',
			headers: { Authorization: 'Bearer someone-else' },
		});

		assert.strictEqual(claudeClientState(text, url, token), 'otherServer');
	});

	test('the token in the url path also marks a moved entry as ours', () => {
		const text = claudeConfig({ type: 'http', url: `http://127.0.0.1:49999/mcp/${token}` });

		assert.strictEqual(claudeClientState(text, url, token), 'wrongPort');
	});
});

suite('codexStrangers', () => {

	// It compares against *this window's* token only, so what it returns is
	// several groups at once: other live windows, entries from another machine,
	// and stale ones the prune left alone. The message must not collapse them —
	// and the rule that decides membership is the one tested here.
	test('a table named like ours without our token is reported', () => {
		const entries = parse([
			'[mcp_servers.ai-browser-other-abc123]',
			'url = "http://127.0.0.1:43111/mcp"',
			'http_headers = { Authorization = "Bearer someone-else" }',
		].join('\n'));

		assert.deepStrictEqual(codexStrangers(entries, token), ['ai-browser-other-abc123']);
	});

	test('a table carrying our token is not a stranger', () => {
		const entries = parse([
			'[mcp_servers.ai-browser-mine-abc123]',
			'url = "http://127.0.0.1:43111/mcp"',
			`http_headers = { Authorization = "Bearer ${token}" }`,
		].join('\n'));

		assert.deepStrictEqual(codexStrangers(entries, token), []);
	});

	test('a name that merely starts with the same letters is not ours', () => {
		const entries = parse([
			'[mcp_servers.ai-browserish]',
			'url = "http://example.com/mcp"',
		].join('\n'));

		assert.deepStrictEqual(codexStrangers(entries, token), []);
	});

	test('the bare name counts, and a sub-table never does', () => {
		const entries = parse([
			'[mcp_servers.ai-browser]',
			'url = "http://127.0.0.1:43111/mcp"',
			'',
			'[mcp_servers.ai-browser.http_headers]',
			'Authorization = "Bearer someone-else"',
		].join('\n'));

		assert.deepStrictEqual(codexStrangers(entries, token), ['ai-browser']);
	});

	test('a name seen in two files is reported once', () => {
		const table = [
			'[mcp_servers.ai-browser-dup-abc123]',
			'url = "http://127.0.0.1:43111/mcp"',
		].join('\n');

		assert.deepStrictEqual(codexStrangers(parse(table, table), token), ['ai-browser-dup-abc123']);
	});
});

suite('claudeLocalScopeShadows', () => {

	// `~/.claude.json` local scope overrides the project's `.mcp.json`, so an
	// entry here is the one thing Connect cannot fix — it is reported, never
	// rewritten, because that file holds Claude Code's own credentials.
	const folder = '/Users/someone/project';
	const localConfig = (servers: unknown) =>
		JSON.stringify({ projects: { [folder]: { mcpServers: servers } } });

	test('an entry under our name is reported', () => {
		const text = localConfig({ 'ai-browser': { type: 'http', url } });

		assert.deepStrictEqual(claudeLocalScopeShadows(text, folder, token), ['ai-browser']);
	});

	test('an entry under another name carrying our token is reported too', () => {
		const text = localConfig({
			'tab-browser': { type: 'http', url, headers: { Authorization: `Bearer ${token}` } },
		});

		assert.deepStrictEqual(claudeLocalScopeShadows(text, folder, token), ['tab-browser']);
	});

	test('somebody else\'s server is left alone', () => {
		const text = localConfig({ github: { type: 'http', url: 'http://example.com/mcp' } });

		assert.deepStrictEqual(claudeLocalScopeShadows(text, folder, token), []);
	});

	test('another project\'s entries are not this project\'s', () => {
		const text = JSON.stringify({
			projects: { '/Users/someone/elsewhere': { mcpServers: { 'ai-browser': { url } } } },
		});

		assert.deepStrictEqual(claudeLocalScopeShadows(text, folder, token), []);
	});

	test('an unparsable or shapeless file answers nothing rather than throwing', () => {
		assert.deepStrictEqual(claudeLocalScopeShadows('{ not json', folder, token), []);
		assert.deepStrictEqual(claudeLocalScopeShadows('{}', folder, token), []);
		assert.deepStrictEqual(claudeLocalScopeShadows(localConfig(null), folder, token), []);
	});
});
