/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ClientKind } from './mcpProtocol';

/*
 * What is left of marking a shared tab *on the tab itself*: the reader.
 *
 * The extension used to append a suffix to `document.title` over CDP — 🔗 for
 * "given out, nobody has driven it yet", 🤖 for "an assistant has" — because
 * the editor tab of a browser view is labelled from the page title and nothing
 * in the `browser` proposal lets an extension decorate that tab.
 *
 * **Writing into the page is gone, on request, and must not come back.** It was
 * an edit to somebody else's live document to say something about *our* state,
 * and it leaked wherever a title travelled: `stripMarker` had to be threaded
 * through every tool result, `stripMarkerFromHtml` through `browser_html`, and
 * each new call site was a fresh chance to miss one (breaks-silently #30, twice).
 * The failure that ended it is the one no amount of stripping could reach:
 * `BrowserTab.title` is not `document.title`. VS Code composes it as
 * `<title> (<url>)`, so our suffix landed in the *middle* of the string —
 * `'Picto ERP\u2009🔗🟦 (http://localhost:3000/en/auth/login)'`, measured — and
 * `stripMarker`, which takes a suffix off the end, could not see it. The marker
 * then reached the connect prompt, the tool results and the status bar tooltip
 * with nothing able to remove it.
 *
 * The same two facts now live entirely in the workbench, where they cost the
 * page nothing: the glyphs below go on the `$(globe) AI Browser` status bar
 * item, and the menu under it names each assignment, the page it holds and
 * whether it has been picked up. See `statusBar.ts`.
 *
 * What stays here is the *reading* half, and it stays for two different reasons:
 * the status bar still needs the two glyphs, and a page marked by an earlier
 * build can still be open — its `MutationObserver` re-applying the suffix on
 * every title change — so titles are still stripped on the way out and
 * {@link legacyMarkerRemoval} takes the old installer off whenever a session
 * reaches such a page.
 */


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
 * The expression that takes an *older build's* marker off a page.
 *
 * Nothing installs a marker any more, so this is a migration and nothing else:
 * a page that a previous version reached still holds
 * `window.__aiBrowserShareMarker`, whose `remove()` restores the title and
 * disconnects the `MutationObserver` that would otherwise keep re-applying the
 * suffix for the life of that tab. Without it the last marker this extension
 * ever wrote would be permanent, because the code that could reach it is the
 * code being deleted.
 *
 * It is sent on every session open (`TabSession.open`), which is cheap: on a
 * page that never had one it is a property read that answers `undefined`. Note
 * that this only disarms the *live* installer — the registration made with
 * `Page.addScriptToEvaluateOnNewDocument` belonged to a CDP session that has
 * since closed, and such a registration dies with its session, so there is
 * nothing left to unregister.
 *
 * A string rather than a function put through `toString`, like every other
 * page-side snippet here: `src/` compiles with `lib: ES2022` and no `DOM`.
 */
export const legacyMarkerRemoval =
	'window.__aiBrowserShareMarker && window.__aiBrowserShareMarker.remove()';
