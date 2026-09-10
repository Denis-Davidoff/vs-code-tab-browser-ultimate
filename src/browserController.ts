/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CDPClient } from './cdp';
import { extractElementData, renderElementMarkdown } from './elementContext';
import { isBrowserApiGranted } from './proposedApi';
import { inUseMarker, ShareIndicator, sharedMarker, stripMarker } from './shareIndicator';
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

/**
 * The share, as the UI needs to see it.
 *
 * `lost` is a state of its own rather than a flag on `none`, because the two
 * mean opposite things to the user: nothing is shared, versus something was and
 * the assistants are waiting.
 */
export interface ShareState {
	readonly state: 'none' | 'shared' | 'lost';
	readonly usedBy: readonly ClientKind[];
	readonly id?: string;
	readonly url?: string;
	readonly title?: string;
}

/**
 * What every tool answers once the tab the user shared has been closed.
 *
 * Falling back to whichever page is focused is what the share exists to
 * prevent, so the tools stay paused instead — a share is a decision by the
 * user, and only the user can move it. The message therefore has to name the
 * fix, because the model cannot apply it.
 */
const shareLostMessage =
	'The browser tab the user shared with you has been closed, so the browser tools are paused. They will not fall '
	+ 'back to whichever page the user happens to be looking at. Ask the user to open the page you should work with '
	+ 'and share it — "AI Browser: Share Tab with Assistants", from the status bar menu or the toolbar menu on the '
	+ 'browser tab.';

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

/** Embeds a value as a JS literal, so a selector cannot break out of the expression. */
function literal(value: unknown): string {
	return JSON.stringify(value ?? null);
}

export class BrowserController implements vscode.Disposable {

	private _session: TabSession | undefined;
	private _sessionTab: vscode.BrowserTab | undefined;

	/**
	 * An open that has been started but has not finished yet.
	 *
	 * Opening a session is asynchronous, so without this two calls arriving
	 * together both find no cached session and both open one — the second
	 * overwrites the field holding the first, which is then never disposed.
	 * The CDP session stays live with its console listeners attached, for the
	 * life of the window. Reproduced with two concurrent `browser_console`
	 * calls: two sessions opened, one closed.
	 */
	private _opening: { tab: vscode.BrowserTab; token: object; promise: Promise<TabSession> } | undefined;

	/**
	 * Identity of the open currently wanted.
	 *
	 * Cleared by {@link _dropSession}, so a session that arrives after the
	 * controller has moved on can see that nobody wants it and close itself
	 * rather than leaking.
	 */
	private _openToken: object | undefined;

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

	/**
	 * The tab an assistant asked for by id, and the reason {@link _resolveTab}
	 * has a first branch at all.
	 *
	 * It outranks the focused editor on purpose: an assistant that was told
	 * "work on this one" must keep working on it while the user reads a
	 * different page. The user's own commands do not go through here — the
	 * toolbar's screenshot passes {@link focusedTab} — so a pin set by an agent
	 * can never redirect a button the user pressed.
	 */
	private _pinnedTab: vscode.BrowserTab | undefined;

	/**
	 * The tab the **user** shared with the assistants — the strongest of the
	 * three levels of intent, and the only one an assistant cannot move.
	 *
	 * `_pinnedTab` was never enough for "work on this page and no other": it is
	 * set by the model, so the user had no way to state the same thing, and
	 * without it every call followed `activeBrowserTab` — click into another
	 * page and the agent went with you. A share sits above both: above the
	 * focused editor, so reading a second page does not redirect the agent, and
	 * above the model's own selection, so it cannot be released by
	 * `browser_select_tab` either.
	 *
	 * The user's own commands still do not come through here — the toolbar's
	 * screenshot passes {@link focusedTab} — so a share never redirects a button
	 * the user pressed.
	 */
	private _sharedTab: vscode.BrowserTab | undefined;

	/**
	 * Set when the shared tab has gone, and the reason the tools then refuse.
	 *
	 * A pin falls back to automatic when its tab closes, which is right for a
	 * choice the model made and wrong for one the user made: silently resuming
	 * on whatever is focused undoes exactly the instruction that was given. So
	 * the share is not replaced by a guess — every tool answers
	 * {@link shareLostMessage} until the user shares something again.
	 */
	private _shareLost = false;

	/**
	 * Which assistants have actually driven the shared tab.
	 *
	 * "Shared" and "an assistant has looked at it" are different facts, and only
	 * the second means work is happening — which is what the marker on the tab
	 * distinguishes, and what makes a share that nobody picked up visible as
	 * such (an assistant that was never restarted, so it never loaded the
	 * server, is the common case).
	 */
	private readonly _shareUsedBy = new Set<ClientKind>();

	/**
	 * The assistant whose `tools/call` is being handled, if any.
	 *
	 * Set by the transport around dispatch ({@link beginCall}), so the tab-use
	 * note can say *who* touched the tab without every tool having to carry a
	 * caller argument. With two assistants calling at once the label can name
	 * the wrong one of the two; the fact it is guarding — that the tab was used
	 * at all — is unaffected, and a cosmetic label is not worth threading a
	 * parameter through the whole tool table for.
	 */
	private _caller: ClientKind | undefined;

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
				this._tabWatch = vscode.window.onDidCloseBrowserTab(tab => {
					if (tab === this._sharedTab) {
						this._loseShare();
					}
				});
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

	/** Last element the user picked, so a follow-up question does not re-prompt. */
	private _selectedElement: string | undefined;

	/**
	 * Which tab the tools act on: the one selected by id, else the active one,
	 * else the one last used, else the most recently opened.
	 *
	 * The last fallback is deliberate rather than a refusal — with a single tab
	 * open, which is the usual case, it is the only answer that can be right.
	 */
	private _resolveTab(user = false): vscode.BrowserTab | undefined {
		const open = vscode.window.browserTabs ?? [];

		// The user's share comes first, and does not fall back: see
		// `_shareLost`. Everything below it is a guess about intent, and a
		// guess must not override a statement of it.
		//
		// `user` is what keeps that from spilling onto the person: a lost share
		// pauses the assistants, and a toolbar command has nothing to do with
		// them. Without this the fall-through reached "No browser tab is open"
		// for a screenshot pressed with another tab open in plain sight.
		if (this._shareLost && !user) {
			return undefined;
		}
		if (this._sharedTab) {
			if (open.includes(this._sharedTab)) {
				return this._sharedTab;
			}
			this._loseShare();
			return undefined;
		}

		if (this._pinnedTab) {
			if (open.includes(this._pinnedTab)) {
				return this._pinnedTab;
			}
			// The tab was closed. Falling back beats refusing every call until
			// something selects again, and `selection` reports which happened.
			this._pinnedTab = undefined;
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
	 * The browser tab the user is looking at, if any.
	 *
	 * This is what a command the *user* pressed should act on, whatever an
	 * assistant has selected. `undefined` means no browser tab has focus, and
	 * the caller falls back to {@link _resolveTab}.
	 */
	public get focusedTab(): vscode.BrowserTab | undefined {
		return isBrowserApiGranted() ? vscode.window.activeBrowserTab : undefined;
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

	/** How the tab in use was chosen, which is what tells a model whether its choice still holds. */
	private get _selectionKind(): 'shared' | 'paused' | 'selected' | 'automatic' {
		if (this._sharedTab) {
			return 'shared';
		}
		// Not `automatic`: nothing is being followed, and reporting the mode the
		// tools *would* be in reads as "carry on" next to a refusal.
		if (this._shareLost) {
			return 'paused';
		}
		return this._pinnedTab ? 'selected' : 'automatic';
	}

	/**
	 * The tab to act on, or a refusal the model can act on.
	 *
	 * Every tool goes through here, which is why the wording matters: this is the
	 * text the assistant sees when there is nothing to drive.
	 */
	private _requireTab(user = false): vscode.BrowserTab {
		if (!isBrowserApiGranted()) {
			throw new Error(
				'The integrated browser is unavailable in this editor. It needs the `browser` API proposal; ' +
				'the user can enable it with the "AI Browser: Enable Integrated Browser API" command.');
		}

		// A lost share pauses the *assistants*. A command the user pressed is
		// not one of them, and blocking it would be answering a question nobody
		// asked: they can see which tab they are in.
		if (this._shareLost && !user) {
			throw new Error(shareLostMessage);
		}

		const tab = this._resolveTab(user);
		if (!tab) {
			throw new Error(
				'No browser tab is open. Ask the user to open a page, or call `browser_navigate` with a URL first.');
		}
		if (!user) {
			this._noteTabUse(tab);
		}
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
	private _noteTabUse(tab: vscode.BrowserTab): void {
		const caller = this._caller;
		if (!caller || tab !== this._sharedTab || this._shareUsedBy.has(caller)) {
			return;
		}
		this._shareUsedBy.add(caller);
		void this._armIndicator();
		this._onDidChangeShare.fire();
	}

	/**
	 * Which assistant's call is in flight, set by the transport around dispatch.
	 *
	 * Kept as a pair rather than a wrapper because the transport has to clear it
	 * even when dispatch throws.
	 */
	public beginCall(caller: ClientKind): void {
		this._caller = caller;
	}

	public endCall(): void {
		this._caller = undefined;
	}

	private async _withSession(): Promise<TabSession> {
		await this._settle();
		return this._sessionFor(this._requireTab());
	}

	/**
	 * Whether an open that has just been superseded is still worth finishing.
	 *
	 * Deliberately side-effect free — `_resolveTab` moves `_lastTab` and can end
	 * a share, neither of which a stale request may do — and deliberately
	 * conservative: every branch here answers "no" to something that has *taken
	 * over*, and a request that lost its subject is a request whose caller
	 * should be told to ask again rather than one to serve from under the new
	 * owner.
	 */
	private _stillWanted(tab: vscode.BrowserTab): boolean {
		if (this._disposed) {
			return false;
		}
		if (!(vscode.window.browserTabs ?? []).includes(tab)) {
			return false;
		}
		// A share decides for itself, and a paused one decides that nothing is
		// the subject.
		if (this._shareLost) {
			return false;
		}
		if (this._sharedTab) {
			return tab === this._sharedTab;
		}
		// Somebody is already opening a different tab: that request is newer
		// than ours, and two opens pulling against each other is worse than one
		// of them failing.
		if (this._opening && this._opening.tab !== tab) {
			return false;
		}
		if (this._pinnedTab) {
			return tab === this._pinnedTab;
		}
		return true;
	}

	/**
	 * The cached session for a tab, opening a fresh one when there is none to
	 * reuse.
	 *
	 * `retries` exists for the one interleaving that is nobody's mistake: a
	 * share transition drops the cache while this open is in flight, so the
	 * session that arrives is unwanted. Opening again is right — the caller
	 * still wants this tab — and it is bounded at one attempt so two callers
	 * pulling in different directions cannot ping-pong. Only a request that is
	 * superseded twice gives up, and it gives up with something the model can
	 * act on rather than with a description of our internals.
	 */
	private _sessionFor(tab: vscode.BrowserTab, retries = 1): Promise<TabSession> {
		if (this._disposed) {
			return Promise.reject(new Error('The integrated browser connection has been closed.'));
		}

		if (this._session && this._sessionTab === tab && !this._session.isClosed) {
			return Promise.resolve(this._session);
		}

		// An open already under way for this tab is shared, not raced.
		if (this._opening?.tab === tab) {
			return this._opening.promise;
		}

		// A different tab: the old session's console belongs to a page that is
		// no longer the subject.
		this._dropSession();

		const token = {};
		this._openToken = token;
		const promise = TabSession.open(tab).then(session => {
			if (this._openToken !== token) {
				// Superseded while we were opening — by another tab, by a share
				// moving, or by the controller being disposed. Nobody will ever
				// read this one, so it closes itself instead of leaking.
				session.dispose();
				// Retried **only while this tab is still the one to act on**.
				// Retrying regardless was worse than the error it was avoiding:
				// an open superseded *because the share moved* came back for the
				// old tab and dropped the newly shared tab's session — sharing
				// still in force, its marker registration gone with the session
				// — and after `dispose` it opened a session with nothing left to
				// close it.
				if (retries > 0 && this._stillWanted(tab)) {
					// Our own `_opening` entry has to go first, or the retry
					// finds it, matches on the tab and awaits the very promise
					// it is running inside.
					if (this._opening?.token === token) {
						this._opening = undefined;
					}
					return this._sessionFor(tab, retries - 1);
				}
				throw new Error(
					'The browser session was replaced while it was opening, which happens when the tab the tools '
					+ 'act on changes. Call the tool again.');
			}
			this._openToken = undefined;
			this._opening = undefined;
			this._session = session;
			this._sessionTab = tab;
			// A fresh session means a fresh page-side world: whatever marker was
			// installed by the previous one is gone with it, along with the
			// registration that would have survived a navigation.
			if (tab === this._sharedTab) {
				void session.indicator.set(this._shareUsedBy.size > 0 ? inUseMarker : sharedMarker)
					.catch(() => { /* the marker is a hint, never a failure */ });
			}
			return session;
		});
		this._opening = { tab, token, promise };
		return promise;
	}

	private _dropSession(): void {
		this._session?.dispose();
		this._session = undefined;
		this._sessionTab = undefined;
		// An open still in flight is no longer wanted. Clearing the token is
		// what tells it to close itself when it arrives; there is nothing to
		// dispose here yet.
		this._openToken = undefined;
		this._opening = undefined;
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

	/** The shared tab itself, for the one question the UI asks that {@link share} cannot answer: is this it? */
	public get sharedTab(): vscode.BrowserTab | undefined {
		return this._sharedTab;
	}

	/** What the status bar and the menu need to render the share. */
	public get share(): ShareState {
		if (this._shareLost) {
			return { state: 'lost', usedBy: [] };
		}
		const tab = this._sharedTab;
		if (!tab) {
			return { state: 'none', usedBy: [] };
		}
		return {
			state: 'shared',
			usedBy: [...this._shareUsedBy],
			id: this._idOf(tab),
			url: tab.url,
			title: stripMarker(tab.title),
		};
	}

	/**
	 * Fixes the tools on one tab, on the user's instruction.
	 *
	 * Clearing the assistant's own selection is part of it: a pin under a share
	 * can never take effect, and leaving it in place would bring it back the
	 * moment sharing stopped — the agent would resume on a page chosen in a
	 * conversation that has since moved on.
	 *
	 * **Moving a share has to un-mark the tab it is moving off.** Dropping the
	 * old session takes the *registration* with it, so the marker does not come
	 * back on that tab's next navigation — but it does nothing to the document
	 * in front of the user: the title suffix stays, and the observer that keeps
	 * re-applying it stays with it. So "Share this tab instead" left both tabs
	 * looking shared, with no way ever to clean the old one up, since
	 * `stopSharing` only knows about the current `_sharedTab`.
	 */
	public shareTab(tab: vscode.BrowserTab): Promise<{ id: string; url: string; title: string | undefined }> {
		return this._transact(() => this._shareTab(tab));
	}

	private async _shareTab(tab: vscode.BrowserTab): Promise<{ id: string; url: string; title: string | undefined }> {
		const previous = this._sharedTab;
		this._sharedTab = tab;
		this._shareLost = false;
		this._shareUsedBy.clear();
		this._pinnedTab = undefined;
		this._lastTab = tab;
		this._onDidChangeShare.fire();

		// Before `_dropSession` below, so the live session — the one that holds
		// the script identifier — is the one used to tidy up where possible.
		// After `_sharedTab` has moved, or `_sessionFor` would re-arm the marker
		// on the very tab being cleaned.
		if (previous && previous !== tab) {
			await this._clearIndicator(previous);
		}

		if (this._sessionTab !== tab) {
			this._dropSession();
			this._selectedElement = undefined;
		}
		await this._armIndicator();
		return { id: this._idOf(tab), url: tab.url, title: stripMarker(tab.title) };
	}

	/** Releases the share, and takes the marker off the page it was on. */
	public stopSharing(): Promise<void> {
		return this._transact(() => this._stopSharing());
	}

	private async _stopSharing(): Promise<void> {
		const tab = this._sharedTab;
		this._sharedTab = undefined;
		this._shareLost = false;
		this._shareUsedBy.clear();
		this._onDidChangeShare.fire();

		if (tab) {
			await this._clearIndicator(tab);
		}
	}

	/**
	 * Takes the marker off one tab, and does not depend on the shared cache to
	 * do it.
	 *
	 * The cached session is tried first when it belongs to this tab, because it
	 * is the one holding the registration identifier and removing that is what
	 * stops the marker coming back on the tab's next navigation.
	 *
	 * **If that fails, a session of our own finishes the job.** It is not a
	 * belt-and-braces flourish: a tool call resolving the *new* shared tab
	 * drops the cached session, and it can do so while this clear is mid-flight
	 * — reproduced, with the marker left on a tab nobody was sharing and no
	 * later `stopSharing` able to reach it, since that only knows the current
	 * tab. A private session cannot be dropped by anyone else. It cannot remove
	 * a registration it never made, but a session that has been dropped took
	 * its registrations with it, so what is left to clean is the live document:
	 * the title, and the observer that re-applies it.
	 *
	 * Never for a tab that has closed — there is nothing left to mark, and
	 * `startCDPSession` on it would only throw.
	 */
	private async _clearIndicator(tab: vscode.BrowserTab): Promise<void> {
		if (!(vscode.window.browserTabs ?? []).includes(tab)) {
			return;
		}

		const cached = this._sessionTab === tab && this._session && !this._session.isClosed
			? this._session
			: undefined;
		if (cached && await cached.indicator.clear().catch(() => false)) {
			return;
		}

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

	/** The shared tab has closed: pause the tools rather than pick a replacement. */
	private _loseShare(): void {
		if (!this._sharedTab) {
			return;
		}
		this._sharedTab = undefined;
		this._shareLost = true;
		this._shareUsedBy.clear();
		this._selectedElement = undefined;
		// The session belonged to a page that no longer exists, and its console
		// buffer describes it.
		this._dropSession();
		this._onDidChangeShare.fire();
	}

	/**
	 * Puts the right marker on the shared tab, best effort.
	 *
	 * Best effort on purpose: every reason this can fail — a session the host
	 * dropped, a tab mid-close, a page that has not committed yet — is a reason
	 * the marker does not matter, and none of them should turn sharing into an
	 * error the user has to read.
	 */
	private async _armIndicator(): Promise<void> {
		const tab = this._sharedTab;
		if (!tab) {
			return;
		}
		try {
			const session = await this._sessionFor(tab);
			if (this._sharedTab !== tab) {
				return;
			}
			await session.indicator.set(this._shareUsedBy.size > 0 ? inUseMarker : sharedMarker);
		} catch {
			// See above.
		}
	}

	public async state(): Promise<unknown> {
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
		// The tab the tools will act on, which is not the same thing as the
		// focused editor: see `_resolveTab`.
		const target = this._resolveTab();
		return {
			available: true,
			openTabs: open.length,
			tab: target ? { id: this._tabIds.get(target), url: target.url, title: stripMarker(target.title) } : undefined,
			selection: this._selectionKind,
			...(this._sharedTab ? { sharedByUser: true } : {}),
			...(this._shareLost ? { sharedTabClosed: true, note: shareLostMessage } : {}),
			hasSelectedElement: this._selectedElement !== undefined,
		};
	}

	/**
	 * Every open tab with an id to address it by.
	 *
	 * The ids are ours, not the editor's — see {@link _tabIds} — so they are
	 * only good for as long as this window lives, and a model has to list before
	 * it selects rather than remembering an id from an earlier conversation.
	 */
	public async tabs(): Promise<unknown> {
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
		const target = this._resolveTab();
		const focused = vscode.window.activeBrowserTab;

		return {
			selection: this._selectionKind,
			...(this._shareLost ? { sharedTabClosed: true, note: shareLostMessage } : {}),
			// Other tabs are still listed while one is shared: they are context,
			// and hiding them would only make the ids in this list confusing.
			// What they are not is selectable — `browser_select_tab` refuses
			// while a share is in force, and says why.
			tabs: open.map(tab => ({
				id: this._tabIds.get(tab),
				url: tab.url,
				title: stripMarker(tab.title),
				inUse: tab === target,
				sharedByUser: tab === this._sharedTab,
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
	public async selectTab(id: string): Promise<unknown> {
		// Before the share checks below, or a selection arriving mid-transition
		// would be judged against a share that is halfway moved.
		await this._settle();
		if (!isBrowserApiGranted()) {
			throw new Error('The integrated browser is unavailable in this editor. Ask the user to run '
				+ '"AI Browser: Enable Integrated Browser API".');
		}

		if (this._shareLost) {
			throw new Error(shareLostMessage);
		}
		if (this._sharedTab) {
			throw new Error(
				`The user has shared one browser tab with you (${this._idOf(this._sharedTab)}), and the tools act on `
				+ 'that tab only — a selection made here could never take effect. Ask the user to share a different '
				+ 'tab, or to stop sharing, from the AI Browser status bar menu.');
		}

		const open = vscode.window.browserTabs ?? [];
		this._identify(open);

		if (id === 'auto') {
			this._pinnedTab = undefined;
			const target = this._resolveTab();
			return {
				selection: this._selectionKind,
				tab: target ? { id: this._tabIds.get(target), url: target.url, title: target.title } : undefined,
			};
		}

		const match = open.find(tab => this._tabIds.get(tab) === id);
		if (!match) {
			throw new Error(`No open browser tab has the id ${id}. `
				+ 'Call `browser_tabs` for the current list — ids change as tabs open and close.');
		}

		this._pinnedTab = match;
		this._lastTab = match;
		// The session in hand may belong to the tab we are leaving.
		if (this._sessionTab !== match) {
			this._dropSession();
			this._selectedElement = undefined;
		}
		return {
			selection: this._selectionKind,
			tab: { id, url: match.url, title: match.title },
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
	public async navigate(rawUrl: string, newTab = false): Promise<unknown> {
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

		if (this._shareLost) {
			throw new Error(shareLostMessage);
		}
		// A new tab under a share would be opened and then never used — it lands
		// below the share in `_resolveTab`, so the next tool goes back to the
		// shared page. That shape is already recorded as a bug worth avoiding:
		// a call that reports one tab while everything after it acts on another.
		if (this._sharedTab && newTab) {
			throw new Error(
				'The user has shared one browser tab with you, and the tools stay on it — a new tab would be opened '
				+ 'and then never used. Navigate in the shared tab instead (drop `newTab`), or ask the user to share '
				+ 'another tab.');
		}

		// Either way this is a new page, so the element the user picked describes
		// something that is gone.
		this._selectedElement = undefined;

		const url = parsed.toString();
		const target = newTab ? undefined : this._resolveTab();
		if (target) {
			this._noteTabUse(target);
		}

		if (!target) {
			// Nothing to drive: the cached session belongs to a page we are leaving.
			this._dropSession();
			const tab = await vscode.window.openBrowserTab(url, { preserveFocus: true });
			this._lastTab = tab;
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
			if (newTab || this._pinnedTab) {
				this._pinnedTab = tab;
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
			this._dropSession();
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
	public async snapshot(): Promise<unknown> {
		const session = await this._withSession();
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
	public async inspectElement(timeoutMs: number): Promise<unknown> {
		await this._settle();
		const tab = this._requireTab();
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
				this._selectedElement = renderElementMarkdown(data, tab.url);
				return this._selectedElement;
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

	public async selectedElement(): Promise<unknown> {
		if (!this._selectedElement) {
			throw new Error(
				'No element has been picked yet. Call `browser_inspect_element` after asking the user to click one.');
		}
		return this._selectedElement;
	}

	public async html(selector: string | undefined): Promise<unknown> {
		const session = await this._withSession();
		return evaluate(session, `(() => {
			const sel = ${literal(selector)};
			const el = sel ? document.querySelector(sel) : document.documentElement;
			if (!el) { throw new Error('No element matches ' + sel); }
			return el.outerHTML;
		})()`);
	}

	public async text(selector: string | undefined): Promise<unknown> {
		const session = await this._withSession();
		return evaluate(session, `(() => {
			const sel = ${literal(selector)};
			const el = sel ? document.querySelector(sel) : document.body;
			if (!el) { throw new Error('No element matches ' + sel); }
			return (el.innerText || el.textContent || '').trim();
		})()`);
	}

	public async consoleOutput(clear: boolean): Promise<unknown> {
		const session = await this._withSession();
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
		user = false,
	): Promise<{ png: Buffer; clipped: boolean; url: string | undefined }> {
		await this._settle();
		const tab = preferred ?? this._requireTab(user);
		return this._borrowSession(tab, session => this._capture(tab, session, fullPage));
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
		if (this._session && this._sessionTab === tab && !this._session.isClosed) {
			return run(this._session);
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

	public async click(selector: string): Promise<unknown> {
		const session = await this._withSession();
		return evaluate(session, `(() => {
			const el = document.querySelector(${literal(selector)});
			if (!el) { throw new Error('No element matches ' + ${literal(selector)}); }
			el.scrollIntoView({ block: 'center' });
			el.click();
			return 'clicked ' + (el.tagName.toLowerCase());
		})()`);
	}

	public async fill(selector: string, value: string): Promise<unknown> {
		const session = await this._withSession();
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
	): Promise<unknown> {
		if (!selector && !text) {
			throw new Error('Give either a selector or a text to wait for.');
		}

		const session = await this._withSession();
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

	public dispose(): void {
		// First, so an open still in flight sees it when it lands.
		this._disposed = true;
		this._tabWatch?.dispose();
		this._onDidChangeShare.dispose();
		this._dropSession();
	}
}
