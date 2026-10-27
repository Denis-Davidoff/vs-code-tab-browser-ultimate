/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// TerminalTab driven through the real TerminalSession (batching, flow control, the tail) over a
// fake PTY: the acknowledgement accounting and the pause/resume interplay between the two, across
// attach, restart and exit. A test sits in `chat/` and imports across folders, which a module may not.

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { TerminalSession, type PtyProcess } from '../terminal/terminalHost.ts';
import { TerminalTab, type TerminalStarter } from './terminalTab.ts';
import type { HostToView } from './chatProtocol.ts';

class FakePty implements PtyProcess {
	dataCb: ((data: string) => void) | undefined;
	exitCb: ((e: { exitCode: number }) => void) | undefined;
	written: string[] = [];
	sizes: Array<[number, number]> = [];
	paused = 0;
	resumed = 0;
	killed = 0;
	onData(cb: (data: string) => void): void { this.dataCb = cb; }
	onExit(cb: (e: { exitCode: number }) => void): void { this.exitCb = cb; }
	write(data: string): void { this.written.push(data); }
	resize(cols: number, rows: number): void { this.sizes.push([cols, rows]); }
	pause(): void { this.paused++; }
	resume(): void { this.resumed++; }
	kill(): void { this.killed++; }
	emit(data: string): void { this.dataCb?.(data); }
	exit(exitCode: number): void { this.exitCb?.({ exitCode }); }
}

const later = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function rig() {
	const posts: HostToView[] = [];
	const ptys: FakePty[] = [];
	const spawnSizes: Array<{ cols: number; rows: number }> = [];
	let changed = 0;
	const starter: TerminalStarter = async (handlers, size) => {
		const pty = new FakePty();
		ptys.push(pty);
		spawnSizes.push({ ...size });
		const session = new TerminalSession(pty, { onData: handlers.onData, onExit: handlers.onExit, batchMs: 2, maxBatch: 100, ackHigh: 300, ackLow: 100 });
		session.resize(size.cols, size.rows);
		return { session };
	};
	const tab = new TerminalTab('t1', 'Terminal 1', '/work', undefined, starter, m => posts.push(m), () => { changed++; });
	const data = () => posts.filter((m): m is Extract<HostToView, { type: 'terminalData' }> => m.type === 'terminalData');
	return { tab, posts, ptys, spawnSizes, changed: () => changed, data };
}

suite('TerminalTab over a real TerminalSession', () => {
	test('output nobody can read is acknowledged at once, so the shell is never paused on it', async () => {
		const r = rig();
		await r.tab.start();
		r.ptys[0].emit('x'.repeat(1000));
		await later(30);
		assert.strictEqual(r.ptys[0].paused, 0);
		assert.deepStrictEqual(r.posts, []);
		r.tab.dispose();
	});

	test('an attached view that does not acknowledge pauses the shell, and its acknowledgements resume it', async () => {
		const r = rig();
		await r.tab.start();
		r.tab.attach(100, 30);
		r.ptys[0].emit('y'.repeat(500));
		await later(30);
		assert.strictEqual(r.ptys[0].paused, 1);
		const total = r.data().reduce((n, m) => n + m.data.length, 0);
		assert.strictEqual(total, 500);
		// A view that acknowledges what it wrote resumes the reader.
		for (const m of r.data()) { r.tab.ack(m.data.length); }
		assert.strictEqual(r.ptys[0].resumed, 1);
		r.tab.dispose();
	});

	test('a view that goes away gives back what it owed, which resumes a paused shell', async () => {
		const r = rig();
		await r.tab.start();
		r.tab.attach(100, 30);
		r.ptys[0].emit('z'.repeat(500));
		await later(30);
		assert.strictEqual(r.ptys[0].paused, 1);
		r.tab.detach();
		assert.strictEqual(r.ptys[0].resumed, 1);
		r.tab.dispose();
	});

	test('attach replays the shell\'s tail with its seq, and live data continues after it', async () => {
		const r = rig();
		await r.tab.start();
		r.ptys[0].emit('hello');
		await later(30);
		r.tab.attach(80, 24);
		assert.deepStrictEqual(r.posts[0], { type: 'terminalReplay', id: 't1', seq: 5, data: 'hello' });
		r.ptys[0].emit('!');
		await later(30);
		assert.deepStrictEqual(r.data().map(m => [m.seq, m.data]), [[6, '!']]);
		r.tab.dispose();
	});

	test('an exit reaches an attached view after every byte the shell wrote', async () => {
		const r = rig();
		await r.tab.start();
		r.tab.attach(80, 24);
		r.ptys[0].emit('bye');
		r.ptys[0].exit(7);
		assert.deepStrictEqual(r.posts.slice(1).map(m => m.type), ['terminalData', 'terminalExit']);
		assert.strictEqual(r.tab.status, 'exited');
		assert.strictEqual(r.tab.exitCode, 7);
		r.tab.dispose();
	});

	test('a restart whose attach lands mid-start gets the view\'s real size, not 80x24, and acknowledgements start over', async () => {
		const r = rig();
		await r.tab.start();
		r.tab.attach(120, 40);
		r.ptys[0].exit(0);
		const restarting = r.tab.restart();
		r.tab.attach(150, 50);
		await restarting;
		// The new process was made at the size known when it began (120x40)…
		assert.deepStrictEqual(r.spawnSizes[1], { cols: 120, rows: 40 });
		// …and told the size the view reported meanwhile.
		assert.deepStrictEqual(r.ptys[1].sizes.at(-1), [150, 50]);
		// The screen starts over, and the new stream is delivered from its own seq 0 (nothing is owed from the old one).
		assert.ok(r.posts.some(m => m.type === 'terminalReplay' && m.seq === 0 && m.data === '\x1bc'));
		r.ptys[1].emit('new');
		await later(30);
		assert.deepStrictEqual(r.data().at(-1), { type: 'terminalData', id: 't1', seq: 3, data: 'new' });
		assert.strictEqual(r.tab.status, 'running');
		r.tab.dispose();
		assert.strictEqual(r.ptys[1].killed, 1);
	});

	test('output of the replaced process never reaches the view', async () => {
		const r = rig();
		await r.tab.start();
		r.tab.attach(80, 24);
		r.ptys[0].exit(0);
		await r.tab.restart();
		const before = r.data().length;
		r.ptys[0].emit('ghost');
		await later(30);
		assert.strictEqual(r.data().length, before);
		r.tab.dispose();
	});
});
