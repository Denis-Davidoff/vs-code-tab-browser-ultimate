/*
 * The terminal's output path, between the host's `terminalData` and xterm.
 *
 * The host posts a shell's output in batches, each numbered (`seq`), and stops
 * reading the shell while too much of it is unacknowledged; the view
 * acknowledges what xterm has parsed. Three small pieces, all pure so the rules
 * are under `npm test`: batching the acknowledgements, ordering live output
 * against the replay (the screen's tail the host sends when the view attaches),
 * and holding output that arrives before the view knows the terminal.
 *
 * Nothing here has a parameter property or an enum: `npm test` runs this file
 * through Node's type stripping.
 */

/** The unit the host counts: UTF-16 code units of the string it posted. */
export function ackSize(data: string): number {
	return data.length;
}

export interface AckTimers {
	set(run: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

const realTimers: AckTimers = { set: (run, ms) => setTimeout(run, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };

/**
 * Acknowledgements are sent in batches: every `threshold` units, or once the
 * output has gone quiet for `idleMs`. One message per chunk would double the
 * traffic of a busy shell; the host's limits (about 1 MB high, 256 KB low) are
 * far above the threshold, so batching never starves it.
 */
export class AckBatcher {
	private _pending = 0;
	private _timer: unknown;
	private readonly _send: (bytes: number) => void;
	private readonly _threshold: number;
	private readonly _idleMs: number;
	private readonly _timers: AckTimers;

	constructor(send: (bytes: number) => void, threshold = 32 * 1024, idleMs = 40, timers: AckTimers = realTimers) {
		this._send = send;
		this._threshold = threshold;
		this._idleMs = idleMs;
		this._timers = timers;
	}

	add(bytes: number): void {
		if (bytes <= 0) { return; }
		this._pending += bytes;
		if (this._pending >= this._threshold) {
			this.flush();
		} else if (this._timer === undefined) {
			this._timer = this._timers.set(() => { this._timer = undefined; this.flush(); }, this._idleMs);
		}
	}

	flush(): void {
		if (this._timer !== undefined) {
			this._timers.clear(this._timer);
			this._timer = undefined;
		}
		if (this._pending > 0) {
			const bytes = this._pending;
			this._pending = 0;
			this._send(bytes);
		}
	}

	/** Nothing more will be said: a closed terminal's host has stopped counting. */
	dispose(): void {
		this.reset();
	}

	/** What was waiting to be said is forgotten, not sent: the host no longer counts it (see `AckLedger`). */
	reset(): void {
		if (this._timer !== undefined) { this._timers.clear(this._timer); }
		this._timer = undefined;
		this._pending = 0;
	}
}

/**
 * Which acknowledgements the host can still use. The host counts the units it
 * posted as `terminalData` and gives them all back (zero) whenever the screen
 * starts over: on `terminalAttach` (`TerminalTab.attach` releases what was in
 * flight to a view that is gone) and on a restart. The replay it sends then is
 * never counted. So the view may only acknowledge output that arrived AFTER the
 * replay of its latest attach, and nothing else: acknowledging the replay, a
 * chunk held or dropped against it, or a pre-attach chunk xterm finishes parsing
 * late would subtract credit the host holds for live data still in the view, and
 * let the shell run ahead of xterm by that much (memory bound, not a deadlock).
 *
 * Each chunk is handed to xterm with a `token()`, and `credit` honours it only
 * while that token is current: `awaitReplay()` (an attach sent, a shell
 * restarted) and `replayed()` each end every token before them and forget what
 * the batcher still held. A ledger starts waiting for its first replay.
 */
export class AckLedger {
	private _epoch = 0;
	private _awaiting = true;
	private readonly _batcher: AckBatcher;

	constructor(batcher: AckBatcher) {
		this._batcher = batcher;
	}

	/** -1 while no replay is current: nothing written under it will be credited. */
	token(): number {
		return this._awaiting ? -1 : this._epoch;
	}

	/** The host is about to rebuild the screen (we asked, or it restarted): everything so far is released host-side. */
	awaitReplay(): void {
		this._epoch++;
		this._awaiting = true;
		this._batcher.reset();
	}

	/** The replay arrived: output from here on is counted by the host. */
	replayed(): void {
		this._epoch++;
		this._awaiting = false;
		this._batcher.reset();
	}

	/** Acknowledges `bytes` if `token` is still current. */
	credit(token: number, bytes: number): void {
		if (token < 0 || this._awaiting || token !== this._epoch) { return; }
		this._batcher.add(bytes);
	}
}

export interface SequenceResult {
	/** What to write to xterm, in order. */
	readonly write: readonly string[];
	/**
	 * Units that will never be written. From `push` on a live sequence they were
	 * counted by the host and are acknowledged at once (a batch posted twice);
	 * from `reset` and `replay` they predate the screen's new start, which the
	 * host has already released, and are NOT acknowledged (see `AckLedger`).
	 */
	readonly dropped: number;
}

const nothing: SequenceResult = { write: [], dropped: 0 };

/**
 * Live output against the replay. After `reset` (the terminal exists, the host
 * has not answered `terminalAttach` yet) live chunks are held. The replay holds
 * everything up to its `seq`, so held chunks at or below it are duplicates and
 * dropped, and the rest follow it. Afterwards every chunk must be newer than the
 * last, which also drops a batch the host sent twice.
 *
 * An empty replay holds nothing to be a duplicate of, so no chunk is dropped
 * against it whatever its `seq` says.
 */
export class OutputSequencer {
	private _live = false;
	private _last = -Infinity;
	private _held: { readonly seq: number; readonly data: string }[] = [];

	get live(): boolean { return this._live; }

	/** Back to waiting for a replay. What was held is dropped: the replay covers it. */
	reset(): SequenceResult {
		const dropped = this._held.reduce((sum, chunk) => sum + ackSize(chunk.data), 0);
		this._held = [];
		this._live = false;
		this._last = -Infinity;
		return { write: [], dropped };
	}

	replay(seq: number, data: string): SequenceResult {
		const held = this._held;
		this._held = [];
		this._live = true;
		this._last = data ? seq : -Infinity;
		const write: string[] = data ? [data] : [];
		let dropped = 0;
		for (const chunk of held) {
			if (chunk.seq > this._last) {
				this._last = chunk.seq;
				write.push(chunk.data);
			} else {
				dropped += ackSize(chunk.data);
			}
		}
		return { write, dropped };
	}

	push(seq: number, data: string): SequenceResult {
		if (!data) { return nothing; }
		if (!this._live) {
			this._held.push({ seq, data });
			return nothing;
		}
		if (seq <= this._last) { return { write: [], dropped: ackSize(data) }; }
		this._last = seq;
		return { write: [data], dropped: 0 };
	}
}

/**
 * Output for a terminal the view has not been told about yet. The host posts
 * output as it arrives and the list of terminals on the next state, which is
 * coalesced, so a new shell's first prompt usually comes first. Bounded: past
 * `limit` units the oldest is dropped, which loses nothing — the replay the host
 * sends on attach holds the same bytes. Dropped units are NOT acknowledged: this
 * output predates the attach, which releases what the host counted for it.
 */
export class EarlyOutput {
	private readonly _chunks = new Map<string, { readonly seq: number; readonly data: string }[]>();
	private _size = 0;
	private readonly _limit: number;

	constructor(limit = 256 * 1024) {
		this._limit = limit;
	}

	/** The units dropped to stay within the limit (reported for information; not acknowledged). */
	push(id: string, seq: number, data: string): number {
		const list = this._chunks.get(id) ?? [];
		list.push({ seq, data });
		this._chunks.set(id, list);
		this._size += ackSize(data);
		let dropped = 0;
		while (this._size > this._limit) {
			const oldest = this._oldest();
			if (!oldest) { break; }
			const chunk = oldest.shift()!;
			this._size -= ackSize(chunk.data);
			dropped += ackSize(chunk.data);
		}
		return dropped;
	}

	take(id: string): readonly { readonly seq: number; readonly data: string }[] {
		const list = this._chunks.get(id) ?? [];
		this._chunks.delete(id);
		this._size -= list.reduce((sum, chunk) => sum + ackSize(chunk.data), 0);
		return list;
	}

	/**
	 * Forgets the output of terminals that are not in `known`: a terminal closed
	 * before the view heard of it. Nothing is acknowledged — its host is gone too.
	 */
	keepOnly(known: ReadonlySet<string>): void {
		for (const id of [...this._chunks.keys()]) {
			if (!known.has(id)) { this.take(id); }
		}
	}

	private _oldest(): { seq: number; data: string }[] | undefined {
		for (const list of this._chunks.values()) {
			if (list.length) { return list as { seq: number; data: string }[]; }
		}
		return undefined;
	}
}
