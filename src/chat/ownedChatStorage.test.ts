import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { createSourceFile, ScriptTarget, forEachChild, isMethodDeclaration, transpileModule } from 'typescript';
import { OwnedChats, ownedSelection } from './ownedChats.ts';
import * as linked from './linkedChats.ts';

test('production adapter creates background workers, dispatches the chosen model, resets and recovers closed workers', async () => {
	const source = createSourceFile('view.ts', readFileSync('src/chat/chatView.ts', 'utf8'), ScriptTarget.Latest, true);
	const wanted = new Set(['_history', '_chatLinks', '_linkedChatCatalog', '_ownedChatApi', '_launchOwnedTask', '_ownedTaskEnded', '_save']);
	const methods: string[] = [];
	function visit(node: import('typescript').Node): void {
		if (isMethodDeclaration(node) && wanted.has(node.name.getText(source))) { methods.push(node.getText(source)); }
		forEachChild(node, visit);
	}
	visit(source); assert.equal(methods.length, wanted.size);
	const sent: any[] = [];
	let accepted = true;
	let onSend: (() => void) | undefined;
	let disposed = 0, saveTabs = 0;
	class Tab {
		id: string; chat: any; busy = false; waiting = false; queuedCount = 0; paused = false; stopGeneration = 0;
		constructor(_host: unknown, chat: any) { this.id = `tab-${chat.id}`; this.chat = chat; }
		get cwd() { return this.chat.folder ?? '/workspace'; }
		push(entry: unknown) { this.chat.entries.push(entry); }
		discard() { disposed++; }
		start(chat: any) { this.chat = chat; }
		stop() { this.stopGeneration++; this.busy = false; }
		async send(prompt: string, attachments: unknown[], agent: string, model: string, effort: string) {
			sent.push({ prompt, attachments, agent, model, effort }); this.busy = true; onSend?.(); return accepted;
		}
	}
	const Adapter = runInNewContext(transpileModule(`class ChatViewProvider {
		static _surfaces = new Map(); static _ownedLaunches = new Map(); static _postAll() {}
		_blocked() { return false; } _selection(tab) { return tab.chat.managed?.selection ?? {agent:'codex',model:'small'}; }
		_saveTabs() { saveTabs(); } _fail(error) { throw error; } _stopTab(tab) { tab.stop(); }
		_findOpenChat(id) { for (const surface of ChatViewProvider._surfaces.values()) { const tab=surface._tabs.find(t=>t.chat.id===id); if(tab) return {surface,tab}; } }
		${methods.join('\n')}
	} ChatViewProvider;`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText,
	{ ...linked, OwnedChats, ownedSelection, ChatTab: Tab, reopened: structuredClone, structuredClone, historyKey: 'history', historyLimit: 50, workerHistoryLimit: 100,
		tabLimit: () => 10, isDirectory: () => true, saveTabs: () => saveTabs++, started: () => true, storedEntries: (entries: any[]) => entries });
	const data = new Map<string, any>();
	let failWrites = false;
	const workspaceState = { get: (key: string) => structuredClone(data.get(key)), update: async (key: string, value: unknown) => {
		if (failWrites) { throw new Error('Disk full'); }
		data.set(key, structuredClone(value));
	} };
	const parent = { id: 'parent', title: 'Parent', agent: 'codex', entries: [], createdAt: 1, updatedAt: 1, stats: {}, folder: '/workspace' };
	const backend = {};
	function boot() {
		Adapter._surfaces.clear(); Adapter._ownedLaunches.clear();
		const view = new Adapter(); view._context = { workspaceState }; view._tabHost = {}; view._runs = { runningIn: () => 0 };
		view._registry = { agents: [{ id: 'codex', available: true, models: [{ id: 'small', label: 'Small', efforts: ['high'], defaultEffort: 'high', isDefault: true }] }], backend: () => backend };
		view._gitAccess = { launch: async (_cwd: string, current: () => boolean, send: () => Promise<boolean>) => { if (!current()) { throw new Error('Launch cancelled'); } return send(); } };
		view._active = new Tab({}, structuredClone(parent)); view._tabs = [view._active];
		Adapter._surfaces.set('editor', view); return view;
	}
	const drain = () => new Promise<void>(resolve => setImmediate(resolve));
	let view = boot();
	let api = view._ownedChatApi();
	const created = await api.run('chat_create', 'parent', { requestId: 'create', title: 'Worker', agent: 'codex', model: 'small' });
	assert.equal(view._active.chat.id, 'parent'); assert.equal(view._tabs.length, 2);
	assert.ok(saveTabs > 0);
	const child = view._tabs[1];
	const task = await api.run('chat_send_task', 'parent', { requestId: 'task', chatId: created.chatId, text: 'Review the patch' });
	await drain();
	assert.equal(sent.length, 1); assert.equal(sent[0].model, 'small'); assert.equal(sent[0].effort, 'high');
	assert.match(sent[0].prompt, /Review the patch/); assert.equal(sent[0].attachments.length, 0);
	child.busy = false; child.chat.ref = 'provider-session'; child.chat.entries.push({ kind: 'assistant', text: 'Done' });
	Object.assign(child.chat.managed.tasks[task.taskId], { state: 'completed' }); view._ownedTaskEnded(child.chat);
	await view._save(child.chat, true);
	assert.match(view._active.chat.entries[0].text, /completed/);
	await api.run('chat_reset_context', 'parent', { requestId: 'reset', chatId: created.chatId });
	assert.equal(child.chat.entries.length, 0); assert.equal(child.chat.ref, undefined); assert.equal(child.chat.managed.generation, 1);
	assert.ok(disposed > 0);
	failWrites = true;
	await assert.rejects(api.run('chat_reset_context', 'parent', { requestId: 'failed-reset', chatId: created.chatId }), /Disk full/);
	assert.equal(child.chat.managed.generation, 1, 'failed persistence restores the prior context');
	failWrites = false;
	view = boot(); api = view._ownedChatApi();
	assert.equal((await api.run('chat_get_task', 'parent', { chatId: created.chatId, taskId: task.taskId })).task.state, 'completed');
	assert.equal(view._tabs.length, 1, 'status does not open a closed worker');
	await api.run('chat_send_task', 'parent', { requestId: 'new-task', chatId: created.chatId, text: 'Continue' });
	await drain();
	assert.equal(view._tabs.length, 2); assert.equal(view._active.chat.id, 'parent'); assert.equal(sent.length, 2);
	await api.run('chat_stop_task', 'parent', { requestId: 'stop', chatId: created.chatId });
	assert.equal((await api.run('chat_get_task', 'parent', { chatId: created.chatId })).task.state, 'cancelled');
	accepted = false;
	onSend = () => { view._tabs = view._tabs.filter((tab: Tab) => tab.chat.id !== created.chatId); };
	await api.run('chat_send_task', 'parent', { requestId: 'closed-before-launch', chatId: created.chatId, text: 'Late assignment' });
	await drain();
	assert.equal((await api.run('chat_get_task', 'parent', { chatId: created.chatId })).task.state, 'failed');
	assert.equal(Adapter._ownedLaunches.size, 0, 'closing before provider acceptance must not leave a permanently active task');

	// Reuse a live worker for an independent task without creating another tab.
	accepted = true; onSend = undefined;
	const reused = new Tab({}, structuredClone(data.get('history').find((chat: any) => chat.id === created.chatId)));
	reused.chat.ref = 'old-provider-session'; reused.chat.entries.push({ kind: 'assistant', text: 'Prior assignment' });
	view._tabs.push(reused);
	const beforeDisposed = disposed, beforeSent = sent.length;
	const independent = { requestId: 'independent', chatId: created.chatId, text: 'Independent assignment', resetContext: true };
	const freshTask = await api.run('chat_send_task', 'parent', independent);
	await drain();
	assert.equal(view._tabs.length, 2); assert.equal(view._tabs[1], reused);
	assert.equal(reused.chat.id, created.chatId); assert.equal(reused.chat.ref, undefined);
	assert.equal(reused.chat.entries.length, 0); assert.equal(reused.chat.managed.generation, 2);
	assert.equal(freshTask.contextCleared, true); assert.ok(disposed > beforeDisposed);
	assert.equal(sent.length, beforeSent + 1); assert.match(sent.at(-1).prompt, /Independent assignment/);
	reused.chat.entries.push({ kind: 'assistant', text: 'New result' });
	assert.equal((await api.run('chat_send_task', 'parent', independent)).duplicate, true);
	assert.equal(reused.chat.entries.length, 1); assert.equal(sent.length, beforeSent + 1);
	await api.run('chat_stop_task', 'parent', { requestId: 'stop-independent', chatId: created.chatId });
	reused.chat.ref = 'keep-provider-session';
	failWrites = true;
	await assert.rejects(api.run('chat_send_task', 'parent', { ...independent, requestId: 'failed-independent' }), /Disk full/);
	assert.equal(reused.chat.managed.generation, 2); assert.equal(reused.chat.ref, 'keep-provider-session');
	assert.equal(reused.chat.entries[0].text, 'New result'); assert.equal(sent.length, beforeSent + 1);
});
