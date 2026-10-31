import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

// Exercise the command with VS Code's terminal and clipboard boundaries mocked.
function fixture(version: string, installed = true, folder: { uri: { scheme: string; fsPath: string } } | undefined = { uri: { scheme: 'file', fsPath: '/project with spaces' } }) {
	const source = readFileSync('src/mcp/mcpSetup.ts', 'utf8');
	const command = /export async function connectOpenCode\([\s\S]*?\n\}/.exec(source)![0];
	const prompt = /export function connectionPrompt\([\s\S]*?\n\}/.exec(source)![0];
	const chatPrompt = /export function chatConnectionPrompt\([\s\S]*?\n\}/.exec(source)![0];
	const exports: any = {};
	const calls: { terminal?: any; clipboard?: string; shown?: boolean; refusal?: string } = {};
	runInNewContext(transpileModule(`${command}\n${prompt}\n${chatPrompt}`, {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText, {
		exports, serverName: 'ai-browser', plainInPrompt: (text: string) => text,
		refuseRemoteWorkspace: () => false, scopeNote: () => '', confirm() {},
		refuse: (text: string) => { calls.refusal = text; },
		chooseAgentBinary: async () => ({ chosen: installed ? { path: '/tools/opencode', version } : undefined }),
		workspaceFolder: () => folder,
		os: { homedir: () => '/home/test' },
		vscode: {
			l10n: { t: (text: string) => text },
			env: { clipboard: { writeText: async (text: string) => { calls.clipboard = text; } } },
			window: { createTerminal: (options: any) => { calls.terminal = options; return { show: () => { calls.shown = true; } }; } },
		},
	});
	return { api: exports, calls };
}

test('OpenCode uses a local home directory for virtual workspaces', async () => {
	const { api, calls } = fixture('2.1.1', true, { uri: { scheme: 'vscode-vfs', fsPath: '/owner/repo' } });
	await api.connectOpenCode({ url: 'http://localhost/mcp', token: 'private-token' });
	assert.equal(calls.terminal.cwd, '/home/test');
	assert.equal(calls.shown, true);
});

for (const version of ['1.2.0', '2.1.1']) {
	test(`OpenCode ${version}: passes authenticated browser tools to the terminal without copying credentials`, async () => {
		const { api, calls } = fixture(version);
		await api.connectOpenCode({ url: 'http://127.0.0.1:9222/mcp', token: 'private-token' });
		assert.equal(calls.terminal.shellPath, '/tools/opencode');
		assert.equal(calls.terminal.cwd, '/project with spaces');
		assert.equal(calls.shown, true);
		const config = JSON.parse(calls.terminal.env.OPENCODE_CONFIG_CONTENT);
		const entry = (version.startsWith('2.') ? config.mcp.servers : config.mcp)['ai-browser'];
		assert.equal(entry.url, 'http://127.0.0.1:9222/mcp');
		assert.equal(entry.headers.Authorization, 'Bearer private-token');
		assert.equal(entry.oauth, false);
		assert.match(calls.clipboard!, /browser_state/);
		assert.ok(!calls.clipboard!.includes('private-token'));
	});
}

test('missing OpenCode reports installation needed without opening a shell', async () => {
	const { api, calls } = fixture('', false);
	await api.connectOpenCode({ url: 'http://localhost/mcp', token: 'private-token' });
	assert.match(calls.refusal!, /Install OpenCode/);
	assert.equal(calls.terminal, undefined);
});

test('Pi and OpenRouter prompts use automatic chat tools and name the shared tab', () => {
	const { api } = fixture('2.1.1');
	for (const name of ['Pi', 'OpenRouter']) {
		const prompt = api.chatConnectionPrompt(name, { title: 'Example page', url: 'https://example.com' });
		assert.ok(prompt.includes(name));
		assert.match(prompt, /provided automatically/);
		assert.match(prompt, /browser_state/);
		assert.match(prompt, /Example page/);
		assert.match(prompt, /Do not add or edit any MCP configuration/);
	}
});
