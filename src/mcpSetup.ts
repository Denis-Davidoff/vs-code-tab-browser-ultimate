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
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { McpServer } from './mcpServer';

const serverName = 'tab-browser';

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

	const choice = await vscode.window.showInformationMessage(
		vscode.l10n.t("Connect Claude Code to the browser panel?"),
		{
			modal: true,
			detail: vscode.l10n.t(
				"The server is at {0}. \".mcp.json\" is read by everyone who opens this project, so the token would be committed with it unless the file is ignored; the cli command keeps it in your own Claude Code settings.",
				server.url),
		},
		...(folder ? [write, copy] : [copy]));

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
