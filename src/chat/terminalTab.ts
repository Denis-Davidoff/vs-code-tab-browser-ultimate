/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The chat view's terminal tabs: a shell (or an agent's own CLI) on the editor's
 * machine, drawn by the view with xterm.js. Terminals are not conversations —
 * they hold no chat, no agent session and no draft, and are never among
 * `ChatViewState.tabs` — so they live here, in a collection of their own that
 * `ChatViewProvider` only hooks into.
 *
 * Free of `vscode` and of relative value imports: the PTY layer reaches it as a
 * starter function and its output leaves it as a post callback, so `npm test`
 * drives it with a fake session.
 *
 * **Output goes to the view directly, never through `ChatViewProvider._postMessage`.**
 * That queues every message until the view is ready and diverts them while a
 * remote command runs: a PTY stream cannot live with either (#488). The host
 * session keeps the screen's tail, which is what a view that (re)loads is
 * given (`terminalReplay`), so nothing is kept here while no view is attached —
 * what is not shown is acknowledged at once, or the PTY would be paused for good
 * on output nobody can read.
 */

import type { AgentId, HostToView, TerminalTabSummary } from './chatProtocol';
import type { ScreenRead } from '../terminal/screenModel';
import type { AgentInputVerdict } from './terminalControl';

/** The slice of the PTY layer's `TerminalSession` a tab uses. */
export interface TerminalSessionLike {
	write(data: string): void;
	resize(cols: number, rows: number): void;
	ack(bytes: number): void;
	replay(): { data: string; seq: number };
	readonly exited: boolean;
	readonly exitCode: number | undefined;
	dispose(): void;
	/**
	 * What an agent reads: the host-side screen model (`TerminalSession.readScreen` / `waitFor`,
	 * `src/terminal`). Optional so a session without a model — a test's fake — still serves the view.
	 */
	readScreen?(options: { since?: string; scrollback?: boolean; maxChars?: number }): Promise<ScreenRead>;
	waitFor?(options: { until: 'idle' | 'text' | 'exit' | 'command'; text?: string; quietMs?: number; timeoutMs: number; since?: string; signal?: AbortSignal }): Promise<ScreenRead & { reason: 'idle' | 'text' | 'exit' | 'command' | 'timeout' | 'aborted' }>;
}

/** What `TerminalTab.agentInput` answers: written, or refused with the reason and a message for the model. */
export type TerminalAgentInput =
	| { readonly ok: true; readonly userTypedMsAgo?: number }
	| Exclude<AgentInputVerdict, { readonly ok: true }>
	| { readonly ok: false; readonly reason: 'exited'; readonly message: string; readonly retryAfterMs?: undefined; readonly userTypedMsAgo?: undefined };

/** The slice of `AgentTypingGate` (`terminalControl.ts`) a tab uses. This file is a leaf and cannot import it by value. */
export interface TerminalGate {
	readonly allowed: boolean;
	setAllowed(allowed: boolean): void;
	userInput(): void;
	userTypedMsAgo(): number | undefined;
	checkAgentInput(): AgentInputVerdict;
	agentTyped(): void;
	agentActive(): boolean;
	agentActiveUntil(): number | undefined;
}

/** The slice of `UnreadTracker` (`terminalControl.ts`) a tab uses. */
export interface TerminalUnread {
	readonly unread: boolean;
	output(inFront: boolean): boolean;
	clear(): boolean;
}

export interface TerminalControls {
	readonly gate: TerminalGate;
	readonly unread: TerminalUnread;
}

/**
 * What a tab uses when its owner gives no controls: **fail closed** — the agent may never type, and
 * nothing is marked unread. The provider always gives real ones (`AgentTypingGate`, `UnreadTracker`);
 * this exists so a tab made without them can never be typed into by an agent.
 */
const closedControls = (): TerminalControls => ({
	gate: {
		allowed: true, setAllowed: () => undefined, userInput: () => undefined, userTypedMsAgo: () => undefined,
		checkAgentInput: () => ({ ok: false, reason: 'paused', message: 'Agent control is not available for this terminal.' }),
		agentTyped: () => undefined, agentActive: () => false, agentActiveUntil: () => undefined,
	},
	unread: { unread: false, output: () => false, clear: () => false },
});

/** Test seams and the provider's wiring: the typing gate and unread mark, a clock, and whether this terminal is the one the view shows. */
export interface TerminalTabOptions {
	readonly now?: () => number;
	readonly isFront?: () => boolean;
	readonly controls?: TerminalControls;
}

export interface TerminalHandlers {
	/** `chunk` is a batch of output, `seq` its place in this terminal's stream. */
	onData(chunk: string, seq: number): void;
	onExit(code: number | undefined): void;
}

/** What starting a shell or a CLI gave back; `cleanup` removes what was written for it (a config file). */
export interface StartedTerminal {
	readonly session: TerminalSessionLike;
	readonly cleanup?: () => void;
}

/** Where a remote consumer's output goes (`remoteTerminal.ts` frames it for the website). */
export interface TerminalConsumerSink {
	data(chunk: string, seq: number): void;
	exit(code: number | undefined): void;
	/** The screen starts over (a restart): `data` is a full reset. */
	replay(data: string, seq: number): void;
}

/** Starts the process; throws an `Error` with a message a user can read. */
export type TerminalStarter = (handlers: TerminalHandlers, size: { cols: number; rows: number }) => Promise<StartedTerminal>;

/**
 * The most one `terminalInput` message carries. The view splits a large paste into slices of at
 * most `terminalInputSlice` (`terminalLogic.ts`) and sends them in order, and the host accepts a
 * paste only up to `terminalPasteLimit`, which is below this, so no accepted paste is dropped
 * here; a message over it is a malformed one.
 */
export const terminalInputLimit = 1_000_000;

/** The size of a PTY before the view has measured its own. */
const initialSize = { cols: 80, rows: 24 };

/** What the view is sent to start a screen over: a full reset. */
const clearScreen = '\x1bc';

export class TerminalTab {
	private _name: string;
	private _status: 'running' | 'exited' = 'running';
	private _exitCode: number | undefined;
	private _session: TerminalSessionLike | undefined;
	private _cleanup: (() => void) | undefined;
	private _attached = false;
	/** UTF-16 units posted to the view and not yet acknowledged by it. */
	private _inflight = 0;
	/** Bumped by every start, so a callback of a process since replaced is ignored. */
	private _generation = 0;
	private _disposed = false;
	/**
	 * The size the view last reported, kept even while no process exists (a restart is being made):
	 * the next process starts at it, and one that was made at another size is told it on arrival.
	 */
	private _size = { ...initialSize };
	/**
	 * Remote consumers (Exchange website viewers, `remoteTerminal.ts`) beside the view. Each has
	 * its own window; the session is acknowledged only what EVERY consumer has written, so the PTY
	 * is held by the slowest one (the hub drops a viewer that stalls).
	 */
	private readonly _consumers = new Map<string, { outstanding: number; sink: TerminalConsumerSink }>();
	/** Units the session counts as sent and not yet acknowledged to it. */
	private _owed = 0;
	private _remote = false;
	/** A website viewer holds the control lease: the editor view's size is kept aside until it ends. */
	private _remoteControl = false;
	private _viewSize: { cols: number; rows: number } | undefined;
	private readonly _editorInput = new Set<(data: string) => void>();
	/** The view's xterm exists and has been given the screen so far. */
	public get attached(): boolean { return this._attached; }

	// Plain fields, not parameter properties: Node strips types for `npm test` and refuses those (#49).
	public readonly id: string;
	public readonly cwd: string;
	public readonly agent: AgentId | undefined;
	private readonly _starter: TerminalStarter;
	/** Posts to the view directly; does nothing while there is none. */
	private readonly _post: (message: HostToView) => void;
	/** The tab's own state changed (it exited, it restarted): the strip is redrawn. */
	private readonly _changed: () => void;
	/** Who may type here: the user's typing keeps the agent out for a moment, and the user can pause the agent altogether. */
	private readonly _gate: TerminalGate;
	private readonly _unread: TerminalUnread;
	private readonly _isFront: () => boolean;
	private readonly _now: () => number;
	private _activeTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(id: string, name: string, cwd: string, agent: AgentId | undefined, starter: TerminalStarter,
		post: (message: HostToView) => void, changed: () => void, options: TerminalTabOptions = {}) {
		this._now = options.now ?? Date.now;
		const controls = options.controls ?? closedControls();
		this._gate = controls.gate;
		this._unread = controls.unread;
		this._isFront = options.isFront ?? (() => false);
		this.id = id;
		this._name = name;
		this.cwd = cwd;
		this.agent = agent;
		this._starter = starter;
		this._post = post;
		this._changed = changed;
	}

	public get name(): string { return this._name; }
	public get status(): 'running' | 'exited' { return this._status; }
	public get exitCode(): number | undefined { return this._exitCode; }
	public get running(): boolean { return this._status === 'running' && !!this._session; }

	/** `pinnedBy` and an `allowed` agent control are the provider's to add: only it knows the owner. */
	public summary(): TerminalTabSummary {
		return {
			id: this.id, name: this._name, cwd: this.cwd, status: this._status,
			...(this._exitCode !== undefined ? { exitCode: this._exitCode } : {}),
			...(this.agent ? { agent: this.agent } : {}),
			...(this._unread.unread ? { unread: true as const } : {}),
			...(this._gate.allowed ? {} : { agentControl: 'paused' as const }),
			...(this._gate.agentActive() ? { agentActive: true as const } : {}),
			...(this._remote ? { remote: true } : {}),
			...(this._consumers.size ? { remoteViewers: this._consumers.size } : {}),
			...(this._remoteControl ? { remoteControl: true as const } : {}),
		};
	}

	/** The terminal was looked at (it came to the front): the unread mark goes. Returns whether it was on. */
	public markRead(): boolean { return this._unread.clear(); }

	public get agentControlAllowed(): boolean { return this._gate.allowed; }

	/** The emergency stop (`false`) and its release. Returns whether it changed. */
	public setAgentControl(allowed: boolean): boolean {
		if (this._gate.allowed === allowed) { return false; }
		this._gate.setAllowed(allowed);
		this._changed();
		return true;
	}

	/** Milliseconds since the user last typed here, when that was recent enough to matter. */
	public userTypedMsAgo(): number | undefined { return this._gate.userTypedMsAgo(); }

	/** The size the view last reported (the PTY's, or what the next process starts at). */
	public get size(): { cols: number; rows: number } { return { ...this._size }; }

	/** Starts the process; a failure is thrown and leaves the tab exited. */
	public async start(): Promise<void> {
		this._stop();
		const generation = ++this._generation;
		this._status = 'running';
		this._exitCode = undefined;
		this._inflight = 0;
		this._owed = 0;
		for (const consumer of this._consumers.values()) { consumer.outstanding = 0; }
		let started: StartedTerminal;
		const requested = { ...this._size };
		try {
			started = await this._starter({
				onData: (chunk, seq) => { if (generation === this._generation) { this._data(chunk, seq); } },
				onExit: code => { if (generation === this._generation) { this._exited(code); } },
			}, requested);
		} catch (error) {
			if (generation === this._generation) { this._status = 'exited'; }
			throw error;
		}
		if (this._disposed || generation !== this._generation) {
			// Closed (or started again) while the process was being made.
			started.session.dispose();
			started.cleanup?.();
			return;
		}
		this._session = started.session;
		this._cleanup = started.cleanup;
		// The view measured itself (attach or resize) while the process was being made: tell it the real size.
		if (this._size.cols !== requested.cols || this._size.rows !== requested.rows) {
			started.session.resize(this._size.cols, this._size.rows);
		}
		// A process that ended before it was handed over.
		if (started.session.exited) { this._exited(started.session.exitCode); }
	}

	/** An exited shell started again in the same folder; the view's screen starts over. */
	public async restart(): Promise<void> {
		if (this._status !== 'exited' || this._disposed) { return; }
		await this.start();
		if (this._attached) {
			this._post({ type: 'terminalReplay', id: this.id, seq: 0, data: clearScreen });
		}
		for (const consumer of this._consumers.values()) { consumer.sink.replay(clearScreen, 0); }
		this._changed();
	}

	/** Shared with the Exchange website ("Allow remote access"). */
	public get remote(): boolean { return this._remote; }
	public setRemote(remote: boolean): boolean {
		if (this._remote === remote) { return false; }
		this._remote = remote;
		this._changed();
		return true;
	}

	/** A remote consumer: given the screen so far, then live output. Replaces one of the same key. */
	public addConsumer(key: string, sink: TerminalConsumerSink): { data: string; seq: number } {
		this.removeConsumer(key);
		const replay = this._session?.replay() ?? { data: '', seq: 0 };
		const added = !this._consumers.has(key);
		this._consumers.set(key, { outstanding: 0, sink });
		if (added && !this._disposed) { this._changed(); }
		return replay;
	}

	public removeConsumer(key: string): void {
		if (this._consumers.delete(key)) { this._settle(); if (!this._disposed) { this._changed(); } }
	}

	/** A remote consumer wrote `bytes` of output; never more than it was sent. */
	public creditConsumer(key: string, bytes: number): void {
		const consumer = this._consumers.get(key);
		if (!consumer || !Number.isFinite(bytes) || bytes <= 0) { return; }
		consumer.outstanding -= Math.min(Math.floor(bytes), consumer.outstanding);
		this._settle();
	}

	public outstanding(key: string): number { return this._consumers.get(key)?.outstanding ?? 0; }
	public get consumerCount(): number { return this._consumers.size; }

	/** Input from a remote viewer holding the control lease. Feeds the typing gate like the user's own. */
	public remoteInput(data: string): void {
		if (!data || data.length > terminalInputLimit || !this.running) { return; }
		this._gate.userInput();
		this._session?.write(data);
	}

	public remoteResize(cols: number, rows: number): void {
		if (!validSize(cols, rows)) { return; }
		this._size = { cols, rows };
		if (this.running) { this._session?.resize(cols, rows); }
	}

	public get remoteControl(): boolean { return this._remoteControl; }
	/**
	 * The hub's lease went to a viewer (`true`) or back to the editor. While a viewer holds it the
	 * editor view's resizes are remembered, not applied; on release the view's last size returns.
	 */
	public setRemoteControl(held: boolean): void {
		if (this._remoteControl === held) { return; }
		this._remoteControl = held;
		if (!held && this._viewSize) { const view = this._viewSize; this._viewSize = undefined; this.resize(view.cols, view.rows); }
		this._changed();
	}

	/** Called on every keystroke of the EDITOR's own view (the editor always wins a lease). */
	public onEditorInput(listener: (data: string) => void): () => void {
		this._editorInput.add(listener);
		return () => { this._editorInput.delete(listener); };
	}

	/** `name` is already one line and in range (`terminalName`); an empty one is no rename. */
	public rename(name: string): boolean {
		if (!name || name === this._name) { return false; }
		this._name = name;
		return true;
	}

	/**
	 * The view's xterm exists: it is given the screen so far, then live output.
	 * `cols` x `rows` is its size, which the process is told about.
	 */
	public attach(cols: number, rows: number): void {
		const session = this._session;
		// Whatever was in flight to a view that is gone will never be acknowledged.
		this._release();
		if (validSize(cols, rows)) {
			this._size = { cols, rows };
			if (session && this._status === 'running') { session.resize(cols, rows); }
		}
		const replay = session?.replay() ?? { data: '', seq: 0 };
		this._attached = true;
		this._post({ type: 'terminalReplay', id: this.id, seq: replay.seq, data: replay.data });
		if (this._status === 'exited') {
			this._post({ type: 'terminalExit', id: this.id, ...(this._exitCode !== undefined ? { code: this._exitCode } : {}) });
		}
	}

	/** The view's page went away (reloaded, closed): output stops being posted, and what was owed is given back. */
	public detach(): void {
		this._attached = false;
		this._release();
	}

	/** The USER's input (the view's keys and pastes): it feeds the typing gate that keeps the agent out. */
	public input(data: unknown): void {
		if (typeof data !== 'string' || !data || data.length > terminalInputLimit || !this.running) { return; }
		this._gate.userInput();
		this._session?.write(data);
		for (const listener of [...this._editorInput]) { listener(data); }
	}

	/**
	 * The AGENT's input, from `terminal_send` / `terminal_key` once the user approved it. The only
	 * way an agent's bytes reach the shell, and it never feeds the typing gate, so an agent typing
	 * several keys in a row is not mistaken for the user. Refused while the user has paused agent
	 * control, while the user is typing, and when the shell has ended; nothing is written then.
	 */
	public agentInput(data: string): TerminalAgentInput {
		if (!this.running) {
			return { ok: false, reason: 'exited', message: 'This terminal has exited; nothing can be typed into it. Ask the user to restart it or pin another.' };
		}
		const verdict = this._gate.checkAgentInput();
		if (!verdict.ok) { return verdict; }
		if (!data || data.length > terminalInputLimit) {
			return { ok: false, reason: 'paused', message: 'There is nothing to type, or it is too long.' };
		}
		this._session?.write(data);
		this._gate.agentTyped();
		this._scheduleActiveEnd();
		this._changed();
		return verdict;
	}

	/** What an agent reads: the screen as text. Works after the shell exited, for what it left. */
	public readScreen(options: { since?: string; scrollback?: boolean; maxChars?: number }): Promise<ScreenRead> {
		const session = this._session;
		if (!session?.readScreen) { return Promise.reject(new Error('The screen of this terminal cannot be read.')); }
		return session.readScreen(options);
	}

	public waitFor(options: { until: 'idle' | 'text' | 'exit' | 'command'; text?: string; quietMs?: number; timeoutMs: number; since?: string; signal?: AbortSignal }): ReturnType<NonNullable<TerminalSessionLike['waitFor']>> {
		const session = this._session;
		if (!session?.waitFor) { return Promise.reject(new Error('The screen of this terminal cannot be read.')); }
		return session.waitFor(options);
	}

	private _scheduleActiveEnd(): void {
		clearTimeout(this._activeTimer);
		const until = this._gate.agentActiveUntil();
		if (until === undefined) { return; }
		// A little after the mark ends, so the strip is redrawn without it.
		this._activeTimer = setTimeout(() => { this._activeTimer = undefined; if (!this._disposed) { this._changed(); } }, Math.max(0, until - this._now()) + 50);
		this._activeTimer.unref?.();
	}

	public resize(cols: unknown, rows: unknown): void {
		if (!validSize(cols, rows)) { return; }
		if (this._remoteControl) { this._viewSize = { cols: cols as number, rows: rows as number }; return; }
		// Remembered even when there is no process right now: a restart in progress starts at it.
		this._size = { cols: cols as number, rows: rows as number };
		if (this.running) { this._session?.resize(cols as number, rows as number); }
	}

	/** The view wrote `bytes` of `terminalData` to its screen. */
	public ack(bytes: unknown): void {
		if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) { return; }
		// Never more than was posted: a view cannot take the count below nothing.
		const n = Math.min(Math.floor(bytes), this._inflight);
		if (n <= 0) { return; }
		this._inflight -= n;
		this._settle();
	}

	/** The process is ended and what was written for it removed; the tab is gone. */
	public dispose(): void {
		this._disposed = true;
		clearTimeout(this._activeTimer);
		this._activeTimer = undefined;
		this._generation++;
		this._attached = false;
		this._consumers.clear();
		this._editorInput.clear();
		this._stop();
	}

	private _data(chunk: string, seq: number): void {
		// Output a quiet terminal gives while another tab is in front: the strip marks it.
		if (this._unread.output(this._isFront())) { this._changed(); }
		this._owed += chunk.length;
		if (this._attached) {
			this._inflight += chunk.length;
			this._post({ type: 'terminalData', id: this.id, seq, data: chunk });
		}
		for (const consumer of [...this._consumers.values()]) {
			consumer.outstanding += chunk.length;
			consumer.sink.data(chunk, seq);
		}
		// Nobody can read it (or not all of it): the session's tail has it for the next view.
		this._settle();
	}

	/** Acknowledges to the session what every consumer (the view and each remote one) has written. */
	private _settle(): void {
		let target = this._attached ? this._inflight : 0;
		for (const consumer of this._consumers.values()) { target = Math.max(target, consumer.outstanding); }
		const give = this._owed - target;
		if (give > 0) {
			this._owed -= give;
			this._session?.ack(give);
		}
	}

	private _exited(code: number | undefined): void {
		if (this._status === 'exited') { return; }
		this._status = 'exited';
		this._exitCode = code;
		this._release();
		this._runCleanup();
		if (this._attached) {
			this._post({ type: 'terminalExit', id: this.id, ...(code !== undefined ? { code } : {}) });
		}
		for (const consumer of [...this._consumers.values()]) { consumer.sink.exit(code); }
		this._changed();
	}

	/** Gives back what the view was sent and will not acknowledge. */
	private _release(): void {
		this._inflight = 0;
		this._settle();
	}

	private _stop(): void {
		const session = this._session;
		this._session = undefined;
		session?.dispose();
		this._runCleanup();
	}

	private _runCleanup(): void {
		const cleanup = this._cleanup;
		this._cleanup = undefined;
		try { cleanup?.(); } catch { /* best effort: a config file left in the private directory */ }
	}
}

function validSize(cols: unknown, rows: unknown): boolean {
	return typeof cols === 'number' && typeof rows === 'number' && Number.isInteger(cols) && Number.isInteger(rows)
		&& cols >= 1 && rows >= 1 && cols <= 1000 && rows <= 1000;
}

/**
 * The window's terminals, in strip order, and which one is in front. The
 * provider holds one and forwards the view's messages to it. Terminals come
 * after the conversations in the strip; `front` is set by selecting or
 * creating one and cleared whenever a conversation is selected.
 */
export class TerminalSet {
	private readonly _tabs: TerminalTab[] = [];
	private _front: string | undefined;
	private _disposed = false;
	/** A terminal whose keyboard input the view is to take: said after the state that shows it, not before. */
	private _focus: string | undefined;

	private readonly _limit: () => number;
	private readonly _post: (message: HostToView) => void;
	private readonly _changed: () => void;
	/** The typing gate and unread mark of each new terminal; without it agents can never type (`closedControls`). */
	private readonly _controls: (() => TerminalControls) | undefined;

	constructor(limit: () => number, post: (message: HostToView) => void, changed: () => void, controls?: () => TerminalControls) {
		this._limit = limit;
		this._post = post;
		this._changed = changed;
		this._controls = controls;
	}

	public get tabs(): readonly TerminalTab[] { return this._tabs; }
	public get front(): string | undefined { return this._front; }
	public get size(): number { return this._tabs.length; }
	public get atLimit(): boolean { return this._tabs.length >= this._limit(); }
	public get limit(): number { return this._limit(); }

	/** The terminal to focus now, once; the provider posts `terminalFocus` right after the state. */
	public takeFocus(): string | undefined {
		const id = this._focus;
		this._focus = undefined;
		return id !== undefined && id === this._front ? id : undefined;
	}

	public find(id: unknown): TerminalTab | undefined {
		return typeof id === 'string' ? this._tabs.find(t => t.id === id) : undefined;
	}

	public summaries(): TerminalTabSummary[] { return this._tabs.map(t => t.summary()); }

	/**
	 * A new terminal at the end of the strip, in front. The process is started
	 * first: a failure is thrown and leaves no tab behind.
	 */
	public async create(id: string, name: string, cwd: string, agent: AgentId | undefined, starter: TerminalStarter, options: { background?: boolean; now?: () => number; remote?: boolean } = {}): Promise<TerminalTab> {
		if (this._disposed) { throw new Error('The chat view was closed.'); }
		const tab = new TerminalTab(id, name, cwd, agent, starter, this._post, this._changed, {
			isFront: () => this._front === id,
			...(options.now ? { now: options.now } : {}),
			...(this._controls ? { controls: this._controls() } : {}),
		});
		await tab.start();
		if (this._disposed) {
			// The window closed while the process was being made.
			tab.dispose();
			throw new Error('The chat view was closed.');
		}
		// Made from the Exchange website: shared with it from the start.
		if (options.remote) { tab.setRemote(true); }
		this._tabs.push(tab);
		// A terminal made for an agent in the background leaves the view where it is.
		if (!options.background) {
			this._front = tab.id;
			this._focus = tab.id;
		}
		this._changed();
		return tab;
	}

	/** In front, if there is such a terminal (and read: its unread mark goes). Returns whether the front changed. */
	public select(id: unknown): boolean {
		const tab = this.find(id);
		if (!tab || this._front === tab.id) { return false; }
		this._front = tab.id;
		this._focus = tab.id;
		tab.markRead();
		this._changed();
		return true;
	}

	/** A conversation is in front now. Returns whether a terminal was. */
	public clearFront(): boolean {
		if (this._front === undefined) { return false; }
		this._front = undefined;
		return true;
	}

	/** Closing kills the process; the next tab to the left comes to the front when this one was. */
	public close(id: unknown): boolean {
		const tab = this.find(id);
		if (!tab) { return false; }
		const at = this._tabs.indexOf(tab);
		this._tabs.splice(at, 1);
		tab.dispose();
		if (this._front === tab.id) {
			// A neighbour terminal, else a conversation (the front is cleared).
			this._front = this._tabs[Math.min(at, this._tabs.length - 1)]?.id;
			this._focus = this._front;
		}
		this._changed();
		return true;
	}

	public names(): string[] { return this._tabs.map(t => t.name); }

	/** The view's page went away: output stops, and nothing is owed. */
	public detachAll(): void {
		for (const tab of this._tabs) { tab.detach(); }
	}

	/** Every process is ended. */
	public dispose(): void {
		this._disposed = true;
		for (const tab of this._tabs.splice(0)) { tab.dispose(); }
		this._front = undefined;
	}
}
