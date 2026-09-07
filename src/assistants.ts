/*---------------------------------------------------------------------------------------------
 *  Hands a report to a coding assistant running in the same window.
 *
 *  Neither extension has an api for this, so each is driven through the command it does expose,
 *  and the two are not alike:
 *
 *  - **Claude Code** has `claude-vscode.insertAtMention`, which takes no arguments and builds
 *    `@<path relative to the workspace>` from the *active editor*. So the report is written into
 *    the workspace, opened, mentioned, and its editor closed again. Plain text can only reach a
 *    *new* conversation, through the `prompt` argument its panel takes while being created.
 *  - **Codex** has `chatgpt.addFileToThread`, which takes the file's uri outright and attaches
 *    it to the current thread. No editor, and no workspace either: the path it stores is
 *    absolute, so its reports are written to the temp directory and never touch the project.
 *
 *  Neither can be handed content without a file: `addFileToThread` drops anything whose scheme
 *  is not `file`, and the agent reads the path from disk afterwards, so a virtual document is
 *  no use. Codex materialises its own attachments the same way.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

export type Assistant = 'claude' | 'codex';

interface AssistantSetup {
	readonly name: string;
	readonly extensionId: string;
	/** The command that does the work; its absence means the extension is too old. */
	readonly command: string;
	/**
	 * Where the report has to live. Claude Code names files relative to the workspace, so it
	 * has no choice; Codex stores an absolute path, so its reports stay out of the project.
	 */
	readonly reportsIn: 'workspace' | 'tempDirectory';
}

const assistants: Record<Assistant, AssistantSetup> = {
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

const openClaudeEditorCommand = 'claude-vscode.editor.open';
const newCodexPanelCommand = 'chatgpt.newCodexPanel';

/** Where reports go inside the workspace. Shared by both assistants. */
const reportDirectory = '.tab-browser';

/** A report is context for one conversation; a few hours later nobody is coming back to it. */
const keepReportsFor = 5 * 60 * 60 * 1000;

/** Sweeping on every write would stat the directory dozens of times a session. */
const pruneInterval = 60 * 60 * 1000;
let lastPrune = 0;

/** Sweeps both report directories, whatever the interval says. Called when the window opens. */
export async function cleanUpReports(): Promise<void> {
	await prune(true);
}

export function name(assistant: Assistant): string {
	return assistants[assistant].name;
}

/** Whether the extension is there at all. Synchronous, for building the copy menu. */
export function isInstalled(assistant: Assistant): boolean {
	return !!vscode.extensions.getExtension(assistants[assistant].extensionId);
}

export async function isAvailable(assistant: Assistant): Promise<boolean> {
	return isInstalled(assistant)
		&& (await vscode.commands.getCommands(true)).includes(assistants[assistant].command);
}

export type HandOverResult = 'delivered' | 'unavailable' | 'noWorkspace';

/** Writes `text` to `fileName` and puts it in front of the assistant. */
export async function handOver(
	assistant: Assistant,
	text: string,
	fileName: string,
): Promise<HandOverResult> {
	if (!await isAvailable(assistant)) {
		return 'unavailable';
	}

	const file = await writeReport(text, fileName, assistants[assistant].reportsIn);
	if (!file) {
		return 'noWorkspace';
	}

	if (assistant === 'codex') {
		await vscode.commands.executeCommand(assistants.codex.command, file);
		return 'delivered';
	}

	// The mention is built from whatever editor is active, so the report has to be it.
	const document = await vscode.workspace.openTextDocument(file);
	await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
	await vscode.commands.executeCommand(assistants.claude.command);

	// Inserting reveals the chat, which may now hold the active tab: close this one by name
	// rather than closing whatever ended up in front.
	await closeTab(file);
	return 'delivered';
}

/**
 * Opens a new Claude Code conversation with `prompt` already in its input, unsent. There is no
 * way to put text into a conversation that is already open: passing a prompt for a session that
 * has a panel is refused by the extension with "enter it manually". Codex offers nothing of the
 * kind, so this is Claude Code only.
 */
export async function openClaudeWithPrompt(prompt: string): Promise<boolean> {
	if (!(await vscode.commands.getCommands(true)).includes(openClaudeEditorCommand)) {
		return false;
	}
	await vscode.commands.executeCommand(openClaudeEditorCommand, undefined, prompt);
	return true;
}

/**
 * Opens a new Codex agent in an editor tab, with `prompt` on the clipboard for the single
 * paste that puts it in front of it.
 *
 * Codex cannot be handed text, and not for want of looking: `chatgpt.newCodexPanel` takes
 * nothing but a telemetry source, its deep link (`vscode://openai.chatgpt/…`) only navigates
 * its webview to a route and no route reads a prompt, the composer's prefill is written from
 * inside that webview and from nowhere else, and `chatgpt.addFileToThread` attaches a file to
 * whichever view Codex considers focused — it focuses its own sidebar on the way there, so a
 * file meant for a fresh tab lands in the sidebar's conversation instead. An attachment is not
 * a prompt either: it leaves the composer empty, and the agent does nothing until something is
 * sent. Hence the clipboard, which is the one channel that always arrives.
 */
export async function openCodexWithPrompt(prompt: string): Promise<boolean> {
	if (!isInstalled('codex')
		|| !(await vscode.commands.getCommands(true)).includes(newCodexPanelCommand)) {
		return false;
	}

	// The clipboard first: the tab takes focus, and the paste has to be ready when it does.
	await vscode.env.clipboard.writeText(prompt);
	await vscode.commands.executeCommand(newCodexPanelCommand);
	return true;
}

async function writeReport(
	text: string,
	fileName: string,
	reportsIn: 'workspace' | 'tempDirectory',
): Promise<vscode.Uri | undefined> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	const inWorkspace = reportsIn === 'workspace' && folder?.uri.scheme === 'file';
	if (reportsIn === 'workspace' && !inWorkspace) {
		return undefined;
	}

	const directory = inWorkspace
		? path.join(folder!.uri.fsPath, reportDirectory)
		: path.join(os.tmpdir(), 'tab-browser-ultimate', 'reports');

	await fs.mkdir(directory, { recursive: true });
	if (inWorkspace) {
		await keepOutOfGit(directory);
	}
	await prune();

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

async function prune(force = false): Promise<void> {
	if (!force && Date.now() - lastPrune < pruneInterval) {
		return;
	}
	lastPrune = Date.now();

	const folder = vscode.workspace.workspaceFolders?.[0];
	const directories = [path.join(os.tmpdir(), 'tab-browser-ultimate', 'reports')];
	if (folder?.uri.scheme === 'file') {
		directories.push(path.join(folder.uri.fsPath, reportDirectory));
	}

	for (const directory of directories) {
		await pruneOldReports(directory);
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
		// Housekeeping only: the directory may not exist yet.
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
