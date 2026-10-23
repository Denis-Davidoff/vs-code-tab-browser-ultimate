import { surfaceControls } from './core/commands';
import { diffState } from './core/sync';
import { exchangeCipher, encryptedExchangeSocket, type ExchangeCipher } from '../core/exchangeCrypto';
import * as vscode from 'vscode';
import type { BrowserController } from '../browser/browserController';
import type { AttachmentChip, ChatViewState, ExchangeConnectionState, HostToView } from './chatProtocol';
import { exchangeConnection, type ExchangeConnectionInput } from './exchangeConnection';
import type { ChatStateSurface } from './chatSurface';
import { ChatViewProvider, chatViewId } from './chatView';
import { readExchangeUiCommand } from './exchangeUiProtocol';
import { chromeChatSnapshot } from './chromeChatProtocol';
import { exchangeServerUrl, exchangeWebsiteUrl, exchangeSnapshot, readExchangeCommand } from './exchangeProtocol';

type Socket = { readyState: number; bufferedAmount: number; send(data: string): void; close(): void; addEventListener(type: string, listener: (event: any) => void): void };
const WebSocketCtor = (globalThis as any).WebSocket as (new (url: string) => Socket) | undefined;
const secretKey = 'aiBrowser.exchange.key';
/** The relay's `maxPayload`. A command's text is limited in UTF-16 units, so its UTF-8 frame can reach several times that. */
/** A whole snapshot at least this often while patches flow; see `ExchangeChat.sendSnapshot`. */
const fullEveryMs = 2000;
const copy = (value: Record<string, unknown>) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
const maxFrameBytes = 12 * 1024 * 1024;
/** The relay's close code for a refused key, a revoked point or a replaced connection; every other close is transient. */
const agentRefused = 4001;
interface Config { url: string; pointId: string; autoConnect?: boolean; panelId?: string }

/** The id the website's shim answers locally by attaching its streamed page. */
export const exchangePageSuggestionId = 'exchange-active-page';
function exchangePageSuggestion(page: { title: string; url: string } | undefined): AttachmentChip[] {
	if (!page || !/^https?:/i.test(page.url)) { return []; }
	return [{ id: exchangePageSuggestionId, kind: 'page', label: (page.title || page.url).slice(0, 120) }];
}

class ExchangeSurface implements ChatStateSurface {
	onClose?: () => void;
	browserTab?: () => Promise<vscode.BrowserTab>;
	/** The page the website's Browser panel streams, offered as a dashed suggestion. */
	page?: () => { id: string; title: string; url: string } | undefined;
	private last?: ChatViewState;
	/** Rebuild the snapshot from the last state, after the streamed page changed. */
	pageChanged(): void { if (this.last) { this.update(this.last); } }
	private socket?: Socket;
	private stopped = false;
	private ready = false;
	private timer?: ReturnType<typeof setTimeout>;
	private handshake?: ReturnType<typeof setTimeout>;
	private publish?: ReturnType<typeof setTimeout>;
	private body?: string;
	private pinned?: string;
	private chats = new Set<string>();
	private refresh?: () => void;
	private retry = 1000;
	/** Retain accepted command IDs across transport reconnects. Never replay commands automatically. */
	private readonly commands = new Map<string, { input: string; result: Promise<string> }>();
	get chatId(): string | undefined { return this.pinned; }
	get active(): boolean { return this.ready; }
	readonly kind = 'exchange' as const;
	get closed(): boolean { return this.stopped; }
	constructor(private readonly config: Config, private readonly key: string, private readonly source: string, private readonly status: vscode.StatusBarItem, private readonly changed: (phase: ExchangeConnectionState['status'], error?: string) => void, private readonly cipher?: ExchangeCipher) { this.connect(); }
	bind(refresh: () => void): void { this.refresh = refresh; }
	event(message: HostToView): void {
		if (this.stopped || !this.ready || !this.pinned || this.socket?.readyState !== 1) { return; }
		this.socket.send(JSON.stringify({ type: 'chat.event', chatId: this.pinned, message }));
	}
	/**
	 * Patches between whole snapshots, once the relay says it carries them
	 * (`ready.features`). `sent` is the view the website was last given, untrimmed;
	 * a trimmed snapshot (over 5 MB) is never a base, since the website holds
	 * fewer entries than it. A whole snapshot goes at least every
	 * `fullEveryMs`, so a viewer that joined from the relay's cached snapshot, or
	 * missed a patch, converges without asking — and it may ask (`chat.resync`).
	 */
	private patches = false;
	private epoch = '';
	private rev = 0;
	private sent?: { value: Record<string, unknown>; at: number; chatId: string };
	private view?: { value: Record<string, unknown>; trimmed: boolean; chatId: string; running: boolean };
	private forceFull = false;
	/**
	 * A whole snapshot once patches stop: the relay caches whole snapshots only,
	 * so a burst that ended in a patch left a viewer joining later (or a page
	 * from before the relay's upgrade, which drops patches) on the older one —
	 * half a reply, still "Working" — until the next change in the editor.
	 */
	private trailing?: ReturnType<typeof setTimeout>;
	update(state: ChatViewState): void {
		this.pinned = state.chatId; this.last = state;
		this.chats = new Set([state.chatId,...state.tabs.map(tab => tab.chatId)]);
		const full = chromeChatSnapshot(state);
		const view = {...full.view,surface:'exchange' as const,controls:surfaceControls('exchange'),voice:{...full.view.voice,available:false,reason:'Microphone recording is available in VS Code.'},suggestions:exchangePageSuggestion(this.page?.())};
		let body = JSON.stringify({...JSON.parse(exchangeSnapshot(state)),uiVersion:1,view});
		while (Buffer.byteLength(body)>5_000_000 && view.entries.length>1) { view.entries = view.entries.slice(Math.max(1,Math.floor(view.entries.length/4))); body = JSON.stringify({...JSON.parse(exchangeSnapshot(state)),uiVersion:1,view}); }
		this.body = body;
		this.view = { value: view as unknown as Record<string, unknown>, trimmed: view.entries.length !== full.view.entries.length, chatId: state.chatId, running: state.running };
		if (!this.publish) { this.publish = setTimeout(() => { this.publish = undefined; this.sendSnapshot(); }, 16); }
	}
	private sendSnapshot(): void {
		if (this.ready && this.body && this.socket?.readyState === 1) {
			if (this.socket.bufferedAmount > maxFrameBytes * 2) { this.socket.close(); return; }
			const view = this.view;
			if (this.patches && view) {
				const sent = this.sent;
				const now = Date.now();
				if (!this.forceFull && sent && !view.trimmed && sent.chatId === view.chatId && now - sent.at < fullEveryMs) {
					const patch = diffState(sent.value, view.value, this.rev, this.rev + 1);
					if (!patch) { return; }
					const frame = JSON.stringify({ type: 'chat.patch', chatId: view.chatId, epoch: this.epoch, base: this.rev, rev: this.rev + 1, patch, top: { chatId: view.chatId, running: view.running, uiVersion: 1 } });
					if (Buffer.byteLength(frame) * 2 < Buffer.byteLength(this.body)) {
						this.rev++; this.sent = { value: copy(view.value), at: sent.at, chatId: view.chatId };
						this.socket.send(frame);
						clearTimeout(this.trailing);
						this.trailing = setTimeout(() => { this.trailing = undefined; this.forceFull = true; this.sendSnapshot(); }, fullEveryMs);
						return;
					}
				}
				this.forceFull = false;
				clearTimeout(this.trailing); this.trailing = undefined;
				this.rev++;
				this.socket.send(JSON.stringify({ ...JSON.parse(this.body), epoch: this.epoch, rev: this.rev }));
				this.sent = view.trimmed ? undefined : { value: copy(view.value), at: now, chatId: view.chatId };
				return;
			}
			this.socket.send(this.body);
		}
	}
	private connect(): void {
		if (this.stopped || !WebSocketCtor) { return; }
		this.status.text = '$(sync~spin) AI Browser Server';
		this.changed('connecting');
		const socket = this.socket = encryptedExchangeSocket(this.config.url + '/ws/agent',this.cipher,true,()=>{ this.forceFull = true; this.sendSnapshot(); },WebSocketCtor as unknown as typeof WebSocket);
		this.handshake = setTimeout(() => socket.close(), 10000);
		socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'auth', version: 1, pointId: this.config.pointId, key: this.key, encryption: this.cipher?.descriptor ?? null })));
		socket.addEventListener('message', event => {
			if (socket !== this.socket || this.stopped) { return; }
			void this.receive(socket, event.data).catch(() => socket.close());
		});
		socket.addEventListener('error', () => socket.close());
		socket.addEventListener('close', event => {
			if (socket !== this.socket) { return; }
			clearTimeout(this.handshake); this.ready = false; this.refresh?.();
			if (this.stopped) { return; }
			if (event.code === agentRefused) {
				this.close();
				this.changed('error', 'Connection refused. Check the connection ID and key, or disconnect another client using this connection.');
				return;
			}
			this.status.text = '$(debug-disconnect) AI Browser Server: reconnecting';
			this.changed('reconnecting', `Cannot keep the connection to ${this.config.url}. Check that this address forwards WebSocket connections. Retrying automatically…`);
			this.timer = setTimeout(() => this.connect(), this.retry);
			this.retry = Math.min(this.retry * 2, 30000);
		});
	}
	private async receive(socket: Socket, raw: unknown): Promise<void> {
		if (typeof raw !== 'string' || Buffer.byteLength(raw) > maxFrameBytes) { throw new Error('Invalid message'); }
		const value = JSON.parse(raw);
		if (value.type === 'ready') {
			if (value.version !== 1) { throw new Error('Unsupported protocol'); }
			clearTimeout(this.handshake); this.ready = true; this.retry = 1000;
			this.patches = Array.isArray(value.features) && value.features.includes('patch');
			this.epoch = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16); this.rev = 0; this.sent = undefined; this.forceFull = true;
			this.status.text = '$(radio-tower) AI Browser Server: connected';
			this.changed('connected');
			this.refresh?.(); this.sendSnapshot(); return;
		}
		if (!this.ready) { throw new Error('Handshake required'); }
		if (value.type === 'chat.resync' && typeof value.id === 'string') {
			this.forceFull = true; this.sendSnapshot();
			socket.send(JSON.stringify({ type: 'command.result', id: value.id, ok: true })); return;
		}
		const command = value.type === 'chat.command' ? readExchangeUiCommand(value) : value.type === 'chat.pin' && typeof value.id === 'string' && typeof value.chatId === 'string' ? {type:'chat.pin' as const,id:value.id,chatId:value.chatId} : readExchangeCommand(value);
		if (!command) { throw new Error('Invalid remote command'); }
		let accepted = this.commands.get(command.id);
		if (accepted && accepted.input !== raw) { throw new Error('Command ID reused'); }
		if (!accepted) {
			const result = (async () => {
				try {
					if (!this.chats.has(command.chatId)) { throw new Error('This conversation is no longer open.'); }
					if (command.type === 'chat.pin') { this.pinned = command.chatId; this.refresh?.(); }
					else if (command.type === 'chat.command') {
						const needsBrowser=['attach','openLink'].includes(command.message.type);
						const browserTab=needsBrowser?await this.browserTab?.():undefined;
						if(needsBrowser&&!browserTab)throw new Error('Select a tab in the website Browser panel first.');
						await ChatViewProvider.commandExchangeSource(this.source,command.chatId,command.message,command.attachments,(message:HostToView,targetChatId = command.chatId) => {
							if (this.stopped) { return; }
							if (targetChatId !== command.chatId && this.pinned === command.chatId) { this.pinned = targetChatId; this.refresh?.(); }
							if (this.socket?.readyState === 1) { this.socket.send(JSON.stringify({type:'chat.event',chatId:targetChatId,message})); }
						},browserTab);
					} else { await ChatViewProvider.commandChromeSource(this.source, command.chatId, command.type === 'chat.send' ? { type: 'send', text: command.text! } : { type: 'stop' }); }
					return JSON.stringify({ type: 'command.result', id: command.id, ok: true });
				} catch (error) {
					return JSON.stringify({ type: 'command.result', id: command.id, ok: false, error: (error instanceof Error ? error.message : 'Command failed').slice(0, 1000) });
				}
			})();
			accepted = { input: raw, result }; this.commands.set(command.id, accepted);
			if (this.commands.size > 256) { this.commands.delete(this.commands.keys().next().value!); }
		}
		const result = await accepted.result;
		if (socket.readyState === 1 && this.ready && !this.stopped) { socket.send(result); }
	}
	close(): void {
		if (this.stopped) { return; }
		this.stopped = true; this.ready = false; clearTimeout(this.trailing);
		ChatViewProvider.releaseExchangeSource?.(this.source);
		this.onClose?.();
		clearTimeout(this.timer); clearTimeout(this.handshake); clearTimeout(this.publish);
		this.socket?.close(); this.status.hide(); this.changed('disconnected');
	}
}

async function verifyExchangeServer(socketOrigin: string): Promise<void> {
	const address = new URL(socketOrigin);
	address.protocol = address.protocol === 'wss:' ? 'https:' : 'http:';
	const healthUrl = new URL('/api/health', address);
	let response: Awaited<ReturnType<typeof fetch>>;
	try { response = await fetch(healthUrl, { signal: AbortSignal.timeout(5000), redirect: 'error' }); }
	catch { throw new Error(`Cannot reach AI Browser Server at ${address.origin}. Copy the server address from your website's connection details.`); }
	if (!response.ok) { throw new Error(`AI Browser Server returned HTTP ${response.status}. Check the server address and port.`); }
	let health: { status?: string; protocolVersion?: number };
	try { health = await response.json() as typeof health; }
	catch { throw new Error('This address does not provide the AI Browser Server API. Copy the server address from your connection details.'); }
	if (health?.status !== 'ok' || health.protocolVersion !== 1) { throw new Error('This server does not support the AI Browser connection protocol.'); }
}

export function registerExchangeChat(context: vscode.ExtensionContext, browser?: BrowserController): void {
	let connection: vscode.Disposable | undefined;
	let connecting = false;
	let generation = 0;
	let disposed = false;
	let savedConfig: Config | undefined;
	let restoreTimer: ReturnType<typeof setTimeout> | undefined;
	let restoreDelay = 1000;
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 40);
	status.command = 'aiBrowser.chat.disconnectExchange';
	status.tooltip = 'Disconnect this chat from AI Browser Server';
	const initialized = (async () => {
		const saved = context.workspaceState.get<Config>('aiBrowser.exchange.connection');
		if (saved && typeof saved.url === 'string' && typeof saved.pointId === 'string') {
			const hasKey = !!await context.secrets.get(secretKey + '.' + saved.pointId);
			const hasPassword = !!await context.secrets.get(secretKey + '.password.' + saved.pointId);
			savedConfig = { ...saved, url: exchangeWebsiteUrl(saved.url) };
			exchangeConnection.update({ url: savedConfig.url, pointId: saved.pointId, hasKey, hasPassword });
		}
	})().catch(() => exchangeConnection.update({ error: 'Could not read the saved connection key. Enter it again to connect.' }));
	const shutdown = () => {
		disposed = true;
		clearTimeout(restoreTimer);
		generation++;
		connection?.dispose(); connection = undefined; status.hide();
	};
	const disconnect = () => {
		clearTimeout(restoreTimer);
		generation++;
		connection?.dispose(); connection = undefined; status.hide();
		if (savedConfig) {
			savedConfig = { ...savedConfig, autoConnect: false };
			void context.workspaceState.update('aiBrowser.exchange.connection', savedConfig).then(undefined, () => exchangeConnection.update({ error: 'Could not save the disconnected state.' }));
		}
		exchangeConnection.update({ status: 'disconnected', error: undefined });
	};
	function shouldRestore(): boolean { return !disposed && !!savedConfig && savedConfig.autoConnect !== false; }
	function scheduleRestore(delay = restoreDelay): void {
		clearTimeout(restoreTimer);
		if (disposed || !savedConfig || savedConfig.autoConnect === false) { return; }
		restoreTimer = setTimeout(() => void restore(), delay);
	}
	async function restore(): Promise<void> {
		if (disposed || connection || connecting || !savedConfig || savedConfig.autoConnect === false) { return; }
		if (!vscode.workspace.isTrusted || !exchangeConnection.state.hasKey) { return; }
		const source = ChatViewProvider.chromeSources().find(item => (item.panelId ?? 'sidebar') === (savedConfig!.panelId ?? 'sidebar'));
		if (!source) { scheduleRestore(1000); return; }
		try { await connect(savedConfig, source.id); restoreDelay = 1000; }
		catch (error) {
			if (!shouldRestore()) { return; }
			exchangeConnection.update({ status: 'reconnecting', error: `${error instanceof Error ? error.message : 'Could not restore the connection.'} Retrying automatically…` });
			restoreDelay = Math.min(restoreDelay * 2, 30000); scheduleRestore();
		}
	}
	async function connect(input: ExchangeConnectionInput, source: string): Promise<void> {
		if (connecting) { throw new Error('A connection is already being configured.'); }
		clearTimeout(restoreTimer);
		const current = ++generation;
		connecting = true;
		try {
			await initialized;
			if (!vscode.workspace.isTrusted) { throw new Error('Trust this workspace before enabling remote chat control.'); }
			if (!WebSocketCtor) { throw new Error('Server connections require a VS Code extension host with Node.js 22 or newer.'); }
			if (typeof input.url !== 'string' || typeof input.pointId !== 'string' || (input.key !== undefined && typeof input.key !== 'string')) { throw new Error('Invalid connection settings.'); }
			const url = exchangeServerUrl(input.url.trim());
			const pointId = input.pointId.trim();
			if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pointId)) { throw new Error('Paste a valid connection ID from your AI Browser dashboard.'); }
			const previous = context.workspaceState.get<Config>('aiBrowser.exchange.connection');
			const supplied = input.key?.trim();
			const key = supplied || (previous && exchangeServerUrl(previous.url) === url && previous.pointId === pointId ? await context.secrets.get(secretKey + '.' + pointId) : undefined);
			if (!key || !/^exch_[A-Za-z0-9_-]{43}$/.test(key)) { throw new Error('Paste the connection key from your AI Browser dashboard.'); }
			if (!ChatViewProvider.chromeSources().some(item => item.id === source)) { throw new Error('Open the chat you want to share and try again.'); }
			if (current !== generation) { return; }
			await verifyExchangeServer(url);
			if (current !== generation) { return; }
			await context.secrets.store(secretKey + '.' + pointId, key);
			if (input.password !== undefined && typeof input.password !== 'string') { throw new Error('Invalid workspace password.'); }
			const passwordId = secretKey + '.password.' + pointId;
			const password = input.password ?? (previous && exchangeServerUrl(previous.url) === url && previous.pointId === pointId ? await context.secrets.get(passwordId) : undefined);
			if (password && password.length < 12) { throw new Error('Use at least 12 characters for the workspace password.'); }
			const cipher = password ? await exchangeCipher(password, pointId) : undefined;
			if (current !== generation || disposed) { return; }
			if (password) { await context.secrets.store(passwordId, password); } else { await context.secrets.delete(passwordId); }
			if (current !== generation || disposed) { return; }
			savedConfig = { url: exchangeWebsiteUrl(url), pointId, autoConnect: true, panelId: ChatViewProvider.chromeSources().find(item => item.id === source)?.panelId ?? 'sidebar' };
			await context.workspaceState.update('aiBrowser.exchange.connection', savedConfig);
			if (current !== generation) { return; }
			connection?.dispose();
			exchangeConnection.update({ url: savedConfig.url, pointId, hasKey: true, hasPassword: !!password, status: 'connecting', error: undefined });
			const surface = new ExchangeSurface({ url, pointId }, key, source, status, (phase, error) => {
				if (current === generation) {
					exchangeConnection.update({ status: phase, error });
					if (phase === 'error' && savedConfig) {
						savedConfig = { ...savedConfig, autoConnect: false };
						clearTimeout(restoreTimer);
						void context.workspaceState.update('aiBrowser.exchange.connection', savedConfig).then(undefined, () => {});
					}
				}
			}, cipher);
			try {
				const chat = ChatViewProvider.observeChromeSource(source, surface);
				let media: {dispose():void} | undefined;
				surface.onClose=()=>{media?.dispose();if(current===generation&&!disposed){connection=undefined;scheduleRestore();}};
				if(browser){const {ExchangeBrowser}=await import('../browser/exchangeBrowser');if(!surface.closed&&current===generation){const remote=new ExchangeBrowser(url,pointId,key,browser,cipher);media=remote;surface.browserTab=()=>remote.selectedTab();surface.page=()=>remote.selectedPage();remote.onPage=()=>surface.pageChanged();}}
				if(current!==generation){media?.dispose();chat.dispose();return;}
				connection={dispose(){media?.dispose();chat.dispose();}}; status.show();
			}
			catch (error) { surface.close(); throw error; }
		} finally { connecting = false; }
	}
	context.subscriptions.push(status, { dispose: shutdown }, exchangeConnection.bind({ connect, disconnect }));
	void initialized.then(() => scheduleRestore(0));
	context.subscriptions.push(vscode.commands.registerCommand('aiBrowser.chat.connectExchange', async () => {
		try {
			await initialized;
			await vscode.commands.executeCommand(`${chatViewId}.focus`);
			const sources = ChatViewProvider.chromeSources();
			const source = sources.length === 1 ? sources[0] : await vscode.window.showQuickPick(sources, { title: 'Choose the chat to share with AI Browser Server' });
			if (!source) { return; }
			const address = await vscode.window.showInputBox({ title: 'AI Browser server address', value: exchangeConnection.state.url, ignoreFocusOut: true });
			if (address === undefined) { return; }
			const pointId = await vscode.window.showInputBox({ title: 'Connection ID', value: exchangeConnection.state.pointId, ignoreFocusOut: true });
			if (!pointId) { return; }
			const key = await vscode.window.showInputBox({ title: 'Connection key', password: true, placeHolder: exchangeConnection.state.hasKey ? 'Leave blank to use the saved key for the same server and connection.' : 'Paste your connection key', ignoreFocusOut: true });
			if (key === undefined) { return; }
			await connect({ url: address, pointId, key }, source.id);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Could not connect to AI Browser Server.';
			exchangeConnection.update({ error: message });
			void vscode.window.showErrorMessage(message);
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('aiBrowser.chat.disconnectExchange', disconnect));
}
