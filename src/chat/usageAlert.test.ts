/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import type { UsageWindow } from './chatProtocol.ts';
import {
	closeAlert, closestLimit, currentLimits, mergeLimits, nextReset, readClosedAlerts, settleClosed, usageAlertFor, usageCheckDue, usageCheckMinGapMs,
	idleGapMs, nearGapMs, periodToleranceMs, type ClosedAlerts, type LimitState,
} from './usageAlert.ts';

const hour = 3_600_000;
const five = (usedPercent: number, resetsAt = 5 * hour): UsageWindow => ({ label: '5-hour limit', usedPercent, resetsAt });
const week = (usedPercent: number, resetsAt = 168 * hour): UsageWindow => ({ label: 'Weekly limit', usedPercent, resetsAt });
const state = (windows: UsageWindow[], usingCredits = false): LimitState => ({ windows, usingCredits });

suite('usageAlertFor', () => {
	test('nothing below 90 %', () => {
		assert.strictEqual(usageAlertFor('claude', state([five(6), week(89.9)]), {}), undefined);
	});

	test('the limit closest to running out, whatever its length', () => {
		const alert = usageAlertFor('claude', state([five(91), week(96)]), {});
		assert.deepStrictEqual(alert, { agent: 'claude', kind: 'high', label: 'Weekly limit', percent: 96, resetsAt: 168 * hour });
	});

	test('100 % is "reached", and a figure past it reads 100', () => {
		assert.strictEqual(usageAlertFor('codex', state([five(100)]), {})?.kind, 'reached');
		assert.strictEqual(usageAlertFor('codex', state([five(104)]), {})?.percent, 100);
	});

	test('spending credits comes first, about the closest limit', () => {
		const alert = usageAlertFor('claude', state([five(100), week(83)], true), {});
		assert.deepStrictEqual(alert, { agent: 'claude', kind: 'credits', label: '5-hour limit', percent: 100, resetsAt: 5 * hour });
	});
});

suite('closing the line', () => {
	test('closed at 91 %, it stays away at 91 % and comes back at 92 %', () => {
		const at91 = state([week(91.4)]);
		const closed = closeAlert({}, 'claude', at91);
		assert.strictEqual(usageAlertFor('claude', at91, closed), undefined);
		assert.strictEqual(usageAlertFor('claude', state([week(91.9)]), closed), undefined);
		assert.strictEqual(usageAlertFor('claude', state([week(92)]), closed)?.percent, 92);
	});

	test('closed at 99 %, 100 % shows again', () => {
		const closed = closeAlert({}, 'claude', state([week(99)]));
		assert.strictEqual(usageAlertFor('claude', state([week(100)]), closed)?.kind, 'reached');
	});

	test('another limit crossing 90 % shows, the closed one does not', () => {
		const closed = closeAlert({}, 'claude', state([five(40), week(95)]));
		const alert = usageAlertFor('claude', state([five(90), week(95)]), closed);
		assert.strictEqual(alert?.label, '5-hour limit');
	});

	test('one agent closed says nothing of the other', () => {
		const closed = closeAlert({}, 'claude', state([week(95)]));
		assert.strictEqual(usageAlertFor('codex', state([week(95)]), closed)?.percent, 95);
	});

	test('closing credits closes the limit behind them too', () => {
		const spending = state([five(100)], true);
		const closed = closeAlert({}, 'claude', spending);
		assert.strictEqual(usageAlertFor('claude', spending, closed), undefined);
	});

	test('a limit that reset forgets the close, so the next climb shows', () => {
		let closed: ClosedAlerts = closeAlert({}, 'claude', state([five(97)]));
		closed = settleClosed(closed, 'claude', state([five(3, 10 * hour)]));
		assert.deepStrictEqual(closed, {});
		assert.strictEqual(usageAlertFor('claude', state([five(90, 10 * hour)]), closed)?.percent, 90);
	});

	test('a new period at the same percentage shows again, even before the close is settled', () => {
		const closed = closeAlert({}, 'claude', state([week(95)]));
		assert.strictEqual(usageAlertFor('claude', state([week(95, 336 * hour)]), closed)?.percent, 95);
	});

	test("a point lower in the same period is the other source's rounding, not a reset", () => {
		// Measured on Claude Code 2.1.301: get_usage 85 against rate_limit_event 0.84 in the same second.
		const closed = closeAlert({}, 'claude', state([week(92)]));
		assert.strictEqual(settleClosed(closed, 'claude', state([week(91)])), closed);
		assert.strictEqual(usageAlertFor('claude', state([week(91)]), closed), undefined);
		assert.strictEqual(usageAlertFor('claude', state([week(92)]), closed), undefined);
		// The same reset with a second's jitter is the same period.
		assert.strictEqual(usageAlertFor('claude', state([week(92, 168 * hour + 1_000)]), closed), undefined);
		assert.strictEqual(usageAlertFor('claude', state([week(92, 168 * hour + periodToleranceMs + 1)]), closed)?.percent, 92);
	});

	test("another window's older figure for a limit this report leaves out does not undo a close", () => {
		const scoped = (p: number): UsageWindow => ({ label: 'Weekly · Fable', usedPercent: p, resetsAt: 1 });
		const closed = closeAlert({}, 'claude', state([scoped(93)]));
		// This window still holds 20 from its detection, before the climb; the turn names only the 5-hour limit.
		const here = mergeLimits(state([scoped(20)]), [five(30)], false, false);
		assert.strictEqual(settleClosed(closed, 'claude', here, new Set(['5-hour limit'])), closed);
	});

	test('closed as shown: a figure that came in while the click was on its way stays to be seen', () => {
		const shown = usageAlertFor('claude', state([week(91)]), {})!;
		const closed = closeAlert({}, 'claude', state([week(93)]), shown);
		assert.strictEqual(usageAlertFor('claude', state([week(93)]), closed)?.percent, 93);
		assert.strictEqual(usageAlertFor('claude', state([week(91)]), closed), undefined);
	});

	test('closing a limit line closes no credits it did not show', () => {
		const shown = usageAlertFor('claude', state([week(95)]), {})!;
		const closed = closeAlert({}, 'claude', state([week(100)], true), shown);
		assert.strictEqual(usageAlertFor('claude', state([week(100)], true), closed)?.kind, 'credits');
	});

	test('with no reset time, only a real fall forgets the close', () => {
		const at = (p: number): UsageWindow => ({ label: 'Weekly limit', usedPercent: p });
		const closed = closeAlert({}, 'codex', state([at(95)]));
		assert.strictEqual(settleClosed(closed, 'codex', state([at(94)])), closed);
		assert.deepStrictEqual(settleClosed(closed, 'codex', state([at(85)])), {});
	});

	test('a sparse report of a new period does not bring back the old period\'s credits', () => {
		// Codex's update can only set credits; the limit they were spent past resetting ends them.
		const spending = mergeLimits(undefined, [five(100), week(60)], true, true);
		const next = mergeLimits(spending, [five(2, 10 * hour)], undefined, false);
		assert.strictEqual(next.usingCredits, false);
		assert.strictEqual(usageAlertFor('codex', next, {}), undefined);
		// Another limit still at 100 % keeps them.
		const both = mergeLimits(undefined, [five(100), week(100)], true, true);
		assert.strictEqual(mergeLimits(both, [five(2, 10 * hour)], undefined, false).usingCredits, true);
		// The reset time passing does the same, before any report.
		assert.strictEqual(currentLimits(spending, 5 * hour + 1)!.usingCredits, false);
	});

	test('a credits close with no limit to tie it to is not kept', () => {
		const closed = closeAlert({}, 'codex', state([], true));
		assert.strictEqual(closed.codex?.credits, undefined);
		assert.deepStrictEqual(readClosedAlerts({ codex: { credits: { percent: 100 } } }), {});
	});

	test('credits closed stay closed until the limit they were spent past resets', () => {
		let closed = closeAlert({}, 'codex', state([five(100)], true));
		closed = settleClosed(closed, 'codex', state([five(100)], false));
		assert.ok(closed.codex?.credits);
		assert.strictEqual(usageAlertFor('codex', state([five(100)], true), closed), undefined);
		closed = settleClosed(closed, 'codex', state([five(2, 10 * hour)], false));
		assert.strictEqual(closed.codex, undefined);
		assert.strictEqual(usageAlertFor('codex', state([five(100, 10 * hour)], true), closed)?.kind, 'credits');
	});

	test('a report that leaves a limit out keeps its close, and nothing changed is the same object', () => {
		const closed = closeAlert({}, 'claude', state([week(95)]));
		assert.strictEqual(settleClosed(closed, 'claude', state([five(10)])), closed);
		assert.strictEqual(settleClosed(closed, 'claude', state([week(96)])), closed);
	});
});

suite('mergeLimits', () => {
	test("a turn's own report replaces the limits it names and keeps the rest", () => {
		const scoped: UsageWindow = { label: 'Weekly · Fable', usedPercent: 40 };
		const merged = mergeLimits(state([five(6), week(83), scoped], true), [five(7), week(84)], undefined, false);
		assert.deepStrictEqual(merged.windows.map(w => [w.label, w.usedPercent]), [['Weekly · Fable', 40], ['5-hour limit', 7], ['Weekly limit', 84]]);
		assert.strictEqual(merged.usingCredits, true);
	});

	test('a full read replaces the list', () => {
		const merged = mergeLimits(state([five(6), week(83)]), [week(85)], false, true);
		assert.deepStrictEqual(merged.windows.map(w => w.label), ['Weekly limit']);
		assert.strictEqual(merged.usingCredits, false);
	});

	test('a limit keeps its higher figure within one period, from either source', () => {
		const read = mergeLimits(undefined, [five(24), week(92)], false, true);
		const turn = mergeLimits(read, [five(23), week(91)], false, false);
		assert.deepStrictEqual(turn.windows.map(w => w.usedPercent), [24, 92]);
		assert.deepStrictEqual(mergeLimits(turn, [week(91)], false, true).windows.map(w => w.usedPercent), [92]);
		// A reset is taken at once.
		assert.deepStrictEqual(mergeLimits(turn, [week(1, 336 * hour)], false, true).windows.map(w => w.usedPercent), [1]);
	});

	test("a turn's own word on credits outranks a full read's guess, and a full read can still clear them", () => {
		const turn = mergeLimits(undefined, [week(99.9)], false, false);
		assert.strictEqual(mergeLimits(turn, [week(100)], true, true).usingCredits, false);
		const spending = mergeLimits(turn, [week(100)], true, false);
		assert.strictEqual(mergeLimits(spending, [week(100)], true, true).usingCredits, true);
		assert.strictEqual(mergeLimits(spending, [week(2, 336 * hour)], false, true).usingCredits, false);
		// With no word from a turn yet, the guess stands.
		assert.strictEqual(mergeLimits(undefined, [week(100)], true, true).usingCredits, true);
	});

	test('a limit whose reset time has passed is left out, and the credits spent past it stop', () => {
		const known = state([five(100, 10), week(60, 1_000)], true);
		const now = currentLimits(known, 20)!;
		assert.deepStrictEqual(now.windows.map(w => w.label), ['Weekly limit']);
		assert.strictEqual(now.usingCredits, false);
		assert.strictEqual(currentLimits(known, 5), known);
		assert.strictEqual(currentLimits(state([five(100, 10), week(100, 1_000)], true), 20)!.usingCredits, true);
		assert.strictEqual(nextReset(known, 5), 10);
		assert.strictEqual(nextReset(known, 20), 1_000);
		assert.strictEqual(nextReset(known, 2_000), undefined);
	});

	test('closestLimit skips a figure that is not a number', () => {
		assert.strictEqual(closestLimit(state([five(Number.NaN), week(20)]))?.label, 'Weekly limit');
	});
});

suite('readClosedAlerts', () => {
	test('takes what it can read and drops the rest', () => {
		assert.deepStrictEqual(readClosedAlerts(undefined), {});
		assert.deepStrictEqual(readClosedAlerts([1]), {});
		assert.deepStrictEqual(readClosedAlerts({
			claude: { windows: { 'Weekly limit': { percent: 92, resetsAt: 5 }, bad: { percent: 'x' }, worse: 7 }, credits: { label: 'Weekly limit', percent: 100, resetsAt: 'soon' } },
			codex: 'nope',
			other: { windows: { a: { percent: 1 } } },
		}), { claude: { windows: { 'Weekly limit': { percent: 92, resetsAt: 5 } }, credits: { label: 'Weekly limit', percent: 100 } } });
	});
});

suite('usageCheckDue', () => {
	const small = { tokens: 2_000, ms: 10_000 };
	const big = { tokens: 60_000, ms: 30_000 };
	const now = 10_000_000;

	test('the first turn asks, and a clock that moved back does not stop it', () => {
		assert.ok(usageCheckDue(now, undefined, small, undefined));
		assert.ok(usageCheckDue(now, now + 60_000, small, undefined));
	});

	test('never twice inside a minute, however big the turn', () => {
		assert.ok(!usageCheckDue(now, now - usageCheckMinGapMs + 1, big, 99));
	});

	test('a big request asks; a small one only now and then', () => {
		assert.ok(usageCheckDue(now, now - usageCheckMinGapMs, big, 10));
		assert.ok(usageCheckDue(now, now - usageCheckMinGapMs, { tokens: 0, ms: 4 * 60_000 }, 10));
		assert.ok(!usageCheckDue(now, now - usageCheckMinGapMs, small, 10));
		assert.ok(usageCheckDue(now, now - idleGapMs, small, 10));
	});

	test('near the line, a small turn asks sooner', () => {
		assert.ok(!usageCheckDue(now, now - nearGapMs + 1, small, 85));
		assert.ok(usageCheckDue(now, now - nearGapMs, small, 85));
		assert.ok(!usageCheckDue(now, now - nearGapMs, small, 70));
	});
});
