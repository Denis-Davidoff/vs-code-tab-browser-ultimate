/*
 * The Chrome side panel's terminal transport: the website's `terminal.*` frames
 * (`src/chat/remoteTerminalProtocol.ts`) over the editor's loopback bridge
 * instead of a WebSocket. Viewer frames go out batched in `POST /terminal`, one
 * request at a time so their `n` arrive in order; agent frames come back from a
 * long-polled `GET /terminal?after=<cursor>`.
 *
 * Leaf: no DOM, no relative value imports; the requests are handed in.
 */

export interface ChromeTerminalLinkDeps {
	/** `POST /terminal` with these frames; false when the bridge refused or could not be reached. */
	post(frames: readonly Record<string, unknown>[]): Promise<boolean>;
	/** `GET /terminal?after=` — held by the bridge while there is nothing new. */
	get(after: number, signal: AbortSignal): Promise<{ readonly cursor: number; readonly frames: readonly unknown[] }>;
	/** One agent frame, to the shim. */
	deliver(frame: unknown): void;
	/** Pause after a failed poll. */
	retryMs?: number;
	maxBatch?: number;
	wait?: (ms: number) => Promise<void>;
}

export interface ChromeTerminalLink {
	/** Queues one viewer frame; false once stopped. */
	send(frame: Record<string, unknown>): boolean;
	/** Starts the poll loop (idempotent). */
	start(): void;
	/** Ends the loop and drops what is queued: frames of a closed connection mean nothing to the next. */
	stop(): void;
	readonly polling: boolean;
}

export function createChromeTerminalLink(deps: ChromeTerminalLinkDeps): ChromeTerminalLink {
	const maxBatch = deps.maxBatch ?? 64;
	const wait = deps.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
	let queue: Record<string, unknown>[] = [];
	let flushing = false;
	let stopped = false;
	let polling = false;
	let cursor = 0;
	let controller: AbortController | undefined;

	async function flush(): Promise<void> {
		if (flushing) { return; }
		flushing = true;
		try {
			while (queue.length && !stopped) {
				const batch = queue.splice(0, maxBatch);
				let ok = false;
				try { ok = await deps.post(batch); } catch { ok = false; }
				// A refused batch: what follows it would arrive out of context; the shim attaches again on reconnect.
				if (!ok) { queue = []; }
			}
		} finally { flushing = false; }
	}

	async function loop(): Promise<void> {
		while (!stopped) {
			controller = new AbortController();
			try {
				const answer = await deps.get(cursor, controller.signal);
				if (stopped) { return; }
				cursor = answer.cursor;
				for (const frame of answer.frames) { deps.deliver(frame); }
			} catch {
				if (stopped) { return; }
				await wait(deps.retryMs ?? 1000);
			}
		}
	}

	return {
		send(frame) {
			if (stopped) { return false; }
			queue.push(frame);
			queueMicrotask(() => void flush());
			return true;
		},
		start() {
			if (polling || stopped) { return; }
			polling = true;
			void loop().finally(() => { polling = false; });
		},
		stop() { stopped = true; queue = []; controller?.abort(); },
		get polling() { return polling; },
	};
}
