import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as path from 'node:path';
import { createSourceFile, isClassDeclaration, transpileModule, ModuleKind, ScriptTarget, ScriptKind } from 'typescript';

function fixture() {
	let close: (terminal: any) => void = () => {};
	let changed = 0, removedListener = false;
	const completed: string[] = [], created: any[] = [], checked: any[] = [];
	let statusError: Error | undefined;
	const vscode = { window: {
		onDidCloseTerminal(fn: typeof close) { close = fn; return { dispose() { removedListener = true; } }; },
		createTerminal(options: any) { const terminal = { options, shown: 0, disposed: false, show() { this.shown++; }, dispose() { this.disposed = true; } }; created.push(terminal); return terminal; },
		showErrorMessage() {},
	}, ThemeIcon: class { id: string; constructor(id: string) { this.id = id; } } };
	const exports: any = {};
	const code = transpileModule(readFileSync('src/chat/agentAuthentication.ts', 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
	runInNewContext(code, { exports, process: { env: { PATH: '/usr/bin', CLAUDECODE: 'nested', CLAUDE_CODE_ENTRYPOINT: 'parent' } }, require(name: string) {
		if (name === 'vscode') return vscode;
		if (name === 'node:path') return path;
		if (name === './agentAuthText') { const leaf: any = {}; runInNewContext(transpileModule(readFileSync('src/chat/agentAuthText.ts', 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText, { exports: leaf }); return leaf; }
		if (name === '../core/safeFiles') return { privateTempDirectory: async () => '/private/agent-sign-in' };
		if (name === 'node:child_process') return { execFile(binary: string, args: string[], options: any, callback: (error?: Error) => void) { checked.push({ binary, args, options }); callback(statusError); } };
		throw new Error(name);
	} });
	const login = new exports.AgentAuthentication(() => changed++, async (id: string) => { completed.push(id); });
	return { exports, login, created, checked, completed, close: (t: any) => close(t), changed: () => changed, removed: () => removedListener,
		statusError(error: Error) { statusError = error; } };
}

test('credential failures across all three agents are distinguished from transient and local errors', () => {
	const { exports } = fixture();
	for (const text of ['Failed to authenticate: OAuth session expired and could not be refreshed',
		'Your access token could not be refreshed because your refresh token was already used.',
		'Gemini CLI is not signed in', 'invalid_grant', 'HTTP 401 Unauthorized', 'invalid_api_key']) {
		assert.equal(exports.isAgentAuthenticationError(text), true, text);
	}
	for (const text of ['Usage limit reached', '429 Too many requests', 'Connection failed', 'Permission denied: /project/file', 'Service unavailable']) {
		assert.equal(exports.isAgentAuthenticationError(text), false, text);
	}
});

test('duplicate sign-in requests reuse one terminal with the selected binary and no shell interpolation', async () => {
	const f = fixture();
	await Promise.all([f.login.start('claude', '/cli with spaces/claude'), f.login.start('claude', '/cli with spaces/claude')]);
	assert.equal(f.created.length, 1);
	const terminal = f.created[0];
	assert.equal(terminal.options.shellPath, '/cli with spaces/claude');
	assert.equal(JSON.stringify(terminal.options.shellArgs), JSON.stringify(['auth', 'login']));
	assert.equal(terminal.options.cwd, '/private/agent-sign-in');
	assert.equal(terminal.options.env.CLAUDECODE, null);
	assert.equal(terminal.options.env.CLAUDE_CODE_ENTRYPOINT, null);
	assert.equal(terminal.options.env.GEMINI_CLI_TRUST_WORKSPACE, 'false');
	await f.login.start('claude', '/different');
	assert.equal(f.created.length, 1); assert.equal(terminal.shown, 2);
	assert.equal(f.login.active('claude'), true);
});

test('only closing the matching successful sign-in refreshes that agent; cancellation is not success', async () => {
	const f = fixture();
	await f.login.start('codex', '/cli/codex'); await f.login.start('gemini', '/cli/gemini');
	assert.equal(JSON.stringify(f.created[0].options.shellArgs), JSON.stringify(['login']));
	assert.equal(JSON.stringify(f.created[1].options.shellArgs), JSON.stringify(['--prompt-interactive', '/auth']));
	f.close({ exitStatus: { code: 0 } }); assert.equal(f.completed.length, 0);
	f.close(Object.assign(f.created[0], { exitStatus: { code: 0 } }));
	assert.deepEqual(f.completed, ['codex']); assert.equal(f.login.active('codex'), false);
	f.close(Object.assign(f.created[1], { exitStatus: { code: 1 } }));
	assert.deepEqual(f.completed, ['codex']); assert.equal(f.login.active('gemini'), false);
});

test('status checks use the chosen binary and hide account output and failure details', async () => {
	const f = fixture();
	await f.exports.checkAgentLogin('claude', '/cli/claude');
	assert.equal(f.checked[0].binary, '/cli/claude');
	assert.equal(JSON.stringify(f.checked[0].args), JSON.stringify(['auth', 'status']));
	assert.equal(f.checked[0].options.env.CLAUDECODE, undefined);
	f.statusError(new Error('sensitive account details'));
	await assert.rejects(f.exports.checkAgentLogin('codex', '/cli/codex'), (error: any) => {
		assert.match(error.message, /could not be confirmed/); assert.doesNotMatch(error.message, /sensitive/); return true;
	});
	await f.exports.checkAgentLogin('gemini', '/cli/gemini');
	assert.equal(f.checked.length, 2);
});

test('disposing while sign-in is starting creates no orphan terminal', async () => {
	const f = fixture();
	const pending = f.login.start('claude', '/cli/claude'); f.login.dispose(); await pending;
	assert.equal(f.created.length, 0); assert.equal(f.removed(), true);
	await f.login.start('codex', '/cli/codex'); assert.equal(f.created.length, 0);
});

test('checking credentials restarts only the chosen agent and refuses to interrupt a running reply', async () => {
	const source = readFileSync('src/chat/agents.ts', 'utf8');
	const ast = createSourceFile('agents.ts', source, ScriptTarget.ES2022, true, ScriptKind.TS);
	const subject = ast.statements.filter(isClassDeclaration).find(c => c.name?.text === 'AgentRegistry')!;
	const members = subject.members.filter(m => ['checkAuthentication', 'redetect', '_drop'].includes(m.name?.getText(ast) ?? ''));
	const Subject = runInNewContext(transpileModule(`class Subject { ${members.map(m => m.getText(ast)).join('\n')} }\nSubject;`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText,
		{ isAgentId: (id: string) => ['claude', 'codex', 'gemini'].includes(id), checkAgentLogin: async () => {}, agentNames: { claude: 'Claude Code' } });
	const host = new Subject();
	const dropped: string[] = [], replaced: string[] = [];
	const backend = (id: string) => ({ running: false, dispose() { dropped.push(id); } });
	const claude = backend('claude'), codex = backend('codex');
	Object.assign(host, { _agents: [{ id: 'claude', binary: '/cli/claude' }, { id: 'codex', binary: '/cli/codex' }],
		_backends: new Map([['claude', { backend: claude }], ['codex', { backend: codex }]]),
		_commandLists: new Map(), _commandsAsked: new Map(), _onDidChange: { fire() {} },
		_onDidReplace: { fire(event: any) { replaced.push(event.agent); } },
		_detectOne: async (id: string) => ({ id, available: true }),
	});
	claude.running = true;
	await assert.rejects(host.checkAuthentication('claude'), /finish its replies/);
	assert.deepEqual(dropped, []);
	claude.running = false;
	await host.checkAuthentication('claude');
	assert.deepEqual(dropped, ['claude']); assert.deepEqual(replaced, ['claude']);
	assert.equal(host._backends.get('codex').backend, codex);
});
