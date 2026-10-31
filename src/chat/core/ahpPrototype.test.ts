import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import * as core from './sessionHost.ts';

// Production imports use extensionless CommonJS paths; Node's TS test loader does not.
const exports: Record<string, unknown> = {};
runInNewContext(transpileModule(readFileSync('src/chat/core/ahpPrototype.ts', 'utf8'), {
	compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText, { exports, require: () => core });
const { AhpPrototypeConnection } = exports as unknown as typeof import('./ahpPrototype');
const root = 'ahp-root://', channel = core.sessionChannel('chat');
const state: core.SessionState = { id: 'chat', title: 'Task', agent: 'codex', directory: '/project', running: true,
	entries: [{ kind: 'assistant', id: 'reply', text: 'Hello' }], pendingSends: [] };
function request(method: string, params: Record<string, unknown> = { channel: root }, id = 1) { return { jsonrpc: '2.0', id, method, params }; }
function initialize() { return request('initialize', { channel: root, clientId: 'display-id', protocolVersions: ['1.0.0'], initialSubscriptions: [root, channel] }); }

type SyncResult = {
	readonly snapshot?: core.SessionSnapshot;
	readonly snapshots?: readonly core.SessionSnapshot[];
	readonly actions?: readonly { readonly action: { readonly change: core.SessionAction } }[];
};

for (const operation of ['initialize', 'subscribe', 'replay', 'snapshot'] as const) {
	test(`${operation} delivers its base before a publish preceding request completion`, async () => {
		const host = new core.SessionHost({ replayLimit: operation === 'snapshot' ? 0 : 256 });
		host.publish(state);
		let clientState: core.SessionState | undefined;
		const deliveries: string[] = [];
		const client = new AhpPrototypeConnection(host, { clientKey: 'peer', canRead: () => true, canControl: () => false,
			send(message) {
				if ('method' in message) {
					deliveries.push('action');
					clientState = core.reduceSession(clientState, message.params.action.change);
					return;
				}
				deliveries.push('reply');
				const result = message.result as SyncResult | undefined;
				for (const snapshot of [...(result?.snapshots ?? []), ...(result?.snapshot ? [result.snapshot] : [])]) {
					if (snapshot.resource === channel) { clientState = snapshot.state; }
				}
				for (const event of result?.actions ?? []) { clientState = core.reduceSession(clientState, event.action.change); }
			} });
		try {
			let syncRequest = initialize();
			if (operation === 'subscribe') {
				await client.receive(request('initialize', { ...syncRequest.params, initialSubscriptions: [root] }));
				syncRequest = request('subscribe', { channel });
			} else if (operation === 'replay' || operation === 'snapshot') {
				await client.receive(syncRequest);
				const cursor = host.serverSeq;
				await client.receive(request('unsubscribe', { channel }));
				host.publish({ ...state, title: 'Offline update' });
				syncRequest = request('reconnect', { channel: root, clientId: 'display-id', subscriptions: [channel], lastSeenServerSeq: cursor });
			}
			deliveries.length = 0;
			const completion = client.receive(syncRequest);
			host.publish({ ...state, title: 'Update before completion' });
			await completion;
			host.publish({ ...state, title: 'Final update' });
			assert.deepEqual(deliveries, ['reply', 'action', 'action']);
			assert.deepEqual(clientState, host.snapshot(channel)!.state);
			assert.equal(host.observed, true, 'the reducer must not lose its subscription');
		} finally { client.dispose(); host.dispose(); }
	});
}

test('publishing reentrantly during snapshot delivery waits until its callback finishes', async () => {
	const host = new core.SessionHost(); host.publish(state);
	let clientState: core.SessionState | undefined;
	const order: string[] = [];
	const client = new AhpPrototypeConnection(host, { clientKey: 'peer', canRead: () => true, canControl: () => false,
		send(message) {
			if ('method' in message) {
				order.push('action'); clientState = core.reduceSession(clientState, message.params.action.change);
			} else {
				order.push('snapshot start');
				host.publish({ ...state, title: 'Reentrant update' });
				clientState = (message.result as SyncResult).snapshots!.find(snapshot => snapshot.resource === channel)!.state;
				order.push('snapshot end');
			}
		} });
	try {
		await client.receive(initialize());
		assert.deepEqual(order, ['snapshot start', 'snapshot end', 'action']);
		assert.deepEqual(clientState, host.snapshot(channel)!.state);
		assert.equal(host.observed, true);
	} finally { client.dispose(); host.dispose(); }
});

test('queued notifications recheck authorization before delivery', async () => {
	const host = new core.SessionHost(); host.publish(state);
	let readable = true, notifications = 0;
	const client = new AhpPrototypeConnection(host, { clientKey: 'peer', canRead: () => readable, canControl: () => false,
		send(message) {
			if ('method' in message) { notifications++; }
			else { host.publish({ ...state, title: 'Queued update' }); readable = false; }
		} });
	try {
		await client.receive(initialize());
		assert.equal(notifications, 0);
	} finally { client.dispose(); host.dispose(); }
});

test('async controls keep live updates flowing and deliver their reply after execution', async () => {
	let finish!: () => void;
	const host = new core.SessionHost({ execute: () => new Promise<void>(resolve => { finish = resolve; }) });
	host.publish(state);
	const messages: string[] = [];
	const client = new AhpPrototypeConnection(host, { clientKey: 'peer', canRead: () => true, canControl: () => true,
		send: message => { messages.push('method' in message ? 'action' : 'reply'); } });
	try {
		await client.receive(initialize()); messages.length = 0;
		const completion = client.receive(request('x-ai-browser/stop', { channel, chatId: 'chat', commandId: 1 }));
		await Promise.resolve();
		host.publish({ ...state, title: 'While control is pending' });
		assert.deepEqual(messages, ['action']);
		finish();
		assert.ok((await completion)?.result);
		assert.deepEqual(messages, ['action', 'reply']);
	} finally { client.dispose(); host.dispose(); }
});

test('failed outbound delivery closes the connection without retrying its callback', async () => {
	const host = new core.SessionHost(); host.publish(state);
	let sends = 0;
	const client = new AhpPrototypeConnection(host, { clientKey: 'peer', canRead: () => true, canControl: () => false,
		send() { sends++; throw new Error('Transport failed'); } });
	try {
		assert.ok((await client.receive(initialize()))?.error);
		host.publish({ ...state, title: 'Later' });
		assert.equal(sends, 1);
		assert.equal(host.observed, false);
	} finally { client.dispose(); host.dispose(); }
});

test('two initialized clients receive the same stream and reconnect with filtered replay', async () => {
	const host = new core.SessionHost(); host.publish(state);
	const seen: unknown[][] = [[], []];
	const clients = seen.map((events, index) => new AhpPrototypeConnection(host, { clientKey: `peer-${index}`, canRead: () => true, canControl: () => false, send: event => { if ('method' in event) { events.push(event); } } }));
	for (const client of clients) { assert.ok((await client.receive(initialize()))?.result); }
	const cursor = host.serverSeq;
	host.publish({ ...state, entries: [{ kind: 'assistant', id: 'reply', text: 'Hello there' }] });
	assert.equal(JSON.stringify(seen[0]), JSON.stringify(seen[1]));
	assert.ok(JSON.stringify(seen[0]).includes('x-ai-browser/sessionChanged'));
	const recovered = await clients[1].receive(request('reconnect', { channel: root, clientId: 'display-id', subscriptions: [channel], lastSeenServerSeq: cursor }));
	assert.ok(JSON.stringify(recovered).includes('"type":"replay"'));
	clients[0].dispose(); clients[1].dispose();
	host.publish({ ...state, title: 'Later' });
	assert.equal(seen[0].length, 1);
});

test('revoked access blocks snapshots, replay, discovery, commands and live events', async () => {
	let readable = true, calls = 0;
	const host = new core.SessionHost({ execute: () => { calls++; } }); host.publish(state);
	const events: unknown[] = [];
	const client = new AhpPrototypeConnection(host, { clientKey: 'trusted-peer', canRead: value => value === root || readable, canControl: () => true, send: event => { if ('method' in event) { events.push(event); } } });
	await client.receive(initialize()); readable = false;
	host.publish({ ...state, title: 'Secret' });
	assert.equal(events.length, 0);
	assert.ok((await client.receive(request('subscribe', { channel })))?.error);
	assert.ok((await client.receive(request('reconnect', { channel: root, clientId: 'display-id', subscriptions: [channel], lastSeenServerSeq: 0 })))?.error);
	assert.equal(JSON.stringify((await client.receive(request('x-ai-browser/listSessions')))?.result), '{"sessions":[]}');
	assert.ok((await client.receive(request('x-ai-browser/stop', { channel, chatId: 'chat', commandId: 1 })))?.error);
	assert.equal(calls, 0);
});

test('version checks, malformed requests, notifications and default-denied controls fail safely', async () => {
	let calls = 0;
	const host = new core.SessionHost({ execute: () => { calls++; } }); host.publish(state);
	const client = new AhpPrototypeConnection(host, { clientKey: 'peer', canRead: () => true, canControl: () => false, send() {} });
	assert.equal((await client.receive(null))?.error?.code, -32600);
	assert.ok((await client.receive(request('subscribe', { channel })))?.error);
	const wrong = initialize(); wrong.params.protocolVersions = ['0.0.0'];
	assert.equal((await client.receive(wrong))?.error?.code, -32005);
	assert.ok((await client.receive(initialize()))?.result);
	assert.equal((await client.receive(request('dispatchAction', { channel, action: { type: 'session/removed' } })))?.error?.code, -32601);
	assert.equal(await client.receive({ jsonrpc: '2.0', method: 'x-ai-browser/stop', params: { channel, chatId: 'chat', commandId: 1 } }), undefined);
	assert.ok((await client.receive(request('x-ai-browser/stop', { channel, chatId: 'chat', commandId: 1 })))?.error);
	assert.equal(calls, 0);
});

test('authorized controls deduplicate across reconnects by authenticated peer, never by display id', async () => {
	let calls = 0;
	const host = new core.SessionHost({ execute: () => { calls++; } }); host.publish(state);
	const make = () => new AhpPrototypeConnection(host, { clientKey: 'same-authenticated-peer', canRead: () => true, canControl: () => true, send() {} });
	const first = make(); await first.receive(initialize());
	const stop = request('x-ai-browser/stop', { channel, chatId: 'chat', commandId: 1 });
	assert.ok((await first.receive(stop))?.result); first.dispose();
	const second = make(); await second.receive(initialize());
	assert.ok((await second.receive(stop))?.result);
	assert.equal(calls, 1);
	assert.ok((await second.receive(request('x-ai-browser/stop', { channel, chatId: 'other', commandId: 2 })))?.error);
	assert.ok((await second.receive(request('x-ai-browser/stop', { channel, chatId: 'chat', commandId: 2, shell: 'danger' })))?.error);
	assert.equal(calls, 1);
});
