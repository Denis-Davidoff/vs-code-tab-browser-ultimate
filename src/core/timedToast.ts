import * as vscode from 'vscode';
import { plainInLabel, plainInNotification } from './notifyText';

/** A native notification with an explicit lifetime; ordinary information messages have no dismiss handle. */
export function timedInformation(message: string): void {
	try {
		const notification = vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: plainInNotification(plainInLabel(message, 240), 240),
			// Cancellable only so the toast gets a button that closes it: a native toast cannot be
			// moved, and in the bottom right corner it covers the chat's Branches button.
			cancellable: true,
		}, (progress, token) => {
			// This announces completed work. The task lifetime controls when VS Code removes the toast.
			progress.report({ increment: 100 });
			return new Promise<void>(resolve => {
				// Whichever ends it first lets go of the other: the timer, or the close button's listener.
				let listener: { dispose(): void } | undefined;
				const timer = setTimeout(() => { listener?.dispose(); resolve(); }, 10_000);
				listener = token?.onCancellationRequested?.(() => { clearTimeout(timer); listener?.dispose(); resolve(); });
			});
		});
		// Notification delivery must never turn a successful operation into a reported failure.
		void Promise.resolve(notification).catch(() => undefined);
	} catch { /* The editor may already be shutting down. */ }
}
