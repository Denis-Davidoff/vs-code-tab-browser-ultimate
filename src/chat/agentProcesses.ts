import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AgentProcessEntry, AgentProcessSnapshot } from './chatProtocol';

export const processOwnerVariable = 'AI_BROWSER_PROCESS_OWNER';
export interface ProcessRow { pid: number; ppid: number; birth: string; command: string; zombie?: boolean }
interface Owner { chatId: string; source: string }
interface Root { pid: number; createdAt: number; birth?: string; owner?: Owner }
interface Tracked { row: ProcessRow; owner: Owner; seenAt: number; detached: boolean; attribution: 'environment' | 'ancestry' }
const identity = (row: Pick<ProcessRow, 'pid' | 'birth'>) => `${row.pid}:${row.birth}`;

/** Executable names only: argv and environments may contain credentials. */
export function parseProcessTable(text: string): ProcessRow[] {
	const rows: ProcessRow[] = [];
	for (const line of text.split('\n')) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(.+?)\s*$/.exec(line);
		if (match) { rows.push({ pid: Number(match[1]), ppid: Number(match[2]), birth: match[3].replace(/\s+/g, ' '), zombie: match[4].includes('Z'), command: match[5].slice(0, 512) }); }
	}
	return rows;
}

function ps(args: string[], allowMissing = false): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile('/bin/ps', args, { env: { ...process.env, LC_ALL: 'C' }, timeout: 1500, maxBuffer: 8 * 1024 * 1024 },
			(error, stdout) => error && !(allowMissing && error.code === 1) ? reject(error) : resolve(stdout));
	});
}
export async function readProcessTable(): Promise<ProcessRow[]> {
	if (process.platform === 'win32') { return parseWindowsProcessTable(await windowsProcesses()); }
	return parseProcessTable(await ps(['-x', '-o', 'pid=,ppid=,lstart=,stat=,comm=']));
}

/**
 * Windows has no `ps`: CIM gives pid, parent and creation time, which is the
 * birth identity (ISO, so `Date.parse` reads it like `lstart`). The environment
 * of another process is not readable there, so attribution is by ancestry from
 * the CLI the chat started — never by marker.
 */
export function parseWindowsProcessTable(text: string): ProcessRow[] {
	let value: unknown;
	try { value = JSON.parse(text || '[]'); } catch { throw new Error('Unreadable process table.'); }
	const items = Array.isArray(value) ? value : [value];
	const rows: ProcessRow[] = [];
	for (const item of items) {
		const { ProcessId: pid, ParentProcessId: ppid, Name: name, CreationDate: born } = (item ?? {}) as Record<string, unknown>;
		if (typeof pid === 'number' && typeof ppid === 'number' && typeof born === 'string' && born && Number.isFinite(Date.parse(born))) {
			rows.push({ pid, ppid, birth: born, command: typeof name === 'string' ? name.slice(0, 512) : '?' });
		}
	}
	return rows;
}
function windowsProcesses(): Promise<string> {
	const script = "Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | Select-Object ProcessId,ParentProcessId,Name,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress";
	return new Promise((resolve, reject) => {
		execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
			(error, stdout) => error ? reject(error) : resolve(String(stdout)));
	});
}

/** Only this non-secret correlation value survives the adapter. No raw environment is retained. */
export async function readProcessOwners(pids: readonly number[]): Promise<Map<number, string>> {
	const result = new Map<number, string>();
	if (!pids.length) { return result; }
	if (process.platform === 'linux') {
		// Bounded concurrency; disappearing or protected processes are normal.
		for (let offset = 0; offset < pids.length; offset += 8) {
			await Promise.all(pids.slice(offset, offset + 8).map(async pid => {
				try {
					const environment = await readFile(`/proc/${pid}/environ`, 'utf8');
					const marker = environment.split('\0').find(value => value.startsWith(`${processOwnerVariable}=`))?.slice(processOwnerVariable.length + 1);
					if (marker && /^[a-f0-9]{64}$/.test(marker)) { result.set(pid, marker); }
				} catch { /* Exited, inaccessible or environment intentionally cleared. */ }
			}));
		}
	} else if (process.platform === 'darwin') {
		// macOS exposes no /proc. Restrict ps to a bounded batch, never log its output.
		const text = await ps(['eww', '-p', pids.join(','), '-o', 'pid=,command='], true);
		for (const line of text.split('\n')) {
			const pid = /^\s*(\d+)\s/.exec(line)?.[1];
			const marker = /(?:^|\s)AI_BROWSER_PROCESS_OWNER=([a-f0-9]{64})(?=\s|$)/.exec(line)?.[1];
			if (pid && marker) { result.set(Number(pid), marker); }
		}
	}
	return result;
}

/**
 * How long to wait before the next sample. Cheap by default: a full process
 * table is read often only while somebody looks (the Bash tab open, an Inspect
 * terminal); otherwise the wait doubles on each sample that changed nothing, up
 * to a ceiling, and a command starting brings it back to the base. With no CLI
 * running and nothing tracked there is no timer at all. Windows pays a
 * PowerShell start per sample, so its every figure is larger.
 */
export interface SamplePace { readonly watchedMs: number; readonly baseMs: number; readonly maxMs: number; readonly floorMs: number; readonly unavailableMs: number }
export const samplePace = (platform: NodeJS.Platform = process.platform): SamplePace => platform === 'win32'
	? { watchedMs: 5_000, baseMs: 15_000, maxMs: 120_000, floorMs: 5_000, unavailableMs: 60_000 }
	: { watchedMs: 2_000, baseMs: 5_000, maxMs: 60_000, floorMs: 2_000, unavailableMs: 30_000 };
export function nextSampleDelay(pace: SamplePace, watched: boolean, backoffMs: number, unavailable: boolean): number {
	if (unavailable) { return pace.unavailableMs; }
	return watched ? pace.watchedMs : Math.min(Math.max(backoffMs, pace.baseMs), pace.maxMs);
}

/** One bounded sampler per extension host. Attribution is established by an injected chat
 * marker or a previously observed ancestor, never cwd, timing, argv, or a shared CLI PID.
 * Runtime-only state: no messages, model calls, conversation saves, or full-view refreshes.
 */
export class AgentProcessMonitor {
	private readonly read: () => Promise<ProcessRow[]>;
	private readonly readOwners: (pids: readonly number[]) => Promise<Map<number, string>>;
	private readonly now: () => number;
	private readonly supported: boolean;
	private readonly automatic: boolean;
	private readonly signal: (pid: number) => void;
	private readonly owners = new Map<string, Owner>();
	private readonly roots = new Map<number, Root>();
	private readonly tracked = new Map<number, Tracked>();
	private readonly checked = new Map<string, number>();
	private readonly listeners = new Set<() => void>();
	private timer?: ReturnType<typeof setTimeout>;
	private timerAt = Infinity;
	private sampledAt = -Infinity;
	private pending?: Promise<void>;
	private disposed = false;
	private discoveryPending = false;
	private lastShape = '';
	private readonly pace: SamplePace;
	private watchers = 0;
	private backoff: number;
	public snapshot: AgentProcessSnapshot;

	constructor(
		read = readProcessTable,
		readOwners = readProcessOwners,
		now = Date.now,
		supported = process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32',
		automatic = true,
		signal: (pid: number) => void = pid => { process.kill(pid, 'SIGTERM'); },
		pace: SamplePace = samplePace(),
	) {
		this.read = read; this.readOwners = readOwners; this.now = now;
		this.pace = pace; this.backoff = pace.baseMs;
		this.supported = supported; this.automatic = automatic; this.signal = signal;
		this.snapshot = { supported, processes: [] };
	}

	public subscribe(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => { this.listeners.delete(listener); } };
	}

	public forChat(chatId: string): AgentProcessSnapshot {
		const rows = this.snapshot.processes.filter(item => item.chatId === chatId);
		return { ...this.snapshot, processes: rows.slice(0, 256), ...(rows.length > 256 ? { truncated: true } : {}) };
	}

	/** A marker is correlation metadata, never an authorization credential. Stable across reloads. */
	public environment(chatId: string | undefined, source: string): Record<string, string> {
		if (!chatId || this.disposed || !this.supported) { return {}; }
		const marker = createHash('sha256').update(`ai-browser-process-v1\0${chatId}\0${source}`).digest('hex');
		if (!this.owners.has(marker) && this.owners.size < 1024) {
			this.owners.set(marker, { chatId, source });
			this.checked.clear(); this.discoveryPending = true; this.schedule(100);
		}
		return { [processOwnerVariable]: marker };
	}

	public register(pid: number, marker?: string): { dispose(): void } {
		if (!this.supported || this.disposed || !Number.isSafeInteger(pid) || pid <= 1 || this.roots.size >= 128) { return { dispose() {} }; }
		const root: Root = { pid, createdAt: this.now(), owner: marker ? this.owners.get(marker) : undefined };
		this.roots.set(pid, root); this.schedule(100);
		return { dispose: () => { if (this.roots.get(pid) === root) { this.roots.delete(pid); this.schedule(100); } } };
	}

	/** A command may have started or ended: sample soon, but never more often than the floor. */
	public commandChanged(): void {
		if (!this.roots.size || !this.owners.size) { return; }
		this.backoff = this.pace.baseMs;
		this.schedule(this.watchers ? 300 : 1500);
	}

	/**
	 * Somebody is looking at the processes: sample at the watched pace until the
	 * returned handle is disposed. Several watchers share one sampler.
	 */
	public watch(): { dispose(): void } {
		if (this.disposed || !this.supported) { return { dispose() {} }; }
		this.watchers++; this.backoff = this.pace.baseMs; this.schedule(100);
		let done = false;
		return { dispose: () => { if (!done) { done = true; this.watchers--; } } };
	}
	public get watched(): boolean { return this.watchers > 0; }

	private schedule(delay: number): void {
		if (!this.automatic || this.disposed || !this.supported) { return; }
		const at = Math.max(this.now() + delay, this.sampledAt + (this.snapshot.unavailable ? this.pace.unavailableMs : this.watchers ? 1000 : this.pace.floorMs));
		if (this.timer && this.timerAt <= at) { return; }
		if (this.timer) { clearTimeout(this.timer); }
		this.timerAt = at;
		this.timer = setTimeout(() => { this.timer = undefined; this.timerAt = Infinity; void this.refresh(); }, Math.max(0, at - this.now()));
		this.timer.unref?.();
	}

	public refresh(): Promise<void> {
		if (this.pending) { return this.pending; }
		if (this.disposed || !this.supported || !this.owners.size) { return Promise.resolve(); }
		this.pending = this.sample().finally(() => {
			this.pending = undefined;
			if (!this.disposed && this.owners.size && (this.roots.size || this.tracked.size || this.discoveryPending)) {
				this.schedule(nextSampleDelay(this.pace, this.watchers > 0, this.backoff, !!this.snapshot.unavailable));
			}
		});
		return this.pending;
	}

	private async sample(): Promise<void> {
		this.sampledAt = this.now();
		let rows: ProcessRow[];
		try { rows = await this.read(); }
		catch { if (!this.disposed) { this.publish({ ...this.snapshot, unavailable: true }); } return; }
		if (this.disposed) { return; }
		const live = new Map(rows.filter(row => !row.zombie).map(row => [row.pid, row]));
		const liveKeys = new Set([...live.values()].map(identity));
		for (const key of this.checked.keys()) { if (!liveKeys.has(key)) { this.checked.delete(key); } }
		for (const [pid, item] of this.tracked) {
			if (live.get(pid)?.birth !== item.row.birth) { this.tracked.delete(pid); }
			else { item.row = live.get(pid)!; item.detached = true; }
		}
		// Newest identities first; a bounded background pass also recovers marked orphans after reload.
		const births = new Map([...live.values()].map(row => [row.pid, Date.parse(row.birth) || 0]));
		const candidates = [...live.values()].filter(row => !this.tracked.has(row.pid) && !this.roots.has(row.pid) && (this.checked.get(identity(row)) ?? 0) < 2)
			.sort((a, b) => (this.checked.get(identity(a)) ?? 0) - (this.checked.get(identity(b)) ?? 0) || births.get(b.pid)! - births.get(a.pid)! || b.pid - a.pid).slice(0, 64);
		let unavailable = false;
		try {
			const markers = await this.readOwners(candidates.map(row => row.pid));
			if (this.disposed) { return; }
			for (const row of candidates) {
				this.checked.set(identity(row), (this.checked.get(identity(row)) ?? 0) + 1);
				const owner = this.owners.get(markers.get(row.pid) ?? '');
				if (owner && this.tracked.size < 2048) { this.tracked.set(row.pid, { row, owner, seenAt: this.now(), detached: true, attribution: 'environment' }); }
			}
		} catch { unavailable = true; }
		this.discoveryPending = [...live.values()].some(row => !this.tracked.has(row.pid) && !this.roots.has(row.pid) && (this.checked.get(identity(row)) ?? 0) < 2);
		const children = new Map<number, ProcessRow[]>();
		for (const row of live.values()) { const list = children.get(row.ppid) ?? []; list.push(row); children.set(row.ppid, list); }
		const visited = new Set<number>();
		let truncated = this.tracked.size >= 2048;
		const walk = (queue: { row: ProcessRow; owner: Owner; detached: boolean }[]) => {
			while (queue.length) {
				const parent = queue.pop()!;
				if (visited.has(parent.row.pid)) { continue; }
				visited.add(parent.row.pid);
				const known = this.tracked.get(parent.row.pid);
				if (known) { known.detached = parent.detached; }
				for (const row of children.get(parent.row.pid) ?? []) {
					if (this.roots.has(row.pid)) { continue; }
					let item = this.tracked.get(row.pid);
					if (!item) {
						if (this.tracked.size >= 2048) { truncated = true; continue; }
						item = { row, owner: parent.owner, seenAt: this.now(), detached: parent.detached, attribution: 'ancestry' };
						this.tracked.set(row.pid, item);
					}
					queue.push({ row, owner: item.owner, detached: parent.detached });
				}
			}
		};
		for (const root of this.roots.values()) {
			const row = live.get(root.pid);
			if (!row || !root.owner || root.birth && root.birth !== row.birth || !root.birth && Date.parse(row.birth) < root.createdAt - 2000) { continue; }
			root.birth = row.birth; walk([{ row, owner: root.owner, detached: false }]);
		}
		// Marked command roots under a shared CLI are attached; reparented survivors stay detached.
		for (const item of this.tracked.values()) {
			const root = this.roots.get(item.row.ppid);
			const parent = root && live.get(root.pid);
			if (parent && (!root.birth || root.birth === parent.birth)) { walk([{ row: item.row, owner: item.owner, detached: false }]); }
		}
		walk([...this.tracked.values()].map(item => ({ row: item.row, owner: item.owner, detached: item.detached })));
		const processes: AgentProcessEntry[] = [...this.tracked.values()].filter(item => this.now() - item.seenAt >= 5000)
			.sort((a, b) => a.seenAt - b.seenAt || a.row.pid - b.row.pid)
			.map(item => ({ id: identity(item.row), pid: item.row.pid, chatId: item.owner.chatId, command: item.row.command,
				source: item.owner.source, startedAt: item.seenAt, detached: item.detached, attribution: item.attribution }));
		this.publish({ supported: true, processes, ...(truncated ? { truncated: true } : {}), ...(unavailable ? { unavailable: true } : {}) });
	}

	private publish(snapshot: AgentProcessSnapshot): void {
		const shape = JSON.stringify(snapshot);
		// Nothing new: wait longer next time. Something new: back to the base pace.
		this.backoff = shape === this.lastShape ? Math.min(this.backoff * 2, this.pace.maxMs) : this.pace.baseMs;
		if (shape === this.lastShape) { return; }
		this.snapshot = snapshot; this.lastShape = shape;
		for (const listener of this.listeners) { listener(); }
	}

	/** Revalidate OS birth identity and chat ownership, never trust a client-supplied PID. */
	public async stop(chatId: string, id: string): Promise<void> {
		const item = [...this.tracked.values()].find(item => identity(item.row) === id && item.owner.chatId === chatId);
		if (!item || this.disposed) { throw new Error('This process is no longer monitored in this chat.'); }
		const row = (await this.read()).find(row => row.pid === item.row.pid && row.birth === item.row.birth && !row.zombie);
		if (!row || this.roots.has(row.pid) || row.pid <= 1 || row.pid === process.pid) { throw new Error('This process has exited or its identity changed.'); }
		this.signal(row.pid); this.backoff = this.pace.baseMs; this.schedule(250);
	}

	/**
	 * The same revalidation as `stop`, for a read-only look: the process must still
	 * be this chat's and have the birth it was seen with. Answers its live row and
	 * its descendants (at most 50), from a fresh table, never from the client.
	 */
	public async inspect(chatId: string, id: string): Promise<{ row: ProcessRow; source: string; detached: boolean; children: ProcessRow[] }> {
		const item = [...this.tracked.values()].find(item => identity(item.row) === id && item.owner.chatId === chatId);
		if (!item || this.disposed) { throw new Error('This process is no longer monitored in this chat.'); }
		const rows = await this.read();
		const row = rows.find(row => row.pid === item.row.pid && row.birth === item.row.birth && !row.zombie);
		if (!row) { throw new Error('This process has exited or its identity changed.'); }
		const children: ProcessRow[] = [];
		const queue = [row.pid];
		while (queue.length && children.length < 50) {
			const parent = queue.shift()!;
			for (const child of rows) {
				if (child.ppid === parent && child.pid !== parent && !child.zombie && children.length < 50) { children.push(child); queue.push(child.pid); }
			}
		}
		return { row, source: item.owner.source, detached: item.detached, children };
	}

	/** Whether this chat still has the process with this identity, without reading the table. */
	public alive(chatId: string, id: string): boolean {
		return [...this.tracked.values()].some(item => identity(item.row) === id && item.owner.chatId === chatId);
	}

	public dispose(): void {
		this.disposed = true;
		if (this.timer) { clearTimeout(this.timer); }
		this.roots.clear(); this.tracked.clear(); this.checked.clear(); this.owners.clear(); this.listeners.clear();
	}
}
/**
 * Whether a CLI line may mean a process started or ended, so the process monitor
 * looks soon: a tool call or its result, a task's start or end, a turn's end.
 * Text, thinking and stream deltas are not — sampling on them read the whole
 * process table about once a second for as long as a reply streamed.
 */
export function startsOrEndsWork(message: any): boolean {
	if (!message || typeof message !== 'object') { return false; }
	if (message.type === 'result') { return true; }
	if (message.type === 'system') { return message.subtype === 'task_started' || message.subtype === 'task_notification'; }
	if (message.type === 'assistant' || message.type === 'user') {
		const content = message.message?.content;
		return Array.isArray(content) && content.some((block: any) => block?.type === 'tool_use' || block?.type === 'tool_result');
	}
	if (message.method === 'item/started' || message.method === 'item/completed') {
		const type = message.params?.item?.type;
		return type === 'commandExecution' || type === 'collabAgentToolCall' || type === 'mcpToolCall' || type === 'dynamicToolCall';
	}
	if (message.method === 'turn/completed') { return true; }
	if (message.method === 'session/update') {
		const update = message.params?.update?.sessionUpdate;
		return update === 'tool_call' || update === 'tool_call_update' && (message.params.update.status === 'completed' || message.params.update.status === 'failed');
	}
	// Pi's RPC events.
	return message.type === 'tool_execution_start' || message.type === 'tool_execution_end' || message.type === 'agent_settled';
}

export const agentProcesses = new AgentProcessMonitor();
