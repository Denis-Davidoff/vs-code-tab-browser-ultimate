import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { OwnedChats, ownedSelection } from './ownedChats.ts';
import type { StoredChat } from './chatTab.ts';
import type { ChatAgent } from './chatProtocol.ts';
import type { ChatLink } from './linkedChats.ts';

export const ownedTestAgents: ChatAgent[] = [
	{ id: 'codex', name: 'Codex', available: true, models: [{ id: 'small', label: 'Small', efforts: ['low', 'high'], defaultEffort: 'low', isDefault: true }, { id: 'large', label: 'Large', efforts: ['high'], isDefault: false }] },
	{ id: 'claude', name: 'Claude', available: true, models: [{ id: 'sonnet', label: 'Sonnet', efforts: [], isDefault: true }] },
	{ id: 'gemini', name: 'Gemini', available: false, models: [{ id: 'offline', label: 'Offline', efforts: [], isDefault: true }] },
];
function fixture() {
	let chats: StoredChat[] = ['parent', 'other'].map(id => ({ id, title: id, agent: 'codex', createdAt: 1, updatedAt: 1, entries: [],
		folder: '/workspace', stats: { turns: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 } }));
	let links: ChatLink[] = [];
	const active = new Map<string, string>(), busy = new Set<string>();
	const paused = new Set<string>();
	const sent: { source: string; id: string; taskId: string; prompt: string }[] = [];
	const writes: boolean[] = [];
	const api = new OwnedChats({ chats: () => chats, agents: () => ownedTestAgents, links: () => links,
		busy: id => busy.has(id), paused: id => paused.has(id), activeTask: (id, task) => active.get(id) === task,
		create: async (source, chat) => { chats.push(chat); links.push({ ownerChatId: source.id, targetChatId: chat.id, access: 'readWrite' }); },
		write: async (chat, reset) => { chats[chats.findIndex(item => item.id === chat.id)] = chat; writes.push(reset); },
		launch: (source, id, taskId, prompt) => { active.set(id, taskId); sent.push({ source, id, taskId, prompt }); },
		stop: id => { active.delete(id); busy.delete(id); },
	});
	const run = (name: string, args: Record<string, unknown>, caller = 'parent') => api.run(name, caller, args) as Promise<any>;
	const create = (overrides: Record<string, unknown> = {}) => run('chat_create', { requestId: 'create', title: 'Reviewer', agent: 'codex', model: 'small', ...overrides });
	return { run, create, active, busy, paused, sent, writes, get chats() { return chats; }, get links() { return links; },
		restart() { chats = JSON.parse(JSON.stringify(chats)); links = JSON.parse(JSON.stringify(links)); active.clear(); },
		revoke() { links = links.filter(link => link.ownerChatId !== 'parent'); } };
}

test('creation is explicit, idempotent regardless of key order, and grants only directed ownership', async () => {
	const s = fixture();
	const created = await s.create({ purpose: 'Check correctness' });
	const child = s.chats.find(chat => chat.id === created.chatId)!;
	assert.equal(child.managed!.ownerChatId, 'parent');
	assert.equal(child.folder, '/workspace');
	assert.equal(child.managed!.purpose, 'Check correctness');
	assert.equal(s.sent.length, 0);
	assert.equal(s.links.length, 1);
	assert.equal(s.links[0].ownerChatId, 'parent');
	s.restart();
	const retry = await s.run('chat_create', { purpose: 'Check correctness', model: 'small', agent: 'codex', title: 'Reviewer', requestId: 'create' });
	assert.equal(retry.chatId, created.chatId); assert.equal(retry.duplicate, true);
	assert.equal(s.chats.length, 3);
	await assert.rejects(s.create({ model: 'large' }), /different chat/);
	s.revoke();
	await assert.rejects(s.create({ purpose: 'Check correctness' }), /access denied/);
});

test('model discovery is bounded and unavailable or unsupported choices never fall back', async () => {
	const s = fixture();
	const first = await s.run('chat_list_models', { limit: 1 });
	assert.equal(first.items.length, 1); assert.equal(first.nextOffset, 1);
	assert.equal((await s.run('chat_list_models', { agent: 'claude' })).items[0].model, 'sonnet');
	await assert.rejects(s.create({ agent: 'gemini', model: 'offline' }), /unavailable/);
	await assert.rejects(s.create({ model: 'nonexistent' }), /unavailable/);
	await assert.rejects(s.create({ effort: 'impossible' }), /effort/);
	assert.equal(ownedSelection(ownedTestAgents, { agent: 'codex', model: 'large' }).effort, 'high');
	assert.equal(s.chats.length, 2);
});

test('normal linked chats, siblings, callers and descendants cannot be managed as direct children', async () => {
	const s = fixture();
	const { chatId } = await s.create();
	s.links.push({ ownerChatId: 'parent', targetChatId: 'other', access: 'readWrite' });
	for (const name of ['chat_configure', 'chat_reset_context', 'chat_send_task', 'chat_stop_task', 'chat_get_task']) {
		for (const target of ['parent', 'other']) { await assert.rejects(s.run(name, { chatId: target, requestId: 'x', text: 'task' }), /access denied/); }
		await assert.rejects(s.run(name, { chatId, requestId: 'x', text: 'task' }, 'other'), /access denied/);
	}
	s.links[0] = { ...s.links[0], access: 'read' };
	await assert.rejects(s.run('chat_configure', { chatId, requestId: 'configure', model: 'large' }), /access denied/);
});

test('configuration stays per chat and reset starts a new context with stable identity and idempotent generation', async () => {
	const s = fixture();
	const { chatId } = await s.create();
	await s.run('chat_configure', { chatId, requestId: 'config', model: 'large', title: 'Deep reviewer' });
	let child = s.chats.find(chat => chat.id === chatId)!;
	assert.equal(child.managed!.selection.model, 'large');
	assert.equal(s.chats[0].managed, undefined);
	child.entries.push({ kind: 'assistant', id: 'old', text: 'old context' }); child.ref = 'provider-resume';
	child.linkedNoteReceipts = { note: 'receipt' };
	const args = { chatId, requestId: 'reset', agent: 'claude', model: 'sonnet' };
	await s.run('chat_reset_context', args);
	s.restart();
	child = s.chats.find(chat => chat.id === chatId)!;
	assert.equal(child.managed!.generation, 1);
	assert.equal(child.agent, 'claude'); assert.equal(child.ref, undefined);
	assert.equal(child.entries.length, 0); assert.equal(child.title, 'Deep reviewer');
	assert.equal(child.folder, '/workspace'); assert.equal(child.linkedNoteReceipts!.note, 'receipt');
	assert.equal((await s.run('chat_reset_context', args)).duplicate, true);
	assert.equal(s.chats.find(chat => chat.id === chatId)!.managed!.generation, 1);
	assert.equal(s.writes.filter(reset => reset).length, 1);
});

test('tasks dispatch once, reject busy mutation, can be cancelled and retain status after context reset', async () => {
	const s = fixture();
	const { chatId } = await s.create();
	const args = { chatId, requestId: 'task', text: 'Review the parser' };
	const task = await s.run('chat_send_task', args);
	assert.equal(s.sent.length, 1); assert.equal(s.sent[0].prompt, args.text);
	assert.equal((await s.run('chat_send_task', args)).duplicate, true);
	assert.equal(s.sent.length, 1);
	for (const name of ['chat_reset_context', 'chat_configure', 'chat_send_task']) { await assert.rejects(s.run(name, { ...args, requestId: name }), /busy/); }
	assert.equal((await s.run('chat_get_task', { chatId })).task.state, 'starting');
	await s.run('chat_stop_task', { chatId, requestId: 'stop' });
	assert.equal(s.active.size, 0);
	assert.equal((await s.run('chat_get_task', { chatId })).task.state, 'cancelled');
	await s.run('chat_reset_context', { chatId, requestId: 'reset' });
	assert.equal((await s.run('chat_get_task', { chatId, taskId: task.taskId })).task.state, 'cancelled');
	assert.equal((await s.run('chat_get_task', { chatId })).task, null);
	await assert.rejects(s.run('chat_send_task', { ...args, text: 'different' }), /different arguments/);
});

test('runtime restarts report interruption and never replay an acknowledged task', async () => {
	const s = fixture();
	const { chatId } = await s.create();
	const args = { chatId, requestId: 'task', text: 'Inspect only' };
	await s.run('chat_send_task', args);
	s.restart();
	assert.equal((await s.run('chat_get_task', { chatId })).task.state, 'interrupted');
	assert.equal((await s.run('chat_send_task', args)).duplicate, true);
	assert.equal(s.sent.length, 1);
	s.revoke();
	await assert.rejects(s.run('chat_get_task', { chatId }), /access denied/);
	await assert.rejects(s.run('chat_stop_task', { chatId, requestId: 'stop' }), /access denied/);
});

test('quota and hierarchy limits bound worker fanout', async () => {
	const s = fixture();
	for (let i = 0; i < 8; i++) { await s.create({ requestId: String(i) }); }
	await assert.rejects(s.create({ requestId: 'overflow' }), /At most 8/);
	const a = s.chats[2];
	const b = await s.run('chat_create', { requestId: 'child', title: 'Child', agent: 'codex', model: 'small' }, a.id);
	const c = await s.run('chat_create', { requestId: 'grandchild', title: 'Grandchild', agent: 'codex', model: 'small' }, b.chatId);
	await assert.rejects(s.run('chat_create', { requestId: 'too-deep', title: 'Too deep', agent: 'codex', model: 'small' }, c.chatId), /three levels/);
});

test('task context is retained by default and with resetContext false', async () => {
	for (const flag of [undefined, false]) {
		const s = fixture();
		const { chatId } = await s.create();
		const child = s.chats.find(chat => chat.id === chatId)!;
		child.entries.push({ kind: 'assistant', text: 'Existing context' }); child.ref = 'provider-session';
		const result = await s.run('chat_send_task', { chatId, requestId: 'task', text: 'Continue', ...(flag === undefined ? {} : { resetContext: flag }) });
		const after = s.chats.find(chat => chat.id === chatId)!;
		assert.equal(after.entries.length, 1); assert.equal(after.ref, 'provider-session');
		assert.equal(after.managed!.generation, 0); assert.equal(result.contextCleared, false);
		assert.equal(s.writes.at(-1), false);
	}
});

test('optional reset reuses a worker, saves one new generation and never resets twice on retry', async () => {
	const s = fixture();
	const { chatId } = await s.create({ purpose: 'Reusable specialist' });
	const child = s.chats.find(chat => chat.id === chatId)!;
	child.entries.push({ kind: 'assistant', text: 'Old task answer' }); child.ref = 'old-provider-session';
	child.stats.turns = 7;
	const request = { chatId, requestId: 'independent', text: 'Unrelated new task', resetContext: true };
	const result = await s.run('chat_send_task', request);
	let after = s.chats.find(chat => chat.id === chatId)!;
	assert.equal(s.chats.length, 3); assert.equal(after.id, child.id);
	assert.equal(after.ref, undefined); assert.equal(after.entries.length, 0); assert.equal(after.stats.turns, 0);
	assert.equal(after.managed!.generation, 1); assert.equal(result.generation, 1); assert.equal(result.contextCleared, true);
	assert.equal(after.managed!.purpose, 'Reusable specialist'); assert.equal(after.managed!.selection.model, 'small');
	assert.equal(after.folder, '/workspace'); assert.equal(after.title, child.title); assert.equal(s.links.length, 1);
	assert.equal(after.managed!.tasks[result.taskId].generation, 1); assert.equal(s.writes.at(-1), true);
	after.entries.push({ kind: 'assistant', text: 'New result' });
	s.restart();
	assert.equal((await s.run('chat_send_task', request)).duplicate, true);
	after = s.chats.find(chat => chat.id === chatId)!;
	assert.equal(after.entries.length, 1); assert.equal(after.managed!.generation, 1);
	assert.equal(s.sent.length, 1); assert.equal(s.writes.length, 1);
	await assert.rejects(s.run('chat_send_task', { ...request, resetContext: false }), /different arguments/);
});

test('invalid, busy, paused and unauthorized reset-and-send requests cannot clear context', async () => {
	const s = fixture();
	const { chatId } = await s.create();
	const child = s.chats.find(chat => chat.id === chatId)!;
	child.entries.push({ kind: 'assistant', text: 'Keep this context' }); child.ref = 'keep-session';
	const request = { chatId, requestId: 'new-task', text: 'Task', resetContext: true };
	for (const resetContext of ['true', 1, null]) { await assert.rejects(s.run('chat_send_task', { ...request, resetContext }), /boolean/); }
	await assert.rejects(s.run('chat_send_task', { ...request, text: '' }), /nonempty/);
	s.busy.add(chatId);
	await assert.rejects(s.run('chat_send_task', request), /busy/);
	s.busy.clear(); s.paused.add(chatId);
	await assert.rejects(s.run('chat_send_task', request), /paused/);
	s.paused.clear(); s.revoke();
	await assert.rejects(s.run('chat_send_task', request), /access denied/);
	assert.equal(child.entries.length, 1); assert.equal(child.ref, 'keep-session'); assert.equal(child.managed!.generation, 0);
	assert.equal(s.sent.length, 0); assert.equal(s.writes.length, 0);
});
