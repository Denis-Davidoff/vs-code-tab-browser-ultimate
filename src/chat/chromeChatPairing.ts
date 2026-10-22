import { chromeChatProtocolVersion, chromeChatProtocolHeader, chromeChatVersionHeader, chromeChatCompatibilityError, chromeChatCapabilities, chromeChatCapabilitiesHeader, negotiateChromeChatCapabilities, chromeChatFeatureError } from './chromeChatCompatibility';
import * as http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { chromePairingKind, chromePairingPorts, type ChromeChatConnection } from './chromeChatProtocol';

interface PairingRequest {
	extensionId: string;
	secret: string;
	status: 'pending' | 'approved' | 'denied';
	controller: AbortController;
	timer: ReturnType<typeof setTimeout>;
	connection?: ChromeChatConnection;
}

/** Discovery exposes no conversations or credentials. A local editor click grants access. */
export class ChromeChatPairing {
	private readonly _server: http.Server;
	private readonly _requests = new Map<string, PairingRequest>();
	private readonly _instance = randomBytes(16).toString('hex');
	private _host?: string;
	private _closed = false;
	private readonly _reportedMismatch = new Set<string>();
	private _resume?: (extensionId: string, key: string, chatId: string | undefined, strict: boolean) => Promise<ChromeChatConnection | 'elsewhere' | 'unavailable' | undefined>;
	private _resuming = false;

	/**
	 * A Chrome the user allowed before comes back after the editor restarted:
	 * it proves the earlier grant with its resume key and gets a new bridge
	 * without another click in the editor.
	 */
	onResume(handler: (extensionId: string, key: string, chatId: string | undefined, strict: boolean) => Promise<ChromeChatConnection | 'elsewhere' | 'unavailable' | undefined>): void {
		this._resume = handler;
	}

	constructor(private readonly _label: string,
		private readonly _approve: (id: string, extensionId: string, signal: AbortSignal) => Promise<ChromeChatConnection | undefined>,
		private readonly _timeoutMs = 90_000, private readonly _editorVersion = 'unknown',
		private readonly _incompatible?: (message: string) => void) {
		this._server = http.createServer((request, response) => this._handle(request, response));
		this._server.requestTimeout = 5_000;
		this._server.headersTimeout = 5_000;
		this._server.maxHeadersCount = 30;
	}

	async start(ports: readonly number[] = chromePairingPorts): Promise<string> {
		if (this._closed || this._server.listening) { throw new Error('Pairing service is already started or closed'); }
		for (const port of ports) {
			try {
				await new Promise<void>((resolve, reject) => {
					this._server.once('error', reject);
					this._server.listen(port, '127.0.0.1', () => { this._server.removeListener('error', reject); resolve(); });
				});
				if (this._closed) { this._server.close(); throw new Error('Pairing service closed'); }
				this._host = `127.0.0.1:${(this._server.address() as AddressInfo).port}`;
				return `http://${this._host}`;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') { throw error; }
			}
		}
		throw new Error('All Chrome pairing ports are in use');
	}

	private _handle(request: http.IncomingMessage, response: http.ServerResponse): void {
		request.resume();
		response.setHeader('Cache-Control', 'no-store');
		response.setHeader('X-Content-Type-Options', 'nosniff');
		const reply = (status: number, body: unknown = {}) => {
			response.setHeader('Content-Type', 'application/json; charset=utf-8');
			response.writeHead(status).end(JSON.stringify(body));
		};
		const origin = request.headers.origin;
		const extensionId = request.headers['x-ai-browser-extension'];
		if (this._closed || request.headers.host !== this._host
			|| (origin !== undefined && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin))) { reply(403); return; }
		if (origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); }
		const id = /^\/pair\/([a-zA-Z0-9-]{8,80})$/.exec(request.url ?? '')?.[1];
		const resume = request.url === '/resume';
		if (request.url !== '/discovery' && !id && !resume) { reply(404); return; }
		if (request.method === 'OPTIONS') {
			if (!origin || !['GET', 'POST', 'DELETE'].includes(String(request.headers['access-control-request-method']))) { reply(403); return; }
			response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE');
			response.setHeader('Access-Control-Allow-Headers', `X-AI-Browser-Extension, X-Pairing-Secret, X-Resume-Key, X-Resume-Chat, X-Resume-Strict, ${chromeChatProtocolHeader}, ${chromeChatVersionHeader}, ${chromeChatCapabilitiesHeader}`);
			response.writeHead(204).end(); return;
		}
		if (typeof extensionId !== 'string' || !/^[a-p]{32}$/.test(extensionId)
			|| (origin !== undefined && origin !== `chrome-extension://${extensionId}`)) { reply(403); return; }
		if (resume) { this._handleResume(request, extensionId, origin, reply); return; }
		if (!id) {
			if (request.method !== 'GET') { reply(405); return; }
			reply(200, { kind: chromePairingKind, version: 1, protocolVersion: chromeChatProtocolVersion, capabilities: chromeChatCapabilities, editorVersion: this._editorVersion, instance: this._instance, label: this._label }); return;
		}
		const secret = request.headers['x-pairing-secret'];
		if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/.test(secret)) { reply(403); return; }
		let pending = this._requests.get(id);
		if (pending && (pending.extensionId !== extensionId || !timingSafeEqual(Buffer.from(secret), Buffer.from(pending.secret)))) { reply(403); return; }
		// Creation relies on the browser-supplied Origin, not a self-declared ID header.
		if (request.method === 'POST' && origin !== `chrome-extension://${extensionId}`) { reply(403); return; }
		if (request.method === 'POST') {
			const compatibility = chromeChatCompatibilityError(chromeChatProtocolVersion, Number(request.headers[chromeChatProtocolHeader.toLowerCase()]), this._editorVersion, request.headers[chromeChatVersionHeader.toLowerCase()]);
			const features = negotiateChromeChatCapabilities(request.headers[chromeChatCapabilitiesHeader.toLowerCase()], Number(request.headers[chromeChatProtocolHeader.toLowerCase()]));
			if (!compatibility && !features.chat) { reply(409, { error: chromeChatFeatureError('chat') }); return; }
			if (compatibility) {
				if (!this._reportedMismatch.has(compatibility) && this._reportedMismatch.size < 16) {
					this._reportedMismatch.add(compatibility); this._incompatible?.(compatibility);
				}
				reply(426, { error: compatibility, protocolVersion: chromeChatProtocolVersion, capabilities: chromeChatCapabilities, editorVersion: this._editorVersion }); return;
			}
		}
		if (request.method === 'POST' && !pending) {
			if (this._requests.size >= 32 || [...this._requests.values()].some(entry => entry.status === 'pending')) { reply(429); return; }
			const controller = new AbortController();
			pending = { extensionId, secret, status: 'pending', controller,
				timer: setTimeout(() => {
					controller.abort(); this._requests.delete(id);
				}, this._timeoutMs) };
			this._requests.set(id, pending);
			const current = pending;
			void Promise.resolve().then(() => controller.signal.aborted ? undefined : this._approve(id, extensionId, controller.signal)).then(connection => {
				if (this._closed || controller.signal.aborted || this._requests.get(id) !== current) { return; }
				current.status = connection ? 'approved' : 'denied'; current.connection = connection;
				clearTimeout(current.timer);
				current.timer = setTimeout(() => this._requests.delete(id), 60_000);
			}, () => {
				if (!controller.signal.aborted) { current.status = 'denied'; }
			});
		}
		if (!pending) { reply(404, { status: 'expired' }); return; }
		if (request.method === 'DELETE') {
			pending.controller.abort(); clearTimeout(pending.timer); this._requests.delete(id);
			reply(200, { status: 'denied' }); return;
		}
		if (request.method !== 'POST' && request.method !== 'GET') { reply(405); return; }
		reply(pending.status === 'pending' ? 202 : 200, { status: pending.status,
			...(pending.status === 'approved' ? { connection: pending.connection } : {}) });
	}

	private _handleResume(request: http.IncomingMessage, extensionId: string, origin: string | undefined, reply: (status: number, body?: unknown) => void): void {
		if (request.method !== 'POST') { reply(405); return; }
		// Like creating a request: the browser-supplied Origin, never a self-declared header alone.
		if (origin !== `chrome-extension://${extensionId}`) { reply(403); return; }
		const key = request.headers['x-resume-key'];
		const chat = request.headers['x-resume-chat'];
		if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) { reply(403); return; }
		const chatId = typeof chat === 'string' && chat.length > 0 && chat.length <= 100 ? chat : undefined;
		const compatibility = chromeChatCompatibilityError(chromeChatProtocolVersion, Number(request.headers[chromeChatProtocolHeader.toLowerCase()]), this._editorVersion, request.headers[chromeChatVersionHeader.toLowerCase()]);
		if (compatibility) { reply(426, { error: compatibility, protocolVersion: chromeChatProtocolVersion, capabilities: chromeChatCapabilities, editorVersion: this._editorVersion }); return; }
		if (!this._resume) { reply(404); return; }
		if (this._resuming) { reply(429); return; }
		this._resuming = true;
		const strict = request.headers['x-resume-strict'] === '1';
		void this._resume(extensionId, key, chatId, strict).then(connection => {
			if (this._closed) { reply(410); return; }
			if (connection === 'elsewhere') { reply(409, { status: 'elsewhere' }); return; }
			if (connection === 'unavailable') { reply(503, { status: 'unavailable' }); return; }
			reply(connection ? 200 : 401, connection ? { status: 'approved', connection } : { status: 'denied' });
		}, () => reply(503, { status: 'unavailable' })).finally(() => { this._resuming = false; });
	}

	cancelPending(): void {
		for (const [id, pending] of this._requests) {
			if (pending.status === 'pending') { pending.controller.abort(); clearTimeout(pending.timer); this._requests.delete(id); }
		}
	}

	dispose(): void {
		this._closed = true;
		for (const pending of this._requests.values()) { clearTimeout(pending.timer); pending.controller.abort(); }
		this._requests.clear(); this._server.close(); this._server.closeAllConnections();
	}
}
