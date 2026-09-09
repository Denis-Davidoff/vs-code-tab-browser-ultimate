/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BrowserController } from './browserController';
import { confirm } from './notify';
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
		try {
			({ png, clipped } = await browser.capture(fullPage));
		} catch (err) {
			vscode.window.showErrorMessage(vscode.l10n.t(
				"Could not capture the page: {0}", err instanceof Error ? err.message : String(err)));
			return;
		}

		const delivery = await copyImage(png, screenshotFileName(browser.activeUrl, fullPage));

		if (delivery.kind === 'clipboard') {
			confirm(clipped
				? vscode.l10n.t("Screenshot copied, cut off at 16384 px — the page is taller than one image can hold.")
				: vscode.l10n.t("Screenshot copied to the clipboard."));
			return;
		}

		const reveal = vscode.l10n.t("Open");
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t("Screenshot saved — it could not reach the clipboard ({0}).", delivery.reason),
			reveal);
		if (choice === reveal) {
			await vscode.commands.executeCommand('vscode.open', delivery.file);
		}
	});
}
