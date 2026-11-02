import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import * as protocol from './agentProtocol.ts';
import * as refs from './attachmentReferences.ts';
import * as files from './messageFiles.ts';
import * as pins from './terminalPins.ts';
import * as toolbar from './toolbarText.ts';
import * as notify from '../core/notifyText.ts';
import * as visualizations from './visualizationProtocol.ts';
import * as store from './visualizationStore.ts';
import { ownedSelection } from './ownedChats.ts';
import type { TabHost } from './chatTab.ts';
import type { AgentEvent } from './agentProtocol.ts';

const nativeRequire = createRequire(resolve('package.json'));
const exports: any = {};
const dependencies: Record<string, unknown> = {
	vscode: { l10n: { t: (text: string) => text } }, './agentProtocol': protocol, './agents': { agentNames: { codex: 'Codex', claude: 'Claude' } },
	'./attachmentReferences': refs, './messageFiles': files, './terminalPins': pins, './toolbarText': toolbar, '../core/notifyText': notify,
	'../core/uuid': { generateUuid: randomUUID }, './visualizationProtocol': visualizations, './visualizationStore': store,
};
runInNewContext(transpileModule(readFileSync('src/chat/chatTab.ts', 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText,
	{ exports, process, Buffer, setTimeout, clearTimeout, require: (name: string) => dependencies[name] ?? nativeRequire(name) });
const { ChatTab, newChat } = exports as typeof import('./chatTab.ts');

function fixture() {
	const ended: string[] = [];
	const host: TabHost = { cwd: () => '/tmp', projectRoot: () => undefined, ownSettings: () => true, changed() {}, limits() {}, turnEnded() {},
		save: async () => {}, inHistory: () => false, approvalMode: () => 'ask', noteServer() {}, released() {},
		managedTaskEnded: chat => ended.push(chat.managed!.tasks.task.state) };
	const chat = newChat('codex');
	chat.managed = { ownerChatId: 'parent', createFingerprint: 'create', generation: 0, selection: { agent: 'codex', model: 'chosen', effort: 'high' }, receipts: {},
		tasks: { task: { id: 'task', generation: 0, state: 'running', createdAt: 1 } }, currentTaskId: 'task' };
	const tab = new ChatTab(host, chat);
	Reflect.set(tab, '_visualizationInstruction', async () => '');
	const sent: { text: string; model: string; effort: string | undefined }[] = [];
	let disposed = 0;
	const session = { running: false, ref: 'provider-session', send: async (input: { text: string }, model: string, effort?: string) => { sent.push({ text: input.text, model, effort }); session.running = true; return true; },
		stop() { session.running = false; }, dispose() { disposed++; } };
	Reflect.set(tab, '_session', session);
	const event = (event: AgentEvent) => { if (event.type === 'turnEnd') { session.running = false; } Reflect.get(tab, '_onAgentEvent').call(tab, event); };
	const send = () => tab.send('Assignment', [], 'codex', 'chosen', 'high', {} as any);
	return { tab, chat, send, event, ended, sent, get disposed() { return disposed; } };
}

test('real ChatTab uses the selected model and reports task completion, failures and cancellation', async () => {
	for (const [error, state] of [[undefined, 'completed'], ['Invalid request', 'failed'], ['Stopped.', 'cancelled']] as const) {
		const s = fixture();
		await s.send();
		assert.equal(s.sent[0].model, 'chosen'); assert.equal(s.sent[0].effort, 'high');
		s.event({ type: 'text', text: 'Result' }); s.event({ type: 'turnEnd', error });
		assert.equal(s.chat.managed!.tasks.task.state, state);
		assert.equal(s.ended[0], state);
		assert.equal(s.chat.entries.some(entry => entry.kind === 'assistant' && entry.text === 'Result'), true);
		s.tab.discard();
	}
});

test('Stop during asynchronous prompt preparation prevents a late provider request', async () => {
	const s = fixture();
	let release!: () => void;
	Reflect.set(s.tab, '_visualizationInstruction', () => new Promise<string>(resolve => { release = () => resolve(''); }));
	const pending = s.send();
	s.tab.stop(); release();
	assert.equal(await pending, false);
	assert.equal(s.sent.length, 0);
	s.tab.discard();
});

test('backend replacement and disappearance interrupt an active worker instead of cancelling it', async () => {
	for (const gone of [false, true]) {
		const s = fixture();
		await s.send();
		s.tab.backendReplaced('codex', gone);
		assert.equal(s.chat.managed!.tasks.task.state, 'interrupted');
		assert.match(s.chat.managed!.tasks.task.error!, /backend/);
		assert.deepEqual(s.ended, ['interrupted']);
		s.tab.discard();
	}
});

test('backend loss also interrupts a worker waiting for an automatic retry', async () => {
	const s = fixture();
	await s.send();
	s.event({ type: 'turnEnd', error: 'Selected model is at capacity. Please try a different model.' });
	assert.equal(s.chat.managed!.tasks.task.state, 'running');
	assert.equal(s.ended.length, 0);
	s.tab.backendReplaced('codex', true);
	assert.equal(s.chat.managed!.tasks.task.state, 'interrupted');
	assert.deepEqual(s.ended, ['interrupted']);
	s.tab.discard();
});

test('reset lifecycle disposes the prior provider session and never resumes its ref', () => {
	const s = fixture();
	s.chat.ref = 'old-provider-session';
	const next = { ...newChat('claude', s.chat.id), managed: { ...s.chat.managed!, generation: 1, selection: { agent: 'claude' as const, model: 'sonnet' }, tasks: {}, currentTaskId: undefined } };
	s.tab.discard(); s.tab.start(next);
	assert.equal(s.disposed, 1);
	assert.equal(s.tab.chat.id, s.chat.id); assert.equal(s.tab.chat.ref, undefined);
	assert.equal(s.tab.chat.entries.length, 0);
	s.tab.discard();
});

test('production selection keeps worker settings independent of global model preferences', () => {
	const source = readFileSync('src/chat/chatView.ts', 'utf8');
	const selection = /\tprivate _selection\([\s\S]*?\n\t\}/.exec(source)![0].replace('private _selection', 'function selection');
	const select = /\tprivate _select\([\s\S]*?\n\t\}/.exec(source)![0].replace('private _select', 'function select');
	const methods = runInNewContext(transpileModule(`${selection}\n${select}\n({selection,select});`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText,
	{ ownedSelection, ChatViewProvider: { _ownedLaunches: new Map() } });
	const s = fixture();
	const state: any = { _active: { chat: s.chat, busy: false, queuedCount: 0 }, _remembered: { models: { codex: 'global-default' } },
		_registry: { agents: [{ id: 'codex', available: true, models: [{ id: 'new-model', efforts: ['low'], defaultEffort: 'low' }] }] }, _save: async () => {}, _post() {} };
	state._selection = methods.selection;
	assert.equal(methods.selection.call(state).model, 'chosen');
	methods.select.call(state, { agent: 'codex', model: 'new-model' });
	assert.equal(s.chat.managed!.selection.model, 'new-model');
	assert.equal(state._remembered.models.codex, 'global-default');
	s.tab.discard();
});

test('a manual message refused during a managed task is restored to its original draft', async () => {
	const source = readFileSync('src/chat/chatView.ts', 'utf8');
	const method = /\tprivate async _send\([\s\S]*?\n\t\}/.exec(source)![0].replace('private async _send', 'async function send');
	const s = fixture();
	const send = runInNewContext(transpileModule(`${method}\nsend;`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText,
	{ ownedSelection, ChatViewProvider: { _ownedLaunches: new Map([[s.chat.id, 'task']]) } });
	const posted: any[] = [];
	const view = { _tabs: [s.tab], _active: s.tab, _blocked: () => false, _rememberInput: async () => {}, _selection: () => s.chat.managed!.selection,
		_registry: { detecting: false, backend: () => ({}), agents: [{ id: 'codex', available: true, models: [{ id: 'chosen', efforts: ['high'] }] }] },
		_postMessage: (message: unknown) => posted.push(message) };
	await send.call(view, 'Follow-up', s.tab.id);
	assert.equal(posted[0].type, 'restoreDraft'); assert.equal(posted[0].text, 'Follow-up'); assert.equal(posted[0].chatId, s.chat.id);
	assert.equal(s.sent.length, 0);
	s.tab.discard();
});

