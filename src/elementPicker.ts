/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CDPClient } from './cdp';

/**
 * Builds an XPath for an element, evaluated inside the page.
 *
 * Prefers a unique `id` as the anchor and walks up only as far as that, so the
 * result stays short and survives layout changes; falls back to a positional
 * path from the document root. Sent to `Runtime.callFunctionOn`, so it must be
 * a self-contained function expression.
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
		// Only emit a predicate when there is more than one sibling of this tag.
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
 * Turns on the browser's element inspector, waits for the user to click one,
 * and returns its XPath.
 *
 * Element selection is `Overlay.setInspectMode`, the same mechanism the
 * built-in browser's own "Add Element to Chat" uses, so hover highlighting
 * comes for free.
 */
export async function pickElementXPath(
	tab: vscode.BrowserTab,
	token: vscode.CancellationToken,
): Promise<string | undefined> {

	const client = new CDPClient(await tab.startCDPSession());
	try {
		const sessionId = await client.attachToPage();

		await client.send('DOM.enable', {}, sessionId);
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

		// Leaving inspect mode has to happen whether or not the rest succeeds,
		// otherwise the page stays in "pick an element" state.
		await client.send('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} }, sessionId)
			.catch(() => { /* the page may have navigated away */ });

		const { object } = await client.send('DOM.resolveNode', { backendNodeId }, sessionId);
		if (!object?.objectId) {
			throw new Error('Could not resolve the selected element');
		}

		const { result, exceptionDetails } = await client.send('Runtime.callFunctionOn', {
			objectId: object.objectId,
			functionDeclaration: xpathFunctionDeclaration,
			returnByValue: true,
		}, sessionId);

		if (exceptionDetails) {
			throw new Error(exceptionDetails.text ?? 'Failed to compute the XPath');
		}

		return typeof result?.value === 'string' && result.value ? result.value : undefined;
	} finally {
		client.dispose();
	}
}

/**
 * Command body: pick an element in the active browser tab and put its XPath on
 * the clipboard.
 */
export async function copyElementXPath(): Promise<void> {
	// `browserTabs` is a proposed API: absent entirely on a VS Code that does not
	// have it, or when the extension was launched without
	// --enable-proposed-api. Worth telling apart from "no tab is open", because
	// the fix is completely different.
	if (!('browserTabs' in vscode.window)) {
		vscode.window.showErrorMessage(vscode.l10n.t(
			"The integrated browser API is not available. It is a proposed API: launch VS Code with --enable-proposed-api=DenysDavydov.ai-browser, and make sure the VS Code build is recent enough to have it."));
		return;
	}

	const tab = vscode.window.activeBrowserTab;
	if (!tab) {
		vscode.window.showWarningMessage(vscode.l10n.t(
			"No integrated browser tab is active. Open a page with \"AI Browser: Show\" (or any localhost link), focus that tab, then run this command."));
		return;
	}

	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		cancellable: true,
		title: vscode.l10n.t("Click an element in the browser to copy its XPath"),
	}, async (_progress, token) => {
		try {
			const xpath = await pickElementXPath(tab, token);
			if (!xpath) {
				return;
			}
			await vscode.env.clipboard.writeText(xpath);
			vscode.window.showInformationMessage(vscode.l10n.t("XPath copied: {0}", xpath));
		} catch (err) {
			if (err instanceof vscode.CancellationError) {
				return;
			}
			vscode.window.showErrorMessage(vscode.l10n.t(
				"Could not copy the XPath: {0}", err instanceof Error ? err.message : String(err)));
		}
	});
}
