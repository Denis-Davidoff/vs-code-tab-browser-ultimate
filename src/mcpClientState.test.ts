/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { bestState, claudeClientState, codexClientState, codexOurEntries } from './mcpClientState.ts';
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
		assert.strictEqual(codexClientState(parse(text), url, urlWithToken), 'thisServer');
	});

	test('the same endpoint with a named env var is accepted', () => {
		const text = `[mcp_servers.ai-browser]\nurl = "${url}"\nbearer_token_env_var = "AI_BROWSER_TOKEN"\n`;
		assert.strictEqual(codexClientState(parse(text), url, urlWithToken), 'thisServer');
	});

	test('the same endpoint with no credentials at all is stale', () => {
		const text = `[mcp_servers.ai-browser]\nurl = "${url}"\n`;
		assert.strictEqual(codexClientState(parse(text), url, urlWithToken), 'staleToken');
	});

	test('a different port is another server', () => {
		const text = '[mcp_servers.ai-browser]\nurl = "http://127.0.0.1:49999/mcp/abc123"\n';
		assert.strictEqual(codexClientState(parse(text), url, urlWithToken), 'otherServer');
	});

	test('the project file wins over the global one for the same name', () => {
		const project = `[mcp_servers.ai-browser]\nurl = "${urlWithToken}"\n`;
		const global = '[mcp_servers.ai-browser]\nurl = "http://127.0.0.1:1/mcp"\n';
		assert.strictEqual(codexClientState(parse(project, global), url, urlWithToken), 'thisServer');
	});

	test('a global entry under another name still counts', () => {
		const global = `[mcp_servers.ai-browser-proj-abc123]\nurl = "${urlWithToken}"\n`;
		assert.strictEqual(codexClientState(parse('', global), url, urlWithToken), 'thisServer');
	});

	test('disabled is reported', () => {
		const text = `[mcp_servers.ai-browser]\nurl = "${urlWithToken}"\nenabled = false\n`;
		assert.strictEqual(codexClientState(parse(text), url, urlWithToken), 'disabled');
	});

	test('an empty config is none', () => {
		assert.strictEqual(codexClientState(parse('', ''), url, urlWithToken), 'none');
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
