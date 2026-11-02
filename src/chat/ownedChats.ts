import { createHash } from 'node:crypto';
import type { AgentId, ChatAgent } from './chatProtocol';
import type { StoredChat } from './chatTab';
import type { ChatLink } from './linkedChats';

export interface OwnedSelection { agent: AgentId; model: string; effort?: string }
export interface OwnedTask {
	id: string; generation: number; state: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
	createdAt: number; endedAt?: number; error?: string; messageId?: string;
}
export interface OwnedChatState {
	ownerChatId: string; createFingerprint: string; selection: OwnedSelection; purpose?: string; generation: number;
	receipts: Record<string, { fingerprint: string; result: Record<string, unknown> }>;
	tasks: Record<string, OwnedTask>; currentTaskId?: string;
}
export interface OwnedChatsHost {
	chats(): StoredChat[];
	agents(): readonly ChatAgent[];
	links(): readonly ChatLink[];
	busy(chatId: string): boolean;
	paused?(chatId: string): boolean;
	activeTask(chatId: string, taskId: string): boolean;
	runtimeState?(chatId: string): string | undefined;
	create(source: StoredChat, chat: StoredChat): Promise<void>;
	write(chat: StoredChat, reset: boolean): Promise<void>;
	launch(sourceId: string, chatId: string, taskId: string, prompt: string): void;
	stop(chatId: string): void;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, item) =>
	item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex').slice(0, 32);
function text(args: Record<string, unknown>, key: string, max: number, required = false): string | undefined {
	const value = args[key];
	if (value === undefined && !required) { return; }
	if (typeof value !== 'string' || !value.trim() || value.length > max) { throw new Error(`${key} must be nonempty text of at most ${max} characters.`); }
	return value;
}
export function ownedSelection(agents: readonly ChatAgent[], args: Record<string, unknown>, previous?: OwnedSelection): OwnedSelection {
	const id = text(args, 'agent', 100) ?? previous?.agent;
	const agent = agents.find(agent => agent.id === id && agent.available);
	if (!agent) { throw new Error('Agent is unavailable. Use chat_list_models to choose an available agent and model.'); }
	const modelId = text(args, 'model', 200) ?? (previous?.agent === agent.id ? previous.model : undefined);
	const model = agent.models.find(model => model.id === modelId);
	if (!model) { throw new Error('Model is unavailable for this agent. Use chat_list_models; no fallback model is selected.'); }
	const effort = text(args, 'effort', 100) ?? (previous?.model === model.id && previous.agent === agent.id ? previous.effort : undefined)
		?? model.defaultEffort ?? model.efforts[0];
	if (effort && !model.efforts.includes(effort)) { throw new Error('This model does not support the requested effort.'); }
	return { agent: agent.id, model: model.id, ...(effort ? { effort } : {}) };
}

/** Reuse the worker identity and configuration while dropping provider context. */
function resetOwnedContext(chat: StoredChat, managed: OwnedChatState): StoredChat {
	managed.generation++;
	delete managed.currentTaskId;
	return { id: chat.id, title: chat.title, agent: managed.selection.agent, named: true, owned: true, folder: chat.folder, copy: chat.copy,
		linkedNoteReceipts: chat.linkedNoteReceipts, references: chat.references, createdAt: chat.createdAt, updatedAt: Date.now(),
		managed, entries: [], historyCompleteness: 'full', stats: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, turns: 0 } };
}

/** Directed ownership adds management rights only to explicitly created children. */
export class OwnedChats {
	private readonly host: OwnedChatsHost;
	constructor(host: OwnedChatsHost) { this.host = host; }
	private target(caller: string, id: string): StoredChat {
		const chat = this.host.chats().find(chat => chat.id === id);
		if (chat?.managed?.ownerChatId !== caller || !this.host.links().some(link => link.ownerChatId === caller && link.targetChatId === id && link.access === 'readWrite')) {
			throw new Error('Management access denied: only your own created chats with an active read-and-add connection can be managed.');
		}
		return chat;
	}
	async run(name: string, caller: string, args: Record<string, unknown>): Promise<unknown> {
		const source = this.host.chats().find(chat => chat.id === caller);
		if (!source) { throw new Error('The calling conversation is unavailable.'); }
		if (name === 'chat_list_models') {
			const agentId = text(args, 'agent', 100);
			const offset = args.offset ?? 0, limit = args.limit ?? 30;
			if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) { throw new Error('offset must be nonnegative; limit must be 1–100.'); }
			const rows = this.host.agents().filter(agent => agent.available && (!agentId || agent.id === agentId)).flatMap(agent => agent.models.map(model =>
				({ agent: agent.id, model: model.id, label: model.label, efforts: model.efforts, defaultEffort: model.defaultEffort ?? null, isDefault: model.isDefault })));
			const items = [];
			for (const row of rows.slice(offset as number, (offset as number) + (limit as number))) {
				if (Buffer.byteLength(JSON.stringify([...items, row])) > 23000) { break; }
				items.push(row);
			}
			if (!items.length && (offset as number) < rows.length) { throw new Error('Model metadata exceeds the response budget.'); }
			return { items, nextOffset: (offset as number) + items.length < rows.length ? (offset as number) + items.length : null, revision: hash(rows) };
		}
		if (name === 'chat_get_task') {
			const chat = this.target(caller, text(args, 'chatId', 200, true)!);
			const taskId = text(args, 'taskId', 200) ?? chat.managed!.currentTaskId;
			const task = taskId ? chat.managed!.tasks[taskId] : undefined;
			if (!task) { return { chatId: chat.id, task: null, generation: chat.managed!.generation }; }
			if (['starting', 'running'].includes(task.state) && !this.host.activeTask(chat.id, task.id)) {
				const copy = structuredClone(chat);
				Object.assign(copy.managed!.tasks[task.id], { state: 'interrupted', endedAt: Date.now(), error: 'The previous runtime ended; this task is not automatically replayed.' });
				await this.host.write(copy, false);
				return { chatId: chat.id, task: copy.managed!.tasks[task.id] };
			}
			return { chatId: chat.id, task: { ...task, ...(this.host.busy(chat.id) ? { busy: true } : {}) }, chatState: this.host.runtimeState?.(chat.id) ?? 'saved' };
		}
		const requestId = text(args, 'requestId', 200, true)!;
		if (name === 'chat_send_task' && args.resetContext !== undefined && typeof args.resetContext !== 'boolean') {
			throw new Error('resetContext must be a boolean; it defaults to false.');
		}
		const fingerprint = hash([name, { ...args, requestId: undefined }]);
		if (name === 'chat_create') {
			const digest = hash([caller, requestId]);
			const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20)}`;
			const existing = this.host.chats().find(chat => chat.id === id);
			if (existing) {
				this.target(caller, id);
				if (existing.managed?.createFingerprint !== fingerprint) { throw new Error('requestId was already used for a different chat.'); }
				return { chatId: id, generation: existing.managed.generation, duplicate: true };
			}
			if (this.host.links().some(link => link.ownerChatId === caller && link.targetChatId === id)) { throw new Error('The previously created worker is no longer available. Use a new requestId for a new worker.'); }
			if (this.host.chats().filter(chat => chat.managed?.ownerChatId === caller).length >= 8) { throw new Error('At most 8 owned chats per conversation. Reuse or reset an existing chat.'); }
			let ancestor: StoredChat | undefined = source;
			for (let depth = 0; ancestor?.managed; depth++) {
				if (depth >= 2) { throw new Error('Owned chats support at most three levels below a user chat.'); }
				const owner: string = ancestor.managed.ownerChatId;
				ancestor = this.host.chats().find(chat => chat.id === owner);
			}
			const selection = ownedSelection(this.host.agents(), args);
			const title = text(args, 'title', 80, true)!;
			const purpose = text(args, 'purpose', 4000);
			const now = Date.now();
			const chat: StoredChat = { id, title, agent: selection.agent, owned: true, named: true, createdAt: now, updatedAt: now, entries: [],
				folder: source.folder, copy: source.copy, references: source.references, historyCompleteness: 'full',
				stats: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, turns: 0 },
				managed: { ownerChatId: caller, createFingerprint: fingerprint, selection, purpose, generation: 0, receipts: {}, tasks: {} } };
			await this.host.create(source, chat);
			return { chatId: id, generation: 0, selection, actions: ['read', 'addNote', 'configure', 'resetContext', 'sendTask', 'stopTask'] };
		}
		const chat = this.target(caller, text(args, 'chatId', 200, true)!);
		const key = hash([name, requestId]);
		const receipt = chat.managed!.receipts[key];
		if (receipt) {
			if (receipt.fingerprint !== fingerprint) { throw new Error('requestId was already used with different arguments.'); }
			return { ...receipt.result, duplicate: true };
		}
		if (Object.keys(chat.managed!.receipts).length >= 512) { throw new Error('This chat has reached its limit of 512 management operations. Create another worker.'); }
		if (name === 'chat_send_task' && this.host.paused?.(chat.id)) { throw new Error('The owned chat is paused. Resume it before sending a task.'); }
		if (name !== 'chat_stop_task' && (this.host.busy(chat.id) || chat.managed!.currentTaskId && this.host.activeTask(chat.id, chat.managed!.currentTaskId))) {
			throw new Error('The owned chat is busy. Wait for its task or stop it before changing context or sending another task.');
		}
		let next = structuredClone(chat);
		const managed = next.managed!;
		let result: Record<string, unknown> = { chatId: chat.id, generation: managed.generation };
		let prompt: string | undefined;
		let resetContext = name === 'chat_reset_context';
		if (name === 'chat_configure') {
			if (args.agent !== undefined && args.agent !== managed.selection.agent) { throw new Error('Changing agents requires chat_reset_context.'); }
			managed.selection = ownedSelection(this.host.agents(), args, managed.selection);
			if (args.title !== undefined) { next.title = text(args, 'title', 80, true)!; }
			if (args.purpose !== undefined) { managed.purpose = text(args, 'purpose', 4000, true)!; }
			result = { ...result, selection: managed.selection, title: next.title, purpose: managed.purpose ?? null };
		} else if (name === 'chat_reset_context') {
			managed.selection = ownedSelection(this.host.agents(), args, managed.selection);
			next = resetOwnedContext(chat, managed);
			result = { chatId: next.id, generation: managed.generation, selection: managed.selection, contextCleared: true };
		} else if (name === 'chat_send_task') {
			ownedSelection(this.host.agents(), {}, managed.selection);
			prompt = text(args, 'text', 50000, true)!;
			resetContext = args.resetContext === true;
			if (resetContext) { next = resetOwnedContext(chat, managed); }
			const task: OwnedTask = { id: `task-${hash([caller, chat.id, requestId])}`, generation: managed.generation, state: 'starting', createdAt: Date.now() };
			managed.tasks[task.id] = task; managed.currentTaskId = task.id;
			result = { chatId: chat.id, generation: managed.generation, taskId: task.id, state: task.state, contextCleared: resetContext };
		} else if (name === 'chat_stop_task') {
			const task = managed.currentTaskId ? managed.tasks[managed.currentTaskId] : undefined;
			if (task && ['starting', 'running'].includes(task.state)) { Object.assign(task, { state: 'cancelled', endedAt: Date.now() }); }
			result = { ...result, taskId: task?.id ?? null, state: task?.state ?? 'idle' };
		} else { throw new Error('Unknown owned chat tool.'); }
		managed.receipts[key] = { fingerprint, result };
		next.updatedAt = Date.now();
		await this.host.write(next, resetContext);
		if (name === 'chat_stop_task') { this.host.stop(chat.id); }
		if (prompt !== undefined) { this.host.launch(caller, chat.id, managed.currentTaskId!, prompt); }
		return result;
	}
}
