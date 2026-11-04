import * as assert from 'node:assert';
import { test } from 'node:test';
import { ComposerSwipe, swipeGapMs } from './composerSwipe.ts';

/** Feeds `deltas` 16 ms apart from `t0` and returns the steps taken. */
function run(swipe: ComposerSwipe, deltas: number[], t0 = 0, dy = 0): number[] {
	const steps: number[] = [];
	deltas.forEach((dx, i) => {
		const r = swipe.feed(dx, dy, t0 + i * 16);
		if (r.step) { steps.push(r.step); }
	});
	return steps;
}

/** A flick: a few large deltas, then a momentum tail fading out. */
function flick(sign: number): number[] {
	const out = [-6, -30, -55, -60].map(d => d * sign);
	for (let d = 50; d > 1; d *= 0.85) { out.push(-d * sign); }
	return out;
}

test('a fast flick to the right moves exactly one tab, tail included', () => {
	assert.deepStrictEqual(run(new ComposerSwipe(), flick(1)), [1]);
});

test('a fast flick to the left moves exactly one tab', () => {
	assert.deepStrictEqual(run(new ComposerSwipe(), flick(-1)), [-1]);
});

test('a momentum tail resuming after a short gap does not step again', () => {
	const swipe = new ComposerSwipe();
	const steps = run(swipe, [-10, -40, -60, -50]);
	steps.push(...run(swipe, [-40, -30, -20, -10], 64 + swipeGapMs + 40));
	assert.deepStrictEqual(steps, [1]);
});

test('a second flick after the lockout moves one more tab', () => {
	const swipe = new ComposerSwipe();
	const steps = run(swipe, flick(1));
	steps.push(...run(swipe, flick(1), 5000));
	assert.deepStrictEqual(steps, [1, 1]);
});

test('a slow drag walks on tab by tab', () => {
	const steps = run(new ComposerSwipe(), new Array(200).fill(-3));
	assert.ok(steps.length >= 3, `steps: ${steps.length}`);
	assert.ok(steps.every(s => s === 1));
});

test('a slow drag holds at each tab before the next step', () => {
	const swipe = new ComposerSwipe();
	const at: number[] = [];
	for (let i = 0; i < 200; i++) {
		if (swipe.feed(-6, 0, i * 16).step) { at.push(i * 16); }
	}
	for (let i = 1; i < at.length; i++) { assert.ok(at[i] - at[i - 1] >= 220, `gap ${at[i] - at[i - 1]}`); }
});

test('a short slow drag below the threshold moves nothing and reports its pull', () => {
	const swipe = new ComposerSwipe();
	let pull = 0;
	for (let i = 0; i < 8; i++) { pull = swipe.feed(-3, 0, i * 16).pull; }
	assert.ok(pull > 0 && pull < 1);
});

test('a vertical gesture is left alone', () => {
	const swipe = new ComposerSwipe();
	const r = [swipe.feed(-2, 10, 0), swipe.feed(-4, 20, 16), swipe.feed(-30, 5, 32)];
	assert.ok(r.every(x => !x.consume && x.step === 0));
});

test('a diagonal start that is mostly sideways is a swipe', () => {
	const swipe = new ComposerSwipe();
	const steps = run(swipe, [-3, -5, -8, -30, -50, -40], 0, 2);
	assert.deepStrictEqual(steps, [1]);
});

test('a second flick inside the first one\'s momentum tail, with no gap, moves one more tab', () => {
	const swipe = new ComposerSwipe();
	const first = [-6, -30, -55, -60, -50, -42, -36, -30, -25, -20, -16, -12];
	const second = [-30, -55, -60, -50, -40, -30, -20, -10, -5, -2, -1];
	assert.deepStrictEqual(run(swipe, [...first, ...second]), [1, 1]);
});

test('a flick back the other way inside the tail moves back', () => {
	const swipe = new ComposerSwipe();
	const first = [-6, -30, -55, -60, -50, -40, -30, -20];
	const back = [30, 55, 60, 40, 20, 10];
	assert.deepStrictEqual(run(swipe, [...first, ...back]), [1, -1]);
});

test('a long fading tail with no new impulse still gives one step', () => {
	const out = [-6, -30, -55, -60];
	for (let d = 58; d > 0.5; d *= 0.95) { out.push(-d); }
	assert.deepStrictEqual(run(new ComposerSwipe(), out), [1]);
});

test('a slow drag right after a flick\'s tail walks on with no pause', () => {
	const swipe = new ComposerSwipe();
	const steps = run(swipe, [...flick(1), ...new Array(80).fill(-4)]);
	assert.ok(steps.length >= 2, `steps: ${steps}`);
	assert.ok(steps.every(s => s === 1));
});
