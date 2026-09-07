/*---------------------------------------------------------------------------------------------
 *  "Is the mcp server reachable, and does anything point at it?"
 *
 *  The server being up says little on its own. The three clients are configured in three
 *  different places, each of which can name another window's port — ports are handed out in
 *  the order windows open — so a configuration that looks right can belong to another project.
 *
 *  The check therefore does both halves and reports them together: one real request through
 *  the loopback interface, carrying the token, so the answer proves the whole path; and a read
 *  of the three configurations to see which of them name *this* endpoint.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'node:http';
import * as os from 'node:os';
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

/** Whether a configuration names this server, another one, or no tab browser at all. */
type ClientState = 'thisServer' | 'otherServer' | 'none';

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
		claudeState(server.url),
		codexState(server.urlWithToken),
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
		case 'otherServer':
			// Another window won the preferred port, or the config was written before a restart.
			return vscode.l10n.t("configured, but for another endpoint — reconnect to fix it");
		case 'none':
			return vscode.l10n.t("nothing here yet (a global cli configuration is not visible from here)");
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
async function claudeState(url: string): Promise<ClientState> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return 'none';
	}

	const text = await readFile(vscode.Uri.joinPath(folder.uri, '.mcp.json'));
	if (!text) {
		return 'none';
	}

	try {
		const entry = JSON.parse(text)?.mcpServers?.[serverName];
		return entry ? (entry.url === url ? 'thisServer' : 'otherServer') : 'none';
	} catch {
		// A config that cannot be parsed is one Claude Code will not read either.
		return 'none';
	}
}

/**
 * Codex reads the project's `.codex/config.toml` in a trusted repository and always reads
 * `~/.codex/config.toml`, where the entry is named after the project. Both are searched for
 * the url rather than for a name, since the url is what actually decides which window is
 * driven — and it carries the token, so a match is a match.
 */
async function codexState(urlWithToken: string): Promise<ClientState> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	const files = [
		...(folder ? [vscode.Uri.joinPath(folder.uri, '.codex', 'config.toml')] : []),
		vscode.Uri.file(`${os.homedir()}/.codex/config.toml`),
	];

	let seen: ClientState = 'none';
	for (const file of files) {
		const text = await readFile(file);
		if (!text) {
			continue;
		}
		if (text.includes(urlWithToken)) {
			return 'thisServer';
		}
		if (new RegExp(`\\[mcp_servers\\.${serverName}`).test(text)) {
			seen = 'otherServer';
		}
	}
	return seen;
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
