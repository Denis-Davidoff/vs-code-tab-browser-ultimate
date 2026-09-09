/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AIBrowserManager } from './aiBrowserManager';
import { AIBrowserView } from './aiBrowserView';
import { copyElement, copyElementCssPath, copyElementXPath } from './elementPicker';
import { ToolsViewProvider } from './toolsView';
import { LastElementAction, type ElementActionId } from './lastAction';

declare class URL {
	constructor(input: string, base?: string | URL);
	hostname: string;
}

const openApiCommand = 'aiBrowser.api.open';
const showCommand = 'aiBrowser.show';
const integratedBrowserCommand = 'workbench.action.browser.open';

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

const openerId = 'aiBrowser.open';

/**
 * Checks if the integrated browser should be used instead of the AI browser.
 *
 * Delegation is opt-in: our own panel is the point of this extension, and
 * `workbench.action.browser.open` exists in every recent VS Code, so
 * delegating whenever the command is available meant our panel never opened
 * at all. Users who prefer VS Code's built-in browser (agent sharing, CDP,
 * device emulation) can still switch back via the setting.
 */
async function shouldUseIntegratedBrowser(): Promise<boolean> {
	const preferIntegrated = vscode.workspace
		.getConfiguration('aiBrowser')
		.get<boolean>('useIntegratedBrowser', true);
	if (!preferIntegrated) {
		return false;
	}

	const commands = await vscode.commands.getCommands(true);
	return commands.includes(integratedBrowserCommand);
}

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

	context.subscriptions.push(vscode.window.registerTreeDataProvider(
		ToolsViewProvider.viewId, new ToolsViewProvider(context.extensionUri)));

	// The toolbar's primary button repeats whichever of these ran last, so every
	// one of them records itself.
	const lastAction = new LastElementAction(context.globalState);
	lastAction.initialize();

	const registerElementCommand = (id: string, remembered: ElementActionId, run: () => Promise<void>) =>
		context.subscriptions.push(vscode.commands.registerCommand(id, async () => {
			await lastAction.record(remembered);
			await run();
		}));

	registerElementCommand(copyElementCommand, 'element', copyElement);
	registerElementCommand(copyXPathCommand, 'xpath', copyElementXPath);
	registerElementCommand(copyCssPathCommand, 'cssPath', copyElementCssPath);

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
}

function isWeb(): boolean {
	return !(typeof process === 'object' && !!process.versions.node) && vscode.env.uiKind === vscode.UIKind.Web;
}
