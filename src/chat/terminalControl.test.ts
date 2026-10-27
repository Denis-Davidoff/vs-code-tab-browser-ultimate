/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { AgentTypingGate, UnreadTracker, agentActiveMs, typingQuietMs, unreadQuietMs } from './terminalControl.ts';

function clock(start = 1_000_000) {
	let now = start;
	return { now: () => now, advance: (ms: number) => { now += ms; } };
}

suite('AgentTypingGate', () => {
	test('agent input is allowed when the user has not typed', () => {
		const gate = new AgentTypingGate(clock().now);
		assert.deepStrictEqual(gate.checkAgentInput(), { ok: true });
	});

	test('the user typing closes the door for the quiet period, and says how long ago', () => {
		const c = clock();
		const gate = new AgentTypingGate(c.now);
		gate.userInput();
		c.advance(400);
		const verdict = gate.checkAgentInput();
		assert.strictEqual(verdict.ok, false);
		if (!verdict.ok) {
			assert.strictEqual(verdict.reason, 'user-typing');
			assert.strictEqual(verdict.userTypedMsAgo, 400);
			assert.strictEqual(verdict.retryAfterMs, typingQuietMs - 400);
			assert.match(verdict.message, /typing in this terminal/);
		}
		c.advance(typingQuietMs - 400);
		const later = gate.checkAgentInput();
		assert.strictEqual(later.ok, true);
		assert.strictEqual(gate.userTypedMsAgo(), typingQuietMs);
	});

	test('the agent\'s own typing does not lock the agent out, and is marked for three seconds', () => {
		const c = clock();
		const gate = new AgentTypingGate(c.now);
		gate.agentTyped();
		assert.strictEqual(gate.checkAgentInput().ok, true);
		assert.strictEqual(gate.agentActive(), true);
		assert.strictEqual(gate.agentActiveUntil(), c.now() + agentActiveMs);
		c.advance(agentActiveMs - 1);
		assert.strictEqual(gate.agentActive(), true);
		c.advance(1);
		assert.strictEqual(gate.agentActive(), false);
		assert.strictEqual(gate.agentActiveUntil(), undefined);
	});

	test('the emergency stop refuses everything until released, and a typist older than a minute is not reported', () => {
		const c = clock();
		const gate = new AgentTypingGate(c.now);
		gate.setAllowed(false);
		const verdict = gate.checkAgentInput();
		assert.strictEqual(verdict.ok, false);
		if (!verdict.ok) { assert.strictEqual(verdict.reason, 'paused'); }
		gate.setAllowed(true);
		assert.strictEqual(gate.checkAgentInput().ok, true);
		gate.userInput();
		c.advance(61_000);
		assert.strictEqual(gate.userTypedMsAgo(), undefined);
		assert.deepStrictEqual(gate.checkAgentInput(), { ok: true });
	});
});

suite('UnreadTracker', () => {
	test('output after a quiet spell marks a terminal that is not in front, once', () => {
		const c = clock();
		const unread = new UnreadTracker(c.now);
		assert.strictEqual(unread.output(false), true);
		assert.strictEqual(unread.unread, true);
		assert.strictEqual(unread.output(false), false);
		assert.strictEqual(unread.clear(), true);
		assert.strictEqual(unread.unread, false);
		assert.strictEqual(unread.clear(), false);
	});

	test('a stream without a pause does not mark again after it was looked at', () => {
		const c = clock();
		const unread = new UnreadTracker(c.now);
		unread.output(true);
		for (let i = 0; i < 5; i++) { c.advance(unreadQuietMs - 1); assert.strictEqual(unread.output(false), false); }
		assert.strictEqual(unread.unread, false);
		c.advance(unreadQuietMs);
		assert.strictEqual(unread.output(false), true);
	});

	test('a terminal in front is never marked', () => {
		const c = clock();
		const unread = new UnreadTracker(c.now);
		c.advance(10_000);
		assert.strictEqual(unread.output(true), false);
		assert.strictEqual(unread.unread, false);
	});
});
