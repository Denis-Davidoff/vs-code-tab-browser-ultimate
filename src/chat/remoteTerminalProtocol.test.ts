import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import {
	RemoteTerminalHub, isTerminalFrame, isTerminalReply, readAgentTerminalFrame, readViewerTerminalFrame, remoteInputFrameMax,
	remoteLeaseIdleMs, remoteStallMs, remoteWindowHigh, splitTerminalData, type AgentTerminalFrame,
} from './remoteTerminalProtocol.ts';
import { TerminalTab, type TerminalHandlers, type TerminalSessionLike } from './terminalTab.ts';

const V = 'viewer-aaaa1111';
const W = 'viewer-bbbb2222';
const base = (v = V, n = 1, t = 't1') => ({ e: 'ep1', v, n, t });

suite('remote terminal frames', () => {
	test('viewer frames are an allowlist', () => {
		assert.deepStrictEqual(readViewerTerminalFrame({ type: 'terminal.input', ...base(), data: 'ls\r' }), { type: 'terminal.input', ...base(), data: 'ls\r' });
		assert.strictEqual(readViewerTerminalFrame({ type: 'terminal.input', ...base(), data: 'x', extra: 1 }), undefined);
		assert.strictEqual(readViewerTerminalFrame({ type: 'terminal.input', ...base(), data: 'x'.repeat(remoteInputFrameMax + 1) }), undefined);
		assert.strictEqual(readViewerTerminalFrame({ type: 'terminal.attach', ...base(), cols: 0, rows: 10 }), undefined);
		assert.strictEqual(readViewerTerminalFrame({ type: 'terminal.ack', ...base(), bytes: -1 }), undefined);
		assert.strictEqual(readViewerTerminalFrame({ type: 'terminal.lease', ...base(), op: 'steal' }), undefined);
		assert.strictEqual(readViewerTerminalFrame({ type: 'chat.command', ...base() }), undefined);
		assert.strictEqual(readViewerTerminalFrame({ type: 'terminal.detach', ...base('short') }), undefined);
		assert.ok(isTerminalFrame({ type: 'terminal.ack' }) && !isTerminalFrame({ type: 'chat.command' }));
	});
	test('agent frames are read by the shim', () => {
		assert.ok(readAgentTerminalFrame({ type: 'terminal.lease', v: V, t: 't1', holder: 'you', expiresInMs: 5 }));
		assert.strictEqual(readAgentTerminalFrame({ type: 'terminal.lease', v: V, t: 't1', holder: 'me' }), undefined);
		assert.strictEqual(readAgentTerminalFrame({ type: 'terminal.data', v: V, t: 't1', seq: 1, data: 'x'.repeat(40000) }), undefined);
	});
	test('splitting never cuts a surrogate pair', () => {
		const parts = splitTerminalData('ab😀cd', 3);
		assert.strictEqual(parts.join(''), 'ab😀cd');
		assert.ok(parts.every(p => !/[\ud800-\udbff]$/.test(p)));
	});
	test('terminal replies are recognised', () => {
		for (const r of ['\x1b[12;40R', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[0n', '\x1b]11;rgb:0000/0000/0000\x07']) { assert.ok(isTerminalReply(r), JSON.stringify(r)); }
		for (const r of ['ls\r', 'R', '\x1b[A', '\x03']) { assert.ok(!isTerminalReply(r), JSON.stringify(r)); }
	});
});

class FakeSession implements TerminalSessionLike {
	written: string[] = [];
	acked: number[] = [];
	resized: [number, number][] = [];
	exited = false;
	exitCode: number | undefined;
	write(data: string): void { this.written.push(data); }
	resize(c: number, r: number): void { this.resized.push([c, r]); }
	ack(bytes: number): void { this.acked.push(bytes); }
	replay() { return { data: 'TAIL', seq: 4 }; }
	dispose(): void { this.exited = true; }
}

async function rig(options: { allowed?: () => boolean } = {}) {
	const session = new FakeSession();
	let handlers!: TerminalHandlers;
	const tab = new TerminalTab('t1', 'zsh', '/p', undefined, async h => { handlers = h; return { session }; }, () => undefined, () => undefined);
	await tab.start();
	tab.setRemote(true);
	let now = 1000;
	const timers: { at: number; fn: () => void; dead?: boolean }[] = [];
	const sent: AgentTerminalFrame[] = [];
	const audits: string[] = [];
	const hub = new RemoteTerminalHub({
		allowed: options.allowed ?? (() => true), epoch: () => 'ep1', find: id => (id === 't1' ? tab : undefined),
		send: f => sent.push(f), audit: a => audits.push(a.kind), now: () => now,
		setTimer: (fn, ms) => { const t = { at: now + ms, fn }; timers.push(t); return t; },
		clearTimer: h => { (h as { dead?: boolean }).dead = true; },
	});
	const advance = (ms: number) => {
		now += ms;
		for (const t of [...timers]) { if (!t.dead && t.at <= now) { t.dead = true; t.fn(); } }
	};
	let n = 0;
	const frame = (type: string, extra: Record<string, unknown> = {}, v = V) => hub.receive({ type, ...base(v, ++n), ...extra });
	return { session, tab, hub, sent, audits, advance, frame, data: (s: string) => handlers.onData(s, 1) };
}

suite('remote terminal hub', () => {
	test('attach replays, a watcher cannot type, a lease holder can', async () => {
		const r = await rig();
		r.frame('terminal.attach', { cols: 80, rows: 24 });
		assert.deepStrictEqual(r.sent.map(f => f.type), ['terminal.replay', 'terminal.lease']);
		assert.strictEqual((r.sent[0] as { data: string }).data, 'TAIL');
		r.frame('terminal.input', { data: 'rm -rf /\r' });
		assert.deepStrictEqual(r.session.written, []);
		assert.strictEqual(r.sent.at(-1)!.type, 'terminal.error');
		r.frame('terminal.input', { data: '\x1b[1;1R' });
		assert.strictEqual(r.sent.filter(f => f.type === 'terminal.error').length, 1, 'a watcher\'s terminal reply is dropped quietly');
		r.frame('terminal.lease', { op: 'claim' });
		r.frame('terminal.input', { data: 'ls\r' });
		assert.deepStrictEqual(r.session.written, ['ls\r']);
		r.frame('terminal.resize', { cols: 100, rows: 30 });
		assert.deepStrictEqual(r.session.resized.at(-1), [100, 30]);
	});
	test('the editor always wins, and a lease expires without input', async () => {
		const r = await rig();
		r.frame('terminal.attach', { cols: 80, rows: 24 });
		r.frame('terminal.lease', { op: 'claim' });
		r.tab.input('x');
		assert.strictEqual(r.hub.leaseHolder('t1'), undefined);
		assert.ok(r.audits.includes('lease-editor'));
		r.frame('terminal.lease', { op: 'claim' });
		r.advance(remoteLeaseIdleMs + 1);
		assert.strictEqual(r.hub.leaseHolder('t1'), undefined);
		r.frame('terminal.input', { data: 'y' });
		assert.ok(!r.session.written.includes('y'));
	});
	test('flow control holds the PTY for the slowest consumer, and a stalled one is dropped', async () => {
		const r = await rig();
		r.tab.attach(80, 24);
		r.frame('terminal.attach', { cols: 80, rows: 24 });
		r.data('abcde');
		assert.deepStrictEqual(r.session.acked, []);
		r.tab.ack(5);
		assert.deepStrictEqual(r.session.acked, [], 'the viewer has not written it yet');
		r.frame('terminal.ack', { bytes: 5 });
		assert.deepStrictEqual(r.session.acked, [5]);
		r.data('x'.repeat(remoteWindowHigh));
		r.tab.ack(remoteWindowHigh);
		r.advance(remoteStallMs + 1);
		assert.strictEqual(r.hub.consumerCount, 0);
		assert.strictEqual((r.sent.at(-1) as { reason?: string }).reason, 'slow');
		assert.strictEqual(r.session.acked.reduce((a, b) => a + b, 0), 5 + remoteWindowHigh, 'dropping gives the debt back');
		r.frame('terminal.attach', { cols: 80, rows: 24 });
		assert.strictEqual(r.sent.at(-2)!.type, 'terminal.replay', 'attach again: a fresh replay');
	});
	test('stale and replayed frames are ignored', async () => {
		const r = await rig();
		r.hub.receive({ type: 'terminal.attach', ...base(V, 5), cols: 80, rows: 24 });
		const count = r.sent.length;
		r.hub.receive({ type: 'terminal.attach', ...base(V, 5), cols: 80, rows: 24 });
		r.hub.receive({ type: 'terminal.attach', e: 'other', v: V, n: 9, t: 't1', cols: 80, rows: 24 });
		assert.strictEqual(r.sent.length, count);
	});
	test('setting off: nothing is produced, and existing consumers go', async () => {
		let on = true;
		const r = await rig({ allowed: () => on });
		r.frame('terminal.attach', { cols: 80, rows: 24 });
		on = false;
		const count = r.sent.length;
		r.frame('terminal.lease', { op: 'claim' });
		r.frame('terminal.input', { data: 'ls\r' });
		assert.strictEqual(r.sent.length, count);
		assert.strictEqual(r.hub.consumerCount, 0);
		assert.deepStrictEqual(r.session.written, []);
	});
	test('a terminal not shared refuses, and unsharing drops its viewers', async () => {
		const r = await rig();
		r.frame('terminal.attach', { cols: 80, rows: 24 });
		r.frame('terminal.attach', { cols: 80, rows: 24 }, W);
		assert.strictEqual(r.hub.consumerCount, 2);
		r.tab.setRemote(false);
		r.hub.sync();
		assert.strictEqual(r.hub.consumerCount, 0);
		r.frame('terminal.attach', { cols: 80, rows: 24 });
		assert.strictEqual((r.sent.at(-1) as { reason?: string }).reason, 'gone');
	});
	test('output reaches every viewer, framed per viewer', async () => {
		const r = await rig();
		r.frame('terminal.attach', { cols: 80, rows: 24 });
		r.frame('terminal.attach', { cols: 80, rows: 24 }, W);
		r.data('hi');
		const data = r.sent.filter(f => f.type === 'terminal.data');
		assert.deepStrictEqual(data.map(f => f.v).sort(), [V, W].sort());
	});
});
