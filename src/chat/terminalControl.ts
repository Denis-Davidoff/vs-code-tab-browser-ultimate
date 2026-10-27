/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Who may type into a terminal right now: the user, or the agent of the conversation the
 * terminal is pinned to. Two writers on one shell interleave their bytes, and a pinned
 * agent must never fight the person at the keyboard, so:
 *
 * - **The user's typing closes the door for `typingQuietMs`.** Agent input in that window is
 *   refused with a message the model can act on (retry in a moment), and results carry
 *   `userTypedMsAgo` so it can tell the user is around.
 * - **The emergency stop** (`setAllowed(false)`) refuses all agent input until released. The
 *   pin stays: reading is not input.
 * - **The agent's own typing is marked** for `agentActiveMs`, which draws the "typing" dot.
 *
 * Agent input and user input go through different methods on purpose: only `userInput()`
 * feeds the gate, so the agent's own bytes never lock the agent out.
 *
 * A leaf: no `vscode`, no relative value import, an injectable clock, so `npm test` drives it.
 */

/** Agent input is refused for this long after the user last typed. */
export const typingQuietMs = 1500;
/** The "agent is typing" mark lasts this long after the agent's last input. */
export const agentActiveMs = 3000;
/** Output that arrives after this much quiet, while the terminal is not in front, marks it unread. */
export const unreadQuietMs = 2000;

export type AgentInputVerdict =
	| { readonly ok: true; readonly userTypedMsAgo?: number }
	| { readonly ok: false; readonly reason: 'paused' | 'user-typing'; readonly message: string; readonly retryAfterMs?: number; readonly userTypedMsAgo?: number };

export class AgentTypingGate {
	private _allowed = true;
	private _lastUserInput: number | undefined;
	private _lastAgentInput: number | undefined;
	private readonly _now: () => number;

	// A plain field, not a parameter property: Node strips types for `npm test` and refuses those (#49).
	constructor(now: () => number = Date.now) {
		this._now = now;
	}

	public get allowed(): boolean { return this._allowed; }

	public setAllowed(allowed: boolean): void { this._allowed = allowed; }

	/** The user typed (or pasted) into the terminal. */
	public userInput(): void { this._lastUserInput = this._now(); }

	/** Milliseconds since the user last typed here, or `undefined` if they have not (or not within a minute: not worth reporting). */
	public userTypedMsAgo(): number | undefined {
		if (this._lastUserInput === undefined) { return undefined; }
		const ago = Math.max(0, this._now() - this._lastUserInput);
		return ago > 60_000 ? undefined : ago;
	}

	/**
	 * May the agent type now? A `true` answer is not a reservation: the caller writes
	 * straight away and then calls `agentTyped()`.
	 */
	public checkAgentInput(): AgentInputVerdict {
		if (!this._allowed) {
			return { ok: false, reason: 'paused', message: 'The user paused agent control of this terminal. Do not type into it; ask the user to resume it.' };
		}
		const ago = this.userTypedMsAgo();
		if (ago !== undefined && ago < typingQuietMs) {
			return {
				ok: false, reason: 'user-typing', userTypedMsAgo: ago, retryAfterMs: typingQuietMs - ago,
				message: `The user is typing in this terminal right now (${ago} ms ago). Wait a couple of seconds, read the screen again, and retry if it is still what you want.`,
			};
		}
		return { ok: true, ...(ago !== undefined ? { userTypedMsAgo: ago } : {}) };
	}

	/** The agent's input was written: the "typing" mark starts. */
	public agentTyped(): void { this._lastAgentInput = this._now(); }

	/** Whether the agent typed within `agentActiveMs`. */
	public agentActive(): boolean {
		return this._lastAgentInput !== undefined && this._now() - this._lastAgentInput < agentActiveMs;
	}

	/** When the "typing" mark ends, for a timer that redraws the strip; `undefined` when it is off. */
	public agentActiveUntil(): number | undefined {
		return this.agentActive() ? this._lastAgentInput! + agentActiveMs : undefined;
	}
}

/**
 * The "unread" mark of a terminal that is not in front: output after at least
 * `unreadQuietMs` of quiet. A stream that never pauses marks it once, at its first
 * chunk after the last quiet spell, and a terminal the user is looking at is never
 * marked. Cleared by selecting the terminal.
 */
export class UnreadTracker {
	private _unread = false;
	private _lastOutput: number | undefined;
	private readonly _now: () => number;

	constructor(now: () => number = Date.now) {
		this._now = now;
	}

	public get unread(): boolean { return this._unread; }

	/** Output arrived. Returns whether the mark changed (the strip is to be redrawn). */
	public output(inFront: boolean): boolean {
		const now = this._now();
		const quiet = this._lastOutput === undefined || now - this._lastOutput >= unreadQuietMs;
		this._lastOutput = now;
		if (inFront || this._unread || !quiet) { return false; }
		this._unread = true;
		return true;
	}

	/** The terminal was looked at. Returns whether the mark was on. */
	public clear(): boolean {
		const was = this._unread;
		this._unread = false;
		return was;
	}
}
