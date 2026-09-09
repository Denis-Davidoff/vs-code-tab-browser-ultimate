/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/*
 * Confirmations go to the status bar, never to a notification.
 *
 * This is not a matter of taste. The built-in browser is a *native* view laid
 * over the workbench, so anything that has to paint on top of it forces the
 * editor to take the live page away: `_refreshOverlayObscured` in
 * `browserViewEditor` asks the overlay manager for anything overlapping the
 * browser container, and on the first hit it swaps the running page for a
 * screenshot. When one of those overlays is a notification toast it also puts
 * up "Paused due to Notification — Dismiss the notification to continue using
 * the browser."
 *
 * Our confirmations fire at exactly the wrong moment: the user has just clicked
 * an element, so the browser tab is focused, and the toast lands in the corner
 * on top of it. Every successful pick therefore froze the page and demanded a
 * dismissal — reported as "a Pause dialog appears whenever I select an
 * element", which reads like a bug in the picker and is really our toast.
 *
 * The status bar is part of the workbench layout rather than an overlay, so it
 * never triggers any of that. A notification is now reserved for something the
 * user has to know about or act on: a refusal, a fallback, a choice.
 */

/** How long a confirmation stays in the status bar. */
const confirmationMs = 6000;

/** A refusal is worth a longer look than a confirmation. */
const refusalMs = 10000;

/**
 * Reports that something succeeded, without covering the page.
 *
 * Codicons render here, so callers may prefix `$(check)` and friends.
 */
export function confirm(message: string): void {
	vscode.window.setStatusBarMessage(`$(check) ${message}`, confirmationMs);
}

/**
 * Reports a refusal that the status bar already offers a fix for.
 *
 * Most refusals are worth a notification — they need attention. This one is
 * not: it fires when a command is pressed while the browser API is off, and in
 * exactly that state the `Enable Browser API` button is already sitting in the
 * status bar. A toast would add nothing except a paused page, which is how the
 * "Paused due to Notification" dialog kept appearing even after the progress
 * notification was gone.
 */
export function refuse(message: string): void {
	vscode.window.setStatusBarMessage(`$(alert) ${message}`, refusalMs);
}
