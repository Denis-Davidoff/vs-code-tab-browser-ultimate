/*
 * The agents' own command-line programs, for the Connect commands: where a
 * CLI is installed, and whether Gemini CLI trusts a folder.
 *
 * Extracted from the chat (which moved to HoverDeck on 2026-11-14) so that
 * Connect OpenCode and Connect Gemini CLI keep working without it.
 *
 * **The newest copy found, not the first.** Candidates are everything on
 * `PATH` (absolute entries only — a relative one would be spawned against the
 * workspace, which a repository can plant), a few install locations `PATH`
 * often misses, and nvm's Node versions. Each is asked `--version` and the
 * highest wins; on a tie the earlier candidate wins.
 *
 * **The setting overrides it and is `application`-scoped**, and has to be: a
 * path to an executable that a workspace's `.vscode/settings.json` could set
 * is code execution from a cloned repository.
 */

import { execFile, spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export type CliAgent = 'gemini' | 'opencode';

export interface AgentBinary {
	readonly path: string;
	readonly version?: string;
}

const versionTimeoutMs = 5000;

/** The copy to use: the setting when set, else the newest copy found. */
export async function chooseAgentBinary(agent: CliAgent): Promise<{ chosen?: AgentBinary }> {
	const configured = vscode.workspace.getConfiguration('aiBrowser.chat').get<string>(`${agent}Path`, '').trim();
	if (configured) {
		const resolved = configured.startsWith('~') ? path.join(os.homedir(), configured.slice(1)) : configured;
		return { chosen: await isExecutable(resolved) ? { path: resolved, version: await versionOf(resolved) } : undefined };
	}
	const home = os.homedir();
	const common = [
		...(agent === 'opencode' ? [path.join(home, '.opencode', 'bin')] : []),
		path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), ...await nvmBins(home), '/opt/homebrew/bin', '/usr/local/bin',
	];
	const dirs = [...(process.env.PATH ?? '').split(path.delimiter).filter(d => d && path.isAbsolute(d)), ...common];
	const unique = new Map<string, string>();
	for (const dir of dirs) {
		const file = await executableIn(dir, agent);
		if (file) {
			const real = await fs.realpath(file).catch(() => file);
			if (!unique.has(real)) {
				unique.set(real, file);
			}
		}
	}
	const copies = await Promise.all([...unique.values()].map(async file => ({ path: file, version: await versionOf(file) })));
	return { chosen: copies.sort((a, b) => compareCliVersions(a.version, b.version))[0] };
}

/** `PATH` for an npm-installed CLI: the binary's folder first, since its `node` is next to it. */
export function cliPath(binary: string): string {
	return [path.dirname(binary), process.env.PATH].filter(Boolean).join(path.delimiter);
}

/** The first version-shaped string in a CLI's `--version` output. Leaf, under test. */
export function parseCliVersion(output: string): string | undefined {
	return /\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?/.exec(output)?.[0];
}

/** Newest first when used with `sort`: positive means `b` is newer. A pre-release loses only to its own release. */
export function compareCliVersions(a: string | undefined, b: string | undefined): number {
	if (!a || !b) {
		return a ? -1 : b ? 1 : 0;
	}
	const [coreA, preA] = splitVersion(a);
	const [coreB, preB] = splitVersion(b);
	for (let i = 0; i < Math.max(coreA.length, coreB.length); i++) {
		const diff = (coreB[i] ?? 0) - (coreA[i] ?? 0);
		if (diff) {
			return diff;
		}
	}
	if (preA !== preB) {
		return preA === undefined ? -1 : preB === undefined ? 1 : 0;
	}
	return 0;
}

function splitVersion(version: string): [number[], string | undefined] {
	const dash = version.indexOf('-');
	const core = (dash < 0 ? version : version.slice(0, dash)).split('.').map(n => parseInt(n, 10) || 0);
	return [core, dash < 0 ? undefined : version.slice(dash + 1)];
}

async function nvmBins(home: string): Promise<string[]> {
	const root = path.join(process.env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node');
	try {
		return (await fs.readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => path.join(root, e.name, 'bin'));
	} catch {
		return [];
	}
}

function versionOf(file: string): Promise<string | undefined> {
	return new Promise(resolve => {
		execFile(file, ['--version'], { timeout: versionTimeoutMs, windowsHide: true, env: { ...process.env, PATH: cliPath(file) } }, (error, stdout) => {
			resolve(error ? undefined : parseCliVersion(String(stdout)));
		});
	});
}

async function executableIn(dir: string, name: string): Promise<string | undefined> {
	const file = path.join(dir, process.platform === 'win32' ? `${name}.exe` : name);
	return await isExecutable(file) ? file : undefined;
}

async function isExecutable(file: string): Promise<boolean> {
	try {
		const stat = await fs.stat(file);
		if (!stat.isFile()) {
			return false;
		}
		if (process.platform !== 'win32') {
			await fs.access(file, fs.constants.X_OK);
		}
		return true;
	} catch {
		return false;
	}
}

/** What `geminiTrustsFolder` found out; `unknown` when Gemini could not be asked. */
export type GeminiFolderState = 'trusted' | 'untrusted' | 'signedOut' | 'unknown';

const acpTimeoutMs = 30_000;

/**
 * Whether Gemini CLI trusts `folder`, in its own judgement. ACP has no
 * question for it, but switching a new session to `autoEdit` is refused in a
 * folder it does not trust ("Cannot enable privileged approval modes in an
 * untrusted folder", measured on 0.64). The mode goes back to `default` and
 * the process ends; no prompt is sent. `session/new` refused with -32000 is
 * "not signed in".
 */
export async function geminiTrustsFolder(binary: string, folder: string): Promise<GeminiFolderState> {
	const env: NodeJS.ProcessEnv = { ...process.env, GEMINI_CLI_NO_RELAUNCH: 'true', PATH: cliPath(binary) };
	delete env.CLAUDECODE;
	const child = spawn(binary, ['--acp'], { cwd: folder, env, windowsHide: true });
	let nextId = 0;
	let buffer = '';
	const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: AcpError) => void }>();
	const fail = (message: string) => {
		for (const p of pending.values()) {
			p.reject(new AcpError(message));
		}
		pending.clear();
	};
	child.on('error', err => fail(err.message));
	child.on('exit', () => fail('Gemini CLI exited.'));
	child.stdin.on('error', () => { /* the process went; its exit settles the requests */ });
	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		buffer += chunk;
		let nl: number;
		while ((nl = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			let msg: { id?: unknown; method?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: { details?: string } } };
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			if (typeof msg.method === 'string' && msg.id !== undefined) {
				// A request of its own (a permission): refused; nothing here asks for one.
				child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'cancelled' } } }) + '\n');
				continue;
			}
			if (typeof msg.id === 'number' && pending.has(msg.id)) {
				const p = pending.get(msg.id)!;
				pending.delete(msg.id);
				if (msg.error) {
					p.reject(new AcpError(msg.error.message ?? 'Error', msg.error.code, msg.error.data?.details));
				} else {
					p.resolve(msg.result);
				}
			}
		}
	});
	const request = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
		const id = ++nextId;
		const timer = setTimeout(() => { pending.delete(id); reject(new AcpError(`Gemini CLI (${method}) timed out.`)); }, acpTimeoutMs);
		pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
		child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
	});
	try {
		await request('initialize', {
			protocolVersion: 1,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
			clientInfo: { name: 'ai-browser', title: 'AI Browser', version: '0' },
		});
		let session: { sessionId?: unknown } | undefined;
		try {
			session = await request('session/new', { cwd: folder, mcpServers: [] }) as typeof session;
		} catch (err) {
			return err instanceof AcpError && err.code === -32000 ? 'signedOut' : 'unknown';
		}
		const sessionId = session?.sessionId;
		if (typeof sessionId !== 'string') {
			return 'unknown';
		}
		try {
			await request('session/set_mode', { sessionId, modeId: 'autoEdit' });
		} catch (err) {
			return err instanceof AcpError && err.code !== undefined && /untrusted folder/i.test(`${err.details ?? ''} ${err.message}`) ? 'untrusted' : 'unknown';
		}
		await request('session/set_mode', { sessionId, modeId: 'default' }).catch(() => undefined);
		return 'trusted';
	} catch {
		return 'unknown';
	} finally {
		child.stdin.end();
		const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
		child.once('exit', () => clearTimeout(kill));
		child.kill('SIGTERM');
	}
}

class AcpError extends Error {
	constructor(message: string, public readonly code?: number, public readonly details?: string) {
		super(message);
	}
}
