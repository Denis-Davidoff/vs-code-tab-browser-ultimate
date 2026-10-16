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
 * **The setting overrides all of it, and is `application`-scoped**, and has to
 * be: a path to an executable that a workspace's `.vscode/settings.json` could
 * set is code execution from a cloned repository, the moment the chat opens.
 */

export interface AgentBinary {
	readonly path: string;
	readonly source: 'setting' | 'path' | 'common' | 'extension';
	readonly version?: string;
}

const versionTimeoutMs = 5000;

const extensionIds: Record<AgentId, string> = {
	claude: 'anthropic.claude-code',
	codex: 'openai.chatgpt',
};

/**
 * `current` is the binary already in use. It is kept when a Refresh cannot
 * prove another copy newer — its `--version` timed out on a busy machine, or
 * the versions are equal — because switching replaces the backend, and that
 * ends a running conversation for nothing.
 */
export async function findAgentBinary(agent: AgentId, current?: string): Promise<AgentBinary | undefined> {
	const configured = vscode.workspace.getConfiguration('aiBrowser.chat').get<string>(`${agent}Path`, '').trim();
	if (configured) {
		const resolved = configured.startsWith('~') ? path.join(os.homedir(), configured.slice(1)) : configured;
		return await isExecutable(resolved)
			? { path: resolved, source: 'setting', version: await versionOf(resolved) }
			: undefined;
	}

	const name = agent === 'claude' ? 'claude' : 'codex';
	const home = os.homedir();
	const common = agent === 'claude'
		? [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin']
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
	const unique = new Map<string, { path: string; source: AgentBinary['source'] }>();
	for (const candidate of found) {
		const real = await fs.realpath(candidate.path).catch(() => candidate.path);
		if (!unique.has(real)) {
			unique.set(real, candidate);
		}
	}
	const candidates = await Promise.all([...unique.values()].map(async c => ({ ...c, version: await versionOf(c.path) })));
	// `sort` is stable, so equal versions keep the search order.
	const best = candidates.sort((a, b) => compareCliVersions(a.version, b.version))[0];
	const kept = current ? candidates.find(c => c.path === current) : undefined;
	if (kept && best && kept !== best && (kept.version === undefined || compareCliVersions(kept.version, best.version) === 0)) {
		return kept;
	}
	return best;
}

/** What the binary says for `--version`, or `undefined` when it says nothing usable in time. */
function versionOf(file: string): Promise<string | undefined> {
	return new Promise(resolve => {
		execFile(file, ['--version'], { timeout: versionTimeoutMs, windowsHide: true }, (error, stdout) => {
			resolve(error ? undefined : parseCliVersion(String(stdout)));
		});
	});
}

/** Where a binary came from, for the agent dropdown's tooltip. */
export function describeBinary(binary: AgentBinary): string {
	const from = {
		setting: 'from the aiBrowser.chat setting',
		path: 'from PATH',
		common: 'from a standard install location',
		extension: "bundled with the assistant's VS Code extension",
	}[binary.source];
	return `${binary.version ?? 'unknown version'}, ${from}: ${binary.path}`;
}

/** The copy inside the assistant's own VS Code extension, if that is installed. */
async function bundledBinary(agent: AgentId, name: string): Promise<string | undefined> {
	const root = vscode.extensions.getExtension(extensionIds[agent])?.extensionPath;
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
