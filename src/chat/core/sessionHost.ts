import type { AgentId, ChatEntry, PendingSend, QuestionAnswers } from '../chatProtocol';

/** Conversation data only: no theme, selected UI tab, credentials or artifact bodies. */
export interface SessionState {
	readonly id: string;
	readonly title: string;
	readonly agent: AgentId;
	readonly directory: string;
	readonly running: boolean;
	readonly entries: readonly ChatEntry[];
	readonly pendingSends: readonly PendingSend[];
}

export type SessionMetadata = Omit<SessionState, 'entries' | 'pendingSends'>;
export type SessionAction =
	| { readonly type: 'session/created'; readonly state: SessionState }
	| { readonly type: 'session/changed'; readonly metadata: SessionMetadata;
		readonly entries?: { readonly from: number; readonly values: readonly ChatEntry[]; readonly length: number };
		readonly pendingSends?: readonly PendingSend[] }
	| { readonly type: 'session/removed' };

export interface SessionEnvelope {
	readonly channel: string;
	readonly serverSeq: number;
	readonly action: SessionAction;
}
export interface SessionSnapshot {
	readonly resource: string;
	readonly fromSeq: number;
	readonly state: SessionState;
}
export type SessionRecovery =
	| { readonly type: 'replay'; readonly actions: readonly SessionEnvelope[]; readonly missing: readonly string[]; readonly serverSeq: number }
	| { readonly type: 'snapshot'; readonly snapshots: readonly SessionSnapshot[]; readonly missing: readonly string[]; readonly serverSeq: number };

export type SessionCommand =
	| { readonly type: 'stop'; readonly chatId: string; readonly commandId: number }
	| { readonly type: 'approve'; readonly chatId: string; readonly commandId: number; readonly approvalId: string; readonly allow: boolean; readonly answers?: QuestionAnswers };

/** Local prototype channels deliberately do not pretend to be standard AHP ChatState. */
export function sessionChannel(id: string): string { return `x-ai-browser-session:/${encodeURIComponent(id)}`; }

function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

/** Isolate the mutable legacy runtime and every client from retained state and replay. */
function freeze<T>(value: T): T {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) { freeze(child); }
		Object.freeze(value);
	}
	return value;
}
function immutable<T>(value: T): T { return freeze(structuredClone(value)); }

/** Pure reducer shared by the host and prototype clients. A gap requires a snapshot. */
export function reduceSession(state: SessionState | undefined, action: SessionAction): SessionState | undefined {
	if (action.type === 'session/removed') { return undefined; }
	if (action.type === 'session/created') { return action.state; }
	if (!state || state.id !== action.metadata.id) { throw new Error('Missing session base.'); }
	const tail = action.entries;
	if (tail && (!Number.isSafeInteger(tail.from) || tail.from < 0 || tail.from > state.entries.length
		|| tail.from + tail.values.length !== tail.length)) { throw new Error('Invalid session entry tail.'); }
	return { ...action.metadata, entries: tail ? [...state.entries.slice(0, tail.from), ...tail.values] : state.entries,
		pendingSends: action.pendingSends ?? state.pendingSends };
}

export interface SessionHostOptions {
	readonly replayLimit?: number;
	readonly replayBytes?: number;
	/** Bootstrap current runtime state when the first observer attaches. */
	readonly onObserved?: () => void;
	/** Host-side adapter only. It must enforce runtime permissions and republish resulting state. */
	readonly execute?: (command: SessionCommand) => void | Promise<void>;
}

/**
 * In-process migration bridge toward a standalone host. Owns immutable published
 * conversation state, sequencing and replay; legacy ChatTab still owns execution.
 * No sockets, VS Code API, timers, file access or provider-specific protocols.
 */
export class SessionHost {
	private readonly _states = new Map<string, SessionState>();
	private readonly _listeners = new Set<(event: SessionEnvelope) => void>();
	private readonly _replay: { event: SessionEnvelope; bytes: number }[] = [];
	private readonly _clients = new Map<string, { last: number; commands: Map<number, { signature: string; result: Promise<void> }> }>();
	private readonly _claims = new Set<string>();
	private readonly _events: SessionEnvelope[] = [];
	private _emitting = false;
	private _bytes = 0;
	private _seq = 0;
	private _closed = false;
	private readonly _limit: number;
	private readonly _byteLimit: number;
	private readonly _options: SessionHostOptions;
	constructor(_options: SessionHostOptions = {}) {
		this._options = _options;
		this._limit = _options.replayLimit ?? 256;
		this._byteLimit = _options.replayBytes ?? 2 * 1024 * 1024;
		if (!Number.isSafeInteger(this._limit) || this._limit < 0 || !Number.isSafeInteger(this._byteLimit) || this._byteLimit < 0) {
			throw new Error('Replay limits must be non-negative integers.');
		}
	}
	get serverSeq(): number { return this._seq; }
	get canExecute(): boolean { return !!this._options.execute && !this._closed; }
	get size(): number { return this._states.size; }
	get observed(): boolean { return this._listeners.size > 0; }

	subscribe(listener: (event: SessionEnvelope) => void): { dispose(): void } {
		this._open();
		this._listeners.add(listener);
		try { if (this._listeners.size === 1) { this._options.onObserved?.(); } }
		catch (error) { this._listeners.delete(listener); throw error; }
		return { dispose: () => { this._listeners.delete(listener); } };
	}

	snapshot(channel: string): SessionSnapshot | undefined {
		const state = this._states.get(channel);
		return state ? { resource: channel, state, fromSeq: this._seq } : undefined;
	}
	list(): readonly SessionSnapshot[] { return [...this._states.keys()].map(channel => this.snapshot(channel)!); }

	publish(input: SessionState): void {
		this._open();
		const channel = sessionChannel(input.id);
		const before = this._states.get(channel);
		if (before && same(before, input)) { return; }
		const state = immutable(input);
		if (!before) { this._emit(channel, { type: 'session/created', state }); return; }
		const { entries, pendingSends, ...metadata } = state;
		let from = 0;
		while (from < before.entries.length && from < entries.length && same(before.entries[from], entries[from])) { from++; }
		const changed = from !== entries.length || from !== before.entries.length;
		this._emit(channel, { type: 'session/changed', metadata,
			...(changed ? { entries: { from, values: entries.slice(from), length: entries.length } } : {}),
			...(!same(before.pendingSends, pendingSends) ? { pendingSends } : {}) });
	}

	/** Retain by conversation identity, so moving a UI tab does not remove its session. */
	retain(chatIds: ReadonlySet<string>): void {
		this._open();
		for (const [channel, state] of this._states) {
			if (!chatIds.has(state.id)) { this._emit(channel, { type: 'session/removed' }); }
		}
	}

	recover(lastSeenServerSeq: number, channels: readonly string[]): SessionRecovery {
		this._open();
		if (!Number.isSafeInteger(lastSeenServerSeq) || lastSeenServerSeq < 0 || lastSeenServerSeq > this._seq) {
			throw new Error('Invalid recovery cursor.');
		}
		const wanted = new Set(channels);
		const missing = [...wanted].filter(channel => !this._states.has(channel));
		const floor = this._replay[0]?.event.serverSeq ?? this._seq + 1;
		if (lastSeenServerSeq >= floor - 1) {
			return { type: 'replay', serverSeq: this._seq, missing,
				actions: this._replay.filter(item => item.event.serverSeq > lastSeenServerSeq && wanted.has(item.event.channel)).map(item => item.event) };
		}
		return { type: 'snapshot', serverSeq: this._seq, missing,
			snapshots: [...wanted].flatMap(channel => { const snapshot = this.snapshot(channel); return snapshot ? [snapshot] : []; }) };
	}

	/** Call only after the transport has authenticated and authorized this particular command. */
	dispatch(clientId: string, input: SessionCommand): Promise<void> {
		this._open();
		if (!this._options.execute) { return Promise.reject(new Error('Session controls are not connected.')); }
		const command = immutable(input);
		if (!clientId || clientId.length > 256 || !Number.isSafeInteger(command.commandId) || command.commandId < 1) {
			return Promise.reject(new Error('Invalid command identity.'));
		}
		let client = this._clients.get(clientId);
		const signature = JSON.stringify(command);
		const previous = client?.commands.get(command.commandId);
		if (previous) { return previous.signature === signature ? previous.result : Promise.reject(new Error('Command id was reused.')); }
		if (client && command.commandId <= client.last) { return Promise.reject(new Error('Command result expired; reconcile state before sending a new command.')); }
		if (!client && this._clients.size >= 128) { return Promise.reject(new Error('Control client limit reached.')); }
		const state = this._states.get(sessionChannel(command.chatId));
		if (!state) { return Promise.reject(new Error('Unknown session.')); }
		const claim = command.type === 'approve' ? JSON.stringify([command.chatId, command.approvalId]) : undefined;
		if (command.type === 'approve' && (!state.entries.some(entry => entry.kind === 'approval' && entry.id === command.approvalId && entry.status === 'pending') || this._claims.has(claim!))) {
			return Promise.reject(new Error('Approval is no longer pending.'));
		}
		// Reserve synchronously, before an async backend can yield to another client.
		if (claim) { this._claims.add(claim); }
		if (!client) { client = { last: 0, commands: new Map() }; this._clients.set(clientId, client); }
		client.last = command.commandId;
		const result = Promise.resolve().then(() => {
			this._open();
			if (!this._states.has(sessionChannel(command.chatId))) { throw new Error('Session was closed.'); }
			return this._options.execute!(command);
		});
		client.commands.set(command.commandId, { signature, result });
		// Keep a high-water mark after dropping results: an old retry must never execute again.
		while (client.commands.size > 32) { client.commands.delete(client.commands.keys().next().value!); }
		return result;
	}

	dispose(): void {
		this._closed = true;
		this._states.clear(); this._listeners.clear(); this._replay.length = 0;
		this._clients.clear(); this._claims.clear(); this._events.length = 0; this._bytes = 0;
	}
	private _open(): void { if (this._closed) { throw new Error('Session host is closed.'); } }
	private _emit(channel: string, action: SessionAction): void {
		const event = immutable({ channel, serverSeq: ++this._seq, action });
		const next = reduceSession(this._states.get(channel), event.action);
		if (next) { this._states.set(channel, freeze(next)); } else { this._states.delete(channel); }
		for (const claim of this._claims) {
			const [chatId, approvalId] = JSON.parse(claim) as [string, string];
			if (sessionChannel(chatId) === channel && !next?.entries.some(entry => entry.kind === 'approval' && entry.id === approvalId && entry.status === 'pending')) { this._claims.delete(claim); }
		}
		const bytes = Buffer.byteLength(JSON.stringify(event));
		this._replay.push({ event, bytes }); this._bytes += bytes;
		while (this._replay.length > this._limit || this._bytes > this._byteLimit) { this._bytes -= this._replay.shift()!.bytes; }
		this._events.push(event);
		if (this._emitting) { return; }
		this._emitting = true;
		try {
			while (this._events.length) {
				const pending = this._events.shift()!;
				for (const listener of [...this._listeners]) {
					if (!this._listeners.has(listener)) { continue; }
					try { listener(pending); } catch { this._listeners.delete(listener); }
				}
			}
		} finally { this._emitting = false; }
	}
}
