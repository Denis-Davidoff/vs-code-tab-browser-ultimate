/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

interface Tool {
	readonly label: string;
	readonly description: string;
	readonly icon: string;
	readonly command: string;
}

/**
 * The extension's activity bar panel: a flat list of element actions.
 *
 * A tree view rather than a webview on purpose — three static rows need no
 * custom rendering, and a tree gets VS Code's theming, keyboard navigation and
 * accessibility for free, with no CSP or bundling to think about.
 */
export class ToolsViewProvider implements vscode.TreeDataProvider<Tool> {

	public static readonly viewId = 'aiBrowser.tools';

	private readonly tools: readonly Tool[] = [
		{
			label: vscode.l10n.t("Copy Element"),
			description: vscode.l10n.t("Full context as Markdown"),
			icon: 'inspect',
			command: 'aiBrowser.copyElement',
		},
		{
			label: vscode.l10n.t("Copy XPath"),
			description: vscode.l10n.t("Anchored on a unique id"),
			icon: 'symbol-key',
			command: 'aiBrowser.copyElementXPath',
		},
		{
			label: vscode.l10n.t("Copy CSS Path"),
			description: vscode.l10n.t("Selector with :nth-of-type"),
			icon: 'symbol-color',
			command: 'aiBrowser.copyElementCssPath',
		},
	];

	public getChildren(element?: Tool): Tool[] {
		return element ? [] : [...this.tools];
	}

	public getTreeItem(tool: Tool): vscode.TreeItem {
		const item = new vscode.TreeItem(tool.label, vscode.TreeItemCollapsibleState.None);
		item.description = tool.description;
		item.iconPath = new vscode.ThemeIcon(tool.icon);
		item.tooltip = vscode.l10n.t("{0} — pick an element in the integrated browser", tool.label);
		item.command = { command: tool.command, title: tool.label };
		return item;
	}
}
