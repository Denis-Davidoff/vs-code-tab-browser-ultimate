/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { isBrowserApiGranted } from '../setup/proposedApi';
import { chrome, ChromeTab } from './chromeBrowser';

/**
 * Every browser tab the tools can act on: the built-in browser's (behind the
 * `browser` grant) and Google Chrome's (once connected). Shaped like the
 * `vscode.window` members it replaces, so callers change one word.
 *
 * Active is the focused built-in browser tab only. Chrome reports no focus
 * over CDP, and a Chrome tab standing in as "active" outranked the built-in
 * tab the user last had in front for every later call. `onDidChangeActive`
 * still fires for a Chrome tab opened through us, so a listener can record it
 * as the tab the user last turned to.
 */
function vscodeTabs(): readonly vscode.BrowserTab[] {
	if (!isBrowserApiGranted()) { return []; }
	try { return vscode.window.browserTabs ?? []; } catch { return []; }
}

function vscodeActive(): vscode.BrowserTab | undefined {
	if (!isBrowserApiGranted()) { return undefined; }
	try { return vscode.window.activeBrowserTab; } catch { return undefined; }
}

function vscodeEvent<T>(read: () => vscode.Event<T>): vscode.Event<T> {
	return (listener, thisArg, disposables) => {
		if (!isBrowserApiGranted()) { return new vscode.Disposable(() => undefined); }
		try { return read()(listener, thisArg, disposables); } catch { return new vscode.Disposable(() => undefined); }
	};
}

const focusGroupCommands = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth']
	.map(n => `workbench.action.focus${n}EditorGroup`);

/**
 * Shows a built-in browser tab's editor. `window.tabGroups` models no browser
 * input, so a browser editor is a tab with `input === undefined`, matched by
 * its label against the page title (`BrowserTab.title` may carry ` (<url>)`
 * after it, #147). The group is focused by position, then the editor by index.
 */
async function revealVscodeTab(tab: vscode.BrowserTab): Promise<boolean> {
	const title = tab.title ?? '';
	const matches = (label: string) => !!label && (label === title || title.startsWith(`${label} (`));
	const groups = vscode.window.tabGroups.all;
	for (let g = 0; g < groups.length; g++) {
		const index = groups[g].tabs.findIndex(t => t.input === undefined && matches(t.label));
		if (index < 0) { continue; }
		const focus = focusGroupCommands[g];
		if (!focus) { return false; }
		await vscode.commands.executeCommand(focus);
		await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', index);
		return true;
	}
	return false;
}

function merged<T>(...events: vscode.Event<T>[]): vscode.Event<T> {
	return (listener, thisArg, disposables) => {
		const parts = events.map(event => event(listener, thisArg));
		const all = vscode.Disposable.from(...parts);
		disposables?.push(all);
		return all;
	};
}

export const tabs = {
	/** Whether any browser can be driven: the grant, or a connected Chrome. */
	available(): boolean {
		return isBrowserApiGranted() || chrome.connected;
	},
	get all(): readonly vscode.BrowserTab[] {
		return [...vscodeTabs(), ...chrome.tabs];
	},
	get active(): vscode.BrowserTab | undefined {
		return vscodeActive();
	},
	isChrome(tab: vscode.BrowserTab | undefined): tab is ChromeTab {
		return tab instanceof ChromeTab;
	},
	onDidOpen: merged<vscode.BrowserTab>(vscodeEvent(() => vscode.window.onDidOpenBrowserTab), chrome.onDidOpenTab),
	onDidClose: merged<vscode.BrowserTab>(vscodeEvent(() => vscode.window.onDidCloseBrowserTab), chrome.onDidCloseTab),
	onDidChangeActive: merged<vscode.BrowserTab | undefined>(vscodeEvent(() => vscode.window.onDidChangeActiveBrowserTab), chrome.onDidChangeActiveTab),
	onDidChangeState: merged<vscode.BrowserTab>(vscodeEvent(() => vscode.window.onDidChangeBrowserTabState), chrome.onDidChangeTabState),
	/**
	 * Opens a page. `chrome` when the caller says so, or when the built-in
	 * browser is not available and Chrome is connected.
	 */
	/**
	 * Brings an open tab forward. Chrome through `Target.activateTarget`; the
	 * built-in browser through its editor tab, since its CDP proxy has no
	 * `Page.bringToFront` (answers -32601) and the proposal has no `show()`.
	 * Answers whether it found the tab to show.
	 */
	async reveal(tab: vscode.BrowserTab): Promise<boolean> {
		if (tab instanceof ChromeTab) { await chrome.activateTab(tab); return true; }
		return revealVscodeTab(tab);
	},
	async open(url: string, options: { preserveFocus?: boolean; where?: 'vscode' | 'chrome' } = {}): Promise<vscode.BrowserTab> {
		const where = options.where ?? (isBrowserApiGranted() ? 'vscode' : 'chrome');
		if (where === 'chrome') { return chrome.openTab(url); }
		return vscode.window.openBrowserTab(url, { preserveFocus: options.preserveFocus });
	},
};
