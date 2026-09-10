/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ClientKind } from './mcpProtocol';

/*
 * Who works on which tab.
 *
 * A leaf on purpose — no `vscode`, no CDP, nothing but bookkeeping — because
 * this is where the rules that matter live: precedence between an assignment
 * made to one conversation, one assistant, and everybody; what happens when a
 * shared tab closes; and who has actually driven a tab. `npm test` loads it
 * directly, and the controller above it only resolves sessions and drives CDP.
 *
 * The map runs **assistant → tab**, and that direction is the whole design:
 * several assistants can point at the same tab (Claude and Codex working the
 * same page, which is what was asked for), while one assistant is never in two
 * places at once. Keyed the other way round it would have been a set per tab,
 * and "which tab does this call act on" — the only question a tool ever asks —
 * would need a scan.
 *
 * `import type` from `mcpProtocol` and nothing else: that module is itself
 * import-free, so the type costs nothing at runtime *and* drags nothing into
 * the test project.
 */

/** Who a tab is given to. */
export type ShareTarget =
	/** Every assistant that has no tab of its own. */
	| { readonly scope: 'everyone' }
	/** One assistant, by kind — survives its restarts, because the kind does. */
	| { readonly scope: 'kind'; readonly kind: ClientKind }
	/** One conversation, by the `Mcp-Session-Id` it was given at `initialize`. */
	| { readonly scope: 'session'; readonly session: string; readonly kind: ClientKind };

export const everyone: ShareTarget = { scope: 'everyone' };

export function forKind(kind: ClientKind): ShareTarget {
	return { scope: 'kind', kind };
}

export function forSession(session: string, kind: ClientKind): ShareTarget {
	return { scope: 'session', session, kind };
}

/** The identity a call arrives with. */
export interface CallerIdentity {
	readonly kind: ClientKind;
	readonly sessionId?: string;
}

/** What a tab's marker has to say. */
export interface TabShareState {
	/** An assistant has driven this tab at least once. */
	readonly used: boolean;
	/** Assistant-specific owners, in a stable order. */
	readonly kinds: readonly ClientKind[];
	/** Whether the tab is also the one every other assistant follows. */
	readonly everyone: boolean;
}

/** One assignment, for the UI to render and for the user to undo. */
export interface ShareAssignment<T> {
	readonly target: ShareTarget;
	readonly tab: T;
	readonly usedBy: readonly ClientKind[];
}

/** Why a call has no tab. */
export type Resolution<T> =
	/** Act on this tab, because it was given to this caller. */
	| { readonly kind: 'shared'; readonly tab: T; readonly target: ShareTarget }
	/** The tab that was given to this caller is gone; only the user can move on. */
	| { readonly kind: 'paused'; readonly target: ShareTarget }
	/** Nothing was given to this caller; the caller follows the user. */
	| { readonly kind: 'unassigned' };

const kindOrder: readonly ClientKind[] = ['claude', 'codex', 'other'];

function keyOf(target: ShareTarget): string {
	switch (target.scope) {
		case 'everyone': return 'everyone';
		case 'kind': return `kind:${target.kind}`;
		case 'session': return `session:${target.session}`;
	}
}

/**
 * The one key that *is* this caller, for state that belongs to it alone.
 *
 * The most specific identity available: a conversation when the client echoes
 * its session id, the assistant otherwise. Used for the model's own tab
 * selection, which was a single window-wide field until Codex's
 * `browser_select_tab` was found redirecting Claude's next call.
 */
export function callerKey(caller: CallerIdentity): string {
	return caller.sessionId ? `session:${caller.sessionId}` : `kind:${caller.kind}`;
}

/**
 * The keys a caller answers to, **most specific first**.
 *
 * The order is the feature: a conversation that was handed its own page keeps
 * it even though the assistant as a whole has another, and an assistant with
 * its own page ignores the one everybody else follows.
 */
function keysFor(caller: CallerIdentity): string[] {
	const keys: string[] = [];
	if (caller.sessionId) {
		keys.push(`session:${caller.sessionId}`);
	}
	keys.push(`kind:${caller.kind}`, 'everyone');
	return keys;
}

export class ShareRegistry<T> {

	private readonly _shares = new Map<string, { target: ShareTarget; tab: T }>();

	/**
	 * Keys whose tab has closed.
	 *
	 * Kept rather than deleted, because "the page you were given is gone" and
	 * "you were never given one" are different answers: the first pauses that
	 * assistant until the user acts, and the second falls back to whatever the
	 * user is looking at. Deleting the entry would silently turn the first into
	 * the second, which is exactly the instruction-undoing the share exists to
	 * prevent — and now it has to be per assistant, or one closed tab would
	 * pause an assistant that still has a page of its own.
	 */
	private readonly _lost = new Map<string, ShareTarget>();

	private readonly _usedBy = new Map<T, Set<ClientKind>>();

	/** Gives a tab to one target, replacing whatever that target had. */
	public share(target: ShareTarget, tab: T): void {
		const key = keyOf(target);
		this._lost.delete(key);
		this._shares.set(key, { target, tab });
	}

	/**
	 * The tab this exact target holds, if any.
	 *
	 * Direct, because deriving it by resolving a *caller* built from the target
	 * was wrong twice over: the everyone target became `{ kind: 'other' }`,
	 * which resolves through `kind:other` first and would answer with somebody
	 * else's assignment, and a session target answered for its assistant as
	 * well. One key, one lookup.
	 */
	public tabOf(target: ShareTarget): T | undefined {
		return this._shares.get(keyOf(target))?.tab;
	}

	/** Takes the assignment away, and reports the tab it pointed at. */
	public stop(target: ShareTarget): T | undefined {
		const key = keyOf(target);
		const existing = this._shares.get(key);
		this._shares.delete(key);
		this._lost.delete(key);
		return existing?.tab;
	}

	/** Clears everything, and reports every tab that was pointed at. */
	public stopAll(): T[] {
		const tabs = [...new Set([...this._shares.values()].map(entry => entry.tab))];
		this._shares.clear();
		this._lost.clear();
		return tabs;
	}

	public get isEmpty(): boolean {
		return this._shares.size === 0 && this._lost.size === 0;
	}

	/** Which tab this caller acts on, or why it has none. */
	public resolve(caller: CallerIdentity): Resolution<T> {
		for (const key of keysFor(caller)) {
			const share = this._shares.get(key);
			if (share) {
				return { kind: 'shared', tab: share.tab, target: share.target };
			}
			const lost = this._lost.get(key);
			if (lost) {
				// The first key that has *anything* to say decides. Falling
				// through to a broader assignment would resume work on a page
				// the user did not choose for this caller.
				return { kind: 'paused', target: lost };
			}
		}
		return { kind: 'unassigned' };
	}

	/**
	 * A tab has closed: every assignment pointing at it becomes `paused`.
	 *
	 * Returns those targets so the caller can tell the user which assistants
	 * are now waiting.
	 */
	public forget(tab: T): ShareTarget[] {
		const lost: ShareTarget[] = [];
		for (const [key, share] of [...this._shares]) {
			if (share.tab === tab) {
				this._shares.delete(key);
				this._lost.set(key, share.target);
				lost.push(share.target);
			}
		}
		this._usedBy.delete(tab);
		return lost;
	}

	/** Records that an assistant drove a tab. Answers whether that is news. */
	public noteUse(tab: T, kind: ClientKind): boolean {
		const kinds = this._usedBy.get(tab) ?? new Set<ClientKind>();
		if (kinds.has(kind)) {
			return false;
		}
		kinds.add(kind);
		this._usedBy.set(tab, kinds);
		return true;
	}

	public usedBy(tab: T): ClientKind[] {
		return kindOrder.filter(kind => this._usedBy.get(tab)?.has(kind));
	}

	/**
	 * Everything the UI needs, most specific assignments last.
	 *
	 * `usedBy` is filtered to the assignment's **own** assistant, not to
	 * everyone who has ever driven that tab. Reporting the tab's whole history
	 * made a fresh assignment look like work in progress: let Claude use a tab,
	 * then give the same tab to Codex, and Codex was immediately shown as
	 * "working" — which suppressed the one hint that matters, "it has not
	 * picked this up yet, so restart it if it reports no tools".
	 */
	public assignments(): ShareAssignment<T>[] {
		const order = ['everyone', 'kind', 'session'];
		return [...this._shares.values()]
			.sort((a, b) => order.indexOf(a.target.scope) - order.indexOf(b.target.scope))
			.map(share => ({
				target: share.target,
				tab: share.tab,
				usedBy: this.usedByTarget(share.target, share.tab),
			}));
	}

	/** Who, among the assistants this assignment covers, has driven the tab. */
	public usedByTarget(target: ShareTarget, tab: T): ClientKind[] {
		const used = this.usedBy(tab);
		return target.scope === 'everyone' ? used : used.filter(kind => kind === target.kind);
	}

	/** Assignments whose tab is gone, so the UI can offer to move or release them. */
	public pausedTargets(): ShareTarget[] {
		return [...this._lost.values()];
	}

	public tabs(): T[] {
		return [...new Set([...this._shares.values()].map(share => share.tab))];
	}

	public targetsFor(tab: T): ShareTarget[] {
		return [...this._shares.values()].filter(share => share.tab === tab).map(share => share.target);
	}

	/** What the marker on one tab has to show. */
	public stateOf(tab: T): TabShareState | undefined {
		const targets = this.targetsFor(tab);
		if (targets.length === 0) {
			return undefined;
		}
		const kinds = new Set<ClientKind>();
		let all = false;
		for (const target of targets) {
			if (target.scope === 'everyone') {
				all = true;
			} else {
				kinds.add(target.kind);
			}
		}
		return {
			// Whether anyone who holds the tab **now** has driven it, not
			// whether anyone ever did. The tab's whole history made a
			// re-assigned tab read as 🤖 — "somebody is working here" — while
			// the menu correctly said the new owner had not picked it up, which
			// is the one hint the two marker states exist for.
			used: targets.some(target => this.usedByTarget(target, tab).length > 0),
			kinds: kindOrder.filter(kind => kinds.has(kind)),
			everyone: all,
		};
	}
}

/**
 * Whether a value really is a target, for arguments that arrive from a menu.
 *
 * VS Code hands a command invoked from `editor/title` the **editor's resource**
 * as its first argument, so a command that reads `arg0` as its own parameter
 * gets a `Uri` instead — and the share commands then resolved a key from
 * `undefined` and threw, which killed sharing from the browser tab's own
 * toolbar. Anything that is not shaped like a target is treated as "no
 * argument".
 */
export function isShareTarget(value: unknown): value is ShareTarget {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const scope = (value as { scope?: unknown }).scope;
	return scope === 'everyone' || scope === 'kind' || scope === 'session';
}

/** `Claude Code`, `Codex`, or something honest for a client that did not say. */
export function assistantName(kind: ClientKind): string {
	return kind === 'claude' ? 'Claude Code' : kind === 'codex' ? 'Codex' : 'another assistant';
}

/** How a target reads in a menu row or a confirmation. */
export function targetName(target: ShareTarget): string {
	switch (target.scope) {
		case 'everyone': return 'all assistants';
		case 'kind': return assistantName(target.kind);
		case 'session': return `${assistantName(target.kind)} (this conversation)`;
	}
}
