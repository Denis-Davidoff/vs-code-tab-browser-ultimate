import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import type { AgentEvent } from './agentProtocol.ts';
import type { AgentBackend, TurnInput } from './agents.ts';
import type { TabHost } from './chatTab.ts';

const nativeRequire = createRequire(resolve('package.json'));
function load<T>(file: string, dependencies: Record<string, unknown> = {}, globals: Record<string, unknown> = {}): T {
	const code = transpileModule(readFileSync(resolve(file), 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
	const exports = {};
	runInNewContext(code, { exports, process, Buffer, setTimeout, clearTimeout,
		require: (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : nativeRequire(name), ...globals });
	return exports as T;
}
const protocol = load<typeof import('./agentProtocol.ts')>('src/chat/agentProtocol.ts');
const capacity = 'Selected model is at capacity. Please try a different model.';
function fixture(agent: 'codex' | 'claude' = 'codex') {
	const timers = new Map<number, { delay: number; callback: () => void }>();
	let timerId = 0;
	const { ChatTab, newChat, transientTurnError } = load<typeof import('./chatTab.ts')>('src/chat/chatTab.ts', {
		vscode: { l10n: { t: (text: string, ...args: unknown[]) => text.replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index)])) } },
		'./agentProtocol': protocol, './agents': { agentNames: { codex: 'Codex', claude: 'Claude Code' } },
		'../core/uuid': { generateUuid: () => 'test-chat' }, './toolbarText': {},
		'./attachmentReferences': load('src/chat/attachmentReferences.ts'),
	}, {
		setTimeout: (callback: () => void, delay: number) => { timers.set(++timerId, { delay, callback }); return timerId; },
		clearTimeout: (id: number) => timers.delete(id),
	});
	const sent: { input: TurnInput; model: string; effort?: string }[] = [];
	const session = {
		running: false, ref: 'existing-conversation',
		async send(input: TurnInput, model: string, effort?: string) { sent.push({ input, model, effort }); this.running = true; return true; },
		stop() { this.running = false; }, dispose() {},
	};
	const host: TabHost = {
		cwd: () => '/tmp', projectRoot: () => undefined, ownSettings: () => true,
		changed() {}, limits() {}, turnEnded() {}, save: async () => {}, inHistory: () => false,
		approvalMode: () => 'ask', noteServer() {}, released() {},
	};
	const tab = new ChatTab(host, newChat(agent));
	Reflect.set(tab, '_session', session);
	const consume = Reflect.get(tab, '_onAgentEvent') as (event: AgentEvent) => void;
	const event = (event: AgentEvent) => {
		if (event.type === 'turnEnd') { session.running = false; }
		consume.call(tab, event);
	};
	const end = (error?: string) => {
		const events = agent === 'codex'
			? protocol.codexEvents('turn/completed', { turn: { status: error ? 'failed' : 'completed', error: { message: error } } })
			: protocol.claudeEvents({ type: 'result', subtype: error ? 'error_during_execution' : 'success', is_error: !!error, result: error ?? '' });
		events.forEach(event);
	};
	const start = () => tab.send('Complete the task using @1', [{ chip: { id: 'image', kind: 'screenshot', label: 'Screenshot' }, image: { mediaType: 'image/png', base64: 'test' } }], agent, 'chosen-model', 'high', {} as AgentBackend);
	const tick = async () => {
		const [id, timer] = timers.entries().next().value!;
		assert.ok(timer, 'a retry was scheduled');
		timers.delete(id);
		timer.callback();
		await Promise.resolve(); await Promise.resolve();
		return timer.delay;
	};
	return { tab, session, sent, timers, event, end, start, tick, transientTurnError };
}

for (const agent of ['codex', 'claude'] as const) {
	test(`${agent}: capacity errors continue the same conversation after 5, 15, 60 seconds, then stop`, async () => {
		const f = fixture(agent);
		await f.start();
		f.event({ type: 'thinking', text: 'Working' });
		const thinking = f.tab.chat.entries.find(e => e.kind === 'thinking');
		assert.equal(f.timers.size, 0);
		for (const delay of [5000, 15000, 60000]) {
			f.end(capacity);
			assert.ok(thinking?.kind === 'thinking' && thinking.endedAt !== undefined);
			assert.equal(f.tab.busy, true, 'Stop remains available during the wait');
			assert.equal(await f.tick(), delay);
			const sent = f.sent.at(-1)!;
			assert.match(sent.input.text, /^Continue the last user request/);
			assert.equal(sent.input.images.length, 0);
			assert.equal(sent.model, 'chosen-model'); assert.equal(sent.effort, 'high');
			assert.equal(f.session.ref, 'existing-conversation');
		}
		f.end(capacity);
		assert.equal(f.sent.length, 4, 'original plus exactly three retries');
		assert.equal(f.timers.size, 0); assert.equal(f.tab.busy, false);
		assert.equal(f.tab.chat.entries.filter(e => e.kind === 'user').length, 1);
		assert.equal(f.tab.chat.entries.filter(e => e.kind === 'error').length, 1);
	});
}

test('streamed errors do not interrupt a live turn or compete with built-in retries', async () => {
	const f = fixture(); await f.start();
	protocol.codexEvents('error', { error: { message: capacity }, willRetry: true }).forEach(f.event);
	protocol.codexEvents('error', { error: { message: capacity }, willRetry: false }).forEach(f.event);
	assert.equal(f.timers.size, 0); assert.equal(f.sent.length, 1); assert.equal(f.session.running, true);
	f.end(); assert.equal(f.timers.size, 0); assert.equal(f.tab.busy, false);
});

test('a successful continuation ends the retry chain and allows the queue to drain', async () => {
	const f = fixture(); await f.start(); f.end(capacity);
	await f.tick(); f.end();
	assert.equal(f.timers.size, 0); assert.equal(f.tab.busy, false);
	assert.equal(f.tab.chat.entries.filter(e => e.kind === 'error').length, 0);
});

for (const action of ['stop', 'new message', 'close', 'open another chat'] as const) {
	test(`${action} cancels a pending automatic continuation`, async () => {
		const f = fixture(); await f.start(); f.end(capacity);
		if (action === 'stop') { f.tab.stop(); }
		if (action === 'new message') { await f.start(); }
		if (action === 'close') { f.tab.close(); }
		if (action === 'open another chat') { f.tab.start({ ...f.tab.chat, id: 'other-chat', entries: [] }); }
		assert.equal(f.timers.size, 0);
		assert.equal(f.sent.length, action === 'new message' ? 2 : 1);
	});
}

test('an active turn never receives an automatic steer and waiting does not consume attempts', async () => {
	const f = fixture(); await f.start(); f.end(capacity);
	f.session.running = true;
	assert.equal(await f.tick(), 5000); assert.equal(f.sent.length, 1);
	assert.equal(await f.tick(), 1000); assert.equal(f.sent.length, 1);
	f.session.running = false;
	await f.tick(); assert.equal(f.sent.length, 2);
	f.end(capacity); assert.equal(await f.tick(), 15000);
});

test('non-transient errors and user interruption stay stopped', async () => {
	for (const error of ['Stopped.', 'Invalid API key', '401 Unauthorized', '403 Forbidden', '429 insufficient_quota', 'Rate limit reached: resets in 5 hours', 'You have hit your usage limit', 'Model not found', 'Permission denied']) {
		const f = fixture(); await f.start(); f.end(error);
		assert.equal(f.timers.size, 0, error); assert.equal(f.tab.busy, false, error);
	}
});

test('temporary overload, throttling and service failures are recognized', () => {
	const { transientTurnError } = fixture();
	for (const error of [capacity, 'overloaded_error', 'API Error: 529 overloaded', '429 Too many requests', 'rate_limit_error', '503 Service unavailable', '502 Bad gateway', 'Internal server error', 'Connection reset', 'Request timed out']) {
		assert.equal(transientTurnError(error), true, error);
	}
});

test('Claude context compaction still resends the original prompt and images', async () => {
	const f = fixture('claude'); await f.start();
	f.event({ type: 'turnEnd', error: 'Prompt is too long', tooLong: true });
	assert.equal(await f.tick(), 5000);
	assert.equal(f.sent[1].input, f.sent[0].input);
});

test('a transient failure to start the continuation uses the next delay', async () => {
	const f = fixture(); await f.start(); f.end(capacity);
	f.session.send = async () => { throw new Error('503 Service unavailable'); };
	assert.equal(await f.tick(), 5000);
	assert.equal(await f.tick(), 15000);
	assert.equal(await f.tick(), 60000);
	assert.equal(f.timers.size, 0); assert.equal(f.tab.busy, false);
	assert.equal(f.tab.chat.entries.filter(e => e.kind === 'error').length, 1);
});

test('Stop during a continuation start prevents a late rejection from restarting it', async () => {
	const f = fixture(); await f.start(); f.end(capacity);
	let reject!: (error: Error) => void;
	f.session.send = () => { f.session.running = true; return new Promise<boolean>((_, fail) => { reject = fail; }); };
	await f.tick();
	f.tab.stop();
	reject(new Error('503 Service unavailable'));
	await Promise.resolve(); await Promise.resolve();
	assert.equal(f.timers.size, 0); assert.equal(f.tab.busy, false);
});

test('automatic continuation preserves an explicitly paused queue', async () => {
	const f = fixture(); await f.start();
	f.tab.pause('user'); f.end(capacity);
	await f.tick(); f.end();
	assert.equal(f.tab.paused?.by, 'user');
	assert.equal(f.tab.busy, false);
});
