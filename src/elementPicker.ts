/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CDPClient } from './cdp';
import { extractElementData, renderElementMarkdown } from './elementContext';

/**
 * Builds an XPath for an element, evaluated inside the page.
 *
 * Prefers a unique `id` as the anchor and walks up only that far, so the result
 * stays short and survives layout changes; falls back to a positional path from
 * the document root. Sent to `Runtime.callFunctionOn`, so it has to be a
 * self-contained function expression.
 */
const xpathFunctionDeclaration = `function () {
	function uniqueById(el) {
		if (!el.id) {
			return null;
		}
		try {
			var matches = el.ownerDocument.querySelectorAll('[id="' + CSS.escape(el.id) + '"]');
			return matches.length === 1 ? '//*[@id=' + JSON.stringify(el.id) + ']' : null;
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
 * Turns on the browser's element inspector, waits for the user to pick an
 * element, and hands the picked node to `use`.
 *
 * Element selection is `Overlay.setInspectMode`, the same mechanism behind the
 * built-in browser's "Add Element to Chat", so hover highlighting comes free.
 */
async function withPickedElement<T>(
	tab: vscode.BrowserTab,
	token: vscode.CancellationToken,
	use: (client: CDPClient, sessionId: string, backendNodeId: number) => Promise<T>,
): Promise<T | undefined> {

	const client = new CDPClient(await tab.startCDPSession());
	try {
		const sessionId = await client.attachToPage();

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

		const { backendNodeId } = await client.once('Overlay.inspectNodeRequested', token);

		// Leave inspect mode before anything that can throw, or the page is
		// stuck in "pick an element" state.
		await client.send('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} }, sessionId)
			.catch(() => { /* the page may have navigated away */ });

		return await use(client, sessionId, backendNodeId);
	} finally {
		client.dispose();
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

function requireBrowserTab(): vscode.BrowserTab | undefined {
	// `browserTabs` is a proposed API: absent on a VS Code without it, or when
	// the extension was launched without --enable-proposed-api. Worth telling
	// apart from "no tab is open" — the fixes are unrelated.
	if (!('browserTabs' in vscode.window)) {
		vscode.window.showErrorMessage(vscode.l10n.t(
			"The integrated browser API is not available. It is a proposed API: launch with --enable-proposed-api=DenysDavydov.ai-browser on a recent VS Code."));
		return undefined;
	}

	const tab = vscode.window.activeBrowserTab;
	if (!tab) {
		vscode.window.showWarningMessage(vscode.l10n.t(
			"No integrated browser tab is active. Open a page with \"AI Browser: Show\", focus that tab, then try again."));
	}
	return tab;
}

async function pickAndCopy(
	title: string,
	produce: (client: CDPClient, sessionId: string, backendNodeId: number, tab: vscode.BrowserTab) => Promise<string | undefined>,
	report: (copied: string) => string,
): Promise<void> {

	const tab = requireBrowserTab();
	if (!tab) {
		return;
	}

	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		cancellable: true,
		title,
	}, async (_progress, token) => {
		try {
			const value = await withPickedElement(tab, token, (client, sessionId, backendNodeId) =>
				produce(client, sessionId, backendNodeId, tab));
			if (!value) {
				return;
			}
			await vscode.env.clipboard.writeText(value);
			vscode.window.showInformationMessage(report(value));
		} catch (err) {
			if (err instanceof vscode.CancellationError) {
				return;
			}
			vscode.window.showErrorMessage(vscode.l10n.t(
				"AI Browser: {0}", err instanceof Error ? err.message : String(err)));
		}
	});
}

/** Truncates a value so a notification stays readable. */
function short(value: string): string {
	const firstLine = value.split('\n', 1)[0];
	return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

export function copyElementXPath(): Promise<void> {
	return pickAndCopy(
		vscode.l10n.t("Click an element in the browser to copy its XPath"),
		(client, sessionId, backendNodeId) =>
			evaluateOnNode(client, sessionId, backendNodeId, xpathFunctionDeclaration),
		copied => vscode.l10n.t("XPath copied: {0}", short(copied)),
	);
}

export function copyElementCssPath(): Promise<void> {
	return pickAndCopy(
		vscode.l10n.t("Click an element in the browser to copy its CSS path"),
		(client, sessionId, backendNodeId) =>
			evaluateOnNode(client, sessionId, backendNodeId, cssPathFunctionDeclaration),
		copied => vscode.l10n.t("CSS path copied: {0}", short(copied)),
	);
}

export function copyElement(): Promise<void> {
	return pickAndCopy(
		vscode.l10n.t("Click an element in the browser to copy its full context"),
		async (client, sessionId, backendNodeId, tab) => {
			const data = await extractElementData(client, sessionId, backendNodeId);
			return renderElementMarkdown(data, tab.url);
		},
		() => vscode.l10n.t("Element context copied as Markdown."),
	);
}
