import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { LinkedChats, ensureChatEntryIds, linkedNoteDigest, readChatLinks, type LinkedChat, type ChatLink } from './linkedChats.ts';

function fixture() {
	const chat = (id: string): LinkedChat => ({ id, title: id, agent: id === 'a' ? 'codex' : 'claude', createdAt: 1, updatedAt: 2,
		entries: [{ kind: 'user', text: `question ${id}`, attachments: [] }, { kind: 'assistant', text: `answer ${id}` }], historyCompleteness: 'full' });
	let chats = [chat('a'), chat('b'), chat('c')];
	let links: ChatLink[] = [{ ownerChatId: 'a', targetChatId: 'b', access: 'read' }, { ownerChatId: 'b', targetChatId: 'c', access: 'readWrite' }];
	let writes = 0;
	const api = new LinkedChats({ chats: () => chats, links: () => links, addNote: async (id, note) => {
		const target = chats.find(chat => chat.id === id)!;
		target.entries.push(note);
		target.linkedNoteReceipts = { ...target.linkedNoteReceipts, [note.id!]: linkedNoteDigest(note.linkedNote!.text) };
		writes++;
	} });
	return { api, get chats() { return chats; }, get links() { return links; }, get writes() { return writes; },
		restart() { chats = JSON.parse(JSON.stringify(chats)); links = readChatLinks(JSON.parse(JSON.stringify(links))); },
		revoke() { links = links.filter(link => link.ownerChatId !== 'a'); },
		run: (name: string, args: Record<string, unknown> = {}, caller = 'a') => api.run(name, caller, args) as Promise<any> };
}

test('access is directed and nontransitive, including metadata and search', async () => {
	const s = fixture();
	assert.deepEqual((await s.run('chat_list')).items.map((item: any) => item.chatId), ['a', 'b']);
	for (const name of ['chat_get_metadata', 'chat_search', 'chat_read_messages']) {
		const args = { chatIds: ['c'], chatId: 'c', query: 'answer' };
		await assert.rejects(s.run(name, args), /access denied/);
		await assert.rejects(s.run(name, { ...args, chatIds: ['a'], chatId: 'a' }, 'b'), /access denied/);
	}
	await assert.rejects(s.run('chat_add_note', { chatId: 'b', requestId: 'r', text: 'hello' }), /access denied/);
	await assert.rejects(s.run('chat_list', {}, 'unknown'), /no longer available/);
});

test('stable IDs, cursors and conditional revisions survive persistence, and revocation blocks continuations', async () => {
	const s = fixture();
	const first = await s.run('chat_read_messages', { chatId: 'b', limit: 1 });
	assert.ok(first.nextCursor);
	s.restart();
	const same = await s.run('chat_read_messages', { chatId: 'b', limit: 1 });
	assert.equal(first.items[0].messageId, same.items[0].messageId);
	assert.equal(first.revision, same.revision);
	assert.equal((await s.run('chat_read_messages', { chatId: 'b', limit: 1, ifRevision: first.revision })).notModified, true);
	const next = await s.run('chat_read_messages', { chatId: 'b', limit: 1, cursor: first.nextCursor });
	assert.notEqual(first.items[0].messageId, next.items[0].messageId);
	await assert.rejects(s.run('chat_read_messages', { chatId: 'b', limit: 2, cursor: first.nextCursor }), /Cursor/);
	s.chats[1].entries[1] = { ...s.chats[1].entries[1], text: 'changed' } as any;
	await assert.rejects(s.run('chat_read_messages', { chatId: 'b', limit: 1, cursor: first.nextCursor }), /Cursor/);
	s.revoke();
	await assert.rejects(s.run('chat_read_messages', { chatId: 'b', limit: 1, cursor: first.nextCursor }), /access denied/);
});

test('bounded Unicode text can be reconstructed, with full tool bodies only on request', async () => {
	const s = fixture();
	const original = '🙂漢字"\\\n'.repeat(3000);
	s.chats[1].entries = [{ kind: 'assistant', text: original }];
	let offset = 0, reconstructed = '';
	do {
		const page = await s.run('chat_read_messages', { chatId: 'b', maxBytes: 2048, maxMessageChars: 20000,
			...(offset ? { messageIds: [s.chats[1].entries[0].id], textOffset: offset } : {}) });
		assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 2048);
		const item = page.items[0];
		assert.ok(item.text.length > 0);
		reconstructed += item.text;
		offset = item.textNextOffset;
	} while (offset !== null);
	assert.equal(reconstructed, original);
	s.chats[1].entries = [{ kind: 'tool', id: 'tool', tool: 'command', name: 'Shell', status: 'done', startedAt: 1, output: 'private output' }];
	assert.doesNotMatch(JSON.stringify(await s.run('chat_read_messages', { chatId: 'b' })), /private output/);
	assert.match(JSON.stringify(await s.run('chat_read_messages', { chatId: 'b', detail: 'full' })), /private output/);
});

test('pagination accepts the same query parameters in a different JSON key order', async () => {
	const s = fixture();
	const queries: [string, Record<string, unknown>][] = [
		['chat_list', { limit: 1, fields: ['title'] }],
		['chat_get_metadata', { chatIds: ['a', 'b'], limit: 1, fields: ['title'] }],
		['chat_read_messages', { chatId: 'b', limit: 1, order: 'oldest' }],
		['chat_search', { query: 'answer', chatIds: ['a', 'b'], limit: 1 }],
	];
	for (const [name, args] of queries) {
		const first = await s.run(name, args);
		assert.ok(first.nextCursor, name);
		const reordered = Object.fromEntries([['cursor', first.nextCursor], ...Object.entries(args).reverse()]);
		const next = await s.run(name, reordered);
		assert.equal(next.items.length, 1, name);
		assert.notDeepEqual(next.items, first.items, name);
		assert.equal(next.nextCursor, null, name);
	}
});

test('search fragments lead to stable surrounding messages, and incompleteness is explicit', async () => {
	const s = fixture();
	s.chats[1].historyCompleteness = 'partial';
	s.chats[1].entries.push({ kind: 'thinking', text: 'hidden secret', startedAt: 1 });
	const search = await s.run('chat_search', { query: 'ANSWER B', chatIds: ['b'] });
	assert.equal(search.items.length, 1);
	assert.equal(search.historyCompleteness.b, 'partial');
	assert.equal((await s.run('chat_search', { query: 'hidden secret', detail: 'full' })).items.length, 0);
	const around = await s.run('chat_read_messages', { chatId: 'b', aroundMessageId: search.items[0].messageId, order: 'oldest' });
	assert.deepEqual(around.items.map((item: any) => item.role), ['user', 'assistant']);
	await assert.rejects(s.run('chat_read_messages', { chatId: 'b', aroundMessageId: 'missing' }), /not available/);
	assert.equal((await s.run('chat_get_metadata', { chatIds: ['b'], fields: ['model', 'messageCount'] })).items[0].model, null);
});

test('notes are attributed, idempotent after restart and pruning, and require write access on retries', async () => {
	const s = fixture();
	s.links[0] = { ...s.links[0], access: 'readWrite' };
	const request = { chatId: 'b', requestId: 'unique', text: 'Result from A' };
	const first = await s.run('chat_add_note', request);
	const note = s.chats[1].entries.at(-1)!;
	assert.equal(note.kind, 'notice');
	assert.match(JSON.stringify(note), /sourceChatId.*a/);
	assert.match(JSON.stringify(note), /codex/);
	s.restart();
	assert.equal((await s.run('chat_add_note', request)).duplicate, true);
	s.chats[1].entries = [];
	assert.equal((await s.run('chat_add_note', request)).messageId, first.messageId);
	assert.equal(s.writes, 1);
	await assert.rejects(s.run('chat_add_note', { ...request, text: 'different' }), /different note/);
	s.revoke();
	await assert.rejects(s.run('chat_add_note', request), /access denied/);
});

test('invalid filters, budgets, stale IDs and malformed persisted grants fail explicitly', async () => {
	const s = fixture();
	for (const args of [{ limit: -1 }, { maxBytes: 1 }, { roles: 'user' }, { detail: 'raw' }, { textOffset: 4 }, { from: -1 }, { order: 'random' }]) {
		await assert.rejects(s.run('chat_read_messages', { chatId: 'b', ...args }));
	}
	assert.deepEqual(readChatLinks([{ ownerChatId: 'a', targetChatId: 'a', access: 'read' }, { ownerChatId: 'a', targetChatId: 'b', access: 'all' }, null]), []);
	ensureChatEntryIds(s.chats[1]);
	const id = s.chats[1].entries[1].id;
	s.chats[1].entries = s.chats[1].entries.slice(1);
	ensureChatEntryIds(s.chats[1]);
	assert.equal(s.chats[1].entries[0].id, id);
});

test('metadata does not report a lost runtime as still running after restart', async () => {
	const s = fixture();
	s.chats[1].managed = { ownerChatId: 'a', createFingerprint: 'create', selection: { agent: 'claude', model: 'chosen' }, generation: 0,
		receipts: {}, tasks: { task: { id: 'task', generation: 0, state: 'running', createdAt: 1 } }, currentTaskId: 'task' };
	const args = { chatIds: ['b'] };
	assert.equal((await s.run('chat_get_metadata', args)).items[0].task.state, 'interrupted');
	s.chats[1].runtimeTaskId = 'task';
	assert.equal((await s.run('chat_get_metadata', args)).items[0].task.state, 'running');
});
