/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as vscode from 'vscode';
import { codexEntries } from './codexToml';
import {
	claudeClientState, codexClientState, codexOurEntries, serverName, type ClientState,
} from './mcpClientState';
import {
	claudeConfigUri, codexGlobalConfigUri, codexProjectConfigUri, connectClaudeCode,
	connectCodex, workspaceFolder,
} from './mcpSetup';
import type { McpServer } from './mcpServer';

/**
 * A server that is listening proves nothing on its own, so the check does both
 * halves: it makes a real `tools/list` call over loopback with the token, and it
 * reads each client's config to say where that client is actually pointed.
 */

const requestTimeoutMs = 4000;

interface ServerProbe {
	readonly ok: boolean;
	readonly detail: string;
}

function callServer(url: string, token: string): Promise<ServerProbe> {
	return new Promise(resolve => {
		const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
		const target = new URL(url);

		const req = http.request({
			hostname: target.hostname,
			port: target.port,
			path: target.pathname,
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'content-length': Buffer.byteLength(body),
				authorization: `Bearer ${token}`,
			},
			timeout: requestTimeoutMs,
		}, res => {
			const chunks: Buffer[] = [];
			res.on('data', (chunk: Buffer) => chunks.push(chunk));
			res.on('end', () => {
				const text = Buffer.concat(chunks).toString('utf8');
				if (res.statusCode !== 200) {
					resolve({ ok: false, detail: `HTTP ${res.statusCode}: ${text.slice(0, 200)}` });
					return;
				}
				try {
					const tools = JSON.parse(text)?.result?.tools;
					resolve(Array.isArray(tools)
						? { ok: true, detail: `${tools.length} tools` }
						: { ok: false, detail: 'Response carried no tool list' });
				} catch {
					resolve({ ok: false, detail: 'Response was not JSON' });
				}
			});
		});

		req.on('timeout', () => {
			req.destroy();
			resolve({ ok: false, detail: `No answer within ${requestTimeoutMs} ms` });
		});
		req.on('error', err => resolve({ ok: false, detail: err.message }));
		req.end(body);
	});
}

async function readText(uri: vscode.Uri): Promise<string> {
	try {
		return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
	} catch {
		return '';
	}
}

function describe(state: ClientState): string {
	switch (state) {
		case 'thisServer': return vscode.l10n.t("connected to this window");
		case 'staleToken': return vscode.l10n.t("right address, wrong token — it will get a 401");
		case 'otherServer': return vscode.l10n.t("pointed at a different port, probably another window");
		case 'disabled': return vscode.l10n.t("configured but disabled");
		case 'none': return vscode.l10n.t("not configured");
	}
}

export async function checkConnection(server: McpServer): Promise<void> {
	const url = server.url;
	if (!url || !server.urlWithToken) {
		vscode.window.showWarningMessage(vscode.l10n.t("The MCP server is not listening."));
		return;
	}

	const probe = await callServer(url, server.token);

	const folder = workspaceFolder();
	const claudeText = folder ? await readText(claudeConfigUri(folder)) : '';
	const codexProject = folder ? await readText(codexProjectConfigUri(folder)) : '';
	const codexGlobal = await readText(codexGlobalConfigUri());

	// Codex's own precedence: project first, then global.
	const codexFiles = [codexEntries(codexProject), codexEntries(codexGlobal)];

	const claude = claudeClientState(claudeText, url, server.token);
	const codex = codexClientState(codexFiles, url, server.urlWithToken);
	const duplicates = codexOurEntries(codexFiles, url);

	// Who has actually called, as opposed to who is merely configured. The
	// server attributes calls by the `Mcp-Session-Id` it mints at `initialize`,
	// because only `initialize` carries `clientInfo`.
	const callers = [
		server.clients.claude ? 'Claude Code' : undefined,
		server.clients.codex ? 'Codex' : undefined,
	].filter(Boolean) as string[];

	const lines = [
		vscode.l10n.t("Server: {0}", url),
		probe.ok
			? vscode.l10n.t("Reachable — {0}", probe.detail)
			: vscode.l10n.t("NOT reachable — {0}", probe.detail),
		callers.length
			? vscode.l10n.t("Called recently by: {0}", callers.join(', '))
			: vscode.l10n.t("No assistant has called this server in the last 10 minutes."),
		'',
		vscode.l10n.t("Claude Code: {0}", describe(claude)),
		vscode.l10n.t("Codex: {0}", describe(codex)),
		vscode.l10n.t("VS Code chat: registered automatically, no config file"),
	];

	if (duplicates.length > 1) {
		// Reported, not repaired: the global file is not ours to edit, and
		// removing the wrong one of these turns working tools into a 401.
		lines.push('', vscode.l10n.t(
			"Codex has {0} entries for this server ({1}), so it will list every tool that many times. Remove the extras with: codex mcp remove {2}",
			String(duplicates.length), duplicates.join(', '), duplicates[1]));
	}

	// Only offer to fix the clients that need it.
	const actions: { label: string; run: () => Thenable<void> }[] = [];
	if (claude !== 'thisServer') {
		actions.push({ label: vscode.l10n.t("Connect Claude Code"), run: () => connectClaudeCode(server) });
	}
	if (codex !== 'thisServer') {
		actions.push({ label: vscode.l10n.t("Connect Codex"), run: () => connectCodex(server) });
	}

	const choice = await vscode.window.showInformationMessage(
		vscode.l10n.t("MCP `{0}` connection", serverName),
		{ modal: true, detail: lines.join('\n') },
		...actions.map(a => a.label));

	await actions.find(a => a.label === choice)?.run();
}
