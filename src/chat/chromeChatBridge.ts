import { chromeChatProtocolVersion, chromeChatProtocolHeader, chromeChatVersionHeader, chromeChatCompatibilityError, chromeChatCapabilities, chromeChatCapabilitiesHeader, negotiateChromeChatCapabilities, chromeChatFeatureError, chromeChatAttachmentFeature, chromeChatCommandFeature, chromeChatWaitHeader, chromeChatMaxWaitMs, chromeChatBaseHeader } from './chromeChatCompatibility';
import { diffState } from './core/sync';
import { ChromeAnnotationSession, chromeAnnotationSessions } from '../browser/chromeAnnotationSessions';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChatStateSurface } from './chatSurface';
import type { ChatViewState, HostToView } from './chatProtocol';
import { chromeChatSnapshot, readChromeChatCommand, type ChromeChatCommand, type ChromeChatConnection } from './chromeChatProtocol';
import type { TerminalSupport, TerminalTabSummary } from './chatProtocol';
import { RemoteTerminalHub, isTerminalFrame, type AgentTerminalFrame, type RemoteTerminalTarget } from './remoteTerminalProtocol';
import { remoteTerminalView, terminalLifecycleTypes } from './remoteTerminalView';

/**
 * The editor's terminals as the Chrome bridge reaches them: the same port the
 * Exchange website uses, plus the setting, the consent modal and the audit log.
 * Absent (an older wiring, a test): Chrome is offered no terminals.
 */
export interface ChromeTerminalPort {
	readonly terminals: { find(id: string): RemoteTerminalTarget | undefined; shared(): readonly TerminalTabSummary[]; support(): TerminalSupport; blocked(): boolean };
	setting(): boolean;
	/** `aiBrowser.chat.remoteTerminalShell` / `remoteTerminalAgent`. */
	openShell(): boolean;
	openAgent(): boolean;
	/** The modal in VS Code; asked once per bridge (connection). */
	askConsent(): Promise<boolean>;
	audit(line: string): void;
}

/** Agent frames kept for the panel's long-poll: the hub's flow control bounds data, this bounds everything. */
const terminalFramesKept = 2048;
const terminalFramesBytes = 4_000_000;
/** Viewer frames in one POST. */
const terminalFramesPerPost = 64;

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
	readonly kind = 'chrome' as const;
	/**
	 * Snapshot requests held open while nothing changed (long-poll): woken by a
	 * new revision, a delivered event or the bridge closing, so a change reaches
	 * the panel at once instead of at its next poll.
	 */
	private readonly _waiters = new Set<() => void>();
	private _wake(): void { for (const wake of [...this._waiters]) { wake(); } }
	/** Names this bridge's revisions: a panel's base from another bridge never matches. */
	private readonly _epoch = randomBytes(8).toString('hex');
	/** The last few published snapshots, as copies, for patches against them. */
	private readonly _published = new Map<number, Record<string, unknown>>();
	/** Terminal tabs in Chrome: see `ChromeTerminalPort`. */
	private _terminalPort?: ChromeTerminalPort;
	private _terminalConsent: 'unasked' | 'asking' | 'yes' | 'no' = 'unasked';
	private _consentAsk?: Promise<boolean>;
	private _hub?: RemoteTerminalHub;
	private _terminalSequence = 0;
	private _terminalFrames: { id: number; frame: AgentTerminalFrame; bytes: number }[] = [];
	private _terminalBytes = 0;
	private readonly _terminalWaiters = new Set<() => void>();
	private _lastState?: ChatViewState;

	/** Snapshot polling is the panel heartbeat, including unchanged (304) snapshots. */
	private _touchPresence(): void {
		if (this._presenceTimer) { clearTimeout(this._presenceTimer); }
		this._presenceTimer = setTimeout(() => {
			this._presenceTimer = undefined;
			this._active = false;
			// No panel is polling: nobody is watching, and nobody may hold a lease.
			this._hub?.dropAll();
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

	/** Gives Chrome the editor's shared terminals (`ChromeTerminalPort`). */
	setTerminals(port: ChromeTerminalPort): void { this._terminalPort = port; if (this._lastState) { this.update(this._lastState); } }

	private _terminalsAllowed(): boolean {
		const port = this._terminalPort;
		return !!port && !this._closed && port.setting() && this._terminalConsent === 'yes' && !port.terminals.blocked();
	}
	/** Asks once per bridge; `false` with no port, the setting off, or a refusal. */
	private async _terminalConsentFor(): Promise<boolean> {
		const port = this._terminalPort;
		if (!port || !port.setting() || this._closed) { return false; }
		if (this._terminalConsent === 'yes') { return true; }
		if (this._terminalConsent === 'no') { return false; }
		if (!this._consentAsk) {
			this._terminalConsent = 'asking';
			this._consentAsk = port.askConsent().then(yes => yes && !this._closed, () => false).then(yes => {
				this._terminalConsent = yes ? 'yes' : 'no';
				port.audit(`consent ${this._terminalConsent} chrome=${this._extensionId}`);
				if (this._lastState) { this.update(this._lastState); }
				return yes;
			});
		}
		return this._consentAsk;
	}
	private _terminalHub(): RemoteTerminalHub {
		const port = this._terminalPort!;
		return this._hub ??= new RemoteTerminalHub({
			allowed: () => this._terminalsAllowed(),
			epoch: () => this._epoch,
			find: id => port.terminals.find(id),
			send: frame => this._pushTerminalFrame(frame),
			audit: event => port.audit(`chrome ${event.kind} viewer=${event.v} terminal=${event.t}${event.detail ? ' ' + event.detail : ''}`),
		});
	}
	private _pushTerminalFrame(frame: AgentTerminalFrame): void {
		if (this._closed) { return; }
		const bytes = Buffer.byteLength(JSON.stringify(frame));
		this._terminalFrames.push({ id: ++this._terminalSequence, frame, bytes });
		this._terminalBytes += bytes;
		while (this._terminalFrames.length > terminalFramesKept || this._terminalBytes > terminalFramesBytes) { this._terminalBytes -= this._terminalFrames.shift()!.bytes; }
		for (const wake of [...this._terminalWaiters]) { wake(); }
	}

	update(state: ChatViewState): void {
		if (this._closed) { return; }
		this._lastState = state;
		this._chats = new Set([state.chatId, ...state.tabs.map(tab => tab.chatId)]);
		// A pinned conversation closed in the editor: follow what the editor shows instead.
		this._chatId = state.chatId;
		const snapshot = chromeChatSnapshot(state, this._editorVersion);
		const port = this._terminalPort;
		if (port) {
			const { controls, ...terminals } = remoteTerminalView({ surface: 'chrome', encrypted: true, setting: port.setting(), openShell: port.openShell(), openAgent: port.openAgent(), consent: this._terminalConsent, blocked: port.terminals.blocked() },
				() => port.terminals.shared(), () => port.terminals.support());
			Object.assign(snapshot.view, terminals, { controls: { ...snapshot.view.controls, ...controls } });
			this._hub?.sync();
		}
		const body = JSON.stringify({ ...snapshot, deliverySession: this._delivery.id, canSend: !!this._command, agentChrome: this._driven, ...(port ? { terminalEpoch: this._epoch } : {}) });
		if (body !== this._body) {
			this._body = body; this._revision++;
			// A copy, not the live state: what was published must not move under a later diff.
			this._published.set(this._revision, JSON.parse(body) as Record<string, unknown>);
			for (const rev of this._published.keys()) { if (this._published.size > 4) { this._published.delete(rev); } }
			this._wake();
		}
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
		const terminalPost = request.url === '/terminal';
		const terminalMatch = /^\/terminal\?after=([0-9]{1,15})$/.exec(request.url ?? '');
		const commandRoute = request.url === '/command' || annotationRoute || terminalPost;
		if (!commandRoute && !eventMatch && !terminalMatch && request.url !== '/snapshot') { response.writeHead(404).end(); return; }
		if (request.method === 'OPTIONS') {
			if (origin !== this._origin || request.headers['access-control-request-method'] !== (commandRoute ? 'POST' : 'GET')) {
				response.writeHead(403).end(); return;
			}
			response.setHeader('Access-Control-Allow-Methods', commandRoute ? 'POST' : 'GET');
			response.setHeader('Access-Control-Allow-Headers', `Authorization, If-None-Match, Content-Type, ${chromeChatWaitHeader}, ${chromeChatProtocolHeader}, ${chromeChatVersionHeader}, ${chromeChatCapabilitiesHeader}`);
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
		if (terminalPost && request.method === 'POST') { void this._receiveTerminalFrames(request, response); return; }
		if (terminalMatch && request.method === 'GET') { this._sendTerminalFrames(request, response, Number(terminalMatch[1])); return; }

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
		const wait = Math.min(chromeChatMaxWaitMs, Math.max(0, Number(request.headers[chromeChatWaitHeader.toLowerCase()]) || 0));
		response.setHeader('Access-Control-Expose-Headers', `ETag, ${chromeChatWaitHeader}, ${chromeChatBaseHeader}`);
		const answer = () => {
			if (response.destroyed || response.writableEnded) { return; }
			const etag = `"${this._revision}"`;
			response.setHeader('ETag', etag);
			if (wait) { response.setHeader(chromeChatWaitHeader, String(wait)); }
			if (this._closed || !this._body) { response.writeHead(503).end(); return; }
			if (request.headers['if-none-match'] === etag) { response.writeHead(304).end(); return; }
			response.setHeader('Content-Type', 'application/json; charset=utf-8');
			response.setHeader(chromeChatBaseHeader, this._epoch);
			response.writeHead(200).end(this._patchFor(request.headers[chromeChatBaseHeader.toLowerCase()]) ?? this._body);
		};
		// Nothing new: hold the request (an unchanged snapshot is the common case).
		if (!wait || request.headers['if-none-match'] !== `"${this._revision}"`) { answer(); return; }
		const events = this._delivery.sequence;
		const done = () => { clearTimeout(timer); this._waiters.delete(wake); response.off('close', done); };
		const wake = () => { if (this._delivery.sequence !== events || request.headers['if-none-match'] !== `"${this._revision}"` || this._closed) { done(); answer(); } };
		const timer = setTimeout(() => { done(); answer(); }, wait);
		this._waiters.add(wake);
		// The response's close, not the request's: a GET request emits close once its body is read.
		response.on('close', done);
	}

	/**
	 * A patch from the revision the panel names to the current one, or
	 * `undefined` for the whole snapshot: another epoch, a revision no longer
	 * held, or a patch not much smaller than the snapshot. The view is diffed on
	 * its own and the rest sent whole (`top`, small), so a streaming reply sends
	 * its last entry once rather than the whole view.
	 */
	private _patchFor(header: string | string[] | undefined): string | undefined {
		const match = typeof header === 'string' ? /^([0-9a-f]{16}):(\d{1,15})$/.exec(header) : null;
		if (!match || match[1] !== this._epoch || !this._body) { return undefined; }
		const base = this._published.get(Number(match[2]));
		const current = this._published.get(this._revision);
		if (!base || !current || Number(match[2]) === this._revision) { return undefined; }
		const view = (v: Record<string, unknown>) => (v.view ?? {}) as Record<string, unknown>;
		const patch = diffState(view(base), view(current), Number(match[2]), this._revision);
		if (!patch) { return undefined; }
		const { view: _view, entries: _entries, ...top } = current;
		const body = JSON.stringify({ patch, top });
		return body.length * 2 < this._body.length ? body : undefined;
	}

	private async _receiveCommand(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
		const reply = (status: number, error?: string) => {
			if (response.destroyed || response.writableEnded) { return; }
			response.setHeader('Content-Type', 'application/json; charset=utf-8');
			response.writeHead(status).end(JSON.stringify({ error, ...(status === 200 && this._body ? { snapshot: JSON.parse(this._body), revision: this._revision } : {}) }));
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
		if ((terminalLifecycleTypes as readonly string[]).includes(command.message.type)) {
			// Consent before anything reaches the terminals; the host checks the setting and the share again.
			if (!(await this._terminalConsentFor())) { reply(409, this._terminalPort?.setting() === false ? 'Terminals are off for Chrome: in VS Code, turn on the setting “AI Browser › Chat: Remote Terminal” (aiBrowser.chat.remoteTerminal).' : 'Terminal access was not allowed in VS Code for this connection.'); return; }
			this._terminalPort?.audit(`chrome ${command.message.type}`);
		}
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

	/** `POST /terminal`: `{ frames: [...] }` from the panel's shim, each checked by the hub. */
	private async _receiveTerminalFrames(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
		response.setHeader('Content-Type', 'application/json; charset=utf-8');
		let frames: unknown[];
		try {
			const chunks: Buffer[] = []; let size = 0;
			for await (const chunk of request) {
				size += (chunk as Buffer).length;
				if (size > 1_000_000) { throw new Error('Too large.'); }
				chunks.push(chunk as Buffer);
			}
			const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { frames?: unknown };
			if (!Array.isArray(value?.frames) || value.frames.length > terminalFramesPerPost) { throw new Error('Invalid frames.'); }
			frames = value.frames;
		} catch { if (!response.destroyed) { response.writeHead(400).end(JSON.stringify({ error: 'Invalid terminal frames.' })); } return; }
		if (!this._terminalPort || this._closed) { response.writeHead(409).end(JSON.stringify({ error: 'Terminals are not available in this editor.' })); return; }
		for (const frame of frames) {
			if (!isTerminalFrame(frame)) { continue; }
			if ((frame as { type: string }).type === 'terminal.attach' && this._terminalConsent === 'unasked') { await this._terminalConsentFor(); }
			if (this._terminalsAllowed()) { this._terminalHub().receive(frame); } else { this._hub?.dropAll(); }
		}
		if (!response.destroyed) { response.writeHead(200).end(JSON.stringify({ ok: this._terminalsAllowed() })); }
	}

	/** `GET /terminal?after=N`: agent frames after the panel's cursor, held up to the wait header while there are none. */
	private _sendTerminalFrames(request: http.IncomingMessage, response: http.ServerResponse, after: number): void {
		response.setHeader('Content-Type', 'application/json; charset=utf-8');
		const wait = Math.min(chromeChatMaxWaitMs, Math.max(0, Number(request.headers[chromeChatWaitHeader.toLowerCase()]) || 0));
		const answer = () => {
			if (response.destroyed || response.writableEnded) { return; }
			// A cursor ahead of this bridge (a panel from before a reconnect) starts again from what is kept.
			const from = after > this._terminalSequence ? 0 : after;
			response.writeHead(200).end(JSON.stringify({ cursor: this._terminalSequence, frames: this._terminalFrames.filter(f => f.id > from).map(f => f.frame) }));
		};
		if (!wait || this._closed || this._terminalSequence !== after) { answer(); return; }
		const done = () => { clearTimeout(timer); this._terminalWaiters.delete(wake); response.off('close', done); };
		const wake = () => { done(); answer(); };
		const timer = setTimeout(wake, wait);
		this._terminalWaiters.add(wake);
		response.on('close', done);
	}

	private _publishEvent(event: { chatId: string; message?: HostToView; error?: string }): void {
		this._delivery.events.push({ ...event, id: ++this._delivery.sequence });
		this._wake();
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
		this._hub?.dispose(); this._hub = undefined;
		for (const wake of [...this._terminalWaiters]) { wake(); }
		this._body = undefined;
		this._wake();
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
