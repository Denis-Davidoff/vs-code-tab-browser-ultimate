/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Handing a report to Claude Code or Codex.
 *
 * Neither extension exposes an API. Both are driven through commands they
 * register, and the two are built differently enough that there is no shared
 * path: Claude Code's command takes no arguments and reads the *active editor*,
 * while Codex's takes a URI. Every command id below is an implementation detail
 * of somebody else's extension, not a contract — hence the availability check
 * before each call and a clipboard fallback on any failure.
 */

export type AssistantId = 'claude' | 'codex';

interface Assistant {
	readonly name: string;
	readonly extensionId: string;
	readonly command: string;
	/**
	 * Where this assistant's reports have to live.
	 *
	 * Claude Code addresses a file by its path relative to the workspace, so the
	 * file must be inside it. Codex stores an absolute path, so its reports go to
	 * the temp directory and never touch the project.
	 */
	readonly reportsIn: 'workspace' | 'tempDirectory';
}

const assistants: Record<AssistantId, Assistant> = {
	claude: {
		name: 'Claude Code',
		extensionId: 'Anthropic.claude-code',
		command: 'claude-vscode.insertAtMention',
		reportsIn: 'workspace',
	},
	codex: {
		name: 'Codex',
		extensionId: 'openai.chatgpt',
		command: 'chatgpt.addFileToThread',
		reportsIn: 'tempDirectory',
	},
};

export function assistantName(id: AssistantId): string {
	return assistants[id].name;
}

/* ------------------------------------------------------------- availability */

/** Synchronous, so a menu can be built from it. */
export function isInstalled(id: AssistantId): boolean {
	return !!vscode.extensions.getExtension(assistants[id].extensionId);
}

/**
 * Installed *and* the command exists.
 *
 * An older version of either extension may not register the command we use, and
 * calling a missing command throws rather than degrading.
 */
async function isAvailable(id: AssistantId): Promise<boolean> {
	if (!isInstalled(id)) {
		return false;
	}
	const commands = await vscode.commands.getCommands(true);
	return commands.includes(assistants[id].command);
}

/**
 * Publishes installation state as context keys, for `when` clauses on menu
 * items. Re-published when the set of extensions changes.
 */
export function publishAssistantContext(): void {
	for (const id of Object.keys(assistants) as AssistantId[]) {
		vscode.commands.executeCommand('setContext', `aiBrowser.${id}Installed`, isInstalled(id));
	}
}

/* ------------------------------------------------------------------ reports */

/** Reports are drafts for one conversation; they are swept after this long. */
const keepReportsFor = 5 * 60 * 60 * 1000;
const pruneInterval = 60 * 60 * 1000;

let lastPrune = 0;

function reportDirectory(reportsIn: Assistant['reportsIn'], folder: vscode.WorkspaceFolder | undefined): string {
	return reportsIn === 'workspace'
		? path.join(folder!.uri.fsPath, '.ai-browser')
		: path.join(os.tmpdir(), 'ai-browser', 'reports');
}

/**
 * Drops a `.gitignore` of `*` into the workspace report directory.
 *
 * These are throwaway drafts for a single conversation; committing them would
 * be noise, and nobody wants to add the ignore rule by hand.
 */
async function keepOutOfGit(directory: string): Promise<void> {
	const marker = path.join(directory, '.gitignore');
	try {
		await fs.access(marker);
	} catch {
		await fs.writeFile(marker, '*\n', 'utf8');
	}
}

async function prune(directory: string): Promise<void> {
	const now = Date.now();
	if (now - lastPrune < pruneInterval) {
		return;
	}
	lastPrune = now;

	try {
		for (const name of await fs.readdir(directory)) {
			if (name === '.gitignore') {
				continue;
			}
			const file = path.join(directory, name);
			try {
				const stat = await fs.stat(file);
				if (now - stat.mtimeMs > keepReportsFor) {
					await fs.unlink(file);
				}
			} catch {
				// Raced with something else; nothing to do.
			}
		}
	} catch {
		// No directory yet.
	}
}

async function writeReport(
	text: string,
	fileName: string,
	reportsIn: Assistant['reportsIn'],
	folder: vscode.WorkspaceFolder | undefined,
): Promise<vscode.Uri> {

	const directory = reportDirectory(reportsIn, folder);
	await fs.mkdir(directory, { recursive: true });
	if (reportsIn === 'workspace') {
		await keepOutOfGit(directory);
	}
	await prune(directory);

	const file = path.join(directory, fileName);
	await fs.writeFile(file, text, 'utf8');
	return vscode.Uri.file(file);
}

/** Sweeps old reports on activation, independently of any write. */
export async function cleanUpReports(): Promise<void> {
	lastPrune = 0;
	await prune(reportDirectory('tempDirectory', undefined));

	const folder = vscode.workspace.workspaceFolders?.[0];
	if (folder?.uri.scheme === 'file') {
		lastPrune = 0;
		await prune(reportDirectory('workspace', folder));
	}
}

/* --------------------------------------------------------------- delivery */

export type HandOverResult = 'delivered' | 'unavailable' | 'noWorkspace';

/** Closes a tab by URI rather than by "active". */
async function closeTab(uri: vscode.Uri): Promise<void> {
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			const input = tab.input as { uri?: vscode.Uri } | undefined;
			if (input?.uri?.toString() === uri.toString()) {
				await vscode.window.tabGroups.close(tab, true);
				return;
			}
		}
	}
}

/**
 * Claude Code: `claude-vscode.insertAtMention` takes no arguments and builds
 * `@<path relative to the workspace>` from the active editor. So the file has
 * to be opened, made active, mentioned, and closed again.
 *
 * The close is **by URI**, deliberately: inserting the mention reveals the chat,
 * so by that point the active tab may well be the chat itself and
 * `closeActiveEditor` would shut that instead.
 */
async function handOverToClaude(file: vscode.Uri, command: string): Promise<void> {
	const document = await vscode.workspace.openTextDocument(file);
	await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
	await vscode.commands.executeCommand(command);
	await closeTab(file);
}

/**
 * Writes `text` to a file and hands it to the assistant's chat.
 *
 * A file, not text, in both cases: `addFileToThread` discards anything whose
 * scheme is not `file`, and the agent reads the path from disk later, so a
 * virtual document is no use.
 */
export async function handOver(
	id: AssistantId,
	text: string,
	fileName: string,
): Promise<HandOverResult> {

	const assistant = assistants[id];
	if (!await isAvailable(id)) {
		return 'unavailable';
	}

	const folder = vscode.workspace.workspaceFolders?.[0];
	if (assistant.reportsIn === 'workspace' && folder?.uri.scheme !== 'file') {
		// Claude Code addresses files by workspace-relative path; without a local
		// folder there is no path to give it.
		return 'noWorkspace';
	}

	const file = await writeReport(text, fileName, assistant.reportsIn, folder);

	if (id === 'claude') {
		await handOverToClaude(file, assistant.command);
	} else {
		// Codex takes the URI directly, attaches it to the current thread and
		// reveals its own sidebar.
		await vscode.commands.executeCommand(assistant.command, file);
	}

	return 'delivered';
}
