/*---------------------------------------------------------------------------------------------
 *  Activation: the commands the extension contributes, and the proxy and view they drive.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BrowserProxy } from './browserProxy';
import { TabBrowserManager } from './tabBrowserManager';
import { TabBrowserView } from './tabBrowserView';
import { registerTerminalLinks } from './terminalLinks';
import { cleanUpReports } from './assistants';
import { BrowserController } from './browserController';
import { generateUuid } from './uuid';
import { McpServer } from './mcpServer';
import { connectToClaudeCode, connectToCodex, registerWithVsCode } from './mcpSetup';
import { checkMcp, McpState } from './mcpCheck';
import { registerSidebar } from './sidebar';
import { CopyCommand } from '../shared/webviewProtocol';

declare class URL {
	constructor(input: string, base?: string | URL);
	hostname: string;
}

const openApiCommand = 'tabBrowser.api.open';
const showCommand = 'tabBrowser.show';
const copyElementCommand = 'tabBrowser.copyElement';
const copyElementXPathCommand = 'tabBrowser.copyElementXPath';
const copyElementPathCommand = 'tabBrowser.copyElementPath';
const addElementToClaudeCommand = 'tabBrowser.addElementToClaude';
const addElementXPathToClaudeCommand = 'tabBrowser.addElementXPathToClaude';
const addElementPathToClaudeCommand = 'tabBrowser.addElementPathToClaude';
const addElementToCodexCommand = 'tabBrowser.addElementToCodex';
const addElementXPathToCodexCommand = 'tabBrowser.addElementXPathToCodex';
const addElementPathToCodexCommand = 'tabBrowser.addElementPathToCodex';
const copyConsoleCommand = 'tabBrowser.copyConsole';
const addConsoleToClaudeCommand = 'tabBrowser.addConsoleToClaude';
const addConsoleToCodexCommand = 'tabBrowser.addConsoleToCodex';
const connectMcpCommand = 'tabBrowser.connectMcpToClaudeCode';
const connectMcpCodexCommand = 'tabBrowser.connectMcpToCodex';
const checkMcpCommand = 'tabBrowser.checkMcp';
const copyMcpUrlCommand = 'tabBrowser.copyMcpUrl';
const openSettingsCommand = 'tabBrowser.openSettings';
const refreshViewCommand = 'tabBrowser.refreshView';
const mcpTokenKey = 'mcp.token';

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

	context.subscriptions.push(registerTerminalLinks(url => manager.show(url)));

	const browser = new BrowserController(manager);

	// The server starts asynchronously, so the sidebar is handed a getter and told to redraw
	// once the state settles — which is also the one place that knows *why* it is not running.
	let mcpState: McpState = { kind: 'starting' };
	const sidebar = registerSidebar(context, manager, () => mcpState);
	context.subscriptions.push(sidebar);

	const mcp = startMcpServer(context, browser).then(state => {
		mcpState = state;
		sidebar.refresh();
		return state;
	});

	// Registered whatever the server does: a palette entry that throws "command not found"
	// is worse than one that explains why there is nothing to connect to.
	const withServer = (connect: (server: McpServer) => Promise<void>) => async () => {
		const state = await mcp;
		if (state.kind !== 'running') {
			vscode.window.showWarningMessage(state.kind === 'failed'
				? vscode.l10n.t("The browser's mcp server could not start: {0}", state.error)
				: vscode.l10n.t("The browser's mcp server is not running. Check `tabBrowser.mcp.enabled`."));
			return;
		}
		await connect(state.server);
	};

	context.subscriptions.push(
		vscode.commands.registerCommand(connectMcpCommand, withServer(connectToClaudeCode)),
		vscode.commands.registerCommand(connectMcpCodexCommand, withServer(connectToCodex)),
		vscode.commands.registerCommand(checkMcpCommand, async () => checkMcp(await mcp, browser)),
		vscode.commands.registerCommand(copyMcpUrlCommand, async () => copyMcpUrl(await mcp)),
		vscode.commands.registerCommand(openSettingsCommand, () => vscode.commands.executeCommand(
			'workbench.action.openSettings', `@ext:${context.extension.id}`)),
		// The client configurations the view reports on are files nothing here watches.
		vscode.commands.registerCommand(refreshViewCommand, () => sidebar.refresh()));

	// The reports handed to an assistant outlive their conversation by a few hours at most.
	cleanUpReports();

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
	registerCopyCommand(copyElementPathCommand, 'elementPath');
	registerCopyCommand(addElementToClaudeCommand, 'elementClaude');
	registerCopyCommand(addElementXPathToClaudeCommand, 'elementXPathClaude');
	registerCopyCommand(addElementPathToClaudeCommand, 'elementPathClaude');
	registerCopyCommand(addElementToCodexCommand, 'elementCodex');
	registerCopyCommand(addElementXPathToCodexCommand, 'elementXPathCodex');
	registerCopyCommand(addElementPathToCodexCommand, 'elementPathCodex');
	registerCopyCommand(copyConsoleCommand, 'console');
	registerCopyCommand(addConsoleToClaudeCommand, 'consoleClaude');
	registerCopyCommand(addConsoleToCodexCommand, 'consoleCodex');

	// `registerExternalUriOpener` is a proposed api, granted only to extensions shipped with the
	// editor. It is on the api object either way and *throws* when called without the proposal,
	// so the call itself has to be guarded and not merely looked up: an error here would take
	// the whole activation down with it, and with it the panel, the mcp server and the rest.
	try {
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
	} catch {
		// Then a forwarded localhost link does not offer this browser, and nothing else changes.
	}
}

/**
 * Gives an assistant the panel to work with. The server is what Claude Code connects to; VS
 * Code's own chat is told about it through the api, so it needs no configuration at all.
 */
async function startMcpServer(
	context: vscode.ExtensionContext,
	browser: BrowserController,
): Promise<McpState> {
	if (!vscode.workspace.getConfiguration('tabBrowser').get<boolean>('mcp.enabled', true)) {
		return { kind: 'disabled' };
	}

	const folder = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? 'no-folder';
	const server = new McpServer(
		browser,
		await workspaceToken(context, folder),
		folder,
		context.extension.packageJSON?.version);
	context.subscriptions.push(server);

	try {
		await server.start(
			vscode.workspace.getConfiguration('tabBrowser').get<number>('mcp.port', 43110));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		vscode.window.showWarningMessage(
			vscode.l10n.t("The browser's mcp server could not start: {0}", message));
		return { kind: 'failed', error: message };
	}

	context.subscriptions.push(registerWithVsCode(server));
	return { kind: 'running', server };
}

/**
 * For a client this extension cannot configure itself. Two forms, because a client that cannot
 * send a header needs the token in the path — and one that can should not have it there, where
 * it ends up in logs and in shell history.
 */
async function copyMcpUrl(state: McpState): Promise<void> {
	if (state.kind !== 'running' || !state.server.url || !state.server.urlWithToken) {
		vscode.window.showWarningMessage(vscode.l10n.t("The mcp server is not running."));
		return;
	}

	const withHeader = {
		label: vscode.l10n.t("Url, with the token in a header"),
		detail: `${state.server.url} — Authorization: Bearer …`,
		text: state.server.url,
	};
	const withToken = {
		label: vscode.l10n.t("Url with the token in it"),
		detail: vscode.l10n.t("For clients that cannot send a header, such as Codex"),
		text: state.server.urlWithToken,
	};

	const picked = await vscode.window.showQuickPick([withHeader, withToken], {
		title: vscode.l10n.t("Copy the mcp server url"),
	});
	if (!picked) {
		return;
	}

	const text = picked === withHeader
		? `${state.server.url}\nAuthorization: Bearer ${state.server.token}`
		: picked.text;
	await vscode.env.clipboard.writeText(text);
	vscode.window.showInformationMessage(vscode.l10n.t("Copied. It is only reachable from this machine, and only with this window's token."));
}

/**
 * One token per workspace, kept across restarts so a configuration written once keeps working.
 *
 * Per workspace and not per user, because ports are handed out in the order windows open: a
 * configuration written for project A can end up pointing at the window of project B. With the
 * token bound to the workspace that misconnection is a plain 401 instead of an assistant
 * quietly driving the wrong project.
 */
async function workspaceToken(context: vscode.ExtensionContext, folder: string): Promise<string> {
	const key = `${mcpTokenKey}:${folder}`;
	let token = context.globalState.get<string>(key);
	if (!token) {
		token = `${generateUuid()}${generateUuid()}`.replace(/-/g, '');
		await context.globalState.update(key, token);
	}
	return token;
}

export function deactivate(): void {
	// Everything is disposed through `context.subscriptions`.
}

function isWeb(): boolean {
	return !(typeof process === 'object' && !!process.versions.node) && vscode.env.uiKind === vscode.UIKind.Web;
}
