/*---------------------------------------------------------------------------------------------
 *  Activation: the commands the extension contributes, and the proxy and view they drive.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BrowserProxy } from './browserProxy';
import { TabBrowserManager } from './tabBrowserManager';
import { TabBrowserView } from './tabBrowserView';
import { CopyCommand } from '../shared/webviewProtocol';

declare class URL {
	constructor(input: string, base?: string | URL);
	hostname: string;
}

const openApiCommand = 'tabBrowser.api.open';
const showCommand = 'tabBrowser.show';
const copyElementCommand = 'tabBrowser.copyElement';
const copyElementXPathCommand = 'tabBrowser.copyElementXPath';
const copyConsoleCommand = 'tabBrowser.copyConsole';

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

const openerId = 'tabBrowser.open';

export function activate(context: vscode.ExtensionContext) {

	const proxy = new BrowserProxy(context.extensionUri);
	context.subscriptions.push(proxy);

	const manager = new TabBrowserManager(context.extensionUri, proxy);
	context.subscriptions.push(manager);

	context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(TabBrowserView.viewType, {
		deserializeWebviewPanel: async (panel, state) => {
			manager.restore(panel, state);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand(showCommand, async (url?: string) => {
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

	context.subscriptions.push(vscode.commands.registerCommand(openApiCommand, async (url: vscode.Uri, showOptions?: {
		preserveFocus?: boolean;
		viewColumn: vscode.ViewColumn;
	}) => {
		manager.show(url, showOptions);
	}));

	const registerCopyCommand = (id: string, command: CopyCommand) =>
		context.subscriptions.push(vscode.commands.registerCommand(id, () => {
			const view = manager.activeView;
			if (!view) {
				vscode.window.showInformationMessage(
					vscode.l10n.t("Open a page with \"Tab Browser Ultimate: Show\" first."));
				return;
			}
			view.runCopyCommand(command);
		}));

	registerCopyCommand(copyElementCommand, 'element');
	registerCopyCommand(copyElementXPathCommand, 'elementXPath');
	registerCopyCommand(copyConsoleCommand, 'console');

	// `registerExternalUriOpener` is a proposed API that is only granted to extensions
	// shipped with the editor. Guard the call so activation still succeeds without it.
	if (typeof vscode.window.registerExternalUriOpener === 'function') {
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
				return manager.show(resolveUri, {
					viewColumn: vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active
				});
			}
		}, {
			schemes: ['http', 'https'],
			label: vscode.l10n.t("Open in Tab Browser Ultimate"),
		}));
	}
}

export function deactivate(): void {
	// Everything is disposed through `context.subscriptions`.
}

function isWeb(): boolean {
	return !(typeof process === 'object' && !!process.versions.node) && vscode.env.uiKind === vscode.UIKind.Web;
}
