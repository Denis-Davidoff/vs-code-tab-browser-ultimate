/**
 * Terminal tabs on the Exchange website: the wire frames between a website viewer
 * and the editor, carried only inside the end-to-end encrypted envelope (the relay
 * sees opaque `secure` frames and never these). They bypass `chat.command`, whose
 * per-command acknowledgement and pending cap cannot carry keystrokes.
 *
 * Leaf module: no `vscode`, no relative value imports. The extension (`remoteTerminal.ts`)
 * and the website shim both read it; `readViewerTerminalFrame` is the host's one strict
 * allowlist for what a viewer sends, and `readAgentTerminalFrame` the shim's for what
 * the editor sends.
 *
 * A viewer is a WATCHER by default ("look what I am doing"): it receives the screen and
 * may type only while it holds the control lease (`terminal.lease` claim). The editor's
 * own input always wins and ends a lease; a lease ends after `remoteLeaseIdleMs` without
 * input from its holder.
 */

/** Most UTF-16 units of one `terminal.input` frame. The shim coalesces keystrokes into frames up to this. */
export const remoteInputFrameMax = 4096;
/** Sustained input a viewer may send, UTF-16 units per second, and the burst on top of it. */
export const remoteInputRate = 64 * 1024;
export const remoteInputBurst = 128 * 1024;
/** Output units in flight to one viewer before the PTY is held for it; the stall clock starts here. */
export const remoteWindowHigh = 512 * 1024;
/** A viewer that stays at `remoteWindowHigh` this long is dropped (`terminal.error` `slow`) and may attach again. */
export const remoteStallMs = 5000;
/** A control lease ends after this long without input from its holder. */
export const remoteLeaseIdleMs = 30_000;
/** Most units of one `terminal.data` frame the editor sends. */
export const remoteDataFrameMax = 32 * 1024;
/** Consumers: all viewers together, per terminal, per viewer. */
export const maxRemoteConsumers = 8;
export const maxRemoteConsumersPerTerminal = 4;
export const maxRemoteConsumersPerViewer = 2;

const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
const viewerPattern = /^[A-Za-z0-9_-]{8,64}$/;
const epochPattern = /^[A-Za-z0-9]{1,64}$/;

/** What every viewer frame carries: the agent connection's epoch, the viewer's own id, and its counter (strictly increasing per viewer). */
export interface ViewerFrameBase {
	readonly e: string;
	readonly v: string;
	readonly n: number;
	/** The terminal. */
	readonly t: string;
}

export type ViewerTerminalFrame =
	| ViewerFrameBase & { readonly type: 'terminal.attach'; readonly cols: number; readonly rows: number }
	| ViewerFrameBase & { readonly type: 'terminal.detach' }
	| ViewerFrameBase & { readonly type: 'terminal.input'; readonly data: string }
	| ViewerFrameBase & { readonly type: 'terminal.resize'; readonly cols: number; readonly rows: number }
	| ViewerFrameBase & { readonly type: 'terminal.ack'; readonly bytes: number }
	| ViewerFrameBase & { readonly type: 'terminal.lease'; readonly op: 'claim' | 'renew' | 'release' };

/** Who may type: the editor (nobody remote), or a viewer by id. */
export type LeaseHolder = { readonly kind: 'editor' } | { readonly kind: 'viewer'; readonly v: string };

export type RemoteTerminalErrorReason = 'slow' | 'refused' | 'watch-only' | 'gone' | 'limit' | 'rate' | 'off';

/** Frames to viewers. `v` addresses one viewer; the shim of any other viewer ignores it (agent → viewers is a broadcast). */
export type AgentTerminalFrame =
	| { readonly type: 'terminal.replay'; readonly v: string; readonly t: string; readonly seq: number; readonly data: string; readonly cols: number; readonly rows: number }
	| { readonly type: 'terminal.data'; readonly v: string; readonly t: string; readonly seq: number; readonly data: string }
	| { readonly type: 'terminal.exit'; readonly v: string; readonly t: string; readonly code?: number }
	| { readonly type: 'terminal.lease'; readonly v: string; readonly t: string; readonly holder: 'editor' | 'you' | 'other'; readonly expiresInMs?: number }
	| { readonly type: 'terminal.error'; readonly v: string; readonly t: string; readonly reason: RemoteTerminalErrorReason; readonly message: string };

export const viewerTerminalFrameTypes = ['terminal.attach', 'terminal.detach', 'terminal.input', 'terminal.resize', 'terminal.ack', 'terminal.lease'] as const;

/** Whether a decoded message is meant for the terminal stream (and so must never be parsed as a chat command). */
export function isTerminalFrame(value: unknown): boolean {
	return !!value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string'
		&& (value as { type: string }).type.startsWith('terminal.');
}

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).every(key => keys.includes(key));
}

function size(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1000;
}

/**
 * A viewer frame, or `undefined` for anything else: unknown keys, an out-of-range
 * value or an oversized input are refused whole, never trimmed.
 */
export function readViewerTerminalFrame(value: unknown): ViewerTerminalFrame | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { return undefined; }
	const o = value as Record<string, unknown>;
	if (typeof o.e !== 'string' || !epochPattern.test(o.e) || typeof o.v !== 'string' || !viewerPattern.test(o.v)
		|| typeof o.n !== 'number' || !Number.isSafeInteger(o.n) || o.n < 0 || typeof o.t !== 'string' || !idPattern.test(o.t)) {
		return undefined;
	}
	const base = { e: o.e, v: o.v, n: o.n, t: o.t };
	const common = ['type', 'e', 'v', 'n', 't'];
	switch (o.type) {
		case 'terminal.attach':
		case 'terminal.resize':
			if (!hasOnly(o, [...common, 'cols', 'rows']) || !size(o.cols) || !size(o.rows)) { return undefined; }
			return { ...base, type: o.type, cols: o.cols, rows: o.rows };
		case 'terminal.detach':
			return hasOnly(o, common) ? { ...base, type: o.type } : undefined;
		case 'terminal.input':
			if (!hasOnly(o, [...common, 'data']) || typeof o.data !== 'string' || !o.data || o.data.length > remoteInputFrameMax) { return undefined; }
			return { ...base, type: o.type, data: o.data };
		case 'terminal.ack':
			if (!hasOnly(o, [...common, 'bytes']) || typeof o.bytes !== 'number' || !Number.isSafeInteger(o.bytes) || o.bytes <= 0) { return undefined; }
			return { ...base, type: o.type, bytes: o.bytes };
		case 'terminal.lease':
			if (!hasOnly(o, [...common, 'op']) || (o.op !== 'claim' && o.op !== 'renew' && o.op !== 'release')) { return undefined; }
			return { ...base, type: o.type, op: o.op };
		default:
			return undefined;
	}
}

/** The shim's reader for frames from the editor; `undefined` for anything not shaped as one. */
export function readAgentTerminalFrame(value: unknown): AgentTerminalFrame | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { return undefined; }
	const o = value as Record<string, unknown>;
	if (typeof o.v !== 'string' || !viewerPattern.test(o.v) || typeof o.t !== 'string' || !idPattern.test(o.t)) { return undefined; }
	const seq = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
	switch (o.type) {
		case 'terminal.replay':
			return seq(o.seq) && typeof o.data === 'string' && size(o.cols) && size(o.rows)
				? { type: o.type, v: o.v, t: o.t, seq: o.seq, data: o.data, cols: o.cols, rows: o.rows } : undefined;
		case 'terminal.data':
			return seq(o.seq) && typeof o.data === 'string' && o.data.length <= remoteDataFrameMax
				? { type: o.type, v: o.v, t: o.t, seq: o.seq, data: o.data } : undefined;
		case 'terminal.exit':
			if (o.code !== undefined && (typeof o.code !== 'number' || !Number.isInteger(o.code))) { return undefined; }
			return { type: o.type, v: o.v, t: o.t, ...(o.code !== undefined ? { code: o.code as number } : {}) };
		case 'terminal.lease':
			if (o.holder !== 'editor' && o.holder !== 'you' && o.holder !== 'other') { return undefined; }
			if (o.expiresInMs !== undefined && !seq(o.expiresInMs)) { return undefined; }
			return { type: o.type, v: o.v, t: o.t, holder: o.holder, ...(o.expiresInMs !== undefined ? { expiresInMs: o.expiresInMs as number } : {}) };
		case 'terminal.error': {
			const reasons: readonly string[] = ['slow', 'refused', 'watch-only', 'gone', 'limit', 'rate', 'off'];
			return typeof o.reason === 'string' && reasons.includes(o.reason) && typeof o.message === 'string' && o.message.length <= 500
				? { type: o.type, v: o.v, t: o.t, reason: o.reason as RemoteTerminalErrorReason, message: o.message } : undefined;
		}
		default:
			return undefined;
	}
}

/**
 * Splits output into frames of at most `remoteDataFrameMax` units, never between the
 * two halves of a surrogate pair (a lone half is refused by strict JSON readers).
 */
export function splitTerminalData(data: string, max = remoteDataFrameMax): string[] {
	const parts: string[] = [];
	let at = 0;
	while (at < data.length) {
		let end = Math.min(data.length, at + max);
		if (end < data.length && end > at + 1) {
			const code = data.charCodeAt(end - 1);
			if (code >= 0xd800 && code <= 0xdbff) { end--; }
		}
		parts.push(data.slice(at, end));
		at = end;
	}
	return parts;
}

/**
 * xterm's automatic replies to a terminal query (cursor position, device attributes,
 * mode reports, window and colour reports). Two screens answering one query would each
 * send one: only the lease holder's are written, and none of them count as the user
 * typing.
 */
export function isTerminalReply(data: string): boolean {
	return /^(?:\x1b\[\d+;\d+R|\x1b\[[?>=]?[\d;]*c|\x1b\[\d*n|\x1b\[\??[\d;]*\$y|\x1b\[[\d;]*t|\x1b\][\d;]+;[^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\)+$/.test(data);
}

// ---------------------------------------------------------------------------------------------
// The host's hub. Kept in this leaf (rather than a module of its own) so `npm test` drives it
// with no relative value import; the website bundle never references it, and esbuild drops it.
// ---------------------------------------------------------------------------------------------

/** The slice of a remote consumer's sink (`TerminalConsumerSink` in `terminalTab.ts`). */
export interface RemoteConsumerSink {
	data(chunk: string, seq: number): void;
	exit(code: number | undefined): void;
	replay(data: string, seq: number): void;
}

/** The slice of `TerminalTab` the hub drives. */
export interface RemoteTerminalTarget {
	readonly id: string;
	readonly remote: boolean;
	readonly running: boolean;
	readonly status: 'running' | 'exited';
	readonly exitCode: number | undefined;
	readonly size: { cols: number; rows: number };
	addConsumer(key: string, sink: RemoteConsumerSink): { data: string; seq: number };
	removeConsumer(key: string): void;
	creditConsumer(key: string, bytes: number): void;
	outstanding(key: string): number;
	remoteInput(data: string): void;
	remoteResize(cols: number, rows: number): void;
	onEditorInput(listener: (data: string) => void): () => void;
	/** The control lease went to a viewer (`true`) or back to the editor: the editor view stops resizing the PTY meanwhile. */
	setRemoteControl?(held: boolean): void;
}

export interface RemoteTerminalAudit {
	readonly kind: 'attach' | 'detach' | 'lease-claim' | 'lease-release' | 'lease-expired' | 'lease-editor' | 'dropped-slow' | 'refused';
	readonly v: string;
	readonly t: string;
	readonly detail?: string;
}

export interface RemoteTerminalHubOptions {
	/** Re-asked on every frame: the setting is on, the connection is encrypted and consented, the window is not blocked. */
	allowed(): boolean;
	/** The agent connection's current epoch; a frame from another is ignored. */
	epoch(): string;
	find(id: string): RemoteTerminalTarget | undefined;
	send(frame: AgentTerminalFrame): void;
	audit?(event: RemoteTerminalAudit): void;
	now?(): number;
	setTimer?(fn: () => void, ms: number): unknown;
	clearTimer?(handle: unknown): void;
}

interface Consumer {
	readonly v: string;
	readonly t: string;
	readonly target: RemoteTerminalTarget;
	stallSince?: number;
	stallTimer?: unknown;
}

const consumerKey = (v: string, t: string) => `remote:${v}:${t}`;

export class RemoteTerminalHub {
	private readonly _consumers = new Map<string, Consumer>();
	private readonly _lastN = new Map<string, number>();
	private readonly _leases = new Map<string, { v: string; last: number; timer?: unknown; target: RemoteTerminalTarget }>();
	private readonly _buckets = new Map<string, { tokens: number; at: number }>();
	private readonly _editorWatch = new Map<string, () => void>();
	private readonly _o: RemoteTerminalHubOptions;
	private readonly _now: () => number;
	private readonly _set: (fn: () => void, ms: number) => unknown;
	private readonly _clear: (handle: unknown) => void;

	constructor(options: RemoteTerminalHubOptions) {
		this._o = options;
		this._now = options.now ?? Date.now;
		this._set = options.setTimer ?? ((fn, ms) => { const h = setTimeout(fn, ms); (h as { unref?: () => void }).unref?.(); return h; });
		this._clear = options.clearTimer ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>));
	}

	public get consumerCount(): number { return this._consumers.size; }
	public leaseHolder(t: string): string | undefined { return this._leases.get(t)?.v; }

	/** A decoded frame from a viewer. Anything malformed, stale or not allowed produces nothing that reaches a shell. */
	public receive(raw: unknown): void {
		const frame = readViewerTerminalFrame(raw);
		if (!frame) { return; }
		if (!this._o.allowed()) {
			// Never answer with terminal frames when terminals are off: drop what exists, say nothing more.
			this.dropAll();
			return;
		}
		if (frame.e !== this._o.epoch()) { return; }
		const last = this._lastN.get(frame.v);
		if (last !== undefined && frame.n <= last) { return; }
		this._lastN.set(frame.v, frame.n);
		if (this._lastN.size > 64) { this._lastN.delete(this._lastN.keys().next().value!); }
		const target = this._o.find(frame.t);
		const key = consumerKey(frame.v, frame.t);
		if (!target || !target.remote) {
			this._drop(key);
			this._error(frame.v, frame.t, 'gone', 'This terminal is not shared with the website.');
			return;
		}
		switch (frame.type) {
			case 'terminal.attach': return this._attach(frame.v, target, frame.cols, frame.rows);
			case 'terminal.detach': this._drop(key); this._audit('detach', frame.v, frame.t); return;
			case 'terminal.ack': {
				if (!this._consumers.has(key)) { return; }
				target.creditConsumer(key, frame.bytes);
				this._checkStall(key);
				return;
			}
			case 'terminal.lease': return this._lease(frame.v, target, frame.op);
			case 'terminal.input': {
				if (!this._holds(frame.v, frame.t)) {
					// Two screens answer one query: only the holder's answer is written; a watcher's is dropped quietly.
					if (!isTerminalReply(frame.data)) { this._error(frame.v, frame.t, 'watch-only', 'You are watching. Take control to type.'); }
					return;
				}
				if (!target.running || !this._spend(frame.v, frame.data.length)) {
					if (target.running) { this._error(frame.v, frame.t, 'rate', 'Too much input at once.'); }
					return;
				}
				target.remoteInput(frame.data);
				if (!isTerminalReply(frame.data)) { this._touchLease(frame.t); }
				return;
			}
			case 'terminal.resize':
				if (this._holds(frame.v, frame.t)) { target.remoteResize(frame.cols, frame.rows); }
				return;
		}
	}

	/** The state changed: consumers of a terminal no longer shared (or gone) are dropped. */
	public sync(): void {
		if (!this._o.allowed()) { this.dropAll(); return; }
		for (const [key, consumer] of [...this._consumers]) {
			const target = this._o.find(consumer.t);
			if (!target || !target.remote || target !== consumer.target) {
				this._drop(key);
				this._error(consumer.v, consumer.t, 'gone', 'This terminal is no longer shared with the website.');
			}
		}
	}

	/** Every viewer left, the connection closed, or terminals were switched off. */
	public dropAll(): void {
		for (const key of [...this._consumers.keys()]) { this._drop(key); }
		for (const lease of this._leases.values()) { if (lease.timer !== undefined) { this._clear(lease.timer); } lease.target.setRemoteControl?.(false); }
		this._leases.clear();
		this._lastN.clear();
		this._buckets.clear();
	}

	public dispose(): void { this.dropAll(); }

	private _attach(v: string, target: RemoteTerminalTarget, cols: number, rows: number): void {
		const key = consumerKey(v, target.id);
		this._drop(key);
		const perTerminal = [...this._consumers.values()].filter(c => c.t === target.id).length;
		const perViewer = [...this._consumers.values()].filter(c => c.v === v).length;
		if (this._consumers.size >= maxRemoteConsumers || perTerminal >= maxRemoteConsumersPerTerminal || perViewer >= maxRemoteConsumersPerViewer) {
			this._audit('refused', v, target.id, 'limit');
			this._error(v, target.id, 'limit', 'Too many terminals are open on the website.');
			return;
		}
		const t = target.id;
		const consumer: Consumer = { v, t, target };
		this._consumers.set(key, consumer);
		const replay = target.addConsumer(key, {
			data: (chunk, seq) => {
				if (this._consumers.get(key) !== consumer) { return; }
				for (const part of splitTerminalData(chunk)) { this._o.send({ type: 'terminal.data', v, t, seq, data: part }); }
				this._checkStall(key);
			},
			exit: code => { if (this._consumers.get(key) === consumer) { this._o.send({ type: 'terminal.exit', v, t, ...(code !== undefined ? { code } : {}) }); } },
			replay: (data, seq) => { if (this._consumers.get(key) === consumer) { this._o.send({ type: 'terminal.replay', v, t, seq, data, ...target.size }); } },
		});
		if (!this._editorWatch.has(t)) {
			this._editorWatch.set(t, target.onEditorInput(data => {
				if (!isTerminalReply(data) && this._leases.has(t)) { this._endLease(t, 'lease-editor'); }
			}));
		}
		// The website's own size does not move the editor's PTY unless it holds the lease.
		void cols; void rows;
		this._o.send({ type: 'terminal.replay', v, t, seq: replay.seq, data: replay.data, ...target.size });
		if (target.status === 'exited') { this._o.send({ type: 'terminal.exit', v, t, ...(target.exitCode !== undefined ? { code: target.exitCode } : {}) }); }
		this._sendLease(v, t);
		this._audit('attach', v, t);
	}

	private _drop(key: string): void {
		const consumer = this._consumers.get(key);
		if (!consumer) { return; }
		this._consumers.delete(key);
		if (consumer.stallTimer !== undefined) { this._clear(consumer.stallTimer); }
		consumer.target.removeConsumer(key);
		if (this._leases.get(consumer.t)?.v === consumer.v) { this._endLease(consumer.t, 'lease-release'); }
		if (![...this._consumers.values()].some(c => c.t === consumer.t)) {
			this._editorWatch.get(consumer.t)?.();
			this._editorWatch.delete(consumer.t);
		}
	}

	private _checkStall(key: string): void {
		const consumer = this._consumers.get(key);
		if (!consumer) { return; }
		if (consumer.target.outstanding(key) < remoteWindowHigh) {
			consumer.stallSince = undefined;
			if (consumer.stallTimer !== undefined) { this._clear(consumer.stallTimer); consumer.stallTimer = undefined; }
			return;
		}
		if (consumer.stallSince === undefined) {
			consumer.stallSince = this._now();
			consumer.stallTimer = this._set(() => {
				consumer.stallTimer = undefined;
				if (this._consumers.get(key) === consumer && consumer.target.outstanding(key) >= remoteWindowHigh) {
					this._drop(key);
					this._audit('dropped-slow', consumer.v, consumer.t);
					this._error(consumer.v, consumer.t, 'slow', 'The connection fell behind; attach again for a fresh screen.');
				}
			}, remoteStallMs);
		}
	}

	private _holds(v: string, t: string): boolean {
		const lease = this._leases.get(t);
		if (!lease || lease.v !== v) { return false; }
		if (this._now() - lease.last >= remoteLeaseIdleMs) { this._endLease(t, 'lease-expired'); return false; }
		return this._consumers.has(consumerKey(v, t));
	}

	private _lease(v: string, target: RemoteTerminalTarget, op: 'claim' | 'renew' | 'release'): void {
		const t = target.id;
		if (!this._consumers.has(consumerKey(v, t))) { return; }
		if (op === 'release') {
			if (this._leases.get(t)?.v === v) { this._endLease(t, 'lease-release'); }
			return;
		}
		if (op === 'renew' && !this._holds(v, t)) { this._sendLease(v, t); return; }
		const previous = this._leases.get(t);
		if (previous?.timer !== undefined) { this._clear(previous.timer); }
		this._leases.set(t, { v, last: this._now(), target });
		this._armLease(t);
		if (!previous) { target.setRemoteControl?.(true); }
		if (op === 'claim') { this._audit('lease-claim', v, t); }
		this._broadcastLease(t);
	}

	private _touchLease(t: string): void {
		const lease = this._leases.get(t);
		if (!lease) { return; }
		lease.last = this._now();
	}

	private _armLease(t: string): void {
		const lease = this._leases.get(t);
		if (!lease) { return; }
		const check = () => {
			const current = this._leases.get(t);
			if (current !== lease) { return; }
			const left = remoteLeaseIdleMs - (this._now() - lease.last);
			if (left <= 0) { this._endLease(t, 'lease-expired'); return; }
			lease.timer = this._set(check, left);
		};
		lease.timer = this._set(check, remoteLeaseIdleMs);
	}

	private _endLease(t: string, kind: 'lease-release' | 'lease-expired' | 'lease-editor'): void {
		const lease = this._leases.get(t);
		if (!lease) { return; }
		if (lease.timer !== undefined) { this._clear(lease.timer); }
		this._leases.delete(t);
		lease.target.setRemoteControl?.(false);
		this._audit(kind, lease.v, t);
		this._broadcastLease(t);
	}

	private _broadcastLease(t: string): void {
		for (const consumer of this._consumers.values()) { if (consumer.t === t) { this._sendLease(consumer.v, t); } }
	}

	private _sendLease(v: string, t: string): void {
		const lease = this._leases.get(t);
		const holder = !lease ? 'editor' : lease.v === v ? 'you' : 'other';
		this._o.send({ type: 'terminal.lease', v, t, holder, ...(lease ? { expiresInMs: Math.max(0, remoteLeaseIdleMs - (this._now() - lease.last)) } : {}) });
	}

	/** Token bucket per viewer. */
	private _spend(v: string, units: number): boolean {
		const now = this._now();
		const bucket = this._buckets.get(v) ?? { tokens: remoteInputBurst, at: now };
		bucket.tokens = Math.min(remoteInputBurst, bucket.tokens + (now - bucket.at) * remoteInputRate / 1000);
		bucket.at = now;
		this._buckets.set(v, bucket);
		if (bucket.tokens < units) { return false; }
		bucket.tokens -= units;
		return true;
	}

	private _error(v: string, t: string, reason: RemoteTerminalErrorReason, message: string): void {
		this._o.send({ type: 'terminal.error', v, t, reason, message });
	}

	private _audit(kind: RemoteTerminalAudit['kind'], v: string, t: string, detail?: string): void {
		try { this._o.audit?.({ kind, v, t, ...(detail ? { detail } : {}) }); } catch { /* auditing never stops the stream */ }
	}
}
