/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { compareCliVersions, parseCliVersion } from './agentProtocol';
import type { AgentId } from './chatProtocol';

/**
 * Where the `claude` and `codex` executables are, and which one to use.
 *
 * **The newest copy found, not the first.** Candidates are everything on
 * `PATH`, a few install locations `PATH` often misses, and the copy each
 * assistant's VS Code extension carries — the Claude Code extension ships the
 * native binary under `resources/native-binary/`, the Codex extension `codex`
 * under `bin/<platform>/`. Each is asked `--version` and the highest wins. The
 * first version of this took the first match on `PATH`, and that was visibly
 * wrong: a standalone `codex` 0.145.0 left in `~/.local/bin` was offered only
 * the 5.6 models, all described as "Older", while the 0.162 inside the Codex
 * extension — the one the user actually chats with — gets GPT-6.1. The model
 * list is the server's answer to the client's version, so an old binary means
 * an old list. On a tie the earlier candidate wins, so `PATH` keeps priority
 * between equal versions.
 *
 * **A project can pick one of those copies by hand** — the gear in the agent
 * menu — or leave it on Auto, the newest. The choice is kept in the project's
 * `workspaceState` and honoured only while the copy is still found: it picks
 * among what was discovered, it never names a program of its own.
 *
 * **The setting overrides all of it, and is `application`-scoped**, and has to
 * be: a path to an executable that a workspace's `.vscode/settings.json` could
 * set is code execution from a cloned repository, the moment the chat opens.
 */

export interface AgentBinary {
	readonly path: string;
	readonly source: 'setting' | 'path' | 'common' | 'extension';
	readonly version?: string;
	/** The file `path` resolves to: one file can be reached under several spellings. */
	readonly realPath?: string;
}

/**
 * What a project stores for "the copy bundled with the assistant's VS Code
 * extension". That copy's path carries the extension's version
 * (`openai.chatgpt-26.1007.…/bin/…`), so a stored path went missing on every
 * update of the extension and fell back to the newest copy; the copy itself
 * is what was picked.
 */
export const bundledPin = 'bundled';

const versionTimeoutMs = 5000;

/**
 * The assistant's VS Code extension whose bundled CLI is a candidate. Gemini
 * CLI's companion extension (`Google.gemini-cli-vscode-ide-companion`) carries
 * no CLI — it runs `gemini` from a terminal — so there is none to look in.
 */
const extensionIds: Record<AgentId, string | undefined> = {
	claude: 'anthropic.claude-code',
	codex: 'openai.chatgpt',
	gemini: undefined,
	// OpenRouter is an HTTP API: there is no program to find.
	openrouter: undefined,
	// OpenCode's installer writes a native executable under `~/.opencode/bin`;
	// Pi is an npm package. Neither has a VS Code extension that carries a copy.
	opencode: undefined,
	pi: undefined,
};

/** What detection found for one agent, and which copy it uses. */
export interface AgentBinaryChoice {
	/** The copy in use; absent when none was found, or the setting names no executable. */
	readonly chosen?: AgentBinary;
	/** Every copy found, newest first; empty when the setting decides. */
	readonly copies: readonly AgentBinary[];
	/** The `aiBrowser.chat.<agent>Path` setting decides, whatever the project chose. */
	readonly setting: boolean;
	/** The project chose a copy that is no longer among those found; the newest is used. */
	readonly pinMissing: boolean;
}

/**
 * The copy to use: the setting when it is set; else the copy the project
 * chose in the chat's agent settings (`pinned`), **only while it is among the
 * copies found** — a stored path is never run on its own say-so; else the
 * newest.
 *
 * `current` is the binary already in use. It is kept when a Refresh cannot
 * prove another copy newer — its `--version` timed out on a busy machine, or
 * the versions are equal — because switching replaces the backend, and that
 * ends a running conversation for nothing.
 */
export async function chooseAgentBinary(agent: AgentId, current?: string, pinned?: string): Promise<AgentBinaryChoice> {
	// `current`: only a Refresh passes it. A choice the user just made asks for a
	// replacement, and keeping the copy in use — say one whose version could not
	// be read — left Auto showing beside a copy it did not pick.
	const configured = vscode.workspace.getConfiguration('aiBrowser.chat').get<string>(`${agent}Path`, '').trim();
	if (configured) {
		const resolved = configured.startsWith('~') ? path.join(os.homedir(), configured.slice(1)) : configured;
		const chosen = await isExecutable(resolved) ? { path: resolved, source: 'setting' as const, version: await versionOf(resolved) } : undefined;
		return { chosen, copies: [], setting: true, pinMissing: false };
	}
	const copies = await listAgentBinaries(agent);
	if (pinned) {
		// By the file, not the spelling: the same file reached first through
		// another `PATH` entry is still the copy the project picked. The copy
		// found is what runs, never the stored text.
		const real = pinned === bundledPin ? undefined : await fs.realpath(pinned).catch(() => pinned);
		const chosen = pinned === bundledPin
			? copies.find(c => c.source === 'extension')
			: copies.find(c => c.path === pinned || c.realPath === real);
		if (chosen) {
			return { chosen, copies, setting: false, pinMissing: false };
		}
	}
	const best = copies[0];
	const kept = current ? copies.find(c => c.path === current) : undefined;
	const chosen = kept && best && kept !== best && (kept.version === undefined || compareCliVersions(kept.version, best.version) === 0) ? kept : best;
	return { chosen, copies, setting: false, pinMissing: !!pinned };
}

/** Every copy of the agent's CLI on this machine, each asked its version, newest first. */
async function listAgentBinaries(agent: AgentId): Promise<AgentBinary[]> {
	const name = agent;
	const home = os.homedir();
	const common = agent === 'claude'
		? [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin']
		: agent === 'opencode'
			// The installer's own folder first: a native Mach-O, no Node needed.
			? [path.join(home, '.opencode', 'bin'), path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), ...await nvmBins(home), '/opt/homebrew/bin', '/usr/local/bin']
		: agent === 'gemini' || agent === 'pi'
			// An npm install: a global prefix of the user's own, or one of nvm's
			// Node versions, which a VS Code started from the Dock has no `PATH` to.
			? [path.join(home, '.local', 'bin'), ...(agent === 'pi' ? [path.join(home, '.pi', 'agent', 'bin')] : []), path.join(home, '.npm-global', 'bin'), ...await nvmBins(home), '/opt/homebrew/bin', '/usr/local/bin']
			: [path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];

	const found: { path: string; source: AgentBinary['source'] }[] = [];
	// Absolute entries only. A relative one (`.`, `node_modules/.bin`) would be
	// probed against the extension host's working directory and spawned against
	// the workspace's — two different files — and the workspace's is one a
	// repository can plant.
	for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(d => d && path.isAbsolute(d))) {
		const file = await executableIn(dir, name);
		if (file) {
			found.push({ path: file, source: 'path' });
		}
	}
	for (const dir of common) {
		const file = await executableIn(dir, name);
		if (file) {
			found.push({ path: file, source: 'common' });
		}
	}
	const bundled = await bundledBinary(agent, name);
	if (bundled) {
		found.push({ path: bundled, source: 'extension' });
	}

	// The same file reached twice (a `PATH` entry that is also a common
	// location, a symlink into another) is asked once.
	const unique = new Map<string, { path: string; source: AgentBinary['source']; realPath: string }>();
	for (const candidate of found) {
		const real = await fs.realpath(candidate.path).catch(() => candidate.path);
		if (!unique.has(real)) {
			unique.set(real, { ...candidate, realPath: real });
		}
	}
	const candidates = await Promise.all([...unique.values()].map(async c => ({ ...c, version: await versionOf(c.path) })));
	// `sort` is stable, so equal versions keep the search order.
	return candidates.sort((a, b) => compareCliVersions(a.version, b.version));
}

/** `~/.nvm/versions/node/<version>/bin` for each Node version nvm has installed. */
async function nvmBins(home: string): Promise<string[]> {
	const root = path.join(process.env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node');
	try {
		return (await fs.readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => path.join(root, e.name, 'bin'));
	} catch {
		return [];
	}
}

/** What the binary says for `--version`, or `undefined` when it says nothing usable in time. */
function versionOf(file: string): Promise<string | undefined> {
	return new Promise(resolve => {
		// The binary's own folder first on `PATH`: an npm-installed CLI is a
		// `#!/usr/bin/env node` script, and its `node` is next to it.
		const env = { ...process.env, PATH: [path.dirname(file), process.env.PATH].filter(Boolean).join(path.delimiter) };
		execFile(file, ['--version'], { timeout: versionTimeoutMs, windowsHide: true, env }, (error, stdout) => {
			resolve(error ? undefined : parseCliVersion(String(stdout)));
		});
	});
}

/** Where a binary came from, in a few words. */
export function binarySource(binary: AgentBinary): string {
	return {
		setting: 'from the aiBrowser.chat setting',
		path: 'from PATH',
		common: 'from a standard install location',
		extension: "bundled with the assistant's VS Code extension",
	}[binary.source];
}

/** Where a binary came from, for the agent dropdown's tooltip. */
export function describeBinary(binary: AgentBinary): string {
	return `${binary.version ?? 'unknown version'}, ${binarySource(binary)}: ${binary.path}`;
}

/** The copy inside the assistant's own VS Code extension, if that is installed. */
async function bundledBinary(agent: AgentId, name: string): Promise<string | undefined> {
	const id = extensionIds[agent];
	const root = id ? vscode.extensions.getExtension(id)?.extensionPath : undefined;
	if (!root) {
		return undefined;
	}
	if (agent === 'claude') {
		return executableIn(path.join(root, 'resources', 'native-binary'), name);
	}
	// `bin/macos-aarch64/codex`, `bin/linux-x86_64/codex`, … — read the
	// directory rather than guessing the platform names.
	try {
		for (const entry of await fs.readdir(path.join(root, 'bin'), { withFileTypes: true })) {
			if (entry.isDirectory()) {
				const found = await executableIn(path.join(root, 'bin', entry.name), name);
				if (found) {
					return found;
				}
			}
		}
	} catch {
		// No `bin` directory in this version of the extension.
	}
	return undefined;
}

/**
 * `<dir>/<name>`, or `<name>.exe` on Windows.
 *
 * **Not `.cmd`.** An npm-installed CLI on Windows is a `.cmd` shim, and Node
 * refuses to spawn one without a shell (`EINVAL`, since the 2024 fix for
 * CVE-2024-27980). Running it through a shell would put the arguments through
 * `cmd.exe` quoting, so it is skipped: the native installer's `.exe` and the
 * extension's bundled copy both work.
 */
async function executableIn(dir: string, name: string): Promise<string | undefined> {
	const candidates = process.platform === 'win32' ? [`${name}.exe`] : [name];
	for (const candidate of candidates) {
		const full = path.join(dir, candidate);
		if (await isExecutable(full)) {
			return full;
		}
	}
	return undefined;
}

async function isExecutable(file: string): Promise<boolean> {
	try {
		const stat = await fs.stat(file);
		if (!stat.isFile()) {
			return false;
		}
		await fs.access(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
