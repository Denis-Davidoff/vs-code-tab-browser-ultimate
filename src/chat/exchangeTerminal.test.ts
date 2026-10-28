// End to end through ExchangeSurface: an encrypted agent socket, a fake relay, and a viewer socket
// built with the website's own `encryptedExchangeSocket`. The terminal is a fake `RemoteTerminalTarget`.
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { dirname, relative, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { setTimeout as delay } from 'node:timers/promises';

class FakeSocket {
	readyState = 1;
	bufferedAmount = 0;
	readonly sent: string[] = [];
	readonly events = new Map<string, ((event: any) => void)[]>();
	onSend?: (data: string) => void;
	readonly url: string;
	constructor(url: string) { this.url = url; FakeSocket.made.push(this); }
	static made: FakeSocket[] = [];
	send(data: string) { this.sent.push(data); this.onSend?.(data); }
	close() { if (this.readyState === 3) { return; } this.readyState = 3; this.emit('close', { code: 1000 }); }
	addEventListener(name: string, listener: (event: any) => void) { this.events.set(name, [...(this.events.get(name) ?? []), listener]); }
	emit(name: string, event: any = {}) { for (const listener of this.events.get(name) ?? []) { listener(event); } }
}

function fakeTerminal() {
	const sinks = new Map<string, { data(chunk: string, seq: number): void; exit(code?: number): void }>();
	const inputs: string[] = [];
	const resizes: [number, number][] = [];
	const control: boolean[] = [];
	let seq = 0;
	return {
		inputs, resizes, control, sinks,
		target: {
			id: 'term-1', remote: true, running: true, status: 'running' as const, exitCode: undefined, size: { cols: 80, rows: 24 },
			addConsumer(key: string, sink: any) { sinks.set(key, sink); return { data: 'hello $ ', seq }; },
			removeConsumer(key: string) { sinks.delete(key); },
			creditConsumer() {}, outstanding: () => 0,
			remoteInput(data: string) { inputs.push(data); },
			remoteResize(cols: number, rows: number) { resizes.push([cols, rows]); },
			onEditorInput: () => () => {},
			setRemoteControl(held: boolean) { control.push(held); },
		},
		output(chunk: string) { seq += chunk.length; for (const sink of sinks.values()) { sink.data(chunk, seq); } },
	};
}

test('a website viewer attaches, watches, takes control and types through an encrypted connection; the setting switched off stops everything', async () => {
	FakeSocket.made = [];
	let setting = true;
	let consentDetail = '';
	let consentAsked = 0;
	const terminal = fakeTerminal();
	const vscode = {
		env: { machineId: 'test-workstation' },
		workspace: { isTrusted: true }, StatusBarAlignment: { Right: 1 },
		window: {
			createStatusBarItem: () => ({ text: '', show() {}, hide() {}, dispose() {} }),
			createOutputChannel: () => ({ appendLine() {} }),
			showWarningMessage: async (_m: string, options: { detail?: string }) => { consentAsked++; consentDetail = options?.detail ?? ''; return 'Allow'; },
		},
		commands: { registerCommand: () => ({ dispose() {} }) },
	};
	const stored = new Map<string, unknown>(), secrets = new Map<string, string>();
	const context = {
		workspaceState: { get: (name: string) => stored.get(name), update: async (name: string, value: unknown) => { stored.set(name, value); } },
		secrets: { get: async (name: string) => secrets.get(name), store: async (name: string, value: string) => { secrets.set(name, value); }, delete: async (name: string) => { secrets.delete(name); } },
		subscriptions: [] as { dispose(): void }[],
	};
	let surface: any;
	const chatView = {
		ChatViewProvider: {
			exchangeViewerConnected() {},
			chromeSources: () => [{ id: 'panel-1', panelId: 'sidebar' }],
			exchangeTerminals: () => ({
				blocked: () => !setting,
				find: (id: string) => setting && id === 'term-1' ? terminal.target : undefined,
				shared: () => setting ? [{ id: 'term-1', name: 'zsh', status: 'running', cwd: '/home/me/project', remote: true }] : [],
				support: () => ({ available: true, limit: 8, agents: [] }),
			}),
			commandExchangeSource: async () => {},
			observeChromeSource: (_source: string, s: any) => {
				surface = s;
				const refresh = () => s.update({ chatId: 'chat-1', entries: [], running: false, tabs: [{ id: 'tab-1', chatId: 'chat-1', title: 'One' }], voice: {} });
				s.bind(refresh); refresh();
				return { dispose: () => s.close() };
			},
		},
		chatViewId: 'aiBrowser.chat', remoteTerminalSetting: () => setting, remoteTerminalOpenSetting: () => true,
	};
	const modules = new Map<string, any>();
	const sandbox = { WebSocket: FakeSocket, Buffer, URL, Error, AbortSignal, TextEncoder, TextDecoder, crypto: globalThis.crypto, btoa, atob, EventTarget, Event, MessageEvent, setTimeout, clearTimeout };
	function load(name: string): any {
		if (modules.has(name)) { return modules.get(name); }
		const module = { exports: {} }; modules.set(name, module.exports);
		const filename = resolve('src/chat', `${name}.ts`);
		const js = transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
		runInNewContext(js, {
			...sandbox, module, exports: module.exports,
			fetch: async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', protocolVersion: 1 }) }),
			require: (specifier: string) => specifier === 'node:net' ? { isIP } : specifier === 'node:crypto' ? { createHash } : specifier === 'vscode' ? vscode : specifier === './chatView' ? chatView : load(relative(resolve('src/chat'), resolve(dirname(filename), specifier))),
		});
		return module.exports;
	}
	load('exchangeChat').registerExchangeChat(context);
	const crypto = load('../core/exchangeCrypto');
	const port = load('exchangeConnection').exchangeConnection;
	const pointId = 'b992f496-44cc-4f54-968b-c474b84df86a';
	const password = 'a sufficiently long password';
	try {
		await port.connect({ url: 'http://127.0.0.1:3001', pointId, key: 'exch_' + 'a'.repeat(43), password }, 'panel-1');
		const agent = FakeSocket.made[0];
		let viewer: FakeSocket | undefined;
		let descriptor: unknown;
		// The relay: auth answered with ready, secure envelopes forwarded both ways, nothing else.
		agent.onSend = raw => {
			const value = JSON.parse(raw);
			if (value.type === 'auth') { descriptor = value.encryption; queueMicrotask(() => agent.emit('message', { data: JSON.stringify({ type: 'ready', version: 1, encryption: descriptor }) })); return; }
			assert.equal(value.type, 'secure', 'the agent sends nothing in plaintext after auth');
			viewer?.emit('message', { data: raw });
		};
		agent.emit('open');
		const until = async (check: () => boolean, what: string) => { for (let i = 0; i < 400 && !check(); i++) { await delay(5); } assert.ok(check(), what); };
		await until(() => !!descriptor && port.state.status === 'connected', 'agent connected');

		const viewerCipher = await crypto.exchangeCipher(password, pointId, descriptor);
		const facade = crypto.encryptedExchangeSocket('ws://127.0.0.1:3001/ws/browser', viewerCipher, false, undefined, FakeSocket);
		viewer = FakeSocket.made.at(-1)!;
		viewer.onSend = raw => { if (JSON.parse(raw).type === 'secure') { agent.emit('message', { data: raw }); } };
		const received: any[] = [];
		facade.addEventListener('message', (event: any) => received.push(JSON.parse(event.data)));
		viewer.emit('open');
		viewer.emit('message', { data: JSON.stringify({ type: 'ready', version: 1, online: true, encryption: descriptor }) });
		await until(() => received.some(m => m.type === 'ready'), 'viewer verified');
		surface.update({ chatId: 'chat-1', entries: [], running: false, tabs: [{ id: 'tab-1', chatId: 'chat-1', title: 'One' }], voice: {} });
		await until(() => received.some(m => m.type === 'chat.snapshot'), 'snapshot reached the viewer');
		const snapshot = [...received].reverse().find(m => m.type === 'chat.snapshot');
		assert.match(snapshot.epoch, /^[A-Za-z0-9]{1,64}$/, 'snapshots are numbered even without patches: terminals need the epoch');
		assert.deepEqual(snapshot.view.terminals.map((t: any) => t.id), ['term-1']);
		assert.equal(snapshot.view.terminals[0].cwd, 'project');
		assert.equal(snapshot.view.controls.terminalInput, undefined, 'terminal input is on for the website');

		const v = 'viewer-0001';
		let n = 0;
		const frame = (body: Record<string, unknown>) => facade.send(JSON.stringify({ e: snapshot.epoch, v, n: ++n, t: 'term-1', ...body }));
		const of = (type: string) => received.filter(m => m.type === type);

		frame({ type: 'terminal.attach', cols: 100, rows: 30 });
		await until(() => of('terminal.lease').length === 1, 'replay and lease after attach');
		assert.equal(consentAsked, 1);
		// The consent names everything it allows, new shells included: those are shared unmarked.
		assert.match(consentDetail, /open new shells or agent CLIs/);
		assert.equal(of('terminal.replay')[0].data, 'hello $ ');
		assert.equal(of('terminal.lease')[0].holder, 'editor', 'a new viewer watches');
		assert.deepEqual(terminal.resizes, [], 'attaching does not resize the PTY');

		terminal.output('ls\r\n');
		await until(() => of('terminal.data').length === 1, 'live output');
		assert.equal(of('terminal.data')[0].data, 'ls\r\n');

		frame({ type: 'terminal.input', data: 'rm -rf x' });
		await until(() => of('terminal.error').length === 1, 'watch input refused');
		assert.equal(of('terminal.error')[0].reason, 'watch-only');
		assert.deepEqual(terminal.inputs, []);

		frame({ type: 'terminal.lease', op: 'claim' });
		await until(() => of('terminal.lease').some(m => m.holder === 'you'), 'lease granted');
		assert.deepEqual(terminal.control, [true], 'the editor stops sizing the PTY while the website holds control');
		frame({ type: 'terminal.resize', cols: 40, rows: 20 });
		frame({ type: 'terminal.input', data: 'echo ok\r' });
		await until(() => terminal.inputs.length === 1, 'input written');
		assert.deepEqual(terminal.inputs, ['echo ok\r']);
		assert.deepEqual(terminal.resizes, [[40, 20]]);

		setting = false;
		surface.update({ chatId: 'chat-1', entries: [], running: false, tabs: [{ id: 'tab-1', chatId: 'chat-1', title: 'One' }], voice: {} });
		await delay(50);
		assert.equal(terminal.sinks.size, 0, 'the setting off drops the consumers');
		assert.deepEqual(terminal.control, [true, false]);
		const before = received.length;
		frame({ type: 'terminal.input', data: 'echo no\r' });
		frame({ type: 'terminal.attach', cols: 80, rows: 24 });
		terminal.output('more');
		await delay(100);
		assert.deepEqual(terminal.inputs, ['echo ok\r']);
		assert.equal(received.slice(before).filter(m => String(m.type).startsWith('terminal.')).length, 0, 'nothing answers with terminal frames');
		const last = [...received].reverse().find(m => m.type === 'chat.snapshot');
		assert.deepEqual(last.view.terminals, []);
	} finally {
		port.disconnect();
		for (const item of context.subscriptions) { item.dispose(); }
	}
});
