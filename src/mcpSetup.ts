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
 * Renders our `[mcp_servers.<name>]` table.
 *
 * The credentials go in `http_headers`, as an **inline** table. Codex supports
 * `http_headers` (static), `env_http_headers` and `bearer_token_env_var`, so the
 * token does not need to sit in the URL after all — that was an earlier
 * misreading. Inline rather than a `[mcp_servers.<name>.http_headers]`
 * sub-table on purpose: a sub-table is a second table, and replacing ours by
 * line range would orphan it.
 */
function codexTable(name: string, server: McpServer): string[] {
	return [
		`[mcp_servers.${name}]`,
		`url = "${server.url}"`,
		`http_headers = { Authorization = "Bearer ${server.token}" }`,
	];
}

/**
 * Writes our table into a Codex config, replacing any previous copy.
 *
 * Details that each cost a broken file:
 *   - the newline style comes from the existing file, or the whole of somebody
 *     else's config turns up in the diff;
 *   - our table is *replaced by line range*, never appended to — the same table
 *     twice is TOML that does not parse at all, taking every other server in the
 *     file down with it;
 *   - a stale `[mcp_servers.<name>.http_headers]` sub-table is removed with it,
 *     since we no longer write that form and leaving it behind would apply
 *     headers to a table that has its own inline ones;
 *   - the table is found with the parser, not `text.includes('[mcp_servers.…]')`,
 *     because `[mcp_servers.ai-browser] # ours` is the same table.
 */
async function writeCodexConfig(
	uri: vscode.Uri,
	name: string,
	server: McpServer,
): Promise<void> {

	const existing = await readText(uri) ?? '';
	const newline = /\r\n/.test(existing) ? '\r\n' : '\n';
	const lines = existing === '' ? [] : existing.split(/\r?\n/);

	// Ours, plus any sub-table of ours, as line ranges to drop.
	const ranges = codexEntries(existing)
		.filter(entry => entry.name === name || entry.name.startsWith(`${name}.`))
		.map(entry => [entry.firstLine, entry.endLine] as const)
		.sort((a, b) => a[0] - b[0]);

	let next: string[];
	if (ranges.length) {
		next = [];
		let cursor = 0;
		for (const [from, to] of ranges) {
			next.push(...lines.slice(cursor, from));
			cursor = to;
		}
		const tail = lines.slice(cursor);
		next = [...next, ...codexTable(name, server), ...tail];
	} else {
		const table = codexTable(name, server);
		next = lines.length
			? [...lines, ...(lines.at(-1) === '' ? [] : ['']), ...table]
			: table;
	}

	let text = next.join(newline);
	if (!text.endsWith(newline)) {
		text += newline;
	}
	await writeText(uri, text);
}

/**
 * Writes the **global** `~/.codex/config.toml`.
 *
 * This is the one Codex always reads, on every surface. A project
 * `.codex/config.toml` is only loaded for *trusted* projects, and the desktop
 * app has been reported to ignore it entirely — which is exactly the "Codex
 * cannot see the server" symptom.
 *
 * The entry is named per project, so two projects do not overwrite each other.
 * Not locked: unlike a repair on startup, this runs on a button press, and two
 * windows racing for it would need the user to click in both at the same moment.
 */
export async function writeCodexGlobalConfig(
	folder: vscode.WorkspaceFolder | undefined,
	server: McpServer,
): Promise<string> {
	const name = folder ? codexEntryName(folder) : `${serverName}-window`;
	await writeCodexConfig(codexGlobalConfigUri(), name, server);
	return name;
}

export async function writeCodexProjectConfig(
	folder: vscode.WorkspaceFolder,
	server: McpServer,
): Promise<void> {
	await writeCodexConfig(codexProjectConfigUri(folder), serverName, server);
}

/**
 * The command that adds us to the global Codex config.
 *
 * Offered alongside the write because `codex mcp add` is the officially
 * supported route, and some people would rather run it than have a file edited.
 */
export function codexCliCommand(folder: vscode.WorkspaceFolder | undefined, server: McpServer): string {
	const name = folder ? codexEntryName(folder) : `${serverName}-window`;
	return `codex mcp add ${name} --url ${server.url}`;
}

/* ---------------------------------------------------------------- connection UX */

/**
 * The text the user pastes into the assistant.
 *
 * It names the **tools**, not a config file, and that is the important part.
 * Both assistants load MCP servers when they start and never re-read the
 * config, so if the server is loaded the tools are already in the session and
 * no prompt is needed at all; and if it is not loaded, telling the model to go
 * and read `config.toml` cannot help — it will read the file, agree the server
 * is configured, and still have no tools. That instruction was in here, and it
 * is exactly what made Codex look stupid.
 *
 * The fallback line therefore points at the CLI command, which changes the
 * config for the *next* session, rather than at the file.
 *
 * It also asks for a *check*, not for work. The line used to end "to inspect
 * the page in the integrated browser", and both assistants read that as the
 * task: they went straight to the browser and started reporting on whatever
 * page happened to be open, before the user had asked for anything. All this
 * paste is for is finding out whether the tools arrived.
 */
export function connectionPrompt(entryName: string, cliCommand: string): string {
	return [
		`Do you have the \`${entryName}\` MCP tools (they start with \`browser_\`)? Just check — do not use them yet.`,
		`If you have no such tools, they were not loaded at startup: run \`${cliCommand}\` and start a new session.`,
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
				await vscode.env.clipboard.writeText(connectionPrompt(serverName, cli));

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

	// The project file leads, matching Claude Code: one button that writes the
	// entry and copies the prompt. The global config is the fallback below —
	// note that it is the one Codex always reads, whereas a *project* config is
	// only loaded for trusted projects, which is the usual reason Codex cannot
	// see the server.
	if (folder) {
		actions.push({
			label: vscode.l10n.t("Write .codex/config.toml & copy connection prompt"),
			run: async () => {
				try {
					await writeCodexProjectConfig(folder, server);
					await vscode.env.clipboard.writeText(connectionPrompt(serverName, cli));
					vscode.window.showInformationMessage(vscode.l10n.t(
						"Wrote `.codex/config.toml` and copied the prompt. Start a NEW Codex conversation, then paste it. If Codex still has no browser tools, the project is probably not trusted — use the global config instead."));
				} catch (err) {
					await vscode.env.clipboard.writeText(cli);
					vscode.window.showErrorMessage(vscode.l10n.t(
						"Could not write `.codex/config.toml` ({0}). The `codex mcp add` command is on your clipboard instead.",
						err instanceof Error ? err.message : String(err)));
				}
			},
		});
	}

	actions.push({
		label: vscode.l10n.t("Write global ~/.codex/config.toml"),
		run: async () => {
			try {
				const name = await writeCodexGlobalConfig(folder, server);
				await vscode.env.clipboard.writeText(connectionPrompt(name, cli));
				vscode.window.showInformationMessage(vscode.l10n.t(
					"Added `{0}` to ~/.codex/config.toml and copied the prompt. Start a NEW Codex conversation, then paste it.",
					name));
			} catch (err) {
				await vscode.env.clipboard.writeText(cli);
				vscode.window.showErrorMessage(vscode.l10n.t(
					"Could not write ~/.codex/config.toml ({0}). The `codex mcp add` command is on your clipboard instead.",
					err instanceof Error ? err.message : String(err)));
			}
		},
	});

	actions.push({
		label: vscode.l10n.t("Copy CLI command"),
		run: () => vscode.env.clipboard.writeText(cli),
	});

	await offer(
		vscode.l10n.t("Connect Codex to the browser"),
		[
			vscode.l10n.t("Server: {0}", server.url ?? '—'),
			folder
				? vscode.l10n.t("The first button writes the project's `.codex/config.toml` and puts a short prompt on your clipboard. Paste that prompt into a Codex conversation.")
				: vscode.l10n.t("No folder is open, so only the global config and the CLI command are available."),
			vscode.l10n.t("Codex loads MCP servers only when a conversation starts and never re-reads the config — start a NEW conversation after connecting. If it says it cannot see the server, it was not loaded, and sending it to read config.toml will not change that."),
			vscode.l10n.t("A project config is only loaded for projects Codex trusts, and some surfaces ignore it entirely. If the tools do not turn up, use the global config."),
		].filter(Boolean).join('\n\n'),
		actions);
}
