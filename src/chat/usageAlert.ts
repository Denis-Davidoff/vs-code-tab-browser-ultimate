/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentId, UsageAlert, UsageWindow } from './chatProtocol';

/**
 * The plan-limit line above the chat, and how often the limits are asked
 * for. Leaf module, under test: what the agents report goes in, and what the
 * view shows comes out.
 *
 * - **Which limit**: the one closest to running out, whatever its length — a
 *   weekly limit at 95 % stops the agent as surely as a 5-hour one.
 * - **When the line shows**: a limit at 90 % or more, and again at 100 %; and
 *   when the agent goes on past a limit by spending credits.
 * - **Closed means "seen at this percentage, in this period"**: the line
 *   closed at 91 % stays away while the limit reads 91 %, and comes back at
 *   92 %. A limit that resets — its reset time moves on to a later period —
 *   forgets the close, so the next climb past 90 % shows again. Credits shown
 *   and closed stay away until the limit they were spent past resets.
 * - **Within one period a limit's use only grows.** A lower figure for the
 *   same period is not a reset: Claude Code's two reports disagree by a point
 *   in the same second (measured on 2.1.301: `get_usage` 85 and 24 against
 *   `rate_limit_event` 0.84 and 0.23), and taking the lower one undid every
 *   close — the line came back at 91 % a turn after it was closed at 92 %.
 */

/** A limit at this percentage or more puts the line up. */
export const alertPercent = 90;

/**
 * Two reset times this close are one period: Claude Code's `get_usage` names
 * the same reset with a second's jitter (13:39:59.6 and 13:40:00.2, measured).
 */
export const periodToleranceMs = 10 * 60_000;

/**
 * With no reset time to tell periods apart, a fall of this many points is
 * read as a reset: a real one falls to near zero, two sources' rounding by one.
 */
export const resetDrop = 10;

/** What is known of one agent's plan: its limits, and whether it spends credits now. */
export interface LimitState {
	readonly windows: readonly UsageWindow[];
	readonly usingCredits: boolean;
	/**
	 * What the last turn's own report said about credits, if one did. It
	 * outranks a full read's guess: Claude Code's `get_usage` says only that
	 * extra usage is on, and a limit there reads a point higher than in the
	 * turn's `rate_limit_event`, so "on, and a limit at 100 %" can be a limit
	 * at 99 %; the event's `isUsingOverage` is the CLI's own word.
	 */
	readonly turnSaid?: boolean;
}

/** A limit as it was when the line was closed: its whole percentage, and the period. */
export interface ClosedLimit {
	readonly percent: number;
	readonly resetsAt?: number;
}

/** Credits shown and closed, tied to the limit they were spent past. */
export interface ClosedCredits {
	readonly label?: string;
	readonly percent?: number;
	readonly resetsAt?: number;
}

/** What the user has closed, by agent. */
export type ClosedAlerts = Partial<Record<AgentId, {
	readonly windows?: Readonly<Record<string, ClosedLimit>>;
	readonly credits?: ClosedCredits;
}>>;

/** A limit's percentage as the line names it: whole, never above 100. */
export function wholePercent(used: number): number {
	return Math.max(0, Math.min(100, Math.floor(used)));
}

/**
 * Whether `now` is a later period than `then`: undefined when either reset
 * time is unknown, and the caller has to judge by the figures.
 */
export function laterPeriod(now: number | undefined, then: number | undefined): boolean | undefined {
	if (now === undefined || then === undefined || !Number.isFinite(now) || !Number.isFinite(then)) {
		return undefined;
	}
	return now > then + periodToleranceMs;
}

/** Whether `now` belongs to a period after the one `before` was read in: a reset. */
function hasReset(now: { usedPercent: number; resetsAt?: number }, before: { percent: number; resetsAt?: number }): boolean {
	const later = laterPeriod(now.resetsAt, before.resetsAt);
	return later ?? wholePercent(now.usedPercent) <= before.percent - resetDrop;
}

/** The newer figure for a limit, never lower than the one known for the same period. */
function steady(before: UsageWindow | undefined, now: UsageWindow): UsageWindow {
	if (!before || !(now.usedPercent < before.usedPercent)
		|| hasReset(now, { percent: wholePercent(before.usedPercent), resetsAt: before.resetsAt })) {
		return now;
	}
	return { ...now, usedPercent: before.usedPercent, resetsAt: now.resetsAt ?? before.resetsAt };
}

/**
 * The newest figures merged into what was known. `whole`: a full read of the
 * plan, which replaces the list; otherwise a turn's own report (Claude Code's
 * `rate_limit_event` names only the 5-hour and weekly limits), which replaces
 * the limits it names and keeps the rest. Either way a limit keeps its higher
 * figure within one period (see the module comment). `usingCredits`
 * undefined keeps what was known; a full read's `true` is a guess, and does
 * not overrule a turn that said otherwise (`turnSaid`).
 *
 * **Unless the limit the credits were spent past has reset.** Codex's
 * `account/rateLimits/updated` can only say credits are spent, never that
 * they stopped, so the report of a new period arrived with `usingCredits`
 * undefined, the old `true` was kept, and the line said "now spending
 * credits" over a limit at 2 % — and its close was forgotten in the same
 * report, since the limit had reset. A limit at 100 % that a report shows
 * reset ends the credits, unless another limit is still at 100 %.
 */
export function mergeLimits(previous: LimitState | undefined, windows: readonly UsageWindow[], usingCredits: boolean | undefined, whole: boolean): LimitState {
	const before = new Map((previous?.windows ?? []).map(w => [w.label, w] as const));
	const named = new Set(windows.map(w => w.label));
	const kept = whole || !previous ? [] : previous.windows.filter(w => !named.has(w.label));
	const merged = [...kept, ...windows.map(w => steady(before.get(w.label), w))];
	const reachedReset = windows.some(w => {
		const old = before.get(w.label);
		return !!old && old.usedPercent >= 100 && w.usedPercent < old.usedPercent
			&& hasReset(w, { percent: wholePercent(old.usedPercent), resetsAt: old.resetsAt });
	});
	const creditsEnded = usingCredits === undefined && reachedReset && !merged.some(w => w.usedPercent >= 100);
	const turnSaid = creditsEnded ? undefined : whole ? previous?.turnSaid : usingCredits ?? previous?.turnSaid;
	const credits = creditsEnded ? false : whole && usingCredits === true ? turnSaid ?? true : usingCredits;
	return {
		windows: merged,
		usingCredits: credits ?? previous?.usingCredits ?? false,
		...(turnSaid !== undefined ? { turnSaid } : {}),
	};
}

/**
 * The figures as they stand at `now`: a limit whose reset time has passed is
 * left out — its figure belongs to a period that is over, and the next report
 * gives the new one — and credits spent past a limit that has reset are no
 * longer spent, unless another limit is still at 100 %. Without this the line
 * went on saying "reached, resets in 40 min" and `U` stayed red after the
 * reset, until the next message brought new figures.
 */
export function currentLimits(state: LimitState | undefined, now: number): LimitState | undefined {
	if (!state) {
		return undefined;
	}
	const over = (w: UsageWindow) => w.resetsAt !== undefined && w.resetsAt <= now;
	if (!state.windows.some(over)) {
		return state;
	}
	const windows = state.windows.filter(w => !over(w));
	const reachedReset = state.windows.some(w => over(w) && w.usedPercent >= 100);
	const stillReached = windows.some(w => w.usedPercent >= 100);
	if (reachedReset && !stillReached) {
		// A turn's word that credits were spent was about the period that ended.
		const { turnSaid: _said, ...rest } = state;
		return { ...rest, windows, usingCredits: false };
	}
	return { ...state, windows };
}

/** The earliest reset still to come, for a timer that shows it when it passes. */
export function nextReset(state: LimitState | undefined, now: number): number | undefined {
	let next: number | undefined;
	for (const w of state?.windows ?? []) {
		if (w.resetsAt !== undefined && Number.isFinite(w.resetsAt) && w.resetsAt > now && (next === undefined || w.resetsAt < next)) {
			next = w.resetsAt;
		}
	}
	return next;
}

/** The limit closest to running out; on a tie, the one that resets first. */
export function closestLimit(state: LimitState | undefined): UsageWindow | undefined {
	let best: UsageWindow | undefined;
	for (const w of state?.windows ?? []) {
		if (!Number.isFinite(w.usedPercent)) {
			continue;
		}
		if (!best || w.usedPercent > best.usedPercent
			|| (w.usedPercent === best.usedPercent && (w.resetsAt ?? Infinity) < (best.resetsAt ?? Infinity))) {
			best = w;
		}
	}
	return best;
}

/** Whether a close of `w` still stands: made in this period, at its percentage or higher. */
function closedFor(w: UsageWindow, closed: ClosedLimit | undefined): boolean {
	return !!closed && !hasReset(w, closed) && wholePercent(w.usedPercent) <= closed.percent;
}

/** Whether closed credits still stand: the limit they were spent past has not reset. */
function creditsClosed(state: LimitState, credits: ClosedCredits | undefined): boolean {
	if (!credits) {
		return false;
	}
	const tied = credits.label !== undefined ? state.windows.find(w => w.label === credits.label) : undefined;
	return !tied || credits.percent === undefined || !hasReset(tied, { percent: credits.percent, resetsAt: credits.resetsAt });
}

/** The line for `agent` now, or undefined: nothing near a limit, or all of it closed already. */
export function usageAlertFor(agent: AgentId, state: LimitState | undefined, closed: ClosedAlerts): UsageAlert | undefined {
	if (!state) {
		return undefined;
	}
	const seen = closed[agent];
	const closest = closestLimit(state);
	if (state.usingCredits && closest && !creditsClosed(state, seen?.credits)) {
		return { agent, kind: 'credits', label: closest.label, percent: wholePercent(closest.usedPercent), resetsAt: closest.resetsAt };
	}
	let best: UsageWindow | undefined;
	for (const w of state.windows) {
		if (!Number.isFinite(w.usedPercent) || wholePercent(w.usedPercent) < alertPercent || closedFor(w, seen?.windows?.[w.label])) {
			continue;
		}
		if (!best || w.usedPercent > best.usedPercent) {
			best = w;
		}
	}
	if (!best) {
		return undefined;
	}
	const percent = wholePercent(best.usedPercent);
	return { agent, kind: percent >= 100 ? 'reached' : 'high', label: best.label, percent, resetsAt: best.resetsAt };
}

/**
 * Closing the line records everything it stood for, not only the limit it
 * named: every limit at 90 % or more at its percentage and period now, and
 * the credits. Otherwise closing "now spending credits" would bring "limit
 * reached" up in its place, for the same moment. `shown`: the line the user
 * closed — a figure that arrived while the click was on its way is not
 * closed above what was on screen, and credits only when they were.
 */
export function closeAlert(closed: ClosedAlerts, agent: AgentId, state: LimitState | undefined, shown?: UsageAlert): ClosedAlerts {
	const previous = closed[agent];
	const windows: Record<string, ClosedLimit> = { ...previous?.windows };
	for (const w of state?.windows ?? []) {
		if (!Number.isFinite(w.usedPercent)) {
			continue;
		}
		let percent = wholePercent(w.usedPercent);
		if (shown && shown.label === w.label) {
			percent = Math.min(percent, shown.percent);
		}
		if (percent >= alertPercent) {
			const old = windows[w.label];
			const same = old && !hasReset(w, old);
			windows[w.label] = { percent: same ? Math.max(percent, old.percent) : percent, resetsAt: w.resetsAt };
		}
	}
	// Tied to a limit, or not recorded at all: a close naming no limit is never
	// judged again (`settleClosed` judges the limits a report names) and would
	// hide every later credits line of this agent.
	const closest = closestLimit(state);
	const credits: ClosedCredits | undefined = state?.usingCredits && closest && (!shown || shown.kind === 'credits')
		? { label: closest.label, percent: wholePercent(closest.usedPercent), resetsAt: closest.resetsAt }
		: previous?.credits;
	return { ...closed, [agent]: { windows, ...(credits ? { credits } : {}) } };
}

/**
 * What was closed and no longer applies, forgotten: a limit that has reset —
 * its reset time moved on, or, with none known, its figure fell by
 * `resetDrop` — and credits whose limit has reset. A lower figure in the
 * same period is kept: it is rounding, not a reset. Answers the same object
 * when nothing changed, so the caller can tell whether to store it.
 *
 * `named`: the limits the latest report gave. Only those are judged — the
 * closes are shared by every window, and a figure this window kept from an
 * earlier report (a model's own weekly limit, which a turn's report leaves
 * out) may be older than the close another window made.
 */
export function settleClosed(closed: ClosedAlerts, agent: AgentId, state: LimitState | undefined, named?: ReadonlySet<string>): ClosedAlerts {
	const seen = closed[agent];
	if (!seen || !state) {
		return closed;
	}
	const judged = (label: string | undefined) => label !== undefined && (!named || named.has(label));
	let changed = false;
	const windows: Record<string, ClosedLimit> = {};
	for (const [label, at] of Object.entries(seen.windows ?? {})) {
		const now = judged(label) ? state.windows.find(w => w.label === label) : undefined;
		// A limit the latest figures do not name is kept: a turn's own report
		// leaves some out, and that says nothing about them.
		if (now && Number.isFinite(now.usedPercent) && hasReset(now, at)) {
			changed = true;
			continue;
		}
		windows[label] = at;
	}
	let credits = seen.credits;
	if (credits && (!named || judged(credits.label)) && !creditsClosed(state, credits)) {
		credits = undefined;
		changed = true;
	}
	if (!changed) {
		return closed;
	}
	const rest = { ...closed };
	if (Object.keys(windows).length || credits) {
		rest[agent] = { windows, ...(credits ? { credits } : {}) };
	} else {
		delete rest[agent];
	}
	return rest;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * What `globalState` holds, read with nothing taken on trust: another build,
 * or a hand edit, may have written anything there, and the view reads it on
 * every post. Unknown agents and malformed entries are dropped.
 */
export function readClosedAlerts(stored: unknown): ClosedAlerts {
	const out: ClosedAlerts = {};
	if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
		return out;
	}
	for (const agent of ['claude', 'codex'] as const) {
		const entry = (stored as Record<string, unknown>)[agent];
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			continue;
		}
		const raw = (entry as Record<string, unknown>).windows;
		const windows: Record<string, ClosedLimit> = {};
		if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
			for (const [label, value] of Object.entries(raw).slice(0, 50)) {
				const v = value as Record<string, unknown> | null;
				if (v && typeof v === 'object' && finite(v.percent)) {
					windows[label] = { percent: v.percent, ...(finite(v.resetsAt) ? { resetsAt: v.resetsAt } : {}) };
				}
			}
		}
		const c = (entry as Record<string, unknown>).credits as Record<string, unknown> | undefined | null;
		// A credits close names its limit, or it could never be judged again.
		const credits: ClosedCredits | undefined = c && typeof c === 'object' && !Array.isArray(c) && typeof c.label === 'string'
			? {
				label: c.label,
				...(finite(c.percent) ? { percent: c.percent } : {}),
				...(finite(c.resetsAt) ? { resetsAt: c.resetsAt } : {}),
			}
			: undefined;
		if (Object.keys(windows).length || credits) {
			out[agent] = { windows, ...(credits ? { credits } : {}) };
		}
	}
	return out;
}

/** One finished turn, as heavy as it was: tokens that count against a plan, and its length. */
export interface TurnWeight {
	/** Input not read from the cache, plus output. */
	readonly tokens: number;
	readonly ms: number;
}

/** Never asked more often than this, however busy the chat. */
export const usageCheckMinGapMs = 60_000;
/** A turn this heavy is a "big request": the limits are asked for after it. */
export const bigTurnTokens = 40_000;
export const longTurnMs = 3 * 60_000;
/** Near the line, asked again after any turn, this long after the last time. */
export const nearPercent = 80;
export const nearGapMs = 3 * 60_000;
/** Otherwise asked again after a turn only this long after the last time. */
export const idleGapMs = 15 * 60_000;

/**
 * Whether to ask the agent for its plan's limits after a turn ended. Not
 * often: after a big request, more readily once near the line, and otherwise
 * now and then. `last` is when it was last asked (undefined: never in this
 * window); a time in the future counts as long ago, since a clock that moved
 * back must not stop the checks.
 */
export function usageCheckDue(now: number, last: number | undefined, turn: TurnWeight, percent: number | undefined): boolean {
	if (last === undefined || last > now) {
		return true;
	}
	const since = now - last;
	if (since < usageCheckMinGapMs) {
		return false;
	}
	if (turn.tokens >= bigTurnTokens || turn.ms >= longTurnMs) {
		return true;
	}
	if (percent !== undefined && percent >= nearPercent && since >= nearGapMs) {
		return true;
	}
	return since >= idleGapMs;
}
