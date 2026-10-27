/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The PTY half of the chat's terminal tabs: a shell on the editor's machine, its output batched,
// flow controlled and kept as a short tail for a view that reloads. No `vscode` import and no
// relative value import, so `npm test` loads it directly (the rule under "Recipe for the next
// feature" in CLAUDE.md).
//
// Units: every count here — `seq`, the acknowledgements, the tail — is UTF-16 code units of the
// strings that travel, because that is what the view can count. The names say "bytes" where the
// message contract does.

import * as fs from 'node:fs';
import * as path from 'node:path';
// Types only: this module is loaded by `npm test` without a relative value import. The model itself arrives through
// `TerminalHost`'s factory (the compiled build loads `./screenModel`; a test passes it in).
import type { ScreenModel, ScreenModelOptions, ScreenRead, ScreenReadOptions, ScreenState, ScreenWait, ScreenWaitOptions } from './screenModel';

/** What node-pty's `IPty` offers, cut to what the host uses. */
export interface PtyProcess {
	onData(cb: (data: string) => void): void;
	onExit(cb: (e: { exitCode: number }) => void): void;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	pause(): void;
	resume(): void;
	kill(): void;
}

export interface PtySpawn {
	file: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	cols: number;
	rows: number;
}

/** Injectable for tests; the default loads the staged `out/terminal/vendor/node-pty`. */
export type PtyLoader = () => { spawn(o: PtySpawn): PtyProcess };

export interface TerminalAvailability {
	ok: boolean;
	reason?: string;
}

export const minCols = 2;
export const maxCols = 500;
export const minRows = 1;
export const maxRows = 200;
/** One `write` larger than this is dropped: a paste is the view's to cap, not the shell's to swallow. */
export const maxWrite = 1 << 20;

const defaultBatchMs = 8;
const defaultMaxBatch = 64 * 1024;
const defaultTailBytes = 256 * 1024;
const defaultAckHigh = 1 << 20;
const defaultAckLow = 256 * 1024;
/**
 * The headless emulator's own queue is capped at 50 MB and throws past it. The shell is paused when this much output
 * waits to be parsed, and read again below the low mark — at the emulator's speed (about 15 ms a megabyte) that is a
 * pause of tens of milliseconds, never a stall.
 */
export const emulatorBacklogHigh = 4 << 20;
export const emulatorBacklogLow = 1 << 20;
/** A killed shell that has not gone after this long gets SIGKILL (a shell that ignores SIGHUP, a hung child). */
const killGraceMs = 3000;

// ---------------------------------------------------------------------------------------------
// Availability and loading
// ---------------------------------------------------------------------------------------------

/** Where `scripts/stage-terminal.mjs` put node-pty, relative to this file — undefined when not running compiled. */
function vendorDirectory(): string | undefined {
	return typeof __dirname === 'string' ? path.join(__dirname, 'vendor', 'node-pty') : undefined;
}

interface NativePty {
	spawn(file: string, args: string[], options: Record<string, unknown>): {
		readonly pid: number;
		onData(cb: (data: string) => void): unknown;
		onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
		write(data: string): void;
		resize(cols: number, rows: number): void;
		pause(): void;
		resume(): void;
		kill(signal?: string): void;
	};
}

let loadedNative: NativePty | undefined;

function loadNative(): NativePty {
	if (loadedNative) {
		return loadedNative;
	}
	const dir = vendorDirectory();
	if (dir && fs.existsSync(path.join(dir, 'package.json'))) {
		loadedNative = require(dir) as NativePty;
		return loadedNative;
	}
	// A development checkout that never staged: `node_modules` is there. A VSIX has none, so this
	// can only succeed where it is meant to.
	try {
		require.resolve('node-pty');
	} catch {
		throw new Error('node-pty is missing: ' + path.join(dir ?? 'out/terminal/vendor', 'node-pty', 'package.json') + ' was not staged (run npm run build-ext).');
	}
	loadedNative = require('node-pty') as NativePty;
	return loadedNative;
}

/** The loader behind `new TerminalHost()`: node-pty, its handle wrapped as a `PtyProcess` that can be killed for good. */
export const defaultLoader: PtyLoader = () => {
	const native = loadNative();
	return {
		spawn(o: PtySpawn): PtyProcess {
			const pty = native.spawn(o.file, o.args, {
				name: o.env.TERM ?? 'xterm-256color',
				cols: o.cols,
				rows: o.rows,
				cwd: o.cwd,
				env: o.env,
				encoding: 'utf8',
			});
			let exited = false;
			let killed = false;
			pty.onExit(() => { exited = true; });
			return {
				onData: cb => { pty.onData(cb); },
				onExit: cb => { pty.onExit(e => cb({ exitCode: e.exitCode })); },
				write: data => pty.write(data),
				resize: (cols, rows) => pty.resize(cols, rows),
				pause: () => pty.pause(),
				resume: () => pty.resume(),
				kill: () => {
					if (killed || exited) {
						return;
					}
					killed = true;
					try { pty.kill(); } catch { /* already gone */ }
					if (process.platform === 'win32') {
						return;
					}
					// The shell is a session leader, so its group is its own: hang up the jobs it left behind
					// too, and make sure of the shell itself if it ignores SIGHUP.
					try { process.kill(-pty.pid, 'SIGHUP'); } catch { /* no group */ }
					const timer = setTimeout(() => {
						if (exited) {
							return;
						}
						try { process.kill(-pty.pid, 'SIGKILL'); } catch { /* gone */ }
						try { process.kill(pty.pid, 'SIGKILL'); } catch { /* gone */ }
					}, killGraceMs);
					timer.unref();
				},
			};
		},
	};
};

const availabilityCache = new Map<string, TerminalAvailability>();

/** Forgets the cached answers (a test, or a build that has just been staged). */
export function resetTerminalAvailability(): void {
	availabilityCache.clear();
	loadedNative = undefined;
}

/**
 * Whether a shell can be started here, decided up front and without starting one. The answer for the real
 * loader is cached; an injected loader is asked every time.
 */
export function terminalAvailability(platform: NodeJS.Platform = process.platform, arch: string = process.arch, loader?: PtyLoader): TerminalAvailability {
	const key = platform + '-' + arch;
	if (!loader) {
		const cached = availabilityCache.get(key);
		if (cached) {
			return cached;
		}
	}
	const answer = decideAvailability(platform, arch, loader);
	if (!loader) {
		availabilityCache.set(key, answer);
	}
	return answer;
}

function decideAvailability(platform: NodeJS.Platform, arch: string, loader: PtyLoader | undefined): TerminalAvailability {
	const vendor = vendorDirectory();
	const builtHere = vendor !== undefined && fs.existsSync(path.join(vendor, 'build', 'Release', platform === 'win32' ? 'conpty.node' : 'pty.node'));
	const prebuilt = (platform === 'darwin' || platform === 'win32') && (arch === 'arm64' || arch === 'x64');
	if (!prebuilt && !builtHere) {
		if (platform === 'linux') {
			return { ok: false, reason: 'The built-in terminal is not available on Linux yet: node-pty ships no Linux prebuilt binary.' };
		}
		return { ok: false, reason: 'The built-in terminal is not available on ' + platform + ' (' + arch + '): node-pty ships no prebuilt binary for it.' };
	}
	if (!loader && vendor !== undefined && !builtHere) {
		const needed = platform === 'win32'
			? [path.join('prebuilds', platform + '-' + arch, 'conpty.node')]
			: [path.join('prebuilds', platform + '-' + arch, 'pty.node'), path.join('prebuilds', platform + '-' + arch, 'spawn-helper')];
		for (const file of needed) {
			if (!fs.existsSync(path.join(vendor, file))) {
				return { ok: false, reason: 'The terminal backend is incomplete: ' + path.join(vendor, file) + ' is missing. Reinstall the extension.' };
			}
		}
	}
	try {
		(loader ?? defaultLoader)();
	} catch (error) {
		return { ok: false, reason: 'The terminal backend could not be loaded: ' + (error instanceof Error ? error.message : String(error)) };
	}
	return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Shell, environment
// ---------------------------------------------------------------------------------------------

export interface ShellProfile {
	path?: string | string[];
	args?: string[] | string;
	source?: string;
}

export interface ShellProfileSettings {
	defaultProfile?: string;
	profiles?: Record<string, ShellProfile | null>;
}

/** Splits a profile's `args` given as one string, keeping quoted parts whole. */
function splitArgs(text: string): string[] {
	const out: string[] = [];
	let current = '';
	let quote: string | undefined;
	let started = false;
	for (const ch of text) {
		if (quote) {
			if (ch === quote) {
				quote = undefined;
			} else {
				current += ch;
			}
		} else if (ch === '"' || ch === '\'') {
			quote = ch;
			started = true;
		} else if (/\s/.test(ch)) {
			if (started || current) {
				out.push(current);
			}
			current = '';
			started = false;
		} else {
			current += ch;
		}
	}
	if (started || current) {
		out.push(current);
	}
	return out;
}

function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
	if (platform !== 'win32') {
		return env[name];
	}
	const wanted = name.toUpperCase();
	for (const key of Object.keys(env)) {
		if (key.toUpperCase() === wanted) {
			return env[key];
		}
	}
	return undefined;
}

/** `${env:NAME}` in a profile's path, as VS Code reads it. */
function substitute(value: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
	return value.replace(/\$\{env:([^}]+)\}/g, (_all, name: string) => envValue(env, name, platform) ?? '');
}

/** A program named without a folder, found on `PATH` the way a shell would. */
function onPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists: (p: string) => boolean): string | undefined {
	const p = platform === 'win32' ? path.win32 : path.posix;
	const dirs = (envValue(env, 'PATH', platform) ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
	const extensions = platform === 'win32' && !p.extname(name)
		? (envValue(env, 'PATHEXT', platform) ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
		: [''];
	for (const dir of dirs) {
		for (const ext of extensions) {
			const candidate = p.join(dir, name + ext);
			if (exists(candidate)) {
				return candidate;
			}
		}
	}
	return undefined;
}

function firstExisting(candidates: readonly string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists: (p: string) => boolean): string | undefined {
	for (const raw of candidates) {
		const candidate = substitute(raw, env, platform);
		if (!candidate) {
			continue;
		}
		if (/[\\/]/.test(candidate)) {
			if (exists(candidate)) {
				return candidate;
			}
		} else {
			const found = onPath(candidate, env, platform, exists);
			if (found) {
				return found;
			}
		}
	}
	return undefined;
}

/** The profiles VS Code offers by name even when `terminal.integrated.profiles.*` does not define them. */
function builtinCandidates(name: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
	const key = name.toLowerCase();
	if (platform === 'win32') {
		const programFiles = [envValue(env, 'ProgramFiles', platform), envValue(env, 'ProgramFiles(x86)', platform)].filter((v): v is string => !!v);
		switch (key) {
			case 'powershell': return ['pwsh.exe', 'powershell.exe'];
			case 'windows powershell': return ['powershell.exe'];
			case 'command prompt': case 'cmd': return [envValue(env, 'COMSPEC', platform) ?? 'cmd.exe'];
			case 'git bash': return programFiles.map(dir => path.win32.join(dir, 'Git', 'bin', 'bash.exe'));
			case 'wsl': return ['wsl.exe'];
			default: return [];
		}
	}
	switch (key) {
		case 'bash': case 'zsh': case 'fish': case 'sh': case 'dash': case 'pwsh': case 'tmux':
			return [key === 'tmux' ? 'tmux' : key];
		case 'powershell': return ['pwsh'];
		default: return [];
	}
}

/** What `-l` is for: the shells a login shell matters for on macOS, so `.zprofile`'s `PATH` is loaded as in Terminal. */
const loginShells = new Set(['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh']);

/**
 * The shell to start: VS Code's own default profile (`terminal.integrated.defaultProfile.<platform>` read by the
 * caller, looked up in `terminal.integrated.profiles.<platform>`), else `$SHELL` — a login shell on macOS, as VS Code
 * starts it — else the platform's own (`/bin/sh`, `%COMSPEC%`).
 */
export function resolveShell(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, settings: ShellProfileSettings, exists: (p: string) => boolean = fs.existsSync): { file: string; args: string[]; name: string } {
	const p = platform === 'win32' ? path.win32 : path.posix;
	const baseName = (file: string) => p.basename(file).replace(/\.(exe|cmd|bat)$/i, '');
	const wanted = settings.defaultProfile;
	if (wanted) {
		const profile = settings.profiles?.[wanted];
		let file: string | undefined;
		if (profile) {
			const paths = profile.path === undefined ? [] : Array.isArray(profile.path) ? profile.path : [profile.path];
			file = firstExisting(paths, env, platform, exists);
			if (!file && paths.length === 0 && profile.source) {
				file = firstExisting(builtinCandidates(profile.source, platform, env), env, platform, exists);
			}
		}
		if (!file && profile === undefined) {
			file = firstExisting(builtinCandidates(wanted, platform, env), env, platform, exists);
		}
		if (file) {
			let args: string[];
			if (profile && profile.args !== undefined) {
				args = Array.isArray(profile.args) ? profile.args.filter(a => typeof a === 'string') : splitArgs(profile.args);
			} else {
				args = platform === 'darwin' && loginShells.has(baseName(file)) ? ['-l'] : [];
			}
			return { file, args, name: wanted };
		}
	}
	if (platform === 'win32') {
		const file = envValue(env, 'COMSPEC', platform) || 'powershell.exe';
		return { file, args: [], name: baseName(file) };
	}
	const fromEnv = env.SHELL && exists(env.SHELL) ? env.SHELL : undefined;
	if (platform === 'darwin') {
		const file = fromEnv ?? (exists('/bin/zsh') ? '/bin/zsh' : '/bin/sh');
		return { file, args: ['-l'], name: baseName(file) };
	}
	const file = fromEnv ?? '/bin/sh';
	return { file, args: [], name: baseName(file) };
}

const scrubbedExact = ['NODE_OPTIONS', 'CLAUDECODE'];
const scrubbedPrefixes = ['VSCODE_', 'ELECTRON_', 'AI_BROWSER_MCP_', 'TERM_PROGRAM'];

/**
 * The environment a shell is started with: the extension host's own, without what only the host (or the chat's CLIs)
 * should hold — the editor's `VSCODE_*` and `ELECTRON_*` (`ELECTRON_RUN_AS_NODE` would turn every `code` or Electron
 * program started from the shell into a Node), `NODE_OPTIONS`, the browser server's token and tab — then ours.
 * `extra` is applied last, so an agent terminal can put the token back on purpose.
 */
export function scrubEnv(env: NodeJS.ProcessEnv, extra: Record<string, string> = {}, platform: NodeJS.Platform = process.platform): Record<string, string> {
	const windows = platform === 'win32';
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value !== 'string') {
			continue;
		}
		const check = windows ? key.toUpperCase() : key;
		if (scrubbedExact.includes(check) || scrubbedPrefixes.some(prefix => check.startsWith(prefix))) {
			continue;
		}
		out[key] = value;
	}
	const set = (key: string, value: string): void => {
		if (windows) {
			for (const existing of Object.keys(out)) {
				if (existing.toUpperCase() === key.toUpperCase()) {
					delete out[existing];
				}
			}
		}
		out[key] = value;
	};
	set('TERM', 'xterm-256color');
	set('COLORTERM', 'truecolor');
	set('TERM_PROGRAM', 'ai-browser');
	// An editor started from the Dock has no locale, and a shell without one draws UTF-8 as `?`.
	if (!windows && !out.LANG && !out.LC_ALL && !out.LC_CTYPE) {
		out.LANG = 'en_US.UTF-8';
	}
	for (const [key, value] of Object.entries(extra)) {
		set(key, value);
	}
	return out;
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

function clampLimit(value: unknown, min: number, max: number, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xD800 && code <= 0xDBFF;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xDC00 && code <= 0xDFFF;
}

/**
 * Where a tail cut at `start` may begin without drawing garbage in a fresh screen: not between the halves of a
 * surrogate pair, not inside an escape sequence, and after the next line break when one is near. A cut that is
 * moved only ever moves forward, so the tail stays within its budget.
 */
export function safeTailStart(text: string, start: number): number {
	if (start <= 0) {
		return 0;
	}
	if (start >= text.length) {
		return text.length;
	}
	if (isLowSurrogate(text.charCodeAt(start))) {
		start++;
	}
	// Inside an escape sequence that began before the cut?
	const esc = text.lastIndexOf('\x1b', start - 1);
	if (esc >= 0 && start - esc <= 512) {
		const end = escapeEnd(text, esc);
		if (end > start) {
			start = end;
		}
	}
	// A line break close by is a better start than any mid-line cut: the colours and the cursor are the line's own.
	const horizon = Math.min(text.length, start + 2048);
	const newline = text.indexOf('\n', start - 1);
	if (newline >= 0 && newline + 1 <= horizon && newline + 1 >= start) {
		start = newline + 1;
	}
	return Math.min(start, text.length);
}

/** The index just past the escape sequence that begins at `esc`, or `text.length` when it is not finished. */
function escapeEnd(text: string, esc: number): number {
	const kind = text.charAt(esc + 1);
	if (kind === '') {
		return text.length;
	}
	if (kind === '[') {
		let i = esc + 2;
		while (i < text.length) {
			const c = text.charCodeAt(i);
			if (c >= 0x40 && c <= 0x7e) {
				return i + 1;
			}
			if (c < 0x20 || c > 0x3f) {
				return i; // not a CSI after all
			}
			i++;
		}
		return text.length;
	}
	if (kind === ']' || kind === 'P' || kind === '_' || kind === '^' || kind === 'X') {
		for (let i = esc + 2; i < text.length; i++) {
			const c = text.charCodeAt(i);
			if (c === 0x07 && kind === ']') {
				return i + 1;
			}
			if (c === 0x1b) {
				return text.charAt(i + 1) === '\\' ? i + 2 : i;
			}
		}
		return text.length;
	}
	if (kind === '(' || kind === ')' || kind === '*' || kind === '+' || kind === '#' || kind === '%') {
		return Math.min(esc + 3, text.length);
	}
	return esc + 2;
}

export interface TerminalSessionOptions extends PtySpawn {
	/** A batch of output, and the number of units emitted up to and including it. */
	onData: (chunk: string, seq: number) => void;
	/** The shell ended; every byte it wrote has been delivered by then. */
	onExit: (code: number | undefined) => void;
	/** Stop reading the shell above this many unacknowledged units (default 1 MB)… */
	ackHigh?: number;
	/** …and read again below this many (default 256 KB). */
	ackLow?: number;
	batchMs?: number;
	maxBatch?: number;
	tailBytes?: number;
	/** The screen model this shell feeds; `TerminalHost` makes one. Without it reads fall back to the stream's tail. */
	screen?: ScreenModel;
	/** Lines of scrollback the host-side screen keeps (default 3000, at most 10000). */
	scrollback?: number;
}

type SessionOptions = Omit<TerminalSessionOptions, keyof PtySpawn>;

/** One shell: batches its output, pauses it while the view is behind, keeps a tail for a view that reloads. */
export class TerminalSession {
	private readonly _pty: PtyProcess;
	private readonly _onData: (chunk: string, seq: number) => void;
	private readonly _onExit: (code: number | undefined) => void;
	private readonly _high: number;
	private readonly _low: number;
	private readonly _batchMs: number;
	private readonly _maxBatch: number;
	private readonly _tailBytes: number;
	private _pending = '';
	private _timer: ReturnType<typeof setTimeout> | undefined;
	private _held = false;
	private _seq = 0;
	private _outstanding = 0;
	private _paused = false;
	private _tail = '';
	private _exited = false;
	private _exitCode: number | undefined;
	private _disposed = false;
	private _cols = 0;
	private _rows = 0;
	private readonly _screen: ScreenModel | undefined;
	private _lastOutputAt = Date.now();
	/** When the keys last went to the shell (`Date.now()`), 0 before any. Stamped by `write`, whoever sent them. */
	lastInputAt = 0;

	constructor(pty: PtyProcess, o: SessionOptions) {
		this._pty = pty;
		this._screen = o.screen;
		this._screen?.attach({ flush: () => this._flush(false), drained: () => this._maybeResume() });
		this._onData = o.onData;
		this._onExit = o.onExit;
		const num = (value: number | undefined, fallback: number, min: number): number =>
			typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.floor(value)) : fallback;
		this._maxBatch = num(o.maxBatch, defaultMaxBatch, 1);
		this._batchMs = num(o.batchMs, defaultBatchMs, 0);
		this._tailBytes = num(o.tailBytes, defaultTailBytes, 1);
		this._high = num(o.ackHigh, defaultAckHigh, 1);
		this._low = Math.min(num(o.ackLow, defaultAckLow, 0), this._high);
		pty.onData(data => this._receive(data));
		pty.onExit(e => this._finish(e.exitCode));
	}

	get exited(): boolean {
		return this._exited;
	}

	get exitCode(): number | undefined {
		return this._exitCode;
	}

	get disposed(): boolean {
		return this._disposed;
	}

	/** Keys and pastes for the shell; ignored once it has ended. */
	write(data: string): void {
		if (this._exited || this._disposed || typeof data !== 'string' || data.length === 0 || data.length > maxWrite) {
			return;
		}
		try {
			this._pty.write(data);
		} catch { /* the shell went between the check and the write */ }
		this.lastInputAt = Date.now();
		this._screen?.noteInput(data, this._seq + this._pending.length);
	}

	/** A new size, clamped; ignored once the shell has ended and when it is the size it already has. */
	resize(cols: number, rows: number): void {
		if (this._exited || this._disposed || !Number.isFinite(cols) || !Number.isFinite(rows)) {
			return;
		}
		const c = Math.min(maxCols, Math.max(minCols, Math.floor(cols)));
		const r = Math.min(maxRows, Math.max(minRows, Math.floor(rows)));
		if (c === this._cols && r === this._rows) {
			return;
		}
		try {
			this._pty.resize(c, r);
			this._cols = c;
			this._rows = r;
			this._screen?.resize(c, r);
		} catch { /* ended meanwhile */ }
	}

	/** The view wrote `bytes` of what it was sent to its screen; reading the shell resumes once few enough are outstanding. */
	ack(bytes: number): void {
		if (!Number.isFinite(bytes) || bytes <= 0) {
			return;
		}
		this._outstanding = Math.max(0, this._outstanding - Math.floor(bytes));
		this._maybeResume();
	}

	/** Counts nothing as outstanding: the view that owed the acknowledgements is gone (its page reloaded, or it was rebuilt). */
	resetAck(): void {
		this._outstanding = 0;
		this._maybeResume();
	}

	/** The tail of what has been delivered, and `seq` of its last unit: the view drops live data up to that `seq`. */
	replay(): { data: string; seq: number } {
		this._trimTail(this._tailBytes);
		return { data: this._tail, seq: this._seq };
	}

	dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = undefined;
		}
		this._pending = '';
		this._screen?.dispose();
		if (!this._exited) {
			try { this._pty.kill(); } catch { /* already gone */ }
		}
	}

	// -- the screen ---------------------------------------------------------------------------

	/** Whether reads come from the headless emulator (false: the stream's tail with its escapes taken out). */
	get screenDegraded(): boolean {
		return !this._screen || this._screen.failed;
	}

	/**
	 * The screen as text. Settles first (what the session holds back is delivered, the emulator finishes what it was
	 * given, at most 250 ms), so a read right after a write sees it. Falls back to the stream's tail, flagged
	 * `degraded`, where the emulator could not be loaded or has failed.
	 */
	async readScreen(o: ScreenReadOptions = {}): Promise<ScreenRead> {
		const screen = this._screen;
		if (screen && !screen.failed) {
			return screen.read(o);
		}
		return this._degradedRead(o);
	}

	/**
	 * Waits for the screen to settle, a text to appear, the shell to report the end of a command, or it to exit —
	 * whichever comes first, within `timeoutMs` (at most 120 s). Always answers with a read and the reason.
	 */
	async waitFor(o: ScreenWaitOptions): Promise<ScreenWait> {
		const screen = this._screen;
		if (screen && !screen.failed) {
			return screen.wait(o);
		}
		return this._degradedWait(o);
	}

	private _degradedState(): ScreenState {
		const state: ScreenState = {
			status: this._exited ? 'exited' : 'running',
			altScreen: false,
			idleMs: Math.max(0, Date.now() - this._lastOutputAt),
			cols: this._cols || 80,
			rows: this._rows || 24,
			commandState: 'unknown',
			integration: 'none',
			degraded: true,
		};
		if (this._exitCode !== undefined) {
			state.exitCode = this._exitCode;
		}
		return state;
	}

	private _degradedRead(o: ScreenReadOptions): ScreenRead {
		this._flush(false);
		const generation = 'd';
		const state = this._degradedState();
		const rows = state.rows;
		const wanted = clampLimit(o.maxChars, 100, 40_000, 12_000);
		let truncated = false;
		let source = this._tail;
		const match = typeof o.since === 'string' ? /^d\.(\d+)$/.exec(o.since) : null;
		if (typeof o.since === 'string' && o.since !== '') {
			const owed = match ? this._seq - Number(match[1]) : -1;
			if (owed >= 0 && owed <= this._tail.length) {
				source = this._tail.slice(this._tail.length - owed);
			} else {
				truncated = true;
			}
		}
		const viewport = plainText(this._tail, rows);
		let text = o.since !== undefined || o.scrollback ? plainText(source, 500).replace(/^\n+/, '') : viewport;
		if (text.length > wanted) {
			text = text.slice(text.length - wanted);
			truncated = true;
		}
		return { text, viewport: viewport.length > wanted ? viewport.slice(viewport.length - wanted) : viewport, cursor: generation + '.' + this._seq, truncated, state };
	}

	private async _degradedWait(o: ScreenWaitOptions): Promise<ScreenWait> {
		const started = Date.now();
		const deadline = started + clampLimit(o.timeoutMs, 0, 120_000, 30_000);
		const quiet = clampLimit(o.quietMs, 50, 60_000, 800);
		if (o.until === 'text' && (typeof o.text !== 'string' || o.text === '')) {
			throw new Error('A text wait needs the text to wait for.');
		}
		for (;;) {
			this._flush(false);
			const now = Date.now();
			let reason: ScreenWait['reason'] | undefined;
			const read = this._degradedRead({ since: o.since, scrollback: o.scrollback, maxChars: o.maxChars });
			if (o.signal?.aborted) {
				reason = 'aborted';
			} else if (o.until === 'text' && o.text && (read.viewport.includes(o.text) || read.text.includes(o.text))) {
				reason = 'text';
			} else if (this._exited || this._disposed) {
				reason = 'exit';
			} else if ((o.until === 'idle' || o.until === 'command') && now - Math.max(started, this._lastOutputAt) >= quiet) {
				reason = 'idle';
			} else if (now >= deadline) {
				reason = 'timeout';
			}
			if (reason) {
				return { ...read, reason };
			}
			await new Promise<void>(resolve => {
				const finish = (): void => { clearTimeout(timer); o.signal?.removeEventListener('abort', finish); resolve(); };
				const timer = setTimeout(finish, Math.max(1, Math.min(100, deadline - now)));
				o.signal?.addEventListener('abort', finish, { once: true });
			});
		}
	}

	private _receive(data: string): void {
		if (this._exited || this._disposed || data.length === 0) {
			return;
		}
		this._pending += data;
		this._held = false;
		if (this._pending.length >= this._maxBatch) {
			this._flush(false);
		} else if (!this._timer) {
			this._timer = setTimeout(() => { this._timer = undefined; this._flush(false); }, this._batchMs);
		}
	}

	/** Sends the pending output in batches of at most `maxBatch`, never cutting a surrogate pair in two. */
	private _flush(final: boolean): void {
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = undefined;
		}
		while (this._pending.length > 0 && !this._disposed) {
			let cut = Math.min(this._pending.length, this._maxBatch);
			let holding = false;
			if (isHighSurrogate(this._pending.charCodeAt(cut - 1))) {
				if (cut < this._pending.length) {
					cut = cut > 1 ? cut - 1 : cut + 1;
				} else if (!final && !this._held) {
					// A pair whose second half has not come yet (node-pty decodes whole code points, so this is
					// only a safeguard): wait for it once.
					cut -= 1;
					holding = true;
					this._held = true;
				}
			}
			if (cut > 0) {
				const chunk = this._pending.slice(0, cut);
				this._pending = this._pending.slice(cut);
				this._emit(chunk);
			}
			if (holding) {
				break;
			}
		}
		if (this._pending.length > 0 && !final && !this._disposed && !this._timer) {
			this._timer = setTimeout(() => { this._timer = undefined; this._flush(false); }, this._batchMs);
		}
	}

	private _emit(chunk: string): void {
		this._seq += chunk.length;
		this._outstanding += chunk.length;
		this._tail += chunk;
		if (this._tail.length > this._tailBytes + (this._tailBytes >> 2)) {
			this._trimTail(this._tailBytes);
		}
		this._lastOutputAt = Date.now();
		this._screen?.feed(chunk, this._seq);
		if (!this._paused && (this._outstanding > this._high || (this._screen !== undefined && this._screen.backlog > emulatorBacklogHigh))) {
			this._paused = true;
			try { this._pty.pause(); } catch { /* ended */ }
		}
		try {
			this._onData(chunk, this._seq);
		} catch { /* a view that went away must not stop the shell's reader */ }
	}

	private _maybeResume(): void {
		if (this._paused && this._outstanding <= this._low && (this._screen === undefined || this._screen.backlog <= emulatorBacklogLow) && !this._exited && !this._disposed) {
			this._paused = false;
			try { this._pty.resume(); } catch { /* ended */ }
		}
	}

	private _trimTail(budget: number): void {
		if (this._tail.length > budget) {
			this._tail = this._tail.slice(safeTailStart(this._tail, this._tail.length - budget));
		}
	}

	private _finish(exitCode: number | undefined): void {
		if (this._exited || this._disposed) {
			return;
		}
		this._flush(true);
		this._exited = true;
		this._exitCode = typeof exitCode === 'number' ? exitCode : undefined;
		this._screen?.markExit(this._exitCode);
		try {
			this._onExit(this._exitCode);
		} catch { /* as above */ }
	}
}

/** Builds the host-side screen of a new shell; throws when the emulator cannot be loaded. */
export type ScreenFactory = (o: ScreenModelOptions) => ScreenModel;

let defaultScreens: ScreenFactory | undefined;

/**
 * `createScreenModel` of the compiled `./screenModel`. A dynamic `require`, like node-pty's: this module may not
 * import it as a value (it is loaded by `npm test`, where there is no `require` and so, deliberately, no screen
 * unless the test passes a factory).
 */
function defaultScreenFactory(): ScreenFactory | undefined {
	if (defaultScreens) {
		return defaultScreens;
	}
	if (typeof require !== 'function') {
		return undefined;
	}
	try {
		defaultScreens = (require('./screenModel') as { createScreenModel: ScreenFactory }).createScreenModel;
	} catch {
		return undefined;
	}
	return defaultScreens;
}

/** The shells of one chat view: starts them, and ends every one with the view. */
export class TerminalHost {
	private readonly _loader: PtyLoader | undefined;
	private readonly _screens: ScreenFactory | false | undefined;
	private readonly _sessions = new Set<TerminalSession>();
	private _disposed = false;

	/** `screens`: another screen factory (a test's), or `false` for none — the default is the compiled screen model. */
	constructor(loader?: PtyLoader, screens?: ScreenFactory | false) {
		this._loader = loader;
		this._screens = screens;
	}

	/** Starts a shell. Throws an `Error` whose message is fit to show the user when it cannot. */
	create(o: TerminalSessionOptions): TerminalSession {
		if (this._disposed) {
			throw new Error('The terminal was shut down with its chat view.');
		}
		for (const session of this._sessions) {
			if (session.disposed || session.exited) {
				this._sessions.delete(session);
			}
		}
		// An injected loader is the caller's own backend (a test's): the platform rules are for node-pty.
		if (!this._loader) {
			const availability = terminalAvailability();
			if (!availability.ok) {
				throw new Error(availability.reason ?? 'The terminal is not available.');
			}
		}
		const clamp = (value: number, min: number, max: number) => Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : min;
		let pty: PtyProcess;
		try {
			pty = (this._loader ?? defaultLoader)().spawn({
				file: o.file,
				args: o.args,
				cwd: o.cwd,
				env: o.env,
				cols: clamp(o.cols, minCols, maxCols),
				rows: clamp(o.rows, minRows, maxRows),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error('Could not start ' + o.file + ' in ' + o.cwd + ': ' + message + (/posix_spawnp|ENOENT|not found/i.test(message) ? ' (check that the shell and the folder exist)' : ''));
		}
		const cols = clamp(o.cols, minCols, maxCols);
		const rows = clamp(o.rows, minRows, maxRows);
		let screen = o.screen;
		if (!screen && this._screens !== false) {
			try {
				// A shell whose screen cannot be built still works; its reads are degraded.
				screen = (this._screens ?? defaultScreenFactory())?.({
					cols,
					rows,
					cwd: o.cwd,
					scrollback: o.scrollback,
					windowsPty: process.platform === 'win32' ? { backend: 'conpty' } : undefined,
				});
			} catch {
				screen = undefined;
			}
		}
		const session = new TerminalSession(pty, { ...o, screen });
		this._sessions.add(session);
		return session;
	}

	dispose(): void {
		this._disposed = true;
		for (const session of this._sessions) {
			session.dispose();
		}
		this._sessions.clear();
	}
}

// ---------------------------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------------------------

/**
 * A screen's text as a person reads it: escape sequences and control characters gone, a line redrawn with `\r` left
 * as its last drawing, backspaces applied, trailing spaces and blank lines trimmed, and the last `lastLines` lines.
 */
export function plainText(screen: string, lastLines?: number): string {
	let text = screen
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, '')
		.replace(/\x1b[P_^X][^\x1b]*(?:\x1b\\|$)/g, '')
		.replace(/\x1b\[[0-?]*[ -/]*(?:[@-~]|$)/g, '')
		.replace(/\x1b[()*+#%][ -~]/g, '')
		.replace(/\x1b[\s\S]?/g, '');
	for (let before = ''; before !== text;) {
		before = text;
		text = text.replace(/[^\n\x08]\x08/g, '');
	}
	text = text.replace(/\r\n/g, '\n');
	const lines = text.split('\n').map(line => {
		if (line.includes('\r')) {
			const parts = line.split('\r').filter(part => part.length > 0);
			line = parts.length > 0 ? parts[parts.length - 1] : '';
		}
		return line.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/[ \t]+$/, '');
	});
	while (lines.length > 0 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	const kept = typeof lastLines === 'number' && lastLines >= 0 && Number.isFinite(lastLines) ? lines.slice(Math.max(0, lines.length - Math.floor(lastLines))) : lines;
	return kept.join('\n');
}
