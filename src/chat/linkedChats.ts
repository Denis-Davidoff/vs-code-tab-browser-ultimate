import { createHash } from 'node:crypto';
import type { ChatEntry } from './chatProtocol';
import type { OwnedChatState } from './ownedChats';

export type ChatLinkAccess = 'read' | 'readWrite';
export interface ChatLink { readonly ownerChatId: string; readonly targetChatId: string; readonly access: ChatLinkAccess }
export interface LinkedChat {
	managed?: OwnedChatState;
	runtimeTaskId?: string;
	id: string; title: string; agent: string; createdAt: number; updatedAt: number;
	entries: ChatEntry[]; historyCompleteness?: 'full' | 'partial' | 'unknown';
	model?: string; state?: string;
	linkedNoteReceipts?: Record<string, string>;
}
export interface LinkedChatHost {
	chats(): LinkedChat[];
	links(): readonly ChatLink[];
	addNote(targetId: string, note: Extract<ChatEntry, { kind: 'notice' }>): Promise<void>;
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
export const linkedNoteDigest = (value: string): string => hash(value);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** Legacy IDs are assigned before slicing history, and subsequently retained on disk. */
export function ensureChatEntryIds(chat: Pick<LinkedChat, 'id' | 'entries'>): void {
	const seen = new Set<string>();
	chat.entries.forEach((entry, index) => {
		if (!entry.id || seen.has(entry.id)) { Object.assign(entry, { id: `legacy-${hash([chat.id, index, entry])}` }); }
		seen.add(entry.id!);
	});
}

export function readChatLinks(value: unknown): ChatLink[] {
	if (!Array.isArray(value)) { return []; }
	return value.filter((link): link is ChatLink => !!link && typeof link.ownerChatId === 'string' && typeof link.targetChatId === 'string'
		&& link.ownerChatId !== link.targetChatId && (link.access === 'read' || link.access === 'readWrite'));
}

function integer(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
	const value = args[key] ?? fallback;
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) { throw new Error(`${key} must be an integer from ${min} to ${max}.`); }
	return value;
}
function strings(args: Record<string, unknown>, key: string): string[] | undefined {
	const value = args[key];
	if (value === undefined) { return; }
	if (!Array.isArray(value) || value.length > 100 || !value.every(item => typeof item === 'string' && item.length <= 200)) { throw new Error(`${key} must contain at most 100 strings of at most 200 characters.`); }
	return value;
}
function text(args: Record<string, unknown>, key: string, required = false): string | undefined {
	const value = args[key];
	if (value === undefined && !required) { return; }
	if (typeof value !== 'string' || !value.trim()) { throw new Error(`${key} must be a nonempty string.`); }
	return value;
}

function body(entry: ChatEntry, full: boolean): string {
	if (entry.kind === 'thinking' || entry.kind === 'approval') { return ''; }
	if (entry.kind === 'tool') { return [entry.name, entry.detail, entry.status, ...(full ? [entry.input, entry.output] : [])].filter(Boolean).join('\n'); }
	if ('text' in entry) { return entry.text; }
	if (entry.kind === 'result') { return [entry.title, ...(full ? entry.blocks.flatMap(block => block.type === 'text' ? [block.text] : block.type === 'json' ? [JSON.stringify(block.value)] : []) : [])].filter(Boolean).join('\n'); }
	if (entry.kind === 'plan') { return [entry.title, ...entry.steps.map(step => `${step.status}: ${step.text}`)].filter(Boolean).join('\n'); }
	if (entry.kind === 'progress') { return [entry.title, entry.stage, entry.status].filter(Boolean).join('\n'); }
	return '';
}
function role(entry: ChatEntry): string { return entry.kind === 'user' ? 'user' : entry.kind === 'notice' ? 'note' : entry.kind === 'tool' ? 'tool' : 'assistant'; }
function visible(entry: ChatEntry): boolean { return entry.kind !== 'thinking' && entry.kind !== 'approval'; }

/** One authorization and bounded query implementation for MCP and every UI surface. */
export class LinkedChats {
	private readonly host: LinkedChatHost;
	constructor(host: LinkedChatHost) { this.host = host; }
	private target(caller: string, id: string, write = false): LinkedChat {
		const link = this.host.links().find(item => item.ownerChatId === caller && item.targetChatId === id);
		if (id !== caller && (!link || (write && link.access !== 'readWrite'))) { throw new Error('Chat access denied or unavailable.'); }
		const chat = this.host.chats().find(item => item.id === id);
		if (!chat) { throw new Error('Chat access denied or unavailable.'); }
		ensureChatEntryIds(chat);
		return chat;
	}
	private metadata(caller: string, chat: LinkedChat) {
		const access = this.host.links().find(link => link.ownerChatId === caller && link.targetChatId === chat.id)?.access;
		const task = chat.managed?.currentTaskId ? chat.managed.tasks[chat.managed.currentTaskId] : undefined;
		const taskStatus = task && ['starting', 'running'].includes(task.state) && chat.runtimeTaskId !== task.id ? { ...task, state: 'interrupted' } : task;
		return { chatId: chat.id, title: chat.title, provider: chat.agent, model: chat.model ?? chat.managed?.selection.model ?? null,
			...(chat.managed ? { ownerChatId: chat.managed.ownerChatId, generation: chat.managed.generation,
				purpose: chat.managed.purpose ?? null, task: taskStatus ?? null } : {}),
			createdAt: chat.createdAt, updatedAt: chat.updatedAt, state: chat.state ?? 'saved',
			messageCount: chat.entries.filter(entry => entry.kind === 'user' || entry.kind === 'assistant').length,
			countScope: 'availableHistory', historyCompleteness: chat.historyCompleteness ?? 'unknown',
			actions: chat.managed?.ownerChatId === caller && access === 'readWrite' ? ['read', 'addNote', 'configure', 'resetContext', 'sendTask', 'stopTask']
				: caller === chat.id || access === 'readWrite' ? ['read', 'addNote'] : ['read'] };
	}
	async run(name: string, caller: string, args: Record<string, unknown>): Promise<unknown> {
		// Resolve the catalog and grants once, including for batched requests. The
		// host serializes note writes with grant changes before taking this snapshot.
		const chats = this.host.chats(), links = this.host.links();
		const snapshot = new LinkedChats({ chats: () => chats, links: () => links, addNote: (id, note) => this.host.addNote(id, note) });
		return snapshot.query(name, caller, args);
	}
	private async query(name: string, caller: string, args: Record<string, unknown>): Promise<unknown> {
		if (!this.host.chats().some(chat => chat.id === caller)) { throw new Error('The calling conversation is no longer available.'); }
		const maxBytes = integer(args, 'maxBytes', 24 * 1024, 2048, 128 * 1024);
		const limit = integer(args, 'limit', name === 'chat_search' ? 10 : 20, 1, 100);
		const maxChars = integer(args, 'maxMessageChars', 2000, 64, 20000);
		const fetchedAt = new Date().toISOString();
		if (name === 'chat_add_note') {
			const target = this.target(caller, text(args, 'chatId', true)!, true);
			const requestId = text(args, 'requestId', true)!;
			const noteText = text(args, 'text', true)!;
			if (requestId.length > 200 || noteText.length > 20000) { throw new Error('requestId is limited to 200 characters and text to 20000.'); }
			const id = `note-${hash([caller, target.id, requestId])}`;
			const source = this.target(caller, caller);
			const existing = target.entries.find(entry => 'id' in entry && entry.id === id);
			const receipt = target.linkedNoteReceipts?.[id];
			if (receipt && receipt !== hash(noteText)) { throw new Error('requestId was already used for a different note.'); }
			if (existing && (existing.kind !== 'notice' || existing.linkedNote?.text !== noteText)) { throw new Error('requestId was already used for a different note.'); }
			if (!existing && !receipt) {
				await this.host.addNote(target.id, { kind: 'notice', id, at: Date.now(), level: 'info',
					text: `Note from ${source.title} (${source.agent}; ${caller})\n\n${noteText}`,
					linkedNote: { sourceChatId: caller, author: source.agent, text: noteText } });
			}
			return { chatId: target.id, messageId: id, duplicate: !!existing || !!receipt, fetchedAt };
		}
		let items: Record<string, unknown>[] = [];
		let revisions: unknown;
		let completeness: unknown;
		if (name === 'chat_list' || name === 'chat_get_metadata') {
			const ids = strings(args, 'chatIds');
			if (name === 'chat_get_metadata' && !ids?.length) { throw new Error('chatIds is required.'); }
			const allowed = new Set([caller, ...this.host.links().filter(link => link.ownerChatId === caller).map(link => link.targetChatId)]);
			const chats = ids ? ids.map(id => this.target(caller, id)) : this.host.chats().filter(chat => allowed.has(chat.id));
			const fields = strings(args, 'fields');
			const changedSince = args.changedSince;
			if (changedSince !== undefined && (typeof changedSince !== 'number' || !Number.isFinite(changedSince))) { throw new Error('changedSince must be a timestamp in milliseconds.'); }
			items = chats.filter(chat => changedSince === undefined || chat.updatedAt > (changedSince as number)).map(chat => {
				const data = this.metadata(caller, chat);
				return fields ? Object.fromEntries(Object.entries(data).filter(([key]) => key === 'chatId' || fields.includes(key))) : data;
			});
			revisions = items;
		} else if (name === 'chat_read_messages' || name === 'chat_search') {
			const ids = name === 'chat_read_messages' ? [text(args, 'chatId', true)!] : strings(args, 'chatIds')
				?? [caller, ...this.host.links().filter(link => link.ownerChatId === caller).map(link => link.targetChatId)].filter(id => this.host.chats().some(chat => chat.id === id));
			const chats = [...new Set(ids)].map(id => this.target(caller, id));
			const detail = text(args, 'detail') ?? 'text';
			if (!['index', 'text', 'full'].includes(detail)) { throw new Error('detail must be index, text or full.'); }
			const roles = strings(args, 'roles'), kinds = strings(args, 'kinds'), messageIds = strings(args, 'messageIds');
			const around = text(args, 'aroundMessageId');
			if (around && messageIds) { throw new Error('Choose aroundMessageId or messageIds.'); }
			const radius = integer(args, 'contextMessages', 2, 0, 10);
			const offset = integer(args, 'textOffset', 0, 0, 100000000);
			if (offset && (messageIds?.length !== 1 || name !== 'chat_read_messages')) { throw new Error('textOffset requires exactly one messageId.'); }
			const query = name === 'chat_search' ? text(args, 'query', true)!.toLocaleLowerCase() : undefined;
			if (query && query.length > 1000) { throw new Error('query is limited to 1000 characters.'); }
			for (const key of ['from', 'to']) { if (args[key] !== undefined && (typeof args[key] !== 'number' || !Number.isSafeInteger(args[key]) || (args[key] as number) < 0)) { throw new Error(`${key} must be a nonnegative available-history index.`); } }
			// Hidden thoughts, attachments and binary payloads do not invalidate a
			// text selection or get serialized just to calculate its revision.
			revisions = chats.map(chat => [chat.id, chat.historyCompleteness, chat.entries.filter(visible).map(entry => [entry.id, entry.kind,
				body(entry, detail === 'full'), 'at' in entry ? entry.at : null,
				entry.kind === 'notice' ? entry.linkedNote?.sourceChatId : null])]);
			completeness = Object.fromEntries(chats.map(chat => [chat.id, chat.historyCompleteness ?? 'unknown']));
			for (const chat of chats) {
				const entries = chat.entries.filter(visible);
				if (messageIds?.some(id => !entries.some(entry => entry.id === id))) { throw new Error('A requested message is not available in this history.'); }
				const center = around ? entries.findIndex(entry => 'id' in entry && entry.id === around) : -1;
				if (around && center < 0) { throw new Error('The requested message is not available.'); }
				entries.forEach((entry, index) => {
					if (around && Math.abs(index - center) > radius || roles && !roles.includes(role(entry)) || kinds && !kinds.includes(entry.kind)
						|| messageIds && !messageIds.includes(entry.id!) || typeof args.from === 'number' && index < args.from || typeof args.to === 'number' && index > args.to) { return; }
					const content = body(entry, detail === 'full');
					const match = query ? content.toLocaleLowerCase().indexOf(query) : -1;
					if (query && match < 0) { return; }
					const start = query ? Math.max(0, match - 100) : offset;
					const take = detail === 'index' ? Math.min(160, maxChars) : maxChars;
					items.push({ chatId: chat.id, messageId: entry.id, index, role: role(entry), kind: entry.kind,
						at: 'at' in entry ? entry.at ?? null : null, text: content.slice(start, start + take), textLength: content.length,
						textOffset: start, textNextOffset: start + take < content.length ? start + take : null,
						...(entry.kind === 'notice' && entry.linkedNote ? { source: { chatId: entry.linkedNote.sourceChatId, author: entry.linkedNote.author } } : {}) });
				});
			}
			if (args.order !== undefined && args.order !== 'oldest' && args.order !== 'newest') { throw new Error('order must be oldest or newest.'); }
			if ((args.order ?? 'newest') === 'newest') { items.reverse(); }
		} else { throw new Error('Unknown linked chat tool.'); }
		const revision = hash([revisions, this.host.links().filter(link => link.ownerChatId === caller)]);
		if (args.ifRevision === revision) { return { notModified: true, revision, fetchedAt }; }
		const queryArgs: Record<string, unknown> = { ...args, cursor: undefined, ifRevision: undefined };
		const signature = hash([name, caller, Object.fromEntries(Object.keys(queryArgs).sort().map(key => [key, queryArgs[key]]))]);
		let start = 0;
		if (args.cursor !== undefined) {
			try {
				const cursor = JSON.parse(Buffer.from(text(args, 'cursor', true)!, 'base64url').toString());
				if (cursor.revision !== revision) { throw new Error('revision'); }
				if (cursor.signature !== signature || !Number.isSafeInteger(cursor.start) || cursor.start < 0 || cursor.start > items.length) { throw new Error('invalid'); }
				start = cursor.start;
			} catch { throw new Error('Cursor expired or does not match this query. Restart the selection.'); }
		}
		const envelope = { revision, fetchedAt, ...(completeness ? { historyCompleteness: completeness, omittedKinds: ['thinking', 'approval'] } : {}) };
		const selected: Record<string, unknown>[] = [];
		let next = start;
		// Reserve room for the cursor and envelope, and enforce the actual UTF-8 JSON size.
		while (next < items.length && selected.length < limit) {
			const item = { ...items[next] };
			if (selected.length && bytes({ ...envelope, items: [...selected, item] }) > maxBytes - 700) { break; }
			if (typeof item.text === 'string') {
				let content = item.text;
				while (content.length && bytes({ ...envelope, items: [...selected, item] }) > maxBytes - 700) {
					content = content.slice(0, Math.floor(content.length / 2));
					// Avoid splitting a UTF-16 surrogate pair at a continuation boundary.
					if (/[\uD800-\uDBFF]$/.test(content)) { content = content.slice(0, -1); }
					item.text = content;
					item.textNextOffset = (item.textOffset as number) + content.length;
				}
			}
			if (bytes({ ...envelope, items: [...selected, item] }) > maxBytes - 700) { break; }
			selected.push(item); next++;
		}
		if (!selected.length && next < items.length) { throw new Error('maxBytes is too small for this result; request fewer fields or a larger budget.'); }
		const nextCursor = next < items.length ? Buffer.from(JSON.stringify({ revision, signature, start: next })).toString('base64url') : null;
		const result = { ...envelope, items: selected, nextCursor, truncated: !!nextCursor || selected.some(item => item.textNextOffset !== undefined && item.textNextOffset !== null) };
		if (bytes(result) > maxBytes) { throw new Error('maxBytes is too small for the response metadata; narrow chatIds or increase the budget.'); }
		return result;
	}
}
