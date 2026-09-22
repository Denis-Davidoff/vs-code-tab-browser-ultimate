/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CDPClient } from './cdp';
import { confirm, refuse } from './notify';
import { extractElementData, formatAncestor, renderElementMarkdown } from './elementContext';
import { assistantName, handOver, type AssistantId } from './assistants';
import { isBrowserApiGranted } from './proposedApi';
import {
	formatElementReport, formatPathReport, inlineCode, reportFileName, withLocation,
	type PathKind,
} from './reportFormat';

/**
 * Builds an XPath for an element, evaluated inside the page.
 *
 * Prefers a unique `id` as the anchor and walks up only that far, so the result
 * stays short and survives layout changes; falls back to a positional path from
 * the document root. Sent to `Runtime.callFunctionOn`, so it has to be a
 * self-contained function expression.
 */
const xpathFunctionDeclaration = `function () {
	// XPath 1.0 string literals have **no escape mechanism at all**, so a value
	// carrying both quote kinds can only be written with concat(). JSON escaping
	// looks like the answer and is not: an id of \`button"save\` produced
	// //*[@id="button\\"save"], which no XPath engine accepts — so a perfectly
	// valid id yielded a path that fails the moment it is used.
	function xpathLiteral(value) {
		// Built rather than written, to keep the quoting readable in here.
		var dq = String.fromCharCode(34);
		if (value.indexOf(dq) === -1) {
			return dq + value + dq;
		}
		if (value.indexOf("'") === -1) {
			return "'" + value + "'";
		}
		var parts = value.split(dq);
		var pieces = [];
		for (var i = 0; i < parts.length; i++) {
			if (parts[i] !== '') {
				pieces.push(dq + parts[i] + dq);
			}
			if (i < parts.length - 1) {
				pieces.push("'" + dq + "'");
			}
		}
		return 'concat(' + pieces.join(', ') + ')';
	}

	function uniqueById(el) {
		if (!el.id) {
			return null;
		}
		try {
			var matches = el.ownerDocument.querySelectorAll('[id="' + CSS.escape(el.id) + '"]');
			return matches.length === 1 ? '//*[@id=' + xpathLiteral(el.id) + ']' : null;
		} catch (e) {
			return null;
		}
	}

	function indexAmongSiblings(el) {
		var index = 1;
		var sibling = el.previousElementSibling;
		while (sibling) {
			if (sibling.tagName === el.tagName) {
				index++;
			}
			sibling = sibling.previousElementSibling;
		}
		var following = el.nextElementSibling;
		while (following) {
			if (following.tagName === el.tagName) {
				return index;
			}
			following = following.nextElementSibling;
		}
		return index === 1 ? 0 : index;
	}

	var node = this.nodeType === 1 ? this : this.parentElement;
	if (!node) {
		return '';
	}

	var segments = [];
	while (node && node.nodeType === 1) {
		var anchor = uniqueById(node);
		if (anchor) {
			return segments.length ? anchor + '/' + segments.join('/') : anchor;
		}
		var tag = node.tagName.toLowerCase();
		var index = indexAmongSiblings(node);
		segments.unshift(index ? tag + '[' + index + ']' : tag);
		node = node.parentElement;
	}

	return '/' + segments.join('/');
}`;

/**
 * Builds a CSS selector path, on the same principles as the XPath builder: a
 * unique `id` short-circuits the walk, and `:nth-of-type` is added only where a
 * tag actually repeats among its siblings.
 *
 * Classes are deliberately left out of the path. Utility-class frameworks
 * produce very long and very unstable class lists, and a selector built from
 * them reads worse and breaks sooner than a positional one. The full class list
 * is in "Copy Element" for anyone who wants it.
 */
const cssPathFunctionDeclaration = `function () {
	function uniqueById(el) {
		if (!el.id) {
			return null;
		}
		try {
			return el.ownerDocument.querySelectorAll('[id="' + CSS.escape(el.id) + '"]').length === 1
				? '#' + CSS.escape(el.id)
				: null;
		} catch (e) {
			return null;
		}
	}

	function nthOfType(el) {
		var index = 1;
		var sibling = el.previousElementSibling;
		while (sibling) {
			if (sibling.tagName === el.tagName) {
				index++;
			}
			sibling = sibling.previousElementSibling;
		}
		var following = el.nextElementSibling;
		while (following) {
			if (following.tagName === el.tagName) {
				return index;
			}
			following = following.nextElementSibling;
		}
		return index === 1 ? 0 : index;
	}

	var node = this.nodeType === 1 ? this : this.parentElement;
	if (!node) {
		return '';
	}

	var segments = [];
	while (node && node.nodeType === 1) {
		var anchor = uniqueById(node);
		if (anchor) {
			segments.unshift(anchor);
			return segments.join(' > ');
		}
		var tag = node.tagName.toLowerCase();
		var index = nthOfType(node);
		segments.unshift(index ? tag + ':nth-of-type(' + index + ')' : tag);
		node = node.parentElement;
	}

	return segments.join(' > ');
}`;

/**
 * The address of the document the picked element actually lives in.
 *
 * Both path builders walk `parentElement` and stop at the `<html>` of the node's
 * **own** document, and they test id uniqueness with `el.ownerDocument`. So an
 * element inside an iframe yields a selector rooted at the *frame's* document —
 * which `document.querySelector` on the top page will never resolve, because one
 * `querySelector` call cannot cross a document boundary. Pairing that selector
 * with `tab.url` therefore produced a locator that reads as precise and is
 * wrong: navigate there, run the selector, get `null` or a different element.
 *
 * The pair is made self-consistent instead, by taking the URL from the same
 * document the selector is rooted in. That follows the rule this project already
 * applies in `browser_snapshot` — never hand out a selector that does not
 * resolve with the call its consumer will make.
 *
 * `top` is reported separately so the report can say where the frame was
 * embedded; the one-line form has no room for it and does not need it, since the
 * pair resolves on its own.
 */
// No backticks anywhere below: every page-side source here is a template
// literal, so one inside a comment closes the string.
const documentLocationFunctionDeclaration = `function () {
	var result = { url: '', top: true, known: false, shadow: false };
	try {
		var node = this.nodeType === 1 ? this : this.parentElement;
		// Inside a shadow tree the root is the ShadowRoot rather than the
		// document, and the selector builder cannot say so: it walks
		// parentElement, which is null at the boundary, so it silently returns a
		// path rooted inside the shadow tree that document.querySelector can
		// never resolve.
		if (node && node.getRootNode) {
			result.shadow = node.getRootNode() !== node.ownerDocument;
		}
		var win = node && node.ownerDocument && node.ownerDocument.defaultView;
		if (win) {
			result.url = String(win.location.href);
			// Comparing the window references is legal across origins; it is not
			// a read of any property on the other document.
			result.top = win === win.top;
			result.known = true;
		}
	} catch (e) {
		// A document we are not allowed to read. The known flag stays false and the
		// caller falls back to the tab's own URL, which is the best it has.
	}
	return JSON.stringify(result);
}`;

/**
 * Turns on the browser's element inspector, waits for the user to pick an
 * element, and hands the picked node to `use`.
 *
 * Element selection is `Overlay.setInspectMode`, the same mechanism behind the
 * built-in browser's "Add Element to Chat", so hover highlighting comes free.
 */
/**
 * The pick currently waiting for a click, if any.
 *
 * Element selection has to be single-flight. Each pick opens its own CDP
 * session and turns on inspect mode; two at once means one click delivers
 * `Overlay.inspectNodeRequested` to *both* sessions, both commands complete,
 * and whichever finishes last overwrites the clipboard — which shows up as
 * "sometimes it copies the action I did not choose". Starting a pick therefore
 * cancels any pick already in flight: the most recent choice is the one the
 * user means.
 */
let pendingPick: vscode.CancellationTokenSource | undefined;

/**
 * Cancels a pick in flight.
 *
 * The cancel affordance is a status bar button rather than the cancel button on
 * a progress notification, because that notification is what froze the page —
 * see [notify.ts](notify.ts). It reuses the same token a superseding pick
 * cancels, so there is one cancellation path, already proven.
 */
export function cancelPendingPick(): void {
	pendingPick?.cancel();
}

/**
 * Claims the single pick slot, cancelling whatever held it.
 *
 * Separate from `withPickedElement` so that `pendingPick` is established
 * *before* the cancel button goes up. It used to be assigned inside, one
 * `await tab.startCDPSession()` later, and a click in that window called
 * `cancel()` on `undefined` — or, worse, on the previous pick's token — so the
 * button did nothing on exactly the slow sessions where someone would reach
 * for it.
 */
function beginPick(): vscode.CancellationTokenSource {
	pendingPick?.cancel();
	// The only cancellation source is this token: a superseding pick and the
	// status bar button both go through `pendingPick`.
	const cts = new vscode.CancellationTokenSource();
	pendingPick = cts;
	return cts;
}

/** Releases the slot, if this pick still holds it. */
function endPick(cts: vscode.CancellationTokenSource): void {
	if (pendingPick === cts) {
		pendingPick = undefined;
	}
	cts.dispose();
}

async function withPickedElement<T>(
	tab: vscode.BrowserTab,
	cts: vscode.CancellationTokenSource,
	use: (client: CDPClient, sessionId: string, backendNodeId: number) => Promise<T>,
): Promise<T | undefined> {

	// Inside the `try`, not before it: a rejection from `startCDPSession` used
	// to escape past the cleanup below, leaving the slot pointing at a token
	// that is no longer live until the next pick reclaimed it.
	let client: CDPClient | undefined;
	let sessionId: string | undefined;
	try {
		client = new CDPClient(await tab.startCDPSession());
		sessionId = await client.attachToPage();

		await client.send('DOM.enable', {}, sessionId);
		await client.send('CSS.enable', {}, sessionId);
		await client.send('Overlay.enable', {}, sessionId);
		await client.send('Overlay.setInspectMode', {
			mode: 'searchForNode',
			highlightConfig: {
				showInfo: true,
				contentColor: { r: 111, g: 168, b: 220, a: 0.45 },
				paddingColor: { r: 147, g: 196, b: 125, a: 0.35 },
				borderColor: { r: 255, g: 229, b: 153, a: 0.45 },
				marginColor: { r: 246, g: 178, b: 107, a: 0.35 },
			},
		}, sessionId);

		const { backendNodeId } = await client.once('Overlay.inspectNodeRequested', cts.token);
		return await use(client, sessionId, backendNodeId);
	} finally {
		// Has to be in `finally`: on cancellation the await above throws, and
		// leaving inspect mode on strands the page in "pick an element" state.
		if (client && sessionId !== undefined) {
			await client.send('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} }, sessionId)
				.catch(() => { /* cancelled, navigated away, or already detached */ });
		}
		client?.dispose();
	}
}

/** Runs a page-side function against the picked node and returns its string result. */
async function evaluateOnNode(
	client: CDPClient,
	sessionId: string,
	backendNodeId: number,
	functionDeclaration: string,
): Promise<string | undefined> {

	const { object } = await client.send('DOM.resolveNode', { backendNodeId }, sessionId);
	if (!object?.objectId) {
		throw new Error('Could not resolve the selected element');
	}

	const { result, exceptionDetails } = await client.send('Runtime.callFunctionOn', {
		objectId: object.objectId,
		functionDeclaration,
		returnByValue: true,
	}, sessionId);

	if (exceptionDetails) {
		throw new Error(exceptionDetails.text ?? 'Evaluation failed in the page');
	}
	return typeof result?.value === 'string' && result.value ? result.value : undefined;
}

/**
 * Whether an address can be navigated back to.
 *
 * `about:srcdoc` is what a `srcdoc` iframe reports and `about:blank` is what a
 * frame a script filled in reports — both name a document that exists only
 * inside the page that built it, so a locator pointing at one cannot be
 * reconstructed by anybody. `blob:` and `data:` are the same shape.
 */
function isNavigable(url: string | undefined): boolean {
	return url !== undefined && /^(https?|file):/i.test(url);
}

/** Where the picked element's own document lives, and whether it is the top one. */
async function documentLocation(
	client: CDPClient,
	sessionId: string,
	backendNodeId: number,
	tab: vscode.BrowserTab,
): Promise<{ url: string | undefined; embeddedIn?: string; shadow: boolean }> {

	let parsed: { url?: string; top?: boolean; known?: boolean; shadow?: boolean } = {};
	try {
		// The evaluation is inside the `try`, not only the parse. A page-side
		// throw comes back as a *successful* CDP reply carrying
		// `exceptionDetails`, which `evaluateOnNode` turns into a rejection — so
		// with only the parse guarded, a page that had replaced
		// `Document.prototype.defaultView` or `JSON.stringify` failed the whole
		// pick with an error toast, which is exactly what the fallback below
		// exists to avoid. It costs every kind now, not just this one:
		// `addPathToAssistant` calls this for `css` and `xpath` too.
		const raw = await evaluateOnNode(
			client, sessionId, backendNodeId, documentLocationFunctionDeclaration);
		parsed = raw ? JSON.parse(raw) : {};
	} catch {
		// Fall back to the tab's own URL rather than lose the pick.
	}
	const shadow = parsed.shadow === true;
	if (!parsed.known || !parsed.url) {
		return { url: tab.url, shadow };
	}
	return parsed.top
		? { url: parsed.url, shadow }
		: { url: parsed.url, embeddedIn: tab.url, shadow };
}

/**
 * Why this element cannot be handed out as a "navigate, then find" locator, if
 * it cannot.
 *
 * The rule is the one already written down for `browser_snapshot`: never hand
 * out a selector that does not resolve with the call its consumer will make. A
 * pair that cannot be reconstructed is worse than no pair, because it reads as
 * precise.
 */
function locatorRefusal(location: { url: string | undefined; shadow: boolean }): string | undefined {
	if (location.shadow) {
		return vscode.l10n.t(
			"That element is inside a shadow root, so a CSS path cannot reach it from the page. Use \"Copy Element\" instead.");
	}
	if (!isNavigable(location.url)) {
		return vscode.l10n.t(
			"That element is in a frame with no address of its own ({0}), so the page cannot be reopened at it. Use \"Copy Element\" instead.",
			location.url ?? 'unknown');
	}
	return undefined;
}

function requireBrowserTab(): vscode.BrowserTab | undefined {
	// `browserTabs` is a proposed API: absent on a VS Code without it, or when
	// the extension was launched without --enable-proposed-api. Worth telling
	// apart from "no tab is open" — the fixes are unrelated.
	if (!isBrowserApiGranted()) {
		// Deliberately not a notification. A browser tab is very likely the thing
		// on screen right now, and a toast over it pauses the page — the exact
		// complaint this whole surface was built to remove. The actionable half
		// is already there: the status bar carries `Enable Browser API` in
		// precisely this state.
		refuse(vscode.l10n.t(
			"Browser API not enabled — click \"Enable Browser API\" in the status bar."));
		return undefined;
	}

	const tab = vscode.window.activeBrowserTab;
	if (!tab) {
		// The status bar as well. `activeBrowserTab` is undefined whenever a file
		// has focus, including with a browser tab visible in a split beside it —
		// and the pause is decided geometrically, so a toast would pause exactly
		// the page this message tells the user to go and focus.
		refuse(vscode.l10n.t(
			"No integrated browser tab is active. Open a page with \"AI Browser: Show\", focus that tab, then try again."));
	}
	return tab;
}

/**
 * Ends the pick when the tab it is running in goes away.
 *
 * A pick is a wait for `Overlay.inspectNodeRequested` on that tab's own CDP
 * session, so a closed tab means the click can never arrive — and nothing
 * settles the wait on its own. `MainThreadBrowsers` closes a browser editor by
 * disposing its input, which fires `$onDidCloseBrowserTab` and leaves
 * `_cdpSessions` untouched: the session group is only destroyed by
 * `$closeCDPSession` or by the group service, so `BrowserCDPSession.onDidClose`
 * never fires for this. The `once` promise therefore hung for ever, taking
 * `withProgress` with it, and `$(stop-circle) Cancel pick` stayed in the status
 * bar for the rest of the session with nothing behind it to cancel.
 *
 * `onDidChangeActiveBrowserTab` is watched as well, for the same reason
 * `browserController` re-checks membership rather than trusting the close
 * event: it is what still arrives on a host that does not fire
 * `onDidCloseBrowserTab`, and the picked tab is by construction the active one,
 * so closing it changes which tab is active.
 */
function watchTabClose(
	tab: vscode.BrowserTab,
	cts: vscode.CancellationTokenSource,
): vscode.Disposable {

	const subs: vscode.Disposable[] = [];
	try {
		subs.push(vscode.window.onDidCloseBrowserTab(gone => {
			if (gone === tab) {
				cts.cancel();
			}
		}));
		subs.push(vscode.window.onDidChangeActiveBrowserTab(() => {
			if (!(vscode.window.browserTabs ?? []).includes(tab)) {
				cts.cancel();
			}
		}));
	} catch {
		// Proposal-gated, like every other use of it. `requireBrowserTab` has
		// already refused on a host without the grant, so this is belt and
		// braces rather than a path anyone reaches.
	}
	return new vscode.Disposable(() => {
		for (const sub of subs) {
			sub.dispose();
		}
	});
}

async function pickAndDeliver<T>(
	title: string,
	produce: (client: CDPClient, sessionId: string, backendNodeId: number, tab: vscode.BrowserTab) => Promise<T | undefined>,
	deliver: (value: T) => Promise<void>,
): Promise<void> {

	const tab = requireBrowserTab();
	if (!tab) {
		return;
	}

	// `ProgressLocation.Window` is the status bar: it renders `$(icon)` syntax
	// and, unlike `Notification`, does not paint over the browser and pause the
	// page. It also has no cancel button, hence the one below.
	// The slot is claimed first, so the button that cancels it is never live
	// before there is something for it to cancel.
	const cts = beginPick();
	const cancel = cancelButton();
	// Armed with the button, and for the same reason: both exist only for as
	// long as there is a pick, and the tab closing is the one way a pick ends
	// that nothing else notices.
	const watch = watchTabClose(tab, cts);
	try {
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Window,
			title: `$(inspect) ${title}`,
		}, async () => {
			try {
				const value = await withPickedElement(tab, cts,
					(client, sessionId, backendNodeId) =>
						produce(client, sessionId, backendNodeId, tab));
				// Cancellation is checked again here, and not only by the await
				// above: the token can be cancelled *after* the click has
				// arrived, and extraction is several CDP round trips. A
				// superseded pick that still delivered overwrote the newer
				// pick's clipboard — "sometimes it copies an action I did not
				// choose", which is the exact symptom `pendingPick` exists to
				// prevent.
				if (value === undefined || cts.token.isCancellationRequested) {
					return;
				}
				await deliver(value);
			} catch (err) {
				// The token is checked as well as the error type: a pick
				// cancelled part-way through its setup surfaces as whatever the
				// step it was in threw — a closed session, a tab that is no
				// longer there — and none of that is worth an error toast over
				// a page the user has just closed.
				if (err instanceof vscode.CancellationError || cts.token.isCancellationRequested) {
					return;
				}
				vscode.window.showErrorMessage(vscode.l10n.t(
					"AI Browser: {0}", err instanceof Error ? err.message : String(err)));
			}
		});
	} finally {
		watch.dispose();
		cancel.dispose();
		endPick(cts);
	}
}

/** The cancel affordance for a pick, for as long as one is running. */
function cancelButton(): vscode.Disposable {
	const item = vscode.window.createStatusBarItem(
		'aiBrowser.cancelPick', vscode.StatusBarAlignment.Left, 1001);
	item.name = vscode.l10n.t("AI Browser: cancel element pick");
	item.text = vscode.l10n.t("$(stop-circle) Cancel pick");
	item.tooltip = vscode.l10n.t("Stop picking an element");
	item.command = cancelPickCommand;
	item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
	item.show();
	return item;
}

export const cancelPickCommand = 'aiBrowser.cancelElementPick';

/** Truncates a value so a notification stays readable. */
function short(value: string): string {
	const firstLine = value.split('\n', 1)[0];
	return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

async function copyToClipboard(value: string, label: string): Promise<void> {
	await vscode.env.clipboard.writeText(value);
	confirm(vscode.l10n.t("{0} copied: {1}", label, short(value)));
}

export function copyElementXPath(): Promise<void> {
	return pickAndDeliver(
		vscode.l10n.t("Click an element in the browser to copy its XPath"),
		(client, sessionId, backendNodeId) =>
			evaluateOnNode(client, sessionId, backendNodeId, xpathFunctionDeclaration),
		value => copyToClipboard(value, vscode.l10n.t("XPath")),
	);
}

export function copyElementCssPath(): Promise<void> {
	return pickAndDeliver(
		vscode.l10n.t("Click an element in the browser to copy its CSS path"),
		(client, sessionId, backendNodeId) =>
			evaluateOnNode(client, sessionId, backendNodeId, cssPathFunctionDeclaration),
		value => copyToClipboard(value, vscode.l10n.t("CSS path")),
	);
}

/**
 * The CSS path plus the address of the page it was picked on, as one line.
 *
 * A selector on its own is ambiguous the moment more than one page is in play —
 * an assistant handed `#main > li:nth-of-type(2)` has no way to know which route
 * it belongs to, and guesses. The joined form answers both questions at once and
 * still splits cleanly on ` → `; see `locationSeparator` for why that separator
 * and not a bracketed suffix.
 */
export function copyElementCssLocation(): Promise<void> {
	return pickAndDeliver(
		vscode.l10n.t("Click an element in the browser to copy its CSS path and page address"),
		async (client, sessionId, backendNodeId, tab) => {
			const path = await evaluateOnNode(
				client, sessionId, backendNodeId, cssPathFunctionDeclaration);
			if (!path) {
				return undefined;
			}
			// The address comes from the element's own document, not from the
			// tab: the two differ inside an iframe, and the selector is rooted in
			// the former. It is also read now rather than when the pick started,
			// since a page can navigate while the user is choosing.
			const location = await documentLocation(client, sessionId, backendNodeId, tab);
			// Refused rather than handed over wrong: this command promises a pair
			// that resolves, and a shadow root or an address-less frame breaks
			// that promise silently. `refuse` is the status bar, never a toast —
			// a notification would pause the very tab being picked in.
			const refusal = locatorRefusal(location);
			if (refusal) {
				refuse(refusal);
				return undefined;
			}
			const { url } = location;
			// Wrapped as inline code, because this one lands in a chat message
			// rather than in a file: the separator and the `>` of the selector
			// are both Markdown-significant, so an unwrapped string is reflowed
			// by whatever renders it. The report path does not get this — its
			// value goes inside a fenced block, which already does the job.
			return inlineCode(withLocation(path, url));
		},
		value => copyToClipboard(value, vscode.l10n.t("CSS path + location")),
	);
}

export function copyElement(): Promise<void> {
	return pickAndDeliver(
		vscode.l10n.t("Click an element in the browser to copy its full context"),
		async (client, sessionId, backendNodeId, tab) => {
			const data = await extractElementData(client, sessionId, backendNodeId);
			return renderElementMarkdown(data, tab.url);
		},
		async markdown => {
			await vscode.env.clipboard.writeText(markdown);
			confirm(vscode.l10n.t(
				"Element context copied as Markdown ({0} characters).", String(markdown.length)));
		},
	);
}

/* ------------------------------------------------ handing a report to a chat */

/**
 * Delivers a report, falling back to the clipboard on every refusal.
 *
 * This is the only place that decides between "give it to the assistant" and
 * "put it on the clipboard", so a missing extension or a folderless window
 * never loses what the user just picked.
 */
async function deliverToAssistant(
	assistant: AssistantId,
	report: string,
	fileName: string,
): Promise<void> {

	let outcome: Awaited<ReturnType<typeof handOver>>;
	try {
		outcome = await handOver(assistant, report, fileName);
	} catch (err) {
		outcome = 'unavailable';
		console.warn('[ai-browser] hand-over failed:', err);
	}

	switch (outcome) {
		case 'delivered':
			confirm(vscode.l10n.t("Sent to {0} as {1}.", assistantName(assistant), fileName));
			return;

		case 'noWorkspace':
			await vscode.env.clipboard.writeText(report);
			vscode.window.showWarningMessage(vscode.l10n.t(
				"{0} addresses files by their path inside the workspace, and no folder is open — the report was copied to the clipboard instead.",
				assistantName(assistant)));
			return;

		case 'unavailable':
			await vscode.env.clipboard.writeText(report);
			vscode.window.showWarningMessage(vscode.l10n.t(
				"{0} is not available, so the report was copied to the clipboard instead.",
				assistantName(assistant)));
			return;
	}
}

/** Descriptor of the picked element, used in the heading and the file name. */
function describeElement(ancestors: { tagName: string; id?: string; classNames?: string[] }[]): string {
	return ancestors.length ? formatAncestor(ancestors[ancestors.length - 1]) : 'element';
}

export function addElementToAssistant(assistant: AssistantId): Promise<void> {
	return pickAndDeliver(
		vscode.l10n.t("Click an element to send its context to {0}", assistantName(assistant)),
		async (client, sessionId, backendNodeId, tab) => {
			const data = await extractElementData(client, sessionId, backendNodeId);
			const descriptor = describeElement(data.ancestors);
			return {
				report: formatElementReport(renderElementMarkdown(data, tab.url), descriptor),
				fileName: reportFileName('element', descriptor),
			};
		},
		({ report, fileName }) => deliverToAssistant(assistant, report, fileName),
	);
}

/** The progress title, which names the format the user is about to get. */
function pathPickTitle(kind: PathKind, assistant: AssistantId): string {
	const name = assistantName(assistant);
	switch (kind) {
		case 'css':
			return vscode.l10n.t("Click an element to send its CSS path to {0}", name);
		case 'cssLocation':
			return vscode.l10n.t("Click an element to send its CSS path and page address to {0}", name);
		case 'xpath':
			return vscode.l10n.t("Click an element to send its XPath to {0}", name);
	}
}

export function addPathToAssistant(assistant: AssistantId, kind: PathKind): Promise<void> {
	const declaration = kind === 'xpath' ? xpathFunctionDeclaration : cssPathFunctionDeclaration;

	return pickAndDeliver(
		pathPickTitle(kind, assistant),
		async (client, sessionId, backendNodeId, tab) => {
			const built = await evaluateOnNode(client, sessionId, backendNodeId, declaration);
			if (!built) {
				return undefined;
			}
			// Every kind gets the element's own document, not the tab's URL —
			// all three selectors are rooted in that document, so inside an
			// iframe the tab's URL names a page none of them resolve against.
			const location = await documentLocation(client, sessionId, backendNodeId, tab);
			// Only `cssLocation` promises a self-contained "navigate, then find"
			// pair, so only it refuses. `css` and `xpath` travel with prose that
			// does not claim the URL is a navigation target.
			if (kind === 'cssLocation') {
				const refusal = locatorRefusal(location);
				if (refusal) {
					refuse(refusal);
					return undefined;
				}
			}
			const { url, embeddedIn } = location;
			const path = kind === 'cssLocation' ? withLocation(built, url) : built;
			// The descriptor needs the element itself, which the path does not
			// carry — one extra round trip, worth it for a readable file name.
			const data = await extractElementData(client, sessionId, backendNodeId);
			const descriptor = describeElement(data.ancestors);
			return {
				report: formatPathReport(descriptor, kind, path, url, embeddedIn),
				fileName: reportFileName(kind, descriptor),
			};
		},
		({ report, fileName }) => deliverToAssistant(assistant, report, fileName),
	);
}
