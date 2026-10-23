import type { ExchangeConnectionState } from './chatProtocol';

export interface ExchangeConnectionInput { readonly url: string; readonly pointId: string; readonly key?: string; readonly password?: string }
interface Handler {
	connect(input: ExchangeConnectionInput, source: string): Promise<void>;
	disconnect(): void;
}

/** Window-local connection state. Secrets never enter the published state. */
export class ExchangeConnectionPort {
	private current: ExchangeConnectionState = { url: 'http://127.0.0.1:3001', pointId: '', hasKey: false, status: 'disconnected' };
	private readonly listeners = new Set<() => void>();
	private handler?: Handler;
	get state(): ExchangeConnectionState { return this.current; }
	onDidChange(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => { this.listeners.delete(listener); } };
	}
	update(change: Partial<ExchangeConnectionState>): void {
		this.current = { ...this.current, ...change };
		for (const listener of this.listeners) { listener(); }
	}
	bind(handler: Handler): { dispose(): void } {
		this.handler = handler;
		return { dispose: () => { if (this.handler === handler) { this.handler = undefined; } } };
	}
	async connect(input: ExchangeConnectionInput, source: string): Promise<void> {
		if (!this.handler) { this.update({ error: 'Server connection is not available in this window.' }); return; }
		try { await this.handler.connect(input, source); }
		catch (error) { this.update({ error: error instanceof Error ? error.message : 'Could not connect to the server.' }); }
	}
	disconnect(): void { this.handler?.disconnect(); }
}
export const exchangeConnection = new ExchangeConnectionPort();
