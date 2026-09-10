/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CDPClient } from './cdp';

/*
 * Marking the shared tab *on the tab itself*.
 *
 * The editor tab of a browser view is labelled with the page title, and nothing
 * in the `browser` proposal lets an extension decorate it — there is no badge,
 * no description, no colour. What an extension *can* reach is the page, over
 * CDP, and `document.title` is what the label is built from. So the marker is a
 * suffix on the title: one emoji, which shows up on the editor tab, in the tab
 * hover, and in the editor's own tab list, without any UI of our own.
 *
 * Two states, because "shared" and "an assistant has actually looked at it" are
 * different facts and only the second one means work is happening:
 *
 *   🔗  shared with assistants, not touched yet
 *   🤖  an assistant has driven this tab at least once
 *
 * The alternative was a floating badge injected into the page. It was rejected:
 * it lands in every screenshot the agent takes, and it shows up in
 * `browser_html` and `browser_text` as page content that is not the page's.
 * A title suffix is visible in exactly one place — the tab — and is stripped
 * from every title this extension reports back (see {@link stripMarker}).
 */

/** Shared, but no assistant has driven it yet. */
export const sharedMarker = '🔗';

/** An assistant has acted on this tab at least once. */
export const inUseMarker = '🤖';

const markers = [sharedMarker, inUseMarker];

/**
 * The page title without our marker.
 *
 * Every title that leaves the extension goes through here — tool results, the
 * status bar tooltip, screenshot file names — or the marker leaks into the
 * things it is supposed to annotate: an agent would read the page title as
 * "Dashboard 🤖" and a screenshot would be filed under it.
 */
export function stripMarker(title: string | undefined): string | undefined {
	if (!title) {
		return title;
	}
	let out = title;
	let stripped = false;
	for (const marker of markers) {
		if (out.endsWith(` ${marker}`)) {
			out = out.slice(0, -(marker.length + 1));
			stripped = true;
		}
	}
	// Only a title we actually cut is trimmed. Trimming unconditionally edits
	// somebody else's page title — a trailing space in it is theirs, not ours.
	return stripped ? out.trimEnd() : out;
}

/**
 * The page-side installer, as source to evaluate.
 *
 * It is idempotent on purpose — the same source is both evaluated in the live
 * page and registered to run on every new document, so it has to be safe to run
 * twice — and it re-applies the suffix rather than setting it once, because a
 * page routinely rewrites its own title: an SPA on every route change, a chat on
 * every unread count. Setting it once meant the marker survived until the first
 * such write and then vanished, which is the worst version of an indicator.
 *
 * It is a string rather than a real function put through `toString`, because
 * `src/` compiles with `lib: ES2022` and no `DOM` — `document`, `window` and
 * `MutationObserver` are not types here, which is why every other page-side
 * snippet in this extension is a string too.
 *
 * Loop safety: `apply` writes only when the suffix is missing, so our own write
 * wakes the observer, finds the suffix already there and stops. The observer
 * watches `document.head` rather than the whole document — it catches both the
 * title text changing and the `<title>` element being replaced wholesale, at a
 * fraction of the cost of a subtree observer on `document`.
 *
 * **`remove` has to disarm the deferred start, not just the observer.** The
 * script runs at document start on a navigation, so on a page that is still
 * loading the real work is queued on `DOMContentLoaded`. Removing the marker
 * before that fires used to leave the listener armed: `start` then ran off its
 * closure, re-applied the suffix and built a *second* observer — and since
 * `window[key]` was already deleted, no later `clear()` could reach it, so the
 * tab stayed marked with a live observer keeping it that way. Hence
 * `state.removed`, checked by both `start` and `apply`, plus the explicit
 * `removeEventListener`.
 */
function installerSource(marker: string): string {
	return `(function (marker, all) {
	var key = '__aiBrowserShareMarker';
	var existing = window[key];
	if (existing) { existing.set(marker); return; }

	var state = {
		marker: marker,
		observer: undefined,
		removed: false,
		strip: function (title) {
			var out = title;
			for (var i = 0; i < all.length; i++) {
				var suffix = ' ' + all[i];
				if (out.endsWith(suffix)) { out = out.slice(0, -suffix.length); }
			}
			return out;
		},
		apply: function () {
			// No <title> yet — this runs at document start on a fresh
			// navigation — and assigning one before <head> exists is a no-op,
			// so wait for the document rather than fighting it.
			if (state.removed || !document.head) { return; }
			var suffix = ' ' + state.marker;
			var title = document.title || '';
			if (!title.endsWith(suffix)) { document.title = state.strip(title) + suffix; }
		},
		set: function (next) {
			if (state.removed) { return; }
			state.marker = next;
			state.apply();
		},
		remove: function () {
			// Order matters, and every step of it.
			//
			// The flag first, so a callback that is already queued — the
			// observer's, or the deferred start below — finds the marker gone
			// rather than putting it back. It is also what makes the two
			// disarms below best effort rather than load-bearing: nothing
			// re-applies once it is set.
			//
			// Then the title, because it is the visible half and this is a page
			// we do not control: a page that has replaced \`removeEventListener\`
			// or \`disconnect\` — or simply broken them — must not be able to
			// keep our suffix on its tab. Same for deleting the global before
			// them: left behind, it would make every later \`set\` find a
			// \`removed\` state and refuse, so the marker could never come back
			// on that page.
			state.removed = true;
			try { document.title = state.strip(document.title || ''); } catch (e) { }
			delete window[key];
			try {
				if (state.observer) { state.observer.disconnect(); state.observer = undefined; }
			} catch (e) { }
			try { document.removeEventListener('DOMContentLoaded', start); } catch (e) { }
		}
	};

	// Hoisted, so \`remove\` above can name it: the listener has to be taken off
	// again, or removing the marker mid-load is undone the moment the document
	// finishes loading.
	var start = function () {
		if (state.removed) { return; }
		state.apply();
		if (document.head && !state.observer) {
			state.observer = new MutationObserver(function () { state.apply(); });
			state.observer.observe(document.head, { childList: true, subtree: true, characterData: true });
		}
	};

	window[key] = state;

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', start, { once: true });
	} else {
		start();
	}
})(${JSON.stringify(marker)}, ${JSON.stringify(markers)})`;
}

/**
 * A marker installed in one tab's page, and the handle to take it away again.
 *
 * The registered `addScriptToEvaluateOnNewDocument` identifier is what makes the
 * marker survive navigation — `Page.navigate`, a link the agent clicks, a
 * redirect — and it is also what has to be removed when sharing stops, or the
 * marker comes back on the next page load in a tab nobody is sharing any more.
 */
export class ShareIndicator {

	/**
	 * The marker that is actually on the page, as far as we know.
	 *
	 * Recorded **after** a successful install, never before it. Setting it up
	 * front recorded the *request* instead: one rejected install then left the
	 * indicator believing the marker was there, and because the same session
	 * keeps the same indicator, the `_marker === marker` short-circuit below
	 * suppressed every retry — a shared tab with no marker for the rest of the
	 * session.
	 */
	private _marker: string | undefined;
	private _scriptId: string | undefined;

	/**
	 * Every operation on this indicator, in call order.
	 *
	 * `set` and `clear` are **serialised**, not merely deduplicated, and that is
	 * load-bearing rather than tidy. They race by construction: the marker is
	 * armed from two places (a session opening, and the share being set) while
	 * `clear` comes from a button the user can press at any moment. Overlapped,
	 * a `clear` arriving mid-install found `_scriptId` not yet assigned and
	 * `window.__aiBrowserShareMarker` not yet defined, so both halves of it were
	 * no-ops — and the install then completed *after* it, putting the marker
	 * back on a tab nobody was sharing and re-registering the script that
	 * returns it on every later navigation, with the identifier no longer held
	 * by anyone who could remove it.
	 *
	 * The chain itself never rejects — a rejected link would be inherited by
	 * every operation queued behind it — while the caller of `set` still gets
	 * the real error.
	 */
	private _queue: Promise<void> = Promise.resolve();

	constructor(
		private readonly _client: CDPClient,
		private readonly _sessionId: string,
	) { }

	/** Puts the marker on the page, replacing whichever one was there. */
	public set(marker: string): Promise<void> {
		return this._enqueue(async () => {
			if (this._marker === marker) {
				return;
			}
			await this._install(marker);
			this._marker = marker;
		});
	}

	/**
	 * Runs `work` after everything already queued, whatever became of it.
	 *
	 * The returned promise is the caller's own: it carries `work`'s rejection.
	 * The promise kept as the chain is a swallowed copy, so a failed install
	 * cannot turn the next `clear` into an unhandled rejection.
	 */
	private _enqueue<T>(work: () => Promise<T>): Promise<T> {
		const run = this._queue.then(work);
		this._queue = run.then(() => undefined, () => undefined);
		return run;
	}

	private async _install(marker: string): Promise<void> {
		const source = installerSource(marker);
		// The identifier bakes the marker in, so switching from 🔗 to 🤖 means
		// replacing the registration rather than adding a second one.
		await this._removeScript();
		const registered = await this._client.send(
			'Page.addScriptToEvaluateOnNewDocument', { source }, this._sessionId);
		this._scriptId = registered?.identifier;

		// The script above only runs on the *next* document; the page in front
		// of the user is marked by evaluating the same source now.
		await this._client.send('Runtime.evaluate', { expression: source }, this._sessionId);
	}

	/**
	 * Takes the marker off. Never throws; answers whether it reached the page.
	 *
	 * Best effort because every reason for calling it — sharing stopped, the tab
	 * closed, the session dropped — includes reasons the page cannot be reached
	 * any more, and a failure to tidy up a title must not become an error the
	 * user has to read.
	 *
	 * It never short-circuits on `_marker` being unset. A fresh indicator on a
	 * newly opened session has no marker recorded and the page may still carry
	 * one installed by the session before it — which is exactly the case
	 * `stopSharing` and a re-share have to clean up.
	 */
	public clear(): Promise<boolean> {
		return this._enqueue(async () => {
			this._marker = undefined;
			try {
				await this._removeScript();
				await this._client.send('Runtime.evaluate', {
					expression: `window.__aiBrowserShareMarker?.remove()`,
				}, this._sessionId);
				return true;
			} catch {
				// The session is gone. Reported rather than swallowed, because
				// the caller has a second way to reach the page — see
				// `_clearIndicator` — and "the marker is off" and "the channel
				// died before it could be taken off" must not look the same.
				return false;
			}
		});
	}

	private async _removeScript(): Promise<void> {
		if (!this._scriptId) {
			return;
		}
		const identifier = this._scriptId;
		this._scriptId = undefined;
		try {
			await this._client.send(
				'Page.removeScriptToEvaluateOnNewDocument', { identifier }, this._sessionId);
		} catch {
			// Session already closed; nothing will run the script again anyway.
		}
	}
}
