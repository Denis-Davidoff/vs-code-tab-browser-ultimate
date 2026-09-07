/*---------------------------------------------------------------------------------------------
 *  Getting the two clients to find the mcp server.
 *
 *  They are configured in different places, and only one of them can be told from here:
 *
 *  - **VS Code's own chat** takes a server definition from the extension api, so it needs no
 *    configuration at all. The api arrived in VS Code 1.101; older editors simply do without,
 *    which is why it is reached through a cast rather than a raised `engines.vscode`.
 *  - **Claude Code** reads `.mcp.json` in the project (and `claude mcp add` writes elsewhere),
 *    so the command below writes that file — and offers the cli line for anyone who would
 *    rather not have it in the repository.
 *  - **Codex** reads servers from `~/.codex/config.toml` and, in a trusted repository, from
 *    `.codex/config.toml` in the project. A bearer token can only be *named* there — the config
 *    holds the name of an environment variable to read it from, and this extension has no say
 *    over the environment Codex runs in — so it gets the url with the token in its path.
 *
 *    The project file is written here, because it belongs to one project and so does the panel
 *    it points at. The global file is left to `codex mcp add`, which owns it and knows how to
 *    edit around the other servers in it; there the server carries the project's name, since
 *    one entry per project is the point.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { codexEntries } from './codexToml';
import { McpServer } from './mcpServer';

/** How the server is named in every client configuration. */
export const serverName = 'tab-browser';

/** The slice of the 1.101 api this needs, so the extension still builds against older types. */
interface McpApi {
	readonly lm?: {
		registerMcpServerDefinitionProvider?(id: string, provider: {
			provideMcpServerDefinitions(): unknown[];
		}): vscode.Disposable;
	};
	/** `constructor(label, uri, headers?, version?)` — positional, per the 1.101 api. */
	McpHttpServerDefinition?: new (
		label: string,
		uri: vscode.Uri,
		headers?: Record<string, string>,
		version?: string,
	) => unknown;
}

export function registerWithVsCode(server: McpServer): vscode.Disposable {
	const api = vscode as unknown as McpApi;
	const register = api.lm?.registerMcpServerDefinitionProvider;
	const Definition = api.McpHttpServerDefinition;

	if (!register || !Definition || !server.url) {
		return new vscode.Disposable(() => { });
	}

	return register.call(api.lm, 'tabBrowserMcp', {
		provideMcpServerDefinitions: () => [new Definition(
			'Tab Browser Ultimate',
			vscode.Uri.parse(server.url!),
			{ Authorization: `Bearer ${server.token}` },
		)],
	});
}

/** Writes `.mcp.json` for Claude Code, or hands over the `claude mcp add` line instead. */
export async function connectToClaudeCode(server: McpServer): Promise<void> {
	if (!server.url) {
		vscode.window.showWarningMessage(vscode.l10n.t("The mcp server is not running."));
		return;
	}

	const cli = `claude mcp add --transport http --scope local ${serverName} ${server.url}`
		+ ` --header "Authorization: Bearer ${server.token}"`;

	const folder = vscode.workspace.workspaceFolders?.[0];
	const write = vscode.l10n.t("Write .mcp.json");
	const copy = vscode.l10n.t("Copy CLI command");
	const prompt = vscode.l10n.t("Copy connection prompt");

	const choice = await vscode.window.showInformationMessage(
		vscode.l10n.t("Connect Claude Code to the browser panel?"),
		{
			modal: true,
			detail: vscode.l10n.t(
				"The server is at {0}. \".mcp.json\" is read by everyone who opens this project, so the token would be committed with it unless the file is ignored; the cli command keeps it in your own Claude Code settings. The prompt is the same command written for Claude Code to run itself, with a check that it worked.",
				server.url),
		},
		...(folder ? [write, copy, prompt] : [copy, prompt]));

	if (choice === prompt) {
		await copyConnectPrompt(
			connectPrompt(cli, vscode.l10n.t(
				"Restart yourself afterwards — you read your mcp servers when you start.")),
			'Claude Code');
		return;
	}

	if (choice === copy) {
		await vscode.env.clipboard.writeText(cli);
		vscode.window.showInformationMessage(
			vscode.l10n.t("Copied. Run it in the project folder, then check it with /mcp."));
		return;
	}

	if (choice !== write || !folder) {
		return;
	}

	const file = vscode.Uri.joinPath(folder.uri, '.mcp.json');
	const config = await readConfig(file);
	if (!config) {
		vscode.window.showErrorMessage(vscode.l10n.t(
			"\".mcp.json\" could not be read as json. Fix or remove it, or use the cli command instead — overwriting it would drop the servers it already defines."));
		return;
	}

	const servers = (config.mcpServers ?? {}) as Record<string, unknown>;

	servers[serverName] = {
		type: 'http',
		url: server.url,
		headers: { Authorization: `Bearer ${server.token}` },
	};
	config.mcpServers = servers;

	await vscode.workspace.fs.writeFile(
		file, Buffer.from(`${JSON.stringify(config, null, 2)}\n`, 'utf8'));

	const open = vscode.l10n.t("Open .mcp.json");
	const picked = await vscode.window.showInformationMessage(
		vscode.l10n.t("Claude Code will offer to approve \"{0}\" the next time it starts in this project.", serverName),
		open);
	if (picked === open) {
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
	}
}

/**
 * A prompt for the assistant itself: the one command that adds the server, and a request to
 * check it. Handed over on the clipboard because neither assistant can be given text from
 * outside — see `openClaudeWithPrompt` in assistants.ts for the one exception, which only
 * applies to a conversation this extension opens itself.
 *
 * Deliberately short: the assistant only needs the command and a reason to try it. `pickUp`
 * differs per client, because both read their servers at startup but start at different
 * moments, and a prompt that skipped this would have the assistant report the tools missing
 * right after adding them correctly.
 */
function connectPrompt(cli: string, pickUp: string): string {
	return [
		vscode.l10n.t("To connect to my embedded browser run this in the project folder:"),
		cli,
		'',
		pickUp,
		vscode.l10n.t("Then call browser_state to test the connection and tell me how it went."),
	].join('\n');
}

async function copyConnectPrompt(prompt: string, assistant: string): Promise<void> {
	await vscode.env.clipboard.writeText(prompt);
	vscode.window.showInformationMessage(vscode.l10n.t(
		"Copied. Paste it into {0} — it carries this window's token, so send it to {0} and to nothing else.",
		assistant));
}

/**
 * The existing config, `{}` when there is no file yet, and `undefined` when there is one that
 * cannot be parsed — that is not an empty config, and writing over it would drop every other
 * server the project defines.
 */
async function readConfig(file: vscode.Uri): Promise<Record<string, unknown> | undefined> {
	let bytes: Uint8Array;
	try {
		bytes = await vscode.workspace.fs.readFile(file);
	} catch {
		return {};
	}

	try {
		const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
		return typeof parsed === 'object' && parsed !== null
			? parsed as Record<string, unknown>
			: undefined;
	} catch {
		return undefined;
	}
}

/** Points Codex at this window's panel: per project where it can be, globally otherwise. */
export async function connectToCodex(server: McpServer): Promise<void> {
	if (!server.urlWithToken) {
		vscode.window.showWarningMessage(vscode.l10n.t("The mcp server is not running."));
		return;
	}

	const folder = vscode.workspace.workspaceFolders?.[0];
	// One name per project: a single shared one would have the second project overwrite the
	// first, and with the token in the url that reconnection would even authenticate. The name
	// alone does not identify a project — every client has a `frontend` — so the location
	// decides, and the readable part is only there to say which entry is which.
	const globalName = folder
		? `${serverName}-${slug(folder.name || path.basename(folder.uri.fsPath))}-${shortHash(folder)}`
		: serverName;
	const cli = `codex mcp add ${globalName} --url ${server.urlWithToken}`;

	const project = vscode.l10n.t("Write .codex/config.toml");
	const global = vscode.l10n.t("Add to Codex globally");
	const copy = vscode.l10n.t("Copy CLI command");
	const prompt = vscode.l10n.t("Copy connection prompt");

	const choice = await vscode.window.showInformationMessage(
		vscode.l10n.t("Connect Codex to the browser panel?"),
		{
			modal: true,
			detail: vscode.l10n.t(
				"The server is at {0}; the token is in the url because Codex can only read one from an environment variable.\n\n\".codex/config.toml\" keeps the entry with this project, and Codex reads it once the repository is trusted. Adding it globally puts \"{1}\" in ~/.codex/config.toml instead, where it applies everywhere. The prompt is the same command written for Codex to run itself, with a check that it worked.",
				server.url ?? '', globalName),
		},
		...(folder ? [project, global, copy, prompt] : [global, copy, prompt]));

	if (choice === prompt) {
		await copyConnectPrompt(
			connectPrompt(cli, vscode.l10n.t(
				"Tell me to start a new conversation afterwards — you read your mcp servers when one starts, so check there.")),
			'Codex');
		return;
	}

	if (choice === copy) {
		await vscode.env.clipboard.writeText(cli);
		vscode.window.showInformationMessage(
			vscode.l10n.t("Copied. Run it, then start a new Codex conversation."));
		return;
	}

	if (choice === project && folder) {
		await writeCodexProjectConfig(folder.uri, server.urlWithToken);
		return;
	}

	if (choice !== global) {
		return;
	}

	try {
		await runCodex(['mcp', 'add', globalName, '--url', server.urlWithToken]);
		await removeSupersededEntry(globalName, server.urlWithToken);
		vscode.window.showInformationMessage(vscode.l10n.t(
			"Added \"{0}\" to Codex. Start a new conversation there — it reads its servers when it starts.",
			globalName));
	} catch (error) {
		// Most likely the cli is not on the PATH; the command still works from a terminal.
		await vscode.env.clipboard.writeText(cli);
		vscode.window.showWarningMessage(vscode.l10n.t(
			"Could not run the Codex cli ({0}). The command is on the clipboard; run it in a terminal.",
			error instanceof Error ? error.message : String(error)));
	}
}

/**
 * Writes just our own table into the project's config, leaving everything else in the file
 * exactly as it was: appending a `[table]` header is valid after anything, and the only way to
 * break the file would be to define the same table twice, which is why an existing one is
 * replaced rather than added to.
 */
async function writeCodexProjectConfig(folder: vscode.Uri, url: string): Promise<void> {
	const file = vscode.Uri.joinPath(folder, '.codex', 'config.toml');
	const header = `[mcp_servers.${serverName}]`;
	const table = `${header}\nurl = "${url}"\n`;

	let existing = '';
	try {
		existing = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
	} catch {
		// No file yet.
	}

	// Read rather than searched for the header line: `[mcp_servers.tab-browser] # ours` is the
	// same table, and missing it would define it a second time, which is not valid TOML at all.
	const ours = codexEntries(existing).find(entry => entry.name === serverName);

	let updated: string;
	if (!ours) {
		updated = existing.trim() ? `${existing.replace(/\s*$/, '')}\n\n${table}` : table;
	} else {
		const lines = existing.split('\n');
		updated = [
			...lines.slice(0, ours.firstLine),
			table.replace(/\n$/, ''),
			...lines.slice(ours.endLine),
		].join('\n');
	}

	await vscode.workspace.fs.writeFile(file, Buffer.from(updated, 'utf8'));

	const open = vscode.l10n.t("Open config.toml");
	const picked = await vscode.window.showInformationMessage(
		vscode.l10n.t("Wrote \".codex/config.toml\". Codex reads it once this repository is trusted; start a new conversation there."),
		open);
	if (picked === open) {
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
	}
}

/** `My App` -> `my-app`, so the name is readable in `codex mcp list`. */
function slug(value: string): string {
	return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
		|| 'workspace';
}

/**
 * Takes back the entry an earlier version of this extension wrote under the name without the
 * location in it. Left there it is a second server offering the same tools, which Codex starts
 * as well — and only ours if this project happens to be the one that wrote it.
 *
 * Which is why the url decides and not the name: it carries this workspace's token, so an entry
 * naming it was written from here. Anything else belongs to another project and is left alone.
 */
async function removeSupersededEntry(currentName: string, urlWithToken: string): Promise<void> {
	let text: string;
	try {
		text = Buffer.from(await vscode.workspace.fs.readFile(globalCodexConfig())).toString('utf8');
	} catch {
		return;
	}

	const legacy = supersededCodexEntry(text, currentName, urlWithToken);
	if (!legacy) {
		return;
	}

	try {
		await runCodex(['mcp', 'remove', legacy]);
	} catch {
		// An older cli without the subcommand, or none on the PATH: the entry stays, which is
		// untidy but harmless — it names this very server.
	}
}

/** Pure half of the above, so the cases that only happen to someone else's config are testable. */
export function supersededCodexEntry(
	text: string,
	currentName: string,
	urlWithToken: string,
): string | undefined {
	const legacy = currentName.replace(/-[0-9a-f]{6}$/, '');
	if (legacy === currentName) {
		return undefined;
	}

	const entry = codexEntries(text).find(candidate => candidate.name === legacy);
	return entry?.values.get('url') === urlWithToken ? legacy : undefined;
}

function globalCodexConfig(): vscode.Uri {
	return vscode.Uri.file(path.join(os.homedir(), '.codex', 'config.toml'));
}

/** Six hex characters of the folder's location: enough to tell two `frontend`s apart. */
function shortHash(folder: vscode.WorkspaceFolder): string {
	const location = folder.uri.toString?.() || folder.uri.fsPath || folder.name;
	return crypto.createHash('sha1').update(location).digest('hex').slice(0, 6);
}

function runCodex(args: readonly string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		// On Windows the cli is `codex.cmd`, which `CreateProcess` will not find on its own.
		const options = { timeout: 20000, shell: process.platform === 'win32' };
		execFile('codex', args as string[], options, (error, _stdout, stderr) => {
			if (error) {
				reject(new Error(stderr?.trim() || error.message));
			} else {
				resolve();
			}
		});
	});
}
