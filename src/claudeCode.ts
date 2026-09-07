/*---------------------------------------------------------------------------------------------
 *  Hands an element report to the Claude Code extension.
 *
 *  Claude Code exposes no api for this. What it does have is `claude-vscode.insertAtMention`,
 *  which takes no arguments: it reads the active editor and puts `@<relative path>` into the
 *  prompt box, opening the chat first if none is showing. So the report is written into the
 *  workspace, opened, mentioned, and its editor closed again.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

const extensionId = 'Anthropic.claude-code';
const insertAtMentionCommand = 'claude-vscode.insertAtMention';

/** Where the reports go, relative to the workspace folder. */
const reportDirectory = ['.claude', 'tab-browser'];

/** Reports older than this are removed the next time one is written. */
const keepReportsFor = 24 * 60 * 60 * 1000;

export async function isAvailable(): Promise<boolean> {
	if (!vscode.extensions.getExtension(extensionId)) {
		return false;
	}
	// The extension may be installed but too old for the command.
	return (await vscode.commands.getCommands(true)).includes(insertAtMentionCommand);
}

/**
 * Writes `text` into the workspace and puts an `@`-mention of it into Claude Code's prompt.
 * Returns the file it wrote, or `undefined` when there is nowhere to write it.
 */
export async function mentionReport(text: string, fileName: string): Promise<vscode.Uri | undefined> {
	const file = await writeReport(text, fileName);
	if (!file) {
		return undefined;
	}

	// The mention is built from whatever editor is active, so the report has to be it.
	const document = await vscode.workspace.openTextDocument(file);
	await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
	await vscode.commands.executeCommand(insertAtMentionCommand);

	// Inserting reveals the chat, which may now hold the active tab: close this one by name
	// rather than closing whatever ended up in front.
	await closeTab(file);

	return file;
}

/**
 * The report has to live in the workspace: Claude Code mentions files by their path relative
 * to it.
 */
async function writeReport(text: string, fileName: string): Promise<vscode.Uri | undefined> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder || folder.uri.scheme !== 'file') {
		return undefined;
	}

	const directory = path.join(folder.uri.fsPath, ...reportDirectory);
	await fs.mkdir(directory, { recursive: true });
	await keepOutOfGit(directory);
	await pruneOldReports(directory);

	const file = path.join(directory, fileName);
	await fs.writeFile(file, text, 'utf8');
	return vscode.Uri.file(file);
}

/** These are scratch files for one conversation; they have no business in a commit. */
async function keepOutOfGit(directory: string): Promise<void> {
	const file = path.join(directory, '.gitignore');
	try {
		await fs.access(file);
	} catch {
		await fs.writeFile(file, '*\n', 'utf8');
	}
}

async function pruneOldReports(directory: string): Promise<void> {
	try {
		const cutoff = Date.now() - keepReportsFor;
		for (const entry of await fs.readdir(directory)) {
			if (entry === '.gitignore') {
				continue;
			}
			const file = path.join(directory, entry);
			const stat = await fs.stat(file);
			if (stat.mtimeMs < cutoff) {
				await fs.rm(file, { force: true });
			}
		}
	} catch {
		// Housekeeping only.
	}
}

async function closeTab(file: vscode.Uri): Promise<void> {
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			const input = tab.input as { uri?: vscode.Uri } | undefined;
			if (input?.uri?.toString() === file.toString()) {
				await vscode.window.tabGroups.close(tab, true);
				return;
			}
		}
	}
}
