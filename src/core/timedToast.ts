import * as vscode from 'vscode';
import { plainInLabel, plainInNotification } from './notifyText';

/** A native notification with an explicit lifetime; ordinary information messages have no dismiss handle. */
export function timedInformation(message: string): void {
	try {
		const notification = vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: plainInNotification(plainInLabel(message, 240), 240),
			cancellable: false,
		}, progress => {
			// This announces completed work. The task lifetime controls when VS Code removes the toast.
			progress.report({ increment: 100 });
			return new Promise<void>(resolve => setTimeout(resolve, 10_000));
		});
		// Notification delivery must never turn a successful operation into a reported failure.
		void Promise.resolve(notification).catch(() => undefined);
	} catch { /* The editor may already be shutting down. */ }
}
