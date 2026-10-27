import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AckBatcher, AckLedger, EarlyOutput, OutputSequencer, ackSize, type AckTimers } from './terminalFlow.ts';

function fakeTimers() {
	const pending = new Map<number, () => void>();
	let next = 1;
	const timers: AckTimers = {
		set: run => { pending.set(next, run); return next++; },
		clear: handle => { pending.delete(handle as number); },
	};
	return { timers, pending, fire: () => { for (const [id, run] of [...pending]) { pending.delete(id); run(); } } };
}

test('acknowledgements are sent in batches: at the threshold, or once the output is quiet', () => {
	const { timers, pending, fire } = fakeTimers();
	const sent: number[] = [];
	const acks = new AckBatcher(bytes => sent.push(bytes), 100, 40, timers);
	acks.add(30);
	acks.add(30);
	assert.deepEqual(sent, []);
	assert.equal(pending.size, 1, 'one idle timer, not one per chunk');
	acks.add(50);
	assert.deepEqual(sent, [110], 'the threshold sends everything so far');
	assert.equal(pending.size, 0, 'and cancels the timer');
	acks.add(10);
	fire();
	assert.deepEqual(sent, [110, 10]);
	acks.flush();
	assert.deepEqual(sent, [110, 10], 'nothing pending sends nothing');
});

test('a disposed batcher says nothing more', () => {
	const { timers, pending } = fakeTimers();
	const sent: number[] = [];
	const acks = new AckBatcher(bytes => sent.push(bytes), 100, 40, timers);
	acks.add(10);
	acks.dispose();
	acks.flush();
	assert.equal(pending.size, 0);
	assert.deepEqual(sent, []);
	acks.add(0);
	acks.add(-5);
	assert.equal(pending.size, 0);
});

test('live output is held until the replay, and what the replay already holds is dropped', () => {
	const s = new OutputSequencer();
	assert.deepEqual(s.push(1, 'a'), { write: [], dropped: 0 });
	assert.deepEqual(s.push(2, 'bb'), { write: [], dropped: 0 });
	assert.deepEqual(s.push(3, 'ccc'), { write: [], dropped: 0 });
	assert.equal(s.live, false);
	const result = s.replay(2, 'AB');
	assert.deepEqual(result, { write: ['AB', 'ccc'], dropped: ackSize('a') + ackSize('bb') });
	assert.equal(s.live, true);
	// A batch posted twice, or arriving late, is not written again.
	assert.deepEqual(s.push(3, 'ccc'), { write: [], dropped: 3 });
	assert.deepEqual(s.push(2, 'bb'), { write: [], dropped: 2 });
	assert.deepEqual(s.push(4, 'd'), { write: ['d'], dropped: 0 });
});

test('an empty replay is nothing to be a duplicate of', () => {
	const s = new OutputSequencer();
	s.push(0, 'first');
	assert.deepEqual(s.replay(0, ''), { write: ['first'], dropped: 0 });
	assert.deepEqual(s.push(1, 'x'), { write: ['x'], dropped: 0 });
});

test('output on the replay\'s own sequence number is a duplicate, the next one is not', () => {
	const s = new OutputSequencer();
	s.replay(10, 'screen');
	assert.deepEqual(s.push(10, 'screen'), { write: [], dropped: 6 });
	assert.deepEqual(s.push(11, 'more'), { write: ['more'], dropped: 0 });
});

test('a reset waits for a new replay and hands back what it held, to be acknowledged', () => {
	const s = new OutputSequencer();
	s.replay(5, 'x');
	s.push(6, 'live');
	s.reset();
	assert.equal(s.live, false);
	s.push(1, 'new-shell');
	assert.deepEqual(s.reset(), { write: [], dropped: ackSize('new-shell') });
	assert.deepEqual(s.push(1, 'again'), { write: [], dropped: 0 });
	assert.deepEqual(s.replay(1, ''), { write: ['again'], dropped: 0 });
});

test('empty chunks are nothing', () => {
	const s = new OutputSequencer();
	s.replay(1, 'x');
	assert.deepEqual(s.push(2, ''), { write: [], dropped: 0 });
});

test('output for a terminal not yet known waits, and is handed over once', () => {
	const e = new EarlyOutput(100);
	assert.equal(e.push('t1', 1, 'aaaa'), 0);
	assert.equal(e.push('t2', 1, 'zz'), 0);
	assert.equal(e.push('t1', 2, 'bbbb'), 0);
	assert.deepEqual(e.take('t1'), [{ seq: 1, data: 'aaaa' }, { seq: 2, data: 'bbbb' }]);
	assert.deepEqual(e.take('t1'), []);
	assert.deepEqual(e.take('t2'), [{ seq: 1, data: 'zz' }]);
});

test('early output is bounded: the oldest goes first and is reported for acknowledgement', () => {
	const e = new EarlyOutput(10);
	assert.equal(e.push('t', 1, '12345'), 0);
	assert.equal(e.push('t', 2, '67890'), 0);
	assert.equal(e.push('t', 3, 'abc'), 5, 'the first chunk made room');
	assert.deepEqual(e.take('t'), [{ seq: 2, data: '67890' }, { seq: 3, data: 'abc' }]);
	// A chunk bigger than the whole limit does not stay either.
	assert.equal(e.push('t', 4, '0123456789ab'), 12);
	assert.deepEqual(e.take('t'), []);
});

test('output for terminals that never appear is forgotten', () => {
	const e = new EarlyOutput(100);
	e.push('gone', 1, 'x');
	e.push('kept', 1, 'y');
	e.keepOnly(new Set(['kept']));
	assert.deepEqual(e.take('gone'), []);
	assert.deepEqual(e.take('kept'), [{ seq: 1, data: 'y' }]);
});

function ledger() {
	const sent: number[] = [];
	const batcher = new AckBatcher(bytes => sent.push(bytes), 1, 40, fakeTimers().timers);
	return { sent, batcher, ledger: new AckLedger(batcher) };
}

test('a ledger credits nothing until the first replay, and only the output after it', () => {
	const { sent, ledger: l } = ledger();
	assert.equal(l.token(), -1);
	l.credit(l.token(), 10);
	l.credit(0, 10);
	assert.deepEqual(sent, [], 'nothing before a replay');
	l.replayed();
	const token = l.token();
	assert.ok(token >= 0);
	l.credit(token, 7);
	assert.deepEqual(sent, [7]);
});

test('an attach sent or a shell restarted ends every earlier token and forgets what was pending', () => {
	const { sent, batcher, ledger: l } = ledger();
	l.replayed();
	const old = l.token();
	// Pending, not yet sent: a batcher with a high threshold keeps it.
	const slow: number[] = [];
	const slowBatcher = new AckBatcher(bytes => slow.push(bytes), 1000, 40, fakeTimers().timers);
	const slowLedger = new AckLedger(slowBatcher);
	slowLedger.replayed();
	slowLedger.credit(slowLedger.token(), 10);
	slowLedger.awaitReplay();
	slowBatcher.flush();
	assert.deepEqual(slow, [], 'what was pending is forgotten, not sent after the attach');
	l.awaitReplay();
	l.credit(old, 5);
	assert.deepEqual(sent, [], 'a chunk parsed late, after the attach, is not acknowledged');
	assert.equal(l.token(), -1);
	l.replayed();
	l.credit(old, 5);
	assert.deepEqual(sent, [], 'and still not once the replay has arrived: its token is from before');
	l.credit(l.token(), 5);
	assert.deepEqual(sent, [5]);
	void batcher;
});

test('a batcher reset drops what it holds without saying it', () => {
	const f = fakeTimers();
	const sent: number[] = [];
	const acks = new AckBatcher(bytes => sent.push(bytes), 100, 40, f.timers);
	acks.add(10);
	acks.reset();
	assert.equal(f.pending.size, 0);
	acks.flush();
	assert.deepEqual(sent, []);
	acks.add(10);
	f.fire();
	assert.deepEqual(sent, [10], 'still usable afterwards');
});

/**
 * The host's side of the contract, as `TerminalTab` keeps it: `inflight` counts
 * the live data it posted, `attach` gives all of it back and posts a replay that
 * is not counted, `ack` is clamped to `inflight`. The view is the real
 * sequencer, ledger and batcher; xterm's parse callbacks are run when told to.
 */
test('the view never acknowledges more than the host counted, whatever the replay and the late callbacks do', () => {
	let inflight = 0;
	let stolen = 0; // acknowledged units the host had no live data in flight for
	const hostAck = (bytes: number) => {
		const n = Math.min(bytes, inflight);
		stolen += bytes - n;
		inflight -= n;
	};
	const batcher = new AckBatcher(hostAck, 1, 40, fakeTimers().timers);
	const l = new AckLedger(batcher);
	const s = new OutputSequencer();
	const parsed: (() => void)[] = [];
	const write = (chunks: readonly string[], counted: boolean) => {
		const token = l.token();
		for (const c of chunks) { parsed.push(() => { if (counted) { l.credit(token, ackSize(c)); } }); }
	};
	const hostPost = (seq: number, data: string) => { inflight += data.length; const r = s.push(seq, data); write(r.write, true); if (r.dropped) { l.credit(l.token(), r.dropped); } };
	const attach = () => { inflight = 0; l.awaitReplay(); s.reset(); };
	const replay = (seq: number, data: string) => { l.replayed(); const r = s.replay(seq, data); write(r.write, false); };
	const runParsers = () => { while (parsed.length) { parsed.shift()!(); } };

	// A first attach, with output posted before the host has taken it.
	hostPost(1, 'aaaa');
	attach();
	replay(1, 'aaaa'.repeat(1000));
	// Live output after the replay, then the replay is parsed (late), then the live data.
	hostPost(2, 'bbbbb');
	hostPost(3, 'cc');
	assert.equal(inflight, 7);
	runParsers();
	assert.equal(stolen, 0, 'the replay\'s 4000 units were not acknowledged');
	assert.equal(inflight, 0, 'the live data was');

	// A second attach with live output still unparsed in the view: the view sends the attach, the
	// host releases what it counted and posts the replay and then new live output, in that order.
	hostPost(4, 'dddd');
	l.awaitReplay();
	s.reset();
	inflight = 0;
	runParsers(); // 'dddd' is parsed after the attach was sent
	replay(5, 'screen');
	hostPost(6, 'ee');
	hostPost(7, 'fff');
	assert.equal(inflight, 5);
	runParsers();
	assert.equal(stolen, 0);
	assert.equal(inflight, 0, 'only what was posted after the replay is owed, and it is paid');
});
