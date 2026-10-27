/*
 * Terminal tabs on the Exchange website: the shim between the chat renderer and the
 * editor's terminals.
 *
 * The renderer (`chat.ts`, `terminalView.ts`) is the editor's, unchanged: it posts
 * `terminalAttach` / `terminalInput` / `terminalResize` / `terminalAck` /
 * `terminalPasteRequest` and handles `terminalReplay` / `terminalData` /
 * `terminalExit` / `terminalSettings` / `terminalPaste`. This turns those into the
 * `terminal.*` frames of `src/chat/remoteTerminalProtocol.ts`, sent over the
 * encrypted socket, and back.
 *
 * The viewer WATCHES by default: its keystrokes are dropped (with one notice) until
 * it holds the control lease ("Take control"). xterm's automatic replies to a
 * terminal query are dropped silently then — they are not the user typing, and two
 * screens answering one query would both be read by the program.
 *
 * Leaf: no DOM and no relative value imports (`npm test` loads it). The protocol's
 * functions are handed in, so the bundle and the test both use the real ones.
 */

import type { HostToView, TerminalSettings, ViewToHost } from '../src/chat/chatProtocol';
import type { AgentTerminalFrame, ViewerTerminalFrame } from '../src/chat/remoteTerminalProtocol';

export type RemoteLeaseView = 'editor' | 'you' | 'other';

/** The lease as the terminal view's toolbar sees it (`TerminalViewOptions.lease`). */
export interface RemoteLeaseControl {
	/** Who may type into this terminal now; undefined before the editor has said. */
	holder(id: string): RemoteLeaseView | undefined;
	/** Take control, or give it back. */
	toggle(id: string): void;
	onChange(listener: () => void): void;
}

/** Frames as the shim sends them: without the per-viewer envelope the shim adds. */
type Outgoing = ViewerTerminalFrame extends infer F ? F extends ViewerTerminalFrame ? Omit<F, 'e' | 'v' | 'n'> : never : never;

export interface RemoteTerminalDeps {
	readonly viewerId: string;
	/** The agent connection's epoch (the snapshot's), or undefined while there is none. */
	readonly epoch: () => string | undefined;
	/** Sends one frame on the socket; false when it could not (offline). */
	readonly send: (frame: Record<string, unknown>) => boolean;
	/** To the renderer. */
	readonly emit: (message: HostToView) => void;
	/** A line above the chat. */
	readonly notice: (text: string) => void;
	/** The viewer's own clipboard (there is no host clipboard on a website). */
	readonly readClipboard?: () => Promise<string>;
	readonly readAgentFrame: (value: unknown) => AgentTerminalFrame | undefined;
	readonly isTerminalReply: (data: string) => boolean;
	readonly splitData: (data: string, max: number) => string[];
	readonly inputFrameMax: number;
	/** Re-attach a viewer the editor dropped as slow after this long. */
	readonly retryMs?: number;
	readonly setTimer?: (run: () => void, ms: number) => unknown;
	readonly clearTimer?: (handle: unknown) => void;
	/** Settings for xterm: the website's own (there are no editor `terminal.integrated.*` here). */
	readonly settings?: TerminalSettings;
}

export interface RemoteTerminalShim extends RemoteLeaseControl {
	/** A renderer message; true when it was a terminal one and was handled here. */
	fromView(message: ViewToHost): boolean;
	/** A decoded socket message; true when it was a terminal frame (for this viewer or not). */
	fromAgent(value: unknown): boolean;
	/** The terminals the state names: any other one attached here is detached. */
	syncTerminals(ids: readonly string[]): void;
	/** A new connection: every attached terminal is attached again (the editor sends a fresh replay). */
	reconnected(): void;
}

const terminalViewTypes = new Set<ViewToHost['type']>(['terminalAttach', 'terminalInput', 'terminalResize', 'terminalAck', 'terminalPasteRequest']);

export function createRemoteTerminalShim(deps: RemoteTerminalDeps): RemoteTerminalShim {
	const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
	const clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
	let counter = 0;
	/** Size per attached terminal. */
	const attached = new Map<string, { cols: number; rows: number }>();
	const leases = new Map<string, RemoteLeaseView>();
	const listeners: (() => void)[] = [];
	const retries = new Map<string, unknown>();
	let watchNoticeShown = false;
	let settingsSent = false;

	function frame(body: Outgoing): boolean {
		const e = deps.epoch();
		if (!e) { return false; }
		counter++;
		return deps.send({ ...body, e, v: deps.viewerId, n: counter });
	}
	function changed(): void { for (const listener of listeners) { listener(); } }
	function attach(t: string, size: { cols: number; rows: number }): void {
		attached.set(t, size);
		if (!settingsSent) { settingsSent = true; deps.emit({ type: 'terminalSettings', settings: deps.settings ?? {} }); }
		if (!frame({ type: 'terminal.attach', t, cols: size.cols, rows: size.rows })) {
			deps.notice('The terminal is not reachable: the workspace is offline.');
		}
	}

	return {
		fromView(message) {
			if (!terminalViewTypes.has(message.type)) { return false; }
			switch (message.type) {
				case 'terminalAttach':
					attach(message.id, { cols: message.cols, rows: message.rows });
					return true;
				case 'terminalResize':
					if (attached.has(message.id)) { attached.set(message.id, { cols: message.cols, rows: message.rows }); }
					// Only the lease holder's size reaches the shell; a watcher keeps its own fit locally.
					if (leases.get(message.id) === 'you') { frame({ type: 'terminal.resize', t: message.id, cols: message.cols, rows: message.rows }); }
					return true;
				case 'terminalAck':
					if (message.bytes > 0) { frame({ type: 'terminal.ack', t: message.id, bytes: message.bytes }); }
					return true;
				case 'terminalInput': {
					if (leases.get(message.id) !== 'you') {
						if (!deps.isTerminalReply(message.data) && !watchNoticeShown) {
							watchNoticeShown = true;
							deps.notice('You are watching this terminal. Take control to type.');
						}
						return true;
					}
					for (const data of deps.splitData(message.data, deps.inputFrameMax)) { frame({ type: 'terminal.input', t: message.id, data }); }
					return true;
				}
				case 'terminalPasteRequest': {
					const id = message.id;
					if (!deps.readClipboard) { deps.notice('Paste with the keyboard: this browser does not let the page read the clipboard.'); return true; }
					deps.readClipboard().then(text => { if (text) { deps.emit({ type: 'terminalPaste', id, text }); } },
						() => deps.notice('The clipboard could not be read. Allow clipboard access or paste with the keyboard.'));
					return true;
				}
			}
			return true;
		},

		fromAgent(value) {
			if (!value || typeof value !== 'object' || typeof (value as { type?: unknown }).type !== 'string' || !(value as { type: string }).type.startsWith('terminal.')) { return false; }
			const f = deps.readAgentFrame(value);
			// Agent → viewers is a broadcast: another viewer's frames are not ours.
			if (!f || f.v !== deps.viewerId) { return true; }
			switch (f.type) {
				case 'terminal.replay': deps.emit({ type: 'terminalReplay', id: f.t, seq: f.seq, data: f.data }); break;
				case 'terminal.data': deps.emit({ type: 'terminalData', id: f.t, seq: f.seq, data: f.data }); break;
				case 'terminal.exit': deps.emit({ type: 'terminalExit', id: f.t, ...(f.code !== undefined ? { code: f.code } : {}) }); break;
				case 'terminal.lease':
					if (leases.get(f.t) !== f.holder) {
						leases.set(f.t, f.holder);
						if (f.holder === 'you') {
							watchNoticeShown = false;
							// The shell takes the size of the screen that now types into it.
							const size = attached.get(f.t);
							if (size) { frame({ type: 'terminal.resize', t: f.t, cols: size.cols, rows: size.rows }); }
						}
						changed();
					}
					break;
				case 'terminal.error':
					if (f.reason === 'slow') {
						// Dropped for falling behind: attach again for a fresh screen.
						const size = attached.get(f.t);
						if (size && !retries.has(f.t)) {
							retries.set(f.t, setTimer(() => { retries.delete(f.t); if (attached.has(f.t)) { attach(f.t, attached.get(f.t)!); } }, deps.retryMs ?? 1000));
						}
						break;
					}
					if (f.reason === 'watch-only') {
						if (leases.get(f.t) === 'you') { leases.set(f.t, 'editor'); changed(); }
					}
					if (f.reason === 'gone') { attached.delete(f.t); }
					deps.notice(f.message);
					break;
			}
			return true;
		},

		syncTerminals(ids) {
			for (const t of [...attached.keys()]) {
				if (ids.includes(t)) { continue; }
				attached.delete(t);
				const handle = retries.get(t);
				if (handle !== undefined) { clearTimer(handle); retries.delete(t); }
				if (leases.delete(t)) { changed(); }
				frame({ type: 'terminal.detach', t });
			}
		},

		reconnected() {
			// Leases do not survive a new connection; the editor says again who holds them.
			if (leases.size) { leases.clear(); changed(); }
			for (const [t, size] of attached) { attach(t, size); }
		},

		holder: id => leases.get(id),
		toggle(id) {
			const holding = leases.get(id) === 'you';
			if (!frame({ type: 'terminal.lease', t: id, op: holding ? 'release' : 'claim' })) {
				deps.notice('The workspace is offline.');
			}
		},
		onChange(listener) { listeners.push(listener); },
	};
}
