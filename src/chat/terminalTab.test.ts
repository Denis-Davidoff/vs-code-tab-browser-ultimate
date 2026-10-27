/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { TerminalSet, TerminalTab, terminalInputLimit, type StartedTerminal, type TerminalHandlers, type TerminalSessionLike, type TerminalStarter } from './terminalTab.ts';
import type { HostToView } from './chatProtocol.ts';

class FakeSession implements TerminalSessionLike {
	written: string[] = [];
	resized: [number, number][] = [];
	acked: number[] = [];
	disposed = false;
	exited = false;
	exitCode: number | undefined;
	tail = { data: 'tail', seq: 4 };
	write(data: string): void { this.written.push(data); }
	resize(cols: number, rows: number): void { this.resized.push([cols, rows]); }
	ack(bytes: number): void { this.acked.push(bytes); }
	replay() { return this.tail; }
	dispose(): void { this.disposed = true; }
}

function rig() {
	const posts: HostToView[] = [];
	const sessions: FakeSession[] = [];
	const handlers: TerminalHandlers[] = [];
	let cleaned = 0;
	let changed = 0;
	const starter: TerminalStarter = async h => {
		const session = new FakeSession();
		sessions.push(session);
		handlers.push(h);
		return { session, cleanup: () => { cleaned++; } } satisfies StartedTerminal;
	};
	const tab = new TerminalTab('t1', 'Terminal 1', '/work', undefined, starter, m => posts.push(m), () => { changed++; });
	return { tab, posts, sessions, handlers, cleaned: () => cleaned, changed: () => changed, starter };
}

suite('TerminalTab', () => {
	test('output is acknowledged at once while no view is attached, and posted once one is', async () => {
		const r = rig();
		await r.tab.start();
		r.handlers[0].onData('hello', 5);
		assert.deepStrictEqual(r.posts, []);
		assert.deepStrictEqual(r.sessions[0].acked, [5]);
		r.tab.attach(100, 30);
		assert.deepStrictEqual(r.sessions[0].resized, [[100, 30]]);
		assert.deepStrictEqual(r.posts, [{ type: 'terminalReplay', id: 't1', seq: 4, data: 'tail' }]);
		r.handlers[0].onData('more', 9);
		assert.deepStrictEqual(r.posts[1], { type: 'terminalData', id: 't1', seq: 9, data: 'more' });
		assert.deepStrictEqual(r.sessions[0].acked, [5]);
	});

	test('the view\'s acknowledgements reach the session, never more than was posted', async () => {
		const r = rig();
		await r.tab.start();
		r.tab.attach(80, 24);
		r.handlers[0].onData('abcdef', 6);
		r.tab.ack(4);
		r.tab.ack(100);
		r.tab.ack(-1);
		r.tab.ack('x');
		assert.deepStrictEqual(r.sessions[0].acked, [4, 2]);
	});

	test('a view that goes away gives back what it was sent and will not acknowledge', async () => {
		const r = rig();
		await r.tab.start();
		r.tab.attach(80, 24);
		r.handlers[0].onData('abc', 3);
		r.tab.detach();
		assert.deepStrictEqual(r.sessions[0].acked, [3]);
		r.handlers[0].onData('de', 5);
		assert.deepStrictEqual(r.sessions[0].acked, [3, 2]);
		r.tab.ack(3);
		assert.deepStrictEqual(r.sessions[0].acked, [3, 2]);
	});

	test('input and resize are validated and only reach a running shell', async () => {
		const r = rig();
		await r.tab.start();
		r.tab.input('ls\r');
		r.tab.input(5);
		r.tab.input('');
		r.tab.input('x'.repeat(terminalInputLimit + 1));
		r.tab.resize(120, 40);
		r.tab.resize(0, 40);
		r.tab.resize(1.5, 40);
		r.tab.resize('a', 40);
		assert.deepStrictEqual(r.sessions[0].written, ['ls\r']);
		assert.deepStrictEqual(r.sessions[0].resized, [[120, 40]]);
		r.handlers[0].onExit(0);
		r.tab.input('after');
		r.tab.resize(90, 20);
		assert.deepStrictEqual(r.sessions[0].written, ['ls\r']);
		assert.deepStrictEqual(r.sessions[0].resized, [[120, 40]]);
	});

	test('an exit marks the tab, tells an attached view, removes what was written for it', async () => {
		const r = rig();
		await r.tab.start();
		r.tab.attach(80, 24);
		r.posts.length = 0;
		r.handlers[0].onExit(3);
		assert.strictEqual(r.tab.status, 'exited');
		assert.strictEqual(r.tab.exitCode, 3);
		assert.deepStrictEqual(r.posts, [{ type: 'terminalExit', id: 't1', code: 3 }]);
		assert.strictEqual(r.cleaned(), 1);
		assert.strictEqual(r.changed(), 1);
		assert.deepStrictEqual(r.tab.summary(), { id: 't1', name: 'Terminal 1', cwd: '/work', status: 'exited', exitCode: 3 });
		// A second exit report changes nothing.
		r.handlers[0].onExit(9);
		assert.strictEqual(r.tab.exitCode, 3);
		assert.strictEqual(r.changed(), 1);
	});

	test('a view attaching to an exited terminal is told it exited', async () => {
		const r = rig();
		await r.tab.start();
		r.handlers[0].onExit(undefined);
		r.tab.attach(80, 24);
		assert.deepStrictEqual(r.posts, [
			{ type: 'terminalReplay', id: 't1', seq: 4, data: 'tail' },
			{ type: 'terminalExit', id: 't1' },
		]);
		assert.deepStrictEqual(r.sessions[0].resized, []);
	});

	test('restart starts a new process in the same tab and clears the view\'s screen; a stale process is ignored', async () => {
		const r = rig();
		await r.tab.start();
		r.tab.attach(80, 24);
		await r.tab.restart();
		assert.strictEqual(r.sessions.length, 1, 'a running shell is not restarted');
		r.handlers[0].onExit(1);
		r.posts.length = 0;
		await r.tab.restart();
		assert.strictEqual(r.sessions.length, 2);
		assert.strictEqual(r.tab.status, 'running');
		assert.strictEqual(r.tab.exitCode, undefined);
		assert.deepStrictEqual(r.posts, [{ type: 'terminalReplay', id: 't1', seq: 0, data: '\x1bc' }]);
		r.handlers[0].onData('old', 3);
		r.handlers[0].onExit(2);
		assert.strictEqual(r.tab.status, 'running');
		r.handlers[1].onData('new', 3);
		assert.deepStrictEqual(r.posts[1], { type: 'terminalData', id: 't1', seq: 3, data: 'new' });
	});

	test('a start that fails leaves the tab exited and throws', async () => {
		const posts: HostToView[] = [];
		const tab = new TerminalTab('t', 'T', '/', undefined, async () => { throw new Error('no shell'); }, m => posts.push(m), () => undefined);
		await assert.rejects(tab.start(), /no shell/);
		assert.strictEqual(tab.status, 'exited');
		assert.strictEqual(tab.running, false);
	});

	test('dispose ends the process once and ignores what comes after', async () => {
		const r = rig();
		await r.tab.start();
		r.tab.attach(80, 24);
		r.posts.length = 0;
		r.tab.dispose();
		assert.strictEqual(r.sessions[0].disposed, true);
		assert.strictEqual(r.cleaned(), 1);
		r.handlers[0].onData('late', 4);
		r.handlers[0].onExit(0);
		assert.deepStrictEqual(r.posts, []);
		await r.tab.restart();
		assert.strictEqual(r.sessions.length, 1);
	});

	test('a process made after the tab was disposed is ended at once', async () => {
		let release!: () => void;
		const session = new FakeSession();
		let cleaned = 0;
		const tab = new TerminalTab('t', 'T', '/', undefined, () => new Promise<StartedTerminal>(resolve => {
			release = () => resolve({ session, cleanup: () => { cleaned++; } });
		}), () => undefined, () => undefined);
		const starting = tab.start();
		tab.dispose();
		release();
		await starting;
		assert.strictEqual(session.disposed, true);
		assert.strictEqual(cleaned, 1);
	});

	test('rename takes a different, non-empty name', async () => {
		const r = rig();
		assert.strictEqual(r.tab.rename(''), false);
		assert.strictEqual(r.tab.rename('Terminal 1'), false);
		assert.strictEqual(r.tab.rename('build'), true);
		assert.strictEqual(r.tab.name, 'build');
	});
});

suite('TerminalSet', () => {
	function set(limit = 2) {
		const posts: HostToView[] = [];
		let changed = 0;
		const all = new TerminalSet(() => limit, m => posts.push(m), () => { changed++; });
		const starter: TerminalStarter = async () => ({ session: new FakeSession() });
		return { all, posts, changed: () => changed, starter };
	}

	test('a created terminal is in front, in strip order, and asked to take focus once', async () => {
		const { all, starter } = set();
		await all.create('a', 'Terminal 1', '/', undefined, starter);
		await all.create('b', 'Terminal 2', '/', 'claude', starter);
		assert.deepStrictEqual(all.summaries().map(s => [s.id, s.agent]), [['a', undefined], ['b', 'claude']]);
		assert.strictEqual(all.front, 'b');
		assert.strictEqual(all.takeFocus(), 'b');
		assert.strictEqual(all.takeFocus(), undefined);
		assert.strictEqual(all.atLimit, true);
	});

	test('a failed start leaves no tab', async () => {
		const { all } = set();
		await assert.rejects(all.create('a', 'T', '/', undefined, async () => { throw new Error('nope'); }), /nope/);
		assert.strictEqual(all.size, 0);
		assert.strictEqual(all.front, undefined);
	});

	test('select and clearFront; an unknown id changes nothing', async () => {
		const { all, starter } = set();
		await all.create('a', 'A', '/', undefined, starter);
		await all.create('b', 'B', '/', undefined, starter);
		assert.strictEqual(all.select('a'), true);
		assert.strictEqual(all.select('a'), false);
		assert.strictEqual(all.select('zzz'), false);
		assert.strictEqual(all.select(5), false);
		assert.strictEqual(all.front, 'a');
		assert.strictEqual(all.clearFront(), true);
		assert.strictEqual(all.clearFront(), false);
		assert.strictEqual(all.front, undefined);
		// A focus asked for before a conversation took the front is not delivered.
		assert.strictEqual(all.takeFocus(), undefined);
	});

	test('closing the front terminal moves to its neighbour, then to the conversations', async () => {
		const { all, starter } = set(3);
		await all.create('a', 'A', '/', undefined, starter);
		await all.create('b', 'B', '/', undefined, starter);
		await all.create('c', 'C', '/', undefined, starter);
		const b = all.find('b')!;
		all.select('b');
		assert.strictEqual(all.close('b'), true);
		assert.strictEqual(all.front, 'c');
		assert.strictEqual(all.find('b'), undefined);
		assert.strictEqual(b.status, 'running', 'the tab object itself is only disposed');
		all.close('c');
		assert.strictEqual(all.front, 'a');
		all.close('a');
		assert.strictEqual(all.front, undefined);
		assert.strictEqual(all.close('a'), false);
	});

	test('closing a terminal that is not in front leaves the front alone', async () => {
		const { all, starter } = set();
		await all.create('a', 'A', '/', undefined, starter);
		await all.create('b', 'B', '/', undefined, starter);
		all.close('a');
		assert.strictEqual(all.front, 'b');
	});

	test('dispose ends every process, and a start finishing after it makes no tab', async () => {
		const { all, starter } = set();
		let release!: () => void;
		const late = all.create('l', 'L', '/', undefined, () => new Promise<StartedTerminal>(resolve => { release = () => resolve({ session: new FakeSession() }); }));
		await all.create('a', 'A', '/', undefined, starter);
		const sessions: FakeSession[] = [];
		await all.create('b', 'B', '/', undefined, async () => { const s = new FakeSession(); sessions.push(s); return { session: s }; });
		all.dispose();
		assert.strictEqual(sessions[0].disposed, true);
		assert.strictEqual(all.size, 0);
		release();
		await assert.rejects(late);
		assert.strictEqual(all.size, 0);
		await assert.rejects(all.create('z', 'Z', '/', undefined, starter));
	});

	test('detachAll gives every view\'s debt back', async () => {
		const posts: HostToView[] = [];
		const sessions: FakeSession[] = [];
		const handlers: TerminalHandlers[] = [];
		const all = new TerminalSet(() => 4, m => posts.push(m), () => undefined);
		const starter: TerminalStarter = async h => { const s = new FakeSession(); sessions.push(s); handlers.push(h); return { session: s }; };
		await all.create('a', 'A', '/', undefined, starter);
		all.find('a')!.attach(80, 24);
		handlers[0].onData('12345', 5);
		all.detachAll();
		assert.deepStrictEqual(sessions[0].acked, [5]);
		assert.strictEqual(all.find('a')!.attached, false);
	});

	test('the size the view reports is remembered with no process, and the new process starts at it (a restart in progress)', async () => {
		const posts: HostToView[] = [];
		const sessions: FakeSession[] = [];
		const sizes: { cols: number; rows: number }[] = [];
		const handlers: TerminalHandlers[] = [];
		let release: (() => void) | undefined;
		const starter: TerminalStarter = async (h, size) => {
			handlers.push(h);
			sizes.push({ ...size });
			if (sessions.length > 0) { await new Promise<void>(resolve => { release = resolve; }); }
			const session = new FakeSession();
			sessions.push(session);
			return { session };
		};
		const tab = new TerminalTab('t1', 'T', '/w', undefined, starter, m => posts.push(m), () => undefined);
		await tab.start();
		tab.attach(100, 30);
		handlers[0].onExit(0);
		const restarting = tab.restart();
		// The view's attach lands while the new process is being made: no session, but the size is kept.
		tab.attach(132, 43);
		release!();
		await restarting;
		assert.deepStrictEqual(sizes[1], { cols: 100, rows: 30 }, 'started at the size known when it began');
		assert.deepStrictEqual(sessions[1].resized, [[132, 43]], 'told the size reported while it was being made');
	});

	test('a resize that arrives before any process is kept for it; an invalid one is not', async () => {
		const sizes: { cols: number; rows: number }[] = [];
		const starter: TerminalStarter = async (_h, size) => { sizes.push({ ...size }); return { session: new FakeSession() }; };
		const tab = new TerminalTab('t2', 'T', '/w', undefined, starter, () => undefined, () => undefined);
		tab.resize(120, 40);
		tab.resize(0, 0);
		tab.resize('x', 5);
		await tab.start();
		assert.deepStrictEqual(sizes, [{ cols: 120, rows: 40 }]);
	});

	test('input of up to the limit is written whole, one above it is dropped', async () => {
		const r = rig();
		await r.tab.start();
		const big = 'x'.repeat(terminalInputLimit);
		r.tab.input(big);
		r.tab.input(big + 'x');
		assert.deepStrictEqual(r.sessions[0].written.map(w => w.length), [terminalInputLimit]);
	});
});
