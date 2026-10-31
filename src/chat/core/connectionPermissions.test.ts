import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import * as commands from './commands.ts';

test('connection restrictions are independent and default to supported actions enabled', () => {
	const defaults = commands.readConnectionPermissions(undefined);
	assert.ok(Object.values(defaults.chrome).every(Boolean));
	const permissions = commands.readConnectionPermissions({ chrome: { conversations: false, git: false }, exchange: { messages: false } });
	assert.match(commands.remoteRefusal('chrome', 'newTab', permissions)!, /disabled for Chrome/);
	assert.equal(commands.remoteRefusal('exchange', 'newTab', permissions), undefined);
	assert.equal(commands.surfaceControls('chrome', permissions).newTab.s, 'off');
	assert.match(commands.remoteRefusal('exchange', 'send', permissions)!, /disabled for Exchange/);
	assert.equal(commands.remoteRefusal('chrome', 'send', permissions), undefined);
	assert.equal(commands.remoteRefusal('chrome', 'stop', permissions), undefined);
	assert.equal(commands.remoteRefusal('exchange', 'stop', permissions), undefined);
	assert.ok(commands.remoteRefusal('chrome', 'setConnectionPermission', permissions));
	assert.ok(commands.remoteRefusal('exchange', 'setConnectionPermission', permissions));
	assert.ok(commands.remoteRefusal('chrome', 'unknownCommand', defaults));
	const noApprovals = commands.readConnectionPermissions({ chrome: { approvals: false } });
	assert.ok(commands.remoteRefusal('chrome', 'approve', noApprovals));
	assert.ok(commands.remoteRefusal('chrome', 'setApprovalMode', noApprovals));
});

test('host-side restrictions use user settings and ignore repository settings', () => {
	let user: unknown;
	const exports: Record<string, unknown> = {};
	const config = { inspect: () => ({ globalValue: user, workspaceValue: { chrome: { conversations: false } } }) };
	runInNewContext(transpileModule(readFileSync('src/chat/connectionPermissions.ts', 'utf8'), {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText, { exports, require: (name: string) => name === 'vscode' ? { workspace: { getConfiguration: () => config } } : commands });
	const api = exports as unknown as typeof import('../connectionPermissions');
	assert.equal(api.remoteRefusal('chrome', 'newTab'), undefined);
	user = { chrome: { conversations: false } };
	assert.match(api.remoteRefusal('chrome', 'newTab')!, /disabled for Chrome/);
	assert.equal(api.remoteRefusal('exchange', 'newTab'), undefined);
});

test('trusted Chrome terminal defaults and website opt-in are independent', () => {
	const source = readFileSync('src/chat/chatView.ts', 'utf8');
	const values: Record<string, boolean> = {};
	const methods = ['remoteTerminalSetting', 'remoteTerminalOpenSetting'].map(name => new RegExp(`export function ${name}\\([^]*?\\n}`).exec(source)![0].replace('export ', '')).join('\n');
	const read = runInNewContext(transpileModule(`${methods}\n({ remoteTerminalSetting, remoteTerminalOpenSetting });`, {
		compilerOptions: { target: ScriptTarget.ES2022 },
	}).outputText, { vscode: { workspace: { getConfiguration: () => ({ inspect: (key: string) => ({ globalValue: values[key] }) }) } } });
	assert.equal(read.remoteTerminalSetting('chrome'), true);
	assert.equal(read.remoteTerminalOpenSetting('shell', 'chrome'), true);
	assert.equal(read.remoteTerminalSetting('exchange'), false);
	assert.equal(read.remoteTerminalOpenSetting('shell', 'exchange'), false);
	values.chromeTerminalAccess = false;
	values.remoteTerminal = true;
	assert.equal(read.remoteTerminalSetting('chrome'), false);
	assert.equal(read.remoteTerminalSetting('exchange'), true);
});
