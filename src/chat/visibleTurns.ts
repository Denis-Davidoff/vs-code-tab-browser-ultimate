import * as vscode from 'vscode';
import { remotePromptsStep } from './core/entryWindow';

/**
 * `aiBrowser.chat.visibleTurns`: how many of the user's turns a chat view is sent at first, and
 * how many more each "Show earlier messages" adds — in VS Code, Chrome and on the website. Read
 * every time; anything but a whole number from 5 to 200 is the default.
 */
export function visibleTurns(): number {
	const value = vscode.workspace.getConfiguration('aiBrowser.chat').get<unknown>('visibleTurns');
	return typeof value === 'number' && Number.isInteger(value) && value >= 5 && value <= 200 ? value : remotePromptsStep;
}
