import { execFile } from 'node:child_process';
import { readlink, stat } from 'node:fs/promises';

/**
 * Read-only facts about one running process, for the Bash tab's Inspect view.
 * Nothing here attaches to the process, reads its pipes or writes to it: a
 * pipe has one reader, and taking its data would take it from the program the
 * process writes to. What can be followed safely is a regular file the process
 * writes its output into, which any number of readers may read.
 *
 * Shown in a VS Code terminal only, never posted into a chat state: the
 * command line may carry credentials, and the monitor keeps executable names
 * for that reason. Leaf module apart from Node's own modules, under test.
 */
export type OutputKind = 'file' | 'pipe' | 'terminal' | 'socket' | 'null' | 'other' | 'unknown';
export interface OutputTarget { readonly fd: 1 | 2; readonly kind: OutputKind; readonly path?: string }
export interface ProcessDetails {
	readonly commandLine?: string;
	readonly cwd?: string;
	readonly cpu?: string;
	readonly memory?: string;
	readonly elapsed?: string;
	readonly state?: string;
	readonly outputs: readonly OutputTarget[];
}

const maxCommandLine = 4000;
const cap = (text: string | undefined) => text === undefined ? undefined : text.length > maxCommandLine ? `${text.slice(0, maxCommandLine)}…` : text;

/** `ps -o pcpu=,rss=,etime=,stat=,args=` for one pid. RSS is in KiB on both macOS and Linux. */
export function parsePsDetails(text: string): Pick<ProcessDetails, 'cpu' | 'memory' | 'elapsed' | 'state' | 'commandLine'> | undefined {
	const line = text.split('\n').find(l => l.trim());
	const match = line && /^\s*([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*?)\s*$/.exec(line);
	if (!match) { return undefined; }
	return { cpu: `${match[1]}%`, memory: formatKiB(Number(match[2])), elapsed: match[3], state: match[4], commandLine: cap(match[5]) };
}

export function formatKiB(kib: number): string {
	if (!Number.isFinite(kib) || kib < 0) { return '?'; }
	return kib >= 1024 * 1024 ? `${(kib / 1024 / 1024).toFixed(1)} GB` : kib >= 1024 ? `${(kib / 1024).toFixed(1)} MB` : `${kib} KB`;
}

/**
 * `lsof -a -p <pid> -d cwd,1,2 -F ftn`: a `p` line, then per descriptor `f<fd>`,
 * `t<type>` and `n<name>`. Types: REG, DIR, CHR (a tty or /dev/null), PIPE,
 * FIFO, unix, IPv4/IPv6.
 */
export function parseLsof(text: string): { cwd?: string; outputs: OutputTarget[] } {
	let fd: string | undefined; let type: string | undefined;
	let cwd: string | undefined;
	const outputs: OutputTarget[] = [];
	for (const line of text.split('\n')) {
		const tag = line[0]; const value = line.slice(1);
		if (tag === 'f') { fd = value; type = undefined; }
		else if (tag === 't') { type = value; }
		else if (tag === 'n' && fd) {
			if (fd === 'cwd') { cwd = value; }
			else if (fd === '1' || fd === '2') {
				outputs.push({ fd: fd === '1' ? 1 : 2, ...classifyLsof(type, value) });
			}
			fd = undefined;
		}
	}
	return { cwd, outputs };
}

function classifyLsof(type: string | undefined, name: string): { kind: OutputKind; path?: string } {
	switch (type) {
		case 'REG': return { kind: 'file', path: name };
		case 'PIPE': case 'FIFO': return { kind: 'pipe' };
		case 'unix': case 'IPv4': case 'IPv6': case 'sock': return { kind: 'socket' };
		case 'CHR': return name === '/dev/null' ? { kind: 'null' } : /\/dev\/(tty|pts)/.test(name) ? { kind: 'terminal', path: name } : { kind: 'other', path: name };
		default: return { kind: 'unknown' };
	}
}

/** A `/proc/<pid>/fd/N` link target. A regular file is confirmed by `stat` separately. */
export function classifyProcLink(target: string): { kind: OutputKind; path?: string } {
	if (target.startsWith('pipe:')) { return { kind: 'pipe' }; }
	if (target.startsWith('socket:')) { return { kind: 'socket' }; }
	if (target === '/dev/null') { return { kind: 'null' }; }
	if (/^\/dev\/(pts\/|tty)/.test(target)) { return { kind: 'terminal', path: target }; }
	if (target.startsWith('/')) { return { kind: 'other', path: target.replace(/ \(deleted\)$/, '') }; }
	return { kind: 'unknown' };
}

/** `Get-CimInstance Win32_Process` piped through `ConvertTo-Json`. */
export function parseWindowsProcess(text: string): Pick<ProcessDetails, 'commandLine' | 'memory' | 'elapsed'> | undefined {
	let value: unknown;
	try { value = JSON.parse(text); } catch { return undefined; }
	if (!value || typeof value !== 'object') { return undefined; }
	const item = value as { CommandLine?: unknown; WorkingSetSize?: unknown; CreationDate?: unknown };
	const created = typeof item.CreationDate === 'string' ? Date.parse(item.CreationDate) : NaN;
	return {
		commandLine: typeof item.CommandLine === 'string' ? cap(item.CommandLine) : undefined,
		memory: typeof item.WorkingSetSize === 'number' ? formatKiB(Math.round(item.WorkingSetSize / 1024)) : undefined,
		elapsed: Number.isFinite(created) ? formatElapsed(Date.now() - created) : undefined,
	};
}

export function formatElapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
	return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

function run(file: string, args: string[], timeout = 3000): Promise<string> {
	return new Promise(resolve => {
		execFile(file, args, { env: { ...process.env, LC_ALL: 'C' }, timeout, maxBuffer: 1024 * 1024, windowsHide: true },
			(_error, stdout) => resolve(String(stdout ?? '')));
	});
}

/** Each source answers what it can; a missing tool or a protected process is a blank field, not an error. */
export async function readProcessDetails(pid: number, platform: NodeJS.Platform = process.platform): Promise<ProcessDetails> {
	if (!Number.isSafeInteger(pid) || pid <= 0) { return { outputs: [] }; }
	if (platform === 'win32') {
		const script = `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object CommandLine,WorkingSetSize,@{n='CreationDate';e={$_.CreationDate.ToString('o')}} | ConvertTo-Json -Compress`;
		const details = parseWindowsProcess(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 8000));
		// Windows exposes no standard handle targets of another process without native code.
		return { ...details, outputs: [{ fd: 1, kind: 'unknown' }, { fd: 2, kind: 'unknown' }] };
	}
	const ps = parsePsDetails(await run('/bin/ps', ['-o', 'pcpu=,rss=,etime=,stat=,args=', '-p', String(pid)]));
	if (platform === 'linux') {
		const link = (name: string) => readlink(`/proc/${pid}/${name}`).catch(() => undefined);
		const cwd = await link('cwd');
		const outputs: OutputTarget[] = [];
		for (const fd of [1, 2] as const) {
			const target = await link(`fd/${fd}`);
			if (target === undefined) { outputs.push({ fd, kind: 'unknown' }); continue; }
			const kind = classifyProcLink(target);
			const regular = kind.kind === 'other' && kind.path && await stat(kind.path).then(s => s.isFile(), () => false);
			outputs.push({ fd, ...(regular ? { kind: 'file', path: kind.path } : kind) });
		}
		return { ...ps, cwd, outputs };
	}
	if (platform === 'darwin') {
		const lsof = parseLsof(await run('/usr/sbin/lsof', ['-w', '-a', '-p', String(pid), '-d', 'cwd,1,2', '-F', 'ftn']));
		return { ...ps, cwd: lsof.cwd, outputs: lsof.outputs.length ? lsof.outputs : [{ fd: 1, kind: 'unknown' }, { fd: 2, kind: 'unknown' }] };
	}
	return { ...ps, outputs: [] };
}

/** The files worth following: regular files, each once (stdout and stderr often share one). */
export function followableOutputs(outputs: readonly OutputTarget[]): string[] {
	return [...new Set(outputs.filter(o => o.kind === 'file' && o.path).map(o => o.path!))];
}

export function describeOutput(o: OutputTarget): string {
	const name = o.fd === 1 ? 'stdout' : 'stderr';
	switch (o.kind) {
		case 'file': return `${name}: file ${o.path} — followed below`;
		case 'pipe': return `${name}: a pipe to another program — not readable without taking its data`;
		case 'terminal': return `${name}: terminal ${o.path ?? ''} — owned by that terminal`.replace(/  /g, ' ');
		case 'socket': return `${name}: a socket — not readable`;
		case 'null': return `${name}: discarded (/dev/null)`;
		case 'other': return `${name}: ${o.path ?? 'device'}`;
		default: return `${name}: not visible on this system`;
	}
}

/**
 * Text from a file a program writes, made safe for a terminal: colours (SGR)
 * are kept, every other escape sequence and control character goes — an OSC
 * in a log must not set the clipboard or a title in the user's terminal.
 */
export function terminalSafe(text: string): string {
	return text
		.replace(/\x1b\[[0-9;]*m|\x1b(\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)?|[@-Z\\-_])?/g, match => /^\x1b\[[0-9;]*m$/.test(match) ? match : '')
		.replace(/[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/g, c => c === '\x1b' ? c : '')
		.replace(/\r?\n/g, '\r\n');
}

export interface FollowFile {
	open(path: string): Promise<{ size(): Promise<number>; read(offset: number, length: number): Promise<Uint8Array>; close(): Promise<void> }>;
}

/**
 * Follows a regular file the way `tail -f` does, as an ordinary reader: the
 * last `tailBytes` first, then whatever is appended. A file that shrinks was
 * truncated or rotated and is read again from its start.
 */
export class FileFollower {
	private _offset = 0;
	private _timer?: ReturnType<typeof setTimeout>;
	private _stopped = false;
	private _decoder = new TextDecoder();
	private _handle?: Awaited<ReturnType<FollowFile['open']>>;

	private readonly _path: string;
	private readonly _write: (text: string) => void;
	private readonly _files: FollowFile;
	private readonly _tailBytes: number;
	private readonly _intervalMs: number;

	constructor(path: string, write: (text: string) => void, files: FollowFile, tailBytes = 32 * 1024, intervalMs = 500) {
		this._path = path; this._write = write; this._files = files; this._tailBytes = tailBytes; this._intervalMs = intervalMs;
	}

	public async start(): Promise<void> {
		try { this._handle = await this._files.open(this._path); }
		catch (error) { this._write(`[Cannot read ${this._path}: ${error instanceof Error ? error.message : String(error)}]\r\n`); return; }
		if (this._stopped) { void this._handle.close().catch(() => {}); return; }
		const size = await this._handle.size().catch(() => 0);
		this._offset = Math.max(0, size - this._tailBytes);
		if (this._offset) { this._write(`[… earlier output in ${this._path}]\r\n`); }
		await this.tick();
	}

	/** One read; schedules the next unless stopped. Exposed for tests and for a final read. */
	public async tick(): Promise<void> {
		if (this._stopped || !this._handle) { return; }
		if (this._timer) { clearTimeout(this._timer); this._timer = undefined; }
		try {
			const size = await this._handle.size();
			if (size < this._offset) { this._offset = 0; this._decoder = new TextDecoder(); this._write('\r\n[The file was truncated; reading from its start.]\r\n'); }
			if (size > this._offset) {
				const bytes = await this._handle.read(this._offset, Math.min(size - this._offset, 256 * 1024));
				this._offset += bytes.length;
				const text = this._decoder.decode(bytes, { stream: true });
				if (text) { this._write(terminalSafe(text)); }
			}
		} catch { /* A file removed or unreadable for a moment: try again next tick. */ }
		if (!this._stopped) { this._timer = setTimeout(() => { void this.tick(); }, this._intervalMs); this._timer.unref?.(); }
	}

	public stop(): void {
		this._stopped = true;
		if (this._timer) { clearTimeout(this._timer); this._timer = undefined; }
		void this._handle?.close().catch(() => {});
	}
}

export const nodeFiles: FollowFile = {
	async open(path) {
		const { open } = await import('node:fs/promises');
		const handle = await open(path, 'r');
		return {
			size: async () => (await handle.stat()).size,
			read: async (offset, length) => { const buffer = new Uint8Array(length); const { bytesRead } = await handle.read(buffer, 0, length, offset); return buffer.subarray(0, bytesRead); },
			close: () => handle.close(),
		};
	},
};
