/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { grantProposedApi } from './argvJson';
import { confirm } from './notify';

/*
 * Turning the `browser` proposal on for the user, in one click.
 *
 * Two very different things look identical from the outside — no toolbar
 * icons, nothing on the clipboard — and only one of them is fixable:
 *
 *   - the grant is missing. The host has the proposal, but this extension was
 *     not named in `--enable-proposed-api`. One line in `argv.json` and a full
 *     quit fixes it, and that is what `enableBrowserApi` writes.
 *   - the host does not have the proposal at all. Cursor is the example: its
 *     `allApiProposals` has no `browser` entry, so the flag grants nothing.
 *     Nothing an extension can write changes that, so the command says so
 *     instead of editing a file to no effect.
 *
 * Telling them apart without reading the host's bundle: a host that ships the
 * upstream integrated browser registers `workbench.action.browser.open`, which
 * is plain stable API to probe. Cursor has no such command (it has its own
 * `workbench.action.openBrowserEditor` for its own, unexposed browser), and no
 * host that carries the proposal is missing it.
 */

/** The upstream command that opens the built-in browser. Absent on Cursor. */
export const integratedBrowserCommand = 'workbench.action.browser.open';

export type BrowserApiState =
	/** `window.browserTabs` is there — nothing to do. */
	| 'granted'
	/**
	 * `argv.json` already names us, but this process did not start with it.
	 * Distinct from `grantMissing` because the remaining step is a restart, not
	 * another edit — telling the user to "enable" it again is what makes the
	 * fix look broken.
	 */
	| 'awaitingRestart'
	/** The host has the proposal but did not grant it to us. Fixable. */
	| 'grantMissing'
	/** The host ships no integrated browser API at all. Not fixable. */
	| 'unsupported';

/**
 * Fires when the grant is written, so the status bar can stop advertising a
 * step the user has already taken.
 */
const grantChanged = new vscode.EventEmitter<void>();
export const onDidChangeGrantState = grantChanged.event;

/**
 * Cached for the session: the file is megabytes and the answer cannot change
 * while the editor runs.
 */
let hostShipsApi: boolean | undefined;

/**
 * Does this host *implement* the browser API, as opposed to merely withholding
 * the grant? `undefined` when it cannot be told.
 *
 * This has to be answered from the host's own build, and the reason is Kiro.
 * The obvious proxy — "a host with the upstream browser registers
 * `workbench.action.browser.open`" — is wrong in one direction that matters:
 * Kiro 1.0.437 ships the browser as an *editor* feature (the command and the
 * `workbench.editor.browser` pane are both there) while shipping none of the
 * extension-facing half. Measured: 171 proposals with no `browser` among them,
 * and zero `browserTabs` in its extension host. On the proxy that reads as
 * "the grant is missing", so the button offered a fix, wrote `argv.json`, and
 * after the restart the API was still absent — leaving `Restart to finish`
 * on screen forever, which is how this was found.
 *
 * The witness is the extension host bundle: if the API exists at all, its
 * implementation is in there. Verified to separate all six editors on this
 * machine exactly — 1 for VS Code, VSCodium and Devin, 0 for Cursor,
 * Antigravity IDE and Kiro — and it is the *implementation*, not a heuristic
 * about it, so a fork that keeps the browser UI while dropping the API is
 * classified correctly rather than promised a restart that cannot help.
 */
async function hostShipsBrowserApi(): Promise<boolean | undefined> {
	if (hostShipsApi !== undefined) {
		return hostShipsApi;
	}
	try {
		const uri = vscode.Uri.joinPath(vscode.Uri.file(vscode.env.appRoot),
			'out', 'vs', 'workbench', 'api', 'node', 'extensionHostProcess.js');
		const bytes = await vscode.workspace.fs.readFile(uri);
		// Searched as bytes: turning two megabytes into a JS string to call
		// `includes` on it costs far more than the question is worth.
		hostShipsApi = Buffer.from(bytes).includes('browserTabs');
		return hostShipsApi;
	} catch {
		// A layout we do not know, or a remote or web host where the desktop
		// bundle is not ours to read. The caller falls back to the proxy.
		return undefined;
	}
}

async function proposalState(): Promise<'granted' | 'missing' | 'unsupported'> {
	if ('browserTabs' in vscode.window) {
		return 'granted';
	}

	const ships = await hostShipsBrowserApi();
	if (ships !== undefined) {
		return ships ? 'missing' : 'unsupported';
	}

	// Nothing authoritative to read. The command proxy is what is left: it is
	// right for every host measured, and wrong only for one that keeps the
	// browser UI without the API — which is the case just above.
	const commands = await vscode.commands.getCommands(true);
	return commands.includes(integratedBrowserCommand) ? 'missing' : 'unsupported';
}

export async function browserApiState(): Promise<BrowserApiState> {
	const state = await proposalState();
	if (state !== 'missing') {
		return state === 'granted' ? 'granted' : 'unsupported';
	}
	// The grant is absent from this process. Whether the file already carries it
	// decides which of the two remaining sentences is true.
	const host = await hostInfo();
	const source = await readArgv(argvUri(host));
	if (source) {
		try {
			if (grantProposedApi(source, extensionId()).alreadyListed) {
				return 'awaitingRestart';
			}
		} catch {
			// An unreadable value: treat as missing so the command runs and
			// reports the problem properly.
		}
	}
	return 'grantMissing';
}

/**
 * The extension id, which is also the string written into `argv.json`.
 *
 * Taken from the manifest rather than hard-coded: it is `publisher.name`, and a
 * copy here would silently stop matching if either ever moved.
 */
function extensionId(): string {
	return vscode.extensions.getExtension('DenysDavydov.tab-browser-ultimate')?.id
		?? 'DenysDavydov.tab-browser-ultimate';
}

function argvUri(host: HostInfo): vscode.Uri {
	return vscode.Uri.file(path.join(os.homedir(), host.dataFolderName, 'argv.json'));
}

/** The file's text, or '' when it does not exist yet. */
async function readArgv(uri: vscode.Uri): Promise<string> {
	try {
		return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
	} catch {
		// Not created yet: the editor writes it the first time anyone opens
		// Configure Runtime Arguments, which most users never have.
		return '';
	}
}

interface HostInfo {
	/** Home-relative folder holding `argv.json` — `.vscode`, `.cursor`, `.devin`. */
	readonly dataFolderName: string;
	/** The CLI binary, for the fallback instructions — `code`, `cursor`. */
	readonly applicationName: string;
	/** What to call the editor in a message. */
	readonly name: string;
}

/**
 * Reads the host's own identity out of `product.json`.
 *
 * `argv.json` lives at `~/<dataFolderName>/argv.json`, and that folder differs
 * per editor — `.vscode`, but `.cursor` and `.devin` on the forks. None of it
 * is exposed through the extension API, so it is read from the `product.json`
 * sitting next to `vscode.env.appRoot`. Verified present on VS Code, Cursor
 * and Devin. Every field falls back, because a fork is free to omit any of it
 * and a wrong guess here would write a file the editor never reads.
 */
async function hostInfo(): Promise<HostInfo> {
	const fallback: HostInfo = {
		dataFolderName: '.vscode',
		applicationName: 'code',
		name: vscode.env.appName,
	};
	try {
		const uri = vscode.Uri.file(path.join(vscode.env.appRoot, 'product.json'));
		const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		const product = JSON.parse(raw) as Record<string, unknown>;
		const folder = product.dataFolderName;
		const app = product.applicationName;
		return {
			dataFolderName: typeof folder === 'string' && folder ? folder : fallback.dataFolderName,
			applicationName: typeof app === 'string' && app ? app : fallback.applicationName,
			name: vscode.env.appName,
		};
	} catch {
		// A fork that hides product.json, or a remote/web host. `.vscode` is the
		// honest guess, and the dialog names the path so a wrong one is visible.
		return fallback;
	}
}

/**
 * Writes the grant into `argv.json` and asks for the restart it needs.
 *
 * `argv.json` is read once at process start, so Reload Window does nothing
 * here — the message says "quit", and the button really quits.
 */
export async function enableBrowserApi(): Promise<void> {
	const id = extensionId();
	const state = await browserApiState();

	if (state === 'granted') {
		confirm(vscode.l10n.t(
			"The integrated browser API is already enabled — element tools, screenshots and the MCP browser tools are available."));
		return;
	}

	const host = await hostInfo();

	if (state === 'unsupported') {
		// Cursor and Kiro land here. Editing argv.json would be a no-op, so it
		// is not even offered; the setting that does help is.
		//
		// A grant may already be sitting in the file from before this was
		// detected properly, and saying so matters: the user restarted for it
		// and is entitled to know it was not their mistake.
		const stale = (await readArgv(argvUri(host))).includes(id);
		const usePanel = vscode.l10n.t("Use the webview panel");
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t("{0} does not support the integrated browser API", host.name),
			{
				modal: true,
				detail: vscode.l10n.t("This editor ships no `browser` API proposal — the API is not in its build at all, so neither `--enable-proposed-api` nor a restart can provide it. The element tools, screenshots and MCP browser tools need VS Code 1.112 or newer; VSCodium and Devin work too.\n\nWhat does work here is the built-in webview panel: \"AI Browser: Show\".{0}",
					stale
						? vscode.l10n.t("\n\nNote: \"enable-proposed-api\" in {0} already names this extension. It is harmless, and you can remove that entry.", argvUri(host).fsPath)
						: ''),
			},
			usePanel);
		if (choice === usePanel) {
			await vscode.workspace.getConfiguration('aiBrowser')
				.update('useIntegratedBrowser', false, vscode.ConfigurationTarget.Global);
			await vscode.commands.executeCommand('aiBrowser.show');
		}
		return;
	}

	const uri = argvUri(host);
	const source = await readArgv(uri);

	let result;
	try {
		result = grantProposedApi(source, id);
	} catch (err) {
		const open = vscode.l10n.t("Open argv.json");
		const choice = await vscode.window.showErrorMessage(
			err instanceof Error ? err.message : String(err), open);
		if (choice === open) {
			await openArgv(uri);
		}
		return;
	}

	if (result.changed) {
		try {
			if (source) {
				// Cheap insurance: this file decides how the editor launches, and
				// the user did not choose to have it touched byte by byte.
				await vscode.workspace.fs.writeFile(
					vscode.Uri.file(`${uri.fsPath}.bak`), Buffer.from(source, 'utf8'));
			}
			await vscode.workspace.fs.createDirectory(
				vscode.Uri.file(path.dirname(uri.fsPath)));
			await vscode.workspace.fs.writeFile(uri, Buffer.from(result.text, 'utf8'));
		} catch (err) {
			await failedToWrite(uri, id, err);
			return;
		}
		// The remaining step is now a restart, and the status bar says so.
		grantChanged.fire();
	}

	const quit = vscode.l10n.t("Quit {0} now", host.name);
	const open = vscode.l10n.t("Show argv.json");
	const detail = result.alreadyListed
		? vscode.l10n.t("{0} already grants the API in {1}, but this window did not start with it. A full quit and reopen is what applies it — Reload Window is read too late.", host.name, uri.fsPath)
		: vscode.l10n.t("Added this extension to \"enable-proposed-api\" in {0}.\n\nThe file is read when the process starts, so {1} has to be fully quit and reopened — Reload Window is not enough.", uri.fsPath, host.name);

	const choice = await vscode.window.showInformationMessage(
		vscode.l10n.t("One more step: quit and reopen {0}", host.name),
		{ modal: true, detail },
		quit, open);

	if (choice === quit) {
		await vscode.commands.executeCommand('workbench.action.quit');
	} else if (choice === open) {
		await openArgv(uri);
	}
}

/** Falls back to the editor's own editor for the file when writing is refused. */
async function failedToWrite(argvUri: vscode.Uri, extensionId: string, err: unknown): Promise<void> {
	const open = vscode.l10n.t("Open argv.json");
	const copy = vscode.l10n.t("Copy the line");
	const line = `"enable-proposed-api": [${JSON.stringify(extensionId)}]`;
	const choice = await vscode.window.showErrorMessage(
		vscode.l10n.t("Could not write {0}: {1}", argvUri.fsPath,
			err instanceof Error ? err.message : String(err)),
		open, copy);
	if (choice === open) {
		await openArgv(argvUri);
	} else if (choice === copy) {
		await vscode.env.clipboard.writeText(line);
	}
}

/**
 * Shows `argv.json`.
 *
 * `workbench.action.configureRuntimeArguments` is preferred over opening the
 * path ourselves: it creates the file from the editor's own template when it is
 * missing, and it is present on VS Code, Cursor and Devin alike. Opening the
 * URI is the fallback for a host that dropped it.
 */
async function openArgv(argvUri: vscode.Uri): Promise<void> {
	try {
		await vscode.commands.executeCommand('workbench.action.configureRuntimeArguments');
	} catch {
		await vscode.window.showTextDocument(argvUri);
	}
}
