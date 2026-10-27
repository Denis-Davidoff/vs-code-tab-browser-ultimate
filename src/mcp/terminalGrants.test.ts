import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { TerminalGrants, grantTtlMs, wildcardGrantTtlMs, maxGrantsPerChat } from './terminalGrants.ts';

function setup() {
	let now = 1_000_000;
	const grants = new TerminalGrants(() => now);
	return { grants, advance: (ms: number) => { now += ms; } };
}

describe('TerminalGrants', () => {
	test('a grant is used once, for the input it was minted for', () => {
		const { grants } = setup();
		grants.mint('c1', 'terminal_send', 'A');
		assert.strictEqual(grants.consume('c1', 'terminal_send', 'A'), true);
		assert.strictEqual(grants.consume('c1', 'terminal_send', 'A'), false, 'single use');
	});

	test('another input, tool or conversation is not covered', () => {
		const { grants } = setup();
		grants.mint('c1', 'terminal_send', 'A');
		assert.strictEqual(grants.consume('c1', 'terminal_send', 'B'), false);
		assert.strictEqual(grants.consume('c1', 'terminal_key', 'A'), false);
		assert.strictEqual(grants.consume('c2', 'terminal_send', 'A'), false);
		assert.strictEqual(grants.count('c1'), 1, 'the refusals used nothing up');
		assert.strictEqual(grants.consume('c1', 'terminal_send', 'A'), true);
	});

	test('a grant expires', () => {
		const { grants, advance } = setup();
		grants.mint('c1', 'terminal_send', 'A');
		advance(grantTtlMs - 1);
		assert.strictEqual(grants.count('c1'), 1);
		advance(2);
		assert.strictEqual(grants.consume('c1', 'terminal_send', 'A'), false);
		assert.strictEqual(grants.count('c1'), 0);
	});

	test('two approvals of one input allow two inputs, not three', () => {
		const { grants } = setup();
		grants.mint('c1', 'terminal_send', 'A');
		grants.mint('c1', 'terminal_send', 'A');
		assert.strictEqual(grants.consume('c1', 'terminal_send', 'A'), true);
		assert.strictEqual(grants.consume('c1', 'terminal_send', 'A'), true);
		assert.strictEqual(grants.consume('c1', 'terminal_send', 'A'), false);
	});

	test('a wildcard grant is used only when no exact one fits, and lives half as long', () => {
		const { grants, advance } = setup();
		grants.mint('c1', 'terminal_send');
		grants.mint('c1', 'terminal_send', 'A');
		assert.strictEqual(grants.consume('c1', 'terminal_send', 'A'), true, 'the exact one first');
		assert.strictEqual(grants.count('c1'), 1, 'the wildcard is still there');
		assert.strictEqual(grants.consume('c1', 'terminal_send', 'anything'), true);
		assert.strictEqual(grants.consume('c1', 'terminal_send', 'anything'), false);

		grants.mint('c1', 'terminal_key');
		advance(wildcardGrantTtlMs + 1);
		assert.strictEqual(grants.consume('c1', 'terminal_key', 'K'), false, 'a wildcard expired at its shorter life');
		assert.ok(wildcardGrantTtlMs < grantTtlMs);
	});

	test('a wildcard of one tool is not a wildcard of the other', () => {
		const { grants } = setup();
		grants.mint('c1', 'terminal_key');
		assert.strictEqual(grants.consume('c1', 'terminal_send', 'A'), false);
		assert.strictEqual(grants.consume('c1', 'terminal_key', 'A'), true);
	});

	test('a conversation holds a bounded number, the oldest dropped first', () => {
		const { grants } = setup();
		for (let i = 0; i < maxGrantsPerChat + 3; i++) {
			grants.mint('c1', 'terminal_send', `f${i}`);
		}
		assert.strictEqual(grants.count('c1'), maxGrantsPerChat);
		assert.strictEqual(grants.consume('c1', 'terminal_send', 'f0'), false);
		assert.strictEqual(grants.consume('c1', 'terminal_send', 'f2'), false);
		assert.strictEqual(grants.consume('c1', 'terminal_send', 'f3'), true);
	});

	test('refund puts a refused input back, and clear forgets a conversation', () => {
		const { grants } = setup();
		grants.mint('c1', 'terminal_send', 'A');
		assert.strictEqual(grants.consume('c1', 'terminal_send', 'A'), true);
		grants.refund('c1', 'terminal_send', 'A');
		assert.strictEqual(grants.count('c1'), 1);
		grants.clear('c1');
		assert.strictEqual(grants.consume('c1', 'terminal_send', 'A'), false);
	});
});
