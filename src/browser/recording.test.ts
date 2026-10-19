import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { recordingProfiles, recordingQualityKey, readRecordingQuality } from './recordingQuality.ts';

const source = fs.readFileSync(path.resolve('src/browser/recording.ts'), 'utf8');
const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;

class Events {
	private readonly listeners = new Set<(value: any) => void>();
	readonly event = (listener: (value: any) => void) => {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	};
	fire(value?: any): void { for (const listener of [...this.listeners]) { listener(value); } }
	dispose(): void { this.listeners.clear(); }
}

async function until(condition: () => boolean): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (condition()) { return; }
		await new Promise(resolve => setImmediate(resolve));
	}
	assert.fail('Expected lifecycle transition did not happen.');
}

function harness(options: { holdReady?: boolean; holdFirstFrame?: boolean; holdChannel?: boolean } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-test-'));
	const changedShare = new Events(), closedTab = new Events();
	const panels: any[] = [], channels: any[] = [], clients: any[] = [];
	const state = { allowed: true, clipboard: '', holdFrame: false, holdStop: false, failAck: false, closeDuringStop: false, quality: 'high' };
	const commands: { method: string; params: any }[] = [];
	const window: any = { browserTabs: [], activeBrowserTab: undefined, onDidCloseBrowserTab: closedTab.event,
		showInformationMessage: async () => undefined, showErrorMessage: async () => undefined };
	const tab: any = { url: 'https://recording.test', startCDPSession: () => {
		const closed = new Events();
		const channel: any = { onDidClose: closed.event, closed: false, close: async () => { channel.closed = true; closed.fire(); } };
		channels.push(channel);
		if (!options.holdChannel) { return Promise.resolve(channel); }
		return new Promise(resolve => { channel.deliver = () => resolve(channel); });
	} };
	window.browserTabs = [tab]; window.activeBrowserTab = tab;
	const browser = {
		recordingTab: () => window.activeBrowserTab,
		canRecordTab: (source: any) => state.allowed && window.browserTabs.includes(source),
		tabIdOf: () => 'tab-A', onDidChangeShare: changedShare.event,
	};
	const uri = (fsPath: string) => ({ fsPath, toString: () => fsPath });
	const vscode = {
		EventEmitter: Events,
		window, commands: { executeCommand: async () => undefined }, l10n: { t: (message: string) => message },
		env: { clipboard: { writeText: async (text: string) => { state.clipboard = text; } } },
		Uri: { file: uri, joinPath: (_root: any, ...parts: string[]) => uri(parts.join('/')) },
		ViewColumn: { Beside: 2 }, Disposable: class { dispose: () => void; constructor(dispose: () => void) { this.dispose = dispose; } },
	};
	window.createWebviewPanel = () => {
		const messages = new Events(), disposed = new Events();
		const panel: any = { onDidDispose: disposed.event, disposed: false,
			dispose: () => { if (!panel.disposed) { panel.disposed = true; disposed.fire(); } },
			reply: (message: any, values: object = {}) => messages.fire({ type: 'reply', seq: message.seq, ...values }),
		};
		const webview: any = {
			onDidReceiveMessage: messages.event, asWebviewUri: (value: any) => value.fsPath,
			postMessage: async (message: any) => {
				if (message.type === 'init') { queueMicrotask(() => panel.reply(message, { mime: 'video/mp4' })); }
				if (message.type === 'frame') {
					if (state.holdFrame) { panel.frame = message; }
					else { queueMicrotask(() => panel.reply(message, { mime: 'video/mp4' })); }
				}
				if (message.type === 'pause' || message.type === 'resume') { queueMicrotask(() => panel.reply(message)); }
				if (message.type === 'stop') {
					panel.finish = () => {
						messages.fire({ type: 'chunk', seq: 99, data: Buffer.from('encoded video').toString('base64') });
						panel.reply(message, { duration: 3 });
					};
					if (!state.holdStop) { queueMicrotask(panel.finish); }
				}
				return true;
			},
		};
		Object.defineProperty(webview, 'html', { set: () => { if (!options.holdReady) { queueMicrotask(() => messages.fire({ type: 'ready' })); } } });
		Object.defineProperty(panel, 'webview', { get: () => { if (panel.disposed) { throw new Error('Webview is disposed'); } return webview; } });
		panels.push(panel);
		return panel;
	};
	class Client {
		isClosed = false;
		private handler?: (params: any, session: string) => void;
		private readonly channel: any;
		constructor(channel: any) { this.channel = channel; clients.push(this); }
		async attachToPage(): Promise<string> { return 'page'; }
		on(_method: string, handler: (params: any, session: string) => void) { this.handler = handler; return { dispose: () => { this.handler = undefined; } }; }
		frame(): void { this.handler?.({ sessionId: 1, data: 'jpeg' }, 'page'); }
		async send(method: string, params?: any): Promise<object> {
			commands.push({ method, params });
			if (this.isClosed) { throw new Error('CDP session closed'); }
			if (method === 'Page.startScreencast' && !options.holdFirstFrame) { queueMicrotask(() => this.frame()); }
			if (method === 'Page.screencastFrameAck' && state.failAck) { throw new Error('Live acknowledgement failed'); }
			if (method === 'Page.stopScreencast' && state.closeDuringStop) {
				this.isClosed = true; window.browserTabs = []; throw new Error('Target closed');
			}
			return {};
		}
		dispose(): void { this.isClosed = true; void this.channel.close(); }
	}
	const exported: any = {};
	runInNewContext(compiled, { exports: exported, Buffer, Date, setTimeout, clearTimeout, setInterval, clearInterval,
		require: (name: string) => {
			switch (name) {
				case 'vscode': return vscode;
				case 'node:fs': return fs;
				case 'node:path': return path;
				case '../core/cdp': return { CDPClient: Client };
				case '../core/uuid': return { generateUuid: randomUUID };
				case '../core/safeFiles': return { privateTempDirectory: async () => root };
				case './shareRegistry': return { callerKey: (caller: any) => caller.sessionId ?? caller.kind };
				case './recordingQuality': return { recordingProfiles, recordingQualityKey, readRecordingQuality };
				default: throw new Error(`Unexpected dependency: ${name}`);
			}
		},
	});
	const recording = new exported.BrowserRecording({ extensionUri: uri(root), globalState: { get: () => state.quality } }, browser);
	recording.createEncoder = () => { const panel = window.createWebviewPanel(); panel.webview.html = ''; return panel; };
	return { recording, tab, window, panels, channels, clients, state, closedTab, commands,
		cleanup: () => { recording.dispose(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('manual pause can resume on the original tab after focus moves elsewhere', async () => {
	const h = harness();
	try {
		await h.recording.start(); await h.recording.control('pause');
		const other = { url: 'https://other.test' };
		h.window.browserTabs.push(other); h.window.activeBrowserTab = other;
		assert.equal((await h.recording.control('resume')).state, 'recording');
		assert.equal(h.recording._active.tab, h.tab);
		const result = await h.recording.control('stop');
		assert.equal(result.state, 'completed'); assert.ok(fs.existsSync(result.file));
	} finally { h.cleanup(); }
});

test('quality is snapshotted at start and preserves lossless source frames after resume', async () => {
	const h = harness();
	try {
		h.state.quality = 'maximum'; await h.recording.start();
		h.state.quality = 'balanced'; await h.recording.control('pause'); await h.recording.control('resume');
		for (const command of h.commands.filter(c => c.method === 'Page.startScreencast')) {
			assert.equal(command.params.format, 'png'); assert.equal(command.params.maxWidth, 3840); assert.equal(command.params.maxHeight, 2160);
		}
		assert.equal((await h.recording.control('stop')).state, 'completed');
	} finally { h.cleanup(); }
});

test('menu quality overrides the next recording without changing the saved default', async () => {
	const h = harness();
	try {
		h.state.quality = 'maximum';
		await h.recording.start(undefined, 'clipboard', undefined, 'balanced');
		await h.recording.control('pause'); await h.recording.control('resume');
		for (const command of h.commands.filter(c => c.method === 'Page.startScreencast')) {
			assert.equal(command.params.maxWidth, 1920); assert.equal(command.params.maxHeight, 1080);
		}
		assert.equal(h.state.quality, 'maximum');
		await h.recording.control('stop');
		await h.recording.start();
		const latest = h.commands.filter(c => c.method === 'Page.startScreencast').at(-1)!;
		assert.equal(latest.params.maxWidth, 3840);
		await h.recording.control('stop');
	} finally { h.cleanup(); }
});

test('recording notifications follow start, pause, resume and completion', async () => {
	const h = harness(), states: (string | undefined)[] = [];
	try {
		h.recording.onDidChange((result: any) => states.push(result?.state));
		await h.recording.start(); await h.recording.control('pause'); await h.recording.control('resume'); await h.recording.control('stop');
		assert.deepEqual(states, ['starting', 'recording', 'paused', 'recording', 'stopping', undefined]);
	} finally { h.cleanup(); }
});

test('resume still rejects revoked access to the source tab', async () => {
	const h = harness();
	try {
		await h.recording.start({ kind: 'codex' }); await h.recording.control('pause');
		h.state.allowed = false;
		await assert.rejects(h.recording.control('resume'), /no longer available/);
	} finally { h.cleanup(); }
});

test('cancelling before startup creates no recording panel', async () => {
	const h = harness(), abort = new AbortController(); abort.abort();
	try { await assert.rejects(h.recording.start(undefined, 'clipboard', abort.signal), /cancelled/); assert.equal(h.panels.length, 0); }
	finally { h.cleanup(); }
});

test('cancelling while the encoder loads releases startup immediately', async () => {
	const h = harness({ holdReady: true }), abort = new AbortController();
	try {
		const start = h.recording.start(undefined, 'clipboard', abort.signal); abort.abort();
		await assert.rejects(start, /cancelled/);
		assert.equal(h.recording._active, undefined); assert.equal(h.panels[0].disposed, true);
		assert.equal(h.channels.length, 0);
	} finally { h.cleanup(); }
});

test('cancelling while awaiting the first frame removes partial output and closes CDP', async () => {
	const h = harness({ holdFirstFrame: true }), abort = new AbortController();
	try {
		const start = h.recording.start(undefined, 'clipboard', abort.signal);
		await until(() => h.clients.length > 0 && !!h.recording._active?.session);
		const file = h.recording._active.file; abort.abort();
		await assert.rejects(start, /cancelled/);
		assert.equal(h.recording._active, undefined); assert.equal(h.clients[0].isClosed, true); assert.ok(!fs.existsSync(file));
	} finally { h.cleanup(); }
});

test('a CDP channel arriving after startup cancellation is closed', async () => {
	const h = harness({ holdChannel: true }), abort = new AbortController();
	try {
		const start = h.recording.start(undefined, 'clipboard', abort.signal);
		await until(() => h.channels.length > 0); abort.abort();
		await assert.rejects(start, /cancelled/); h.channels[0].deliver();
		await until(() => h.channels[0].closed); assert.equal(h.clients.length, 0);
	} finally { h.cleanup(); }
});

test('aborting an already completed start call leaves the recording running', async () => {
	const h = harness(), abort = new AbortController();
	try {
		await h.recording.start(undefined, 'clipboard', abort.signal); abort.abort();
		assert.equal(h.recording._active.result.state, 'recording');
		assert.equal((await h.recording.control('stop')).state, 'completed');
	} finally { h.cleanup(); }
});

test('cancellation between CDP channel delivery and client construction closes the channel', async () => {
	const h = harness({ holdChannel: true }), abort = new AbortController();
	try {
		const start = h.recording.start(undefined, 'clipboard', abort.signal);
		await until(() => h.channels.length > 0);
		h.channels[0].deliver(); queueMicrotask(() => abort.abort());
		await assert.rejects(start, /cancelled/);
		assert.equal(h.channels[0].closed, true); assert.equal(h.recording._active, undefined);
		assert.ok(h.clients.every(client => client.isClosed));
	} finally { h.cleanup(); }
});

test('source closure with a frame in flight preserves and finalizes the video', async () => {
	const h = harness();
	try {
		await h.recording.start(); h.state.holdFrame = true; h.state.holdStop = true;
		h.clients[0].frame(); await until(() => !!h.panels[0].frame);
		const file = h.recording._active.file;
		h.clients[0].isClosed = true; h.window.browserTabs = [];
		const finish = h.recording.stop(); await until(() => !!h.panels[0].finish);
		h.panels[0].reply(h.panels[0].frame, { mime: 'video/mp4' });
		await until(() => !h.recording._active?.busyFrame);
		h.panels[0].finish();
		const result = await finish;
		assert.equal(result.state, 'completed'); assert.ok(fs.existsSync(file)); assert.equal(h.state.clipboard, file);
	} finally { h.cleanup(); }
});

test('source closure during stopScreencast still finalizes captured video', async () => {
	const h = harness();
	try {
		await h.recording.start(); h.state.closeDuringStop = true;
		const result = await h.recording.control('stop');
		assert.equal(result.state, 'completed'); assert.ok(fs.existsSync(result.file));
	} finally { h.cleanup(); }
});

test('acknowledgement errors from a live source are still reported', async () => {
	const h = harness();
	try {
		await h.recording.start(); const run = h.recording._active; h.state.failAck = true;
		h.clients[0].frame(); await until(() => !h.recording._active);
		assert.equal(run.result.state, 'failed'); assert.match(run.result.error, /Live acknowledgement failed/);
	} finally { h.cleanup(); }
});

test('losing the background encoder releases CDP and removes partial output', async () => {
	const h = harness();
	try {
		await h.recording.start(); const run = h.recording._active;
		h.panels[0].dispose();
		assert.equal(run.result.state, 'failed'); assert.equal(h.recording._active, undefined);
		assert.equal(h.clients[0].isClosed, true); assert.ok(!fs.existsSync(run.file));
	} finally { h.cleanup(); }
});
