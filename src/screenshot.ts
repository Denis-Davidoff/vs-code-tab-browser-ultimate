/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BrowserController } from './browserController';
import { confirm, refuse } from './notify';
import { copyImage, screenshotFileName } from './clipboardImage';

/**
 * Captures the page and puts it on the clipboard.
 *
 * Capturing is the easy half — one CDP call. The clipboard is the hard half: the
 * extension API has no image clipboard, so [clipboardImage.ts](clipboardImage.ts)
 * shells out to the platform, and the PNG is written to a file either way so a
 * failure still leaves something behind.
 */
export async function copyScreenshot(
	browser: BrowserController,
	fullPage: boolean,
): Promise<void> {

	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Window,
		title: fullPage
			? vscode.l10n.t("Capturing the whole page…")
			: vscode.l10n.t("Capturing the page…"),
	}, async () => {
		let png: Buffer;
		let clipped: boolean;
		let url: string | undefined;
		try {
			// The tab the user is looking at, whatever any assistant has been
			// given over MCP — this is a button they pressed themselves. No
			// caller, which is what tells the controller the same thing.
			({ png, clipped, url } = await browser.capture(fullPage, browser.focusedTab));
		} catch (err) {
			// The status bar, never a toast: the page just captured is on screen,
			// and a notification over it pauses it (breaks-silently #10).
			refuse(vscode.l10n.t(
				"Could not capture the page: {0}", err instanceof Error ? err.message : String(err)));
			return;
		}

		const delivery = await copyImage(png, screenshotFileName(url, fullPage));

		if (delivery.kind === 'clipboard') {
			confirm(clipped
				? vscode.l10n.t("Screenshot copied, cut off at 16384 px — the page is taller than one image can hold.")
				: vscode.l10n.t("Screenshot copied to the clipboard."));
			return;
		}

		// Not a toast either, and this is the common fallback rather than a rare
		// one — every copy on a Linux box without xclip or wl-copy lands here —
		// so a notification would pause the page on every press.
		if (vscode.env.remoteName || vscode.env.uiKind !== vscode.UIKind.Desktop) {
			// **A path is useless here**: the file is on the remote host and the
			// text clipboard is the user's local one, so putting the path there
			// overwrote whatever they had copied with something nothing local
			// can open. This is also the case that *always* falls back. So the
			// image is shown instead, through the remote file system — what the
			// old "Open" button did — beside the page rather than over it, and
			// without taking focus from it.
			await vscode.commands.executeCommand('vscode.open', delivery.file,
				{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true, preview: true });
			refuse(vscode.l10n.t(
				"Screenshot opened beside the page — the clipboard belongs to another machine in a remote or web window."));
			return;
		}

		// Locally the text clipboard still works when the image one does not,
		// so the file's path goes there in place of the "Open" button.
		await vscode.env.clipboard.writeText(delivery.file.fsPath);
		refuse(vscode.l10n.t(
			"Screenshot saved to {0} (path copied) — it could not reach the clipboard as an image: {1}",
			delivery.file.fsPath, delivery.reason));
	});
}
