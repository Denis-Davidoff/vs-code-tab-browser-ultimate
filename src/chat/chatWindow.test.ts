import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule, ScriptTarget } from 'typescript';

function setup(supported = true, failMove = false) {
	const source = readFileSync('src/chat/chatView.ts', 'utf8');
	const method = /\tpublic async newChat\([\s\S]*?\n\t\}/.exec(source)![0].replace('public async newChat', 'async function createChat');
	const messages: any[] = [], added: string[] = [], commands: string[] = [], children: any[] = [], errors: unknown[] = [];
	let closed = false;
	let onClose = () => {};
	const panel = {
		webview: {}, visible: true,
		onDidDispose: (listener: () => void) => { onClose = listener; },
		onDidChangeViewState: () => ({ dispose() {} }), reveal() {},
		dispose() { closed = true; onClose(); },
	};
	class Child {
		static _openingWindow = false;
		disposed = false;
		constructor(...args: any[]) { children.push(this); Object.assign(this, { args }); }
		_bindView(_view: unknown) {}
		dispose() { this.disposed = true; }
	}
	const create = runInNewContext(transpileModule(`${method}\ncreateChat;`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, {
		ChatViewProvider: Child, newChat: (agent: string) => ({ agent }), refuse: (text: string) => errors.push(text),
		vscode: { l10n: { t: (text: string) => text }, ViewColumn: { Active: -1 },
			window: { createWebviewPanel: () => panel }, commands: {
				getCommands: async () => supported ? ['workbench.action.moveEditorToNewWindow'] : [],
				executeCommand: async (command: string) => { commands.push(command); if (failMove) { throw new Error('move failed'); } },
			} },
	});
	const host = { _remembered: { agent: 'codex' }, _selection: () => ({}), _active: { chat: { folder: '/project', copy: { repo: 'a/b' }, references: [] } },
		_tabs: [] as any[], _selectTab: (_id: string) => {}, _focusInput: () => {},
		_windows: new Set(), _postMessage: (message: any) => messages.push(message), _addTab: (agent: string) => added.push(agent), _fail: (error: unknown) => errors.push(error) };
	return { create: (location?: string) => create.call(host, location), messages, added, children, commands, errors, panel, host, closed: () => closed };
}

test('request asks first; opening here creates only a local tab', async () => {
	const s = setup();
	await s.create();
	assert.equal(s.messages[0].type, 'chooseNewChatLocation');
	assert.equal(s.children.length, 0);
	assert.equal(s.added.length, 0);
	await s.create('here');
	assert.deepEqual(s.added, ['codex']);
});

test('detached chat inherits folder and closing its panel disposes its host', async () => {
	const s = setup();
	await s.create('window');
	assert.equal(s.added.length, 0);
	assert.equal(s.children[0].args[4].folder, '/project');
	assert.equal(s.children[0].args[4].agent, 'codex');
	assert.deepEqual(s.commands, ['workbench.action.moveEditorToNewWindow']);
	s.panel.dispose();
	assert.equal(s.children[0].disposed, true);
	assert.equal(s.host._windows.size, 0);
});

test('unsupported hosts create nothing; failed moves clean up the new panel', async () => {
	const unsupported = setup(false);
	await unsupported.create('window');
	assert.equal(unsupported.children.length, 0);
	assert.equal(unsupported.errors.length, 1);
	const failed = setup(true, true);
	await failed.create('window');
	assert.equal(failed.closed(), true);
	assert.equal(failed.children[0].disposed, true);
	assert.equal(failed.errors.length, 1);
});


test('editor tab creates an independent chat without moving it to a window', async () => {
	const s = setup(false);
	await s.create('tab');
	assert.equal(s.children.length, 1);
	assert.equal(s.children[0].args[4].folder, '/project');
	assert.equal(s.added.length, 0);
	assert.equal(s.commands.length, 0);
	assert.equal(s.errors.length, 0);
	s.panel.dispose();
	assert.equal(s.children[0].disposed, true);
});

 test('adding a chat reuses and highlights an existing empty tab', async () => {
	const s = setup();
	s.host._tabs.push({ id: 'empty', started: false });
	let selected = '';
	s.host._selectTab = id => { selected = id; };
	await s.create('here');
	assert.equal(selected, 'empty');
	assert.equal(s.added.length, 0);
	assert.deepEqual(s.messages.map(m => ({ ...m })), [{ type: 'flashTab', id: 'empty' }]);
});
