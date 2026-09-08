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
 *    edit around the other servers in it — so it is offered as a command to run and not written
 *    from here; there the server carries the project's name, since one entry per project is the
 *    point, and `mcpRefresh.ts` keeps an entry added that way pointing at this window.
 *
 *  Either command's two first buttons are one way of connecting, which is why they are numbered:
 *  the prompt has the assistant read an entry, and writing that entry is what comes first.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
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
	// Numbered, because the two of them are one way of connecting and the order matters: the
	// prompt tells Claude Code to read an entry that the first button is what writes.
	const write = vscode.l10n.t("1. Write .mcp.json");
	const prompt = vscode.l10n.t("2. Copy connection prompt");
	const copy = vscode.l10n.t("Copy CLI command");

	const choice = await vscode.window.showInformationMessage(
		vscode.l10n.t("Connect Claude Code to the browser panel?"),
		{
			modal: true,
			detail: vscode.l10n.t(
				"The simplest way is both buttons in order: \"1. Write .mcp.json\", then \"2. Copy connection prompt\" — and paste that into the Claude Code chat.\n\nThe server is at {0}. \".mcp.json\" is read by everyone who opens this project, so the token would be committed with it unless the file is ignored; the cli command keeps it in your own Claude Code settings instead.",
				server.url),
		},
		// Both of the first two name `.mcp.json`, of which there is none without a folder open.
		...(folder ? [write, prompt, copy] : [copy]));

	if (choice === prompt) {
		await copyConnectPrompt(
			connectPrompt(vscode.l10n.t("Use MCP `{0}` from `.mcp.json`", serverName), cli),
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
 * The prompt for the assistant itself: pick the entry this extension writes up, and the command
 * that adds it for the case where the file was never written.
 *
 * That command does not always add the *same* name. Claude Code's writes `tab-browser`, the name
 * the first line asks for; Codex's writes the one carrying this project's hash, because the file
 * it writes is shared between projects — so for Codex the fallback has to say which server the
 * command actually leaves behind, or the assistant runs it correctly and then looks for a server
 * that is not there.
 */
function connectPrompt(use: string, cli: string, addedName?: string): string {
	const fallback = addedName
		? vscode.l10n.t(
			"If it is not in the file, run `{0}` — that adds `{1}` to `~/.codex/config.toml`; use that one instead.",
			cli, addedName)
		: vscode.l10n.t("If it is not in the file, run `{0}`.", cli);
	return `${use}\n${fallback}`;
}

/**
 * Handed over on the clipboard because neither assistant can be given text from outside — see
 * `openClaudeWithPrompt` in assistants.ts for the one exception, which only applies to a
 * conversation this extension opens itself.
 */
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

/** Points Codex at this window's panel through the config of whichever project is open. */
export async function connectToCodex(server: McpServer): Promise<void> {
	if (!server.urlWithToken) {
		vscode.window.showWarningMessage(vscode.l10n.t("The mcp server is not running."));
		return;
	}

	const folder = vscode.workspace.workspaceFolders?.[0];
	const globalName = codexEntryName(folder);
	const cli = `codex mcp add ${globalName} --url ${server.urlWithToken}`;

	const project = vscode.l10n.t("1. Write .codex/config.toml");
	const prompt = vscode.l10n.t("2. Copy connection prompt");
	const copy = vscode.l10n.t("Copy CLI command");

	const choice = await vscode.window.showInformationMessage(
		vscode.l10n.t("Connect Codex to the browser panel?"),
		{
			modal: true,
			detail: vscode.l10n.t(
				"The simplest way is both buttons in order: \"1. Write .codex/config.toml\", then \"2. Copy connection prompt\" — and paste that into the Codex chat.\n\nThe server is at {0}; the token is in the url because Codex can only read one from an environment variable. Codex reads the project's config once the repository is trusted; the cli command adds \"{1}\" to ~/.codex/config.toml instead, where it applies to every project.",
				server.url ?? '', globalName),
		},
		// Both of the first two name the project's config, which needs a folder open.
		...(folder ? [project, prompt, copy] : [copy]));

	if (choice === prompt) {
		await copyConnectPrompt(
			connectPrompt(
				vscode.l10n.t("Use MCP `{0}` from `.codex/config.toml`", serverName), cli, globalName),
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

	let existing = '';
	try {
		existing = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
	} catch {
		// No file yet.
	}

	// Whatever the file already uses: a table written with bare newlines into a file with CRLF
	// endings leaves it half one and half the other, and the diff of somebody else's config is
	// then the whole file.
	const newline = /\r\n/.test(existing) ? '\r\n' : '\n';
	const header = `[mcp_servers.${serverName}]`;
	const table = `${header}${newline}url = "${url}"${newline}`;

	// Read rather than searched for the header line: `[mcp_servers.tab-browser] # ours` is the
	// same table, and missing it would define it a second time, which is not valid TOML at all.
	const ours = codexEntries(existing).find(entry => entry.name === serverName);

	let updated: string;
	if (!ours) {
		updated = existing.trim()
			? `${existing.replace(/\s*$/, '')}${newline}${newline}${table}`
			: table;
	} else {
		// Split on the newline alone, so a `\r` stays at the end of the line it belongs to and
		// the lines this leaves alone keep the endings they had.
		const lines = existing.split('\n');
		updated = [
			...lines.slice(0, ours.firstLine),
			// Only the newline: the `\r` before it belongs to the line, and the join below
			// supplies the `\n` that completes it.
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

/**
 * What this workspace's server is called in the config Codex shares between projects. One name
 * per project: a single shared one would have the second project overwrite the first, and with
 * the token in the url that reconnection would even authenticate. The name alone does not
 * identify a project — every client has a `frontend` — so the location decides, and the
 * readable part is only there to say which entry is which.
 */
export function codexEntryName(folder: vscode.WorkspaceFolder | undefined): string {
	return folder
		? `${serverName}-${slug(folder.name || path.basename(folder.uri.fsPath))}-${shortHash(folder)}`
		: serverName;
}

/** `My App` -> `my-app`, so the name is readable in `codex mcp list`. */
function slug(value: string): string {
	return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
		|| 'workspace';
}

/** Six hex characters of the folder's location: enough to tell two `frontend`s apart. */
function shortHash(folder: vscode.WorkspaceFolder): string {
	const location = folder.uri.toString?.() || folder.uri.fsPath || folder.name;
	return crypto.createHash('sha1').update(location).digest('hex').slice(0, 6);
}
