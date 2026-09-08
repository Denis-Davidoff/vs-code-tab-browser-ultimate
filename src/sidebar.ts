/*---------------------------------------------------------------------------------------------
 *  The view in the activity bar: what the panel and the mcp server are doing, and the actions
 *  that are worth reaching without the command palette.
 *
 *  A tree and not a webview, and every row runs one of the commands the extension already
 *  registers — the view is a way to reach them and nothing more, so there is still one
 *  implementation of each action. The whole tree is a couple of dozen rows, so it is rebuilt
 *  from scratch whenever the panel, the configuration or the installed assistants change.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { isInstalled, name as assistantName } from './assistants';
import { McpState } from './mcpCheck';
import { RecentPages } from './recentPages';
import { TabBrowserManager } from './tabBrowserManager';

export const viewId = 'tabBrowser.actions';

/** As many of the remembered pages as a tree section has room for. */
const maxRecentRows = 8;

interface Row {
	readonly label: string;
	readonly description?: string;
	readonly tooltip?: string;
	readonly icon?: vscode.ThemeIcon;
	readonly command?: string;
	readonly args?: readonly unknown[];
	readonly children?: readonly Row[];
	readonly collapsed?: boolean;
}

export interface Sidebar extends vscode.Disposable {
	refresh(): void;
}

export function registerSidebar(
	context: vscode.ExtensionContext,
	manager: TabBrowserManager,
	recent: RecentPages,
	mcpState: () => McpState,
): Sidebar {
	const provider = new SidebarProvider(manager, recent, mcpState);
	const disposables = [
		provider,
		vscode.window.registerTreeDataProvider(viewId, provider),
		manager.onDidChange(() => provider.refresh()),
		recent.onDidChange(() => provider.refresh()),
		// The mcp rows and the assistant rows both depend on things outside the panel.
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('tabBrowser')) {
				provider.refresh();
			}
		}),
		vscode.extensions.onDidChange(() => provider.refresh()),
	];

	return {
		refresh: () => provider.refresh(),
		dispose: () => {
			for (const disposable of disposables) {
				disposable.dispose();
			}
		},
	};
}

class SidebarProvider implements vscode.TreeDataProvider<Row> {

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(
		private readonly _manager: TabBrowserManager,
		private readonly _recent: RecentPages,
		private readonly _mcpState: () => McpState,
	) { }

	public dispose(): void {
		this._onDidChangeTreeData.dispose();
	}

	public refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	public getTreeItem(row: Row): vscode.TreeItem {
		const item = new vscode.TreeItem(row.label, row.children
			? (row.collapsed
				? vscode.TreeItemCollapsibleState.Collapsed
				: vscode.TreeItemCollapsibleState.Expanded)
			: vscode.TreeItemCollapsibleState.None);

		item.description = row.description;
		item.tooltip = row.tooltip;
		item.iconPath = row.icon;
		if (row.command) {
			item.command = { command: row.command, title: row.label, arguments: [...row.args ?? []] };
		}
		return item;
	}

	public getChildren(row?: Row): Row[] {
		return [...(row ? row.children ?? [] : this._roots())];
	}

	private _roots(): Row[] {
		const view = this._manager.activeView;
		const recent = this._recentUrls();

		return [
			{
				label: vscode.l10n.t("Navigation"),
				icon: new vscode.ThemeIcon('globe'),
				children: [
					view
						? {
							// A new tab has no page yet, and an empty row says nothing at all.
							label: view.url ? shorten(view.url) : vscode.l10n.t("New tab"),
							description: view.inspectable
								? vscode.l10n.t("ready")
								: vscode.l10n.t("not instrumented"),
							tooltip: view.inspectable
								? vscode.l10n.t("{0}\n\nThe page carries the injected script: the copy menu and the mcp tools can read it.", view.url)
								: vscode.l10n.t("{0}\n\nThe page is loaded directly, so it cannot be read. `tabBrowser.proxy.mode` decides which urls go through the proxy that makes it readable.", view.url),
							icon: new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(
								view.inspectable ? 'charts.green' : 'charts.yellow')),
						}
						: {
							label: vscode.l10n.t("No page open"),
							icon: new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground')),
						},
					{
						label: vscode.l10n.t("New tab"),
						description: vscode.l10n.t("a second panel"),
						icon: new vscode.ThemeIcon('add'),
						command: 'tabBrowser.newTab',
					},
					{
						label: vscode.l10n.t("Open a page…"),
						icon: new vscode.ThemeIcon('add'),
						command: 'tabBrowser.show',
					},
					{
						label: vscode.l10n.t("Open a file…"),
						description: vscode.l10n.t("html from disk"),
						icon: new vscode.ThemeIcon('file-code'),
						command: 'tabBrowser.openFile',
					},
					...(view ? [{
						label: vscode.l10n.t("Reload"),
						icon: new vscode.ThemeIcon('refresh'),
						command: 'tabBrowser.show',
						args: [view.url],
					}] : []),
				],
			},
			...(view ? [{
				label: vscode.l10n.t("Tools"),
				icon: new vscode.ThemeIcon('browser'),
				children: this._pageRows(),
			}] : []),
			{
				label: vscode.l10n.t("MCP"),
				icon: new vscode.ThemeIcon('server'),
				children: this._mcpRows(),
			},
			...(recent.length ? [{
				label: vscode.l10n.t("Recent"),
				icon: new vscode.ThemeIcon('history'),
				collapsed: true,
				children: recent.map(url => ({
					label: shorten(url),
					tooltip: url,
					icon: new vscode.ThemeIcon('globe'),
					command: 'tabBrowser.show',
					args: [url],
				})),
			}] : []),
		];
	}

	/**
	 * The copy menu entries that are worth a second home. The panel's own toolbar has all of
	 * them; these are the ones asked for often enough to belong next to a keyboard shortcut,
	 * and the assistant ones only appear when that assistant is installed, as in the toolbar.
	 */
	private _pageRows(): Row[] {
		const rows: Row[] = [{
			label: vscode.l10n.t("Pick an element"),
			description: vscode.l10n.t("to the clipboard"),
			icon: new vscode.ThemeIcon('inspect'),
			command: 'tabBrowser.copyElement',
		}];

		if (isInstalled('claude')) {
			rows.push({
				label: vscode.l10n.t("Pick an element"),
				description: vscode.l10n.t("to {0}", assistantName('claude')),
				icon: new vscode.ThemeIcon('inspect'),
				command: 'tabBrowser.addElementToClaude',
			});
		}
		if (isInstalled('codex')) {
			rows.push({
				label: vscode.l10n.t("Pick an element"),
				description: vscode.l10n.t("to {0}", assistantName('codex')),
				icon: new vscode.ThemeIcon('inspect'),
				command: 'tabBrowser.addElementToCodex',
			});
		}

		rows.push({
			label: vscode.l10n.t("Console output"),
			description: vscode.l10n.t("to the clipboard"),
			icon: new vscode.ThemeIcon('terminal'),
			command: 'tabBrowser.copyConsole',
		});
		if (isInstalled('claude')) {
			rows.push({
				label: vscode.l10n.t("Console output"),
				description: vscode.l10n.t("to {0}", assistantName('claude')),
				icon: new vscode.ThemeIcon('terminal'),
				command: 'tabBrowser.addConsoleToClaude',
			});
		}
		if (isInstalled('codex')) {
			rows.push({
				label: vscode.l10n.t("Console output"),
				description: vscode.l10n.t("to {0}", assistantName('codex')),
				icon: new vscode.ThemeIcon('terminal'),
				command: 'tabBrowser.addConsoleToCodex',
			});
		}

		return rows;
	}

	/**
	 * The connect entries stay whatever the server is doing: they explain what is missing, and
	 * they are not gated on an installed extension either — both clients also run as a cli,
	 * with no extension in this window at all.
	 */
	private _mcpRows(): Row[] {
		const state = this._mcpState();

		return [
			this._mcpStatusRow(state),
			{
				label: vscode.l10n.t("Connect Claude Code"),
				icon: new vscode.ThemeIcon('plug'),
				command: 'tabBrowser.connectMcpToClaudeCode',
			},
			{
				label: vscode.l10n.t("Connect Codex"),
				icon: new vscode.ThemeIcon('plug'),
				command: 'tabBrowser.connectMcpToCodex',
			},
			{
				label: vscode.l10n.t("Check connection"),
				icon: new vscode.ThemeIcon('pulse'),
				command: 'tabBrowser.checkMcp',
			},
			...(state.kind === 'running' ? [{
				label: vscode.l10n.t("Copy server url"),
				icon: new vscode.ThemeIcon('link'),
				command: 'tabBrowser.copyMcpUrl',
			}] : []),
		];
	}

	private _mcpStatusRow(state: McpState): Row {
		const dot = (color: string) => new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(color));

		switch (state.kind) {
			case 'running':
				return {
					label: vscode.l10n.t("Running"),
					description: state.server.url?.replace(/^https?:\/\//, ''),
					tooltip: vscode.l10n.t("{0}\n\nLoopback only, and every request needs this window's token.", state.server.url ?? ''),
					icon: dot('charts.green'),
					command: 'tabBrowser.checkMcp',
				};
			case 'starting':
				return { label: vscode.l10n.t("Starting…"), icon: new vscode.ThemeIcon('loading~spin') };
			case 'disabled':
				return {
					label: vscode.l10n.t("Turned off"),
					description: 'tabBrowser.mcp.enabled',
					icon: new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground')),
					command: 'tabBrowser.openSettings',
				};
			case 'failed':
				return {
					label: vscode.l10n.t("Could not start"),
					description: state.error,
					tooltip: state.error,
					icon: dot('charts.red'),
					command: 'tabBrowser.checkMcp',
				};
		}
	}

	private _recentUrls(): string[] {
		return this._recent.all().slice(0, maxRecentRows);
	}
}

/** `http://localhost:3000/a/b` -> `localhost:3000/a/b`, which is what a row has room for. */
function shorten(url: string): string {
	if (/^file:/i.test(url)) {
		// A file's own path, shortened against the project it belongs to; `asRelativePath`
		// hands back the absolute one for a file that belongs to none.
		try {
			return vscode.workspace.asRelativePath(vscode.Uri.parse(url), false);
		} catch {
			return url.replace(/^file:\/\//, '');
		}
	}
	return url.replace(/^https?:\/\//, '').replace(/\/$/, '') || url;
}
