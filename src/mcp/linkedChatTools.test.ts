import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import * as protocol from './mcpProtocol.ts';
import { LinkedChats, type LinkedChat } from '../chat/linkedChats.ts';
import { OwnedChats } from '../chat/ownedChats.ts';
import type { StoredChat } from '../chat/chatTab.ts';
import type { ChatLink } from '../chat/linkedChats.ts';
import * as chatFeatures from '../chat/core/chatFeatures.ts';

function load(features: { readonly chatConnectionsEnabled: boolean }): Record<string, any> {
	const exports: Record<string, any> = {};
	runInNewContext(transpileModule(readFileSync('src/mcp/chatTools.ts', 'utf8'), {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText, { exports, require: (name: string) => {
		if (name === './mcpProtocol') { return protocol; }
		if (name === '../chat/core/chatFeatures') { return features; }
		throw new Error(`Unexpected dependency: ${name}`);
	} });
	return exports;
}
const exports = load({ chatConnectionsEnabled: true });

test('chat-to-chat MCP tools are unavailable while the feature is disabled', async () => {
	const disabled = load(chatFeatures);
	const tools = disabled.chatTools(new disabled.ChatControlPort()) as protocol.Tool[];
	const names = tools.map(tool => tool.name);
	for (const name of ['chat_list', 'chat_get_metadata', 'chat_read_messages', 'chat_search', 'chat_add_note',
		'chat_list_models', 'chat_create', 'chat_configure', 'chat_reset_context', 'chat_send_task', 'chat_get_task', 'chat_stop_task']) {
		assert.equal(names.includes(name), false, name);
		const response = await protocol.dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } },
			{ tools, serverVersion: 'test', workspaceName: undefined }, { kind: 'codex', chatId: 'a' });
		assert.match(JSON.stringify(response), /Unknown tool/);
	}
	assert.ok(names.includes('chat_present_html'));
	assert.ok(names.includes('chat_state'));
});

test('MCP linked tools bind to the authenticated caller and refuse general tokens and closed callers', async () => {
	const port = new exports.ChatControlPort();
	const chats: LinkedChat[] = ['a', 'b', 'c'].map(id => ({ id, title: id, agent: 'codex', entries: [{ kind: 'assistant', text: `answer ${id}` }], createdAt: 1, updatedAt: 2 }));
	const api = new LinkedChats({ chats: () => chats, links: () => [{ ownerChatId: 'a', targetChatId: 'b', access: 'read' }], addNote: async () => { throw new Error('Read-only fixture'); } });
	port.target = { tabOf: (id: string) => id === 'a' ? 'tab-a' : undefined, linkedChats: (caller: string, tool: string, args: Record<string, unknown>) => api.run(tool, caller, args) };
	const tools = exports.chatTools(port) as protocol.Tool[];
	const call = async (name: string, args: Record<string, unknown>, chatId?: string) => {
		return protocol.dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
			{ tools, serverVersion: 'test', workspaceName: undefined }, { kind: 'codex', ...(chatId ? { chatId } : {}) });
	};
	const own = JSON.stringify(await call('chat_list', {}, 'a'));
	assert.match(own, /answer|chatId/);
	assert.doesNotMatch(own, /answer c/);
	for (const name of ['chat_list', 'chat_get_metadata', 'chat_read_messages', 'chat_search', 'chat_add_note']) {
		const tool = tools.find(tool => tool.name === name)!;
		assert.equal(tool.visibleTo!({ kind: 'codex' }), false);
		assert.equal(tool.visibleTo!({ kind: 'codex', chatId: 'a' }), true);
		for (const caller of [undefined, 'closed']) {
			await assert.rejects(tool.run({}, { kind: 'codex', chatId: caller }), /Only the agents|no longer open/);
		}
	}
	const denied = JSON.stringify(await call('chat_read_messages', { chatId: 'c' }, 'a'));
	assert.match(denied, /access denied/);
	assert.doesNotMatch(denied, /answer c/);
	const read = JSON.stringify(await call('chat_read_messages', { chatId: 'b' }, 'a'));
	assert.match(read, /answer b/);
});

test('owned MCP commands bind creation and management to the authenticated caller', async () => {
	const port = new exports.ChatControlPort();
	const chats: StoredChat[] = ['parent', 'other'].map(id => ({ id, title: id, agent: 'codex', createdAt: 1, updatedAt: 1, entries: [],
		stats: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, turns: 0 } }));
	const links: ChatLink[] = [];
	let dispatched = 0;
	const api = new OwnedChats({ chats: () => chats, links: () => links, agents: () => [{ id: 'codex', name: 'Codex', available: true,
		models: [{ id: 'selected-model', label: 'Selected', efforts: [], isDefault: true }] }], busy: () => false, activeTask: () => false,
		create: async (source, chat) => { chats.push(chat); links.push({ ownerChatId: source.id, targetChatId: chat.id, access: 'readWrite' }); },
		write: async chat => { chats[chats.findIndex(item => item.id === chat.id)] = chat; },
		launch: () => { dispatched++; }, stop() {},
	});
	port.target = { tabOf: (id: string) => ['parent', 'other'].includes(id) ? `tab-${id}` : undefined,
		linkedChats: (caller: string, tool: string, args: Record<string, unknown>) => api.run(tool, caller, args) };
	const tools = exports.chatTools(port) as protocol.Tool[];
	for (const name of ['chat_list_models', 'chat_create', 'chat_configure', 'chat_reset_context', 'chat_send_task', 'chat_get_task', 'chat_stop_task']) {
		const tool = tools.find(tool => tool.name === name)!;
		assert.equal(tool.visibleTo!({ kind: 'codex' }), false);
		await assert.rejects(tool.run({}, { kind: 'codex' }), /Only the agents/);
		await assert.rejects(tool.run({}, { kind: 'codex', chatId: 'closed' }), /no longer open/);
	}
	const call = async (name: string, args: Record<string, unknown>, chatId = 'parent') => JSON.parse(await tools.find(tool => tool.name === name)!.run(args, { kind: 'codex', chatId }) as string);
	assert.equal((await call('chat_list_models', {})).items[0].model, 'selected-model');
	const created = await call('chat_create', { requestId: 'create', title: 'Worker', agent: 'codex', model: 'selected-model', ownerChatId: 'other' });
	assert.equal(chats.find(chat => chat.id === created.chatId)!.managed!.ownerChatId, 'parent');
	assert.ok(created.fetchedAt);
	await assert.rejects(call('chat_reset_context', { chatId: created.chatId, requestId: 'reset' }, 'other'), /access denied/);
	const request = { chatId: created.chatId, requestId: 'task', text: 'Investigate' };
	await call('chat_send_task', request); await call('chat_send_task', request);
	assert.equal(dispatched, 1);
	const sendSchema = tools.find(tool => tool.name === 'chat_send_task')!.inputSchema.properties as Record<string, { type: string; default?: unknown }>;
	assert.equal(sendSchema.resetContext.type, 'boolean'); assert.equal(sendSchema.resetContext.default, false);
	const worker = chats.find(chat => chat.id === created.chatId)!;
	worker.entries.push({ kind: 'assistant', text: 'Prior context' }); worker.ref = 'prior-session';
	const resetTask = await call('chat_send_task', { ...request, requestId: 'new-independent-task', resetContext: true });
	assert.equal(resetTask.contextCleared, true); assert.equal(resetTask.generation, 1);
	assert.equal(chats.find(chat => chat.id === created.chatId)!.entries.length, 0);
	assert.equal(chats.find(chat => chat.id === created.chatId)!.ref, undefined);
	assert.equal(chats.length, 3); assert.equal(dispatched, 2);
});
