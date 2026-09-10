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
import { connectClaudeCode, connectCodex, type SharedPage } from './mcpSetup';
import { everyone, forKind, isShareTarget, targetName, type ShareTarget } from './shareRegistry';
import { checkConnection } from './mcpCheck';
import { copyScreenshot } from './screenshot';
import {
	enableBrowserApi, integratedBrowserCommand, isBrowserApiGranted, shouldUseIntegratedBrowser,
} from './proposedApi';
import { confirm, refuse } from './notify';
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
const shareTabCommand = 'aiBrowser.shareTab';
const stopSharingTabCommand = 'aiBrowser.stopSharingTab';
const shareWithClaudeCommand = 'aiBrowser.shareTabWithClaudeCode';
const shareWithCodexCommand = 'aiBrowser.shareTabWithCodex';

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

	// **"Share Tab with Claude Code" is one gesture that means both halves.**
	// It was "Connect", which attaches the server to the *window*, and that
	// invited the belief that it bound the tab in front of you — so the tools
	// followed whichever tab was active and looked broken. Now the entry says
	// what it does and does it: the config is written if it has to be, and the
	// focused tab is given to *that* assistant.
	//
	// A connect made from anywhere else — the setup case, where the config is
	// written long before there is a page — assigns nothing and says what the
	// alternative is.
	const giveFocusedTab = async (target: ShareTarget): Promise<SharedPage | undefined> => {
		const tab = browser.focusedTab;
		if (!tab) {
			return undefined;
		}
		try {
			const shared = await browser.shareTab(tab, target);
			return { url: shared.url, title: shared.title, label: shared.label };
		} catch {
			// The tab went while the click was queued. Connecting is still
			// worth finishing; it simply assigns nothing.
			return undefined;
		}
	};

	context.subscriptions.push(vscode.commands.registerCommand(connectClaudeCommand,
		() => mcp.withServer(async server =>
			connectClaudeCode(server, await giveFocusedTab(forKind('claude'))))));
	context.subscriptions.push(vscode.commands.registerCommand(connectCodexCommand,
		() => mcp.withServer(async server =>
			connectCodex(server, await giveFocusedTab(forKind('codex'))))));
	context.subscriptions.push(vscode.commands.registerCommand(checkMcpCommand,
		() => mcp.withServer(checkConnection)));

	context.subscriptions.push(vscode.commands.registerCommand(enableBrowserApiCommand,
		() => enableBrowserApi()));

	// --- giving a tab to an assistant -----------------------------------------
	//
	// The MCP tools follow whichever tab is in front of the user by default,
	// which is right until an assistant is working while the user reads
	// something else. Every confirmation here goes through `confirm()` rather
	// than a notification — a browser tab is on screen by definition when these
	// are used, and a toast would pause the very page being handed over.
	const publishShareContext = () => {
		const shares = browser.shares;
		const any = shares.assignments.length > 0 || shares.paused.length > 0;
		void vscode.commands.executeCommand('setContext', 'aiBrowser.tabShared', any);
	};
	publishShareContext();
	context.subscriptions.push(browser.onDidChangeShare(publishShareContext));

	const share = async (target: ShareTarget) => {
		if (!isBrowserApiGranted()) {
			refuse(vscode.l10n.t("Sharing a tab needs the integrated browser API — see the AI Browser status bar item."));
			return;
		}
		// The focused tab, never the resolved one: this is a user gesture, and
		// "this tab" can only mean the one they are looking at.
		const tab = browser.focusedTab;
		if (!tab) {
			refuse(vscode.l10n.t("Open a page in the integrated browser and run this from that tab."));
			return;
		}
		try {
			const shared = await browser.shareTab(tab, target);
			confirm(vscode.l10n.t("{0} now works on {1} — and on nothing else",
				shared.label, shared.title || shared.url));
		} catch (err) {
			// A refusal, not a crash: the tab can close while the click is
			// queued behind another transition. Through `refuse()` because a
			// toast here would pause whatever browser tab is on screen.
			refuse(vscode.l10n.t("Could not share the tab: {0}",
				err instanceof Error ? err.message : String(err)));
		}
	};

	// `isShareTarget` and not `target ?? everyone`: a command invoked from an
	// `editor/title` menu is handed the **editor's resource**, so the first
	// argument is a `Uri` whenever this runs from the browser tab's own toolbar
	// — which resolved a key from a `Uri`, threw, and killed the entry that
	// matters most.
	context.subscriptions.push(vscode.commands.registerCommand(shareTabCommand,
		(target?: unknown) => share(isShareTarget(target) ? target : everyone)));
	context.subscriptions.push(vscode.commands.registerCommand(shareWithClaudeCommand,
		() => share(forKind('claude'))));
	context.subscriptions.push(vscode.commands.registerCommand(shareWithCodexCommand,
		() => share(forKind('codex'))));

	context.subscriptions.push(vscode.commands.registerCommand(stopSharingTabCommand,
		async (argument?: unknown) => {
			// See above: from the toolbar this argument is the editor's Uri.
			const target = isShareTarget(argument) ? argument : undefined;
			const shares = browser.shares;
			if (shares.assignments.length === 0 && shares.paused.length === 0) {
				refuse(vscode.l10n.t("No tab is shared."));
				return;
			}
			await browser.stopSharing(target);
			confirm(target
				? vscode.l10n.t("{0} follows whichever tab is in front of you again", targetName(target))
				: vscode.l10n.t("Stopped sharing — the assistants follow whichever tab is in front of you again"));
		}));

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
	registerStatusBar(context, browser);

}

function isWeb(): boolean {
	return !(typeof process === 'object' && !!process.versions.node) && vscode.env.uiKind === vscode.UIKind.Web;
}
