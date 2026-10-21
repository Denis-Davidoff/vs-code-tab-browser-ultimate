/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Google Chrome driven over its own DevTools WebSocket, with no extension.
 *
 * Every Chrome tab is presented as a {@link vscode.BrowserTab}, so the tools
 * written against the built-in browser run unchanged. Each CDP session is a
 * WebSocket of its own to the browser endpoint, scoped to one tab: its
 * `Target.getTargets` lists that tab's page and the frames inside it only,
 * which is exactly what the built-in browser's per-tab channel answers.
 *
 * Which Chrome: the user's own, when remote debugging is switched on at
 * `chrome://inspect/#remote-debugging` (Chrome writes `DevToolsActivePort`
 * into its profile); otherwise a Chrome of our own with a separate profile
 * under `~/.ai-browser/chrome-profile`, since Chrome 136+ refuses
 * `--remote-debugging-port` on the default profile.
 */

interface TargetInfo {
	readonly targetId: string;
	readonly type: string;
	readonly url: string;
	readonly title: string;
	readonly openerId?: string;
	readonly parentFrameId?: string;
}

type Socket = {
	send(data: string): void;
	close(): void;
	readyState: number;
	addEventListener(type: string, listener: (event: any) => void): void;
};

const WebSocketCtor = (globalThis as any).WebSocket as (new (url: string) => Socket) | undefined;

function openSocket(url: string, timeoutMs = 5000): Promise<Socket> {
	if (!WebSocketCtor) {
		return Promise.reject(new Error('This VS Code has no WebSocket in its extension host (needs Node 22+).'));
	}
	return new Promise((resolve, reject) => {
		const socket = new WebSocketCtor(url);
		const timer = setTimeout(() => { socket.close(); reject(new Error('Chrome did not answer.')); }, timeoutMs);
		socket.addEventListener('open', () => { clearTimeout(timer); resolve(socket); });
		socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Could not connect to Chrome.')); });
	});
}

/** A browser-level CDP connection with request/response correlation. */
class Connection {
	private _nextId = 1;
	private readonly _pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	private readonly _events = new vscode.EventEmitter<any>();
	private readonly _closed = new vscode.EventEmitter<void>();
	public readonly onEvent = this._events.event;
	public readonly onClose = this._closed.event;
	public closed = false;

	constructor(public readonly socket: Socket) {
		socket.addEventListener('message', event => {
			let message: any;
			try { message = JSON.parse(String(event.data)); } catch { return; }
			if (typeof message?.id === 'number' && this._pending.has(message.id)) {
				const pending = this._pending.get(message.id)!;
				this._pending.delete(message.id);
				if (message.error) { pending.reject(new Error(message.error.message)); } else { pending.resolve(message.result ?? {}); }
				return;
			}
			this._events.fire(message);
		});
		socket.addEventListener('close', () => this._end());
		socket.addEventListener('error', () => this._end());
	}

	private _end(): void {
		if (this.closed) { return; }
		this.closed = true;
		for (const { reject } of this._pending.values()) { reject(new Error('Chrome closed the connection.')); }
		this._pending.clear();
		this._closed.fire();
		this._events.dispose();
		this._closed.dispose();
	}

	public send(method: string, params?: object): Promise<any> {
		if (this.closed) { return Promise.reject(new Error('Chrome closed the connection.')); }
		const id = this._nextId++;
		return new Promise((resolve, reject) => {
			this._pending.set(id, { resolve, reject });
			this.socket.send(JSON.stringify({ id, method, params: params ?? {} }));
		});
	}

	public close(): void {
		try { this.socket.close(); } catch { /* already gone */ }
		this._end();
	}
}

/** Ids of our own questions on a session's socket, far from `CDPClient`'s counter. */
let privateId = 2_000_000_000;

/**
 * One CDP session on one Chrome tab, in the shape of `vscode.BrowserCDPSession`.
 *
 * Its socket reaches the whole browser, so it answers for one tab by hand:
 * `Target.getTargets` lists this tab's page and **only the frames inside it**,
 * and `Target.attachToTarget` refuses anything else. A frame target from
 * another process is this tab's when its `parentFrameId` is a frame of this
 * tab — the page's own tree, or the tree of a frame already admitted — so the
 * set is grown until it stops changing. Listing every `iframe` in the browser
 * handed an assistant the payment and sign-in widgets of the user's other
 * tabs, whatever tab it had been given.
 */
class ChromeCDPSession implements vscode.BrowserCDPSession {
	private readonly _message = new vscode.EventEmitter<unknown>();
	private readonly _close = new vscode.EventEmitter<void>();
	public readonly onDidReceiveMessage = this._message.event;
	public readonly onDidClose = this._close.event;
	private _gone = false;
	/** Attach requests on their way, by id, with the target each names. */
	private readonly _attaching = new Map<number, string>();
	/** The CDP session of each target attached through this socket. */
	private readonly _sessions = new Map<string, string>();
	private readonly _asked = new Map<number, (reply: any) => void>();

	constructor(private readonly _socket: Socket, private readonly _tab: ChromeTab, private readonly _browser: ChromeBrowser) {
		_socket.addEventListener('message', event => {
			let message: any;
			try { message = JSON.parse(String(event.data)); } catch { return; }
			if (typeof message?.id === 'number') {
				const asked = this._asked.get(message.id);
				if (asked) {
					this._asked.delete(message.id);
					asked(message);
					return;
				}
				const target = this._attaching.get(message.id);
				if (target !== undefined) {
					this._attaching.delete(message.id);
					const sessionId = message.result?.sessionId;
					if (typeof sessionId === 'string') { this._sessions.set(target, sessionId); }
				}
			}
			if (message?.method === 'Target.detachedFromTarget') {
				for (const [target, sessionId] of this._sessions) {
					if (sessionId === message.params?.sessionId) { this._sessions.delete(target); }
				}
			}
			this._message.fire(message);
		});
		_socket.addEventListener('close', () => this._end());
		_socket.addEventListener('error', () => this._end());
	}

	private _end(): void {
		if (this._gone) { return; }
		this._gone = true;
		for (const asked of this._asked.values()) { asked({ error: { message: 'closed' } }); }
		this._asked.clear();
		this._close.fire();
		this._message.dispose();
		this._close.dispose();
	}

	/** A question of our own on this socket, bounded; its reply is never passed on. */
	private _ask(method: string, params: object, sessionId: string): Promise<any> {
		if (this._gone) { return Promise.resolve(undefined); }
		const id = privateId++;
		return new Promise(resolve => {
			const timer = setTimeout(() => { this._asked.delete(id); resolve(undefined); }, 3000);
			this._asked.set(id, reply => { clearTimeout(timer); resolve(reply?.result); });
			this._socket.send(JSON.stringify({ id, method, params, sessionId }));
		});
	}

	/** Every frame id of the tree a session shows. */
	private async _treeOf(sessionId: string | undefined): Promise<string[]> {
		if (!sessionId) { return []; }
		const result = await this._ask('Page.getFrameTree', {}, sessionId);
		const ids: string[] = [];
		const walk = (node: any) => {
			if (typeof node?.frame?.id === 'string') { ids.push(node.frame.id); }
			for (const child of node?.childFrames ?? []) { walk(child); }
		};
		walk(result?.frameTree);
		return ids;
	}

	/** This tab's page target and the frame targets inside it. */
	private async _ownTargets(): Promise<TargetInfo[]> {
		const infos = await this._browser.targets();
		const page = infos.find(t => t.targetId === this._tab.targetId);
		if (!page) { return []; }
		// A page target's id is its main frame's id.
		const frames = new Set<string>([page.targetId, ...await this._treeOf(this._sessions.get(page.targetId))]);
		const admitted = new Map<string, TargetInfo>();
		for (let grew = true; grew;) {
			grew = false;
			for (const info of infos) {
				if (info.type !== 'iframe' || admitted.has(info.targetId)) { continue; }
				if (!info.parentFrameId || !frames.has(info.parentFrameId)) { continue; }
				admitted.set(info.targetId, info);
				frames.add(info.targetId);
				for (const id of await this._treeOf(this._sessions.get(info.targetId))) { frames.add(id); }
				grew = true;
			}
		}
		return [page, ...admitted.values()];
	}

	public async sendMessage(raw: unknown): Promise<void> {
		if (this._gone) { throw new Error('CDP session closed'); }
		const message = raw as { id: number; method: string; params?: any; sessionId?: string };
		// The browser-level channel sees every tab; this session answers for one.
		if (message.method === 'Target.getTargets' && !message.sessionId) {
			try {
				this._message.fire({ id: message.id, result: { targetInfos: await this._ownTargets() } });
			} catch (error) {
				this._message.fire({ id: message.id, error: { code: -32000, message: (error as Error).message } });
			}
			return;
		}
		if (message.method === 'Target.attachToTarget' && !message.sessionId) {
			const id = message.params?.targetId;
			const own = await this._ownTargets().catch(() => []);
			if (typeof id !== 'string' || !own.some(t => t.targetId === id)) {
				this._message.fire({ id: message.id, error: { code: -32000, message: 'No such target in this tab' } });
				return;
			}
			this._attaching.set(message.id, id);
		}
		// Discovery and auto-attach would report every target in the browser.
		if ((message.method === 'Target.setDiscoverTargets' || message.method === 'Target.setAutoAttach') && !message.sessionId) {
			this._message.fire({ id: message.id, error: { code: -32000, message: 'Not available on a Chrome tab session' } });
			return;
		}
		this._socket.send(JSON.stringify(message));
	}

	public async close(): Promise<void> {
		try { this._socket.close(); } catch { /* already gone */ }
		this._end();
	}
}

export class ChromeTab implements vscode.BrowserTab {
	public url: string;
	public title: string;
	public readonly icon = new vscode.ThemeIcon('globe');
	/** So a heading or a status line can say which browser the page is in. */
	public readonly browserName = 'Chrome';

	constructor(public readonly targetId: string, info: TargetInfo, private readonly _browser: ChromeBrowser) {
		this.url = info.url;
		this.title = info.title;
	}

	/** Mirrors the built-in browser's composition, `<title> (<url>)`. */
	public update(info: TargetInfo): boolean {
		if (info.url === this.url && info.title === this.title) { return false; }
		this.url = info.url;
		this.title = info.title;
		return true;
	}

	public async startCDPSession(): Promise<vscode.BrowserCDPSession> {
		const socket = await openSocket(this._browser.endpoint());
		return new ChromeCDPSession(socket, this, this._browser);
	}

	public async close(): Promise<void> {
		await this._browser.closeTab(this);
	}
}

/** Where a Chrome profile says its DevTools endpoint is. */
function readActivePort(profileDir: string): string | undefined {
	try {
		const [port, wsPath] = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/);
		if (!/^\d+$/.test(port) || !wsPath?.startsWith('/devtools/browser/')) { return undefined; }
		return `ws://127.0.0.1:${port}${wsPath}`;
	} catch {
		return undefined;
	}
}

function defaultProfileDirs(): string[] {
	const home = os.homedir();
	switch (process.platform) {
		case 'darwin': return [path.join(home, 'Library/Application Support/Google/Chrome')];
		case 'win32': return [path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData/Local'), 'Google/Chrome/User Data')];
		default: return [path.join(home, '.config/google-chrome'), path.join(home, '.config/chromium')];
	}
}

function chromeExecutable(): string | undefined {
	const candidates = process.platform === 'darwin'
		? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]
		: process.platform === 'win32'
			? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
				.filter((d): d is string => !!d).map(d => path.join(d, 'Google/Chrome/Application/chrome.exe'))
			: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
	return candidates.find(file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } });
}

/** No Chrome where we look for one, and none running with remote debugging on. */
export class ChromeNotInstalledError extends Error {
	constructor() { super('Google Chrome is not installed.'); }
}

/** Where to get it; the official page picks the build for the platform. */
export const chromeDownloadUrl = 'https://www.google.com/chrome/';

const ownProfileDir = path.join(os.homedir(), '.ai-browser', 'chrome-profile');

/** Whether a live Chrome holds this profile (its `SingletonLock` names a running pid). */
function profileInUse(dir: string): boolean {
	try {
		const target = fs.readlinkSync(path.join(dir, 'SingletonLock'));
		const pid = Number(target.slice(target.lastIndexOf('-') + 1));
		if (!Number.isInteger(pid) || pid <= 0) { return false; }
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

export class ChromeBrowser implements vscode.Disposable {
	private _control: Connection | undefined;
	private _connecting: Promise<Connection> | undefined;
	private _endpoint = '';
	private readonly _tabs = new Map<string, ChromeTab>();
	private _active: ChromeTab | undefined;

	private readonly _onOpen = new vscode.EventEmitter<ChromeTab>();
	private readonly _onClose = new vscode.EventEmitter<ChromeTab>();
	private readonly _onActive = new vscode.EventEmitter<ChromeTab | undefined>();
	private readonly _onState = new vscode.EventEmitter<ChromeTab>();
	public readonly onDidOpenTab = this._onOpen.event;
	public readonly onDidCloseTab = this._onClose.event;
	public readonly onDidChangeActiveTab = this._onActive.event;
	public readonly onDidChangeTabState = this._onState.event;

	public get connected(): boolean { return !!this._control && !this._control.closed; }
	public get tabs(): readonly ChromeTab[] { return [...this._tabs.values()]; }
	/** The Chrome tab last opened or used through us; Chrome reports no focus. */
	public get activeTab(): ChromeTab | undefined { return this._active && this._tabs.has(this._active.targetId) ? this._active : undefined; }
	public endpoint(): string { return this._endpoint; }

	public async targets(): Promise<TargetInfo[]> {
		const control = await this.connect();
		const { targetInfos } = await control.send('Target.getTargets');
		return targetInfos as TargetInfo[];
	}

	/** Connects to a running Chrome, or starts one with a profile of our own. */
	public connect(): Promise<Connection> {
		if (this._control && !this._control.closed) { return Promise.resolve(this._control); }
		this._connecting ??= this._connect().finally(() => { this._connecting = undefined; });
		return this._connecting;
	}

	private async _connect(): Promise<Connection> {
		for (const dir of [...defaultProfileDirs(), ownProfileDir]) {
			const url = readActivePort(dir);
			if (!url) { continue; }
			const socket = await openSocket(url, 3000).catch(() => undefined)
				?? (dir === ownProfileDir ? await openSocket(url, 8000).catch(() => undefined) : undefined);
			if (socket) { return this._adopt(socket, url); }
		}
		// A Chrome still holding our profile would take a second launch's
		// arguments and exit, and its port file would never come back.
		if (profileInUse(ownProfileDir)) {
			throw new Error('Google Chrome started by AI Browser is running but not answering. Quit it and try again.');
		}
		const exe = chromeExecutable();
		if (!exe) {
			throw new ChromeNotInstalledError();
		}
		fs.mkdirSync(ownProfileDir, { recursive: true, mode: 0o700 });
		try { fs.unlinkSync(path.join(ownProfileDir, 'DevToolsActivePort')); } catch { /* none yet */ }
		const child = cp.spawn(exe, [
			`--user-data-dir=${ownProfileDir}`,
			'--remote-debugging-port=0',
			'--no-first-run',
			'--no-default-browser-check',
		], { detached: true, stdio: 'ignore' });
		child.unref();
		for (let i = 0; i < 100; i++) {
			await new Promise(r => setTimeout(r, 150));
			const url = readActivePort(ownProfileDir);
			if (!url) { continue; }
			const socket = await openSocket(url, 3000).catch(() => undefined);
			if (socket) { return this._adopt(socket, url); }
		}
		throw new Error('Chrome started but did not open its DevTools endpoint.');
	}

	private async _adopt(socket: Socket, url: string): Promise<Connection> {
		const control = new Connection(socket);
		this._endpoint = url;
		this._control = control;
		control.onEvent(message => this._event(message));
		control.onClose(() => {
			if (this._control !== control) { return; }
			this._control = undefined;
			for (const tab of [...this._tabs.values()]) { this._drop(tab.targetId); }
		});
		await control.send('Target.setDiscoverTargets', { discover: true });
		const { targetInfos } = await control.send('Target.getTargets');
		for (const info of targetInfos as TargetInfo[]) { this._add(info); }
		return control;
	}

	private _isTab(info: TargetInfo): boolean {
		return info.type === 'page' && !info.url.startsWith('devtools://') && !info.url.startsWith('chrome-extension://');
	}

	private _add(info: TargetInfo): ChromeTab | undefined {
		if (!this._isTab(info) || this._tabs.has(info.targetId)) { return undefined; }
		const tab = new ChromeTab(info.targetId, info, this);
		this._tabs.set(info.targetId, tab);
		this._onOpen.fire(tab);
		return tab;
	}

	private _drop(targetId: string): void {
		const tab = this._tabs.get(targetId);
		if (!tab) { return; }
		this._tabs.delete(targetId);
		this._onClose.fire(tab);
		if (this._active === tab) {
			this._active = undefined;
			this._onActive.fire(undefined);
		}
	}

	private _event(message: any): void {
		const info = message?.params?.targetInfo as TargetInfo | undefined;
		switch (message?.method) {
			case 'Target.targetCreated':
				if (info) { this._add(info); }
				return;
			case 'Target.targetInfoChanged': {
				if (!info) { return; }
				const tab = this._tabs.get(info.targetId);
				if (tab) { if (tab.update(info)) { this._onState.fire(tab); } } else { this._add(info); }
				return;
			}
			case 'Target.targetDestroyed':
				this._drop(message.params?.targetId);
				return;
		}
	}

	/** Opens a page in Chrome, brings the window forward, and makes it ours. */
	public async openTab(url: string): Promise<ChromeTab> {
		const control = await this.connect();
		const { targetId } = await control.send('Target.createTarget', { url: url || 'about:blank' });
		let tab = this._tabs.get(targetId);
		if (!tab) {
			const infos = await this.targets();
			const info = infos.find(t => t.targetId === targetId) ?? { targetId, type: 'page', url, title: url };
			tab = this._add(info) ?? new ChromeTab(targetId, info, this);
			this._tabs.set(targetId, tab);
		}
		await control.send('Target.activateTarget', { targetId }).catch(() => undefined);
		this.markActive(tab);
		return tab;
	}

	public markActive(tab: ChromeTab): void {
		if (this._active === tab) { return; }
		this._active = tab;
		this._onActive.fire(tab);
	}

	public async closeTab(tab: ChromeTab): Promise<void> {
		if (!this.connected) {
			this._drop(tab.targetId);
			return;
		}
		const control = await this.connect();
		await control.send('Target.closeTarget', { targetId: tab.targetId });
	}

	public dispose(): void {
		this._control?.close();
		this._onOpen.dispose();
		this._onClose.dispose();
		this._onActive.dispose();
		this._onState.dispose();
	}
}

export const chrome = new ChromeBrowser();
