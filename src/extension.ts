/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AIBrowserManager } from './aiBrowserManager';
import { AIBrowserView } from './aiBrowserView';
import {
	addElementToAssistant, addPathToAssistant, cancelPendingPick, cancelPickCommand,
	copyElement, copyElementCssPath, copyElementXPath,
} from './elementPicker';
import { cleanUpReports, publishAssistantContext, type AssistantId } from './assistants';
import { LastElementAction, type ElementActionId } from './lastAction';
import { BrowserController } from './browserController';
import { McpLifecycle } from './mcpLifecycle';
import { connectClaudeCode, connectCodex } from './mcpSetup';
import { checkConnection } from './mcpCheck';
import { copyScreenshot } from './screenshot';
import {
	enableBrowserApi, integratedBrowserCommand, shouldUseIntegratedBrowser,
} from './proposedApi';
import { registerStatusBar } from './statusBar';

declare class URL {
	constructor(input: string, base?: string | URL);
	hostname: string;
}

const openApiCommand = 'aiBrowser.api.open';
const showCommand = 'aiBrowser.show';

const enabledHosts = new Set<string>([
	'localhost',
	// localhost IPv4
	'127.0.0.1',
	// localhost IPv6
	'[0:0:0:0:0:0:0:1]',
	'[::1]',
	// all interfaces IPv4
	'0.0.0.0',
	// all interfaces IPv6
	'[0:0:0:0:0:0:0:0]',
	'[::]'
]);

const copyXPathCommand = 'aiBrowser.copyElementXPath';
const copyElementCommand = 'aiBrowser.copyElement';
const copyCssPathCommand = 'aiBrowser.copyElementCssPath';
const connectClaudeCommand = 'aiBrowser.connectClaudeCode';
const connectCodexCommand = 'aiBrowser.connectCodex';
const checkMcpCommand = 'aiBrowser.checkMcpConnection';
const enableBrowserApiCommand = 'aiBrowser.enableBrowserApi';

const openerId = 'aiBrowser.open';

/**
 * Opens a URL in the integrated browser
 */
async function openInIntegratedBrowser(url?: string): Promise<void> {
	await vscode.commands.executeCommand(integratedBrowserCommand, url);
}

export function activate(context: vscode.ExtensionContext) {

	const manager = new AIBrowserManager(context.extensionUri);
	context.subscriptions.push(manager);

	context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(AIBrowserView.viewType, {
		deserializeWebviewPanel: async (panel, state) => {
			manager.restore(panel, state);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand(showCommand, async (url?: string) => {
		if (await shouldUseIntegratedBrowser()) {
			return openInIntegratedBrowser(url);
		}

		if (!url) {
			url = await vscode.window.showInputBox({
				placeHolder: vscode.l10n.t("https://example.com"),
				prompt: vscode.l10n.t("Enter url to visit")
			});
		}

		if (url) {
			manager.show(url);
		}
	}));

	// The toolbar's primary button repeats whichever of these ran last, so every
	// one of them records itself.
	const lastAction = new LastElementAction(context.globalState);
	lastAction.initialize();

	const registerElementCommand = (id: string, remembered: ElementActionId, run: () => Promise<void>) =>
		context.subscriptions.push(vscode.commands.registerCommand(id, async () => {
			await lastAction.record(remembered);
			await run();
		}));

	// --- MCP: the browser exposed to Claude Code, Codex and VS Code chat --------
	const browser = new BrowserController();
	context.subscriptions.push(browser);

	const mcp = new McpLifecycle(context, browser, context.extension.packageJSON.version ?? '0.0.0');
	context.subscriptions.push(mcp);
	mcp.apply();

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('aiBrowser.mcp.enabled') || e.affectsConfiguration('aiBrowser.mcp.port')) {
			mcp.apply();
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('aiBrowser.copyScreenshot',
		() => copyScreenshot(browser, false)));
	context.subscriptions.push(vscode.commands.registerCommand('aiBrowser.copyFullScreenshot',
		() => copyScreenshot(browser, true)));

	context.subscriptions.push(vscode.commands.registerCommand(connectClaudeCommand,
		() => mcp.withServer(connectClaudeCode)));
	context.subscriptions.push(vscode.commands.registerCommand(connectCodexCommand,
		() => mcp.withServer(connectCodex)));
	context.subscriptions.push(vscode.commands.registerCommand(checkMcpCommand,
		() => mcp.withServer(checkConnection)));

	context.subscriptions.push(vscode.commands.registerCommand(enableBrowserApiCommand,
		() => enableBrowserApi()));

	// Not contributed to the manifest on purpose: it only exists for the status
	// bar button shown while a pick is running, and a palette entry that is
	// inert the rest of the time would be worse than none.
	context.subscriptions.push(vscode.commands.registerCommand(cancelPickCommand,
		() => cancelPendingPick()));

	// Menu items for the assistants are gated on `when` clauses, so their
	// installation state has to be published — and re-published, since an
	// extension can be installed while this window is open.
	publishAssistantContext();
	context.subscriptions.push(vscode.extensions.onDidChange(publishAssistantContext));
	cleanUpReports();

	// These record themselves too, so the toolbar button repeats "Add XPath to
	// Codex" just as readily as "Copy XPath".
	for (const assistant of ['claude', 'codex'] as AssistantId[]) {
		const suffix = assistant === 'claude' ? 'ClaudeCode' : 'Codex';
		registerElementCommand(`aiBrowser.addElementTo${suffix}`, `${assistant}:element`,
			() => addElementToAssistant(assistant));
		registerElementCommand(`aiBrowser.addCssPathTo${suffix}`, `${assistant}:cssPath`,
			() => addPathToAssistant(assistant, 'css'));
		registerElementCommand(`aiBrowser.addXPathTo${suffix}`, `${assistant}:xpath`,
			() => addPathToAssistant(assistant, 'xpath'));
	}

	registerElementCommand(copyElementCommand, 'element', copyElement);
	registerElementCommand(copyXPathCommand, 'xpath', copyElementXPath);
	registerElementCommand(copyCssPathCommand, 'cssPath', copyElementCssPath);

	// The toolbar button and the Cmd+Alt+C chord run these `repeat.*` twins
	// rather than the commands above. The reason is presentational: VS Code
	// prints a command's keybinding beside every menu item that invokes it, with
	// no way to opt out, so the chord had to move off the commands that appear in
	// the dropdown. Each twin shares its original's icon and title, so the button
	// and its tooltip are unchanged.
	const repeats: [ElementActionId, () => Promise<void>][] = [
		['element', copyElement],
		['cssPath', copyElementCssPath],
		['xpath', copyElementXPath],
		['claude:element', () => addElementToAssistant('claude')],
		['claude:cssPath', () => addPathToAssistant('claude', 'css')],
		['claude:xpath', () => addPathToAssistant('claude', 'xpath')],
		['codex:element', () => addElementToAssistant('codex')],
		['codex:cssPath', () => addPathToAssistant('codex', 'css')],
		['codex:xpath', () => addPathToAssistant('codex', 'xpath')],
	];
	for (const [action, run] of repeats) {
		registerElementCommand(`aiBrowser.repeat.${action.replace(':', '.')}`, action, run);
	}

	context.subscriptions.push(vscode.commands.registerCommand(openApiCommand, async (url: vscode.Uri, showOptions?: {
		preserveFocus?: boolean;
		viewColumn: vscode.ViewColumn;
	}) => {
		if (await shouldUseIntegratedBrowser()) {
			await openInIntegratedBrowser(url.toString(true));
		} else {
			manager.show(url, showOptions);
		}
	}));

	// Calling this without `--enable-proposed-api` throws and aborts activate.
	// The `browser` proposal is dropped with a log line; this one is not.
	try {
		context.subscriptions.push(vscode.window.registerExternalUriOpener(openerId, {
			canOpenExternalUri(uri: vscode.Uri) {
				// We have to replace the IPv6 hosts with IPv4 because URL can't handle IPv6.
				const originalUri = new URL(uri.toString(true));
				if (enabledHosts.has(originalUri.hostname)) {
					return isWeb()
						? vscode.ExternalUriOpenerPriority.Default
						: vscode.ExternalUriOpenerPriority.Option;
				}

				return vscode.ExternalUriOpenerPriority.None;
			},
			async openExternalUri(resolveUri: vscode.Uri) {
				if (await shouldUseIntegratedBrowser()) {
					await openInIntegratedBrowser(resolveUri.toString(true));
				} else {
					return manager.show(resolveUri, {
						viewColumn: vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active
					});
				}
			}
		}, {
			schemes: ['http', 'https'],
			label: vscode.l10n.t("Open in AI browser"),
		}));
	} catch {
		// Host refused the proposal. The rest of the extension still works.
	}

	// The permanent status bar entry, plus the warning one that hides itself
	// once the grant is in place.
	registerStatusBar(context);

}

function isWeb(): boolean {
	return !(typeof process === 'object' && !!process.versions.node) && vscode.env.uiKind === vscode.UIKind.Web;
}
