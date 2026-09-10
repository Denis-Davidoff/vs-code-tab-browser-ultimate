/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ClientKind } from './mcpProtocol';
import type { TabShareState } from './shareRegistry';

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


/**
 * The slice of `CDPClient` this module uses.
 *
 * Structural rather than an `import type`, so this file imports **nothing** and
 * `npm test` can load it directly — the same reason `elementMarkdown.ts` was
 * split out of `elementContext.ts`. A type-only import is erased at runtime but
 * not at *typecheck* time: it pulled `cdp.ts`, and with it the `browser`
 * proposal's typings, into the test project, which by design compiles the test
 * files alone. `CDPClient` satisfies this as it stands.
 */
export interface PageChannel {
	send(method: string, params?: object, sessionId?: string): Promise<any>;
}

/** Shared, but no assistant has driven it yet. */
export const sharedMarker = '🔗';

/** An assistant has acted on this tab at least once. */
export const inUseMarker = '🤖';

/**
 * What separates a page's title from our marker: a thin space, U+2009.
 *
 * Not a plain space, and that is the whole point. An emoji is not ours to own —
 * a CI dashboard called `Deploy Bot 🤖` and a link tool called `Docs 🔗` are
 * ordinary titles — and with a plain space the page-side strip could not tell
 * the page's own trailing emoji from the suffix we appended. It ate it: the
 * page's title was rewritten to `Deploy Bot` in its own live document, and
 * `clear()` left it that way for good, while every title we reported lost the
 * emoji too. A thin space in front of a trailing emoji is not something a title
 * has by accident, so `separator + marker` identifies the suffix as ours, and
 * it renders on the tab the same as before.
 */
const separator = '\u2009';

/**
 * One glyph per assistant, so a tab says *whose* it is.
 *
 * The colours are the ones the per-assistant dots on the toolbar icons used
 * before they were removed, which is the only prior art this project has for
 * "which assistant" at a glance. `other` covers VS Code chat and anything that
 * did not name itself.
 */
const assistantGlyphs: Record<ClientKind, string> = {
	claude: '🟠',
	codex: '🟦',
	other: '🟣',
};

/** Every glyph the suffix can be made of — the contract `stripMarker` reverses. */
const glyphs = [sharedMarker, inUseMarker, ...Object.values(assistantGlyphs)];

/**
 * What to append for one tab, given who holds it.
 *
 * Two facts, two positions. The leading glyph keeps the distinction that made
 * the marker worth having — 🔗 nobody has picked this up, 🤖 somebody has
 * driven it — and the trailing ones name the assistants the tab was given to
 * *specifically*. A tab shared with everyone carries no trailing glyph, so the
 * common case reads exactly as it did before.
 */
export function markerSuffix(state: TabShareState): string {
	const lead = state.used ? inUseMarker : sharedMarker;
	return lead + state.kinds.map(kind => assistantGlyphs[kind]).join('');
}

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
	// The tail after the **last** separator has to be made of our glyphs and
	// nothing else. A fixed list of suffixes cannot do this any more — the
	// suffix is composed now, `🤖🟠🟦` and so on — and matching loosely would
	// take a page's own trailing emoji, which is the failure this separator was
	// introduced to end.
	const at = title.lastIndexOf(separator);
	if (at === -1) {
		return title;
	}
	if (!isGlyphRun(title.slice(at + separator.length))) {
		return title;
	}
	return title.slice(0, at).trimEnd();
}

/** Whether `tail` is a non-empty run of our own glyphs, and nothing else. */
function isGlyphRun(tail: string): boolean {
	if (tail.length === 0) {
		return false;
	}
	let index = 0;
	while (index < tail.length) {
		const glyph = glyphs.find(candidate => tail.startsWith(candidate, index));
		if (!glyph) {
			return false;
		}
		index += glyph.length;
	}
	return true;
}

/**
 * Takes the marker out of serialized page HTML.
 *
 * `browser_html` returns `document.documentElement.outerHTML`, so a shared
 * tab's `<title>` carried our suffix straight into it — into the one tool a
 * model reaches for to *verify* a page, diff it, or generate an assertion from
 * it, which is the worst possible place for content that is not the page's. It
 * also contradicted the reason a floating badge was rejected in the first
 * place.
 *
 * Doing this by text is safe only because of {@link separator}: the pair
 * `U+2009` + marker is not something a document contains of its own. The first
 * occurrence is enough — there is exactly one, in the title.
 */
export function stripMarkerFromHtml(html: string): string {
	// **Inside `<title>` and nowhere else.** Scanning the whole document for a
	// separator followed by our glyphs found *decoys*: a `<meta>` description
	// or an inline legend (`🟠 degraded`) preceded by a thin space matched
	// first, so the page's own content was edited and the real marker was left
	// in the title. The suffix only ever exists in one element, so that is the
	// only place to look.
	const open = /<title\b[^>]*>/i.exec(html);
	if (!open) {
		return html;
	}
	const from = open.index + open[0].length;
	const to = html.toLowerCase().indexOf('</title>', from);
	if (to === -1) {
		return html;
	}

	const title = html.slice(from, to);
	const stripped = stripMarker(title);
	return stripped === title ? html : html.slice(0, from) + stripped + html.slice(to);
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
	return `(function (suffix, sep, all) {
	var key = '__aiBrowserShareMarker';
	var existing = window[key];
	if (existing) { existing.set(suffix); return; }

	var state = {
		suffix: suffix,
		observer: undefined,
		removed: false,
		// Only what is ours: the separator, followed by a run made entirely of
		// our glyphs. The page's own trailing emoji is not preceded by the
		// separator, so it is left alone — taking it was a silent, irreversible
		// edit of someone else's document.
		strip: function (title) {
			var at = title.lastIndexOf(sep);
			if (at === -1) { return title; }
			var tail = title.slice(at + sep.length);
			if (tail.length === 0) { return title; }
			var index = 0;
			while (index < tail.length) {
				var glyph = null;
				for (var i = 0; i < all.length; i++) {
					if (tail.startsWith(all[i], index)) { glyph = all[i]; break; }
				}
				if (!glyph) { return title; }
				index += glyph.length;
			}
			return title.slice(0, at);
		},
		apply: function () {
			// No <title> yet — this runs at document start on a fresh
			// navigation — and assigning one before <head> exists is a no-op,
			// so wait for the document rather than fighting it.
			if (state.removed || !document.head) { return; }
			var title = document.title || '';
			if (!title.endsWith(state.suffix)) { document.title = state.strip(title) + state.suffix; }
		},
		set: function (next) {
			if (state.removed) { return; }
			state.suffix = next;
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
})(${JSON.stringify(separator + marker)}, ${JSON.stringify(separator)}, ${JSON.stringify(glyphs)})`;
}

/**
 * Evaluates in the page and treats a page-side throw as a failure.
 *
 * CDP reports a thrown expression as a **successful reply** carrying
 * `exceptionDetails`, so ignoring that field made both callers lie: `_install`
 * recorded a marker it had not applied — and the `_marker === marker`
 * short-circuit then suppressed every retry for the life of the session — while
 * `clear()` reported it had reached the page, so `_clearIndicator` skipped the
 * private-session route that exists for exactly this case. A page can cause it:
 * freeze the object we look for, replace `endsWith`, break `MutationObserver`.
 */
async function evaluateInPage(client: PageChannel, sessionId: string, expression: string): Promise<void> {
	const reply = await client.send('Runtime.evaluate', { expression }, sessionId);
	if (reply?.exceptionDetails) {
		const details = reply.exceptionDetails;
		throw new Error(details.exception?.description ?? details.text ?? 'The page rejected the marker script');
	}
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
	 * No field remembers what is on the page, and that is deliberate.
	 *
	 * There was one, and it was a belief rather than a fact: the handle lives
	 * on `window`, so the page can take the marker off, and a page can define
	 * `window.__aiBrowserShareMarker` before we arrive and make our installer
	 * do nothing. Both left the extension convinced the marker was applied,
	 * after which every later arm sent nothing at all. An install is cheap
	 * enough to repeat; a marker that cannot come back is not.
	 */
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

	private readonly _client: PageChannel;
	private readonly _sessionId: string;

	// Plain fields rather than parameter properties: this module is loaded
	// directly by `npm test`, and Node *strips* types rather than compiling
	// them, so `constructor(private readonly x)` fails at load with
	// ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. The same rule that keeps `enum` out of
	// anything a test can reach.
	constructor(client: PageChannel, sessionId: string) {
		this._client = client;
		this._sessionId = sessionId;
	}

	/** Puts the marker on the page, replacing whichever one was there. */
	public set(marker: string): Promise<void> {
		return this._enqueue(async () => {
			// **Installed every time, with no "already there" short-circuit.**
			// The handle lives on `window`, so the page can call `remove()` on
			// it — and a page can also define `window.__aiBrowserShareMarker`
			// itself before we arrive, in which case our installer takes its
			// `existing.set` branch and does whatever that page wants. Either
			// way the extension had recorded the marker as applied, and every
			// later arm then sent *nothing at all*, so a page could keep itself
			// unmarked for the rest of the session while an assistant drove it.
			// `clear()` already declines to trust this state for the same
			// reason; the round trip it saved was not worth a marker that
			// cannot come back.
			await this._install(marker);
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
		await evaluateInPage(this._client, this._sessionId, source);
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
			try {
				await this._removeScript();
				await evaluateInPage(this._client, this._sessionId,
					'window.__aiBrowserShareMarker && window.__aiBrowserShareMarker.remove()');
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
