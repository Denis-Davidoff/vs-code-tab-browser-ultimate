/*---------------------------------------------------------------------------------------------
 *  "Is the mcp server reachable, and does anything point at it?"
 *
 *  The server being up says little on its own. The three clients are configured in three
 *  different places, each of which can name another window's port — ports are handed out in
 *  the order windows open — so a configuration that looks right can belong to another project.
 *
 *  The check therefore does both halves and reports them together: one real request through
 *  the loopback interface, carrying the token, so the answer proves the whole path; and a read
 *  of the three configurations to see which of them would reach *this* endpoint.
 *
 *  "Would reach" and not "names": the url is the least of it. The token is per workspace, so a
 *  config carrying another window's token names the right endpoint and still answers 401, and
 *  an entry that is commented out or turned off names it while doing nothing at all. Reading
 *  these files loosely is worse than not reading them — it reports a broken client as working
 *  and hides the one button that would fix it — so each entry is read for its url, its
 *  credentials and whether it is switched on.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { BrowserController } from './browserController';
import { McpServer } from './mcpServer';
import { serverName } from './mcpSetup';

/** What `startMcpServer` ended up doing, which the sidebar shows and this check reads. */
export type McpState =
	| { readonly kind: 'starting' }
	| { readonly kind: 'running'; readonly server: McpServer }
	| { readonly kind: 'disabled' }
	| { readonly kind: 'failed'; readonly error: string };

/**
 * What a client's configuration amounts to. Naming this endpoint is not enough on its own:
 * the credentials have to be this window's, and the entry has to be switched on — both have
 * been seen to look right in the file and answer 401, or nothing at all.
 */
type ClientState =
	/** Names this endpoint, with credentials this server will accept. */
	| 'thisServer'
	/** Names this endpoint with a token that is not this window's: a 401 for the client. */
	| 'staleToken'
	/** Names something else — usually another window, which won the preferred port. */
	| 'otherServer'
	/** Names this endpoint, but the entry is turned off. */
	| 'disabled'
	| 'none';

/** Worst last: a config with several entries is reported by its most working one. */
const clientStateOrder: readonly ClientState[] =
	['thisServer', 'staleToken', 'otherServer', 'disabled', 'none'];

const connectClaudeCommand = 'tabBrowser.connectMcpToClaudeCode';
const connectCodexCommand = 'tabBrowser.connectMcpToCodex';

export async function checkMcp(state: McpState, browser: BrowserController): Promise<void> {
	const settings = vscode.l10n.t("Open Settings");

	if (state.kind === 'starting') {
		vscode.window.showInformationMessage(
			vscode.l10n.t("The mcp server is still starting. Try again in a moment."));
		return;
	}

	if (state.kind === 'disabled') {
		if (await vscode.window.showWarningMessage(
			vscode.l10n.t("The mcp server is turned off by `tabBrowser.mcp.enabled`."),
			settings) === settings) {
			await openSettings('tabBrowser.mcp.enabled');
		}
		return;
	}

	if (state.kind === 'failed') {
		if (await vscode.window.showErrorMessage(
			vscode.l10n.t("The mcp server could not start: {0}", state.error),
			settings) === settings) {
			await openSettings('tabBrowser.mcp.port');
		}
		return;
	}

	const server = state.server;
	if (!server.url || !server.urlWithToken) {
		vscode.window.showWarningMessage(vscode.l10n.t("The mcp server is not listening."));
		return;
	}

	const answer = await callServer(server.url, server.token);
	const [claude, codex] = await Promise.all([
		claudeState(server.url, server.token),
		codexState(server.url, server.urlWithToken),
	]);

	const detail = [
		vscode.l10n.t("Endpoint: {0}", server.url),
		vscode.l10n.t("Response: {0}", answer.ok
			? vscode.l10n.t("answered, {0} tools", answer.tools)
			: answer.error),
		vscode.l10n.t("Browser panel: {0}", panelLine(browser)),
		'',
		vscode.l10n.t("VS Code chat: {0}", vsCodeLine()),
		vscode.l10n.t("Claude Code (.mcp.json): {0}", clientLine(claude)),
		vscode.l10n.t("Codex (config.toml): {0}", clientLine(codex)),
		// `claude mcp add` writes to Claude Code's own settings, which are not ours to read.
		...(claude === 'none'
			? [vscode.l10n.t("A connection added with \"claude mcp add\" lives in Claude Code's own settings and cannot be seen from here; /mcp shows it.")]
			: []),
	].join('\n');

	// The command that would fix whichever client is not pointing here yet.
	const fixClaude = vscode.l10n.t("Connect Claude Code");
	const fixCodex = vscode.l10n.t("Connect Codex");
	const actions = [
		...(claude === 'thisServer' ? [] : [fixClaude]),
		...(codex === 'thisServer' ? [] : [fixCodex]),
	];

	const show = answer.ok ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
	const picked = await show(
		answer.ok
			? vscode.l10n.t("The mcp server is reachable.")
			: vscode.l10n.t("The mcp server did not answer."),
		{ modal: true, detail },
		...actions);

	if (picked === fixClaude) {
		await vscode.commands.executeCommand(connectClaudeCommand);
	} else if (picked === fixCodex) {
		await vscode.commands.executeCommand(connectCodexCommand);
	}
}

function panelLine(browser: BrowserController): string {
	const state = browser.state();
	if (!state.open) {
		return vscode.l10n.t("not open — the tools that read the page will say so");
	}
	return state.inspectable
		? vscode.l10n.t("{0}, ready to be read", state.url || '')
		: vscode.l10n.t("{0}, not instrumented — only navigation works", state.url || '');
}

function clientLine(state: ClientState): string {
	switch (state) {
		case 'thisServer':
			return vscode.l10n.t("points at this server");
		case 'staleToken':
			// The token is per workspace and kept across restarts, so this is a config written
			// against another project's window — the endpoint is right, the token is not.
			return vscode.l10n.t("this endpoint, but with a token this window will refuse — reconnect to fix it");
		case 'otherServer':
			// Another window won the preferred port, or the config predates a restart.
			return vscode.l10n.t("configured, but for another endpoint — reconnect to fix it");
		case 'disabled':
			return vscode.l10n.t("configured for this server, but the entry is turned off");
		case 'none':
			return vscode.l10n.t("nothing here points at this server");
	}
}

/** VS Code's own chat needs no configuration, as long as the api that carries it is there. */
function vsCodeLine(): string {
	return typeof (vscode as { lm?: { registerMcpServerDefinitionProvider?: unknown } })
		.lm?.registerMcpServerDefinitionProvider === 'function'
		? vscode.l10n.t("registered automatically")
		: vscode.l10n.t("needs VS Code 1.101 or newer");
}

/** One `tools/list` through the loopback interface: the token, the transport and the tools. */
async function callServer(
	url: string,
	token: string,
): Promise<{ ok: true; tools: number } | { ok: false; error: string }> {
	const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), 'utf8');
	const target = new URL(url);

	return new Promise(resolve => {
		const request = http.request({
			host: target.hostname,
			port: target.port,
			path: target.pathname,
			method: 'POST',
			timeout: 4000,
			headers: {
				'content-type': 'application/json',
				'content-length': body.byteLength,
				authorization: `Bearer ${token}`,
			},
		}, response => {
			const chunks: Buffer[] = [];
			response.on('data', chunk => chunks.push(chunk as Buffer));
			response.on('end', () => {
				if (response.statusCode !== 200) {
					resolve({ ok: false, error: vscode.l10n.t("http {0}", response.statusCode ?? 0) });
					return;
				}
				try {
					const tools = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.result?.tools;
					resolve(Array.isArray(tools)
						? { ok: true, tools: tools.length }
						: { ok: false, error: vscode.l10n.t("answered, but not with a tool list") });
				} catch (error) {
					resolve({ ok: false, error: message(error) });
				}
			});
		});

		request.on('timeout', () => request.destroy(new Error(vscode.l10n.t("timed out"))));
		request.on('error', error => resolve({ ok: false, error: message(error) }));
		request.end(body);
	});
}

/** Claude Code's project configuration: json, with our entry under `mcpServers`. */
async function claudeState(url: string, token: string): Promise<ClientState> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return 'none';
	}

	return claudeClientState(
		await readFile(vscode.Uri.joinPath(folder.uri, '.mcp.json')), url, token);
}

/**
 * The endpoint *and* the credentials, because the token is per workspace: a `.mcp.json` copied
 * from another project, or written before this window's token was minted, names the right url
 * and still answers 401. Reading the url alone reported such a config as working.
 */
export function claudeClientState(
	text: string | undefined,
	url: string,
	token: string,
): ClientState {
	if (!text) {
		return 'none';
	}

	let entry: Record<string, unknown> | undefined;
	try {
		entry = JSON.parse(text)?.mcpServers?.[serverName];
	} catch {
		// A config that cannot be parsed is one Claude Code will not read either.
		return 'none';
	}

	const configured = typeof entry?.url === 'string' ? entry.url : '';
	if (!configured) {
		return 'none';
	}
	if (!sameEndpoint(configured, url)) {
		return 'otherServer';
	}

	// Headers are sent as written, and http header names are case insensitive.
	const authorization = header(entry?.headers, 'authorization');
	return authorization === `Bearer ${token}` || configured === `${url}/${token}`
		? 'thisServer'
		: 'staleToken';
}

/**
 * Codex reads `~/.codex/config.toml` always and the project's `.codex/config.toml` once the
 * repository is trusted. Both are read here, and every `[mcp_servers.tab-browser*]` entry in
 * them is judged on its own: the entries carry different names per project, so one config can
 * hold several and the best of them is what Codex ends up using.
 */
async function codexState(url: string, urlWithToken: string): Promise<ClientState> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	const files = [
		...(folder ? [vscode.Uri.joinPath(folder.uri, '.codex', 'config.toml')] : []),
		vscode.Uri.file(path.join(os.homedir(), '.codex', 'config.toml')),
	];

	return codexClientState(await Promise.all(files.map(readFile)), url, urlWithToken);
}

/** `texts` in order of precedence: the project's config first, the global one after it. */
export function codexClientState(
	texts: readonly (string | undefined)[],
	url: string,
	urlWithToken: string,
): ClientState {
	let state: ClientState = 'none';
	const seen = new Set<string>();

	for (const text of texts) {
		for (const entry of text ? codexEntries(text) : []) {
			// A name defined twice is read from the more specific file, as Codex reads it.
			if (!entry.name.startsWith(serverName) || seen.has(entry.name)) {
				continue;
			}
			seen.add(entry.name);

			const candidate = codexEntryState(entry, url, urlWithToken);
			if (clientStateOrder.indexOf(candidate) < clientStateOrder.indexOf(state)) {
				state = candidate;
			}
		}
	}

	return state;
}

function codexEntryState(entry: CodexEntry, url: string, urlWithToken: string): ClientState {
	const configured = entry.values.get('url') ?? '';
	if (!configured) {
		// Not an http server at all, so not one of ours whatever it is named.
		return 'none';
	}

	const ours = configured === urlWithToken
		// The token can also be read from the environment, which cannot be judged from here.
		|| (sameEndpoint(configured, url) && entry.values.has('bearer_token_env_var'));

	if (entry.values.get('enabled') === 'false') {
		return ours || sameEndpoint(configured, url) ? 'disabled' : 'none';
	}
	if (ours) {
		return 'thisServer';
	}
	return sameEndpoint(configured, url) ? 'staleToken' : 'otherServer';
}

interface CodexEntry {
	readonly name: string;
	readonly values: ReadonlyMap<string, string>;
}

/**
 * The `[mcp_servers.*]` tables of a Codex config, comments taken off.
 *
 * Not a TOML parser: it reads table headers and the plain `key = value` lines inside them,
 * which is what `codex mcp add` and this extension write. Anything more exotic reads as
 * unconfigured, which costs a reconnect — searching the text for the url instead used to
 * accept a url in a comment, and an entry standing right there with `enabled = false`.
 */
function codexEntries(text: string): CodexEntry[] {
	const entries: CodexEntry[] = [];
	let values: Map<string, string> | undefined;

	for (const raw of text.split(/\r?\n/)) {
		const line = withoutComment(raw).trim();
		if (!line) {
			continue;
		}

		// Any header ends the previous table, so keys never land in the wrong one.
		if (line.startsWith('[')) {
			const name = /^\[\s*mcp_servers\s*\.\s*([^\]]+?)\s*\]$/.exec(line)?.[1];
			values = name === undefined ? undefined : new Map();
			if (values && name !== undefined) {
				entries.push({ name: unquote(name), values });
			}
			continue;
		}

		const pair = /^([^=]+?)\s*=\s*(.+)$/.exec(line);
		if (values && pair) {
			values.set(unquote(pair[1].trim()).toLowerCase(), unquote(pair[2].trim()));
		}
	}

	return entries;
}

/** A `#` opens a comment unless it stands inside a string — and a url can carry one. */
function withoutComment(line: string): string {
	let quote: string | undefined;

	for (let at = 0; at < line.length; at++) {
		const char = line[at];
		if (quote) {
			if (char === quote) {
				quote = undefined;
			}
		} else if (char === '"' || char === '\'') {
			quote = char;
		} else if (char === '#') {
			return line.slice(0, at);
		}
	}

	return line;
}

function unquote(value: string): string {
	return /^(["'])(.*)\1$/.exec(value)?.[2] ?? value;
}

/** The same server, whether or not the token is carried as the last segment of the url. */
function sameEndpoint(configured: string, url: string): boolean {
	return configured === url || configured.startsWith(`${url}/`);
}

function header(headers: unknown, name: string): string | undefined {
	if (typeof headers !== 'object' || headers === null) {
		return undefined;
	}
	const found = Object.entries(headers)
		.find(([key]) => key.toLowerCase() === name);
	return typeof found?.[1] === 'string' ? found[1].trim() : undefined;
}

async function readFile(file: vscode.Uri): Promise<string | undefined> {
	try {
		return Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
	} catch {
		return undefined;
	}
}

function openSettings(query: string): Thenable<unknown> {
	return vscode.commands.executeCommand('workbench.action.openSettings', query);
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
