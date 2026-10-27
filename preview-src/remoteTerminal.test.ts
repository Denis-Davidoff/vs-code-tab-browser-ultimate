import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createRemoteTerminalShim } from './remoteTerminal.ts';
import { isTerminalReply, readAgentTerminalFrame, readViewerTerminalFrame, remoteInputFrameMax, splitTerminalData } from '../src/chat/remoteTerminalProtocol.ts';

const viewerId = 'viewer-0001';
function harness(epoch: string | null = 'ep1') {
	const sent: Record<string, unknown>[] = [];
	const emitted: unknown[] = [];
	const notices: string[] = [];
	const timers: (() => void)[] = [];
	let clip: string | Error = 'clip';
	const shim = createRemoteTerminalShim({
		viewerId, epoch: () => epoch ?? undefined, send: f => { sent.push(f); return true; },
		emit: m => emitted.push(m), notice: t => notices.push(t),
		readClipboard: () => clip instanceof Error ? Promise.reject(clip) : Promise.resolve(clip),
		readAgentFrame: readAgentTerminalFrame, isTerminalReply, splitData: splitTerminalData, inputFrameMax: remoteInputFrameMax,
		setTimer: run => { timers.push(run); return timers.length; }, clearTimer: () => {},
	});
	return { shim, sent, emitted, notices, timers, setClip: (v: string | Error) => { clip = v; } };
}

test('attach sends a valid viewer frame with the epoch and a rising counter, and settings once', () => {
	const h = harness();
	h.shim.fromView({ type: 'terminalAttach', id: 't1', cols: 80, rows: 24 });
	h.shim.fromView({ type: 'terminalAck', id: 't1', bytes: 10 });
	assert.deepEqual(h.sent[0], { type: 'terminal.attach', t: 't1', cols: 80, rows: 24, e: 'ep1', v: viewerId, n: 1 });
	assert.equal((h.sent[1] as { n: number }).n, 2);
	for (const f of h.sent) { assert.ok(readViewerTerminalFrame(f), JSON.stringify(f)); }
	assert.deepEqual(h.emitted, [{ type: 'terminalSettings', settings: {} }]);
});

test('without an epoch nothing is sent and the user is told', () => {
	const h = harness(null);
	h.shim.fromView({ type: 'terminalAttach', id: 't1', cols: 80, rows: 24 });
	assert.equal(h.sent.length, 0);
	assert.equal(h.notices.length, 1);
});

test('agent frames for this viewer become renderer messages; others are swallowed', () => {
	const h = harness();
	assert.equal(h.shim.fromAgent({ type: 'terminal.replay', v: viewerId, t: 't1', seq: 5, data: 'ab', cols: 80, rows: 24 }), true);
	h.shim.fromAgent({ type: 'terminal.data', v: viewerId, t: 't1', seq: 7, data: 'cd' });
	h.shim.fromAgent({ type: 'terminal.data', v: 'someone-else', t: 't1', seq: 9, data: 'x' });
	h.shim.fromAgent({ type: 'terminal.exit', v: viewerId, t: 't1', code: 1 });
	assert.equal(h.shim.fromAgent({ type: 'chat.snapshot' }), false);
	assert.deepEqual(h.emitted, [
		{ type: 'terminalReplay', id: 't1', seq: 5, data: 'ab' },
		{ type: 'terminalData', id: 't1', seq: 7, data: 'cd' },
		{ type: 'terminalExit', id: 't1', code: 1 },
	]);
});

test('a watcher\'s input is refused with one notice, a terminal reply silently; resize is local', () => {
	const h = harness();
	h.shim.fromView({ type: 'terminalAttach', id: 't1', cols: 80, rows: 24 });
	h.shim.fromView({ type: 'terminalInput', id: 't1', data: '\x1b[1;1R' });
	assert.equal(h.notices.length, 0);
	h.shim.fromView({ type: 'terminalInput', id: 't1', data: 'ls' });
	h.shim.fromView({ type: 'terminalInput', id: 't1', data: 'ls' });
	h.shim.fromView({ type: 'terminalResize', id: 't1', cols: 40, rows: 20 });
	assert.equal(h.notices.length, 1);
	assert.deepEqual(h.sent.map(f => f.type), ['terminal.attach']);
});

test('claiming the lease, then typing; the holder\'s size goes to the shell; release hands back', () => {
	const h = harness();
	const seen: (string | undefined)[] = [];
	h.shim.onChange(() => seen.push(h.shim.holder('t1')));
	h.shim.fromView({ type: 'terminalAttach', id: 't1', cols: 80, rows: 24 });
	h.shim.toggle('t1');
	assert.deepEqual({ type: h.sent[1].type, op: h.sent[1].op }, { type: 'terminal.lease', op: 'claim' });
	h.shim.fromAgent({ type: 'terminal.lease', v: viewerId, t: 't1', holder: 'you', expiresInMs: 30000 });
	assert.deepEqual({ type: h.sent[2].type, cols: h.sent[2].cols }, { type: 'terminal.resize', cols: 80 });
	h.shim.fromView({ type: 'terminalInput', id: 't1', data: 'x'.repeat(remoteInputFrameMax + 5) });
	const inputs = h.sent.filter(f => f.type === 'terminal.input');
	assert.deepEqual(inputs.map(f => (f.data as string).length), [remoteInputFrameMax, 5]);
	for (const f of h.sent) { assert.ok(readViewerTerminalFrame(f)); }
	h.shim.toggle('t1');
	assert.equal(h.sent.at(-1)!.op, 'release');
	h.shim.fromAgent({ type: 'terminal.lease', v: viewerId, t: 't1', holder: 'editor' });
	assert.deepEqual(seen, ['you', 'editor']);
});

test('slow: attach again after the delay; gone and watch-only notify', () => {
	const h = harness();
	h.shim.fromView({ type: 'terminalAttach', id: 't1', cols: 80, rows: 24 });
	h.shim.fromAgent({ type: 'terminal.error', v: viewerId, t: 't1', reason: 'slow', message: 'slow' });
	h.shim.fromAgent({ type: 'terminal.error', v: viewerId, t: 't1', reason: 'slow', message: 'slow' });
	assert.equal(h.timers.length, 1);
	h.timers[0]();
	assert.equal(h.sent.filter(f => f.type === 'terminal.attach').length, 2);
	h.shim.fromAgent({ type: 'terminal.error', v: viewerId, t: 't1', reason: 'watch-only', message: 'Take control first.' });
	assert.deepEqual(h.notices, ['Take control first.']);
});

test('a terminal leaving the state is detached; a reconnect attaches the rest again', () => {
	const h = harness();
	h.shim.fromView({ type: 'terminalAttach', id: 't1', cols: 80, rows: 24 });
	h.shim.fromView({ type: 'terminalAttach', id: 't2', cols: 80, rows: 24 });
	h.shim.syncTerminals(['t2']);
	assert.deepEqual({ type: h.sent.at(-1)!.type, t: h.sent.at(-1)!.t }, { type: 'terminal.detach', t: 't1' });
	h.shim.reconnected();
	assert.deepEqual({ type: h.sent.at(-1)!.type, t: h.sent.at(-1)!.t }, { type: 'terminal.attach', t: 't2' });
});

test('paste reads the viewer\'s own clipboard', async () => {
	const h = harness();
	h.shim.fromView({ type: 'terminalPasteRequest', id: 't1' });
	await new Promise(r => setTimeout(r, 0));
	assert.deepEqual(h.emitted.at(-1), { type: 'terminalPaste', id: 't1', text: 'clip' });
	h.setClip(new Error('denied'));
	h.shim.fromView({ type: 'terminalPasteRequest', id: 't1' });
	await new Promise(r => setTimeout(r, 0));
	assert.equal(h.notices.length, 1);
	assert.equal(h.shim.fromView({ type: 'copy', text: 'x' }), false);
});
