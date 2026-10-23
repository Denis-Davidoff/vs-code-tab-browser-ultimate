import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import type { ChromeChatConnection } from './chromeChatProtocol';
import type { ChatViewState } from './chatProtocol';
import { remoteRefusal } from './core/commands.ts';
import { remoteScope } from './core/remoteScope.ts';

// Load the same CommonJS modules VS Code runs, without importing the VS Code API.
const nodeRequire = createRequire(`${process.cwd()}/package.json`);
const modules = new Map<string, { exports: any }>();
function load(name: string): any { return loadFile(path.resolve(`src/chat/${name}.ts`)); }
function loadFile(file: string): any {
	const existing = modules.get(file); if (existing) { return existing.exports; }
	const module = { exports: {} }; modules.set(file, module);
	const source = readFileSync(file, 'utf8');
	runInNewContext(transpileModule(source, {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText, {
		module, exports: module.exports, Buffer, Error, AbortController, setTimeout, clearTimeout,
		require: (specifier: string) => specifier.startsWith('.') ? loadFile(path.resolve(path.dirname(file), `${specifier}.ts`)) : nodeRequire(specifier),
	});
	return module.exports;
}

const { ChromeChatBridge } = load('chromeChatBridge');
const { ChromeChatPairing } = load('chromeChatPairing');
const { readChromeChatConnection, readChromeChatCommand, chromeChatSnapshot } = load('chromeChatProtocol');
const { ChatStateSurfaces } = load('chatSurface');
const attachmentReferences = load('attachmentReferences');
const extensionId = 'a'.repeat(32);
const { chromeChatProtocolVersion, chromeChatProtocolHeader, chromeChatVersionHeader, chromeChatCompatibilityError } = load('chromeChatCompatibility');

test('Chrome sends stay bound to the displayed chat, preserve editor attachments and never block Stop', async () => {
	const source = readFileSync('src/chat/chatView.ts', 'utf8');
	const method = /public static async commandChromeSource\([\s\S]*?\n\t\}/.exec(source)![0].replace('public static async ', 'async function ');
	const command = runInNewContext(transpileModule(`${method}\ncommandChromeSource;`, {
		compilerOptions: { target: ScriptTarget.ES2022 },
	}).outputText, { Error, remoteRefusal, remoteScope, chromeChatCommandFeature: load('chromeChatCompatibility').chromeChatCommandFeature, bindAttachmentReference: attachmentReferences.bindAttachmentReference });
	const attachments = [{ label: 'unsent editor attachment' }];
	const calls: any[] = [];
	const tab: any = { id: 'tab-1', chat: { id: 'chat-1' }, pendingSends: [], attachments,
		enqueue(text: string, given: unknown[]) { calls.push(['queue', text, given]); } };
	const view: any = { _view: {}, _active: tab, _tabs: [tab], _blocked: () => undefined,
		_stopTab(stopped: any) { calls.push(['stop', stopped.id]); },
		_selection: () => ({ agent: 'codex', model: 'model' }),
		_registry: { detecting: false, backend: () => ({}) },
		_rememberInput: async () => {}, _postMessage() {}, _state: () => ({}),
		_drainQueues() { calls.push(['drain']); },
		_send(text: string, id: string, given: unknown[]) { calls.push(['send', text, id, given]); return new Promise(() => {}); },
		async _receive(message: { type: string }) { calls.push([message.type]); },
	};
	const receiver = { _surfaces: new Map([['surface', view]]) };
	await assert.rejects(command.call(receiver, 'surface', 'other-chat', { type: 'send', text: 'wrong' }), /closed in the editor/);
	assert.equal(calls.length, 0);
	await command.call(receiver, 'surface', 'chat-1', { type: 'send', text: 'hello' });
	assert.equal(calls[0][0], 'send'); assert.equal(calls[0][2], 'tab-1'); assert.equal(calls[0][3].length, 0);
	assert.equal(tab.attachments, attachments);
	await command.call(receiver, 'surface', 'chat-1', { type: 'stop' });
	assert.equal(calls[1][0], 'stop');
	await command.call(receiver, 'surface', 'chat-1', { type: 'send', text: 'later', mode: 'queue' });
	assert.equal(calls[2][0], 'queue'); assert.equal(calls[2][2].length, 0);
	const picked = [{ id: 'picked-element', label: 'button#save', reference: '@3', text: 'Element context' }];
	const before = calls.length;
	await command.call(receiver, 'surface', 'chat-1', { type: 'send', text: 'Inspect @3' }, picked);
	const given = calls[before][3];
	assert.equal(given.length, 1); assert.equal(given[0].chip.kind, 'element');
	assert.equal(given[0].text, 'Element context'); assert.equal(attachmentReferences.attachmentReference(given[0].chip), '@3');
	assert.equal(tab.attachments, attachments);
	view._blocked = () => 'Workspace is untrusted';
	await assert.rejects(command.call(receiver, 'surface', 'chat-1', { type: 'send', text: 'blocked' }), /untrusted/);
});

function state(): ChatViewState {
	return {
		chatId: 'chat-1', activeTab: 'tab-1', running: true, dragToken: 'private-drag-token',
		tabs: [{ id: 'tab-1', title: 'A live conversation' }],
		entries: [{ kind: 'assistant', text: 'First answer' }],
		selection: { agent: 'codex', model: 'test-model', effort: 'high' }, viewMode: 'compact',
	} as unknown as ChatViewState;
}

async function get(config: ChromeChatConnection, headers: http.OutgoingHttpHeaders = {}, method = 'GET', path = '/snapshot', body?: string) {
	return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
		const combined: http.OutgoingHttpHeaders = {
			[chromeChatProtocolHeader]: String(chromeChatProtocolVersion), [chromeChatVersionHeader]: '0.5.0',
			Authorization: `Bearer ${config.token}`, Origin: `chrome-extension://${extensionId}`, ...headers,
		};
		for (const key of Object.keys(combined)) { if (combined[key] === undefined) { delete combined[key]; } }
		const request = http.request(`${config.url}${path}`, { method, headers: combined }, response => {
			let responseBody = '';
			response.setEncoding('utf8');
			response.on('data', chunk => { responseBody += chunk; });
			response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: responseBody }));
		});
		request.on('error', reject); request.end(body);
	});
}

test('quick pairing exposes no token before consent and binds its claim to the extension and secret', async () => {
	let approvals = 0;
	let approve!: (config: ChromeChatConnection | undefined) => void;
	const pairing = new ChromeChatPairing('Editor', async () => { approvals++; return new Promise(resolve => { approve = resolve; }); });
	const url = await pairing.start([0]);
	const config: ChromeChatConnection = { version: 1, url, extensionId, token: 'a'.repeat(64) };
	const headers = { 'X-AI-Browser-Extension': extensionId, 'X-Pairing-Secret': 'c'.repeat(64) };
	try {
		const discovery = await get(config, headers, 'GET', '/discovery');
		assert.equal(discovery.status, 200);
		assert.equal(JSON.parse(discovery.body).kind, 'ai-browser-chrome-pairing');
		assert.equal(discovery.body.includes('token'), false);
		const first = await get(config, headers, 'POST', '/pair/request-1234');
		assert.equal(first.status, 202); assert.equal(JSON.parse(first.body).connection, undefined);
		assert.equal((await get(config, headers, 'POST', '/pair/request-1234')).status, 202);
		assert.equal(approvals, 1);
		assert.equal((await get(config, headers, 'POST', '/pair/another-request')).status, 429);
		approve(config);
		const granted = await get(config, headers, 'GET', '/pair/request-1234');
		assert.equal(granted.status, 200); assert.equal(JSON.parse(granted.body).connection.token, config.token);
		assert.equal((await get(config, { ...headers, 'X-Pairing-Secret': 'd'.repeat(64) }, 'GET', '/pair/request-1234')).status, 403);
		assert.equal((await get(config, { ...headers, 'X-AI-Browser-Extension': 'b'.repeat(32), Origin: `chrome-extension://${'b'.repeat(32)}` }, 'GET', '/pair/request-1234')).status, 403);
		assert.equal((await get(config, { ...headers, Origin: 'https://example.com' }, 'GET', '/discovery')).status, 403);
		assert.equal((await get(config, { ...headers, Origin: undefined }, 'POST', '/pair/no-origin-request')).status, 403);
		assert.equal((await get(config, { ...headers, Origin: `chrome-extension://${'b'.repeat(32)}` }, 'POST', '/pair/wrong-origin-request')).status, 403);
		assert.equal(approvals, 1);
	} finally { pairing.dispose(); }
});

test('denied, cancelled and expired quick requests never return credentials', async () => {
	let signal: AbortSignal | undefined;
	const pairing = new ChromeChatPairing('Editor', async (id: string, _extensionId: string, abort: AbortSignal) => {
		signal = abort;
		if (id === 'deny-request') { return undefined; }
		return new Promise(() => {});
	}, 50);
	const url = await pairing.start([0]);
	const config: ChromeChatConnection = { version: 1, url, extensionId, token: 'a'.repeat(64) };
	const headers = { 'X-AI-Browser-Extension': extensionId, 'X-Pairing-Secret': 'c'.repeat(64) };
	try {
		await get(config, headers, 'POST', '/pair/deny-request');
		assert.deepEqual(JSON.parse((await get(config, headers, 'GET', '/pair/deny-request')).body), { status: 'denied' });
		await get(config, headers, 'POST', '/pair/cancel-request');
		await get(config, headers, 'DELETE', '/pair/cancel-request');
		assert.equal(signal!.aborted, true);
		assert.equal((await get(config, headers, 'GET', '/pair/cancel-request')).status, 404);
		await get(config, headers, 'POST', '/pair/expire-request');
		await new Promise(resolve => setTimeout(resolve, 80));
		assert.equal(signal!.aborted, true);
		assert.equal((await get(config, headers, 'GET', '/pair/expire-request')).status, 404);
		await get(config, headers, 'POST', '/pair/revoke-request');
		pairing.cancelPending();
		assert.equal(signal!.aborted, true);
		assert.equal((await get(config, headers, 'GET', '/pair/revoke-request')).status, 404);
	} finally { pairing.dispose(); }
});

test('quick discovery skips an occupied port without replacing the other editor', async () => {
	const first = new ChromeChatPairing('First', async () => undefined);
	const second = new ChromeChatPairing('Second', async () => undefined);
	try {
		const firstUrl = await first.start([0]);
		const secondUrl = await second.start([Number(new URL(firstUrl).port), 0]);
		assert.notEqual(firstUrl, secondUrl);
	} finally { first.dispose(); second.dispose(); }
});

test('only an editor surface can grant a pending quick connection; cancellation clears the card', async () => {
	const source = readFileSync('src/chat/chatView.ts', 'utf8');
	const method = /public static requestChromeConnection\([\s\S]*?\n\t\}/.exec(source)![0].replace('public static ', 'function ');
	const request = runInNewContext(transpileModule(`${method}\nrequestChromeConnection;`, {
		compilerOptions: { target: ScriptTarget.ES2022 },
	}).outputText);
	let updates = 0;
	const receiver: any = { _surfaces: new Map([['first', { _post() { updates++; } }], ['second', { _post() { updates++; } }]]) };
	const controller = new AbortController();
	const accepted = request.call(receiver, 'request-1234', extensionId, controller.signal);
	assert.equal(receiver._chromeConnectionRequest.extensionId, extensionId);
	receiver._chromeConnectionRequest.finish('second');
	assert.equal(await accepted, 'second'); assert.equal(receiver._chromeConnectionRequest, undefined);
	const cancelled = request.call(receiver, 'request-5678', extensionId, controller.signal);
	controller.abort();
	assert.equal(await cancelled, undefined); assert.equal(receiver._chromeConnectionRequest, undefined);
	assert.ok(updates >= 8);
	assert.equal(readChromeChatCommand({ id: 'request-1234', chatId: 'chat', message: { type: 'answerChromeConnection', id: 'request-5678', allow: true } }), undefined);
	const snapshot = chromeChatSnapshot({ ...state(), chromeConnectionRequest: { id: 'request-1234', extensionId } });
	assert.equal(snapshot.view.chromeConnectionRequest, undefined);
});

test('connection codes accept only a versioned loopback URL, full secret and extension ID', () => {
	const valid = { version: 1, url: 'http://127.0.0.1:12345', token: 'f'.repeat(64), extensionId };
	assert.equal(readChromeChatConnection(valid)?.url, valid.url);
	for (const value of [null, {}, { ...valid, version: 2 }, { ...valid, token: '' },
		{ ...valid, url: 'http://localhost:12345' }, { ...valid, url: 'http://127.0.0.1:65536' },
		{ ...valid, url: 'http://127.0.0.1:12345/private' }, { ...valid, url: 'https://example.com' },
		{ ...valid, url: 'http://127.0.0.1:12345@evil.com' }, { ...valid, extensionId: 'z'.repeat(32) }]) {
		assert.equal(readChromeChatConnection(value), undefined);
	}
});

test('Chrome command validation strips routing overrides and refuses unsupported mutations', () => {
	const envelope = { id: 'request-1234', chatId: 'chat-1' };
	const command = readChromeChatCommand({ ...envelope, message: { type: 'send', text: 'hello', tabId: 'another-tab' } });
	assert.equal(command.message.text, 'hello');
	assert.equal(command.message.tabId, undefined);
	for (const message of [{ type: 'send', text: '' }, { type: 'send', text: 'a'.repeat(100_001) },
		{ type: 'gitCommit', folder: '/' }, { type: 'approve', id: 'x', allow: 'yes' },
		{ type: 'select', selection: { agent: 'unknown' } }, { type: 'setViewMode', mode: 'unknown' }]) {
		assert.equal(readChromeChatCommand({ ...envelope, message }), undefined);
	}
});

test('element-only messages are accepted and invalid or duplicate attachment references are refused', () => {
	const attachment = { id: 'picked-element', label: 'button#save', reference: '@2', text: 'Selected element context' };
	const envelope = { id: 'request-1234', chatId: 'chat-1', message: { type: 'send', text: '' }, attachments: [attachment] };
	assert.equal(readChromeChatCommand(envelope).attachments[0].reference, '@2');
	for (const attachments of [[{ ...attachment, reference: '@0' }], [{ ...attachment, text: 'x'.repeat(64_001) }],
		[attachment, { ...attachment, id: 'another-element' }], [attachment, { ...attachment, reference: '@3' }],
		[{ ...attachment, label: 'Injected\nlabel' }]]) {
		assert.equal(readChromeChatCommand({ ...envelope, attachments }), undefined);
	}
	assert.equal(readChromeChatCommand({ ...envelope, message: { type: 'stop' } }), undefined);
});

test('repeated concurrent command requests execute once and changed payload cannot reuse an ID', async () => {
	let calls = 0;
	let finish!: () => void;
	const gate = new Promise<void>(resolve => { finish = resolve; });
	const bridge = new ChromeChatBridge(extensionId, async () => { calls++; await gate; });
	const config = await bridge.start(); bridge.update(state());
	const command = { id: 'request-1234', chatId: 'chat-1', message: { type: 'send', text: 'hello' } };
	const body = JSON.stringify(command);
	try {
		const attempts = [get(config, {}, 'POST', '/command', body), get(config, {}, 'POST', '/command', body)];
		finish();
		const replies = await Promise.all(attempts);
		assert.equal(replies[0].status, 200); assert.equal(replies[1].status, 200); assert.equal(calls, 1);
		assert.equal((await get(config, {}, 'POST', '/command', body)).status, 200);
		assert.equal(calls, 1);
		const changed = JSON.stringify({ ...command, message: { type: 'send', text: 'different' } });
		assert.equal((await get(config, {}, 'POST', '/command', changed)).status, 409);
		assert.equal((await get(config, { Authorization: '' }, 'POST', '/command', body)).status, 401);
		assert.equal((await get(config, { Origin: 'https://example.com' }, 'POST', '/command', body)).status, 403);
		assert.equal(calls, 1);
		assert.equal((await get(config, {}, 'POST', '/command', '{')).status, 400);
		assert.equal((await get(config, {}, 'POST', '/command', JSON.stringify({ ...command, message: { type: 'clearChat' } }))).status, 400);
	} finally { bridge.close(); }
});

test('host refusal is returned and retained for retries without executing the command again', async () => {
	let calls = 0;
	const bridge = new ChromeChatBridge(extensionId, async () => { calls++; throw new Error('The active conversation changed.'); });
	const config = await bridge.start();
	const body = JSON.stringify({ id: 'request-1234', chatId: 'old-chat', message: { type: 'send', text: 'hello' } });
	try {
		for (let i = 0; i < 2; i++) {
			const response = await get(config, {}, 'POST', '/command', body);
			assert.equal(response.status, 409);
			assert.equal(JSON.parse(response.body).error, 'The active conversation changed.');
		}
		assert.equal(calls, 1);
		const preflight = await get(config, { Authorization: '', 'Access-Control-Request-Method': 'POST' }, 'OPTIONS', '/command');
		assert.equal(preflight.status, 204);
	} finally { bridge.close(); }
});

test('snapshot projects settings and chat without exposing internal host fields', () => {
	const snapshot = chromeChatSnapshot(state());
	assert.equal(snapshot.title, 'A live conversation');
	assert.equal(snapshot.settings.selection.effort, 'high');
	assert.equal(snapshot.chatId, 'chat-1');
	assert.equal('dragToken' in snapshot, false);
	assert.equal('tabs' in snapshot, false);
});

test('bridge streams successive immutable snapshots and supports conditional polling', async () => {
	const bridge = new ChromeChatBridge(extensionId);
	const config = await bridge.start();
	try {
		assert.equal((await get(config)).status, 503);
		const view = state(); bridge.update(view);
		const first = await get(config);
		assert.equal(first.status, 200);
		assert.equal(first.headers['cache-control'], 'no-store');
		assert.equal(first.headers['access-control-allow-origin'], `chrome-extension://${extensionId}`);
		assert.equal(JSON.parse(first.body).entries[0].text, 'First answer');
		assert.equal(first.body.includes('private-drag-token'), false);
		const etag = first.headers.etag!;
		assert.equal((await get(config, { 'If-None-Match': etag })).status, 304);
		bridge.update(view);
		assert.equal((await get(config, { 'If-None-Match': etag })).status, 304);
		(view.entries[0] as { text: string }).text = 'Updated answer';
		// A live mutable source must not alter an already-published snapshot.
		assert.equal(JSON.parse((await get(config)).body).entries[0].text, 'First answer');
		bridge.update(view);
		const next = await get(config, { 'If-None-Match': etag });
		assert.equal(next.status, 200);
		assert.notEqual(next.headers.etag, etag);
		assert.equal(JSON.parse(next.body).entries[0].text, 'Updated answer');
	} finally { bridge.close(); bridge.close(); }
});

test('bridge refuses wrong secrets, web origins, other extensions, hosts and mutations', async () => {
	const bridge = new ChromeChatBridge(extensionId);
	const config = await bridge.start(); bridge.update(state());
	try {
		assert.equal((await get(config, { Authorization: '' })).status, 401);
		assert.equal((await get(config, { Authorization: `Bearer ${'b'.repeat(64)}` })).status, 401);
		for (const Origin of ['https://example.com', 'null', `chrome-extension://${'b'.repeat(32)}`]) {
			const denied = await get(config, { Origin });
			assert.equal(denied.status, 403);
			assert.equal(denied.headers['access-control-allow-origin'], undefined);
		}
		assert.equal((await get(config, { Host: 'example.com' })).status, 403);
		assert.equal((await get(config, {}, 'POST')).status, 405);
		assert.equal((await get(config, {}, 'GET', '/commands')).status, 404);
		assert.equal((await get(config, {}, 'GET', `/snapshot?token=${config.token}`)).status, 404);
		const preflight = await get(config, { Authorization: '', 'Access-Control-Request-Method': 'GET' }, 'OPTIONS');
		assert.equal(preflight.status, 204);
		assert.equal(preflight.headers['access-control-allow-methods'], 'GET');
		assert.equal((await get(config, { 'Access-Control-Request-Method': 'POST' }, 'OPTIONS')).status, 403);
	} finally { bridge.close(); }
	await assert.rejects(get(config));
});

test('surface detach and source shutdown revoke observers once without closing an agent', () => {
	const surfaces = new ChatStateSurfaces();
	const updates: ChatViewState[] = [];
	let closes = 0;
	const attachment = surfaces.attach({ update: (value: ChatViewState) => updates.push(value), close: () => { closes++; } }, () => state());
	surfaces.publish(() => state());
	assert.equal(updates.length, 2);
	attachment.dispose(); attachment.dispose();
	surfaces.publish(() => state()); surfaces.dispose();
	assert.equal(updates.length, 2); assert.equal(closes, 1);
	surfaces.attach({ update() {}, close: () => { closes++; } }, () => state());
	surfaces.dispose(); surfaces.dispose();
	assert.equal(closes, 2);
});

test('an external view failure cannot interrupt editor updates or other observers', () => {
	const surfaces = new ChatStateSurfaces();
	let failingUpdates = 0, healthyUpdates = 0;
	surfaces.attach({ update() { if (++failingUpdates > 1) { throw new Error('Disconnected'); } },
		close() { throw new Error('Already disconnected'); } }, () => state());
	surfaces.attach({ update() { healthyUpdates++; }, close() {} }, () => state());
	surfaces.publish(() => state()); surfaces.publish(() => state());
	assert.equal(healthyUpdates, 3);
	assert.equal(failingUpdates, 2);
	surfaces.dispose();
});

test('a pinned surface keeps its conversation while the editor switches tabs, and follows it once it closes', async () => {
	const surfaces = new ChatStateSurfaces();
	const tabs = [{ id: 'tab-1', chatId: 'chat-1', title: 'One' }, { id: 'tab-2', chatId: 'chat-2', title: 'Two' }];
	let open = tabs, front = 'chat-1';
	const stateFor = (chatId?: string) => {
		const shown = open.some(t => t.chatId === chatId) ? chatId! : front;
		return { ...state(), chatId: shown, tabs: open } as unknown as ChatViewState;
	};
	const bridge = new ChromeChatBridge(extensionId, async () => {});
	let changed = 0;
	const config = await bridge.start();
	surfaces.attach(bridge, stateFor, () => { changed++; });
	await get(config);
	assert.equal(bridge.chatId, 'chat-1');
	assert.deepEqual([...surfaces.chatIds(front)], ['chat-1']);
	(bridge as any)._chatId = 'chat-2'; (bridge as any)._refresh();
	assert.equal(bridge.chatId, 'chat-2'); assert.ok(changed >= 2);
	front = 'chat-1'; surfaces.publish(stateFor);
	assert.equal(bridge.chatId, 'chat-2', 'switching tabs in the editor does not move Chrome');
	open = [tabs[0]]; surfaces.publish(stateFor);
	assert.equal(bridge.chatId, 'chat-1', 'a closed pinned conversation falls back to the one in front');
	surfaces.dispose();
});

test('the pin command switches the shown conversation and refuses one that is not open', async () => {
	const commands: unknown[] = [];
	const bridge = new ChromeChatBridge(extensionId, async (command: unknown) => { commands.push(command); });
	const config = await bridge.start();
	const surfaces = new ChatStateSurfaces();
	const stateFor = (chatId?: string) => ({ ...state(), chatId: chatId ?? 'chat-1',
		tabs: [{ id: 'tab-1', chatId: 'chat-1', title: 'One' }, { id: 'tab-2', chatId: 'chat-2', title: 'Two' }] } as unknown as ChatViewState);
	surfaces.attach(bridge, stateFor);
	try {
		const pin = (chatId: string, id: string) => get(config, { 'Content-Type': 'application/json' }, 'POST', '/command',
			JSON.stringify({ id, chatId, message: { type: 'pin' } }));
		const ok = await pin('chat-2', 'pin-request-1');
		assert.equal(ok.status, 200); assert.equal(JSON.parse(ok.body).snapshot.chatId, 'chat-2');
		assert.equal((await pin('chat-9', 'pin-request-2')).status, 409);
		assert.equal(bridge.chatId, 'chat-2'); assert.equal(commands.length, 0);
	} finally { surfaces.dispose(); }
});


test('Chrome binary attachments preserve their type and reject invalid paths, encodings and aggregate sizes', () => {
  const attachment = { id: 'image-12345', label: 'Screenshot', reference: '@1', kind: 'screenshot', text: 'Page screenshot',
    file: { name: 'screenshot.png', mime: 'image/png', base64: 'aGVsbG8=' } };
  const command = (items: unknown[]) => readChromeChatCommand({ id: 'request-1234', chatId: 'chat-1', message: { type: 'send', text: '' }, attachments: items });
  assert.equal(command([attachment]).attachments[0].file.base64, 'aGVsbG8=');
  assert.equal(command([attachment]).attachments[0].kind, 'screenshot');
  for (const file of [{ ...attachment.file, name: '../escape.png' }, { ...attachment.file, mime: 'image/png; injected' },
    { ...attachment.file, base64: 'bad?' }, { ...attachment.file, base64: 'a===' }, { ...attachment.file, base64: 'a'.repeat(5_600_004) }]) {
    assert.equal(command([{ ...attachment, file }]), undefined);
  }
  assert.equal(command([{ ...attachment, kind: 'element' }]), undefined);
  assert.equal(command([{ ...attachment, kind: 'unknown' }]), undefined);
  const large = { ...attachment, file: { ...attachment.file, base64: 'a'.repeat(3_000_000) } };
  assert.equal(command([large, { ...large, id: 'image-67890', reference: '@2' }]), undefined);
  assert.equal(command([{ id: 'page-12345', kind: 'sharedPage', tabId: 42, label: 'Page', reference: '@3', text: 'https://example.com' }]).attachments[0].tabId, 42);
});

test('authenticated Chrome annotation synchronization carries MCP requests and acknowledgements', async () => {
  const { chromeAnnotationSessions } = load('../browser/chromeAnnotationSessions');
  const bridge = new ChromeChatBridge(extensionId, async () => {});
  const config = await bridge.start();
  bridge.update({ ...state(), tabs: [{ id: 'tab-1', chatId: 'chat-1', title: 'Chat' }] } as unknown as ChatViewState);
  const tab = { tabId: 17, chatId: 'chat-1', url: 'https://example.test/', pages: [{ url: 'https://example.test/', records: [], found: [] }] };
  const caller = { kind: 'codex', chatId: 'chat-1' };
  const sync = (results: unknown[] = []) => get(config, { 'Content-Type': 'application/json' }, 'POST', '/annotations', JSON.stringify({ tabs: [tab], results }));
  try {
    assert.equal((await sync()).status, 200);
    const session = chromeAnnotationSessions.forTab('chrome-annotations:17', caller);
    const adding = session.add('chrome-annotations:17', '#save', 'Check spacing', 'purple', caller);
    const response = await sync();
    const task = JSON.parse(response.body).requests[0];
    assert.equal(task.action, 'add'); assert.equal(task.chatId, 'chat-1');
    assert.equal((await sync([{ id: task.id, value: { id: task.annotationId, number: 1, url: tab.url } }])).status, 200);
    assert.equal((await adding).id, task.annotationId);
    assert.equal((await get(config, { Authorization: 'Bearer wrong' }, 'POST', '/annotations', '{}')).status, 401);
    assert.equal((await get(config, { 'Content-Type': 'application/json' }, 'POST', '/annotations', JSON.stringify({ tabs: [{ ...tab, chatId: 'unrelated' }], results: [] }))).status, 400);
    assert.equal(chromeAnnotationSessions.visible({ kind: 'codex', chatId: 'unrelated' }).length, 0);
  } finally { bridge.close(); }
});

test('compatibility uses the shared protocol rather than equal extension release numbers', () => {
  assert.equal(chromeChatCompatibilityError(chromeChatProtocolVersion, chromeChatProtocolVersion, '0.8.7', '0.5.0'), undefined);
  assert.match(chromeChatCompatibilityError(undefined, chromeChatProtocolVersion, '0.8.6', '0.5.0'), /Update the AI Browser extension for VS Code/);
  assert.match(chromeChatCompatibilityError(chromeChatProtocolVersion, undefined, '0.8.7', '0.4.0'), /Update the AI Browser extension for Chrome/);
  assert.match(chromeChatCompatibilityError(chromeChatProtocolVersion + 1, chromeChatProtocolVersion), /Update the AI Browser extension for Chrome/);
  assert.match(chromeChatCompatibilityError(chromeChatProtocolVersion, chromeChatProtocolVersion + 1), /Update the AI Browser extension for VS Code/);
  const connection = readChromeChatConnection({ version: 1, url: 'http://127.0.0.1:12345', token: 'f'.repeat(64), extensionId,
    protocolVersion: chromeChatProtocolVersion, editorVersion: '0.8.7' });
  assert.equal(connection.protocolVersion, chromeChatProtocolVersion); assert.equal(connection.editorVersion, '0.8.7');
});

test('an incompatible Chrome client cannot send, pin or synchronize annotations, and legacy panels see an update notice', async () => {
  let commands = 0;
  const bridge = new ChromeChatBridge(extensionId, async () => { commands++; }, '0.8.7');
  const config = await bridge.start(); bridge.update(state());
  const body = JSON.stringify({ id: 'request-1234', chatId: 'chat-1', message: { type: 'send', text: 'must not send' } });
  try {
    assert.equal(config.protocolVersion, chromeChatProtocolVersion); assert.equal(config.editorVersion, '0.8.7');
    const current = JSON.parse((await get(config)).body);
    assert.equal(current.protocolVersion, chromeChatProtocolVersion); assert.equal(current.editorVersion, '0.8.7');
    for (const protocol of [undefined, '1', String(chromeChatProtocolVersion + 1)]) {
      const headers = { [chromeChatProtocolHeader]: protocol, 'Content-Type': 'application/json' };
      for (const path of ['/command', '/annotations']) {
        const response = await get(config, headers, 'POST', path, body);
        assert.equal(response.status, 426); assert.match(JSON.parse(response.body).error, /Update/);
      }
      const response = await get(config, headers);
      if (protocol === undefined) {
        assert.equal(response.status, 200);
        const legacy = JSON.parse(response.body);
        assert.match(legacy.view.blocked, /Update the AI Browser extension for Chrome/);
        assert.equal(legacy.entries[0].kind, 'notice');
      } else { assert.equal(response.status, 426); }
    }
    assert.equal(commands, 0);
    assert.equal((await get(config, { 'Content-Type': 'application/json' }, 'POST', '/command', body)).status, 200);
    assert.equal(commands, 1);
  } finally { bridge.close(); }
});

test('pairing advertises editor compatibility and refuses mismatched Chrome before consent', async () => {
  let approvals = 0; const notices: string[] = [];
  const pairing = new ChromeChatPairing('Editor', async () => { approvals++; return undefined; }, 90_000, '0.8.7', (message: string) => notices.push(message));
  const url = await pairing.start([0]);
  const config = { version: 1 as const, url, extensionId, token: 'a'.repeat(64) };
  const headers = { 'X-AI-Browser-Extension': extensionId, 'X-Pairing-Secret': 'c'.repeat(64), [chromeChatProtocolHeader]: '1' };
  try {
    const discovery = JSON.parse((await get(config, headers, 'GET', '/discovery')).body);
    assert.equal(discovery.protocolVersion, chromeChatProtocolVersion); assert.equal(discovery.editorVersion, '0.8.7');
    for (let i = 0; i < 2; i++) {
      const response = await get(config, headers, 'POST', '/pair/request-1234');
      assert.equal(response.status, 426); assert.match(JSON.parse(response.body).error, /Update the AI Browser extension for Chrome/);
      assert.equal(JSON.parse(response.body).connection, undefined);
    }
    assert.equal(approvals, 0); assert.equal(notices.length, 1);
    await get(config, { ...headers, [chromeChatProtocolHeader]: String(chromeChatProtocolVersion) }, 'POST', '/pair/request-1234');
    assert.equal(approvals, 1);
  } finally { pairing.dispose(); }
});

test('optional feature mismatch rejects only that feature while chat remains usable', async () => {
  let commands = 0;
  const bridge = new ChromeChatBridge(extensionId, async () => { commands++; });
  const config = await bridge.start(); bridge.update(state());
  const headers = { 'X-AI-Browser-Capabilities': JSON.stringify({ chat: [1], annotations: [2], elements: [2] }), 'Content-Type': 'application/json' };
  const body = { id: 'request-feature-1', chatId: 'chat-1', message: { type: 'send', text: 'hello' } };
  try {
    const snapshot = await get(config, headers);
    assert.equal(snapshot.status, 200);
    assert.deepEqual(JSON.parse(snapshot.body).capabilities.annotations, [1]);
    assert.equal((await get(config, headers, 'POST', '/command', JSON.stringify(body))).status, 200);
    const annotations = await get(config, headers, 'POST', '/annotations', '{}');
    assert.equal(annotations.status, 409); assert.match(JSON.parse(annotations.body).error, /annotations feature/);
    const attachment = { id: 'element-1234', label: 'Element', reference: '@1', text: 'context', kind: 'element' };
    const elements = await get(config, headers, 'POST', '/command', JSON.stringify({ ...body, id: 'request-feature-2', attachments: [attachment] }));
    assert.equal(elements.status, 409); assert.match(JSON.parse(elements.body).error, /elements feature/);
    assert.equal(commands, 1);
    const missingChat = { ...headers, 'X-AI-Browser-Capabilities': JSON.stringify({ chat: [2] }) };
    assert.equal((await get(config, missingChat)).status, 426);
    assert.equal((await get(config, headers)).status, 200, 'a feature mismatch does not revoke the bridge');
  } finally { bridge.close(); }
});

test('resume answers only a remembered key from the extension itself, and lets the owning window go first', async () => {
	const calls: unknown[][] = [];
	const config: ChromeChatConnection = { version: 1, url: 'http://127.0.0.1:1', extensionId, token: 'f'.repeat(64) };
	const pairing = new ChromeChatPairing('Editor', async () => undefined);
	pairing.onResume(async (id: string, key: string, chatId: string | undefined, strict: boolean) => {
		calls.push([id, key, chatId, strict]);
		if (key !== 'b'.repeat(64)) { return undefined; }
		return strict && chatId === 'elsewhere' ? 'elsewhere' : config;
	});
	const url = await pairing.start([0]);
	const target: ChromeChatConnection = { ...config, url, token: 'a'.repeat(64) };
	const resume = (headers: http.OutgoingHttpHeaders) => get(target, { 'X-AI-Browser-Extension': extensionId, Authorization: undefined, ...headers }, 'POST', '/resume');
	try {
		const ok = await resume({ 'X-Resume-Key': 'b'.repeat(64), 'X-Resume-Chat': 'chat-1', 'X-Resume-Strict': '1' });
		assert.equal(ok.status, 200); assert.equal(JSON.parse(ok.body).connection.token, config.token);
		assert.deepEqual(calls[0], [extensionId, 'b'.repeat(64), 'chat-1', true]);
		assert.equal((await resume({ 'X-Resume-Key': 'c'.repeat(64) })).status, 401);
		assert.equal((await resume({ 'X-Resume-Key': 'b'.repeat(64), 'X-Resume-Chat': 'elsewhere', 'X-Resume-Strict': '1' })).status, 409);
		assert.equal((await resume({ 'X-Resume-Key': 'short' })).status, 403);
		const before = calls.length;
		assert.equal((await resume({ 'X-Resume-Key': 'b'.repeat(64), Origin: undefined })).status, 403, 'no browser Origin, no resume');
		assert.equal((await resume({ 'X-Resume-Key': 'b'.repeat(64), Origin: `chrome-extension://${'b'.repeat(32)}` })).status, 403);
		assert.equal(calls.length, before);
	} finally { pairing.dispose(); }
});

test('footer commands validate fields and reject malformed actions', () => {
  const envelope = { id: 'footer-command-1', chatId: 'chat-1' };
  const valid = [
    { type: 'usage' }, { type: 'compact', tabId: 'tab-1' }, { type: 'listCommands', agent: 'codex' },
    { type: 'runToolbarSkill', id: 'skill-1', tabId: 'tab-1', values: { task: 'Review' } },
    { type: 'chooseWorkdir' }, { type: 'setWorkdir', path: '/project' }, { type: 'listWorkdir' },
    { type: 'gitCommit', folder: '/project', tabId: 'tab-1', scope: 'all' },
    { type: 'gitIndexAction', folder: '/project', tabId: 'tab-1', action: 'stage', path: 'file.ts' },
    { type: 'gitBranchName', folder: '/project', tabId: 'tab-1', id: 1 },
    { type: 'gitBranchAction', folder: '/project', action: 'switch', name: 'main' },
    { type: 'gitRemoteAction', folder: '/project', action: 'push' },
    { type: 'openRepo', repo: 'owner/repo', branch: 'main', mode: 'copy' },
    { type: 'repoAction', action: 'push' },
  ];
  for (const message of valid) {
    assert.equal(readChromeChatCommand({ ...envelope, message: { ...message, override: 'discard me' } })?.message.type, message.type);
    assert.equal(readChromeChatCommand({ ...envelope, message: { ...message, override: 'discard me' } })?.message.override, undefined);
  }
  for (const message of [
    { type: 'runToolbarSkill', id: 'skill-1', values: { input: [] } },
    { type: 'setWorkdir', path: 'bad\0path' }, { type: 'gitCommit', folder: '/project', tabId: 'tab-1', scope: 'anything' },
    { type: 'gitRemoteAction', folder: '/project', action: 'forcePush' },
    { type: 'gitBranchAction', folder: '/project', action: 'reset', name: 'main' },
    { type: 'openRepo', repo: 'owner/repo', branch: '', mode: 'execute' }, { type: 'saveToolbarSkill', skill: {} },
  ]) { assert.equal(readChromeChatCommand({ ...envelope, message }), undefined); }
});

test('long footer actions acknowledge immediately, preserve Stop and deliver replayable scoped answers once', async () => {
  let finish!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  let reads = 0, stops = 0;
  const bridge = new ChromeChatBridge(extensionId, async (command: any, reply: (message: unknown) => void) => {
    if (command.message.type === 'stop') { stops++; return; }
    reads++; started(); await waiting;
    reply({ type: 'usage', usage: [], stats: { contextTokens: 1234 }, loading: false });
  });
  const config = await bridge.start(); bridge.update(state());
  const headers = { 'Content-Type': 'application/json', 'X-AI-Browser-Capabilities': JSON.stringify({ chat: [1], usage: [1] }) };
  const body = JSON.stringify({ id: 'footer-usage-123', chatId: 'chat-1', message: { type: 'usage' } });
  try {
    assert.equal((await get(config, headers, 'POST', '/command', body)).status, 200);
    await entered;
    assert.equal((await get(config, headers, 'POST', '/command', body)).status, 200);
    assert.equal(reads, 1, 'a retry does not start the footer operation again');
    const stop = JSON.stringify({ id: 'footer-stop-123', chatId: 'chat-1', message: { type: 'stop' } });
    assert.equal((await get(config, headers, 'POST', '/command', stop)).status, 200);
    assert.equal(stops, 1);
    finish(); await new Promise(resolve => setImmediate(resolve));
    const first = JSON.parse((await get(config, headers, 'GET', '/events?after=0')).body);
    assert.equal(first.events.length, 1); assert.equal(first.events[0].chatId, 'chat-1');
    assert.equal(first.events[0].message.stats.contextTokens, 1234);
    assert.deepEqual(JSON.parse((await get(config, headers, 'GET', '/events?after=0')).body), first, 'a lost response can be fetched again');
    assert.equal(JSON.parse((await get(config, headers, 'GET', `/events?after=${first.cursor}`)).body).events.length, 0);
    assert.equal((await get(config, { Authorization: 'Bearer invalid' }, 'GET', '/events?after=0')).status, 401);
    const old = await get(config, { ...headers, 'X-AI-Browser-Capabilities': JSON.stringify({ chat: [1] }) }, 'POST', '/command', JSON.stringify({ id: 'footer-usage-456', chatId: 'chat-1', message: { type: 'usage' } }));
    assert.equal(old.status, 409); assert.match(JSON.parse(old.body).error, /usage feature/);
  } finally { finish(); bridge.close(); }
});

test('automatic bridge replacement shares command receipts and late footer results', async () => {
  const { ChromeChatDelivery } = load('chromeChatBridge');
  const delivery = new ChromeChatDelivery();
  let sends = 0, finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const execute = async (command: any, reply: (message: unknown) => void) => {
    if (command.message.type === 'send') { sends++; return; }
    await gate; reply({ type: 'usage', usage: [], loading: false });
  };
  const first = new ChromeChatBridge(extensionId, execute, '0.8.9', delivery);
  const resumed = new ChromeChatBridge(extensionId, execute, '0.8.9', delivery);
  const a = await first.start(); first.update(state());
  const headers = { 'Content-Type': 'application/json', 'X-AI-Browser-Capabilities': JSON.stringify({ chat: [1], usage: [1] }) };
  const body = JSON.stringify({ id: 'resumable-send-1', chatId: 'chat-1', message: { type: 'send', text: 'once' } });
  try {
    assert.equal((await get(a, headers, 'POST', '/command', body)).status, 200);
    assert.equal((await get(a, headers, 'POST', '/command', JSON.stringify({ id: 'resumable-usage-1', chatId: 'chat-1', message: { type: 'usage' } }))).status, 200);
    first.close();
    const b = await resumed.start(); resumed.update(state());
    assert.equal(a.deliverySession, b.deliverySession);
    assert.equal((await get(b, headers, 'POST', '/command', body)).status, 200);
    assert.equal(sends, 1, 'accepted sends do not execute again after a lost response and resume');
    finish(); await new Promise(resolve => setImmediate(resolve));
    const events = JSON.parse((await get(b, headers, 'GET', '/events?after=0')).body);
    assert.equal(events.events[0].message.type, 'usage', 'late answers survive replacement of their original bridge');
  } finally { finish(); first.close(); resumed.close(); }
});

test('an authenticated but unavailable resume target returns 503 instead of revoking the grant', async () => {
  const pairing = new ChromeChatPairing('Editor', async () => undefined);
  pairing.onResume(async () => 'unavailable');
  const url = await pairing.start([0]);
  try {
    const response = await get({ version: 1, url, extensionId, token: 'a'.repeat(64) }, {
      'X-AI-Browser-Extension': extensionId, 'X-Resume-Key': 'f'.repeat(64),
    }, 'POST', '/resume');
    assert.equal(response.status, 503);
  } finally { pairing.dispose(); }
});


test('Chrome presence expires after polling stops and returns on an unchanged snapshot', async () => {
	const bridge = new ChromeChatBridge(extensionId);
	const config = await bridge.start();
	const surfaces = new ChatStateSurfaces();
	let changes = 0;
	const attachment = surfaces.attach(bridge, () => state(), () => { changes++; });
	try {
		assert.equal(surfaces.chatIds(state().chatId).size, 0);
		assert.equal((await get(config, { Authorization: '' })).status, 401);
		assert.equal(bridge.active, false);
		const first = await get(config);
		assert.equal(surfaces.chatIds(state().chatId).has(state().chatId), true);
		await new Promise(resolve => setTimeout(resolve, 10_100));
		assert.equal(bridge.active, false);
		assert.equal(surfaces.chatIds(state().chatId).size, 0);
		assert.equal((await get(config, { 'If-None-Match': first.headers.etag })).status, 304);
		assert.equal(surfaces.chatIds(state().chatId).has(state().chatId), true);
		assert.equal(changes, 4);
	} finally { attachment.dispose(); bridge.close(); }
});

test('only Chrome bridges mark a conversation as open in Chrome', () => {
	const surfaces = new ChatStateSurfaces();
	const website = { kind: 'exchange' as const, active: true, chatId: 'chat-1', update() {}, close() {} };
	const attachment = surfaces.attach(website, () => state());
	try {
		assert.equal(surfaces.chatIds('chat-1').has('chat-1'), true);
		assert.equal(surfaces.chatIds('chat-1', 'chrome').size, 0);
	} finally { attachment.dispose(); }
});

test('Chrome cannot configure server credentials or receive local server settings', () => {
	const envelope = { id: 'request-1234', chatId: 'chat-1' };
	assert.equal(readChromeChatCommand({ ...envelope, message: { type: 'connectExchange', url: 'https://server.example', pointId: 'point', key: 'secret' } }), undefined);
	assert.equal(readChromeChatCommand({ ...envelope, message: { type: 'disconnectExchange' } }), undefined);
	const snapshot = chromeChatSnapshot({ chatId: 'chat-1', entries: [], tabs: [], voice: {}, agents: [],
		exchangeConnection: { url: 'https://private-server.example', pointId: 'private-point', hasKey: true, status: 'connected' },
	});
	assert.equal(snapshot.view.exchangeConnection, undefined);
	assert.equal(JSON.stringify(snapshot).includes('private-server'), false);
});

test('a remote snapshot carries only classified fields, with the surface and its control map', () => {
	const snapshot = chromeChatSnapshot({ chatId: 'chat-1', entries: [], tabs: [], voice: {}, agents: [],
		dragToken: 'secret-drag', panel: { id: 'p' }, exchangeConnection: { status: 'connected' }, somethingNew: '/Users/me/secret' } as never);
	assert.equal(snapshot.view.dragToken, undefined);
	assert.equal(snapshot.view.panel, undefined);
	assert.equal(snapshot.view.exchangeConnection, undefined);
	assert.equal((snapshot.view as any).somethingNew, undefined, 'an unclassified field must not leave the editor');
	assert.equal(snapshot.view.surface, 'chrome');
	assert.deepEqual(snapshot.view.controls?.setApprovalMode?.s, 'off');
	assert.equal(snapshot.view.controls?.voiceStart?.s, 'hidden');
	assert.equal(snapshot.view.controls?.send, undefined);
});

test('an unchanged snapshot request is held until the state changes, then answered at once', async () => {
	const bridge = new ChromeChatBridge(extensionId);
	const config = await bridge.start();
	try {
		const view = state(); bridge.update(view);
		const etag = (await get(config)).headers.etag!;
		const started = Date.now();
		const held = get(config, { 'If-None-Match': etag, 'X-AI-Browser-Wait': '1000' });
		setTimeout(() => { (view.entries[0] as { text: string }).text = 'Changed'; bridge.update(view); }, 150);
		const answer = await held;
		assert.equal(answer.status, 200);
		assert.equal(answer.headers['x-ai-browser-wait'], '1000');
		assert.ok(Date.now() - started < 900, 'answered when the state changed, not at the timeout');
		const idle = Date.now();
		const timedOut = await get(config, { 'If-None-Match': answer.headers.etag, 'X-AI-Browser-Wait': '300' });
		assert.equal(timedOut.status, 304);
		assert.ok(Date.now() - idle >= 250);
		assert.equal((await get(config, { 'If-None-Match': answer.headers.etag })).status, 304, 'without the header nothing is held');
	} finally { bridge.close(); }
});

test('a panel that names the revision it shows gets a patch of the view, and a stranger the whole snapshot', async () => {
	const { applyPatch } = load('core/sync');
	const bridge = new ChromeChatBridge(extensionId);
	const config = await bridge.start();
	try {
		const view = state();
		(view as any).entries = Array.from({ length: 40 }, (_, i) => ({ kind: 'assistant', text: `answer ${i} `.repeat(20) }));
		bridge.update(view);
		const first = await get(config);
		const epoch = first.headers['x-ai-browser-base'] as string;
		assert.match(epoch, /^[0-9a-f]{16}$/);
		const rev = Number(String(first.headers.etag).replace(/"/g, ''));
		(view as any).entries[39] = { kind: 'assistant', text: 'streaming on' };
		bridge.update(view);
		const patched = JSON.parse((await get(config, { 'X-AI-Browser-Base': `${epoch}:${rev}` })).body);
		assert.ok(patched.patch, 'a patch, not the whole snapshot');
		assert.equal(patched.patch.entries.from, 39);
		const result = applyPatch(JSON.parse(first.body).view, rev, patched.patch);
		assert.equal(result.entries[39].text, 'streaming on');
		assert.equal(patched.top.chatId, 'chat-1');
		assert.ok(JSON.parse((await get(config, { 'X-AI-Browser-Base': `0000000000000000:${rev}` })).body).view, 'another epoch gets the whole snapshot');
		assert.ok(JSON.parse((await get(config)).body).view, 'no header gets the whole snapshot');
	} finally { bridge.close(); }
});
