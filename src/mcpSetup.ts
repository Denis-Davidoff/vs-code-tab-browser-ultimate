/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { codexEntries, codexRangeDeletable, codexUnterminated } from './codexToml';
import { lockPath, withLock } from './fileLock';
import { serverName } from './mcpClientState';
import {
	codexOurTables, codexRetiredTables, codexTableLines, removeCodexTables, repairClaudeJson,
	repairCodexToml,
	spliceCodexTables, type Endpoint,
} from './mcpRepair';
import type { McpServer } from './mcpServer';
import { confirm } from './notify';
import { plainInNotification, plainInPrompt } from './notifyText';

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
 *     licenses marking a missing workspace as handled. An unreadable file read as absent
 *     made a window report a complete run and record the marker, after which
 *     `missingWorkspaceTokens` skips that folder for good — so the entry sitting
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
): Promise<'written' | 'unparsable' | 'busy'> {

	const uri = claudeConfigUri(folder);
	// **Under the same lock as the repair**, which writes this very file.
	// `writeCodexGlobalConfig` was given the lock for exactly this reason and
	// this one was left without: a Connect pressed while any window's startup
	// repair — or the `claude mcp add --scope project` fallback this extension
	// hands the user — is mid-write on a team-shared `.mcp.json` loses whichever
	// edit lands first. One locked writer and one unlocked is the same as no
	// lock (breaks-silently #16). Losing the race reports as `unparsable`, which
	// is the existing refusal path and leaves the file untouched.
	let outcome: 'written' | 'unparsable' = 'unparsable';
	const took = await withLock(lockPath(configLockName(uri)), async () => {
		outcome = await writeClaudeConfigLocked(uri, server);
	});
	// **A lost lock is its own answer, not `unparsable`.** Folding it into the
	// existing refusal was safe for the *file* — nothing is written either way —
	// and wrong for the *user*, who was then told a healthy, committed
	// `.mcp.json` "could not be read or parsed" and to fix or delete it. The
	// file had not even been opened. Worse, `acquire` gives up immediately and
	// permanently when `os.tmpdir()` cannot be written, so that advice would
	// repeat on every press. The Codex writer next door already names its
	// reason; this is the same shape.
	return took ? outcome : 'busy';
}

async function writeClaudeConfigLocked(
	uri: vscode.Uri,
	server: McpServer,
): Promise<'written' | 'unparsable'> {
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
 * line range would leave it behind.
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
	if (codexUnterminated(existing)) {
		// Same trap as the unattended path: our table's line range would run to
		// end of file and the splice would take every server below it with us.
		throw new Error('the existing config ends inside an unclosed value');
	}
	const newline = /\r\n/.test(existing) ? '\r\n' : '\n';
	const lines = existing === '' ? [] : existing.split(/\r?\n/);

	// Ours, plus any sub-table of ours, as line ranges to drop. The splice
	// itself lives in `mcpRepair.ts` because the startup repair needs exactly
	// the same operation, and two copies of it would be two chances to write
	// TOML that does not parse.
	const ranges = codexEntries(existing)
		.filter(entry => entry.name === name || entry.name.startsWith(`${name}.`))
		.map(entry => [entry.firstLine, entry.endLine] as const);

	const next = spliceCodexTables(
		lines, ranges, codexTableLines(name, endpoint(server, name)),
		(from, to) => codexRangeDeletable(existing, from, to));
	if (!next) {
		// A range we would replace holds something that is not our table. The
		// splice reports this rather than handing back the input, because the
		// two are indistinguishable to a writer: this used to write the file
		// back byte-identical and confirm "Wrote ~/.codex/config.toml" while the
		// stale url and token stayed exactly where they were. Throwing lands in
		// `connectCodex`'s catch, which says so and offers `codex mcp add`.
		throw new Error('the existing table could not be replaced safely');
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

/**
 * Writes the **project** `.codex/config.toml`, which is what Connect Codex uses.
 *
 * It uses the bare `ai-browser` name: a project file serves one project, so the
 * per-project suffix the global file needs would be noise here — and it is the
 * name the startup repair already looks for in this file
 * ({@link repairConfigs}).
 */
export async function writeCodexProjectConfig(
	folder: vscode.WorkspaceFolder,
	server: McpServer,
): Promise<void> {
	const uri = codexProjectConfigUri(folder);
	const wrote = await withLock(lockPath(configLockName(uri)), () =>
		writeCodexConfig(uri, serverName, server));
	if (!wrote) {
		throw new Error('another window is writing .codex/config.toml');
	}
	await keepTokenOutOfGit(folder);
}

/**
 * Drops a `.gitignore` next to the project Codex config, naming that one file.
 *
 * `.codex/config.toml` carries the workspace's bearer token — the only thing
 * guarding a loopback server that can drive the developer's browser — and this
 * extension is what put it inside the user's repository. CLAUDE.md records why
 * *this* repository ignores it, and adding the rule by hand is exactly what
 * nobody does; `assistants.ts` already drops a `.gitignore` into `.ai-browser/`
 * on creation for the same reason.
 *
 * **`config.toml`, not `*`.** `.codex/` is Codex's own project directory and may
 * hold settings a team does want to share; only the file we wrote is ours to
 * exclude. An existing `.gitignore` is never touched — it is the user's, and a
 * rule of theirs may already cover this.
 *
 * Best effort: failing to write it must not fail a connection that succeeded,
 * and the confirmation says where the token went either way.
 */
async function keepTokenOutOfGit(folder: vscode.WorkspaceFolder): Promise<void> {
	const marker = vscode.Uri.joinPath(folder.uri, '.codex', '.gitignore');
	try {
		await vscode.workspace.fs.stat(marker);
		return;
	} catch {
		// Absent, or unreadable — either way, try to write it.
	}
	try {
		await writeText(marker, 'config.toml\n');
	} catch {
		// A read-only folder, or a provider that cannot write. The token is
		// still only in a file the user controls.
	}
}

/**
 * What became of this workspace's entry in the **global** `~/.codex/config.toml`.
 *
 * A boolean could not carry this, and returning one was breaks-silently #113
 * re-entered on a new path: `false` meant "there was nothing to remove" *and*
 * "I declined" *and* "another window holds the lock", so the caller could only
 * report success. Only `removed` and `absent` mean the duplicate is gone.
 */
export type GlobalEntryOutcome = 'removed' | 'absent' | 'refused' | 'busy';

/**
 * Takes this workspace's entry out of the **global** `~/.codex/config.toml`.
 *
 * Connecting writes the project file now, and Codex loads both files, so an
 * entry left in the global one is a second definition of the same server under
 * a different name — which is exactly the duplicate this project refused to
 * create when it wrote only one of the two. Every tool would be listed twice.
 *
 * **Which tables go is decided by the token, and it has to include the
 * sub-tables.** Both halves were wrong in the first version, which passed the
 * bare `codexEntryName(folder)`:
 *
 * - matching by *name* is the thing CLAUDE.md forbids in as many words (items
 *   14 and 92) — it misses an entry still under the pre-rename
 *   `tab-browser-<slug>-<hash>`, and it deletes one carrying a token this
 *   machine never minted, which `codexStrangers` promises to leave alone;
 * - and `codexEntries` names a sub-table `<root>.<suffix>`, so removing only
 *   the root left `[mcp_servers.<name>.http_headers]` behind — from which TOML
 *   *recreates* `mcp_servers.<name>` as a server with no `url`, with the bearer
 *   token still in it. Item 26, reproduced: the startup repair then answers
 *   `changed: false` for ever, so nothing in the extension could heal it.
 *   `env_http_headers` is the reachable shape, because the repair deliberately
 *   keeps that sub-table as the user's.
 *
 * `codexOurTables` answers both at once — it is the predicate the prune and the
 * repair already share, and it returns the root *with* its sub-tables. Using it
 * here rather than assembling a name set by hand is what stops this site
 * drifting out of the rule again, which is how it drifted in.
 *
 * Best effort by design: a failure leaves a duplicate, which is a degraded
 * listing rather than a broken file — and the caller really does report it now.
 */
export async function removeCodexGlobalEntry(server: McpServer): Promise<GlobalEntryOutcome> {
	const uri = codexGlobalConfigUri();
	// Before the first await: `token` is a getter over live server state, the
	// same hazard as `server.url` (breaks-silently #19).
	const token = server.token;

	let outcome: GlobalEntryOutcome = 'absent';
	const ran = await withLock(codexGlobalLock(), async () => {
		const read = await readConfig(uri);
		if (read.kind === 'absent') {
			return;
		}
		// Only a clean absence is "nothing to do"; an unreadable file may well
		// hold the duplicate (items 94 and 101).
		if (read.kind !== 'text' || codexUnterminated(read.text)) {
			outcome = 'refused';
			return;
		}

		const entries = codexEntries(read.text);
		const names = codexOurTables(entries, token);
		if (names.length === 0) {
			return;
		}

		const prune = removeCodexTables(read.text, entries, names,
			(from, to) => codexRangeDeletable(read.text, from, to));
		if (prune.refused || !prune.changed) {
			outcome = prune.refused ? 'refused' : 'absent';
			return;
		}
		await writeText(uri, prune.text);
		outcome = 'removed';
	});
	return ran ? outcome : 'busy';
}

/*
 * There is deliberately no `writeCodexGlobalConfig` any more.
 *
 * Connect writes the project `.codex/config.toml`; the global file is only ever
 * *read* now (the check, the repair) or *pruned* ({@link removeCodexGlobalEntry},
 * and the stale-workspace prune in `repairConfigs`). A writer nothing calls is a
 * writer that drifts out of step with the one that is used — the `Tool.slowMs`
 * rule — so it went with the path that needed it. `codexEntryName` and
 * `codexGlobalLock` stay, because finding and locking that file is still done.
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
 *
 * **It must not describe the tools by a prefix they do not have, and asking for
 * a check it then forbids is not a check.** Both halves were wrong, and
 * together they produced the report this prompt exists to prevent: Codex
 * answering "the tools were not loaded, restart your session" while the server
 * was connected and its tools were in that very turn's tool list, so every
 * restart said the same thing.
 *
 * Neither assistant exposes an MCP tool under its bare name. The client
 * namespaces it under the server, and the two spell that differently — Claude
 * Code keeps the server name as written (`mcp__ai-browser__browser_state`),
 * Codex replaces the hyphens (`mcp__ai_browser_picto_2a3f1f__browser_state`)
 * and then declares the lot inside its `exec` sandbox rather than as separate
 * tools. So *nothing* starts with `browser_`, and a model told to look for that
 * prefix among ~200 tools correctly reports finding none. The prompt therefore
 * names the **suffix**, which is ours and is stable, and says explicitly that a
 * prefix is expected — rather than guessing at a spelling that is the client's
 * to choose and would go stale the moment either changed it.
 *
 * And it asks for one real call. "Just check — do not use them yet" left the
 * model nothing to check *with*: the tool list is the only other evidence
 * available, and that is exactly the evidence the naming had already made
 * unreadable. `browser_state` is the right one to spend: the server's own
 * instructions open with it, it touches no page, and it **is** counted as the
 * caller picking the tab up — `state()` runs `_noteTabUse` deliberately, so a
 * check that succeeds turns the status bar from 🔗 to 🤖 and stops the menu
 * advising a restart.
 *
 * That last clause is the reverse of what this comment said for one revision,
 * and the reversal is the point. `browser_state` was originally chosen
 * *because* it did not count, on the reading that 🤖 meant "work is happening on
 * this page". It no longer means that — the two states live in the status bar,
 * where they answer "has this assistant picked the tools up?" — so a check the
 * UI cannot see leaves the user being told to restart a session that has just
 * proved it works. See breaks-silently #149.
 *
 * **It must not tell the model to read the config file, and this was tried.**
 * An intermediate version opened with "read `~/.codex/config.toml` and find the
 * `<name>` entry", on the reasoning that the exact `[mcp_servers.<name>]` header
 * is what a model needs to rebuild the prefix its client mangled — and that does
 * work. It is still wrong, for a reason the reasoning never touched: **those
 * files hold credentials.** Every entry we write carries
 * `Authorization = "Bearer <token>"`, the global Codex file accumulates one per
 * project (three on the machine this was found on, two of them for *other*
 * workspaces), and neither file is only ours — `~/.codex/config.toml` holds the
 * user's whole personal configuration and any third-party MCP server's secrets
 * with it. "Read this file" puts all of that into a model's context, a
 * provider's logs and a conversation history, to learn one string.
 *
 * And the string is one we already have: `entryName` is a parameter. Naming it
 * outright gives the model exactly what the read gave it, with nothing else
 * attached. `configPath` therefore survives only so the prompt can *locate* the
 * entry in a sentence — never as an instruction to open it.
 */
export function connectionPrompt(entryName: string, configPath: string, shared?: SharedPage): string {
	const lines = [
		`The MCP server is named \`${entryName}\` (it is already configured, in \`${configPath}\` —`
		+ ' do not open or edit that file).',
		`Do you have that server's browser tools in this session?`
		+ ' Their names end in `browser_state`, `browser_snapshot`, `browser_click` and so on,'
		+ ' but your client prefixes them with the server name — so do not look for a bare'
		+ ' `browser_` prefix. Call `browser_state` once to check; nothing else yet.',
		`If you have none, they were simply not loaded at startup. The config is already written and correct, so just restart your session — do not add or edit any MCP configuration yourself.`,
	];
	if (shared) {
		// Stated, not asked for: the paste is still a *check*, and the rule that
		// it must not send the model off to inspect a page stands. This line
		// exists so the model does not go looking for a tab to select — the user
		// has already chosen one.
		// Neutralised, for the reason `scopeNote` neutralises the same value one
		// sink along: the page chooses its own title, and this text is pasted
		// into an assistant that has shell tools. See {@link plainInPrompt}.
		lines.push(`Beyond that one call: the user has given you one browser tab — ${plainInPrompt(shared.title ?? shared.url)}`
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
		// The page chooses its own title, and a notification body is linked text
		// opened with `allowCommands: true` — see {@link plainInNotification}. The
		// label beside it is ours (`targetName`), so only this half is neutralised.
		? vscode.l10n.t(" {0} works on {1} — use \"Stop Sharing Tab\" to let it follow you again.",
			shared.label ?? vscode.l10n.t("It"), plainInNotification(shared.title ?? shared.url))
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

	// **A write can throw, and only the three enumerated outcomes were handled.**
	// `writeText` calls `createDirectory`/`writeFile` unguarded and `withLock` is
	// `try`/`finally` with no `catch`, so `NoPermissions`, `ENOSPC` or a read-only
	// folder escaped this command entirely: VS Code's generic "command failed"
	// toast, no `claude mcp add` fallback — which every other refusal here
	// provides — and no `scopeNote`, so a tab shared a moment earlier was left
	// assigned and unannounced (breaks-silently #62). `connectCodex` next door has
	// always had this shape; this one was the asymmetry.
	let outcome: Awaited<ReturnType<typeof writeClaudeConfig>>;
	try {
		outcome = await writeClaudeConfig(folder, server);
	} catch (err) {
		await vscode.env.clipboard.writeText(claudeCliCommand(server));
		vscode.window.showErrorMessage(vscode.l10n.t(
			"Could not write `.mcp.json` ({0}). The `claude mcp add` command is on your clipboard instead.",
			err instanceof Error ? err.message : String(err)) + scopeNote(shared));
		return;
	}
	if (outcome === 'busy') {
		await vscode.env.clipboard.writeText(claudeCliCommand(server));
		vscode.window.showErrorMessage(vscode.l10n.t(
			"Another window is writing `.mcp.json`, so it was left alone — try again in a moment. The `claude mcp add` command is on your clipboard instead.")
			+ scopeNote(shared));
		return;
	}
	if (outcome === 'unparsable') {
		await vscode.env.clipboard.writeText(claudeCliCommand(server));
		vscode.window.showErrorMessage(vscode.l10n.t(
			"`.mcp.json` could not be read or parsed, so it was left alone — rewriting it would drop the project's other MCP servers. Fix or delete it and try again. The `claude mcp add` command is on your clipboard instead.")
			+ scopeNote(shared));
		return;
	}

	// `.mcp.json` sits in the project root, which is the model's own working
	// directory, so the relative name is the one it can act on — and it is the
	// file this path just wrote.
	await vscode.env.clipboard.writeText(connectionPrompt(serverName, '.mcp.json', shared));
	confirm(vscode.l10n.t(
		"Wrote .mcp.json, prompt copied — restart Claude Code, then paste it.") + scopeNote(shared));
}

/**
 * Connects Codex by writing the **project** `.codex/config.toml`.
 *
 * It wrote the global `~/.codex/config.toml` for a while, and the reasoning was
 * wrong on its central claim. The stated ground was that a project config "is
 * only loaded for projects Codex trusts" and that the desktop surface ignores
 * it (openai/codex#13025) — so the global file was the safe one-click target.
 * Measured on this machine, against the Codex VS Code extension: a project
 * `.codex/config.toml` **is** loaded. Its bare `ai-browser` server appears in
 * Codex's own start log ten times in one day, from sessions whose `cwd` is that
 * project, up to the minute the file was deleted. The trust caveat is real —
 * the project has to be trusted — but "sometimes silently does nothing" was an
 * over-reading of one sample, and it cost the feature the file that belongs
 * with the project it serves.
 *
 * What the global file did cost, measured on the same machine: its entries are
 * named per project and only ever accumulate, so three had built up, two of
 * them dead — one pointing at a port another window had taken, answering 401 on
 * every Codex start.
 *
 * Writing both is still wrong, and now it is an active concern rather than a
 * hypothetical: Codex reads both files, and the two entries have different
 * names — the project file uses the bare `ai-browser`, the global one a
 * per-project name — so every tool would be listed twice. Hence
 * {@link removeCodexGlobalEntry} on this path.
 */
export async function connectCodex(server: McpServer, shared?: SharedPage): Promise<void> {
	const folder = workspaceFolder();
	if (!folder) {
		// A project config needs a project. Same shape as `connectClaudeCode`
		// with no folder: say so, and hand over the command that does not need
		// one. The tab given away a moment ago is still named (#62).
		await vscode.env.clipboard.writeText(codexCliCommand(folder, server));
		vscode.window.showWarningMessage(vscode.l10n.t(
			"No folder is open, so there is no `.codex/config.toml` to write. The `codex mcp add` command is on your clipboard instead.")
			+ scopeNote(shared));
		return;
	}

	try {
		await writeCodexProjectConfig(folder, server);
	} catch (err) {
		await vscode.env.clipboard.writeText(codexCliCommand(folder, server));
		vscode.window.showErrorMessage(vscode.l10n.t(
			"Could not write .codex/config.toml ({0}). The `codex mcp add` command is on your clipboard instead.",
			err instanceof Error ? err.message : String(err)) + scopeNote(shared));
		return;
	}

	// The project file is now the definition, so a leftover entry of ours in the
	// global file is a duplicate under a second name and Codex would list every
	// tool twice. Reported rather than thrown: the connection itself succeeded.
	//
	// **Every outcome that is not "gone" has to reach the user.** Discarding this
	// was breaks-silently #113 on a new path: a held lock — the normal shape while
	// a sibling window runs its startup repair on this very file — a config that
	// could not be read, and a range the deletion guard declined all leave the
	// duplicate in place without throwing.
	let duplicate = false;
	try {
		const outcome = await removeCodexGlobalEntry(server);
		duplicate = outcome === 'refused' || outcome === 'busy';
	} catch {
		duplicate = true;
	}

	await vscode.env.clipboard.writeText(
		connectionPrompt(serverName, '.codex/config.toml', shared));
	// **The trust precondition is stated, not detected.** Codex loads a project
	// config only for a project it trusts, which is a fact about Codex's own
	// registry rather than about anything this extension can see — and the
	// connect path has just removed the global entry that would otherwise have
	// covered an untrusted project. Guessing at that registry would be a second
	// copy of somebody else's format; saying the precondition costs one clause
	// and is the one fact a user needs when the tools do not appear.
	confirm(vscode.l10n.t(
		"Wrote .codex/config.toml, prompt copied — start a NEW Codex conversation, then paste it."
		+ " Codex reads a project config only for a project it trusts.")
		+ (duplicate
			? vscode.l10n.t(" An old entry in ~/.codex/config.toml could not be removed — if Codex lists every tool twice, delete it or press this again.")
			: '')
		+ scopeNote(shared));
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
 * **A completion marker, because deleting `mcp.token:<folderUri>` removes the
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
 * So the token stays and the folder is marked as handled instead, the scan skips it,
 * and `markWorkspaceAlive` clears the marker the moment a window serves that
 * folder again. **The marker bounds only what it marks** — a folder that still
 * exists and has simply not been opened for a while never gets one, so it is
 * stat'd again on every run; see `MissingWorkspaces.folders`. An earlier draft of
 * this paragraph claimed the completion marker solved the unbounded scan outright,
 * which is the premise under which somebody would drop `statTimeoutMs` or the
 * parallel survey.
 */
export const handledKeyPrefix = 'mcp.pruned:';
// The constant was renamed and the key string deliberately was not: this is a
// **persisted** `globalState` key, already written on every machine where the
// cleanup has run. Change the string and those markers stop being read, so
// folders already handled are surveyed and reported all over again. Renaming it
// would need a migration that reads both prefixes for a release.

/** `mcp.token:<folderUri>` -> the token, for every folder we have ever served. */
export type TokenStore = Pick<vscode.Memento, 'keys' | 'get' | 'update'>;

/** An empty verdict, for the callers that do not prune at all. */
export function emptyScan(): MissingWorkspaces {
	return { tokens: new Set(), folders: [], byFolder: new Map(), at: Date.now() };
}

/**
 * The prune's two halves, kept apart because only one of them may hold a lock.
 *
 * `scan` surveys the filesystem and is slow; `confirm` re-checks that verdict
 * from `globalState` alone and is not. See {@link stillMissing}.
 */
export interface WorkspaceScan {
	readonly scan: () => Promise<MissingWorkspaces>;
	readonly confirm: (surveyed: MissingWorkspaces) => MissingWorkspaces;
}

/** Tokens proven missing, and the `globalState` keys that held them. */
export interface MissingWorkspaces {
	readonly tokens: Set<string>;
	/**
	 * Folder URIs to mark as handled once the prune has actually landed.
	 *
	 * It bounds the scan, but only over the folders it actually marks, and the
	 * distinction is worth stating because the obvious reading is wrong: a
	 * folder that still *exists* and simply has not been opened for a while
	 * never gets a marker, so it is stat'd again on every activation and every
	 * `aiBrowser.mcp.*` change, for the life of the machine. On a long project
	 * history that is a few hundred `stat` calls per run — parallel and each
	 * capped at {@link statTimeoutMs}, so it is cheap rather than free.
	 *
	 * Recording a completion marker must wait for a **complete** repair: a run that lost the lock,
	 * or could not read a config that exists, would record the marker before the
	 * entry it identifies is gone — and then nothing ever looks again.
	 */
	readonly folders: string[];
	/** When the verdict was taken, for callers that must re-check it later. */
	readonly at: number;
	/** Folder URI -> its token, so a narrowed verdict can drop the right ones. */
	readonly byFolder: ReadonlyMap<string, string>;
}

/**
 * Re-checks a survey's verdict from `globalState` alone, with no filesystem.
 *
 * **The survey must not run under the config lock and this must.** The survey
 * stats every historical folder — two sequential `presence` calls each, so up to
 * `2 * statTimeoutMs` for one stalled mount — while `withLock` gives up after
 * `attempts * retryMs`, one second. Holding the lock across the survey therefore
 * made every other window's `apply` report `took === false`, skip
 * `~/.codex/config.toml` entirely and return `complete: false`: no port repair
 * and no completion markers, for all of them, on exactly the session restore the lock
 * was introduced for. So the survey runs outside and this runs inside — memento
 * reads only, microseconds — immediately before the rewrite.
 *
 * What it can still catch is the thing that actually changes fast: another
 * window opening the folder, which stamps it alive and lifts its marker. A folder
 * restored on disk but not yet opened by anybody leaves no signal either way,
 * and that residual is unchanged by where the survey runs.
 */
export function stillMissing(store: TokenStore, surveyed: MissingWorkspaces): MissingWorkspaces {
	const folders = surveyed.folders.filter(raw => {
		if (store.get(`${handledKeyPrefix}${raw}`) !== undefined) {
			return false; // already marked by somebody else
		}
		const seen = store.get<number>(`${seenKeyPrefix}${raw}`);
		// `>=` for the reason `markWorkspaceHandled` uses it: a stamp in the
		// same millisecond as the survey is not provably older than it.
		return !(typeof seen === 'number' && seen >= surveyed.at);
	});
	if (folders.length === surveyed.folders.length) {
		return { ...surveyed, at: Date.now() };
	}
	const kept = new Set(folders);
	const tokens = new Set(
		[...surveyed.byFolder].filter(([raw]) => kept.has(raw)).map(([, token]) => token));
	return { tokens, folders, byFolder: surveyed.byFolder, at: Date.now() };
}

/**
 * Records that this window is serving `folder`, for the prune's grace period.
 *
 * It also lifts any completion marker: a folder that is being served is by definition
 * back, and leaving the marker would hide it from the scan forever if it were
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
	// Marker first, stamp second, and each awaited. If only the first lands the
	// folder is visible to the scan with no stamp, which seeds a fresh grace
	// period. The other order would leave it stamped but hidden — stale rather
	// than wrong, and the hourly heartbeat does retry the removal, so it heals
	// within the hour while the window stays open; this order heals on the next
	// scan instead, which does not depend on the window living that long.
	if (store.get(`${handledKeyPrefix}${raw}`) !== undefined) {
		await store.update(`${handledKeyPrefix}${raw}`, undefined);
	}
	await store.update(`${seenKeyPrefix}${raw}`, Date.now());
}

/**
 * Records that this folder's entries have been pruned, keeping its token.
 *
 * The heartbeat goes, since nothing reads it already marked; the token stays,
 * for the reason written on {@link handledKeyPrefix}.
 */
export async function markWorkspaceHandled(
	store: TokenStore,
	folderUri: string,
	/**
	 * When the verdict that authorises this marker was taken.
	 *
	 * **A stamp newer than the verdict means the folder came back**, and the
	 * marker must not go down. The config lock orders the *writers* of the file;
	 * it says nothing about `markWorkspaceAlive`, which another window calls
	 * without taking it. So a workspace restored between the verdict and this
	 * call would otherwise be marked as handled — taken out of the scan permanently
	 * while being live — and `repairConfigs` never recreates an entry, so its
	 * owner would have to reconnect by hand with nothing explaining why.
	 */
	decidedAt: number,
): Promise<void> {
	// **`>=`, not `>`.** Two events in the same millisecond are not ordered by a
	// millisecond clock, and the conservative reading is the only safe one: a
	// stamp that may be newer than the verdict must be treated as newer.
	const cameBack = () => {
		const seen = store.get<number>(`${seenKeyPrefix}${folderUri}`);
		return typeof seen === 'number' && seen >= decidedAt;
	};

	if (cameBack()) {
		return;
	}
	// The marker is recorded first: if the second write is the one that fails, the
	// folder is marked as handled with a stale stamp, which the scan simply skips. The
	// other order leaves it visible with no stamp, so the next start seeds a
	// grace period and the whole seven days begin again.
	await store.update(`${handledKeyPrefix}${folderUri}`, true);

	// **Read again, after the write, and stand down if the folder came back.**
	// The check above and the writes below are separate trips through the main
	// process, and `markWorkspaceAlive` is called by other windows without
	// taking the config lock — so this interleaving is available: we read a
	// stale stamp, the live window lifts its marker and stamps afresh, and we
	// then mark a *serving* workspace as handled and delete the stamp that said
	// so. Re-reading catches the common case, where their stamp has landed by
	// now.
	//
	// **It narrows the window; it does not close it**, and there is no way to
	// close it here: `Memento` offers no compare-and-swap, so "check and write"
	// cannot be made one operation. The residual is bounded rather than
	// permanent — the hourly heartbeat calls `markWorkspaceAlive`, which lifts
	// the marker again — and the stamp is left in place here so that heartbeat
	// has something to find. Do not re-order these two writes without rereading
	// this: deleting the stamp first destroys the evidence this check reads.
	if (cameBack()) {
		await store.update(`${handledKeyPrefix}${folderUri}`, undefined);
		return;
	}
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
 * These are every way a workspace escapes being treated as missing, and the list
 * has to stay complete, since it is what anyone auditing "what can stop a
 * deletion" will read. (It is a list of *stoppers*, not of `continue`
 * statements — two of them are decided inside `folderIsGone` — so do not audit
 * it by counting branches. An earlier version named six, omitting the completion marker
 * and the seeding rule; the second is why nothing at all is prunable for the
 * first week after an upgrade.)
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
 *   - a folder already under a completion marker: it has been dealt with, and looking
 *     again is what the marker exists to stop;
 *   - a workspace with **no stamp at all**, which is seeded and skipped this
 *     round. On the first run of this build that is every historical workspace
 *     on the machine, so the feature does nothing for its first seven days;
 *   - a `mcp.token:` key whose URI will not parse, which is not a folder we can
 *     ask about at all.
 */
export async function missingWorkspaceTokens(
	store: TokenStore,
	ourToken: string,
	now = Date.now(),
): Promise<MissingWorkspaces> {
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
		if (store.get(`${handledKeyPrefix}${raw}`) !== undefined) {
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
			// evidence either way, and "no evidence" must not read as "missing"
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
	const byFolder = new Map<string, string>();
	for (const [at, gone] of verdicts.entries()) {
		if (gone) {
			tokens.add(candidates[at].token);
			folders.push(candidates[at].raw);
			byFolder.set(candidates[at].raw, candidates[at].token);
		}
	}

	return { tokens, folders, byFolder, at: now };
}

/**
 * How long one `stat` may take before the answer is "cannot tell".
 *
 * `workspace.fs.stat` has no timeout of its own, and one of the paths in the
 * list may well be on a mount that has stopped answering. The budget is **per
 * call**, and `folderIsGone` makes two of them in sequence, so one stalled
 * folder costs up to `2 * statTimeoutMs` — the number to use when sizing
 * anything downstream of the scan. Without a budget that
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
	 * Folder URIs whose removal was decided **under the lock** on this run.
	 *
	 * These, and not the caller's own earlier scan, are what may be marked as handled.
	 * A folder whose *comeback is visible in `globalState`* — another window
	 * opened it, stamping it alive and lifting its marker — is absent from this
	 * list. One restored on disk and not yet opened by anybody leaves no signal
	 * either way and is still here; see `stillMissing`.
	 */
	readonly pruned: string[];
	/** When that decision was taken, to be re-checked before a marker is recorded. */
	prunedAt: number;
	/**
	 * True when `~/.codex/config.toml` was actually dealt with.
	 *
	 * **Scoped to that one file, not to every config this run repairs**, because
	 * this flag gates exactly one thing — the prune's completion marker — and
	 * only the global file can hold a table belonging to a *different* folder.
	 * It is false when the server had no URL to write, when a newer run
	 * superseded this one, or when the global config was skipped for a held
	 * lock, could not be read, or was deliberately left alone by a rewrite that
	 * declined it. A failure on `.mcp.json` or on the project
	 * `.codex/config.toml` does **not** clear it: those cannot strand a pruned
	 * entry, and letting them block the marker meant one committed, permanently
	 * broken project file suppressed the markers for every folder, for ever.
	 * See items 108 and 112.
	 *
	 * The caller must not act on the run as if it were final — recording a completion marker after
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
	/**
	 * True when this rewrite **declined** to touch a file it was asked to.
	 *
	 * Distinct from `changed: false`, which also covers "there was nothing to
	 * do". Only a refusal means the entries are still in the file, and the
	 * caller must not treat the run as complete — a completion marker laid on the back
	 * of it takes the folder out of the scan while its table sits there, and
	 * nothing lifts that marker for a folder that no longer exists.
	 */
	readonly refused: boolean;
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
 * rule: an entry is identified by its token, and `missingWorkspaceTokens` admits
 * only tokens this extension minted itself, for folders it has checked are
 * missing while their parent directory is not. Anything it cannot prove — an
 * entry with an unfamiliar token, a remote folder, an unmounted volume — is
 * left for `codexStrangers` to report, exactly as before.
 */
export async function repairConfigs(
	server: McpServer,
	// Required, with no default. The default was a second, never-exercised path
	// through the one function in this file that deletes a user's config.
	scan: WorkspaceScan,
	/**
	 * The folder whose token this run is writing.
	 *
	 * Passed in rather than re-derived, for the reason `_apply` resolves it
	 * before its first await: `workspaceFolder()` is `workspaceFolders[0]`, and
	 * removing the first root of a multi-root window moves it without restarting
	 * the server. Re-reading it here — after the scan and two lock acquisitions
	 * — could name the global entry after one folder while writing another
	 * folder's token into it. Same rule as item 98, applied to the repair.
	 */
	folder: vscode.WorkspaceFolder | undefined,
	/**
	 * Asked under the lock, immediately before each write: is this run still the
	 * one that should be believed? Returning false abandons the write and marks
	 * the run incomplete.
	 */
	stillWanted?: () => boolean,
): Promise<RepairReport> {
	const report: RepairReport = {
		files: [], removed: [], pruned: [], prunedAt: Date.now(), complete: false,
	};

	// Captured before the first await. `server.url` goes undefined when the
	// server is disposed, and a repair can be waiting on a lock when that
	// happens — reading it later would write an empty URL into the config.
	const url = server.url;
	if (!url) {
		return report;
	}

	// **Scoped to the file the prune touches, not to every file this repairs.**
	// `complete` gates one thing only — `markWorkspaceHandled` — and a marker
	// says "the stale Codex table for this missing folder is gone". Only
	// `~/.codex/config.toml` can hold such a table, so only its outcome can
	// block the marker.
	//
	// Sharing one set of flags across all three files was a permanent trap: the
	// project `.codex/config.toml` is rewritten with an *empty* prune set, yet
	// an unterminated value there set `refused`, forced `complete: false`, and
	// so suppressed the markers for folders the global prune really had cleaned
	// up. That file is committed and travels with the project, so it stays
	// broken — and a marker is only ever lifted by a window serving that folder,
	// which a missing folder never has again. The scan therefore re-stats those
	// folders on every activation for the life of the machine and never heals.
	let busy = false;
	let unreadable = false;
	let refused = false;
	// Run-wide, and deliberately not scoped: a superseded run must not lay a
	// marker for a decision whose write it abandoned, whichever file it was in.
	let superseded = false;

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
		 * Runs inside the lock, immediately before the rewrite.
		 *
		 * The prune's *decision* belongs here and not at the call site. It used
		 * to be taken before `repairConfigs` was even called, and the set then
		 * travelled across every await in between — the lock included. Restore
		 * a folder in that window (or simply open it in another window, which
		 * lifts its completion marker) and the stale verdict still deleted the entry of
		 * a workspace that was live again by the time the write happened, then
		 * marked as handled it. Deciding under the lock makes the verdict as fresh as
		 * the write it authorises — and it runs *after* the read, not before,
		 * so the only thing between deciding and writing is the rewrite itself.
		 */
		inside?: () => Promise<void>,
		/**
		 * Whether a failure on this file may block a completion marker.
		 *
		 * True for `~/.codex/config.toml` alone — it is the only file the prune
		 * removes anything from, so it is the only one whose outcome a marker
		 * depends on. See the flags above for what sharing them cost.
		 */
		prunes = false,
	): Promise<void> => {
		const took = await withLock(lockPath(configLockName(uri)), async () => {
			const read = await readConfig(uri);
			if (read.kind === 'absent') {
				if (inside) {
					// Still decide: a user with no `~/.codex/config.toml` must
					// get their completion markers, or the scan stats every missing folder
					// on every start for ever.
					await inside();
				}
				return; // repairing is not connecting
			}
			if (read.kind === 'unreadable') {
				// The file is there and we could not look inside it, so this run
				// cannot claim to have examined every config.
				if (prunes) {
					unreadable = true;
				}
				return;
			}
			if (inside) {
				await inside();
			}
			const result = rewrite(read.text);
			if (result.refused) {
				// The file was read and deliberately left alone, so this run did
				// not reach the entries it was asked about. Recorded before the
				// `changed` test, because a refusal and a no-op both leave the
				// text identical and only one of them must block a completion marker.
				if (prunes) {
					refused = true;
				}
			}
			if (!result.changed) {
				return;
			}
			// **Checked here, holding the lock, with the bytes ready to go.**
			// The caller's own guard runs only after `repairConfigs` resolves,
			// which is far too late: an older run can take this lock *after* a
			// newer one has given up waiting for it, write the port the newer
			// run replaced, and only then discover it was superseded — leaving
			// the config pointing at a server that is gone. The last thing
			// before the write is the right place to ask.
			if (stillWanted && !stillWanted()) {
				superseded = true;
				return;
			}
			await writeText(uri, result.text);
			// Only a *repair* means the port moved. A file rewritten purely to
			// drop a stale entry must not be reported as one, or the window says
			// it fixed a port it never touched.
			if (result.repaired) {
				report.files.push(label);
			}
			report.removed.push(...result.removed);
		});
		// Losing a race is not an error: the next start repairs it.
		if (prunes) {
			busy ||= !took;
		}
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
		if (codexUnterminated(text)) {
			// A value that never closes makes its table's range run to end of
			// file, so a deletion would take every table below it — the user's
			// other MCP servers and our own live entry — while reporting the one
			// name it meant to remove. A file we cannot finish reading is not
			// one to rewrite, exactly as for an unparsable `.mcp.json`.
			return { text, changed: false, removed: [], repaired: false, refused: true };
		}
		const entries = codexEntries(text);
		const pruned = removeCodexTables(
			text, entries, codexRetiredTables(entries, prune, server.token),
			(from, to) => codexRangeDeletable(text, from, to));
		// `pruned.text` throughout, including the range check: the prune has
		// already moved every line below whatever it removed, so a predicate
		// closing over the pre-prune text would be answering about other lines.
		const repaired = repairCodexToml(
			pruned.text, codexEntries(pruned.text), endpoint(server, name, url),
			(from, to) => codexRangeDeletable(pruned.text, from, to));
		return {
			text: repaired.text,
			changed: pruned.changed || repaired.changed,
			removed: pruned.removed,
			repaired: repaired.changed,
			refused: pruned.refused,
		};
	};

	if (folder) {
		await apply(claudeConfigUri(folder), '.mcp.json', text => {
			const repaired = repairClaudeJson(text, endpoint(server, serverName, url));
			return {
				text: repaired.text, changed: repaired.changed,
				removed: [], repaired: repaired.changed, refused: false,
			};
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
	// only one whose lock has to cover the decision. `confirmed` is filled in by the
	// hook below, which runs inside that lock; `rewriteCodex` reads it after.
	// The survey runs **here**, outside every lock: it stats the filesystem and
	// can be slow. Only its confirmation happens under the lock, below.
	const surveyed = await scan.scan();
	let confirmed: MissingWorkspaces = emptyScan();
	const globalName = folder ? codexEntryName(folder) : `${serverName}-window`;
	await apply(
		codexGlobalConfigUri(),
		'~/.codex/config.toml',
		text => rewriteCodex(globalName, confirmed.tokens)(text),
		async () => {
			confirmed = scan.confirm(surveyed);
			report.prunedAt = confirmed.at;
			// Recorded here rather than after the write, because an absent
			// config returns early and never reaches it — and a user with no
			// `~/.codex/config.toml` at all must still get their completion markers,
			// or the scan stats every missing folder on every start for ever.
			report.pruned.push(...confirmed.folders);
		},
		true);

	// A superseded run is not a complete one: it must not lay completion markers for a
	// decision whose write it abandoned.
	return { ...report, complete: !busy && !unreadable && !superseded && !refused };
}
