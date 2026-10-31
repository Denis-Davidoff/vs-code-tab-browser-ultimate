import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SessionHost, reduceSession, sessionChannel, type SessionState, type SessionEnvelope } from './sessionHost.ts';

function state(id = 'chat'): SessionState {
	return { id, title: 'Task', agent: 'codex', directory: '/project', running: true,
		entries: [{ kind: 'user', id: 'prompt', text: 'Hello', attachments: [] }, { kind: 'assistant', id: 'reply', text: 'Hi' }], pendingSends: [] };
}

test('runtime mutation cannot change a snapshot or replay; clients reduce the same stream', () => {
	const host = new SessionHost();
	const events: SessionEnvelope[] = [];
	host.subscribe(event => events.push(event));
	const input = state();
	host.publish(input);
	const first = host.snapshot(sessionChannel('chat'))!;
	(input.entries[1] as { text: string }).text += ' there';
	assert.equal((first.state.entries[1] as { text: string }).text, 'Hi');
	host.publish(input);
	assert.equal(events[1].action.type, 'session/changed');
	if (events[1].action.type === 'session/changed') { assert.equal(events[1].action.entries?.from, 1); }
	let client: SessionState | undefined;
	for (const event of events) { client = reduceSession(client, event.action); }
	assert.deepEqual(client, host.snapshot(sessionChannel('chat'))!.state);
	assert.throws(() => (host.snapshot(sessionChannel('chat'))!.state.entries as unknown[]).push('bad'));
	assert.throws(() => { (first.state.entries[1] as { text: string }).text = 'bad'; });
	host.publish(input);
	assert.equal(host.serverSeq, 2, 'unchanged publication has no event');
});

test('metadata, queues, shortened history and empty state converge through pure reducers', () => {
	const host = new SessionHost();
	let client: SessionState | undefined;
	host.subscribe(event => { client = reduceSession(client, event.action); });
	host.publish(state());
	host.publish({ ...state(), title: 'Renamed', running: false, entries: [], pendingSends: [{ id: 'q', text: 'Next', kind: 'queue', attachments: [] }] });
	assert.deepEqual(client, host.snapshot(sessionChannel('chat'))!.state);
	host.publish({ ...state(), running: false, entries: [], pendingSends: [] });
	assert.deepEqual(client?.pendingSends, []);
	assert.throws(() => reduceSession(undefined, { type: 'session/changed', metadata: state() }));
	assert.throws(() => reduceSession(state(), { type: 'session/changed', metadata: state(), entries: { from: 8, values: [], length: 8 } }));
});

test('recovery filters channels, reports removal and falls back after count or byte eviction', () => {
	const host = new SessionHost({ replayLimit: 2 });
	host.publish(state());
	host.publish(state('other'));
	const cursor = host.serverSeq;
	host.publish({ ...state(), title: 'Changed' });
	host.retain(new Set(['chat']));
	const replay = host.recover(cursor, [sessionChannel('chat'), sessionChannel('other')]);
	assert.equal(replay.type, 'replay');
	assert.deepEqual(replay.missing, [sessionChannel('other')]);
	if (replay.type === 'replay') { assert.equal(replay.actions.length, 2); }
	const snapshot = host.recover(0, [sessionChannel('chat')]);
	assert.equal(snapshot.type, 'snapshot');
	assert.equal(host.recover(2, [sessionChannel('chat')]).type, 'replay');
	assert.equal(host.recover(host.serverSeq, []).type, 'replay');
	for (const cursor of [-1, NaN, 0.5, 50]) { assert.throws(() => host.recover(cursor, [])); }
	const small = new SessionHost({ replayBytes: 1 });
	small.publish(state());
	assert.equal(small.recover(0, [sessionChannel('chat')]).type, 'snapshot');
	assert.throws(() => new SessionHost({ replayLimit: -1 }));
});

test('subscriber failure and reentrant publication cannot reorder other clients', () => {
	const host = new SessionHost();
	const seen: number[] = [];
	host.subscribe(() => { throw new Error('Disconnected client'); });
	host.subscribe(event => { if (event.serverSeq === 1) { host.publish({ ...state(), title: 'Nested' }); } });
	host.subscribe(event => seen.push(event.serverSeq));
	host.publish(state());
	assert.deepEqual(seen, [1, 2]);
	host.dispose();
	assert.equal(host.size, 0);
	assert.throws(() => host.publish(state()));
});

test('only one client resolves an approval; duplicate retries share the original result', async () => {
	let calls = 0;
	let finish!: () => void;
	const host = new SessionHost({ execute: async () => { calls++; await new Promise<void>(resolve => { finish = resolve; }); } });
	host.publish({ ...state(), entries: [{ kind: 'approval', id: 'a', what: 'command', title: 'Run tests', status: 'pending' }] });
	const command = { type: 'approve' as const, chatId: 'chat', commandId: 1, approvalId: 'a', allow: true };
	const first = host.dispatch('phone', command);
	const retry = host.dispatch('phone', command);
	assert.equal(first, retry);
	await assert.rejects(host.dispatch('desktop', { ...command, allow: false }), /no longer pending/);
	await assert.rejects(host.dispatch('phone', { ...command, allow: false }), /reused/);
	assert.equal(calls, 1);
	finish(); await first;
	host.publish({ ...state(), entries: [] });
	await assert.rejects(host.dispatch('phone', { ...command, commandId: 2 }), /no longer pending/);
});

test('expired command results never execute again, and a failed control is not blindly retried', async () => {
	let calls = 0;
	const host = new SessionHost({ execute: () => { calls++; } });
	host.publish(state());
	for (let commandId = 1; commandId <= 40; commandId++) { await host.dispatch('client', { type: 'stop', chatId: 'chat', commandId }); }
	await assert.rejects(host.dispatch('client', { type: 'stop', chatId: 'chat', commandId: 1 }), /expired/);
	assert.equal(calls, 40);
	const failed = new SessionHost({ execute: () => { throw new Error('Transport failed after send'); } });
	failed.publish(state());
	const command = { type: 'stop' as const, chatId: 'chat', commandId: 1 };
	await assert.rejects(failed.dispatch('client', command), /Transport failed/);
	await assert.rejects(failed.dispatch('client', command), /Transport failed/);
	await assert.rejects(new SessionHost().dispatch('client', command), /not connected/);
	await assert.rejects(host.dispatch('client', { ...command, chatId: 'unknown', commandId: 41 }), /Unknown/);
});
