import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { createSourceFile, ScriptTarget, forEachChild, isMethodDeclaration, transpileModule } from 'typescript';
import * as linked from './linkedChats.ts';

test('production adapter persists directed grants and closed-chat notes across restarts, and serializes revoke with writes', async () => {
	const source = createSourceFile('view.ts', readFileSync('src/chat/chatView.ts', 'utf8'), ScriptTarget.Latest, true);
	const wanted = new Set(['_history', '_chatLinks', '_linkedChatCatalog', '_linkedChatApi', '_linkedChatContext', '_changeChatLink', '_save']);
	const methods: string[] = [];
	function visit(node: import('typescript').Node): void {
		if (isMethodDeclaration(node) && wanted.has(node.name.getText(source))) { methods.push(node.getText(source)); }
		forEachChild(node, visit);
	}
	visit(source);
	assert.equal(methods.length, wanted.size);
	const Adapter = runInNewContext(transpileModule(`class ChatViewProvider {
		static _surfaces = new Map(); static _ownedLaunches = new Map(); static _chatLinkWrites = Promise.resolve(); static _postAll() {}
		_blocked() { return false; } _selection() { return {model:'test-model'}; }
		_findOpenChat(id) { for (const surface of ChatViewProvider._surfaces.values()) { const tab=surface._tabs.find(t=>t.chat.id===id); if(tab) return {surface,tab}; } }
		${methods.join('\n')}
	}
	ChatViewProvider;`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText,
	{ ...linked, historyKey: 'history', historyLimit: 50, workerHistoryLimit: 100, started: (chat: any) => chat.entries.some((entry: any) => entry.kind === 'user'), storedEntries: (entries: any[]) => entries });
	const data = new Map<string, any>();
	const workspaceState = { get: (key: string) => structuredClone(data.get(key)), update: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); } };
	const a: any = { id: 'a', title: 'Source', agent: 'codex', entries: [], createdAt: 1, updatedAt: 1, stats: {} };
	const b: any = { ...a, id: 'b', title: 'Closed target', agent: 'claude', entries: [] };
	data.set('history', [b]);
	function boot() {
		const view = new Adapter();
		view._context = { workspaceState };
		view._active = { chat: a };
		view._tabs = [view._active];
		Adapter._surfaces.clear(); Adapter._surfaces.set('editor', view);
		return view;
	}
	let view = boot();
	await view._changeChatLink('a', 'b', 'readWrite');
	view = boot();
	let api = view._linkedChatApi();
	const request = { chatId: 'b', requestId: 'one', text: 'Remember this finding' };
	const first = await api.run('chat_add_note', 'a', request);
	assert.equal(first.duplicate, false);
	assert.equal(view._tabs.length, 1, 'writing a closed chat must not open it or start an AI');
	view = boot(); api = view._linkedChatApi();
	assert.equal((await api.run('chat_add_note', 'a', request)).duplicate, true);
	const messages = await api.run('chat_read_messages', 'a', { chatId: 'b' });
	assert.match(messages.items[0].text, /Remember this finding/);
	assert.equal(messages.items[0].source.chatId, 'a');
	// Simultaneous UI changes are queued and read the latest stored grant set.
	await Promise.all([view._changeChatLink('a', 'b', 'readWrite'), view._changeChatLink('a', 'b', 'read')]);
	assert.equal(view._chatLinks()[0].access, 'read');
	await view._changeChatLink('a', 'b', 'read');
	await assert.rejects(api.run('chat_add_note', 'a', { ...request, requestId: 'two' }), /access denied/);
	await view._changeChatLink('a', 'b');
	await assert.rejects(api.run('chat_read_messages', 'a', { chatId: 'b' }), /access denied/);
	view = boot();
	assert.equal(view._chatLinks().length, 0);
	assert.equal(data.get('history')[0].entries.length, 1);

	// A live streaming save sees the note before the first persistence await.
	await view._changeChatLink('a', 'b', 'readWrite');
	const live = { chat: structuredClone(data.get('history')[0]), push(note: any) { this.chat.entries.push(note); } };
	view._tabs.push(live);
	await view._linkedChatApi().run('chat_add_note', 'a', { ...request, requestId: 'live' });
	assert.equal(live.chat.entries.length, 2);
	assert.equal(Object.keys(live.chat.linkedNoteReceipts).length, 2);
	const originalUpdate = workspaceState.update;
	workspaceState.update = async () => { throw new Error('Disk full'); };
	await assert.rejects(view._linkedChatApi().run('chat_add_note', 'a', { ...request, requestId: 'failed' }), /Disk full/);
	assert.equal(live.chat.entries.length, 2, 'a failed write rolls back the live note');
	assert.equal(Object.keys(live.chat.linkedNoteReceipts).length, 2);
	workspaceState.update = originalUpdate;
});
