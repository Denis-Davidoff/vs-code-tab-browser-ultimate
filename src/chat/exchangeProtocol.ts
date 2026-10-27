import { isIP } from 'node:net';
import type { ChatViewState } from './chatProtocol';

export interface ExchangeCommand {
	readonly type: 'chat.send' | 'chat.stop';
	readonly id: string;
	readonly chatId: string;
	readonly text?: string;
}

/** A remote client has only these two capabilities, never arbitrary editor commands. */
export function readExchangeCommand(value: unknown): ExchangeCommand | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { return undefined; }
	const item = value as Record<string, unknown>;
	if (typeof item.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.id)
		|| typeof item.chatId !== 'string' || !item.chatId || item.chatId.length > 200) { return undefined; }
	if (item.type !== 'chat.send' && item.type !== 'chat.stop') { return undefined; }
	const fields = item.type === 'chat.send' ? ['type', 'id', 'chatId', 'text'] : ['type', 'id', 'chatId'];
	if (Object.keys(item).some(key => !fields.includes(key))) { return undefined; }
	if (item.type === 'chat.send' && (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 64000)) { return undefined; }
	return item as unknown as ExchangeCommand;
}

/** Plain HTTP is supported on loopback and private networks during local development. */
function privateNetworkHost(hostname: string): boolean {
	if (hostname === 'localhost') { return true; }
	const host = hostname.replace(/^\[|\]$/g, '');
	if (isIP(host) === 4) {
		const [a, b] = host.split('.').map(Number);
		return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
	}
	return isIP(host) === 6 && (host === '::1' || /^f[cd][0-9a-f]{2}:/i.test(host));
}

/** Never accept URL credentials, query strings or paths as a server address. */
export function exchangeServerUrl(value: string): string {
	const url = new URL(value);
	if (url.username || url.password || url.search || url.hash || url.pathname !== '/') { throw new Error('Use a server address without a path, credentials or query parameters.'); }
	if (url.protocol === 'https:') { url.protocol = 'wss:'; }
	if (url.protocol === 'http:') { url.protocol = 'ws:'; }
	if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && privateNetworkHost(url.hostname))) {
		throw new Error('Use HTTPS/WSS, or an HTTP address on your local network for development.');
	}
	return url.origin;
}

/** Settings show a website address; WebSocket schemes stay inside the transport. */
export function exchangeWebsiteUrl(value: string): string {
	const url = new URL(exchangeServerUrl(value));
	url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
	return url.origin;
}

/** Text-only projection: no tool arguments, credentials, drafts, files or local resource URLs. */
export function exchangeSnapshot(state: ChatViewState): string {
	const messages: { id: string; role: 'user' | 'assistant' | 'system'; text: string }[] = [];
	for (const [index, entry] of state.entries.entries()) {
		if (entry.kind === 'user' || entry.kind === 'assistant' || entry.kind === 'notice' || entry.kind === 'error') {
			messages.push({ id: `${state.chatId}:${index}`, role: entry.kind === 'user' ? 'user' : entry.kind === 'assistant' ? 'assistant' : 'system', text: entry.text.slice(0, 64000) });
		} else if (entry.kind === 'approval' && entry.status === 'pending') {
			messages.push({ id: `${state.chatId}:${index}`, role: 'system', text: `Approval required in VS Code: ${entry.title}`.slice(0, 64000) });
		}
	}
	const bounded: typeof messages = [];
	let bytes = 0;
	for (let index = messages.length - 1; index >= 0 && bounded.length < 1000; index--) {
		const message = messages[index];
		const size = Buffer.byteLength(JSON.stringify(message)) + 1;
		if (bytes + size > 890_000) { break; }
		bounded.push(message); bytes += size;
	}
	return JSON.stringify({ type: 'chat.snapshot', chatId: state.chatId, running: state.running, messages: bounded.reverse() });
}
