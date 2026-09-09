/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { codexEntries } from './codexToml';
import { serverName } from './mcpClientState';
import type { McpServer } from './mcpServer';

/**
 * Three clients, three places to configure, and only one of them has an API.
 */

export const vsCodeProviderId = 'aiBrowserMcp';
const providerLabel = 'AI Browser';

/* ---------------------------------------------------------------- VS Code chat */

/**
 * Shape of the 1.101 MCP provider API, reached through a cast.
 *
 * Declaring it this way keeps `engines.vscode` where it is and lets the feature
 * be simply absent on editors that do not have it, instead of failing
 * activation.
 */
interface McpApi {
	readonly lm?: {
		registerMcpServerDefinitionProvider?(id: string, provider: {
			provideMcpServerDefinitions(): unknown[];
		}): vscode.Disposable;
	};
	McpHttpServerDefinition?: new (
		label: string, uri: vscode.Uri, headers?: Record<string, string>, version?: string,
	) => unknown;
}

/**
 * Registers the server with VS Code's own chat, if this editor supports it.
 *
 * Returns undefined when the API is missing, which is not an error.
 */
export function registerWithVsCode(server: McpServer, version: string): vscode.Disposable | undefined {
	const api = vscode as unknown as McpApi;
	const register = api.lm?.registerMcpServerDefinitionProvider;
	const Definition = api.McpHttpServerDefinition;
	if (!register || !Definition || !server.url) {
		return undefined;
	}

	try {
		return register.call(api.lm, vsCodeProviderId, {
			provideMcpServerDefinitions: () => [
				// The constructor is positional; an options object does not work.
				new Definition(
					providerLabel,
					vscode.Uri.parse(server.url!),
					{ Authorization: `Bearer ${server.token}` },
					version),
			],
		});
	} catch {
		return undefined;
	}
}

/* --------------------------------------------------------------- shared helpers */

export function workspaceFolder(): vscode.WorkspaceFolder | undefined {
	return vscode.workspace.workspaceFolders?.[0];
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
	try {
		return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
	} catch {
		return undefined; // absent
	}
}

async function writeText(uri: vscode.Uri, text: string): Promise<void> {
	const parent = uri.with({ path: uri.path.replace(/\/[^/]+$/, '') });
	await vscode.workspace.fs.createDirectory(parent);
	await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
}

export function claudeConfigUri(folder: vscode.WorkspaceFolder): vscode.Uri {
	return vscode.Uri.joinPath(folder.uri, '.mcp.json');
}

export function codexProjectConfigUri(folder: vscode.WorkspaceFolder): vscode.Uri {
	return vscode.Uri.joinPath(folder.uri, '.codex', 'config.toml');
}

export function codexGlobalConfigUri(): vscode.Uri {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
	return vscode.Uri.file(`${home}/.codex/config.toml`);
}

/**
 * A per-project name for the global Codex config.
 *
 * One shared name would mean the second project silently overwrites the first —
 * and because the token rides in the URL, that hijacked entry would even
 * authenticate successfully against the wrong workspace.
 */
export function codexEntryName(folder: vscode.WorkspaceFolder): string {
	const slug = folder.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
	const hash = crypto.createHash('sha1').update(folder.uri.toString()).digest('hex').slice(0, 6);
	return `${serverName}-${slug || 'project'}-${hash}`;
}

/* ------------------------------------------------------------------ Claude Code */

/**
 * Reads `.mcp.json`, distinguishing "absent" from "unparsable".
 *
 * Absent is `{}` and safe to write. Unparsable is `undefined`, and the caller
 * must give up: rewriting a broken file would delete every other MCP server the
 * project has configured.
 */
export async function readClaudeConfig(uri: vscode.Uri): Promise<Record<string, any> | undefined> {
	const text = await readText(uri);
	if (text === undefined || text.trim() === '') {
		return {};
	}
	try {
		const parsed = JSON.parse(text);
		return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export async function writeClaudeConfig(
	folder: vscode.WorkspaceFolder,
	server: McpServer,
): Promise<'written' | 'unparsable'> {

	const uri = claudeConfigUri(folder);
	const config = await readClaudeConfig(uri);
	if (config === undefined) {
		return 'unparsable';
	}

	config.mcpServers = { ...(config.mcpServers ?? {}) };
	config.mcpServers[serverName] = {
		type: 'http',
		url: server.url,
		headers: { Authorization: `Bearer ${server.token}` },
	};

	await writeText(uri, `${JSON.stringify(config, null, 2)}\n`);
	return 'written';
}

export function claudeCliCommand(server: McpServer): string {
	return `claude mcp add --transport http --scope local ${serverName} ${server.url} `
		+ `--header "Authorization: Bearer ${server.token}"`;
}

/* ------------------------------------------------------------------------ Codex */

/**
 * Writes our table into the project's `.codex/config.toml`.
 *
 * Three details matter, each learned from a broken file:
 *   - the newline style is taken from the existing file, otherwise the whole of
 *     somebody else's config shows up in the diff;
 *   - an existing table of ours is *replaced by line range*, not appended to —
 *     the same table twice is TOML that does not parse at all;
 *   - the table is located with the parser, not `text.includes('[mcp_servers.…]')`,
 *     because `[mcp_servers.ai-browser] # ours` is the same table.
 */
export async function writeCodexProjectConfig(
	folder: vscode.WorkspaceFolder,
	server: McpServer,
): Promise<void> {

	const uri = codexProjectConfigUri(folder);
	const existing = await readText(uri) ?? '';
	const newline = /\r\n/.test(existing) ? '\r\n' : '\n';

	const table = [
		`[mcp_servers.${serverName}]`,
		`url = "${server.urlWithToken}"`,
	];

	const lines = existing === '' ? [] : existing.split(/\r?\n/);
	const ours = codexEntries(existing).find(entry => entry.name === serverName);

	let next: string[];
	if (ours) {
		next = [...lines.slice(0, ours.firstLine), ...table, ...lines.slice(ours.endLine)];
	} else {
		next = lines.length ? [...lines, ...(lines.at(-1) === '' ? [] : ['']), ...table] : table;
	}

	let text = next.join(newline);
	if (!text.endsWith(newline)) {
		text += newline;
	}
	await writeText(uri, text);
}

/**
 * The command that adds us to the *global* Codex config.
 *
 * The extension never writes `~/.codex/config.toml` itself: that file belongs to
 * `codex mcp add`, which already knows how to leave other people's servers
 * alone.
 */
export function codexCliCommand(folder: vscode.WorkspaceFolder | undefined, server: McpServer): string {
	const name = folder ? codexEntryName(folder) : `${serverName}-window`;
	return `codex mcp add ${name} --url ${server.urlWithToken}`;
}

/* ---------------------------------------------------------------- connection UX */

/**
 * The text the user pastes into the assistant.
 *
 * Two lines, on purpose. It deliberately says nothing about "picking up the
 * server": both assistants read their MCP servers at startup and do not
 * re-read, so Claude Code has to be restarted and Codex needs a new
 * conversation. That belongs in the dialog, where the user is, not in a prompt
 * addressed to the model.
 */
export function connectionPrompt(client: 'claude' | 'codex', cliCommand: string): string {
	const source = client === 'claude' ? '`.mcp.json`' : '`.codex/config.toml`';
	return [
		`Use MCP \`${serverName}\` from ${source}`,
		`If it is not in the file, run \`${cliCommand}\`.`,
	].join('\n');
}

async function offer(
	title: string,
	detail: string,
	actions: { label: string; run: () => Thenable<void> }[],
): Promise<void> {
	const choice = await vscode.window.showInformationMessage(
		title, { modal: true, detail }, ...actions.map(a => a.label));
	await actions.find(a => a.label === choice)?.run();
}

export async function connectClaudeCode(server: McpServer): Promise<void> {
	const folder = workspaceFolder();
	const cli = claudeCliCommand(server);
	const actions: { label: string; run: () => Thenable<void> }[] = [];

	if (folder) {
		// One button for both halves: writing the entry and copying the prompt
		// were never useful separately — the prompt tells the assistant to read
		// exactly the entry the write creates.
		actions.push({
			label: vscode.l10n.t("Write .mcp.json & copy connection prompt"),
			run: async () => {
				const outcome = await writeClaudeConfig(folder, server);

				// The prompt is copied either way: its second line covers the case
				// where the entry is missing, which is precisely what an unparsable
				// file leaves behind.
				await vscode.env.clipboard.writeText(connectionPrompt('claude', cli));

				if (outcome === 'unparsable') {
					vscode.window.showErrorMessage(vscode.l10n.t(
						"`.mcp.json` could not be parsed, so it was left alone — rewriting it would drop the project's other MCP servers. Fix or delete it and try again. The prompt is on your clipboard and tells Claude Code how to add the server itself."));
					return;
				}

				vscode.window.showInformationMessage(vscode.l10n.t(
					"Wrote `.mcp.json` and copied the prompt. Restart Claude Code, then paste the prompt into its chat."));
			},
		});
	}

	actions.push({
		label: vscode.l10n.t("Copy CLI command"),
		run: () => vscode.env.clipboard.writeText(cli),
	});

	await offer(
		vscode.l10n.t("Connect Claude Code to the browser"),
		[
			vscode.l10n.t("Server: {0}", server.url ?? '—'),
			folder
				? vscode.l10n.t("The button below writes `.mcp.json` and puts a short prompt on your clipboard. Paste that prompt into the Claude Code chat — it tells the assistant to use the server from the file.")
				: vscode.l10n.t("No folder is open, so only the CLI command is available."),
			vscode.l10n.t("Claude Code reads MCP servers when it starts and does not re-read them — restart it before pasting the prompt."),
		].filter(Boolean).join('\n\n'),
		actions);
}

export async function connectCodex(server: McpServer): Promise<void> {
	const folder = workspaceFolder();
	const cli = codexCliCommand(folder, server);

	const actions: { label: string; run: () => Thenable<void> }[] = [];

	if (folder) {
		actions.push({
			label: vscode.l10n.t("1. Write .codex/config.toml"),
			run: async () => {
				await writeCodexProjectConfig(folder, server);
				vscode.window.showInformationMessage(vscode.l10n.t(
					"Wrote `.codex/config.toml`. Codex reads a project config once the repository is trusted; start a new conversation to pick it up."));
			},
		});
		actions.push({
			label: vscode.l10n.t("2. Copy connection prompt"),
			run: () => vscode.env.clipboard.writeText(connectionPrompt('codex', cli)),
		});
	}

	actions.push({
		label: vscode.l10n.t("Copy CLI command"),
		run: () => vscode.env.clipboard.writeText(cli),
	});

	await offer(
		vscode.l10n.t("Connect Codex to the browser"),
		[
			vscode.l10n.t("Server: {0}", server.url ?? '—'),
			vscode.l10n.t("Codex can only name a bearer token in its config, and the extension does not control its environment, so the token travels in the URL."),
			folder ? '' : vscode.l10n.t("No folder is open, so only the CLI command is available."),
			vscode.l10n.t("Codex reads MCP servers when a conversation starts — begin a new one after connecting."),
		].filter(Boolean).join('\n\n'),
		actions);
}
