import { chromeChatProtocolVersion, chromeChatProtocolHeader, chromeChatVersionHeader, chromeChatCompatibilityError, chromeChatCapabilities, chromeChatCapabilitiesHeader, negotiateChromeChatCapabilities, chromeChatFeatureError, chromeChatAttachmentFeature, chromeChatCommandFeature } from './chromeChatCompatibility';
import { ChromeAnnotationSession, chromeAnnotationSessions } from '../browser/chromeAnnotationSessions';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChatStateSurface } from './chatSurface';
import type { ChatViewState, HostToView } from './chatProtocol';
import { chromeChatSnapshot, readChromeChatCommand, type ChromeChatCommand, type ChromeChatConnection } from './chromeChatProtocol';

/** Delivery state belongs to an approved session, not its replaceable HTTP bridge. */
export class ChromeChatDelivery {
	readonly id = randomBytes(16).toString('hex');
	sequence = 0;
	readonly events: { id: number; chatId: string; message?: HostToView; error?: string }[] = [];
	readonly commands = new Map<string, { json: string; result: Promise<{ status: number; error?: string }> }>();
}

/** Authenticated UI endpoint with a bounded, explicit command protocol. */
export class ChromeChatBridge implements ChatStateSurface {
	private readonly _token = randomBytes(32).toString('hex');
	private readonly _server: http.Server;
	private readonly _origin: string;
	private _body?: string;
	private _revision = 0;
	private _closed = false;
	private _host?: string;
	/** The conversation Chrome shows; set from the tab in front when Chrome connects. */
	private _chatId?: string;
	private _chats = new Set<string>();
	private _refresh?: () => void;
	/** Whether the agents' browser tools drive the very Chrome this panel runs in. */
	private _driven?: boolean;
	private readonly _annotations = new ChromeAnnotationSession(() => this._chats);
	private _releaseAnnotations?: () => void;
	private _presenceTimer?: ReturnType<typeof setTimeout>;
	private _active = false;
	get active(): boolean { return this._active; }

	/** Snapshot polling is the panel heartbeat, including unchanged (304) snapshots. */
	private _touchPresence(): void {
		if (this._presenceTimer) { clearTimeout(this._presenceTimer); }
		this._presenceTimer = setTimeout(() => {
			this._presenceTimer = undefined;
			this._active = false;
			this._refresh?.();
		}, 10_000);
		this._presenceTimer.unref?.();
		if (!this._active) { this._active = true; this._refresh?.(); }
	}


	constructor(private readonly _extensionId: string, private readonly _command?: (command: ChromeChatCommand, reply: (message: HostToView, chatId?: string) => void) => Promise<void>, private readonly _editorVersion = 'unknown', private readonly _delivery = new ChromeChatDelivery()) {
		if (!/^[a-p]{32}$/.test(_extensionId)) { throw new Error('Invalid Chrome extension ID'); }
		this._origin = `chrome-extension://${_extensionId}`;
		this._server = http.createServer((request, response) => this._handle(request, response));
		this._server.requestTimeout = 5_000;
		this._server.headersTimeout = 5_000;
		this._server.maxHeadersCount = 30;
	}

	async start(): Promise<ChromeChatConnection> {
		if (this._closed || this._server.listening) { throw new Error('Bridge already started or closed'); }
		await new Promise<void>((resolve, reject) => {
			this._server.once('error', reject);
			this._server.listen(0, '127.0.0.1', () => {
				this._server.removeListener('error', reject);
				resolve();
			});
		});
		this._releaseAnnotations = chromeAnnotationSessions.register(this._annotations);
		this._host = `127.0.0.1:${(this._server.address() as AddressInfo).port}`;
		return { version: 1, deliverySession: this._delivery.id, protocolVersion: chromeChatProtocolVersion, capabilities: chromeChatCapabilities, editorVersion: this._editorVersion, url: `http://${this._host}`, token: this._token, extensionId: this._extensionId };
	}

	get chatId(): string | undefined { return this._chatId; }
	/** Before attaching: the conversation to show first, if the panel still has it. */
	pin(chatId: string | undefined): void { if (chatId) { this._chatId = chatId; } }
	bind(refresh: () => void): void { this._refresh = refresh; }
	get extensionId(): string { return this._extensionId; }
	/** Set by the editor's check; the panel shows the mode it implies. */
	setDriven(driven: boolean): void {
		if (driven === this._driven) { return; }
		this._driven = driven;
		this._refresh?.();
	}

	update(state: ChatViewState): void {
		if (this._closed) { return; }
		this._chats = new Set([state.chatId, ...state.tabs.map(tab => tab.chatId)]);
		// A pinned conversation closed in the editor: follow what the editor shows instead.
		this._chatId = state.chatId;
		const body = JSON.stringify({ ...chromeChatSnapshot(state, this._editorVersion), deliverySession: this._delivery.id, canSend: !!this._command, agentChrome: this._driven });
		if (body !== this._body) { this._body = body; this._revision++; }
	}

	private _handle(request: http.IncomingMessage, response: http.ServerResponse): void {
		response.setHeader('Cache-Control', 'no-store');
		response.setHeader('X-Content-Type-Options', 'nosniff');
		const origin = request.headers.origin;
		if (request.headers.host !== this._host || (origin !== undefined && origin !== this._origin)) {
			response.writeHead(403).end(); return;
		}
		if (origin === this._origin) {
			response.setHeader('Access-Control-Allow-Origin', this._origin);
			response.setHeader('Vary', 'Origin');
		}
		const eventMatch = /^\/events\?after=([0-9]{1,15})$/.exec(request.url ?? '');
		const annotationRoute = request.url === '/annotations';
		const commandRoute = request.url === '/command' || annotationRoute;
		if (!commandRoute && !eventMatch && request.url !== '/snapshot') { response.writeHead(404).end(); return; }
		if (request.method === 'OPTIONS') {
			if (origin !== this._origin || request.headers['access-control-request-method'] !== (commandRoute ? 'POST' : 'GET')) {
				response.writeHead(403).end(); return;
			}
			response.setHeader('Access-Control-Allow-Methods', commandRoute ? 'POST' : 'GET');
			response.setHeader('Access-Control-Allow-Headers', `Authorization, If-None-Match, Content-Type, ${chromeChatProtocolHeader}, ${chromeChatVersionHeader}, ${chromeChatCapabilitiesHeader}`);
			response.writeHead(204).end(); return;
		}
		const authorization = Buffer.from(request.headers.authorization ?? '');
		const expected = Buffer.from(`Bearer ${this._token}`);
		if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
			response.writeHead(401).end(); return;
		}
		const clientProtocol = request.headers[chromeChatProtocolHeader.toLowerCase()];
		const features = negotiateChromeChatCapabilities(request.headers[chromeChatCapabilitiesHeader.toLowerCase()], Number(clientProtocol));
		const compatibility = chromeChatCompatibilityError(chromeChatProtocolVersion, Number(clientProtocol), this._editorVersion, request.headers[chromeChatVersionHeader.toLowerCase()]);
		if (compatibility) {
			request.resume();
			response.setHeader('Content-Type', 'application/json; charset=utf-8');
			if (clientProtocol === undefined && request.url === '/snapshot' && request.method === 'GET' && this._body) {
				// Older panels only understand snapshots. Their existing blocked UI can show the update instruction.
				const snapshot = JSON.parse(this._body) as ReturnType<typeof chromeChatSnapshot>;
				const entries = [{ kind: 'notice', text: compatibility }];
				response.writeHead(200).end(JSON.stringify({ ...snapshot, blocked: compatibility, entries, canSend: true, canAttachElements: false,
					view: { ...snapshot.view, blocked: compatibility, entries } }));
			} else {
				response.writeHead(426).end(JSON.stringify({ error: compatibility, protocolVersion: chromeChatProtocolVersion, capabilities: chromeChatCapabilities, editorVersion: this._editorVersion }));
			}
			return;
		}
		if (!features.chat || (annotationRoute && !features.annotations)) {
			response.setHeader('Content-Type', 'application/json');
			response.writeHead(features.chat ? 409 : 426).end(JSON.stringify({ error: chromeChatFeatureError(features.chat ? 'annotations' : 'chat') })); return;
		}

		if (annotationRoute && request.method === 'POST') { void this._syncAnnotations(request, response); return; }

		if (commandRoute && request.method === 'POST') {
			void this._receiveCommand(request, response); return;
		}
		if (commandRoute) { response.writeHead(405).end(); return; }
		if (request.method !== 'GET') {
			response.setHeader('Allow', 'GET, OPTIONS');
			response.writeHead(405).end(); return;
		}
		if (eventMatch) {
			response.setHeader('Content-Type', 'application/json');
			response.writeHead(200).end(JSON.stringify({ cursor: this._delivery.sequence, events: this._delivery.events.filter(event => event.id > Number(eventMatch[1])) })); return;
		}
		if (!this._body || this._closed) { response.writeHead(503).end(); return; }
		this._touchPresence();
		const etag = `"${this._revision}"`;
		response.setHeader('ETag', etag);
		response.setHeader('Access-Control-Expose-Headers', 'ETag');
		if (request.headers['if-none-match'] === etag) { response.writeHead(304).end(); return; }
		response.setHeader('Content-Type', 'application/json; charset=utf-8');
		response.writeHead(200).end(this._body);
	}

	private async _receiveCommand(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
		const reply = (status: number, error?: string) => {
			if (response.destroyed || response.writableEnded) { return; }
			response.setHeader('Content-Type', 'application/json; charset=utf-8');
			response.writeHead(status).end(JSON.stringify({ error, ...(status === 200 && this._body ? { snapshot: JSON.parse(this._body) } : {}) }));
		};
		if (!this._command) { reply(405, 'Sending is unavailable. Update the editor extension.'); return; }
		let raw: unknown;
		try {
			const body = await new Promise<string>((resolve, reject) => {
				const chunks: Buffer[] = []; let size = 0;
				request.on('data', (chunk: Buffer) => {
					size += chunk.length;
					if (size > 6_000_000) { reject(new Error('Message too large')); }
					else { chunks.push(chunk); }
				});
				request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
				request.on('aborted', () => reject(new Error('Request aborted')));
				request.on('error', reject);
			});
			raw = JSON.parse(body);
		} catch { reply(400, 'Invalid or oversized message.'); return; }
		const pin = readPin(raw);
		if (pin !== undefined) {
			if (this._closed) { reply(410, 'Connection revoked.'); return; }
			if (!this._chats.has(pin)) { reply(409, 'This conversation is no longer open in the editor.'); return; }
			this._chatId = pin; this._refresh?.();
			reply(200); return;
		}
		const command = readChromeChatCommand(raw);
		if (!command) { reply(400, 'This action is not supported in Chrome yet.'); return; }
		const features = negotiateChromeChatCapabilities(request.headers[chromeChatCapabilitiesHeader.toLowerCase()], Number(request.headers[chromeChatProtocolHeader.toLowerCase()]));
		const feature = chromeChatCommandFeature(command.message);
		if (!features[feature]) { reply(409, chromeChatFeatureError(feature)); return; }
		if (feature !== 'chat' && !this._chats.has(command.chatId)) { reply(409, 'This conversation is no longer open in the editor.'); return; }
		for (const item of command.attachments ?? []) {
			const feature = chromeChatAttachmentFeature(item.kind);
			if (!features[feature]) { reply(409, chromeChatFeatureError(feature)); return; }
		}
		if (this._closed) { reply(410, 'Connection revoked.'); return; }
		const json = JSON.stringify(command);
		let saved = this._delivery.commands.get(command.id);
		if (saved && saved.json !== json) { reply(409, 'A request ID was reused with different content.'); return; }
		if (!saved) {
			if (this._delivery.commands.size >= 2048) { reply(429, 'Pair Chrome again with Connect to start a new delivery session.'); return; }
			const result = Promise.resolve().then(() => {
				if (this._closed) { throw new Error('Connection revoked.'); }
				return this._command!(command, (message, targetChatId = command.chatId) => {
					if (!this._closed && targetChatId !== command.chatId && this._chatId === command.chatId && this._chats.has(targetChatId)) {
						this._chatId = targetChatId; this._refresh?.();
					}
					this._publishEvent({ chatId: targetChatId, message });
				});
			}).then(() => ({ status: 200 }),
				(error: unknown) => {
					const message = error instanceof Error ? error.message : 'Action refused.';
					if (feature !== 'chat') { this._publishEvent({ chatId: command.chatId, error: message }); }
					return { status: 409, error: message };
				});
			saved = { json, result }; this._delivery.commands.set(command.id, saved);
		}
		// Long Git operations and native dialogs must not hold the Chrome outbox or Stop.
		if (feature !== 'chat') { reply(200); return; }
		const result = await saved.result;
		reply(result.status, result.error);
	}

	private _publishEvent(event: { chatId: string; message?: HostToView; error?: string }): void {
		this._delivery.events.push({ ...event, id: ++this._delivery.sequence });
		// Answers survive a lost response; polling acknowledges by sequence, not by consuming them.
		while (this._delivery.events.length > 128 || Buffer.byteLength(JSON.stringify(this._delivery.events)) > 4_000_000) { this._delivery.events.shift(); }
	}

	private async _syncAnnotations(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
		response.setHeader('Content-Type', 'application/json; charset=utf-8');
		try {
			const chunks: Buffer[] = []; let size = 0;
			for await (const chunk of request) {
				size += chunk.length;
				if (size > 6_000_000) { throw new Error('Annotation synchronization is too large.'); }
				chunks.push(chunk);
			}
			const requests = this._annotations.sync(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			response.writeHead(200).end(JSON.stringify({ requests }));
		} catch (error) { if (!response.destroyed) { response.writeHead(400).end(JSON.stringify({ error: error instanceof Error ? error.message : 'Invalid annotations.' })); } }
	}

	close(): void {
		if (this._closed) { return; }
		this._closed = true;
		if (this._presenceTimer) { clearTimeout(this._presenceTimer); this._presenceTimer = undefined; }
		this._active = false;
		this._releaseAnnotations?.();
		this._body = undefined;
		this._server.close();
		this._server.closeAllConnections();
	}
}

/** `{ message: { type: 'pin' }, chatId }`: which conversation Chrome shows. Handled by the bridge alone. */
function readPin(raw: unknown): string | undefined {
	if (!raw || typeof raw !== 'object') { return undefined; }
	const value = raw as Record<string, unknown>;
	const message = value.message as Record<string, unknown> | undefined;
	if (!message || typeof message !== 'object' || message.type !== 'pin') { return undefined; }
	return typeof value.chatId === 'string' && value.chatId.length <= 100 ? value.chatId : '';
}
