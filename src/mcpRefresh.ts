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
/** Older than this, a lock belongs to a window that is no longer running. */
const staleLockMs = 10000;

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
 * Runs `work` while no other window is in it, through a file only one process can create
 * (`wx`), which is the one lock every platform this runs on agrees about.
 *
 * A lock nobody released is a window that was killed inside its two milliseconds of work, so
 * one left behind for `staleLockMs` is taken over — by *renaming* it, because `rm` and then
 * `wx` is two steps and two windows can come through both, the second one deleting the first
 * one's fresh lock and landing them together in the very read-and-write this exists to keep
 * apart. A rename can only be won once.
 *
 * Every path through the loop either waits or gives up at the deadline: a lock this process
 * cannot remove — a directory of that name, a file another user owns — is no reason to spin,
 * which in here would be a spin with the extension's activation waiting on it. Failing to
 * create the lock for any other reason (a read-only home directory) is no reason to skip the
 * repair either: the work runs unlocked, which is what it did before there was a lock at all.
 */
async function withLock(file: vscode.Uri, work: () => Promise<void>): Promise<void> {
	const lock = `${file.fsPath}.lock`;
	const until = Date.now() + lockWaitMs;

	for (;;) {
		let handle: fs.FileHandle;
		try {
			handle = await fs.open(lock, 'wx');
		} catch (error) {
			if ((error as { code?: string }).code !== 'EEXIST') {
				await work();
				return;
			}

			const held = await fs.stat(lock).then(stat => Date.now() - stat.mtimeMs, () => 0);
			if (held > staleLockMs
				&& await fs.rename(lock, `${lock}.${process.pid}`).then(() => true, () => false)) {
				// Ours to clear, and only ours: whoever lost the rename sees a lock that is
				// either gone or somebody else's, and waits for it like any other.
				// `recursive`, since what was left behind under that name may be a directory.
				await fs.rm(`${lock}.${process.pid}`, { force: true, recursive: true }).catch(() => { });
				continue;
			}

			if (Date.now() > until) {
				// Another window is holding it for far longer than this work takes. Writing
				// anyway is what the lock is there to prevent, so this entry waits for the
				// next start of the server, or for the connect command.
				return;
			}
			await new Promise(resolve => setTimeout(resolve, lockPollMs));
			continue;
		}

		try {
			await work();
		} finally {
			await handle.close().catch(() => { });
			await fs.rm(lock, { force: true }).catch(() => { });
		}
		return;
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
		// No file, no entry of ours in it.
		return;
	}

	const updated = refreshed(text);
	if (updated === undefined || updated === text) {
		return;
	}

	try {
		await vscode.workspace.fs.writeFile(file, Buffer.from(updated, 'utf8'));
	} catch {
		// A read-only checkout or a file someone else holds: the connect command still works.
	}
}

/** The key a header is written under, http header names being case insensitive. */
function headerName(headers: unknown, name: string): string | undefined {
	if (typeof headers !== 'object' || headers === null) {
		return undefined;
	}
	return Object.keys(headers).find(key => key.toLowerCase() === name);
}
