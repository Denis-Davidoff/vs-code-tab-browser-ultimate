import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { SkillAgents } from './skillAgents.ts';
import * as text from './toolbarText.ts';
import { codexEvents } from './agentProtocol.ts';
import type { AgentEvent } from './agentProtocol.ts';
import type { ToolbarRuns as Runs } from './toolbarRun.ts';
import type { AgentBackend } from './agents.ts';
import type { ToolbarSkill } from './chatProtocol.ts';

function fixture(check?: string) {
	const timers = new Map<number, () => void>();
	let timerId = 0;
	let listener: (event: AgentEvent) => void = () => {};
	const sent: string[] = [];
	const session = {
		running: false, disposed: false, ref: undefined,
		onEvent(fn: typeof listener) { listener = fn; return { dispose() {} }; },
		send(input: { text: string }) { sent.push(input.text); this.running = true; return Promise.resolve(); },
		stop() {}, answer() {}, dispose() { this.disposed = true; this.running = false; },
	};
	const exports: { ToolbarRuns?: typeof Runs } = {};
	const require = (name: string): unknown => {
		switch (name) {
			case 'vscode': return { l10n: { t: (s: string) => s }, env: { clipboard: { writeText: async () => {} } } };
			case './skillAgents': return { SkillAgents };
			case './toolbarText': return text;
			case './chatTab': return { approvalKey: () => 'terminal' };
			case '../core/notify': return { confirm() {} };
			case '../core/notifyText': return { capAt: (s: string, n: number) => s.slice(0, n) };
			default: throw new Error(name);
		}
	};
	const source = readFileSync(resolve('src/chat/toolbarRun.ts'), 'utf8');
	runInNewContext(transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText, {
		exports, require, setTimeout: (fn: () => void) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id: number) => timers.delete(id),
	});
	const runs = new exports.ToolbarRuns!({ approvalMode: () => 'auto', noteServer() {}, changed() {}, ended() {} });
	const skill = { id: 'test', name: 'test', prompt: 'one', result: 'silent', agents: 'all', icon: 'play', params: [] } as ToolbarSkill;
	runs.start(skill, [{ text: 'one' }, { text: 'two', check }], {}, 'chat', { id: 'codex', openSession: () => session } as unknown as AgentBackend, 'model', 'low', '/tmp', undefined);
	return {
		runs, session, sent,
		emit(event: AgentEvent) {
			if (event.type === 'turnEnd') { session.running = false; }
			if (event.type === 'autoTurn') { session.running = true; }
			listener(event);
		},
		tick() { const pending = [...timers]; for (const [id, fn] of pending) { if (timers.delete(id)) { fn(); } } },
	};
}

const child = (id: string): AgentEvent => ({ type: 'tool', id, tool: { kind: 'agent', name: 'Agent', agent: { background: true, threadId: id } } });

test('next prompt waits for every child and the parent automatic follow-up', () => {
	const f = fixture('passed');
	f.emit(child('one')); f.emit(child('two'));
	f.emit({ type: 'turnEnd' }); f.tick();
	assert.equal(f.sent.length, 1);
	f.emit({ type: 'toolUpdate', id: 'one', update: { status: 'done' } }); f.tick();
	assert.equal(f.sent.length, 1);
	f.emit({ type: 'agentStates', states: [{ threadId: 'two', status: 'done' }] });
	f.emit({ type: 'autoTurn' }); f.tick();
	assert.equal(f.sent.length, 1);
	f.emit({ type: 'text', text: text.nextYes });
	f.emit({ type: 'turnEnd' }); f.tick();
	assert.equal(f.sent.length, 2);
	assert.equal(f.sent[1], 'two');
	f.runs.dispose();
});

test('stopping while waiting cancels the pending next prompt', () => {
	const f = fixture();
	f.emit(child('one')); f.emit({ type: 'turnEnd' }); f.tick();
	f.runs.dispose();
	f.emit({ type: 'toolUpdate', id: 'one', update: { status: 'done' } }); f.tick();
	assert.equal(f.sent.length, 1);
	assert.equal(f.session.disposed, true);
});

test('failure does not start another prompt; ordinary success still advances', () => {
	const failed = fixture();
	failed.emit(child('one')); failed.emit({ type: 'turnEnd', error: 'Failed' }); failed.tick();
	assert.equal(failed.sent.length, 1);
	assert.equal(failed.session.disposed, true);
	failed.runs.dispose();
	const success = fixture();
	success.emit({ type: 'turnEnd' }); success.tick();
	assert.equal(success.sent.length, 2);
	success.runs.dispose();
});

test('chat queue stays blocked while child agents are running', () => {
	const source = readFileSync(resolve('src/chat/chatTab.ts'), 'utf8');
	const getter = /public get readyForQueued\(\): boolean \{[\s\S]*?\n\t\}/.exec(source)?.[0];
	assert.ok(getter);
	const prototype = runInNewContext(transpileModule(`({ ${getter.replace('public ', '')} })`, {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText);
	const ready = Object.getOwnPropertyDescriptor(prototype, 'readyForQueued')!.get!;
	const state = { _queued: [{}], running: false, _pending: [], _waiting: [], waiting: false, agentsRunning: 1,
		get busy() { return this.running || this._pending.length > 0 || this.agentsRunning > 0; } };
	assert.equal(ready.call(state), false);
	state.agentsRunning = 0;
	assert.equal(ready.call(state), true);
});

for (const legacy of [false, true]) {
	test(`next prompt waits for ${legacy ? 'legacy spawnAgent' : 'restarted agent thread'}`, () => {
		const f = fixture();
		const report = (kind: string) => {
			for (const event of codexEvents('item/started', { item: { type: 'subAgentActivity', id: 'report', kind, agentThreadId: 'thread', agentPath: '/root/worker' } })) { f.emit(event); }
		};
		if (legacy) {
			for (const event of codexEvents('item/started', { item: { type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', receiverThreadIds: ['thread'] } })) { f.emit(event); }
		} else {
			report('started'); report('completed'); report('started');
		}
		f.emit({ type: 'turnEnd' }); f.tick();
		assert.equal(f.sent.length, 1);
		if (legacy) { f.emit({ type: 'agentStates', states: [{ threadId: 'thread', status: 'done' }] }); }
		else { report('completed'); }
		f.tick();
		assert.equal(f.sent.length, 2);
		f.runs.dispose();
	});
}
