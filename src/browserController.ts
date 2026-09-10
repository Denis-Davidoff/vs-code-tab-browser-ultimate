/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CDPClient } from './cdp';
import { extractElementData, renderElementMarkdown } from './elementContext';
import { isBrowserApiGranted } from './proposedApi';
import { markerSuffix, ShareIndicator, stripMarker, stripMarkerFromHtml } from './shareIndicator';
import {
	callerKey, everyone, ShareRegistry, targetName,
	type CallerIdentity, type ShareTarget,
} from './shareRegistry';
import type { ClientKind } from './mcpProtocol';

/**
 * What the browser can do, expressed without transport or CDP detail.
 *
 * This is the only layer that turns "no tab is open" into a sentence a model can
 * act on: it throws `Error`, and the protocol layer reports the message as
 * `isError: true`. The transport knows nothing about tabs, and nothing here
 * knows about JSON-RPC.
 */

interface ConsoleLine {
	readonly level: string;
	readonly text: string;
}

/** How many console lines to keep. Enough to be useful, bounded so it cannot grow without limit. */
const consoleLimit = 200;

/** One assignment, as the UI shows it. */
export interface ShareEntry {
	readonly target: ShareTarget;
	/** Who it is for, as it reads in a row: `Claude Code`, `all assistants`. */
	readonly label: string;
	readonly tabId: string;
	readonly url: string;
	readonly title: string | undefined;
	readonly usedBy: readonly ClientKind[];
}

/** Every assignment in this window, plus the ones waiting on the user. */
export interface ShareView {
	readonly assignments: readonly ShareEntry[];
	readonly paused: readonly { readonly target: ShareTarget; readonly label: string }[];
}

/**
 * What every tool answers once the tab the user shared has been closed.
 *
 * Falling back to whichever page is focused is what the share exists to
 * prevent, so the tools stay paused instead — a share is a decision by the
 * user, and only the user can move it. The message therefore has to name the
 * fix, because the model cannot apply it.
 */
function shareLostMessage(target: ShareTarget): string {
	const whose = target.scope === 'everyone'
		? 'The browser tab the user shared with the assistants'
		: `The browser tab the user shared with ${targetName(target)}`;
	return `${whose} has been closed, so the browser tools are paused for you. They will not fall back to whichever `
		+ 'page the user happens to be looking at. Ask the user to open the page you should work with and share it — '
		+ '"AI Browser: Share Tab with…", from the status bar menu or the toolbar menu on the browser tab.';
}

/**
 * A CDP session held open for one tab.
 *
 * Console capture is the reason this is cached rather than opened per call:
 * messages only arrive while something is attached, so a session created on
 * demand would report an empty log for everything that happened before.
 */
class TabSession {

	private readonly _console: ConsoleLine[] = [];
	private readonly _subscriptions: vscode.Disposable[] = [];
	private _indicator: ShareIndicator | undefined;

	private constructor(
		public readonly client: CDPClient,
		public readonly sessionId: string,
	) { }

	public static async open(tab: vscode.BrowserTab): Promise<TabSession> {
		const client = new CDPClient(await tab.startCDPSession());
		try {
			const sessionId = await client.attachToPage();
			const session = new TabSession(client, sessionId);
			await session._enableDomains();
			return session;
		} catch (err) {
			client.dispose();
			throw err;
		}
	}

	private async _enableDomains(): Promise<void> {
		await this.client.send('DOM.enable', {}, this.sessionId);
		await this.client.send('CSS.enable', {}, this.sessionId);
		await this.client.send('Runtime.enable', {}, this.sessionId);
		await this.client.send('Log.enable', {}, this.sessionId);
		// Page is enabled here rather than per call because `navigate` waits for
		// `Page.loadEventFired` on this session.
		await this.client.send('Page.enable', {}, this.sessionId);

		this._subscriptions.push(this.client.on('Runtime.consoleAPICalled', (params: any) => {
			const text = (params.args ?? [])
				.map((arg: any) => arg.value ?? arg.description ?? arg.unserializableValue ?? '')
				.join(' ');
			this._record(params.type ?? 'log', text);
		}));

		this._subscriptions.push(this.client.on('Log.entryAdded', (params: any) => {
			this._record(params.entry?.level ?? 'log', params.entry?.text ?? '');
		}));

		this._subscriptions.push(this.client.on('Runtime.exceptionThrown', (params: any) => {
			const details = params.exceptionDetails;
			this._record('error', details?.exception?.description ?? details?.text ?? 'Uncaught exception');
		}));
	}

	private _record(level: string, text: string): void {
		this._console.push({ level, text });
		if (this._console.length > consoleLimit) {
			this._console.splice(0, this._console.length - consoleLimit);
		}
	}

	/**
	 * Whether the channel under this session has gone.
	 *
	 * The host can drop a session; a stale one then rejects every send with "CDP
	 * session closed", which reads to a model as the browser being broken rather
	 * than as something to retry.
	 */
	public get isClosed(): boolean {
		return this.client.isClosed;
	}

	/**
	 * The share marker for this tab, bound to this session.
	 *
	 * It hangs off the session rather than off the controller because a
	 * registered `addScriptToEvaluateOnNewDocument` identifier belongs to the
	 * session it was registered on. Held on the controller, it outlived a
	 * dropped session and "stop sharing" then removed a script id that no
	 * longer existed — so the marker reappeared on the next page load in a tab
	 * nobody was sharing.
	 */
	public get indicator(): ShareIndicator {
		return this._indicator ??= new ShareIndicator(this.client, this.sessionId);
	}

	public get consoleLines(): readonly ConsoleLine[] {
		return this._console;
	}

	public clearConsole(): void {
		this._console.length = 0;
	}

	public dispose(): void {
		for (const subscription of this._subscriptions) {
			subscription.dispose();
		}
		this.client.dispose();
	}
}

/** Result of a page-side evaluation, already unwrapped. */
async function evaluate(session: TabSession, expression: string): Promise<any> {
	const { result, exceptionDetails } = await session.client.send('Runtime.evaluate', {
		expression,
		returnByValue: true,
		awaitPromise: true,
	}, session.sessionId);

	if (exceptionDetails) {
		throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'Evaluation failed');
	}
	return result?.value;
}

/**
 * Waits for a navigation to finish, and gives up rather than blocking a tool.
 *
 * The listener has to be in place *before* `Page.navigate` is sent: a fast load
 * fires the event before anything is listening, and the wait then runs to its
 * timeout for a page that is already there. Timing out is not an error — the
 * page is still loading, and the next tool sees whatever is there by then.
 */
function waitForLoad(session: TabSession, timeoutMs: number): { settled: Promise<boolean>; cancel(): void } {
	const source = new vscode.CancellationTokenSource();
	const timer = setTimeout(() => source.cancel(), timeoutMs);
	const settled = session.client.once('Page.loadEventFired', source.token)
		.then(() => true, () => false)
		.finally(() => {
			clearTimeout(timer);
			source.dispose();
		});
	// Callable so a navigation that will never fire the event does not leave the
	// timer armed for the full timeout behind it.
	return { settled, cancel: () => source.cancel() };
}

/**
 * How long the marker work inside a share transition may take before it is
 * abandoned — **one budget for the whole of it**, not one per route.
 *
 * A budget per route added up: the cleanup tries the cached session and then a
 * private one, so an unresponsive page cost two of them, and the transition —
 * which the user is waiting on, and which every tool is queued behind — took
 * that long twice over. The fallback route exists for a session that was
 * *dropped*, not for a page that has stopped answering, and in the second case
 * it can only fail the same way.
 */
const indicatorTimeoutMs = 1500;

/**
 * Bounds a best-effort CDP round trip, and swallows its failure.
 *
 * `CDPClient.send` has no timeout of its own: it settles on a reply or on the
 * channel closing, and a page that has stopped servicing its main thread — an
 * infinite loop in a dev build, a paused renderer, a modal dialog handed to the
 * debugger client — answers neither. For one tool call that is survivable. For
 * the marker work inside a share transition it was not: `_transact` never
 * settled, and because every tool *and* every user command awaits `_settle()`,
 * the entire surface hung silently, `stopSharing` — the only documented escape
 * — included. Reproduced against a stubbed channel that drops
 * `Runtime.evaluate`.
 *
 * Returns `undefined` when the work times out or fails, which every caller here
 * already treats as "the marker did not happen", because none of them may turn
 * a tidy-up into an error the user has to read.
 */
function bounded<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
	// Attached first, so a rejection arriving after the race is already handled.
	const settled = work.then(value => value, () => undefined);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<undefined>(resolve => {
		timer = setTimeout(() => resolve(undefined), ms);
	});
	return Promise.race([settled, expiry]).finally(() => {
		if (timer) {
			clearTimeout(timer);
		}
	});
}

/**
 * Whether two targets are the same assignment.
 *
 * Deliberately structural and deliberately small: the registry owns key
 * identity (`keyOf`), and the one question this file has to ask — "is the
 * assignment a caller just resolved to the one being written?" — is answered
 * without a second key format to keep in step.
 */
function sameTarget(a: ShareTarget, b: ShareTarget): boolean {
	if (a.scope !== b.scope) {
		return false;
	}
	if (a.scope === 'kind' && b.scope === 'kind') {
		return a.kind === b.kind;
	}
	if (a.scope === 'session' && b.scope === 'session') {
		return a.session === b.session;
	}
	return true;
}

/** Embeds a value as a JS literal, so a selector cannot break out of the expression. */
function literal(value: unknown): string {
	return JSON.stringify(value ?? null);
}

export class BrowserController implements vscode.Disposable {

	/**
	 * One CDP session per tab, not one for the window.
	 *
	 * It was a single slot, and that was only tenable while the tools acted on
	 * one tab: now Claude can be on one page and Codex on another, and a single
	 * slot would be dropped and re-opened on every alternating call — which
	 * costs a handshake each time and, worse, loses the **console**. Capture
	 * only happens while something is attached, so a buffer that is thrown away
	 * every other call reports an empty log for everything that mattered. That
	 * is the whole reason a session is cached rather than opened per call.
	 *
	 * Bounded, because a session is a live channel into a page and an agent can
	 * open tabs all day. The least recently used one goes first, and a tab
	 * somebody is assigned to is passed over while any unassigned one remains —
	 * evicting the page an assistant is working on to make room for a page
	 * nobody asked about is the wrong trade every time.
	 */
	private readonly _sessions = new Map<vscode.BrowserTab, TabSession>();

	/** Least recently used first, so eviction has an order to follow. */
	private _sessionOrder: vscode.BrowserTab[] = [];

	private static readonly _sessionLimit = 4;

	/**
	 * Opens in flight, per tab.
	 *
	 * Opening is asynchronous, so without this two calls arriving together both
	 * find no session and both open one — the second overwrites the first,
	 * which is then never disposed while its console listeners stay attached
	 * for the life of the window. Reproduced once with two concurrent
	 * `browser_console` calls.
	 *
	 * Per tab rather than one slot, which also retires the whole "superseded
	 * while opening" apparatus: with a map, an open is only ever unwanted
	 * because the controller was disposed or the tab closed, never because
	 * somebody else asked for a different tab.
	 */
	private readonly _opening = new Map<vscode.BrowserTab, Promise<TabSession>>();

	/**
	 * The tab the tools last acted on.
	 *
	 * `vscode.window.activeBrowserTab` means "a browser editor is the active
	 * pane", nothing more — the extension host sets it from
	 * `activeEditorPane?.input instanceof BrowserEditorInput` — so it goes
	 * `undefined` the moment the user clicks into a file, which is the normal
	 * thing to do while an agent works. Without a memory of the tab, every tool
	 * refuses with "no browser tab is open" whenever a document has focus, and
	 * `browser_navigate` opens a second tab for the page already sitting there.
	 */
	private _lastTab: vscode.BrowserTab | undefined;
	//
	// **Written only where the user's own focus was seen.** It used to be
	// written by `selectTab`, by `shareTab` and by `navigate`'s new-tab
	// branch — one caller's choice, recorded in a field every caller reads —
	// so Codex selecting a tab still redirected Claude's next call one level
	// below the per-caller pin that was introduced to stop exactly that:
	// with no browser tab focused, which the docstring above calls the normal
	// thing to do while an agent works, an unassigned caller fell through to
	// `_lastTab` and got the page somebody else had chosen. Reproduced.

	/**
	 * The tab a caller selected for itself, **per caller**.
	 *
	 * It was one field for the window while everything around it became per
	 * caller, and that is a redirect: Codex calling `browser_select_tab tab-2`
	 * moved Claude's next tool call to tab-2, and `browser_state` then reported
	 * `selection: "selected"` to a caller that had selected nothing. Giving a
	 * tab to one assistant cleared it for everybody too, so an unrelated
	 * assistant silently changed page.
	 *
	 * Keyed by {@link callerKey} — the conversation when the client echoes its
	 * session id, the assistant otherwise — and it stays *below* an assignment:
	 * a selection is the model's own guess and the user's instruction outranks
	 * it.
	 */
	private readonly _pins = new Map<string, { readonly tab: vscode.BrowserTab; readonly caller: CallerIdentity }>();

	/**
	 * Who works on which tab — **assistant → tab**, and the direction is the
	 * design.
	 *
	 * A single `_sharedTab` could only say "the assistants work here", and the
	 * ask was the other thing: Claude on one page, Codex on another, and both
	 * on the same page when that is what is wanted. Several assistants pointing
	 * at one tab falls out for free this way round, while one assistant is
	 * never in two places at once — and "which tab does this call act on", the
	 * only question a tool ever asks, is a single lookup.
	 *
	 * The rules themselves — precedence between a conversation, an assistant
	 * and everybody, what a closed tab does to each of them, who has driven
	 * what — live in [src/shareRegistry.ts](src/shareRegistry.ts), which is a
	 * leaf with tests. This class only resolves sessions and drives CDP.
	 *
	 * The user's own commands still do not come through here — the toolbar's
	 * screenshot passes {@link focusedTab} — so a share never redirects a
	 * button the user pressed.
	 */
	private readonly _shares = new ShareRegistry<vscode.BrowserTab>();

	/**
	 * A share transition in progress, and the reason one is needed at all.
	 *
	 * Moving a share is several async steps over the fields the tools read: the
	 * marker comes off one page, the session moves, the marker goes on another.
	 * A tool call landing in the middle of that used to interfere with it in two
	 * ways at once, both reproduced — the call resolved the *new* tab, so
	 * `_sessionFor` dropped the session the cleanup was still using, leaving the
	 * marker on the old tab with nothing able to remove it afterwards
	 * (`stopSharing` only knows the current tab); and the call itself failed
	 * with `The browser session was replaced while it was opening`, an internal
	 * sentence handed to a model.
	 *
	 * So a transition is a gate. `_transact` runs the transitions in call order
	 * — two clicks on "Share this tab instead" cannot interleave either — and
	 * `_settle` is what every tool waits on. It is short by construction: two
	 * CDP round-trips.
	 *
	 * The gate orders calls that *arrive* during a transition. A call already
	 * past it can still be holding a session that the transition drops, which is
	 * why the cleanup has a second route to the page that nothing can take away
	 * (`_clearIndicator`) — the gate narrows the window, that makes the outcome
	 * correct regardless.
	 */
	private _transition: Promise<void> = Promise.resolve();

	private readonly _onDidChangeShare = new vscode.EventEmitter<void>();

	/** Fires when the share changes, so the status bar can follow it without polling. */
	public readonly onDidChangeShare = this._onDidChangeShare.event;

	private readonly _tabWatch: vscode.Disposable | undefined;

	/**
	 * Set by {@link dispose}, and checked by everything that could still be in
	 * flight at that moment.
	 *
	 * An open takes two CDP round-trips, so a window closing or the MCP setting
	 * being switched off lands in the middle of one routinely. Without this the
	 * session arriving afterwards was cached and left running — there was
	 * nothing left to dispose it.
	 */
	private _disposed = false;

	constructor() {
		// The share has to notice a closed tab even when no tool is running, or
		// the status bar keeps advertising a share with nothing behind it until
		// the next call comes in. Guarded like every other use of the proposal:
		// on a host without it, reading the event throws.
		try {
			if (isBrowserApiGranted()) {
				this._tabWatch = vscode.window.onDidCloseBrowserTab(tab => this._loseTab(tab));
			}
		} catch {
			// No browser API here; there is nothing to share in the first place.
		}
	}

	/**
	 * Ids handed out for `browser_tabs`, because the `browser` proposal exposes
	 * none: `BrowserTab` carries url, title, icon and two methods, and nothing
	 * that survives being written down. So identity is ours to mint, keyed on
	 * the tab object — which the extension host builds once per tab and only
	 * mutates in place, so it is stable for as long as the tab is open.
	 */
	private readonly _tabIds = new Map<vscode.BrowserTab, string>();
	private _nextTabId = 1;

	/**
	 * The element last picked, **per tab**.
	 *
	 * It was one field for the window, which crossed the boundary the whole
	 * feature exists to draw: with Claude on one page and Codex on another,
	 * `browser_selected_element` handed whichever of them asked the context
	 * picked on the *other* one — a page it was never given. Keyed by tab, the
	 * lookup goes through the caller's own assignment, so there is nothing to
	 * cross.
	 *
	 * It also removes an invalidation that had to be remembered: selecting or
	 * navigating away used to leave a stale element behind unless the code
	 * cleared it, and now a tab simply has its own or has none.
	 */
	private readonly _selectedElements = new Map<vscode.BrowserTab, string>();

	/**
	 * Which tab the tools act on: the one selected by id, else the active one,
	 * else the one last used, else the most recently opened.
	 *
	 * The last fallback is deliberate rather than a refusal — with a single tab
	 * open, which is the usual case, it is the only answer that can be right.
	 */
	private _resolveTab(caller?: CallerIdentity): vscode.BrowserTab | undefined {
		const open = vscode.window.browserTabs ?? [];

		const key = caller ? callerKey(caller) : undefined;
		const pinned = key ? this._pins.get(key)?.tab : undefined;
		if (pinned) {
			if (open.includes(pinned)) {
				return pinned;
			}
			// The tab was closed. Falling back beats refusing every call until
			// something selects again, and `selection` reports which happened.
			this._pins.delete(key!);
		}

		const active = vscode.window.activeBrowserTab;
		if (active) {
			this._lastTab = active;
			return active;
		}

		if (this._lastTab && open.includes(this._lastTab)) {
			return this._lastTab;
		}

		this._lastTab = open.length > 0 ? open[open.length - 1] : undefined;
		return this._lastTab;
	}

	/**
	 * The tab one caller acts on, or why it has none.
	 *
	 * An assignment answers first and **does not fall through**: the user chose
	 * that page for this assistant, so resuming it on another — the one
	 * everybody else follows, or whatever happens to be focused — is undoing
	 * the instruction rather than recovering from it. Only a caller with no
	 * assignment at all follows the user, which is the state everything starts
	 * in and the right default for "just look at what I am looking at".
	 *
	 * Nothing here has a `user` flag any more, and that is the point of moving
	 * the rules into the registry: a paused assignment belongs to one
	 * assistant, so it can no longer spill onto a button the person pressed —
	 * their commands simply never carry a caller.
	 */
	private _resolveForCaller(caller: CallerIdentity): {
		readonly tab?: vscode.BrowserTab;
		readonly paused?: ShareTarget;
		readonly target?: ShareTarget;
	} {
		const open = vscode.window.browserTabs ?? [];
		const resolution = this._shares.resolve(caller);

		if (resolution.kind === 'paused') {
			return { paused: resolution.target };
		}

		if (resolution.kind === 'shared') {
			if (open.includes(resolution.tab)) {
				return { tab: resolution.tab, target: resolution.target };
			}
			// The resolve that *discovers* the closure — normally
			// `onDidCloseBrowserTab` beats it to this, but on a host that does
			// not fire the event it is the only detector there is.
			this._loseTab(resolution.tab);
			return { paused: resolution.target };
		}

		return { tab: this._resolveTab(caller) };
	}

	/**
	 * The browser tab the user is looking at, if any.
	 *
	 * This is what a command the *user* pressed should act on, whatever an
	 * assistant has selected. `undefined` means no browser tab has focus, and
	 * the caller falls back to {@link _resolveTab}.
	 */
	public get focusedTab(): vscode.BrowserTab | undefined {
		return isBrowserApiGranted() ? vscode.window.activeBrowserTab : undefined;
	}

	/**
	 * Whether the window has any browser tab at all.
	 *
	 * Distinct from {@link focusedTab}, and the distinction is what the menu got
	 * wrong: "no tab is focused" is the normal state while somebody reads a
	 * file, and "no tab exists" is the state where every entry about giving a
	 * tab away is nonsense.
	 */
	public get hasOpenTabs(): boolean {
		return isBrowserApiGranted() && (vscode.window.browserTabs ?? []).length > 0;
	}

	/** Gives every open tab an id and forgets the ones that have closed. */
	private _identify(open: readonly vscode.BrowserTab[]): void {
		for (const tab of open) {
			if (!this._tabIds.has(tab)) {
				this._tabIds.set(tab, `tab-${this._nextTabId++}`);
			}
		}
		for (const known of [...this._tabIds.keys()]) {
			if (!open.includes(known)) {
				this._tabIds.delete(known);
			}
		}
	}

	/** The id of a tab, minting one if this is the first time it is named. */
	private _idOf(tab: vscode.BrowserTab): string {
		this._identify(vscode.window.browserTabs ?? []);
		return this._tabIds.get(tab) ?? 'tab-0';
	}

	/**
	 * How this caller's tab was chosen, which is what tells a model whether its
	 * own choice still holds.
	 *
	 * Per caller now, because the answer differs between them: the same window
	 * can have Claude on a page of its own, Codex following the user, and a
	 * third assistant paused because the page it was given was closed.
	 */
	private _selectionKind(caller: CallerIdentity): 'shared' | 'paused' | 'selected' | 'automatic' {
		const resolution = this._shares.resolve(caller);
		if (resolution.kind === 'shared') {
			return 'shared';
		}
		// Not `automatic`: nothing is being followed, and reporting the mode the
		// tools *would* be in reads as "carry on" next to a refusal.
		if (resolution.kind === 'paused') {
			return 'paused';
		}
		return this._pins.has(callerKey(caller)) ? 'selected' : 'automatic';
	}

	/**
	 * The tab to act on, or a refusal the model can act on.
	 *
	 * Every tool goes through here, which is why the wording matters: this is the
	 * text the assistant sees when there is nothing to drive.
	 */
	private _requireTab(caller?: CallerIdentity): vscode.BrowserTab {
		if (!isBrowserApiGranted()) {
			throw new Error(
				'The integrated browser is unavailable in this editor. It needs the `browser` API proposal; ' +
				'the user can enable it with the "AI Browser: Enable Integrated Browser API" command.');
		}

		// No caller means a command the user pressed. It never pauses: a lost
		// assignment is an assistant's problem, and blocking a button would be
		// answering a question nobody asked — they can see which tab they are
		// in.
		if (!caller) {
			const tab = this._resolveTab();
			if (!tab) {
				throw new Error('No browser tab is open.');
			}
			return tab;
		}

		const { tab, paused } = this._resolveForCaller(caller);
		if (paused) {
			throw new Error(shareLostMessage(paused));
		}
		if (!tab) {
			throw new Error(
				'No browser tab is open. Ask the user to open a page, or call `browser_navigate` with a URL first.');
		}
		this._noteTabUse(tab, caller);
		return tab;
	}

	/**
	 * Records that an assistant really did drive the shared tab.
	 *
	 * Deliberately not "an assistant made a call": `browser_tabs` and
	 * `browser_state` answer without touching a page, and a marker that lit up
	 * on those would say "in use" about a tab nothing had opened. So the note is
	 * taken where a tab is actually handed out for work.
	 */
	private _noteTabUse(tab: vscode.BrowserTab, caller: CallerIdentity): void {
		if (!this._shares.stateOf(tab) || !this._shares.noteUse(tab, caller.kind)) {
			return;
		}
		void this._armMarker(tab);
		this._onDidChangeShare.fire();
	}

	/**
	 * The session for the tab this caller acts on.
	 *
	 * Every tool goes through here, which is why it takes the caller: the tab
	 * is no longer a property of the window but of whoever is asking.
	 */
	private async _withSession(caller: CallerIdentity): Promise<TabSession> {
		await this._settle();
		return this._sessionFor(this._requireTab(caller));
	}

	/**
	 * The session for a tab, opening one if there is none to reuse.
	 *
	 * No "superseded while opening" case any more: a session belongs to its tab
	 * rather than to the window, so the only reasons an arriving one is unwanted
	 * are that the controller was disposed or the tab closed — both of which it
	 * checks for itself, and neither of which another caller can cause. The
	 * retry, the token and the `_stillWanted` predicate that guarded that shape
	 * are gone with it.
	 */
	private _sessionFor(tab: vscode.BrowserTab): Promise<TabSession> {
		if (this._disposed) {
			return Promise.reject(new Error('The integrated browser connection has been closed.'));
		}

		const cached = this._sessions.get(tab);
		if (cached && !cached.isClosed) {
			this._touch(tab);
			return Promise.resolve(cached);
		}
		if (cached) {
			this._dropSession(tab);
		}

		// An open already under way for this tab is shared, not raced.
		const pending = this._opening.get(tab);
		if (pending) {
			return pending;
		}

		const promise = TabSession.open(tab).then(session => {
			const open = vscode.window.browserTabs ?? [];
			if (this._disposed || !open.includes(tab)) {
				// Nobody will ever read this one, so it closes itself rather
				// than leaking: before the map, an open landing after `dispose`
				// was cached and left running with nothing to close it.
				session.dispose();
				throw new Error('The integrated browser connection has been closed.');
			}
			this._opening.delete(tab);
			this._sessions.set(tab, session);
			this._touch(tab);
			this._evict(tab);
			// A fresh session means a fresh page-side world: whatever marker was
			// installed by the previous one is gone with it, along with the
			// registration that would have survived a navigation.
			const state = this._shares.stateOf(tab);
			if (state) {
				void session.indicator.set(markerSuffix(state))
					.catch(() => { /* the marker is a hint, never a failure */ });
			}
			return session;
		});

		this._opening.set(tab, promise);
		// A rejection has to release the entry, or the failed attempt is cached:
		// the lookup above would hand the same rejected promise to every later
		// call, so one failed handshake — a page that crashed, a host hiccup —
		// made that tab permanently broken until something dropped it.
		promise.catch(() => {
			if (this._opening.get(tab) === promise) {
				this._opening.delete(tab);
			}
		});
		return promise;
	}

	/** Marks a tab as the most recently used, for eviction order. */
	private _touch(tab: vscode.BrowserTab): void {
		this._sessionOrder = this._sessionOrder.filter(known => known !== tab);
		this._sessionOrder.push(tab);
	}

	/**
	 * Keeps the number of live channels bounded.
	 *
	 * A tab somebody is assigned to is passed over while any unassigned one
	 * remains: evicting the page an assistant is working on — losing its
	 * console buffer and its marker registration — to make room for a page
	 * nobody asked about is the wrong trade every time. When every session
	 * belongs to an assignment, the least recently used goes anyway; the
	 * alternative is an unbounded number of open channels.
	 */
	private _evict(arriving?: vscode.BrowserTab): void {
		while (this._sessions.size > BrowserController._sessionLimit) {
			// The arrival is never the victim. It is the most recently used *and*
			// unassigned whenever the caller has no tab of its own, so the spare
			// search below picked it — the opener then got a session that had
			// already been disposed, and its first send failed with "CDP session
			// closed", the one error the docs single out as reading to a model
			// as a broken browser rather than as something to retry.
			const candidates = this._sessionOrder.filter(tab =>
				tab !== arriving && this._sessions.has(tab));
			// A tab that somebody is *using* is passed over the same way an
			// assigned one is. "Least recently used" is really "least recently
			// acquired" — `_touch` runs when a session is handed out, not while
			// it works — so the longest-running call sat at the front of the
			// queue: a `browser_wait_for` on a pinned tab was evicted by another
			// assistant opening tabs, and answered the model with the internal
			// `CDP client disposed`. Reproduced.
			const claimed = (tab: vscode.BrowserTab) =>
				this._shares.stateOf(tab) !== undefined
				|| [...this._pins.values()].some(pin => pin.tab === tab);
			const spare = candidates.find(tab => !claimed(tab));
			const victim = spare ?? candidates[0];
			if (!victim) {
				return;
			}
			this._dropSession(victim);
		}
	}

	/** Closes the session for one tab, or for all of them. */
	private _dropSession(tab?: vscode.BrowserTab): void {
		if (!tab) {
			for (const known of [...this._sessions.keys()]) {
				this._dropSession(known);
			}
			this._opening.clear();
			return;
		}
		this._sessions.get(tab)?.dispose();
		this._sessions.delete(tab);
		this._opening.delete(tab);
		this._sessionOrder = this._sessionOrder.filter(known => known !== tab);
	}

	/* ------------------------------------------------------------ sharing a tab */

	/**
	 * Runs a share transition, after any already queued.
	 *
	 * The chain kept in `_transition` is a swallowed copy, so a transition that
	 * fails cannot reject in the face of the next one — or of a tool waiting in
	 * {@link _settle}. The caller still gets the real error.
	 */
	private _transact<T>(work: () => Promise<T>): Promise<T> {
		const run = this._transition.then(work);
		this._transition = run.then(() => undefined, () => undefined);
		return run;
	}

	/**
	 * Waits for any share transition to finish.
	 *
	 * Loops, because a transition can begin while we are waiting for the one
	 * before it — the whole point is that no tool starts while the tab it would
	 * resolve is being changed underneath it.
	 */
	private async _settle(): Promise<void> {
		let awaited: Promise<void> | undefined;
		while (awaited !== this._transition) {
			awaited = this._transition;
			await awaited;
		}
	}

	/** Everything the UI needs to render the assignments and undo them. */
	public get shares(): ShareView {
		return {
			assignments: this._shares.assignments().map(assignment => ({
				target: assignment.target,
				label: targetName(assignment.target),
				tabId: this._idOf(assignment.tab),
				url: assignment.tab.url,
				title: stripMarker(assignment.tab.title),
				usedBy: assignment.usedBy,
			})),
			paused: this._shares.pausedTargets().map(target => ({ target, label: targetName(target) })),
		};
	}

	/** Whether this tab is assigned to anyone, for the menu that offers to move it. */
	public isShared(tab: vscode.BrowserTab): boolean {
		return this._shares.stateOf(tab) !== undefined;
	}

	/**
	 * Gives one tab to one target, on the user's instruction.
	 *
	 * Clearing the assistant's own pin is part of it: a pin under an assignment
	 * can never take effect, and leaving it in place would bring it back the
	 * moment the assignment was released — the agent would resume on a page
	 * chosen in a conversation that has since moved on.
	 */
	public shareTab(
		tab: vscode.BrowserTab,
		target: ShareTarget = everyone,
	): Promise<{ id: string; url: string; title: string | undefined; label: string }> {
		return this._transact(() => this._shareTab(tab, target));
	}

	private async _shareTab(
		tab: vscode.BrowserTab,
		target: ShareTarget,
	): Promise<{ id: string; url: string; title: string | undefined; label: string }> {
		// Checked here rather than at the caller, because `_transact` can defer
		// this body past several CDP round-trips: two clicks queue up, and the
		// second one's tab can be closed by the time its turn comes. Adopting it
		// left the UI advertising a share on a tab that no longer existed.
		if (!(vscode.window.browserTabs ?? []).includes(tab)) {
			throw new Error('That browser tab is no longer open.');
		}

		// Asked of the target itself: building a caller from it and resolving
		// that answered with a *different* assignment for `everyone` (it became
		// `{ kind: 'other' }`, which resolves `kind:other` first), so the tab
		// this target was moving off could keep its marker with nothing able to
		// clean it.
		const heldBefore = this._shares.tabOf(target);
		const alreadyThere = heldBefore === tab;

		// Re-giving the tab that this target already holds is a no-op, and has
		// to be: the entry sits in the shared tab's own menu, so it is one click
		// away, and re-running it took the marker from 🤖 back to 🔗 and the
		// tooltip back to "no assistant has used it yet" — advice for a broken
		// setup — while the assistants carried on working.
		if (alreadyThere) {
			return {
				id: this._idOf(tab), url: tab.url, title: stripMarker(tab.title), label: targetName(target),
			};
		}

		const releasedTab = heldBefore;

		this._shares.share(target, tab);
		// Deliberately *not* `_lastTab = tab`: that field is the tab the user
		// was last looking at, and an assignment made for one assistant is not
		// that. Writing it here handed the assigned page to every unassigned
		// caller as its fallback.
		// **Every caller this assignment now answers for** loses its own
		// selection, and nobody else does. An assignment outranks a selection,
		// so a shadowed pin would resurrect a stale choice the moment the
		// assignment was released — and deriving one key from the target was
		// not the same thing: a Codex *conversation* keeps its pin under
		// `session:<id>`, so giving Codex a tab deleted `kind:codex` and left
		// the conversation's own pin behind, which it then went back to as soon
		// as the assignment was released. Asking the registry who each pin
		// resolves to now covers a conversation, an assistant and everybody
		// with one rule.
		for (const [key, pin] of [...this._pins]) {
			const resolution = this._shares.resolve(pin.caller);
			if (resolution.kind === 'shared' && resolution.tab === tab
				&& this._shares.tabOf(resolution.target) === tab
				&& sameTarget(resolution.target, target)) {
				this._pins.delete(key);
			}
		}
		this._lastTab = tab;
		this._onDidChangeShare.fire();

		// The tab this target was moved *off* keeps its marker only if somebody
		// else still holds it. Before this, "give it to Codex instead" left both
		// tabs looking shared, permanently.
		if (releasedTab && releasedTab !== tab) {
			await this._refreshMarker(releasedTab);
		}
		await this._armMarker(tab);
		return {
			id: this._idOf(tab), url: tab.url, title: stripMarker(tab.title), label: targetName(target),
		};
	}

	/** Releases one assignment, or every one of them, and tidies the tabs. */
	public stopSharing(target?: ShareTarget): Promise<void> {
		return this._transact(() => this._stopSharing(target));
	}

	private async _stopSharing(target?: ShareTarget): Promise<void> {
		const tabs = target ? [this._shares.stop(target)] : this._shares.stopAll();
		this._onDidChangeShare.fire();
		for (const tab of tabs) {
			if (tab) {
				await this._refreshMarker(tab);
			}
		}
	}

	/**
	 * A tab has closed: every assignment on it pauses, and nobody else's moves.
	 *
	 * Paused rather than released, because "the page you were given is gone" and
	 * "you were never given one" are different answers — see the registry.
	 */
	private _loseTab(tab: vscode.BrowserTab): void {
		// The cleanup is unconditional, and used to sit behind the early return
		// below: closing an ordinary tab — the common case — left its
		// `TabSession` undisposed and still counting against the session limit,
		// and kept the element markdown picked on it for the life of the
		// window, keyed by a tab that no longer exists.
		this._selectedElements.delete(tab);
		this._dropSession(tab);
		for (const [key, pin] of [...this._pins]) {
			if (pin.tab === tab) {
				this._pins.delete(key);
			}
		}

		if (this._shares.forget(tab).length === 0) {
			return;
		}
		this._onDidChangeShare.fire();
	}

	/**
	 * Puts the right marker on a tab, or takes it off if nobody holds it now.
	 *
	 * Bounded, because this runs inside a transaction the user is waiting on and
	 * a page that has stopped answering must not hold it open — see `bounded`.
	 */
	private async _refreshMarker(tab: vscode.BrowserTab): Promise<void> {
		if (this._shares.stateOf(tab)) {
			await this._armMarker(tab);
			return;
		}
		await this._clearIndicator(tab);
	}

	private async _armMarker(tab: vscode.BrowserTab): Promise<void> {
		await bounded(this._armMarkerNow(tab), indicatorTimeoutMs);
	}

	private async _armMarkerNow(tab: vscode.BrowserTab): Promise<void> {
		const state = this._shares.stateOf(tab);
		if (!state) {
			return;
		}
		try {
			const session = await this._sessionFor(tab);
			const current = this._shares.stateOf(tab);
			if (!current) {
				return;
			}
			await session.indicator.set(markerSuffix(current));
		} catch {
			// Best effort: a session the host dropped, a tab mid-close, a page
			// that has not committed. None of them may turn sharing into an
			// error the user has to read.
		}
	}

	/**
	 * Takes the marker off one tab, and does not depend on the shared cache to
	 * do it.
	 *
	 * The cached session is tried first when there is one, because it holds the
	 * registration identifier and removing that is what stops the marker coming
	 * back on the tab's next navigation. If that fails, a session of our own
	 * finishes the job: a page can stop answering, and a tool call can drop the
	 * cached session mid-clear.
	 *
	 * Never for a tab that has closed — there is nothing left to mark, and
	 * `startCDPSession` on it would only throw.
	 */
	private async _clearIndicator(tab: vscode.BrowserTab): Promise<void> {
		if (!(vscode.window.browserTabs ?? []).includes(tab)) {
			return;
		}
		await bounded(this._clearMarker(tab), indicatorTimeoutMs);
	}

	private async _clearMarker(tab: vscode.BrowserTab): Promise<void> {
		const cached = this._sessions.get(tab);
		if (cached && !cached.isClosed && await cached.indicator.clear().catch(() => false)) {
			return;
		}
		await this._clearWithOwnSession(tab);
	}

	/**
	 * The second cleanup route: a session nobody else can drop.
	 *
	 * Split out so {@link bounded} can stop *waiting* for it without leaking it
	 * — the session still disposes itself whenever it finishes opening.
	 */
	private async _clearWithOwnSession(tab: vscode.BrowserTab): Promise<void> {
		let own: TabSession | undefined;
		try {
			own = await TabSession.open(tab);
			await own.indicator.clear();
		} catch {
			// The page cannot be reached at all, and the marker goes with it.
		} finally {
			own?.dispose();
		}
	}


	public async state(caller: CallerIdentity): Promise<unknown> {
		await this._settle();
		if (!isBrowserApiGranted()) {
			return {
				available: false,
				reason: 'The `browser` API proposal is not enabled. Ask the user to run '
					+ '"AI Browser: Enable Integrated Browser API".',
			};
		}

		const open = vscode.window.browserTabs ?? [];
		this._identify(open);
		// The tab *this caller* will act on, which is not the same thing as the
		// focused editor, and not the same thing as another assistant's tab.
		const { tab: target, paused, target: assignment } = this._resolveForCaller(caller);
		// `assignment !== undefined` is not the test — a *paused* caller has no
		// assignment in that sense, and answering it with the window's tab count
		// is the same mistake the sibling method was fixed for: the moment its
		// page is gone is not the moment to start describing the others.
		const bounded = assignment !== undefined || paused !== undefined;
		return {
			available: true,
			// Assigned callers are told how many other tabs exist, not what
			// they are: the page they were given is their scope, and every
			// other address in the window — one-time links, tokens in a query
			// string — is not theirs to read.
			openTabs: paused ? 0 : (bounded ? 1 : open.length),
			...(assignment && open.length > 1 ? { otherTabsInWindow: open.length - 1 } : {}),
			tab: target ? { id: this._tabIds.get(target), url: target.url, title: stripMarker(target.title) } : undefined,
			selection: this._selectionKind(caller),
			...(assignment ? { sharedByUser: true, sharedWith: targetName(assignment) } : {}),
			...(paused ? { sharedTabClosed: true, note: shareLostMessage(paused) } : {}),
			hasSelectedElement: target !== undefined && this._selectedElements.has(target),
		};
	}

	/**
	 * Every open tab with an id to address it by.
	 *
	 * The ids are ours, not the editor's — see {@link _tabIds} — so they are
	 * only good for as long as this window lives, and a model has to list before
	 * it selects rather than remembering an id from an earlier conversation.
	 */
	public async tabs(caller: CallerIdentity): Promise<unknown> {
		await this._settle();
		if (!isBrowserApiGranted()) {
			return {
				available: false,
				reason: 'The `browser` API proposal is not enabled. Ask the user to run '
					+ '"AI Browser: Enable Integrated Browser API".',
			};
		}

		const open = vscode.window.browserTabs ?? [];
		this._identify(open);
		const { tab: target, paused, target: assignment } = this._resolveForCaller(caller);
		const focused = vscode.window.activeBrowserTab;

		// **An assigned caller sees its own tab and nothing else.** The other
		// tabs used to be listed as context, on the reasoning that they are not
		// *selectable* anyway — but a user who gives one page to an assistant is
		// bounding what it can see, and a list of every other address in the
		// window (one-time links, tokens in a query string) is the one hole in
		// that. Unassigned callers still get the whole list: nothing has been
		// bounded, and they follow the user.
		// A paused caller gets **nothing**, not the full list: the page it was
		// given is gone, and answering with every other tab in the window —
		// their addresses, one-time links and query-string tokens included — is
		// the opposite of what the assignment was for. The note says what
		// happened; the count of others is withheld for the same reason.
		const visible = paused ? [] : (assignment && target ? [target] : open);

		return {
			selection: this._selectionKind(caller),
			...(paused ? { sharedTabClosed: true, note: shareLostMessage(paused) } : {}),
			...(assignment && open.length > visible.length
				? { otherTabsInWindow: open.length - visible.length }
				: {}),
			tabs: visible.map(tab => ({
				id: this._tabIds.get(tab),
				url: tab.url,
				title: stripMarker(tab.title),
				inUse: tab === target,
				sharedByUser: this._shares.stateOf(tab) !== undefined,
				focusedInEditor: tab === focused,
			})),
		};
	}

	/**
	 * Points every later tool at one tab, by an id from {@link tabs}.
	 *
	 * `auto` releases it, which is the state everything starts in: follow the
	 * focused tab, and fall back to the last one used. A selection also outlives
	 * the user clicking into a file or into another page — that is the point of
	 * it — but not the tab being closed, after which `selection` reads
	 * `automatic` again.
	 */
	public async selectTab(id: string, caller: CallerIdentity): Promise<unknown> {
		// Before the share checks below, or a selection arriving mid-transition
		// would be judged against a share that is halfway moved.
		await this._settle();
		if (!isBrowserApiGranted()) {
			throw new Error('The integrated browser is unavailable in this editor. Ask the user to run '
				+ '"AI Browser: Enable Integrated Browser API".');
		}

		const assignment = this._shares.resolve(caller);
		if (assignment.kind === 'paused') {
			throw new Error(shareLostMessage(assignment.target));
		}
		if (assignment.kind === 'shared') {
			throw new Error(
				`The user has given you one browser tab (${this._idOf(assignment.tab)}), and your tools act on that `
				+ 'tab only — a selection made here could never take effect. Ask the user to give you a different '
				+ 'tab, or to stop sharing, from the AI Browser status bar menu.');
		}

		const open = vscode.window.browserTabs ?? [];
		this._identify(open);

		if (id === 'auto') {
			this._pins.delete(callerKey(caller));
			const target = this._resolveTab();
			return {
				selection: this._selectionKind(caller),
				tab: target
					? { id: this._tabIds.get(target), url: target.url, title: stripMarker(target.title) }
					: undefined,
			};
		}

		const match = open.find(tab => this._tabIds.get(tab) === id);
		if (!match) {
			throw new Error(`No open browser tab has the id ${id}. `
				+ 'Call `browser_tabs` for the current list — ids change as tabs open and close.');
		}

		// The pin above is this caller's; `_lastTab` is the user's, and a
		// selection is not a user action.
		this._pins.set(callerKey(caller), { tab: match, caller });
		// The session in hand may belong to the tab we are leaving.
		// Nothing to invalidate: a picked element belongs to its tab now, so
		// selecting another cannot hand back the one picked on this.
		return {
			selection: this._selectionKind(caller),
			tab: { id, url: match.url, title: stripMarker(match.title) },
		};
	}

	/**
	 * Opens a URL, driving the tab the tools are already on unless a new one is
	 * asked for.
	 *
	 * Reuse is the default because the alternative piles up editor tabs. There is
	 * no "navigate" in the `browser` proposal, and `openBrowserTab` always mints
	 * a new editor — `$openBrowserTab` generates a fresh id per call, so VS Code
	 * cannot even collapse the tabs into one preview slot — which left an agent
	 * that navigated ten times with ten tabs behind it. `Page.navigate` over the
	 * session we already hold drives the existing tab instead, and stays attached
	 * across the load, so the console of the new page is captured from its first
	 * line rather than from whenever the next tool happens to attach.
	 *
	 * `file:` is refused. Otherwise an agent can point the browser at any file on
	 * disk and then read it back with `browser_text` — turning a browser tool
	 * into an unrestricted file reader.
	 */
	public async navigate(rawUrl: string, newTab: boolean, caller: CallerIdentity): Promise<unknown> {
		await this._settle();
		let parsed: URL;
		try {
			parsed = new URL(rawUrl);
		} catch {
			throw new Error(`Not a valid absolute URL: ${rawUrl}`);
		}

		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			throw new Error(
				`Refusing to open a ${parsed.protocol} URL. Only http and https are allowed, ` +
				'because other schemes would let this tool read local files.');
		}

		if (!isBrowserApiGranted()) {
			throw new Error('The integrated browser is unavailable in this editor. Ask the user to run '
				+ '"AI Browser: Enable Integrated Browser API".');
		}

		const assignment = this._shares.resolve(caller);
		if (assignment.kind === 'paused') {
			throw new Error(shareLostMessage(assignment.target));
		}
		// A new tab under an assignment would be opened and then never used — it
		// is not the tab this caller resolves to, so the next tool goes back to
		// the page it was given. That shape is already recorded as a bug worth
		// avoiding: a call that reports one tab while everything after it acts
		// on another.
		if (assignment.kind === 'shared' && newTab) {
			throw new Error(
				'The user has given you one browser tab, and your tools stay on it — a new tab would be opened and '
				+ 'then never used. Navigate in your own tab instead (drop `newTab`), or ask the user to give you '
				+ 'another tab.');
		}

		// Whatever was picked on the tab being navigated describes something
		// that is gone. Cleared for the *resolved* tab further down — keyed by
		// tab, this used to be conditional on the caller having an assignment,
		// which left an unassigned caller reading the previous document's
		// element after a same-tab navigation, with `hasSelectedElement` still
		// saying yes.

		const url = parsed.toString();
		// Resolved through the caller, and re-checked afterwards: resolution is
		// the lazy detector for an assigned tab that has gone — the only one on
		// a host that does not fire `onDidCloseBrowserTab` — so the gate above
		// is not the last word. Without the re-check the one tool that *acts*
		// instead of refusing went on to open a brand-new tab at a model-chosen
		// URL, in precisely the state the assignment exists to pause, and
		// reported `openedNewTab: true` while every later call refused.
		const resolved = newTab ? { tab: undefined, paused: undefined } : this._resolveForCaller(caller);
		if (resolved.paused) {
			throw new Error(shareLostMessage(resolved.paused));
		}
		const target = resolved.tab;

		if (target) {
			this._selectedElements.delete(target);
			this._noteTabUse(target, caller);
		}

		if (!target) {
			// Nothing to drive, and nothing of this caller's to drop: sessions
			// belong to tabs now, so the no-argument form would have closed
			// every one of them — another assistant's console buffer and its
			// marker registration with it.
			const tab = await vscode.window.openBrowserTab(url, { preserveFocus: true });
			// An explicit `newTab` selects the tab it just created, and it has
			// to: the tab is opened with `preserveFocus`, so the *old* tab
			// stays active and wins the focused-tab branch of `_resolveTab`,
			// which sits above `_lastTab`. This used to be guarded on a
			// selection already existing, which meant `navigate(newTab: true)`
			// reported the new tab and then every following tool acted on the
			// old one.
			//
			// The other way into this branch is "no tab was open at all", and
			// that one deliberately does not select: nothing was chosen, so
			// the user's focus should still lead. An existing selection is
			// carried over either way, or the next tool would go back to the
			// page the caller chose to leave.
			if (newTab || this._pins.has(callerKey(caller))) {
				this._pins.set(callerKey(caller), { tab, caller });
			}
			return { url: tab.url, title: stripMarker(tab.title), tabId: this._idOf(tab), openedNewTab: true };
		}

		try {
			return await this._navigateInTab(target, url);
		} catch (err) {
			// A session can be dropped by the host between two calls. One fresh
			// attempt, and only for that, so a real navigation failure still
			// reports itself instead of being retried twice.
			if (!String(err).includes('CDP session closed')) {
				throw err;
			}
			// This tab's session, not everyone's: the no-argument form closed
			// every session in the window to recover one of them.
			this._dropSession(target);
			return await this._navigateInTab(target, url);
		}
	}

	/** How long `navigate` waits for the load event before reporting what it has. */
	private static readonly _navigationTimeoutMs = 15_000;

	private async _navigateInTab(tab: vscode.BrowserTab, url: string): Promise<unknown> {
		const session = await this._sessionFor(tab);
		// The buffer describes the page being left.
		session.clearConsole();

		const load = waitForLoad(session, BrowserController._navigationTimeoutMs);
		try {
			const result = await session.client.send('Page.navigate', { url }, session.sessionId);
			if (result?.errorText) {
				throw new Error(`Could not open ${url}: ${result.errorText}`);
			}

			// A same-document navigation — `/docs` to `/docs#intro` — loads nothing
			// and fires no load event, and CDP says so by omitting `loaderId` from
			// the reply ("the previously committed loaderId would not change").
			// Waiting for an event that cannot come stalls every anchor change for
			// the full timeout.
			if (result?.loaderId) {
				await load.settled;
			}
		} finally {
			load.cancel();
		}

		// Read the page rather than the tab: `BrowserTab.url` catches up over an
		// event and can still hold the previous address here. Best effort — the
		// navigation happened either way, and reporting it as a failure because a
		// title could not be read would be a lie.
		let info: { url?: string; title?: string } | undefined;
		try {
			info = await evaluate(session, '({ url: location.href, title: document.title })');
		} catch {
			info = undefined;
		}
		return { url: info?.url ?? url, title: stripMarker(info?.title), tabId: this._idOf(tab), openedNewTab: false };
	}

	/**
	 * A compact list of things worth interacting with, for orientation.
	 *
	 * **Every selector it hands out is verified to resolve back to the element
	 * it describes**, and that is not a refinement — it is the difference
	 * between this tool being safe and being dangerous. `click` and `fill`
	 * resolve a selector with `document.querySelector`, which returns the
	 * *first* match. The old builder fell back to the bare tag name, so two
	 * buttons with no `id` and no `name` were both reported as `button`, and an
	 * agent told to press the second one pressed the first: asked for Delete,
	 * it clicked Save. Nothing anywhere reported a problem — the click
	 * succeeded, on the wrong element.
	 *
	 * So the builder tries a unique `id`, then `tag[name=…]`, then a positional
	 * `:nth-of-type` path, and **checks each candidate with the same call
	 * `click` will make** before accepting it. An element that cannot be
	 * addressed — inside a shadow root, say — is listed with no `selector` at
	 * all rather than with one that would act on something else.
	 *
	 * Classes are deliberately not used, for the reason given under the element
	 * commands: utility-class frameworks make them long and unstable.
	 */
	public async snapshot(caller: CallerIdentity): Promise<unknown> {
		const session = await this._withSession(caller);
		const value = await evaluate(session, `(() => {
			// The exact test the consumer performs, so a selector cannot pass
			// here and pick a different element there.
			const resolves = (sel, el) => {
				try { return !!sel && document.querySelector(sel) === el; } catch (e) { return false; }
			};
			const idFor = (el) => el.id ? '#' + CSS.escape(el.id) : undefined;
			const pathFor = (el) => {
				const parts = [];
				let node = el;
				while (node && node.nodeType === 1) {
					const byId = idFor(node);
					// A duplicate id resolves to somebody else, so it is only an
					// anchor when it actually points back at this node.
					if (byId && document.querySelector(byId) === node) { parts.unshift(byId); break; }
					const parent = node.parentElement;
					let part = node.tagName.toLowerCase();
					if (parent) {
						const twins = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
						if (twins.length > 1) { part += ':nth-of-type(' + (twins.indexOf(node) + 1) + ')'; }
					}
					parts.unshift(part);
					if (!parent) { break; }
					node = parent;
				}
				return parts.join(' > ');
			};
			const selectorFor = (el) => {
				const byId = idFor(el);
				if (resolves(byId, el)) { return byId; }
				const name = el.getAttribute('name');
				const byName = name ? el.tagName.toLowerCase() + '[name=' + JSON.stringify(name) + ']' : undefined;
				if (resolves(byName, el)) { return byName; }
				const path = pathFor(el);
				return resolves(path, el) ? path : undefined;
			};

			const out = [];
			const nodes = document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"], [contenteditable="true"]');
			for (const el of nodes) {
				const rect = el.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) { continue; }
				const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().slice(0, 80);
				const entry = { tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || undefined, label };
				const selector = selectorFor(el);
				if (selector) { entry.selector = selector; }
				out.push(entry);
				if (out.length >= 150) { break; }
			}
			return { url: location.href, title: document.title, elements: out };
		})()`);
		// The title is read from the page, and while this tab is shared the page
		// is carrying *our* suffix — so it needs the same strip as every other
		// title that leaves the extension.
		return value ? { ...value, title: stripMarker(value.title) } : value;
	}

	/**
	 * Asks the user to click an element and returns its full context.
	 *
	 * This one blocks on a human, so its description tells the model to only
	 * call it after asking. The result is remembered for
	 * {@link selectedElement}.
	 */
	public async inspectElement(timeoutMs: number, caller: CallerIdentity): Promise<unknown> {
		await this._settle();
		const tab = this._requireTab(caller);
		const client = new CDPClient(await tab.startCDPSession());
		let sessionId: string | undefined;

		try {
			sessionId = await client.attachToPage();
			await client.send('DOM.enable', {}, sessionId);
			await client.send('CSS.enable', {}, sessionId);
			await client.send('Overlay.enable', {}, sessionId);
			await client.send('Overlay.setInspectMode', {
				mode: 'searchForNode',
				highlightConfig: { showInfo: true, contentColor: { r: 111, g: 168, b: 220, a: 0.45 } },
			}, sessionId);

			const cts = new vscode.CancellationTokenSource();
			const timer = setTimeout(() => cts.cancel(), timeoutMs);
			try {
				const { backendNodeId } = await client.once('Overlay.inspectNodeRequested', cts.token);
				const data = await extractElementData(client, sessionId, backendNodeId);
				const rendered = renderElementMarkdown(data, tab.url);
				this._selectedElements.set(tab, rendered);
				return rendered;
			} catch (err) {
				if (err instanceof vscode.CancellationError) {
					throw new Error(
						'The user did not pick an element in time. Ask them to click one, then call this again.');
				}
				throw err;
			} finally {
				clearTimeout(timer);
				cts.dispose();
			}
		} finally {
			if (sessionId !== undefined) {
				await client.send('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} }, sessionId)
					.catch(() => { /* navigated away or detached */ });
			}
			client.dispose();
		}
	}

	public async selectedElement(caller: CallerIdentity): Promise<unknown> {
		// Resolved through the caller, so this can only ever return what was
		// picked on the tab that caller works on.
		const { tab, paused } = this._resolveForCaller(caller);
		if (paused) {
			throw new Error(shareLostMessage(paused));
		}
		const picked = tab ? this._selectedElements.get(tab) : undefined;
		if (!picked) {
			throw new Error(
				'No element has been picked on your tab yet. Call `browser_inspect_element` after asking the user to '
				+ 'click one.');
		}
		return picked;
	}

	public async html(selector: string | undefined, caller: CallerIdentity): Promise<unknown> {
		const session = await this._withSession(caller);
		const value = await evaluate(session, `(() => {
			const sel = ${literal(selector)};
			const el = sel ? document.querySelector(sel) : document.documentElement;
			if (!el) { throw new Error('No element matches ' + sel); }
			return el.outerHTML;
		})()`);
		// The `<title>` of a shared tab carries our marker, and this is the tool
		// a model uses to check the page against itself.
		return typeof value === 'string' ? stripMarkerFromHtml(value) : value;
	}

	public async text(selector: string | undefined, caller: CallerIdentity): Promise<unknown> {
		const session = await this._withSession(caller);
		return evaluate(session, `(() => {
			const sel = ${literal(selector)};
			const el = sel ? document.querySelector(sel) : document.body;
			if (!el) { throw new Error('No element matches ' + sel); }
			return (el.innerText || el.textContent || '').trim();
		})()`);
	}

	public async consoleOutput(clear: boolean, caller: CallerIdentity): Promise<unknown> {
		const session = await this._withSession(caller);
		const lines = session.consoleLines.map(line => `[${line.level}] ${line.text}`);
		if (clear) {
			session.clearConsole();
		}
		return lines.length
			? lines.join('\n')
			: 'The console is empty. Note that only messages logged since this tab was first inspected are captured.';
	}

	/**
	 * PNG of the page.
	 *
	 * `captureBeyondViewport` is stated rather than left to the default, which
	 * has moved between Chromium versions — `false` is the visible area, `true`
	 * goes past it.
	 *
	 * For a full page the size is taken from `Page.getLayoutMetrics` and passed
	 * as an explicit `clip`. Relying on `captureBeyondViewport` alone is what
	 * produces the familiar half-captured screenshot, because the capture is
	 * still bounded by the viewport unless the region is spelled out.
	 */
	public async capture(
		fullPage: boolean,
		preferred?: vscode.BrowserTab,
		caller?: CallerIdentity,
	): Promise<{ png: Buffer; clipped: boolean; url: string | undefined }> {
		await this._settle();

		if (!preferred) {
			// The tools' own subject, so its session is *cached* rather than
			// borrowed. Borrowing here quietly cost the console its priming:
			// before this, a screenshot left an attached session behind, so a
			// following `browser_console` had the page's log from the moment of
			// the capture. With a throwaway it answers "The console is empty"
			// for everything that happened before the next call — and console
			// capture is the whole reason the session is cached at all.
			const tab = this._requireTab(caller);
			return this._capture(tab, await this._sessionFor(tab), fullPage);
		}

		// A tab named by the caller may not be the subject — the toolbar passes
		// the one in front of the user — and moving the cache to it would take
		// the shared tab's marker registration and console buffer with it.
		return this._borrowSession(preferred, session => this._capture(preferred, session, fullPage));
	}

	/**
	 * A session for one read of a tab that is not the subject of the tools.
	 *
	 * The cached session is reused when it already belongs to this tab;
	 * otherwise a throwaway one is opened rather than the cache being *moved*.
	 * `_sessionFor` drops whatever it was holding, and for a screenshot that is
	 * destructive in a way it is not for the tools: the dropped session takes
	 * the shared tab's `addScriptToEvaluateOnNewDocument` registration with it,
	 * so a screenshot of another tab silently disarmed the marker on the shared
	 * one — with the symptom appearing on that tab's next reload, long after the
	 * screenshot that caused it. It also threw away the console buffer the
	 * assistant was collecting, for a picture of a different page.
	 *
	 * The throwaway session is the same shape as the picker's: opened, used,
	 * disposed, and never cached.
	 */
	private async _borrowSession<T>(
		tab: vscode.BrowserTab,
		run: (session: TabSession) => Promise<T>,
	): Promise<T> {
		const cached = this._sessions.get(tab);
		if (cached && !cached.isClosed) {
			return run(cached);
		}
		const session = await TabSession.open(tab);
		try {
			return await run(session);
		} finally {
			session.dispose();
		}
	}

	/** The capture itself. `Page` is already enabled by {@link TabSession}, so nothing does it here. */
	private async _capture(
		tab: vscode.BrowserTab,
		session: TabSession,
		fullPage: boolean,
	): Promise<{ png: Buffer; clipped: boolean; url: string | undefined }> {
		let clip: object | undefined;
		let clipped = false;

		if (fullPage) {
			const metrics = await session.client.send('Page.getLayoutMetrics', {}, session.sessionId);
			const size = metrics.cssContentSize ?? metrics.contentSize;
			const width = Math.ceil(size?.width ?? 0);
			const height = Math.ceil(size?.height ?? 0);

			if (width > 0 && height > 0) {
				// Chromium cannot allocate a texture beyond roughly this, and past
				// it the capture comes back blank rather than failing. Better a
				// truthfully clipped image than an empty one.
				const limit = 16384;
				clipped = height > limit;
				clip = { x: 0, y: 0, width, height: Math.min(height, limit), scale: 1 };
			}
		}

		const { data } = await session.client.send('Page.captureScreenshot', {
			format: 'png',
			captureBeyondViewport: fullPage,
			...(clip ? { clip } : {}),
		}, session.sessionId);

		if (typeof data !== 'string' || data.length === 0) {
			throw new Error(fullPage
				? 'The browser returned an empty screenshot. The page may be too large to capture in one image.'
				: 'The browser returned an empty screenshot');
		}
		return { png: Buffer.from(data, 'base64'), clipped, url: tab.url };
	}

	public async click(selector: string, caller: CallerIdentity): Promise<unknown> {
		const session = await this._withSession(caller);
		return evaluate(session, `(() => {
			const el = document.querySelector(${literal(selector)});
			if (!el) { throw new Error('No element matches ' + ${literal(selector)}); }
			el.scrollIntoView({ block: 'center' });
			el.click();
			return 'clicked ' + (el.tagName.toLowerCase());
		})()`);
	}

	public async fill(selector: string, value: string, caller: CallerIdentity): Promise<unknown> {
		const session = await this._withSession(caller);
		return evaluate(session, `(() => {
			const el = document.querySelector(${literal(selector)});
			if (!el) { throw new Error('No element matches ' + ${literal(selector)}); }
			el.focus();
			if (el.isContentEditable) {
				el.textContent = ${literal(value)};
			} else {
				el.value = ${literal(value)};
			}
			// Frameworks listen for these, not for the assignment.
			el.dispatchEvent(new Event('input', { bubbles: true }));
			el.dispatchEvent(new Event('change', { bubbles: true }));
			return 'filled ' + el.tagName.toLowerCase();
		})()`);
	}

	/** Polls in the page until a selector or a piece of text shows up. */
	public async waitFor(
		selector: string | undefined,
		text: string | undefined,
		timeoutMs: number,
		caller: CallerIdentity,
	): Promise<unknown> {
		if (!selector && !text) {
			throw new Error('Give either a selector or a text to wait for.');
		}

		const session = await this._withSession(caller);
		return evaluate(session, `(async () => {
			const sel = ${literal(selector)};
			const needle = ${literal(text)};
			const deadline = Date.now() + ${Math.max(0, timeoutMs)};
			const found = () => {
				if (sel && !document.querySelector(sel)) { return false; }
				if (needle && !(document.body.innerText || '').includes(needle)) { return false; }
				return true;
			};
			while (Date.now() < deadline) {
				if (found()) { return 'found'; }
				await new Promise(r => setTimeout(r, 100));
			}
			throw new Error('Timed out waiting for ' + (sel || '') + (sel && needle ? ' and ' : '') + (needle ? JSON.stringify(needle) : ''));
		})()`);
	}

	/**
	 * One last attempt to take every marker off, on a path that cannot await.
	 *
	 * Sent **directly**, not through `indicator.clear()`: that goes onto the
	 * indicator's serialising queue, whose first `await` defers the work past
	 * the `_dropSession()` below — the channel was already torn down by the
	 * time anything was written, so nothing reached the page.
	 * `CDPClient.send` hands the message to the host inside its own
	 * constructor, synchronously, which is what makes this worth attempting at
	 * all here. The browser editor belongs to the workbench, so a disable or a
	 * reload of this extension leaves those pages alive.
	 */
	private _unmarkAllOnDispose(): void {
		for (const tab of this._shares.tabs()) {
			const session = this._sessions.get(tab);
			if (!session || session.isClosed) {
				continue;
			}
			void session.client.send('Runtime.evaluate', {
				expression: 'window.__aiBrowserShareMarker && window.__aiBrowserShareMarker.remove()',
			}, session.sessionId).catch(() => { /* the window is closing anyway */ });
		}
	}

	public dispose(): void {
		// First, so an open still in flight sees it when it lands.
		this._disposed = true;

		// The extension is going; the *page* is not. The browser editor belongs
		// to the workbench, so a disable or a reload of this extension left the
		// title suffix and the observer that re-applies it in a live document
		// with nothing able to call `remove()` — clearing only on the next
		// navigation. `send` hands the message to the host synchronously, which
		// is why this can still be worth doing on a synchronous teardown path;
		// it is best effort and nothing waits for it.
		this._unmarkAllOnDispose();
		this._tabWatch?.dispose();
		this._onDidChangeShare.dispose();
		this._dropSession();
	}
}
