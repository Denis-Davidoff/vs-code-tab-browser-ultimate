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
	codexDeadTables, codexTableLines, removeCodexTables, repairClaudeJson, repairCodexToml,
	spliceCodexTables, type Endpoint,
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

/**
 * A config read that tells "there is no such file" from "I could not read it".
 *
 * A plain `try/catch` answering `undefined` for both is fine for a caller that
 * only wants the contents — `mcpCheck.ts` keeps one, because misreading a state
 * in a report costs a wrong line and nothing more. Every reader in *this* file
 * acts on what it reads, and for both of them the collapse was harmful:
 *
 *   - the **repair** decides whether a run was complete, and `complete` is what
 *     licenses tombstoning a dead workspace. An unreadable file read as absent
 *     made a window report a complete run and lay the stone, after which
 *     `deadWorkspaceTokens` skips that folder for good — so the entry sitting
 *     in the file nobody managed to open is never looked at again.
 *   - the **connect** writers rebuild the file from what they read, so the same
 *     collapse replaced a global `~/.codex/config.toml`, or a committed and
 *     team-shared `.mcp.json`, with our single entry — deleting every other MCP
 *     server the user had, and reporting success. That path is the destructive
 *     one and it had the weaker read of the two, which is the wrong way round.
 *
 * Same rule as `presence()`: only a clean `FileNotFound` proves absence.
 */
type ConfigRead =
	| { readonly kind: 'absent' }
	| { readonly kind: 'unreadable' }
	| { readonly kind: 'text'; readonly text: string };

async function readConfig(uri: vscode.Uri): Promise<ConfigRead> {
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		return { kind: 'text', text: Buffer.from(bytes).toString('utf8') };
	} catch (err) {
		return isFileNotFound(err) ? { kind: 'absent' } : { kind: 'unreadable' };
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
	// `readConfig`, not `readText`: this is a *destructive* reader — whatever it
	// returns is what the file is rebuilt from — so "I could not read it" must
	// not arrive here as `{}`. It did, and the consequence was total: a
	// transient read error (EMFILE under load, a hiccup on a network home) made
	// the write replace a committed, team-shared `.mcp.json` with nothing but
	// our own entry, and report success. The distinction was already written
	// next door for the *repair*, where the same failure only costs a skipped
	// run; the path that rewrites the file had the weaker read of the two.
	const read = await readConfig(uri);
	if (read.kind === 'unreadable') {
		return undefined; // refuse, exactly as for unparsable
	}
	if (read.kind === 'absent' || read.text.trim() === '') {
		return {};
	}
	try {
		const parsed = JSON.parse(read.text);
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

	// Same rule as `readClaudeConfig`: this rebuilds the file from what it reads,
	// so an unreadable config must stop the write rather than be read as empty.
	// `~/.codex/config.toml` is global — treating a read error as "no file"
	// replaced every MCP server on the machine with our one table, and the
	// button still said it had succeeded. The throw lands in `connectCodex`'s
	// catch, which reports it and puts `codex mcp add` on the clipboard.
	const read = await readConfig(uri);
	if (read.kind === 'unreadable') {
		throw new Error('the existing config could not be read');
	}
	const existing = read.kind === 'absent' ? '' : read.text;
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
			"`.mcp.json` could not be read or parsed, so it was left alone — rewriting it would drop the project's other MCP servers. Fix or delete it and try again. The `claude mcp add` command is on your clipboard instead.")
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

/* ----------------------------------------------------------------------- prune */

/**
 * The `globalState` key prefix under which every workspace token is kept.
 *
 * Owned here rather than in `mcpLifecycle.ts`, where the tokens are minted,
 * because reading the *whole set* of them back is now a second use of the same
 * convention and two spellings of a storage key is the same as no key at all.
 */
export const tokenKeyPrefix = 'mcp.token:';

/**
 * The `globalState` key prefix under which each window records that it is alive.
 *
 * **A missing folder does not prove its token is unused, and that gap could
 * delete a live server's entry.** The MCP server authorizes by token alone; it
 * holds its token and port in memory and nothing subscribes to
 * `onDidChangeWorkspaceFolders`, so a window whose folder is deleted or
 * *renamed* on disk keeps listening and keeps answering. Another window
 * starting at that moment saw only "folder gone" and pruned the entry of a
 * server that was answering.
 *
 * So a window stamps its own folder here, at activation and on a timer, and a
 * token is prunable only once nobody has stamped it for {@link seenGraceMs}.
 */
export const seenKeyPrefix = 'mcp.seen:';

/**
 * How long a workspace must go unserved before its entry may be pruned.
 *
 * Seven days rather than hours, deliberately: the entries this cleans up
 * accumulate over months, so nothing is lost by waiting, while a short window
 * would start betting against an extension host that was merely suspended. The
 * heartbeat ticks hourly, so the margin is 168 ticks — stated as a number
 * because "orders of magnitude" was wrong by one and anyone shortening the
 * grace period would have trusted a safety factor that never existed.
 */
export const seenGraceMs = 7 * 24 * 60 * 60 * 1000;

/**
 * Marks a workspace whose entries have already been pruned.
 *
 * **A tombstone, because deleting `mcp.token:<folderUri>` destroys the
 * workspace's identity, and that identity is used for more than this prune.**
 * `_workspaceToken` mints a fresh token when the key is gone, which the comment
 * above it forbids in as many words — "never regenerate it for an existing
 * workspace, every config naming that window would stop being recognisable at
 * once". A folder can come back at the same URI (`git worktree remove` then
 * `add`, a restore from the Trash, a re-clone into the same directory), and
 * `.mcp.json` is *designed to be committed*, so a re-clone brings it back
 * carrying the old token. Regenerate, and `repairClaudeJson` — which matches by
 * token — can no longer see that entry to fix it: every call 401s and the
 * assistant reports no tools, with nothing able to repair it.
 *
 * So the token stays and the folder is tombstoned instead. The scan skips it,
 * which is all the unbounded-scan problem ever needed, and `markWorkspaceAlive`
 * lifts the stone the moment a window serves that folder again.
 */
export const prunedKeyPrefix = 'mcp.pruned:';

/** `mcp.token:<folderUri>` -> the token, for every folder we have ever served. */
export type TokenStore = Pick<vscode.Memento, 'keys' | 'get' | 'update'>;

/** Tokens proven dead, and the `globalState` keys that held them. */
export interface DeadWorkspaces {
	readonly tokens: Set<string>;
	/**
	 * Folder URIs to tombstone once the prune has actually landed.
	 *
	 * It bounds the scan, but only over the folders it actually buries, and the
	 * distinction is worth stating because the obvious reading is wrong: a
	 * folder that still *exists* and simply has not been opened for a while
	 * never gets a stone, so it is stat'd again on every activation and every
	 * `aiBrowser.mcp.*` change, for the life of the machine. On a long project
	 * history that is a few hundred `stat` calls per run — parallel and each
	 * capped at {@link statTimeoutMs}, so it is cheap rather than free.
	 *
	 * Tombstoning must wait for a **complete** repair: a run that lost the lock,
	 * or could not read a config that exists, would lay the stone before the
	 * entry it identifies is gone — and then nothing ever looks again.
	 */
	readonly folders: string[];
}

/**
 * Records that this window is serving `folder`, for the prune's grace period.
 *
 * It also lifts any tombstone: a folder that is being served is by definition
 * back, and leaving the stone would hide it from the scan forever if it were
 * ever to disappear a second time.
 *
 * **It returns its promise rather than discarding it**, and every caller either
 * awaits it inside a guarded chain or attaches its own `catch`. `Memento.update`
 * can reject — it persists the whole memento through the main process — and a
 * `void`-ed rejection is an unhandled rejection in the extension host, which is
 * the same defect as item 93 one layer down, in the helper written to fix it.
 */
export async function markWorkspaceAlive(
	store: TokenStore,
	folder: vscode.WorkspaceFolder | undefined,
): Promise<void> {
	if (!folder) {
		return; // a window with no folder has no entry anybody could prune
	}
	if (folder.uri.scheme !== 'file') {
		// The scan only ever considers `file:` folders, so a stamp for anything
		// else is a row in `globalState` nothing will ever read — one per remote
		// workspace, for ever.
		return;
	}
	const raw = folder.uri.toString();
	// Stone first, stamp second, and each awaited. If only the first lands the
	// folder is visible to the scan with no stamp, which seeds a fresh grace
	// period — it self-heals. The other order would leave it stamped but
	// hidden, which is stale rather than wrong but never corrects itself.
	if (store.get(`${prunedKeyPrefix}${raw}`) !== undefined) {
		await store.update(`${prunedKeyPrefix}${raw}`, undefined);
	}
	await store.update(`${seenKeyPrefix}${raw}`, Date.now());
}

/**
 * Records that this folder's entries have been pruned, keeping its token.
 *
 * The heartbeat goes, since nothing reads it under a stone; the token stays,
 * for the reason written on {@link prunedKeyPrefix}.
 */
export async function markWorkspacePruned(store: TokenStore, folderUri: string): Promise<void> {
	// The stone goes down first: if the second write is the one that fails, the
	// folder is tombstoned with a stale stamp, which the scan simply skips. The
	// other order leaves it visible with no stamp, so the next start seeds a
	// grace period and the whole seven days begin again.
	await store.update(`${prunedKeyPrefix}${folderUri}`, true);
	await store.update(`${seenKeyPrefix}${folderUri}`, undefined);
}

/**
 * Tokens of ours whose workspace folder no longer exists on disk.
 *
 * `globalState` is shared across every window of this extension, so it holds a
 * `mcp.token:<folderUri>` entry for each folder this extension has ever served
 * on this machine. That is the piece the Codex "strangers" report never had:
 * it could only say an entry *looked* like ours by name, which is why it
 * refused to touch anything and asked the user to run `codex mcp remove` by
 * hand. With the minted tokens in view, an entry can be shown to be ours and
 * its project shown to be gone — and only then is it safe to delete.
 *
 * Six things are deliberately **not** treated as dead, because each is a live
 * project that merely cannot be seen from here — and the list has to be complete,
 * since it is what anyone auditing "what can stop a deletion" will read:
 *
 *   - a token whose folder is still there, obviously, including this window's;
 *   - the `no-folder` token, which never named a folder to check;
 *   - a folder on a non-`file` URI — a remote or virtual workspace, where the
 *     extension host answering this question is on a different machine from the
 *     one that holds the folder;
 *   - a folder whose **parent directory is missing too**. That is what an
 *     unmounted volume or an unreachable network share looks like: the whole
 *     branch is absent, not the project. Only a folder whose parent is still
 *     there is provably gone rather than merely unreachable. It costs a false
 *     negative on a project deleted together with its parent, which is the safe
 *     direction — a missed entry is tidied next time, a wrongly deleted one
 *     costs somebody a reconnect;
 *   - a folder some window has stamped within {@link seenGraceMs}. This is the
 *     one the liveness argument actually rests on, and it was missing from this
 *     list while being the answer to "a folder can be gone while its server is
 *     still serving";
 *   - a folder already under a tombstone: it has been dealt with, and looking
 *     again is what the stone exists to stop.
 */
export async function deadWorkspaceTokens(
	store: TokenStore,
	ourToken: string,
	now = Date.now(),
): Promise<DeadWorkspaces> {
	const candidates: { raw: string; token: string; uri: vscode.Uri }[] = [];

	for (const key of store.keys()) {
		if (!key.startsWith(tokenKeyPrefix)) {
			continue;
		}
		const token = store.get<string>(key);
		if (typeof token !== 'string' || token === '' || token === ourToken) {
			continue;
		}

		const raw = key.slice(tokenKeyPrefix.length);
		if (raw === 'no-folder') {
			continue;
		}
		if (store.get(`${prunedKeyPrefix}${raw}`) !== undefined) {
			continue; // already pruned; the token is kept, the scan moves on
		}

		let uri: vscode.Uri;
		try {
			uri = vscode.Uri.parse(raw, true);
		} catch {
			continue;
		}
		if (uri.scheme !== 'file') {
			continue;
		}

		// A window that is still serving this folder, however absent the folder
		// itself is. Without this the prune races a live server.
		const seenKey = `${seenKeyPrefix}${raw}`;
		const seen = store.get<number>(seenKey);
		if (typeof seen !== 'number') {
			// A workspace from before the heartbeat existed: there is no
			// evidence either way, and "no evidence" must not read as "dead"
			// — a window running an older build is exactly the live one we
			// cannot see. Start its grace period now and leave it alone.
			await store.update(seenKey, now);
			continue;
		}
		if (now - seen < seenGraceMs) {
			continue;
		}

		candidates.push({ raw, token, uri });
	}

	// In parallel, because this is a list of every folder ever opened and the
	// checks are independent. Each one is bounded by `statTimeoutMs`, so a
	// single stalled mount costs that budget rather than blocking the rest.
	const verdicts = await Promise.all(candidates.map(c => folderIsGone(c.uri)));

	const tokens = new Set<string>();
	const folders: string[] = [];
	for (const [at, gone] of verdicts.entries()) {
		if (gone) {
			tokens.add(candidates[at].token);
			folders.push(candidates[at].raw);
		}
	}

	return { tokens, folders };
}

/**
 * How long one `stat` may take before the answer is "cannot tell".
 *
 * `workspace.fs.stat` has no timeout of its own, and one of the paths in the
 * list may well be on a mount that has stopped answering. Without a budget that
 * single folder holds up the repair behind it — the same failure shape as the
 * unbounded CDP call inside a transition.
 */
const statTimeoutMs = 2000;

/**
 * Three answers, and collapsing them to two is how a live project gets deleted.
 *
 * `unknown` is everything that is not a clean "no such file": `NoPermissions`
 * (macOS gates `~/Documents` and `~/Desktop` behind TCC, and the first `stat`
 * after an update can fail there), a transient I/O error, a provider that
 * cannot reach its backing store, a stalled mount. Every one of those happens
 * to a folder that is very much alive, and treating them as absence — which
 * a bare `catch { return false }` does — silently deletes that project's Codex
 * entry at startup.
 *
 * The parent-directory guard does not cover this: it proves the *branch* is
 * mounted, so it catches a detached volume, and says nothing about an error
 * landing on the folder itself while its parent reads fine.
 *
 * A dangling symlink is safe either way. VS Code's disk provider resolves one
 * to `SymbolicLink | Unknown` and returns it rather than throwing, so it reads
 * as `present`; a provider that throws something else instead lands on
 * `unknown`. Only a clean `FileNotFound` prunes.
 */
type Presence = 'present' | 'missing' | 'unknown';

async function presence(uri: vscode.Uri): Promise<Presence> {
	let timer: NodeJS.Timeout | undefined;
	try {
		const answer = await Promise.race([
			vscode.workspace.fs.stat(uri).then(() => 'present' as const),
			new Promise<'unknown'>(resolve => {
				timer = setTimeout(() => resolve('unknown'), statTimeoutMs);
			}),
		]);
		return answer;
	} catch (err) {
		return isFileNotFound(err) ? 'missing' : 'unknown';
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Whether an error is specifically "there is no such file".
 *
 * `FileSystemError.code` is read off the value rather than through
 * `instanceof`: a file system provider is free to reject with its own error,
 * and a Node-style `ENOENT` reaches us the same way. Anything unrecognised is
 * *not* a proof of absence, which is the direction that matters.
 */
function isFileNotFound(err: unknown): boolean {
	const code = (err as { code?: unknown } | undefined)?.code;
	return code === 'FileNotFound' || code === 'ENOENT';
}

/**
 * Proven missing, *and* its parent proven present.
 *
 * Both halves have to be definite. The folder must answer `missing` — not
 * merely fail — and the parent must answer `present`, since an `unknown` there
 * is exactly what an unmounted volume or an unreachable share looks like.
 */
async function folderIsGone(uri: vscode.Uri): Promise<boolean> {
	if (await presence(uri) !== 'missing') {
		return false;
	}
	const parent = uri.with({ path: uri.path.replace(/\/[^/]+\/?$/, '') });
	if (parent.path === uri.path || parent.path === '') {
		return false;
	}
	return await presence(parent) === 'present';
}

/* ---------------------------------------------------------------------- repair */

/** What {@link repairConfigs} changed, for the caller to report. */
export interface RepairReport {
	/** Human-readable names of the files that were rewritten. */
	readonly files: string[];
	/** Codex entries removed because the project they were written for is gone. */
	readonly removed: string[];
	/**
	 * Folder URIs whose death was decided **under the lock** on this run.
	 *
	 * These, and not the caller's own earlier scan, are what may be tombstoned:
	 * a folder that came back in between is simply absent from this list.
	 */
	readonly pruned: string[];
	/**
	 * True when every config was actually examined.
	 *
	 * False when the server had no URL to write, when another window held a lock
	 * and that file was skipped, or when a config that exists could not be read.
	 * The caller must not act on the run as if it were final — tombstoning after
	 * an incomplete run takes the folder out of the scan while its entry may
	 * still be sitting in a file this run never managed to open.
	 */
	readonly complete: boolean;
}

/** What one config rewrite produced, for {@link repairConfigs} to account for. */
interface Rewrite {
	readonly text: string;
	/** True when anything at all changed and the file is worth writing. */
	readonly changed: boolean;
	/** Codex tables dropped because the project they name is gone. */
	readonly removed: readonly string[];
	/** True when the *repair* changed something, as opposed to the prune. */
	readonly repaired: boolean;
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
 *
 * It also **prunes** Codex entries of ours whose project folder is gone, which
 * is the one thing here that deletes rather than corrects. It rests on the same
 * rule: an entry is identified by its token, and `deadWorkspaceTokens` admits
 * only tokens this extension minted itself, for folders it has checked are
 * missing while their parent directory is not. Anything it cannot prove — an
 * entry with an unfamiliar token, a remote folder, an unmounted volume — is
 * left for `codexStrangers` to report, exactly as before.
 */
export async function repairConfigs(
	server: McpServer,
	resolveDead: () => Promise<DeadWorkspaces> = async () => ({ tokens: new Set(), folders: [] }),
): Promise<RepairReport> {
	const report: RepairReport = { files: [], removed: [], pruned: [], complete: false };

	// Captured before the first await. `server.url` goes undefined when the
	// server is disposed, and a repair can be waiting on a lock when that
	// happens — reading it later would write an empty URL into the config.
	const url = server.url;
	if (!url) {
		return report;
	}

	const folder = workspaceFolder();
	let busy = false;
	let unreadable = false;

	/**
	 * Reads, repairs and writes one config, under that file's own lock.
	 *
	 * Every file here is locked, not just the global one. Two windows on the
	 * *same folder* share a token and hold different ports, so both recognise
	 * the same entry as theirs and both rewrite it — the lock does not settle
	 * which of them wins (last start does) but it does keep the two
	 * read-modify-writes from interleaving into a broken file.
	 */
	const apply = async (
		uri: vscode.Uri,
		label: string,
		rewrite: (text: string) => Rewrite,
		/**
		 * Runs inside the lock, before the file is read.
		 *
		 * The prune's *decision* belongs here and not at the call site. It used
		 * to be taken before `repairConfigs` was even called, and the set then
		 * travelled across every await in between — the lock included. Restore
		 * a folder in that window (or simply open it in another window, which
		 * lifts its tombstone) and the stale verdict still deleted the entry of
		 * a workspace that was live again by the time the write happened, then
		 * tombstoned it. Deciding under the lock makes the verdict as fresh as
		 * the write it authorises.
		 */
		inside?: () => Promise<void>,
	): Promise<void> => {
		const took = await withLock(lockPath(configLockName(uri)), async () => {
			if (inside) {
				await inside();
			}
			const read = await readConfig(uri);
			if (read.kind === 'absent') {
				return; // repairing is not connecting
			}
			if (read.kind === 'unreadable') {
				// The file is there and we could not look inside it, so this run
				// cannot claim to have examined every config.
				unreadable = true;
				return;
			}
			const result = rewrite(read.text);
			if (!result.changed) {
				return;
			}
			await writeText(uri, result.text);
			// Only a *repair* means the port moved. A file rewritten purely to
			// drop a dead entry must not be reported as one, or the window says
			// it fixed a port it never touched.
			if (result.repaired) {
				report.files.push(label);
			}
			report.removed.push(...result.removed);
		});
		// Losing a race is not an error: the next start repairs it.
		busy ||= !took;
	};

	/**
	 * Prune, then repair — in that order, and it has to be that way round.
	 *
	 * Both are expressed as line ranges over the same text, so the repair must
	 * see the text the prune produced or it edits lines that have moved. Doing
	 * both inside one `apply` is also what keeps this to a single locked
	 * read-modify-write per file: two passes would be two chances to interleave
	 * with the window next door.
	 */
	const rewriteCodex = (name: string, prune: ReadonlySet<string>) => (text: string): Rewrite => {
		const entries = codexEntries(text);
		const pruned = removeCodexTables(
			text, entries, codexDeadTables(entries, prune, server.token));
		const repaired = repairCodexToml(
			pruned.text, codexEntries(pruned.text), endpoint(server, name, url));
		return {
			text: repaired.text,
			changed: pruned.changed || repaired.changed,
			removed: pruned.removed,
			repaired: repaired.changed,
		};
	};

	if (folder) {
		await apply(claudeConfigUri(folder), '.mcp.json', text => {
			const repaired = repairClaudeJson(text, endpoint(server, serverName, url));
			return { text: repaired.text, changed: repaired.changed, removed: [], repaired: repaired.changed };
		});

		// **The project file is repaired but never pruned**, and the asymmetry
		// with the global one below is the point. Pruning exists for the global
		// `~/.codex/config.toml`, which is named per project and only ever grew;
		// a project's own `.codex/config.toml` has one entry, lives inside the
		// folder and is routinely committed. Worse, it *travels with the
		// folder*: move or re-clone a project and its entry still carries the
		// token minted for the old path, so a prune here deleted a line from a
		// version-controlled file of a live project and announced that the
		// project no longer existed. An entry we can no longer place is what
		// `staleToken` in `Check Connection` is for — the disposition CLAUDE.md
		// already records as deliberate. The sibling `.mcp.json` is left alone
		// in exactly the same situation, and now these two agree.
		await apply(codexProjectConfigUri(folder), '.codex/config.toml',
			rewriteCodex(serverName, new Set()));
	}

	// The global config is the only file the prune touches, so it is also the
	// only one whose lock has to cover the decision. `dead` is filled in by the
	// hook below, which runs inside that lock; `rewriteCodex` reads it after.
	let dead: DeadWorkspaces = { tokens: new Set(), folders: [] };
	const globalName = folder ? codexEntryName(folder) : `${serverName}-window`;
	await apply(
		codexGlobalConfigUri(),
		'~/.codex/config.toml',
		text => rewriteCodex(globalName, dead.tokens)(text),
		async () => {
			dead = await resolveDead();
			// Recorded here rather than after the write, because an absent
			// config returns early and never reaches it — and a user with no
			// `~/.codex/config.toml` at all must still get their tombstones,
			// or the scan stats every dead folder on every start for ever.
			report.pruned.push(...dead.folders);
		});

	return { ...report, complete: !busy && !unreadable };
}
