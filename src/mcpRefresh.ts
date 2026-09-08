/*---------------------------------------------------------------------------------------------
 *  Keeping a configuration that was written once pointing at this window.
 *
 *  The token is not what goes stale: it belongs to the workspace and outlives the window
 *  (`workspaceToken` in extension.ts), so an entry written last week still authenticates. The
 *  *port* does. Ports are handed out in the order windows open, so the entry written for this
 *  project names whichever window opened first today — a 401 if that window belongs to another
 *  workspace, and until now the only cure was running the connect command again.
 *
 *  So every start of the server repairs the entries this extension wrote: same file, same name,
 *  and a url that is still one of ours. Anything else is somebody's own configuration and is
 *  left as it is, and an entry that is not there is never created — adding a server to a
 *  project is a decision, and the connect command is where it is made.
 *
 *  Two things decide what counts as ours, and they are not the same in every file. In the
 *  workspace's own `.mcp.json` and `.codex/config.toml` the location is the proof: they belong
 *  to this project, whoever wrote them. The global `~/.codex/config.toml` is shared by every
 *  project on the machine, so an entry there has to say it is ours — by carrying this
 *  workspace's name (which the connect command puts a hash of the folder into) or its token.
 *  Without that, a window with no folder open would take over the entry of a project that
 *  happens to be configured under the bare name.
 *
 *  That shared file is also the one place where the *other windows* are part of the problem:
 *  each of them repairs a different entry in it, so two starting at once would both write the
 *  text they read and the later one would undo the earlier one's repair — leaving a client that
 *  was configured correctly on somebody else's port. Hence the lock around it, and why nothing
 *  between reading that file and writing it back may be skipped.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { codexEntries } from './codexToml';
import { McpServer } from './mcpServer';
import { codexEntryName, serverName } from './mcpSetup';

/**
 * A url this extension could have written: the loopback interface, our own path, and at most
 * one segment after it for the token. Which is also what keeps a `${PORT}` written by hand out
 * of here — a url a client expands from the environment is one that repairs itself already.
 */
const ourUrl = /^http:\/\/127\.0\.0\.1:\d+\/mcp(\/[A-Za-z0-9._~-]+)?$/;

/** An entry named after this workspace, which the bare `tab-browser` is not. */
const perWorkspaceName = /-[0-9a-f]{6}$/;

/** How long a window waits for another one to finish with the shared config, and gives up. */
const lockWaitMs = 2000;
const lockPollMs = 25;
/** Fixes the entries pointing at an older port, in every file this extension writes itself. */
export async function refreshClientConfigs(
	server: McpServer,
	/** Taken as an argument so a test can point it away from the real home directory. */
	sharedCodexConfig = vscode.Uri.file(path.join(os.homedir(), '.codex', 'config.toml')),
): Promise<void> {
	const url = server.url;
	if (!url) {
		return;
	}

	const folder = vscode.workspace.workspaceFolders?.[0];
	// Both names, because the entry can be under either: the connect command writes the one
	// carrying this folder's hash, and an older version of it wrote the bare one. Naming only
	// the first would put the bare one beyond repair — and beyond the token check below, which
	// is the whole of what makes it safe to touch.
	const names = [...new Set([codexEntryName(folder), serverName])];

	await Promise.all([
		...(folder ? [
			rewrite(vscode.Uri.joinPath(folder.uri, '.mcp.json'),
				text => refreshedClaudeConfig(text, url, server.token)),
			rewrite(vscode.Uri.joinPath(folder.uri, '.codex', 'config.toml'),
				text => refreshedCodexConfig(text, url, server.token, { names: [serverName] })),
		] : []),
		// Every window on this machine repairs its own entry in this one file, so the read and
		// the write have to be one step: two of them starting together would otherwise both
		// write what they read, and the later one would put the earlier one's entry back on a
		// port that is not its own — a 401 for a client that was configured correctly.
		withLock(sharedCodexConfig, () =>
			rewrite(sharedCodexConfig, text => refreshedCodexConfig(text, url, server.token,
				{ names, shared: true }))),
	]);
}

/**
 * Claude Code's `.mcp.json`, rewritten whole — it is json, so there are no comments to keep,
 * and the connect command writes it the same way.
 *
 * The shape of the entry is left as it was found: a token in the url is a client that cannot
 * send a header, and moving it into one would break it. A header holding a `${...}` is left
 * alone too — that is a token read from the environment, which is nobody's business here.
 */
export function refreshedClaudeConfig(
	text: string,
	url: string,
	token: string,
): string | undefined {
	let config: Record<string, unknown> | undefined;
	try {
		config = JSON.parse(text);
	} catch {
		// A config Claude Code cannot read either. Overwriting it would drop what it holds.
		return undefined;
	}

	const servers = (config as { mcpServers?: Record<string, unknown> })?.mcpServers;
	const entry = servers?.[serverName] as Record<string, unknown> | undefined;
	if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string') {
		return undefined;
	}

	const match = ourUrl.exec(entry.url);
	if (!match) {
		return undefined;
	}

	const headers = entry.headers as Record<string, unknown> | undefined;
	const key = headerName(headers, 'authorization');
	const written = key === undefined ? undefined : String(headers?.[key] ?? '');
	const wanted = match[1] ? `${url}/${token}` : url;
	const authorization = `Bearer ${token}`;
	// A token in the url belongs to a client that cannot send a header, and one written as
	// `${...}` is read from the environment: either way the header is not ours to fill in.
	const fillHeader = !match[1] && !written?.includes('${');

	if (entry.url === wanted && (!fillHeader || written === authorization)) {
		return undefined;
	}

	entry.url = wanted;
	if (fillHeader) {
		entry.headers = { ...headers, [key ?? 'Authorization']: authorization };
	}

	return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * Codex's config, with only the `url` line of our own table rewritten: the file is TOML, held
 * by `codex mcp add` where it is the global one, and everything else in the table — an
 * `enabled = false` someone meant, the environment variable a token is read from — is theirs.
 */
export function refreshedCodexConfig(
	text: string,
	url: string,
	token: string,
	options: {
		readonly names: readonly string[];
		/** Set for a file several projects share, where a name alone proves nothing. */
		readonly shared?: boolean;
	},
): string | undefined {
	const lines = text.split('\n');
	let changed = false;

	for (const entry of codexEntries(text)) {
		const configured = entry.values.get('url');
		if (!options.names.includes(entry.name) || !configured || !ourUrl.test(configured)) {
			continue;
		}
		if (options.shared
			&& !perWorkspaceName.test(entry.name)
			&& !configured.endsWith(`/${token}`)) {
			continue;
		}

		// A token named rather than written is read from the environment, so the url carries none.
		const wanted = entry.values.has('bearer_token_env_var') ? url : `${url}/${token}`;
		if (configured === wanted) {
			continue;
		}

		// The line the value was read from, not the first line of the table that looks like a
		// url: a `url = …` inside a multi-line string is prose, and rewriting that would edit
		// the middle of somebody's `instructions` and leave a file Codex cannot parse.
		const at = entry.valueLines.get('url');
		if (at === undefined) {
			continue;
		}

		lines[at] = `url = "${wanted}"`;
		changed = true;
	}

	return changed ? lines.join('\n') : undefined;
}

/**
 * A bakery queue: each contender owns a unique directory and publishes its ticket atomically.
 * Nobody removes a live process's claim, even after sleep or a slow disk operation. Dead owners
 * can be removed by their unique name without ever deleting a successor's claim (the race in
 * a shared, reusable lock filename). The parent directory stays to avoid the same race there.
 */
async function withLock(file: vscode.Uri, work: () => Promise<void>): Promise<void> {
	const directory = `${file.fsPath}.tab-browser-locks`;
	const name = `${process.pid}.${randomUUID()}`;
	const claim = path.join(directory, name);
	const deadline = Date.now() + lockWaitMs;
	try {
		await fs.mkdir(directory, { recursive: true });
		await fs.mkdir(claim);
	} catch {
		// Without exclusion, a write could undo another window's configuration.
		return;
	}

	try {
		const contenders = async () => (await fs.readdir(directory))
			.filter(entry => /^\d+\.[0-9a-f-]{36}$/.test(entry));
		const ticketOf = async (entry: string): Promise<number> => {
			try {
				return Number(await fs.readFile(path.join(directory, entry, 'ticket'), 'utf8')) || 0;
			} catch {
				// A published directory with no ticket is still choosing its place.
				return 0;
			}
		};
		let ticket = 1;
		for (const entry of await contenders()) {
			ticket = Math.max(ticket, await ticketOf(entry) + 1);
		}
		await fs.writeFile(path.join(claim, 'pending'), String(ticket));
		await fs.rename(path.join(claim, 'pending'), path.join(claim, 'ticket'));

		while (Date.now() < deadline) {
			let waiting = false;
			for (const entry of await contenders()) {
				if (entry === name) { continue; }
				if (!processExists(Number(entry.split('.')[0]))) {
					await fs.rm(path.join(directory, entry), { recursive: true, force: true });
					continue;
				}
				const other = await ticketOf(entry);
				if (!other || other < ticket || (other === ticket && entry < name)) {
					waiting = true;
					break;
				}
			}
			if (!waiting) {
				await work();
				return;
			}
			await new Promise(resolve => setTimeout(resolve, lockPollMs));
		}
	} catch {
		// An unreadable queue cannot establish exclusion; leave the config for the next start.
	} finally {
		await fs.rm(claim, { recursive: true, force: true }).catch(() => { });
	}
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== 'ESRCH';
	}
}

/** Reads the file, and writes it back only when there was something to change. */
async function rewrite(
	file: vscode.Uri,
	refreshed: (text: string) => string | undefined,
): Promise<void> {
	let text: string;
	try {
		text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
	} catch {
		return;
	}
	const updated = refreshed(text);
	if (updated === undefined || updated === text) { return; }
	try {
		await vscode.workspace.fs.writeFile(file, Buffer.from(updated, 'utf8'));
	} catch {
		// Read-only configurations are left for the explicit connect command.
	}
}

/** The key a header is written under, http header names being case insensitive. */
function headerName(headers: unknown, name: string): string | undefined {
	if (typeof headers !== 'object' || headers === null) {
		return undefined;
	}
	return Object.keys(headers).find(key => key.toLowerCase() === name);
}
