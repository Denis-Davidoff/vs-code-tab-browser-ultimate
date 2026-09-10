/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { BrowserController, ShareState } from './browserController';
import { inUseMarker, sharedMarker, stripMarker } from './shareIndicator';
import {
	browserApiState, integratedBrowserCommand, onDidChangeGrantState,
	shouldUseIntegratedBrowser, type BrowserApiState,
} from './proposedApi';

/*
 * Two status bar items, with different jobs.
 *
 *   - `AI Browser` is permanent and opens a menu. Everything the extension can
 *     do from outside a browser tab lives there, which is not decoration: the
 *     dropdown on the tab is gated on `activeEditor == 'workbench.editor.browser'`,
 *     so before this the MCP commands had no home but the command palette.
 *   - `Enable Browser API` appears only while that is the one thing standing
 *     between the user and every browser feature, and hides itself the moment
 *     it is not. It carries a warning background, which is the only attention
 *     mechanism the API actually offers (see `pulse`).
 */

/** Highest of the left-hand items, so it does not drift behind language tools. */
const priority = 1000;

export function registerStatusBar(context: vscode.ExtensionContext, controller: BrowserController): void {
	const item = vscode.window.createStatusBarItem(
		'aiBrowser.status', vscode.StatusBarAlignment.Left, priority);
	item.name = vscode.l10n.t("AI Browser");
	item.command = menuCommand;
	item.show();
	context.subscriptions.push(item);

	// The share is the one piece of state this item carries, because it is the
	// one piece a user can lose track of: an assistant driving a tab in the
	// background looks exactly like an assistant doing nothing.
	const applyShare = () => applyShareState(item, controller.share);
	applyShare();
	context.subscriptions.push(controller.onDidChangeShare(applyShare));

	const enable = vscode.window.createStatusBarItem(
		'aiBrowser.enableApi', vscode.StatusBarAlignment.Left, priority - 1);
	enable.name = vscode.l10n.t("AI Browser: browser API");
	enable.command = 'aiBrowser.enableBrowserApi';
	context.subscriptions.push(enable);

	let pulsed = false;
	const refresh = async () => {
		const state = await browserApiState();
		applyState(enable, state);
		if (state === 'grantMissing' && !pulsed) {
			pulsed = true;
			context.subscriptions.push(pulse(enable));
		}
	};

	void refresh();
	// The only thing that moves this within a session is our own write.
	context.subscriptions.push(onDidChangeGrantState(() => void refresh()));
	context.subscriptions.push(vscode.commands.registerCommand(menuCommand,
		() => showMenu(controller)));
}

/**
 * Shows the item only while it has something actionable to say.
 *
 * The `unsupported` case is explained in the menu instead — see `showMenu`.
 *
 * `granted` hides it — a permanent badge for a solved problem is noise. So does
 * `unsupported`: on Cursor the button could never do anything but apologise,
 * and it would say so in every window forever. That case is reachable from the
 * menu, where the user went looking for it.
 */
function applyState(item: vscode.StatusBarItem, state: BrowserApiState): void {
	if (state === 'grantMissing') {
		item.text = '$(alert) Enable Browser API';
		item.tooltip = new vscode.MarkdownString(vscode.l10n.t(
			"**The integrated browser API is off.**\n\nElement tools, screenshots and the MCP browser tools need it. Click to add this extension to `argv.json` — then quit and reopen the editor."));
		item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		item.show();
		return;
	}
	if (state === 'awaitingRestart') {
		item.text = '$(debug-restart) Restart to finish';
		item.tooltip = new vscode.MarkdownString(vscode.l10n.t(
			"**`argv.json` is set, this window is not.**\n\nIt is read when the process starts, so the editor has to be fully quit and reopened — Reload Window is not enough."));
		item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		item.show();
		return;
	}
	item.hide();
}

/**
 * The permanent item, carrying the share state.
 *
 * The marker is the same emoji that sits on the shared tab itself, so the two
 * read as one thing rather than as two indicators that happen to agree.
 *
 * `lost` is the only state that takes a background. It is not decoration: the
 * assistants are paused until the user acts, so this is precisely the case the
 * warning colour exists for — and the only two colours the API accepts are
 * `warningBackground` and `errorBackground`, per the `.d.ts`. Red would say
 * something broke, and nothing did.
 */
function applyShareState(item: vscode.StatusBarItem, share: ShareState): void {
	if (share.state === 'lost') {
		item.text = `$(globe) AI Browser $(debug-pause)`;
		item.tooltip = new vscode.MarkdownString(vscode.l10n.t(
			"**The shared tab was closed, so the browser tools are paused.**\n\nThey will not fall back to another page on their own — share a tab again, or stop sharing to let the assistants follow whichever tab is in front of you."));
		item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		return;
	}

	item.backgroundColor = undefined;

	if (share.state === 'shared') {
		const used = share.usedBy.length > 0;
		item.text = `$(globe) AI Browser ${used ? inUseMarker : sharedMarker}`;
		const who = share.usedBy.map(assistantName).join(', ');
		item.tooltip = new vscode.MarkdownString([
			vscode.l10n.t("**Shared with assistants**"),
			`\n\n${share.title || share.url || ''}`,
			'\n\n',
			used
				? vscode.l10n.t("Driven by {0}. The browser tools act on this tab only.", who)
				: vscode.l10n.t("No assistant has used it yet. If one reports no `browser_` tools, it has to be restarted to load them."),
		].join(''));
		return;
	}

	item.text = '$(globe) AI Browser';
	item.tooltip = vscode.l10n.t("AI Browser — open a page, connect an assistant");
}

function assistantName(kind: string): string {
	return kind === 'claude' ? 'Claude Code' : kind === 'codex' ? 'Codex' : vscode.l10n.t("another assistant");
}

/**
 * Blinks the item a few times, then leaves it steady, and never again.
 *
 * The API supports exactly two backgrounds — `statusBarItem.errorBackground`
 * and `statusBarItem.warningBackground`, per the `.d.ts` — and no animation at
 * all. The one animation primitive anywhere near this is the `~spin` codicon
 * modifier, and it is the wrong word: a spinner means "working", so a spinning
 * alert reads as a hung extension rather than an invitation.
 *
 * So the animation is the background going on and off. Deliberately slow —
 * three blinks at 700ms a phase, about 0.7Hz — because a status bar is
 * peripheral vision and anything faster is a flashing-content problem rather
 * than a hint. It stops on its own; a permanently blinking button is the kind
 * of thing people disable the extension over.
 */
function pulse(item: vscode.StatusBarItem): vscode.Disposable {
	const warning = new vscode.ThemeColor('statusBarItem.warningBackground');
	const phases = 6;
	let phase = 0;
	const timer = setInterval(() => {
		if (++phase >= phases) {
			// Land on, in one assignment: setting it off and then straight back
			// on within a tick is a flicker the renderer is free to show.
			clearInterval(timer);
			item.backgroundColor = warning;
			return;
		}
		item.backgroundColor = phase % 2 === 0 ? warning : undefined;
	}, 700);
	return new vscode.Disposable(() => clearInterval(timer));
}

const menuCommand = 'aiBrowser.statusMenu';

interface MenuItem extends vscode.QuickPickItem {
	readonly run?: () => Thenable<unknown>;
}

/**
 * The dropdown behind the permanent item.
 *
 * Built fresh on each click, because half of what belongs in it depends on the
 * grant and on whether a browser tab is open. It deliberately does not mirror
 * the tab's dropdown: the element and screenshot commands are one click away
 * whenever a tab is focused, and a second copy here would be a longer menu
 * saying the same thing.
 */
async function showMenu(controller: BrowserController): Promise<void> {
	const state = await browserApiState();
	const items: MenuItem[] = [];

	// Read before the QuickPick is shown: a focused browser tab is what "share
	// this tab" means, and clicking the status bar does not move focus.
	const focused = controller.focusedTab;
	const share = controller.share;

	items.push({ label: vscode.l10n.t("Open"), kind: vscode.QuickPickItemKind.Separator });
	items.push({
		label: vscode.l10n.t("$(link) Open URL…"),
		detail: vscode.l10n.t("Type or paste an address"),
		run: () => openUrl(),
	});
	if (await shouldUseIntegratedBrowser()) {
		// Only offered when the built-in browser will take it. The webview panel
		// cannot show a local file at all — its `localResourceRoots` is `media/`
		// and the page lives in a cross-origin iframe, so a `file:` URL there is
		// a blank panel with no error.
		items.push({
			label: vscode.l10n.t("$(file) Open File…"),
			detail: vscode.l10n.t("Preview a local HTML file"),
			run: () => openFile(),
		});
	}

	if (state !== 'granted') {
		items.push({ label: vscode.l10n.t("Setup"), kind: vscode.QuickPickItemKind.Separator });
		items.push({
			label: state === 'grantMissing'
				? vscode.l10n.t("$(alert) Enable Browser API")
				: state === 'awaitingRestart'
					? vscode.l10n.t("$(debug-restart) Restart to finish enabling the API")
					// An editor that cannot ever provide the API still owes the
					// user a reason. The warning item stays hidden here — it
					// would apologise in every window forever — but this menu
					// is opened deliberately, so the explanation belongs in it.
					// Without it the experience is "nothing works and nothing
					// says why", which is how Trae was reported.
					: vscode.l10n.t("$(circle-slash) Why are the browser tools unavailable?"),
			detail: vscode.l10n.t("Element tools, screenshots and the MCP browser tools need the browser API"),
			run: () => vscode.commands.executeCommand('aiBrowser.enableBrowserApi'),
		});
	}

	// Sharing sits above the connect entries because it is the per-page half of
	// the same job: Connect attaches an assistant to this window once, sharing
	// says which page inside it to work on.
	if (share.state !== 'none' || focused) {
		items.push({ label: vscode.l10n.t("Shared tab"), kind: vscode.QuickPickItemKind.Separator });
	}
	if (share.state === 'shared') {
		items.push({
			label: vscode.l10n.t("$(circle-slash) Stop sharing"),
			description: share.title || share.url,
			detail: share.usedBy.length > 0
				? vscode.l10n.t("Assistants act on this tab only — {0} has used it", share.usedBy.map(assistantName).join(', '))
				: vscode.l10n.t("Assistants act on this tab only — none has used it yet"),
			run: () => vscode.commands.executeCommand('aiBrowser.stopSharingTab'),
		});
	}
	if (share.state === 'lost') {
		items.push({
			label: vscode.l10n.t("$(debug-pause) Sharing paused — the shared tab was closed"),
			detail: vscode.l10n.t("Pick this to let the assistants follow whichever tab is in front of you again"),
			run: () => vscode.commands.executeCommand('aiBrowser.stopSharingTab'),
		});
	}
	if (focused && focused !== controller.sharedTab) {
		items.push({
			label: share.state === 'shared'
				? vscode.l10n.t("$(link) Share this tab instead")
				: vscode.l10n.t("$(link) Share this tab with assistants"),
			// Stripped like every other title we show: a tab that was shared a
			// moment ago can still be carrying the suffix if the page could not
			// be reached when sharing stopped.
			description: stripMarker(focused.title) || focused.url,
			detail: vscode.l10n.t("The browser tools then act on this tab only, whatever else you open"),
			run: () => vscode.commands.executeCommand('aiBrowser.shareTab'),
		});
	}

	items.push({ label: vscode.l10n.t("Assistants"), kind: vscode.QuickPickItemKind.Separator });
	items.push({
		label: vscode.l10n.t("$(comment-discussion) Connect Claude Code"),
		run: () => vscode.commands.executeCommand('aiBrowser.connectClaudeCode'),
	});
	items.push({
		label: vscode.l10n.t("$(comment-discussion) Connect Codex"),
		run: () => vscode.commands.executeCommand('aiBrowser.connectCodex'),
	});
	items.push({
		label: vscode.l10n.t("$(pulse) Check Connection"),
		run: () => vscode.commands.executeCommand('aiBrowser.checkMcpConnection'),
	});

	items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
	items.push({
		label: vscode.l10n.t("$(gear) Settings"),
		run: () => vscode.commands.executeCommand(
			'workbench.action.openSettings', '@ext:DenysDavydov.tab-browser-ultimate'),
	});

	const picked = await vscode.window.showQuickPick(items, {
		title: vscode.l10n.t("AI Browser"),
		placeHolder: vscode.l10n.t("Pick an action"),
	});
	await picked?.run?.();
}

/**
 * Asks for an address, then opens it.
 *
 * The prompt is ours rather than `aiBrowser.show`'s own: that command only
 * prompts on the panel path, and hands `undefined` straight to
 * `workbench.action.browser.open` on the integrated one. Asking here is what
 * makes the menu entry mean the same thing on every host.
 */
async function openUrl(): Promise<void> {
	const url = await vscode.window.showInputBox({
		title: vscode.l10n.t("AI Browser"),
		placeHolder: vscode.l10n.t("https://example.com"),
		prompt: vscode.l10n.t("Enter url to visit"),
	});
	if (url) {
		await vscode.commands.executeCommand('aiBrowser.show', url);
	}
}

/**
 * Opens a local file in the built-in browser.
 *
 * Reached only when `shouldUseIntegratedBrowser()` said yes, so the browser is
 * there to take it. Its own picker is preferred — it knows how it wants to
 * serve a `file:` page — and our dialog covers a host that has the browser but
 * not that particular command.
 *
 * There is deliberately **no panel fallback**. Handing a `file:` URI to the
 * panel produced a blank page and no error, which is worse than the entry not
 * being in the menu.
 */
async function openFile(): Promise<void> {
	const commands = await vscode.commands.getCommands(true);
	if (commands.includes('workbench.action.browser.openFile')) {
		await vscode.commands.executeCommand('workbench.action.browser.openFile');
		return;
	}
	const picked = await vscode.window.showOpenDialog({
		canSelectMany: false,
		openLabel: vscode.l10n.t("Open in AI Browser"),
		filters: { [vscode.l10n.t("Web pages")]: ['html', 'htm', 'svg', 'pdf'] },
	});
	const file = picked?.[0];
	if (file) {
		await vscode.commands.executeCommand(
			integratedBrowserCommand, file.toString(true));
	}
}
