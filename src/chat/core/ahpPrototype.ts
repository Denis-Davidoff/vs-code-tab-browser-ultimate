import { sessionChannel, type SessionHost, type SessionCommand, type SessionSnapshot, type SessionAction } from './sessionHost';

const root = 'ahp-root://';
export const ahpPrototypeVersion = '1.0.0';
const profile = 'ai-browser.session.v1';
type RecordValue = Record<string, unknown>;
type RpcId = string | number;
export interface PrototypeReply { readonly jsonrpc: '2.0'; readonly id: RpcId | null; readonly result?: unknown; readonly error?: { code: number; message: string; data?: unknown } }
export interface PrototypeNotification {
	readonly jsonrpc: '2.0';
	readonly method: 'action';
	readonly params: { readonly channel: string; readonly serverSeq: number; readonly action: { readonly type: 'x-ai-browser/sessionChanged'; readonly change: SessionAction } };
}
export type PrototypeMessage = PrototypeReply | PrototypeNotification;
export interface AhpPrototypeOptions {
	/** Stable authenticated peer key for command deduplication, scoped by the embedding. */
	readonly clientKey: string;
	/** The embedding transport must authenticate first; do not trust initialize.clientId as identity. */
	readonly canRead: (channel: string) => boolean;
	readonly canControl: (command: SessionCommand) => boolean;
	/** Synchronously consume or enqueue each response/notification on one ordered transport. */
	readonly send: (message: PrototypeMessage) => void;
}

function record(value: unknown): value is RecordValue { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, max = 256): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function channels(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 64 && value.every(item => text(item, 1024)); }
function fault(code: number, message: string, data?: unknown): Error & { code: number; data?: unknown } { return Object.assign(new Error(message), { code, data }); }

/**
 * Transport-free AHP framing experiment, using explicit x- channels/actions.
 * This is NOT a standard chat/session provider or a VS Code-compatible host.
 * No listener or port is opened. Only a trusted, authenticated embedding may use it.
 */
export class AhpPrototypeConnection {
	private _clientId?: string;
	private _closed = false;
	private readonly _subscriptions = new Set<string>();
	private readonly _subscription: { dispose(): void };
	private readonly _outgoing: PrototypeMessage[] = [];
	private _sending = false;
	constructor(private readonly _host: SessionHost, private readonly _options: AhpPrototypeOptions) {
		this._subscription = _host.subscribe(event => {
			if (!this._clientId || !this._subscriptions.has(event.channel)) { return; }
			if (!this._options.canRead(event.channel)) { this._subscriptions.delete(event.channel); return; }
			this._send({ jsonrpc: '2.0', method: 'action', params: { ...event,
				action: { type: 'x-ai-browser/sessionChanged', change: event.action } } });
		});
	}

	/** Replies are delivered through send; the returned promise is only for request completion. */
	async receive(value: unknown): Promise<PrototypeReply | undefined> {
		if (!record(value) || value.jsonrpc !== '2.0' || !text(value.method)
			|| ('id' in value && !(typeof value.id === 'string' || typeof value.id === 'number' && Number.isFinite(value.id)))) {
			return this._reply({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request.' } });
		}
		const id = value.id as RpcId | undefined;
		// Unknown notifications are ignored. Mutating prototype operations require requests.
		if (id === undefined && value.method !== 'unsubscribe') { return undefined; }
		try {
			if (this._closed) { throw fault(-32000, 'Connection is closed.'); }
			if (!record(value.params) || !text(value.params.channel, 1024)) { throw fault(-32602, 'A channel is required.'); }
			const result = this._handle(value.method, value.params);
			// Snapshot/recovery operations are synchronous: publish their response before
			// yielding. Only backend controls await a promise (including cross-realm ones).
			const resolved = result && typeof (result as PromiseLike<unknown>).then === 'function' ? await result : result;
			return id === undefined ? undefined : this._reply({ jsonrpc: '2.0', id, result: resolved });
		} catch (error) {
			if (id === undefined) { return undefined; }
			const known = error as { code?: number; message?: string; data?: unknown };
			return this._reply({ jsonrpc: '2.0', id, error: { code: known.code ?? -32000, message: known.message ?? 'Request failed.',
				...(known.data !== undefined ? { data: known.data } : {}) } });
		}
	}

	dispose(): void { this._closed = true; this._subscription.dispose(); this._subscriptions.clear(); this._outgoing.length = 0; }

	private _reply(reply: PrototypeReply): PrototypeReply { this._send(reply); return reply; }
	private _send(message: PrototypeMessage): void {
		if (this._closed) { return; }
		this._outgoing.push(message);
		if (this._sending) { return; }
		this._sending = true;
		try {
			while (this._outgoing.length && !this._closed) {
				const next = this._outgoing.shift()!;
				if ('method' in next) {
					const channel = next.params.channel;
					if (!this._subscriptions.has(channel)) { continue; }
					if (!this._options.canRead(channel)) { this._subscriptions.delete(channel); continue; }
				}
				this._options.send(next);
			}
		} catch (error) { this.dispose(); throw error; }
		finally { this._sending = false; }
	}

	private _snapshot(channel: string): SessionSnapshot | { resource: string; fromSeq: number; state: { agents: never[] } } {
		if (!this._options.canRead(channel)) { throw fault(-32001, 'Channel is not available.'); }
		if (channel === root) { return { resource: root, fromSeq: this._host.serverSeq, state: { agents: [] } }; }
		const snapshot = this._host.snapshot(channel);
		if (!snapshot) { throw fault(-32001, 'Channel is not available.'); }
		return snapshot;
	}
	private _handle(method: string, params: RecordValue): unknown {
		const channel = params.channel as string;
		if (method === 'initialize') {
			if (channel !== root || this._clientId || !text(params.clientId) || !Array.isArray(params.protocolVersions)) { throw fault(-32602, 'Invalid initialization.'); }
			if (!params.protocolVersions.includes(ahpPrototypeVersion)) { throw fault(-32005, 'Unsupported protocol version.', { supportedVersions: [ahpPrototypeVersion] }); }
			const subscriptions = params.initialSubscriptions ?? [root];
			if (!channels(subscriptions)) { throw fault(-32602, 'Invalid subscriptions.'); }
			const snapshots = subscriptions.map(item => this._snapshot(item));
			this._clientId = params.clientId;
			for (const item of subscriptions) { this._subscriptions.add(item); }
			return { protocolVersion: ahpPrototypeVersion, serverSeq: this._host.serverSeq, snapshots,
				serverInfo: { name: 'ai-browser-ahp-prototype' },
				_meta: { 'ai-browser.profile': profile, 'ai-browser.standardChat': false, 'ai-browser.controls': this._host.canExecute } };
		}
		if (!this._clientId) { throw fault(-32000, 'Initialize first.'); }
		if (method === 'subscribe') {
			const snapshot = this._snapshot(channel);
			this._subscriptions.add(channel);
			return { snapshot };
		}
		if (method === 'unsubscribe') { this._subscriptions.delete(channel); return {}; }
		if (method === 'reconnect') {
			if (channel !== root || params.clientId !== this._clientId || !channels(params.subscriptions)
				|| typeof params.lastSeenServerSeq !== 'number') { throw fault(-32602, 'Invalid reconnection.'); }
			// Reject revoked resources before returning any replay or snapshot data.
			for (const item of params.subscriptions) { if (!this._options.canRead(item)) { throw fault(-32001, 'Channel is not available.'); } }
			const recovery = this._host.recover(params.lastSeenServerSeq, params.subscriptions.filter(item => item !== root));
			this._subscriptions.clear();
			for (const item of params.subscriptions) { this._subscriptions.add(item); }
			return recovery.type === 'replay' ? { ...recovery, actions: recovery.actions.map(event => ({ ...event,
				action: { type: 'x-ai-browser/sessionChanged', change: event.action } })) }
				: { ...recovery, snapshots: [...recovery.snapshots, ...(params.subscriptions.includes(root) ? [this._snapshot(root)] : [])] };
		}
		if (method === 'ping') { if (channel !== root) { throw fault(-32602, 'Use the root channel.'); } return {}; }
		if (method === 'x-ai-browser/listSessions') {
			if (channel !== root) { throw fault(-32602, 'Use the root channel.'); }
			return { sessions: this._host.list().filter(item => this._options.canRead(item.resource)).map(item => ({ resource: item.resource,
				id: item.state.id, title: item.state.title, running: item.state.running, agent: item.state.agent })) };
		}
		if (method === 'x-ai-browser/stop' || method === 'x-ai-browser/approve') {
			this._snapshot(channel);
			if (!text(params.chatId) || sessionChannel(params.chatId) !== channel || typeof params.commandId !== 'number'
				|| !Number.isSafeInteger(params.commandId) || params.commandId < 1) { throw fault(-32602, 'Invalid command target.'); }
			let command: SessionCommand;
			if (method === 'x-ai-browser/stop') {
				if (Object.keys(params).some(key => !['channel', 'chatId', 'commandId'].includes(key))) { throw fault(-32602, 'Unexpected command field.'); }
				command = { type: 'stop', chatId: params.chatId, commandId: params.commandId };
			} else {
				if (Object.keys(params).some(key => !['channel', 'chatId', 'commandId', 'approvalId', 'allow'].includes(key))
					|| !text(params.approvalId) || typeof params.allow !== 'boolean') { throw fault(-32602, 'Invalid approval.'); }
				// Question answers and secret input need a separate reviewed contract.
				const approval = this._host.snapshot(channel)?.state.entries.find(entry => entry.kind === 'approval' && entry.id === params.approvalId);
				if (approval?.kind === 'approval' && (approval.what === 'question' || approval.questions?.length)) { throw fault(-32602, 'Question forms are not supported by this prototype.'); }
				command = { type: 'approve', chatId: params.chatId, commandId: params.commandId, approvalId: params.approvalId, allow: params.allow };
			}
			if (!this._options.canControl(command)) { throw fault(-32001, 'Control is not authorized.'); }
			return this._host.dispatch(this._options.clientKey, command).then(() => ({ accepted: true }));
		}
		throw fault(-32601, 'Method not found.');
	}
}
