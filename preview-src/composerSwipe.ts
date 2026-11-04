/*
 * The composer tabs' sideways swipe, as a pure state machine: wheel deltas in, tab steps out.
 * A leaf module under test (`composerSwipe.test.ts`); `chat.ts` feeds it and applies the steps.
 *
 * Two kinds of gesture, told apart by speed (asked for):
 * - a fast flick moves exactly one tab: it steps early, then the rest of the gesture and its
 *   momentum tail are swallowed, and a hard lockout outlives short gaps in that tail;
 * - a slow drag works like a magnet: the tab in front resists until the drag passes a
 *   threshold, then snaps to the next one, and holds there for a moment before the next step
 *   can arm, so a slow drag can walk on tab by tab without skipping.
 */

export interface SwipeResult {
	/** Whether the event belongs to the swipe (the caller then prevents its default). */
	consume: boolean;
	/** Tabs to move: 1 is the next tab to the right, -1 to the left. */
	step: -1 | 0 | 1;
	/** How far the slow drag has pulled towards the next step, -1..1 in tab direction. */
	pull: number;
}

export const swipeGapMs = 200;
const axisPx = 6;
const slowStepPx = 56;
const fastStepPx = 28;
const flickPx = 24;
const flickSpeed = 0.6;
const speedWindowMs = 80;
const settleMs = 220;
const lockoutMs = 350;
/** A new flick inside a momentum tail: the tail only fades, so a delta this much above the last one is a finger. */
const reflickRatio = 2;
const reflickAfterMs = 120;
const tailEndPx = 2;

export class ComposerSwipe {
	private _last = -Infinity;
	private _axis: 'x' | 'y' | undefined;
	private _sx = 0;
	private _sy = 0;
	private _pending = 0;
	private _acc = 0;
	private _peak = 0;
	private _samples: { t: number; dx: number }[] = [];
	private _locked = false;
	private _lockUntil = -Infinity;
	private _lastStep = -Infinity;
	private _stepped = false;
	private _lastAbs = 0;
	private _fastAt = -Infinity;
	private _fastSign = 0;

	/** `dx` as the browser reports it: with natural scrolling, fingers moving right are negative. */
	feed(dx: number, dy: number, t: number): SwipeResult {
		if (t - this._last > swipeGapMs) { this._start(); }
		this._last = t;
		if (this._axis === undefined) {
			this._sx += Math.abs(dx);
			this._sy += Math.abs(dy);
			this._pending += dx;
			if (this._sx + this._sy < axisPx) { return { consume: false, step: 0, pull: 0 }; }
			this._axis = this._sx >= this._sy ? 'x' : 'y';
			if (this._axis === 'y') { return { consume: false, step: 0, pull: 0 }; }
			dx = this._pending;
		} else if (this._axis === 'y') {
			return { consume: false, step: 0, pull: 0 };
		}
		if (this._locked || t < this._lockUntil) {
			const abs = Math.abs(dx);
			const lastAbs = this._lastAbs;
			this._lastAbs = abs;
			// A momentum tail only fades. A delta that jumps well above the last one, or turns the
			// other way at flick speed, is the finger again: a new flick, not more of the tail.
			const reflick = abs >= flickPx && t - this._fastAt >= reflickAfterMs
				&& (abs > lastAbs * reflickRatio || (this._fastSign !== 0 && Math.sign(dx) !== this._fastSign));
			// The tail has faded out: the lock is over and a slow drag may follow without a pause.
			if (!reflick && abs <= tailEndPx && t - this._fastAt >= lockoutMs) {
				this._locked = false;
				this._lockUntil = -Infinity;
				this._acc = 0;
				this._peak = 0;
				this._samples = [];
				return { consume: true, step: 0, pull: 0 };
			}
			if (!reflick) {
				// Swallow the rest of a flick and its tail; keep the lockout going while it lasts.
				if (this._locked) { this._lockUntil = Math.max(this._lockUntil, t + swipeGapMs); }
				return { consume: true, step: 0, pull: 0 };
			}
			this._start();
			this._axis = 'x';
			this._lockUntil = -Infinity;
		}
		this._lastAbs = Math.abs(dx);
		if (dx === 0) { return { consume: true, step: 0, pull: this._pull() }; }
		if (this._acc !== 0 && Math.sign(dx) !== Math.sign(this._acc)) { this._acc = 0; }
		this._acc += dx;
		this._peak = Math.max(this._peak, Math.abs(dx));
		this._samples.push({ t, dx: Math.abs(dx) });
		while (this._samples.length > 1 && t - this._samples[0].t > speedWindowMs) { this._samples.shift(); }
		const span = Math.max(16, t - this._samples[0].t);
		const speed = this._samples.reduce((s, x) => s + x.dx, 0) / span;
		const fast = this._peak >= flickPx || speed >= flickSpeed;
		const step: -1 | 1 = this._acc < 0 ? 1 : -1;
		if (fast && Math.abs(this._acc) >= fastStepPx) {
			this._locked = true;
			this._lockUntil = t + lockoutMs;
			this._fastAt = t;
			this._fastSign = Math.sign(this._acc);
			this._acc = 0;
			return { consume: true, step, pull: 0 };
		}
		if (!fast && Math.abs(this._acc) >= slowStepPx) {
			if (this._stepped && t - this._lastStep < settleMs) {
				// The magnet holds the tab just reached: the drag waits at the threshold.
				this._acc = Math.sign(this._acc) * slowStepPx;
				return { consume: true, step: 0, pull: this._pull() };
			}
			this._stepped = true;
			this._lastStep = t;
			this._acc = 0;
			return { consume: true, step, pull: 0 };
		}
		return { consume: true, step: 0, pull: this._pull() };
	}

	/** The swipe could not move (no tab that way): drop what was gathered. */
	blocked(): void {
		this._acc = 0;
	}

	private _pull(): number {
		return Math.max(-1, Math.min(1, -this._acc / slowStepPx));
	}

	private _start(): void {
		this._axis = undefined;
		this._sx = 0;
		this._sy = 0;
		this._pending = 0;
		this._acc = 0;
		this._peak = 0;
		this._samples = [];
		this._locked = false;
		this._stepped = false;
		this._lastStep = -Infinity;
	}
}
