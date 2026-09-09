/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CDPClient } from './cdp';
import { extractElementData, formatAncestor, renderElementMarkdown } from './elementContext';
import { assistantName, handOver, type AssistantId } from './assistants';
import {
	formatElementReport, formatPathReport, reportFileName, type PathKind,
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

async function withPickedElement<T>(
	tab: vscode.BrowserTab,
	token: vscode.CancellationToken,
	use: (client: CDPClient, sessionId: string, backendNodeId: number) => Promise<T>,
): Promise<T | undefined> {

	pendingPick?.cancel();

	const cts = new vscode.CancellationTokenSource();
	pendingPick = cts;
	const externalCancel = token.onCancellationRequested(() => cts.cancel());

	const client = new CDPClient(await tab.startCDPSession());
	let sessionId: string | undefined;
	try {
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
		if (sessionId !== undefined) {
			await client.send('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} }, sessionId)
				.catch(() => { /* cancelled, navigated away, or already detached */ });
		}
		client.dispose();
		externalCancel.dispose();
		if (pendingPick === cts) {
			pendingPick = undefined;
		}
		cts.dispose();
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
			"The integrated browser API is not available. It is a proposed API: launch with --enable-proposed-api=DenysDavydov.tab-browser-ultimate on a recent VS Code."));
		return undefined;
	}

	const tab = vscode.window.activeBrowserTab;
	if (!tab) {
		vscode.window.showWarningMessage(vscode.l10n.t(
			"No integrated browser tab is active. Open a page with \"AI Browser: Show\", focus that tab, then try again."));
	}
	return tab;
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

	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		cancellable: true,
		title,
	}, async (_progress, token) => {
		try {
			const value = await withPickedElement(tab, token, (client, sessionId, backendNodeId) =>
				produce(client, sessionId, backendNodeId, tab));
			if (value === undefined) {
				return;
			}
			await deliver(value);
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

async function copyToClipboard(value: string, label: string): Promise<void> {
	await vscode.env.clipboard.writeText(value);
	vscode.window.showInformationMessage(vscode.l10n.t("{0} copied: {1}", label, short(value)));
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

export function copyElement(): Promise<void> {
	return pickAndDeliver(
		vscode.l10n.t("Click an element in the browser to copy its full context"),
		async (client, sessionId, backendNodeId, tab) => {
			const data = await extractElementData(client, sessionId, backendNodeId);
			return renderElementMarkdown(data, tab.url);
		},
		async markdown => {
			await vscode.env.clipboard.writeText(markdown);
			vscode.window.showInformationMessage(vscode.l10n.t(
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
			vscode.window.showInformationMessage(vscode.l10n.t(
				"Sent to {0} as {1}.", assistantName(assistant), fileName));
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

export function addPathToAssistant(assistant: AssistantId, kind: PathKind): Promise<void> {
	const declaration = kind === 'css' ? cssPathFunctionDeclaration : xpathFunctionDeclaration;

	return pickAndDeliver(
		kind === 'css'
			? vscode.l10n.t("Click an element to send its CSS path to {0}", assistantName(assistant))
			: vscode.l10n.t("Click an element to send its XPath to {0}", assistantName(assistant)),
		async (client, sessionId, backendNodeId, tab) => {
			const path = await evaluateOnNode(client, sessionId, backendNodeId, declaration);
			if (!path) {
				return undefined;
			}
			// The descriptor needs the element itself, which the path does not
			// carry — one extra round trip, worth it for a readable file name.
			const data = await extractElementData(client, sessionId, backendNodeId);
			const descriptor = describeElement(data.ancestors);
			return {
				report: formatPathReport(descriptor, kind, path, tab.url),
				fileName: reportFileName(kind, descriptor),
			};
		},
		({ report, fileName }) => deliverToAssistant(assistant, report, fileName),
	);
}
