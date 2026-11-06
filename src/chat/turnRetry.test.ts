import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { CodexShells } from './codexShells.ts';
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
		'./messageFiles': load('src/chat/messageFiles.ts'),
		'./visualizationProtocol': load('src/chat/visualizationProtocol.ts'), './visualizationStore': load('src/chat/visualizationStore.ts'),
		'../core/notifyText': load('src/core/notifyText.ts'), './terminalPins': load('src/chat/terminalPins.ts'),
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
	Reflect.set(tab, '_sessionOpenedAt', Date.now());
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
	return { tab, session, sent, timers, event, end, start, tick, transientTurnError, host,
		makeTab: (chat = newChat(agent)) => new ChatTab(host, chat) };
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

test('Ultracode survives automatic continuation without changing effort', async () => {
	const f = fixture('claude');
	await f.tab.send('Complete the task', [], 'claude', 'chosen-model', 'low', {} as AgentBackend, undefined, true);
	assert.equal(f.sent[0].input.ultracode, true);
	f.end(capacity); await f.tick();
	assert.equal(f.sent[1].input.ultracode, true);
	assert.equal(f.sent[1].effort, 'low');
});

test('Claude launches Ultracode independently and preserves tool approval settings', async () => {
	class Emitter<T> {
		private listeners: ((event: T) => void)[] = [];
		event = (listener: (event: T) => void) => { this.listeners.push(listener); return { dispose() {} }; };
		fire(event: T) { this.listeners.forEach(fn => fn(event)); }
		dispose() {}
	}
	const processes: FakeProcess[] = [];
	class FakeProcess {
		readonly messages = new Emitter<Record<string, unknown>>();
		readonly exits = new Emitter<string>();
		onMessage = this.messages.event;
		onExit = this.exits.event;
		exited = false;
		readonly args: string[];
		constructor(_binary: string, args: string[]) { this.args = args; processes.push(this); }
		send() {}
		dispose() { this.exited = true; }
	}
	const { ClaudeBackend } = load<typeof import('./claudeAgent.ts')>('src/chat/claudeAgent.ts', {
		vscode: { EventEmitter: Emitter, l10n: { t: (text: string) => text } },
		'./agentProtocol': protocol, './agentProcess': { JsonLineProcess: FakeProcess },
		'./agentProcesses': { agentProcesses: { environment: () => ({}) } },
		'./autoTitle': {}, './commitMessage': {}, '../core/safeFiles': {},
		'../core/uuid': {}, '../core/chatCapability': {},
	});
	const backend = new ClaudeBackend('unused-test-binary', () => '/tmp');
	const session = backend.openSession('/tmp');
	try {
		await session.send({ text: 'Task', images: [], ultracode: true }, 'opus', 'low');
		const first = processes[0];
		assert.equal(first.args.filter(arg => arg === '--settings').length, 1);
		const settings = JSON.parse(first.args[first.args.indexOf('--settings') + 1]);
		assert.equal(settings.ultracode, true);
		assert.ok(settings.permissions.ask.length > 0, 'workflow mode retains mandatory approval rules');
		assert.equal(first.args[first.args.indexOf('--effort') + 1], 'low');
		first.messages.fire({ type: 'result', subtype: 'success', result: '' });
		await session.send({ text: 'Next task', images: [], ultracode: false }, 'opus', 'low');
		assert.equal(processes.length, 2, 'changing only Ultracode restarts an idle process');
		assert.equal(first.exited, true);
		const second = processes[1];
		assert.equal(JSON.parse(second.args[second.args.indexOf('--settings') + 1]).ultracode, false);
		assert.equal(second.args[second.args.indexOf('--effort') + 1], 'low');
	} finally { backend.dispose(); }
});


test('each chat snapshots the latest UltraCode default and retains its own setting', () => {
	const f = fixture('claude');
	let defaultMode = true;
	f.host.ultracodeDefault = () => defaultMode;
	const first = f.makeTab();
	assert.equal(first.chat.ultracode, true);
	defaultMode = false;
	const second = f.makeTab();
	assert.equal(second.chat.ultracode, false);
	assert.equal(first.chat.ultracode, true, 'changing the default does not change an existing tab');
	first.chat.ultracode = false;
	defaultMode = true;
	const restored = f.makeTab(JSON.parse(JSON.stringify(first.chat)));
	assert.equal(restored.chat.ultracode, false, 'saved false is not replaced by a true default');
	first.start({ ...second.chat });
	assert.equal(first.chat.ultracode, false, 'opening another conversation keeps its own mode');
});

test('toggling UltraCode updates only the active chat and the default for future tabs', () => {
	const source = readFileSync('src/chat/chatView.ts', 'utf8');
	const method = /private _select\([\s\S]*?\n\t\}/.exec(source)![0].replace('private ', '');
	let saved: { ultracode?: boolean } = { ultracode: false };
	const select = runInNewContext(transpileModule(`({ ${method} })`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, { selectionKey: 'selection' })._select;
	const first = { chat: { ultracode: false }, started: false };
	const second = { chat: { ultracode: false }, started: false };
	const host = {
		_active: first, _remembered: { models: {}, efforts: {}, ultracode: false },
		_context: { globalState: { get: () => saved, update: async (_key: string, value: typeof saved) => { saved = value; } } },
		_selection: () => ({ agent: 'claude' }), _save: async () => {}, _saveTabs() {}, _post() {},
	};
	select.call(host, { agent: 'claude', ultracode: true });
	assert.equal(first.chat.ultracode, true);
	assert.equal(second.chat.ultracode, false);
	assert.equal(saved.ultracode, true);
	host._active = second;
	select.call(host, { agent: 'claude', ultracode: false });
	assert.equal(first.chat.ultracode, true);
	assert.equal(second.chat.ultracode, false);
	assert.equal(saved.ultracode, false);
});

 test('sent attachments retain serializable opening data after the composer is cleared', async () => {
	const f = fixture();
	const chip = { id: 'note', kind: 'annotation' as const, label: 'Note' };
	await f.tab.send('Read it', [{ chip, text: 'Original note', file: { toString: () => 'file:///tmp/note.txt' } as any }], 'codex', 'chosen-model', undefined, {} as AgentBackend);
	f.tab.attachments = [];
	const entry = JSON.parse(JSON.stringify(f.tab.chat.entries.find(e => e.kind === 'user')));
	assert.equal(entry.attachmentData[0].text, 'Original note');
	assert.equal(entry.attachmentData[0].file, 'file:///tmp/note.txt');
	assert.equal(entry.attachmentData[0].chip.id, 'note');
	chip.label = 'Changed';
	assert.equal(entry.attachmentData[0].chip.label, 'Note');
});


test('native background Bash survives the parent turn and ends on its task notification without agent fields', async () => {
	const f = fixture('claude');
	await f.start();
	const tasks = new Map<string, string>();
	const send = (message: Record<string, unknown>) => protocol.claudeEvents(message, tasks).forEach(f.event);
	send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'shell', name: 'Bash', input: { command: 'npm run dev', run_in_background: true } }] } });
	send({ type: 'system', subtype: 'task_started', tool_use_id: 'shell', task_id: 'task', task_type: 'local_bash', is_backgrounded: true });
	send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'shell', content: 'Server output' }] } });
	f.end();
	const entry = f.tab.chat.entries.find(e => e.kind === 'tool' && e.id === 'shell');
	assert.ok(entry?.kind === 'tool');
	assert.equal(entry.status, 'running');
	assert.equal(entry.agent, undefined);
	assert.equal(f.tab.agentsRunning, 0);
	send({ type: 'system', subtype: 'task_progress', task_id: 'task', usage: { total_tokens: 12 } });
	assert.equal(entry.status, 'running');
	send({ type: 'system', subtype: 'task_notification', task_id: 'task', status: 'completed', summary: 'Server finished' });
	assert.equal(entry.status, 'done');
	assert.equal(entry.output, 'Server output', 'a task summary must not replace the command output');
	assert.equal(entry.agent, undefined);
	assert.ok(entry.endedAt);
	f.tab.discard();
});

test('a foreground Bash task moved to the background survives a turn, then stops with its session', async () => {
	const f = fixture('claude');
	await f.start();
	const tasks = new Map<string, string>();
	const send = (message: Record<string, unknown>) => protocol.claudeEvents(message, tasks).forEach(f.event);
	send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'shell', name: 'Bash', input: { command: 'npm run dev' } }] } });
	send({ type: 'system', subtype: 'task_started', tool_use_id: 'shell', task_id: 'task', task_type: 'local_bash', is_backgrounded: false });
	send({ type: 'system', subtype: 'task_updated', task_id: 'task', patch: { is_backgrounded: true } });
	f.end();
	const entry = f.tab.chat.entries.find(e => e.kind === 'tool' && e.id === 'shell');
	assert.ok(entry?.kind === 'tool' && entry.status === 'running');
	f.tab.close();
	assert.equal(entry.status, 'stopped');
});

test('Codex dev server survives turnEnd, write_stdin appends to that row, and only exit completes it', async () => {
	const f = fixture('codex');
	await f.start();
	const shells = new CodexShells(protocol.codexEvents);
	const send = (method: string, params: Record<string, unknown>) => shells.events(method, { threadId: 'thread', ...params }).forEach(f.event);
	const server = { type: 'commandExecution', id: 'server', command: '/bin/zsh -lc "npm run dev"', processId: '6761', source: 'unifiedExecStartup', status: 'inProgress' };
	send('item/started', { item: server });
	send('item/commandExecution/outputDelta', { itemId: 'server', delta: 'Ready\n' });
	f.end();
	const row = f.tab.chat.entries.find(e => e.kind === 'tool' && e.id === 'server');
	assert.ok(row?.kind === 'tool');
	assert.equal(row.status, 'running');
	assert.equal(row.endedAt, undefined);
	assert.equal(row.shell?.processId, '6761');
	assert.equal(row.shell?.background, true);
	assert.equal(f.tab.agentsRunning, 0);
	assert.equal(f.tab.running, false, 'the parent turn is idle while the shell remains active');
	const read = { ...server, id: 'read', source: 'unifiedExecInteraction', command: '', status: 'completed', exitCode: null, aggregatedOutput: 'Request\n' };
	send('item/started', { item: read });
	send('item/completed', { item: read });
	assert.equal(row.status, 'running');
	assert.equal(row.output, 'Ready\nRequest\n');
	assert.equal(f.tab.chat.entries.filter(e => e.kind === 'tool' && e.tool === 'command').length, 1);
	send('item/started', { item: server });
	assert.equal(f.tab.chat.entries.filter(e => e.kind === 'tool' && e.id === 'server').length, 1);
	send('item/completed', { item: { ...server, status: 'completed', exitCode: 0, aggregatedOutput: 'Ready\nRequest\nStopped\n' } });
	assert.equal(row.status, 'done');
	assert.equal(row.exitCode, 0);
	assert.equal(row.shell?.background, false);
	assert.ok(row.endedAt);
	f.tab.discard();
});

test('Codex session closing settles an idle shell without waiting for a parent turn', async () => {
	const f = fixture('codex');
	await f.start();
	protocol.codexEvents('item/started', { item: { type: 'commandExecution', id: 'shell', command: 'npm run dev', processId: '6761', source: 'unifiedExecStartup' } }).forEach(f.event);
	f.end();
	const row = f.tab.chat.entries.find(e => e.kind === 'tool' && e.id === 'shell');
	assert.ok(row?.kind === 'tool' && row.status === 'running');
	f.tab.close();
	assert.equal(row.status, 'stopped');
});

test('a quiet tab lets its CLI go an hour after all activity ended', async () => {
	const hour = 60 * 60_000;
	const f = fixture('claude'); await f.start();
	const t0 = Date.now();
	assert.equal(f.tab.releaseIfIdle(t0 + 2 * hour), false, 'a turn is running');
	f.end();
	// The turn was still running two hours in: the hour counts from there.
	assert.equal(f.tab.releaseIfIdle(t0 + 2 * hour + 30 * 60_000), false, 'not an hour since the work ended');
	f.tab.chat.entries.push({ kind: 'tool', id: 'bg', tool: 'agent', title: 'Background agent', status: 'running' } as never);
	assert.equal(f.tab.releaseIfIdle(t0 + 4 * hour), false, 'a background agent lives inside the CLI');
	f.tab.chat.entries.pop();
	assert.equal(f.tab.releaseIfIdle(t0 + 4 * hour + 30 * 60_000), false, 'counted from when the agent was last seen running');
	assert.equal(f.tab.releaseIfIdle(t0 + 6 * hour, true), false, 'a toolbar run or a worker chat is still at work');
	assert.equal(f.tab.releaseIfIdle(t0 + 7 * hour - 60_000), false);
	assert.equal(f.tab.releaseIfIdle(t0 + 7 * hour + 1000), true);
	assert.equal(Reflect.get(f.tab, '_session'), undefined, 'the next message opens a session again');
	assert.equal(f.tab.releaseIfIdle(t0 + 9 * hour), false, 'nothing left to let go');
});

test('a tab whose agent scheduled itself keeps its CLI', async () => {
	const hour = 60 * 60_000;
	const f = fixture('claude'); await f.start();
	f.end();
	const t0 = Date.now();
	const tool = (id: string, name: string, input: unknown, output = '', at = t0) =>
		f.tab.chat.entries.push({ kind: 'tool', id, tool: 'other', name, input: JSON.stringify(input), output, status: 'done', startedAt: at, endedAt: at } as never);
	tool('w', 'ScheduleWakeup', { delaySeconds: 1800 });
	assert.equal(f.tab.releaseIfIdle(t0 + hour + 10 * 60_000), false, 'the hour counts from the wake-up');
	tool('c', 'CronCreate', { cron: '0 9 * * *' }, 'Scheduled job job-42a');
	assert.equal(f.tab.releaseIfIdle(t0 + 5 * hour), false, 'a cron lives inside the CLI');
	tool('d', 'CronDelete', { id: 'job-42a' }, '', t0 + 5 * hour);
	assert.equal(f.tab.releaseIfIdle(t0 + 6 * hour - 60_000), false, 'counted from when the cron was last held');
	assert.equal(f.tab.releaseIfIdle(t0 + 6 * hour + 1000), true);
});

test('a session cron holds the CLI for at most seven days', async () => {
	const f = fixture('claude'); await f.start();
	f.end();
	const t0 = Date.now();
	f.tab.chat.entries.push({ kind: 'tool', id: 'c', tool: 'other', name: 'CronCreate', input: '{}', output: 'ok', status: 'done', startedAt: t0, endedAt: t0 } as never);
	assert.equal(f.tab.releaseIfIdle(t0 + 6 * 24 * 60 * 60_000), false);
	assert.equal(f.tab.releaseIfIdle(t0 + 8 * 24 * 60 * 60_000), true);
});

test('a cron set by an earlier process does not hold a new one', async () => {
	const hour = 60 * 60_000;
	const f = fixture('claude'); await f.start();
	f.end();
	// Set an hour before this session opened: a reloaded window's history.
	const before = Date.now() - 2 * hour;
	f.tab.chat.entries.push({ kind: 'tool', id: 'c', tool: 'other', name: 'CronCreate', input: '{}', output: 'ok', status: 'done', startedAt: before, endedAt: before } as never);
	const t0 = Date.now();
	assert.equal(f.tab.releaseIfIdle(t0 + hour + 1000), true, 'the cron went with the process that set it');
});

test('a cron set before the CLI restarted does not hold the new process', async () => {
	const hour = 60 * 60_000;
	const f = fixture('claude'); await f.start();
	f.end();
	const before = Date.now() - 1000;
	f.tab.chat.entries.push({ kind: 'tool', id: 'c', tool: 'other', name: 'CronCreate', input: '{}', output: 'ok', status: 'done', startedAt: before, endedAt: before } as never);
	// A model, effort or Ultracode change starts another process in the same session.
	f.event({ type: 'processStarted' });
	const t0 = Date.now();
	assert.equal(f.tab.releaseIfIdle(t0 + hour + 1000), true, 'the cron went with the process that was replaced');
});
