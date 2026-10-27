/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { TerminalSet, TerminalTab, type TerminalHandlers, type TerminalSessionLike, type TerminalStarter } from './terminalTab.ts';
import { AgentTypingGate, UnreadTracker, agentActiveMs, typingQuietMs, unreadQuietMs } from './terminalControl.ts';

class Session implements TerminalSessionLike {
	written: string[] = [];
	exited = false;
	exitCode: number | undefined;
	reads: unknown[] = [];
	write(data: string): void { this.written.push(data); }
	resize(): void { /* not used */ }
	ack(): void { /* not used */ }
	replay() { return { data: '', seq: 0 }; }
	dispose(): void { /* not used */ }
	async readScreen(options: unknown) { this.reads.push(options); return { text: 'hi', viewport: 'hi', cursor: '1.1', truncated: false, state: {} } as never; }
}

function clock(start = 5_000_000) {
	let now = start;
	return { now: () => now, advance: (ms: number) => { now += ms; } };
}

async function rig(options: { controls?: boolean; front?: boolean } = {}) {
	const c = clock();
	const session = new Session();
	let handlers!: TerminalHandlers;
	let changed = 0;
	const starter: TerminalStarter = async h => { handlers = h; return { session }; };
	const controls = options.controls === false ? undefined : { gate: new AgentTypingGate(c.now), unread: new UnreadTracker(c.now) };
	const tab = new TerminalTab('t', 'Terminal 1', '/w', undefined, starter, () => undefined, () => { changed++; },
		{ now: c.now, isFront: () => options.front === true, ...(controls ? { controls } : {}) });
	await tab.start();
	return { tab, session, c, handlers: () => handlers, changed: () => changed };
}

suite('TerminalTab agent input', () => {
	test('the agent\'s input reaches the shell, never feeds the typing gate, and marks the tab as typed in', async () => {
		const r = await rig();
		assert.deepStrictEqual(r.tab.agentInput('ls\r'), { ok: true });
		assert.deepStrictEqual(r.tab.agentInput('pwd\r'), { ok: true });
		assert.deepStrictEqual(r.session.written, ['ls\r', 'pwd\r']);
		assert.strictEqual(r.tab.userTypedMsAgo(), undefined);
		assert.strictEqual(r.tab.summary().agentActive, true);
		r.c.advance(agentActiveMs);
		assert.strictEqual(r.tab.summary().agentActive, undefined);
	});

	test('the user typing keeps the agent out for 1.5 s, writes nothing, and the verdict says why', async () => {
		const r = await rig();
		r.tab.input('a');
		r.c.advance(300);
		const refused = r.tab.agentInput('ls\r');
		assert.strictEqual(refused.ok, false);
		if (!refused.ok) { assert.strictEqual(refused.reason, 'user-typing'); assert.strictEqual(refused.userTypedMsAgo, 300); }
		assert.deepStrictEqual(r.session.written, ['a']);
		r.c.advance(typingQuietMs);
		const allowed = r.tab.agentInput('ls\r');
		assert.strictEqual(allowed.ok, true);
		assert.ok((allowed.userTypedMsAgo ?? 0) >= typingQuietMs);
		assert.deepStrictEqual(r.session.written, ['a', 'ls\r']);
	});

	test('the emergency stop refuses the agent, shows on the summary and is released again', async () => {
		const r = await rig();
		assert.strictEqual(r.tab.setAgentControl(false), true);
		assert.strictEqual(r.tab.setAgentControl(false), false);
		assert.strictEqual(r.tab.summary().agentControl, 'paused');
		const refused = r.tab.agentInput('x');
		assert.strictEqual(refused.ok === false && refused.reason, 'paused');
		assert.deepStrictEqual(r.session.written, []);
		r.tab.setAgentControl(true);
		assert.strictEqual(r.tab.summary().agentControl, undefined);
		assert.strictEqual(r.tab.agentInput('x').ok, true);
		// The user's own input is not affected by the stop.
		r.tab.setAgentControl(false);
		r.tab.input('y');
		assert.deepStrictEqual(r.session.written, ['x', 'y']);
	});

	test('an exited shell takes no agent input', async () => {
		const r = await rig();
		r.handlers().onExit(0);
		const refused = r.tab.agentInput('x');
		assert.strictEqual(refused.ok === false && refused.reason, 'exited');
		assert.deepStrictEqual(r.session.written, []);
	});

	test('a tab made with no controls fails closed: the agent can never type', async () => {
		const r = await rig({ controls: false });
		const refused = r.tab.agentInput('x');
		assert.strictEqual(refused.ok, false);
		assert.deepStrictEqual(r.session.written, []);
		assert.strictEqual(r.tab.summary().agentControl, undefined);
	});

	test('the screen is read through the session, and a session with no model says so', async () => {
		const r = await rig();
		const read = await r.tab.readScreen({ since: '1.0', maxChars: 100 });
		assert.strictEqual(read.text, 'hi');
		assert.deepStrictEqual(r.session.reads, [{ since: '1.0', maxChars: 100 }]);
		const bare = new TerminalTab('b', 'B', '/', undefined, async () => ({ session: { write() {}, resize() {}, ack() {}, replay: () => ({ data: '', seq: 0 }), exited: false, exitCode: undefined, dispose() {} } }), () => undefined, () => undefined);
		await bare.start();
		await assert.rejects(bare.readScreen({}), /cannot be read/);
	});

	test('the typing mark redraws the strip once it has ended', async () => {
		const r = await rig();
		const before = r.changed();
		r.tab.agentInput('x');
		assert.strictEqual(r.changed(), before + 1);
		r.tab.dispose();
	});
});

suite('TerminalSet unread, background and controls', () => {
	function set(now: () => number) {
		let changed = 0;
		const sessions: Session[] = [];
		const all = new TerminalSet(() => 8, () => undefined, () => { changed++; }, () => ({ gate: new AgentTypingGate(now), unread: new UnreadTracker(now) }));
		const starter: TerminalStarter = async () => { const s = new Session(); sessions.push(s); return { session: s }; };
		return { all, starter, changed: () => changed };
	}

	test('output on a terminal that is not in front marks it unread, and selecting it clears the mark', async () => {
		const c = clock();
		const { all, starter } = set(c.now);
		let a!: TerminalHandlers;
		await all.create('a', 'A', '/', undefined, async h => { a = h; return starter(h, { cols: 80, rows: 24 }); });
		await all.create('b', 'B', '/', undefined, starter, {});
		assert.strictEqual(all.front, 'b');
		c.advance(unreadQuietMs);
		a.onData('x', 1);
		assert.strictEqual(all.find('a')?.summary().unread, true);
		assert.strictEqual(all.find('b')?.summary().unread, undefined);
		all.select('a');
		assert.strictEqual(all.find('a')?.summary().unread, undefined);
	});

	test('a terminal made in the background leaves the front and the focus alone', async () => {
		const c = clock();
		const { all, starter } = set(c.now);
		await all.create('a', 'A', '/', undefined, starter);
		const tab = await all.create('bg', 'BG', '/', undefined, starter, { background: true });
		assert.strictEqual(all.front, 'a');
		assert.strictEqual(all.takeFocus(), 'a');
		assert.ok(all.find('bg') === tab);
		// With nothing in front (a conversation shows) it stays that way.
		all.clearFront();
		await all.create('bg2', 'BG2', '/', undefined, starter, { background: true });
		assert.strictEqual(all.front, undefined);
	});

	test('terminals of a set with controls let the agent type', async () => {
		const c = clock();
		const { all, starter } = set(c.now);
		const tab = await all.create('a', 'A', '/', undefined, starter);
		assert.strictEqual(tab.agentInput('ls\r').ok, true);
	});
});
