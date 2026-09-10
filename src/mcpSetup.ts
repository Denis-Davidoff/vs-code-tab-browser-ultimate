/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { codexEntries } from './codexToml';
import { lockPath, withLock } from './fileLock';
import { serverName } from './mcpClientState';
import {
	codexTableLines, repairClaudeJson, repairCodexToml, spliceCodexTables, type Endpoint,
} from './mcpRepair';
import type { McpServer } from './mcpServer';
import { confirm } from './notify';

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

/**
 * Claude Code's own `~/.claude.json`.
 *
 * Read only, and only to *report* the local-scope entries that shadow
 * `.mcp.json` — see `claudeLocalScopeShadows`. This file holds Claude Code's
 * credentials and history; we do not write it.
 */
export function claudeLocalConfigUri(): vscode.Uri {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
	return vscode.Uri.file(`${home}/.claude.json`);
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

/**
 * The command that adds us to Claude Code, for when writing the file failed.
 *
 * **`--scope project`, never `--scope local`.** Local scope lives in
 * `~/.claude.json` under `projects[cwd].mcpServers`, and it *overrides*
 * `.mcp.json` — so a local-scope copy shadows the very file this extension
 * maintains. Once one exists, pressing Connect rewrites `.mcp.json` and nothing
 * reads it: the assistant keeps using whatever port the shadow was written
 * with, forever. That is exactly how a stale port turned into "Claude cannot
 * see the browser and reconnecting does not help".
 *
 * `--scope project` writes the same `.mcp.json` we write, so the two can never
 * disagree.
 */
export function claudeCliCommand(server: McpServer): string {
	return `claude mcp add --transport http --scope project ${serverName} ${server.url} `
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
/**
 * The endpoint description the writers and the repair share.
 *
 * `server.url` is read through a getter backed by the live port, so it becomes
 * `undefined` the moment the server is disposed — a setting toggled, a window
 * closing. Anything that reads it *after* an await can therefore find nothing
 * there and write `url = ""` into the user's config. Callers on an unattended
 * path capture it once, up front, and pass it in; the `?? ''` here is the
 * last resort for the click paths, which hold a live server by construction.
 */
function endpoint(server: McpServer, name: string, url = server.url ?? ''): Endpoint {
	return { url, token: server.token, name };
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

	// Ours, plus any sub-table of ours, as line ranges to drop. The splice
	// itself lives in `mcpRepair.ts` because the startup repair needs exactly
	// the same operation, and two copies of it would be two chances to write
	// TOML that does not parse.
	const ranges = codexEntries(existing)
		.filter(entry => entry.name === name || entry.name.startsWith(`${name}.`))
		.map(entry => [entry.firstLine, entry.endLine] as const);

	const next = spliceCodexTables(lines, ranges, codexTableLines(name, endpoint(server, name)));

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
 *
 * **Locked.** This used to be unlocked, on the reasoning that a button press
 * cannot race itself. That stopped being true when the startup repair started
 * writing the same file: a machine restoring a session opens every window at
 * once, each repairing its own entry, and a Connect click can land in the
 * middle of that. Two interleaved read-modify-writes of one TOML file lose an
 * entry at best and corrupt every MCP server the user has at worst.
 */
/**
 * The lock name for one config file.
 *
 * Derived from the URI so that the connect path and the startup repair, which
 * are different call sites writing the same file, take the *same* lock. Two
 * lock names for one file is the same as no lock at all.
 */
export function configLockName(uri: vscode.Uri): string {
	return crypto.createHash('sha1').update(uri.toString()).digest('hex').slice(0, 12);
}

export function codexGlobalLock(): string {
	return lockPath(configLockName(codexGlobalConfigUri()));
}

export async function writeCodexGlobalConfig(
	folder: vscode.WorkspaceFolder | undefined,
	server: McpServer,
): Promise<string> {
	const name = folder ? codexEntryName(folder) : `${serverName}-window`;
	const wrote = await withLock(codexGlobalLock(), () =>
		writeCodexConfig(codexGlobalConfigUri(), name, server));
	if (!wrote) {
		throw new Error('another window is writing ~/.codex/config.toml');
	}
	return name;
}

/*
 * There is deliberately no `writeCodexProjectConfig` any more. Connect Codex
 * writes the global file, for the reasons in the doc comment above it, and a
 * writer nothing calls is a writer that drifts out of step with the one that
 * is used. Project `.codex/config.toml` files written by earlier releases are
 * still *read* — by the check and by the repair — so they keep working.
 */

/**
 * The command that adds us to the global Codex config.
 *
 * Offered alongside the write because `codex mcp add` is the officially
 * supported route, and some people would rather run it than have a file edited.
 */
export function codexCliCommand(folder: vscode.WorkspaceFolder | undefined, server: McpServer): string {
	const name = folder ? codexEntryName(folder) : `${serverName}-window`;
	// **The token has to travel.** This command is handed over on exactly the
	// path where writing the config failed, so it has to stand on its own — and
	// without credentials the entry it creates answers 401 on every call, which
	// reads as a broken server rather than as a command missing an argument.
	//
	// The token rides in the URL path rather than in a header flag: the server
	// accepts that form (rule 4 of the security model, kept for exactly this
	// kind of client), it needs no `codex mcp add` option this project has
	// verified, and the startup repair still recognises the entry, because it
	// matches on the token wherever the token sits.
	return `codex mcp add ${name} --url ${server.urlWithToken ?? server.url}`;
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
 * It also asks for a *check*, not for work. The line used to end "to inspect
 * the page in the integrated browser", and both assistants read that as the
 * task: they went straight to the browser and started reporting on whatever
 * page happened to be open, before the user had asked for anything.
 *
 * **And it tells the model not to configure anything itself.** The second line
 * used to hand over `claude mcp add …`, and the condition guarding it — "if you
 * have no such tools" — is *always true* at the moment this prompt is pasted,
 * because the config was written seconds ago and neither assistant re-reads it.
 * So the fallback fired every single time: the model dutifully added a second,
 * local-scope copy of the server, which then shadowed the `.mcp.json` this
 * extension maintains and pinned the assistant to a port that would later go
 * stale. Every subsequent Connect fixed a file nothing read. The CLI command is
 * still offered — but only on the path where writing the file actually failed.
 */
export function connectionPrompt(entryName: string, shared?: SharedPage): string {
	const lines = [
		`Do you have the \`${entryName}\` MCP tools (they start with \`browser_\`)? Just check — do not use them yet.`,
		`If you have none, they were simply not loaded at startup. The config is already written and correct, so just restart your session — do not add or edit any MCP configuration yourself.`,
	];
	if (shared) {
		// Stated, not asked for: the paste is still a *check*, and the rule that
		// it must not send the model off to inspect a page stands. This line
		// exists so the model does not go looking for a tab to select — the user
		// has already chosen one.
		lines.push(`For when you do use them: the user has given you one browser tab — ${shared.title ?? shared.url}`
			+ ` (${shared.url}). Every browser tool of yours acts on that tab, and only that tab; you cannot and need`
			+ ' not select another, and other tabs in the window are not yours to read.');
	}
	return lines.join('\n');
}

/**
 * Connecting is one click and no dialog.
 *
 * There used to be a modal with two or three buttons on it. It asked questions
 * whose answer never varied — of course the file should be written, of course
 * the prompt should be copied — and it stood between the user and the one
 * thing they wanted. Now the click does the work and says what it did.
 *
 * The confirmation goes through {@link confirm}, not `showInformationMessage`,
 * and that is not a style choice: a notification paints over the built-in
 * browser and pauses the live page behind it. Connecting is very often done
 * with a browser tab open, so a success toast here would freeze exactly the
 * page the user is about to ask an assistant to work on. Failures still get a
 * real notification — they need attention, and they are rare.
 */
/** The page a connect pinned the assistants to, if there was one. */
export interface SharedPage {
	readonly url: string;
	readonly title?: string;
	/** Who it was given to, as it reads in a sentence: `Claude Code`, `all assistants`. */
	readonly label?: string;
}

/**
 * What the confirmation says about *which page* the assistant will drive.
 *
 * Connecting attaches an assistant to the **window**, and that is exactly the
 * thing nobody reads twice: "Connect Claude Code" invites the belief that it is
 * bound to the tab in front of you, so the tools then followed whichever tab
 * was active and looked broken. Reported as "the agents go into the active tab,
 * not the one I connected them to" — with the share never pressed at all.
 *
 * So a connect made from a browser tab now shares that tab, and a connect made
 * from anywhere else says what the alternative is.
 */
function scopeNote(shared: SharedPage | undefined): string {
	return shared
		? vscode.l10n.t(" {0} works on {1} — use \"Stop Sharing Tab\" to let it follow you again.",
			shared.label ?? vscode.l10n.t("It"), shared.title ?? shared.url)
		// The command is named, so the title has to be the one the palette
		// actually has: it was renamed in the same change that added this
		// sentence, and naming a title nobody can find is worse than naming
		// none.
		: vscode.l10n.t(" The tools follow whichever browser tab you are looking at;"
			+ " run \"Share Tab with Claude Code\" or \"Share Tab with Codex\" from a tab to give one away.");
}

export async function connectClaudeCode(server: McpServer, shared?: SharedPage): Promise<void> {
	const folder = workspaceFolder();
	if (!folder) {
		await vscode.env.clipboard.writeText(claudeCliCommand(server));
		// The tab was given away before this ran, so the message says so.
		// Silence here left an assignment the user was never told about — and
		// closing that tab later paused every Claude call with advice about a
		// share they did not remember making.
		vscode.window.showWarningMessage(vscode.l10n.t(
			"No folder is open, so there is no `.mcp.json` to write. The `claude mcp add` command is on your clipboard instead.")
			+ scopeNote(shared));
		return;
	}

	const outcome = await writeClaudeConfig(folder, server);
	if (outcome === 'unparsable') {
		await vscode.env.clipboard.writeText(claudeCliCommand(server));
		vscode.window.showErrorMessage(vscode.l10n.t(
			"`.mcp.json` could not be parsed, so it was left alone — rewriting it would drop the project's other MCP servers. Fix or delete it and try again. The `claude mcp add` command is on your clipboard instead.")
			+ scopeNote(shared));
		return;
	}

	await vscode.env.clipboard.writeText(connectionPrompt(serverName, shared));
	confirm(vscode.l10n.t(
		"Wrote .mcp.json, prompt copied — restart Claude Code, then paste it.") + scopeNote(shared));
}

/**
 * Connects Codex by writing the **global** `~/.codex/config.toml`.
 *
 * The project file used to lead, on the reasoning that a server belongs with
 * the project it serves. Dropping the dialog forced the question, and the
 * global file wins it: a project `.codex/config.toml` is only loaded for
 * projects Codex *trusts*, and the desktop surface has been reported to ignore
 * it outright (openai/codex#13025). That is the usual reason "Codex cannot see
 * the server", and a one-click action must not land on the option that
 * sometimes silently does nothing.
 *
 * Writing both was considered and is wrong: the two entries have different
 * names — the project file uses the bare `ai-browser`, the global one a
 * per-project name — so Codex would load both and list every tool twice.
 */
export async function connectCodex(server: McpServer, shared?: SharedPage): Promise<void> {
	const folder = workspaceFolder();
	try {
		const name = await writeCodexGlobalConfig(folder, server);
		await vscode.env.clipboard.writeText(connectionPrompt(name, shared));
		confirm(vscode.l10n.t(
			"Wrote ~/.codex/config.toml, prompt copied — start a NEW Codex conversation, then paste it.")
			+ scopeNote(shared));
	} catch (err) {
		await vscode.env.clipboard.writeText(codexCliCommand(folder, server));
		vscode.window.showErrorMessage(vscode.l10n.t(
			"Could not write ~/.codex/config.toml ({0}). The `codex mcp add` command is on your clipboard instead.",
			err instanceof Error ? err.message : String(err)) + scopeNote(shared));
	}
}

/* ---------------------------------------------------------------------- repair */

/** What {@link repairConfigs} changed, for the caller to report. */
export interface RepairReport {
	/** Human-readable names of the files that were rewritten. */
	readonly files: string[];
	/** Entries that were ours and were folded into the canonical one. */
	readonly collapsed: string[];
	/** True when the global Codex file was skipped because another window held the lock. */
	readonly lockBusy: boolean;
}

/**
 * Brings this window's entries in every assistant config back into line.
 *
 * Runs on every start, right after the port is known. What it fixes is the one
 * failure this whole area kept producing: the port is written into a config
 * once, at connect time, and a window's port can change between restarts, so
 * the entry ends up addressing a *neighbour's* window and the workspace-scoped
 * token turns that into a bare 401. The assistant then reports "no tools" and
 * nothing about the situation says why.
 *
 * Three properties make this safe to do unattended, and all three matter:
 *
 *   - **It only ever touches entries carrying our own token.** Identification
 *     is by token, never by name or URL — see `mcpRepair.ts` for why. An entry
 *     that merely looks like ours may be another window's live entry.
 *   - **It never creates a file or an entry.** An absent config is left absent:
 *     repairing is not connecting, and a window must not quietly wire an
 *     assistant the user never connected.
 *   - **It is silent unless something actually changed**, which is rare — only
 *     when the port moved or an old duplicate was still lying around.
 */
export async function repairConfigs(server: McpServer): Promise<RepairReport> {
	const report: RepairReport = { files: [], collapsed: [], lockBusy: false };

	// Captured before the first await. `server.url` goes undefined when the
	// server is disposed, and a repair can be waiting on a lock when that
	// happens — reading it later would write an empty URL into the config.
	const url = server.url;
	if (!url) {
		return report;
	}

	const folder = workspaceFolder();
	let busy = false;

	/**
	 * Reads, repairs and writes one config, under that file's own lock.
	 *
	 * Every file here is locked, not just the global one. Two windows on the
	 * *same folder* share a token and hold different ports, so both recognise
	 * the same entry as theirs and both rewrite it — the lock does not settle
	 * which of them wins (last start does) but it does keep the two
	 * read-modify-writes from interleaving into a broken file.
	 */
	const apply = async (uri: vscode.Uri, label: string, repair: (text: string) => {
		text: string; changed: boolean; collapsed: readonly string[];
	}): Promise<void> => {
		const took = await withLock(lockPath(configLockName(uri)), async () => {
			const text = await readText(uri);
			if (text === undefined) {
				return; // absent: repairing is not connecting
			}
			const result = repair(text);
			if (!result.changed) {
				return;
			}
			await writeText(uri, result.text);
			report.files.push(label);
			report.collapsed.push(...result.collapsed);
		});
		// Losing a race is not an error: the next start repairs it.
		busy ||= !took;
	};

	if (folder) {
		await apply(claudeConfigUri(folder), '.mcp.json', text =>
			repairClaudeJson(text, endpoint(server, serverName, url)));

		await apply(codexProjectConfigUri(folder), '.codex/config.toml', text =>
			repairCodexToml(text, codexEntries(text), endpoint(server, serverName, url)));
	}

	const globalName = folder ? codexEntryName(folder) : `${serverName}-window`;
	await apply(codexGlobalConfigUri(), '~/.codex/config.toml', text =>
		repairCodexToml(text, codexEntries(text), endpoint(server, globalName, url)));

	return busy ? { ...report, lockBusy: true } : report;
}
