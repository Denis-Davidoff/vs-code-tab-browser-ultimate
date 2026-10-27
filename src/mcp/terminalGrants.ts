/**
 * One-shot grants for input to a terminal: the approval, made enforceable at
 * the point where the input takes effect.
 *
 * The approval card is asked over each CLI's own channel, and that channel can
 * be skipped by something the chat does not control — a user's `allow` rule for
 * the whole `ai-browser` server, a `PreToolUse` hook, a CLI configured to
 * accept MCP tools, Gemini giving us nothing but a title. So the answer the
 * user gives (a click, "Always", or an approval menu on Auto) mints a grant
 * here, and `terminal_send` / `terminal_key` refuse without one to consume. An
 * input that no card was ever shown for cannot be typed.
 *
 * - **Single use**: one approval, one input.
 * - **Short**: 120 s. The CLI runs the tool right after the answer; a grant
 *   still there minutes later is not that approval.
 * - **Keyed by conversation, tool and what is typed**: an approval of `ls` does
 *   not cover `rm -rf ~`. The fingerprint is `terminalInputFingerprint`.
 * - **A grant with no fingerprint** is for a CLI that gave no arguments that
 *   could be read (Gemini's title when it does not parse). It is consumed only
 *   when no exact grant fits, and lives half as long: it vouches for whatever
 *   was typed next, which is as much as the card could say.
 *
 * A leaf: no imports, an injectable clock, under test.
 */

export const grantTtlMs = 120_000;
export const wildcardGrantTtlMs = 60_000;
/** Most grants held for one conversation; the oldest goes first. */
export const maxGrantsPerChat = 16;

interface Grant {
	readonly tool: string;
	/** Absent: any input of the tool. */
	readonly fingerprint: string | undefined;
	readonly expires: number;
}

export class TerminalGrants {
	private readonly _byChat = new Map<string, Grant[]>();

	private readonly _now: () => number;

	// No parameter property: Node's type stripping, which loads this under `npm test`, refuses one.
	constructor(now: () => number = Date.now) {
		this._now = now;
	}

	/** The user approved this input (or the menu did): the next such call may run once. */
	public mint(chatId: string, tool: string, fingerprint?: string): void {
		const now = this._now();
		const held = this._live(chatId, now);
		held.push({ tool, fingerprint, expires: now + (fingerprint === undefined ? wildcardGrantTtlMs : grantTtlMs) });
		while (held.length > maxGrantsPerChat) {
			held.shift();
		}
		this._byChat.set(chatId, held);
	}

	/**
	 * Uses one grant for this exact input. An exact one wins over a wildcard,
	 * and the earliest of equals goes first. `false` when there is none: the
	 * caller refuses.
	 */
	public consume(chatId: string, tool: string, fingerprint: string): boolean {
		const held = this._live(chatId, this._now());
		let index = held.findIndex(g => g.tool === tool && g.fingerprint === fingerprint);
		if (index < 0) {
			index = held.findIndex(g => g.tool === tool && g.fingerprint === undefined);
		}
		if (index < 0) {
			this._store(chatId, held);
			return false;
		}
		held.splice(index, 1);
		this._store(chatId, held);
		return true;
	}

	/** Gives a consumed grant back, when the input it was spent on was refused before anything was typed. */
	public refund(chatId: string, tool: string, fingerprint: string): void {
		this.mint(chatId, tool, fingerprint);
	}

	/** Forgets a conversation's grants: it ended, or its terminals were unpinned. */
	public clear(chatId: string): void {
		this._byChat.delete(chatId);
	}

	/** How many live grants a conversation holds, for tests and the status of a call. */
	public count(chatId: string): number {
		return this._live(chatId, this._now()).length;
	}

	private _live(chatId: string, now: number): Grant[] {
		return (this._byChat.get(chatId) ?? []).filter(g => g.expires > now);
	}

	private _store(chatId: string, held: Grant[]): void {
		if (held.length) {
			this._byChat.set(chatId, held);
		} else {
			this._byChat.delete(chatId);
		}
	}
}
