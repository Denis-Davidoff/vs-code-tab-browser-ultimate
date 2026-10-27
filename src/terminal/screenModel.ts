/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The screen of one terminal as an agent reads it. The PTY's byte stream goes through a headless xterm.js (the
// same version the view draws with), so what comes out is the *screen* — a progress bar redrawn with `\r`, an Ink
// UI repainted with cursor-up, a full-screen program — and not the pile of escape sequences that made it. No
// `vscode` import and no relative value import, so `npm test` loads it directly (the rule under "Recipe for the
// next feature" in CLAUDE.md); the only non-relative dependency is the emulator, loaded like node-pty is:
// `scripts/stage-terminal.mjs` puts one file into `out/terminal/vendor/xterm-headless`, a development checkout
// falls back to `node_modules`.
//
// Units are the PTY layer's: `seq` is UTF-16 code units of the stream the session has delivered.
//
// **Never subscribe to the emulator's `onData`.** A headless terminal answers terminal queries (CPR, DA) through
// it; the view's xterm already answers them, and a second answer would reach the shell as input.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------------------------
// The contract with the rest of the extension
// ---------------------------------------------------------------------------------------------

export interface ScreenState {
	status: 'running' | 'exited';
	exitCode?: number;
	altScreen: boolean;
	/** Milliseconds since the shell last wrote anything. */
	idleMs: number;
	cols: number;
	rows: number;
	cwd?: string;
	title?: string;
	/** `unknown` until the shell reports command boundaries (OSC 133), which no shell does by itself unless it is set up to. */
	commandState: 'running' | 'prompt' | 'unknown';
	lastExitCode?: number;
	integration: 'osc133' | 'none';
	/** The emulator was not available: the text is the stream's tail with its escapes taken out, not a screen. */
	degraded?: boolean;
	/** The program asked for bracketed paste (DECSET 2004): an insert is wrapped in ESC[200~ … ESC[201~. */
	bracketedPaste?: boolean;
}

export interface ScreenRead {
	/** Plain text, soft-wrapped rows joined. The viewport, or with `since` / `scrollback` what those ask for. */
	text: string;
	/** The visible rows of the active screen (the alternate one while a full-screen program runs). */
	viewport: string;
	/** Opaque `generation.seq`; give it back as `since` to read only what came after. */
	cursor: string;
	/** Something was left out: a cap, or a `since` whose place the scrollback no longer holds. */
	truncated: boolean;
	state: ScreenState;
}

export interface ScreenReadOptions {
	since?: string;
	/** The whole retained scrollback, not only the screen. */
	scrollback?: boolean;
	maxChars?: number;
}

export type ScreenWaitReason = 'idle' | 'text' | 'exit' | 'command' | 'timeout' | 'aborted';

export interface ScreenWaitOptions {
	until: 'idle' | 'text' | 'exit' | 'command';
	/** For `until: 'text'`: a literal, case-sensitive, looked for in the screen and in what came after `since`. */
	text?: string;
	/** For `idle`: how long the screen must stay unchanged (default 800). */
	quietMs?: number;
	timeoutMs: number;
	since?: string;
	signal?: AbortSignal;
	maxChars?: number;
	scrollback?: boolean;
}

export interface ScreenWait extends ScreenRead {
	reason: ScreenWaitReason;
	/** `command`: the exit status the shell reported, when it did. */
	exitCode?: number;
	/** `command`: the rows between the shell's start-of-output and end-of-command marks, when they are still held. */
	output?: string;
	/** `idle`: the last line looks like a question or a prompt for input. Advisory. */
	maybeAwaitingInput?: boolean;
}

// ---------------------------------------------------------------------------------------------
// The emulator, structurally (rule: a module `npm test` loads may not import the real types)
// ---------------------------------------------------------------------------------------------

interface EmuLine {
	readonly isWrapped: boolean;
	translateToString(trimRight?: boolean): string;
}

interface EmuMarker {
	readonly line: number;
	readonly isDisposed: boolean;
	dispose(): void;
}

interface EmuBuffer {
	readonly type: 'normal' | 'alternate';
	readonly length: number;
	readonly baseY: number;
	readonly cursorX: number;
	readonly cursorY: number;
	getLine(y: number): EmuLine | undefined;
}

export interface Emulator {
	readonly cols: number;
	readonly rows: number;
	readonly buffer: { readonly active: EmuBuffer; readonly normal: EmuBuffer; readonly alternate: EmuBuffer };
	readonly parser: { registerOscHandler(ident: number, callback: (data: string) => boolean): { dispose(): void } };
	write(data: string, callback?: () => void): void;
	resize(cols: number, rows: number): void;
	registerMarker(cursorYOffset?: number): EmuMarker | undefined;
	onTitleChange(listener: (title: string) => void): { dispose(): void };
	/** xterm's mode flags; optional so a test's fake emulator need not carry them. */
	readonly modes?: { readonly bracketedPasteMode?: boolean };
	dispose(): void;
}

export interface EmulatorOptions {
	cols: number;
	rows: number;
	scrollback: number;
	allowProposedApi: boolean;
	windowsPty?: { backend: 'conpty' | 'winpty' };
}

export type EmulatorFactory = (options: EmulatorOptions) => Emulator;

let loadedFactory: EmulatorFactory | undefined;

/** `require` where there is one (compiled, CommonJS); under `node --test` the modules are ESM and there is none. */
function nodeRequire(): (id: string) => unknown {
	return typeof require === 'function' ? require : createRequire(path.join(process.cwd(), 'noop.js'));
}

/**
 * The headless xterm: the file `scripts/stage-terminal.mjs` staged beside the compiled host, else the development
 * checkout's `node_modules`. Throws when neither is there — the session then reads the raw tail instead.
 */
export function loadEmulator(): EmulatorFactory {
	if (loadedFactory) {
		return loadedFactory;
	}
	const req = nodeRequire();
	const staged = typeof __dirname === 'string' ? path.join(__dirname, 'vendor', 'xterm-headless', 'xterm-headless.js') : undefined;
	let mod: { Terminal: new (options: Record<string, unknown>) => Emulator };
	if (staged && fs.existsSync(staged)) {
		mod = req(staged) as typeof mod;
	} else {
		try {
			mod = req('@xterm/headless') as typeof mod;
		} catch {
			throw new Error('The terminal screen emulator is missing: ' + (staged ?? 'out/terminal/vendor/xterm-headless/xterm-headless.js') + ' was not staged (run npm run build-ext).');
		}
	}
	loadedFactory = options => new mod.Terminal({ ...options });
	return loadedFactory;
}

/** Forgets the loaded module (a test). */
export function resetEmulatorLoader(): void {
	loadedFactory = undefined;
}

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------

export const defaultScrollback = 3000;
export const maxScrollback = 10000;
export const defaultReadChars = 12_000;
export const maxReadChars = 40_000;
export const maxReadLines = 500;
export const maxLineChars = 2000;
/** What a wait may last, whatever the caller asked for (the MCP layer caps lower). */
export const maxWaitMs = 120_000;
const defaultQuietMs = 800;
const pollMs = 100;
const settleMs = 250;
/** After the shell reports the end of a command, how long its prompt gets to be drawn. */
const promptDrawMs = 60;
const maxMarks = 32;
const maxCheckpoints = 16;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}

/** `text` cut to `max` UTF-16 units without leaving half of a surrogate pair. */
function cutUnits(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	let end = max;
	const last = text.charCodeAt(end - 1);
	if (last >= 0xD800 && last <= 0xDBFF) {
		end--;
	}
	return text.slice(0, end);
}

/** Control characters out of a string an application chose (the title, the working directory). */
function plainLabel(text: string, max: number): string {
	return cutUnits(text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ''), max);
}

// ---------------------------------------------------------------------------------------------
// Reading a buffer
// ---------------------------------------------------------------------------------------------

/**
 * The logical lines of rows `from..to` of a buffer: the rows of one soft-wrapped line joined, trailing spaces of
 * the line's last row dropped. A wrapped row is full width, so its trailing spaces are content.
 */
export function logicalLines(buffer: EmuBuffer, from: number, to: number): string[] {
	const out: string[] = [];
	let current: string | undefined;
	const last = Math.min(to, buffer.length - 1);
	for (let y = Math.max(0, from); y <= last; y++) {
		const line = buffer.getLine(y);
		if (!line) {
			continue;
		}
		const row = line.translateToString(false);
		if (line.isWrapped && current !== undefined) {
			current += row;
		} else {
			if (current !== undefined) {
				out.push(current.replace(/ +$/, ''));
			}
			current = row;
		}
	}
	if (current !== undefined) {
		out.push(current.replace(/ +$/, ''));
	}
	return out;
}

function dropTrailingBlank(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === '') {
		end--;
	}
	return end === lines.length ? lines : lines.slice(0, end);
}

/** Keeps the newest lines within the caps; `truncated` says something was cut. */
export function capLines(lines: string[], maxChars: number): { text: string; truncated: boolean } {
	let truncated = false;
	let kept = lines;
	if (kept.length > maxReadLines) {
		kept = kept.slice(kept.length - maxReadLines);
		truncated = true;
	}
	kept = kept.map(line => {
		if (line.length > maxLineChars) {
			truncated = true;
			return cutUnits(line, maxLineChars) + '…';
		}
		return line;
	});
	let total = 0;
	let start = kept.length;
	while (start > 0) {
		const add = kept[start - 1].length + (total > 0 ? 1 : 0);
		if (total + add > maxChars) {
			break;
		}
		total += add;
		start--;
	}
	if (start > 0) {
		truncated = true;
		if (start === kept.length) {
			// One line alone is over the budget (a small `maxChars`): keep the start of the newest.
			return { text: cutUnits(kept[kept.length - 1], maxChars), truncated: true };
		}
		kept = kept.slice(start);
	}
	return { text: kept.join('\n'), truncated };
}

/** A last line that asks for input: a question, a `[y/N]`, a `Password:`. Advisory only. */
export function looksLikePrompt(text: string): boolean {
	const lines = text.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].trim() === '') {
			continue;
		}
		return /(\?|:|\[[yY]\/[nN]\]|\[[nN]\/[yY]\]|\([yY]\/[nN]\)|\(yes\/no\))\s*$/.test(lines[i]);
	}
	return false;
}

// ---------------------------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------------------------

export interface ScreenModelOptions {
	cols: number;
	rows: number;
	cwd?: string;
	scrollback?: number;
	/** Conpty reflows lines differently; the view tells xterm so, and so must this. */
	windowsPty?: { backend: 'conpty' | 'winpty' };
	/** Test seam: another emulator. */
	emulator?: EmulatorFactory;
}

export interface ScreenModelHooks {
	/** Delivers what the session still holds back (its batch timer) so a read sees it. */
	flush(): void;
	/** The emulator parsed something: the session may read the shell again. */
	drained(): void;
}

interface Chunk {
	readonly end: number;
	readonly length: number;
}

interface Mark {
	readonly kind: 'C' | 'D';
	readonly seq: number;
	readonly exitCode?: number;
	/** A `D` that ends a command, as against the one a shell prints at start-up. */
	readonly result: boolean;
}

interface Checkpoint {
	readonly seq: number;
	readonly marker: EmuMarker | undefined;
}

function markerAlive(marker: EmuMarker | undefined): marker is EmuMarker {
	return marker !== undefined && !marker.isDisposed && marker.line >= 0;
}

function newGeneration(): string {
	return Math.floor(Math.random() * 0xffffff).toString(36) + Date.now().toString(36).slice(-3);
}

const cursorPattern = /^([0-9a-z]+)\.(\d+)$/;

export class ScreenModel {
	private readonly _emu: Emulator;
	private readonly _generation = newGeneration();
	private _hooks: ScreenModelHooks | undefined;
	private readonly _inflight: Chunk[] = [];
	private _backlog = 0;
	private _parsedSeq = 0;
	private _version = 0;
	private _lastOutputAt = Date.now();
	private _lastInputAt = 0;
	private _inputSeq = 0;
	private _inputPending = false;
	private _failed = false;
	private _disposed = false;
	private _exited = false;
	private _exitCode: number | undefined;
	private _title: string | undefined;
	private _cwd: string | undefined;
	private _integration: 'osc133' | 'none' = 'none';
	private _commandState: 'running' | 'prompt' | 'unknown' = 'unknown';
	private _lastExitCode: number | undefined;
	private _marks: Mark[] = [];
	private _checkpoints: Checkpoint[] = [];
	private _command: { startSeq: number; marker: EmuMarker | undefined } | undefined;
	private _lastCommand: { endSeq: number; exitCode: number | undefined; output: string | undefined } | undefined;
	private _settlers: Array<() => void> = [];
	private _wakers = new Set<() => void>();

	constructor(o: ScreenModelOptions) {
		const factory = o.emulator ?? loadEmulator();
		this._emu = factory({
			cols: clampInt(o.cols, 2, 500, 80),
			rows: clampInt(o.rows, 1, 200, 24),
			scrollback: clampInt(o.scrollback, 0, maxScrollback, defaultScrollback),
			allowProposedApi: true,
			windowsPty: o.windowsPty,
		});
		this._cwd = o.cwd ? plainLabel(o.cwd, 1000) : undefined;
		this._emu.onTitleChange(title => { this._title = plainLabel(title, 200); });
		for (const ident of [133, 633]) {
			this._emu.parser.registerOscHandler(ident, data => { this._osc(ident, data); return true; });
		}
		this._emu.parser.registerOscHandler(7, data => { this._osc7(data); return true; });
	}

	/** Connected by the session that owns the model. */
	attach(hooks: ScreenModelHooks): void {
		this._hooks = hooks;
	}

	/** Output the emulator has been given and not yet parsed, in stream units. The session pauses the shell above a cap. */
	get backlog(): number {
		return this._backlog;
	}

	/** The emulator threw (its own queue limit, a bug): what it holds is no longer the screen. */
	get failed(): boolean {
		return this._failed || this._disposed;
	}

	get lastOutputAt(): number {
		return this._lastOutputAt;
	}

	// -- feeding ------------------------------------------------------------------------------

	/** The next batch of the stream; `seq` is the stream's place after it. Never throws. */
	feed(chunk: string, seq: number): void {
		if (this._disposed || this._failed || chunk.length === 0) {
			return;
		}
		this._lastOutputAt = Date.now();
		const entry: Chunk = { end: seq, length: chunk.length };
		this._inflight.push(entry);
		this._backlog += chunk.length;
		try {
			this._emu.write(chunk, () => this._parsed(entry));
		} catch {
			// The emulator refuses data past its own 50 MB queue ("use flow control"). The session's cap keeps it far
			// below that, so this is a bug or a dead emulator: stop trusting the screen rather than the shell's output.
			this._inflight.pop();
			this._backlog -= chunk.length;
			this._failed = true;
			this._release();
		}
	}

	private _parsed(entry: Chunk): void {
		if (this._disposed) {
			return;
		}
		const index = this._inflight.indexOf(entry);
		if (index >= 0) {
			this._inflight.splice(index, 1);
		}
		this._backlog = Math.max(0, this._backlog - entry.length);
		this._parsedSeq = Math.max(this._parsedSeq, entry.end);
		this._version++;
		if (this._backlog === 0) {
			this._release();
		}
		try { this._hooks?.drained(); } catch { /* the session's own problem */ }
	}

	private _release(): void {
		const waiting = this._settlers;
		this._settlers = [];
		for (const resolve of waiting) {
			resolve();
		}
	}

	/** Keys went to the shell; `seq` is where the stream stood. A `command` wait with no `since` counts from here. */
	noteInput(text: string, seq: number): void {
		this._lastInputAt = Date.now();
		this._inputSeq = seq;
		if (text.includes('\r') || text.includes('\n')) {
			this._inputPending = true;
		}
	}

	/** The new size, mirrored from the PTY. */
	resize(cols: number, rows: number): void {
		if (this._disposed || this._failed) {
			return;
		}
		const c = clampInt(cols, 2, 500, this._emu.cols);
		const r = clampInt(rows, 1, 200, this._emu.rows);
		if (c === this._emu.cols && r === this._emu.rows) {
			return;
		}
		try { this._emu.resize(c, r); } catch { this._failed = true; }
	}

	/** The shell ended. The screen stays readable until `dispose`. */
	markExit(code: number | undefined): void {
		this._exited = true;
		this._exitCode = typeof code === 'number' ? code : undefined;
		this._wake();
	}

	dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		for (const cp of this._checkpoints) {
			try { cp.marker?.dispose(); } catch { /* gone */ }
		}
		this._checkpoints = [];
		try { this._command?.marker?.dispose(); } catch { /* gone */ }
		this._command = undefined;
		try { this._emu.dispose(); } catch { /* gone */ }
		this._release();
		this._wake();
	}

	// -- what the shell says about itself -----------------------------------------------------

	/** The stream place of the chunk being parsed: marks are laid while the emulator works through a batch. */
	private _parsingSeq(): number {
		return this._inflight.length > 0 ? this._inflight[0].end : this._parsedSeq;
	}

	private _marker(): EmuMarker | undefined {
		try {
			return this._emu.buffer.active.type === 'normal' ? this._emu.registerMarker(0) : undefined;
		} catch {
			return undefined;
		}
	}

	private _pushMark(mark: Mark): void {
		this._marks.push(mark);
		if (this._marks.length > maxMarks) {
			this._marks.shift();
		}
	}

	/** OSC 133 (and VS Code's 633, which carries the same A/B/C/D and more). */
	private _osc(ident: number, data: string): void {
		const parts = data.split(';');
		const kind = parts[0];
		const seq = this._parsingSeq();
		switch (kind) {
			case 'A':
			case 'B':
				this._integration = 'osc133';
				if (this._commandState !== 'running') {
					this._commandState = 'prompt';
				}
				break;
			case 'C': {
				this._integration = 'osc133';
				this._commandState = 'running';
				try { this._command?.marker?.dispose(); } catch { /* gone */ }
				this._command = { startSeq: seq, marker: this._marker() };
				this._pushMark({ kind: 'C', seq, result: false });
				break;
			}
			case 'D': {
				this._integration = 'osc133';
				const result = this._commandState === 'running' || this._inputPending;
				const code = parts.length > 1 && /^-?\d+$/.test(parts[1]) ? Number(parts[1]) : undefined;
				this._pushMark({ kind: 'D', seq, exitCode: code, result });
				if (result) {
					if (code !== undefined) {
						this._lastExitCode = code;
					}
					this._lastCommand = { endSeq: seq, exitCode: code, output: this._commandOutput() };
				}
				try { this._command?.marker?.dispose(); } catch { /* gone */ }
				this._command = undefined;
				this._commandState = 'prompt';
				this._inputPending = false;
				break;
			}
			case 'P':
				if (ident === 633 && parts[1] && parts[1].startsWith('Cwd=')) {
					this._cwd = plainLabel(parts.slice(1).join(';').slice(4), 1000);
				}
				break;
			default:
				break;
		}
	}

	/** The rows between a command's start mark and the cursor now, while both are still held. */
	private _commandOutput(): string | undefined {
		const command = this._command;
		if (!command || !markerAlive(command.marker) || this._emu.buffer.active.type !== 'normal') {
			return undefined;
		}
		const buffer = this._emu.buffer.normal;
		const cursorRow = buffer.baseY + buffer.cursorY;
		const lines = dropTrailingBlank(logicalLines(buffer, command.marker.line, buffer.cursorX > 0 ? cursorRow : cursorRow - 1));
		return capLines(lines, maxReadChars).text;
	}

	/** OSC 7: the working directory as a `file://` address (zsh and most prompts send it). */
	private _osc7(data: string): void {
		const match = /^file:\/\/[^/]*(\/.*)$/.exec(data);
		if (!match) {
			return;
		}
		let value = match[1];
		try { value = decodeURIComponent(value); } catch { /* keep it as sent */ }
		if (/^\/[A-Za-z]:[\\/]/.test(value)) {
			value = value.slice(1);
		}
		this._cwd = plainLabel(value, 1000);
	}

	// -- reading ------------------------------------------------------------------------------

	/**
	 * Waits until the emulator has parsed everything it was given, after the session has delivered what it held back.
	 * Bounded: a flood the emulator cannot finish in `settleMs` is read as it stands.
	 */
	async settle(): Promise<void> {
		try { this._hooks?.flush(); } catch { /* the session's own problem */ }
		if (this._backlog === 0 || this._disposed || this._failed) {
			return;
		}
		await new Promise<void>(resolve => {
			const timer = setTimeout(done, settleMs);
			const waiter = (): void => done();
			function done(): void {
				clearTimeout(timer);
				resolve();
			}
			this._settlers.push(waiter);
		});
	}

	async read(o: ScreenReadOptions = {}): Promise<ScreenRead> {
		await this.settle();
		return this.readNow(o);
	}

	private _state(): ScreenState {
		const buffer = this._emu.buffer.active;
		const state: ScreenState = {
			status: this._exited ? 'exited' : 'running',
			altScreen: buffer.type === 'alternate',
			idleMs: Math.max(0, Date.now() - this._lastOutputAt),
			cols: this._emu.cols,
			rows: this._emu.rows,
			commandState: this._integration === 'none' ? 'unknown' : this._commandState,
			integration: this._integration,
		};
		if (this._exitCode !== undefined) {
			state.exitCode = this._exitCode;
		}
		if (this._cwd !== undefined) {
			state.cwd = this._cwd;
		}
		if (this._title !== undefined) {
			state.title = this._title;
		}
		if (this._lastExitCode !== undefined) {
			state.lastExitCode = this._lastExitCode;
		}
		if (this._emu.modes?.bracketedPasteMode) {
			state.bracketedPaste = true;
		}
		return state;
	}

	private _viewportLines(): string[] {
		const buffer = this._emu.buffer.active;
		return dropTrailingBlank(logicalLines(buffer, buffer.baseY, buffer.baseY + this._emu.rows - 1));
	}

	/** The screen's text, and what a later `since` is checked against. */
	private _signature(): string {
		const buffer = this._emu.buffer.active;
		return buffer.type + '|' + buffer.cursorX + ',' + buffer.cursorY + '|' + this._viewportLines().join('\n');
	}

	private _parseCursor(since: string | undefined): number | undefined {
		if (typeof since !== 'string') {
			return undefined;
		}
		const match = cursorPattern.exec(since);
		return match && match[1] === this._generation ? Number(match[2]) : undefined;
	}

	private _layCheckpoint(seq: number): void {
		const existing = this._checkpoints.findIndex(cp => cp.seq === seq);
		if (existing >= 0) {
			if (markerAlive(this._checkpoints[existing].marker) || this._emu.buffer.active.type !== 'normal') {
				return;
			}
			this._checkpoints.splice(existing, 1);
		}
		this._checkpoints.push({ seq, marker: this._marker() });
		while (this._checkpoints.length > maxCheckpoints) {
			const old = this._checkpoints.shift();
			try { old?.marker?.dispose(); } catch { /* gone */ }
		}
	}

	/** The lines of the normal buffer from the checkpoint `seq` on, or undefined when its place is gone. */
	private _linesSince(seq: number | undefined): string[] | undefined {
		if (seq === undefined) {
			return undefined;
		}
		const cp = this._checkpoints.find(c => c.seq === seq);
		if (!cp || !markerAlive(cp.marker)) {
			return undefined;
		}
		const buffer = this._emu.buffer.normal;
		let start = cp.marker.line;
		// The cursor's row may be the continuation of a wrapped line: begin where that line begins.
		while (start > 0 && buffer.getLine(start)?.isWrapped) {
			start--;
		}
		return dropTrailingBlank(logicalLines(buffer, start, buffer.length - 1));
	}

	/** A read without settling — for a caller that has just done so (the waits). */
	readNow(o: ScreenReadOptions = {}): ScreenRead {
		const maxChars = clampInt(o.maxChars, 100, maxReadChars, defaultReadChars);
		const buffer = this._emu.buffer.active;
		const viewportLines = this._viewportLines();
		const alt = buffer.type === 'alternate';
		const sinceSeq = this._parseCursor(o.since);
		let lines: string[];
		let truncated = false;
		if (alt) {
			lines = viewportLines;
		} else if (typeof o.since === 'string' && o.since !== '') {
			const since = this._linesSince(sinceSeq);
			if (since) {
				lines = since;
			} else {
				// Gone — scrolled out, or never ours: what is retained instead, and say so.
				lines = dropTrailingBlank(logicalLines(this._emu.buffer.normal, 0, this._emu.buffer.normal.length - 1));
				truncated = true;
			}
		} else if (o.scrollback) {
			lines = dropTrailingBlank(logicalLines(this._emu.buffer.normal, 0, this._emu.buffer.normal.length - 1));
		} else {
			lines = viewportLines;
		}
		const capped = capLines(lines, maxChars);
		const viewport = capLines(viewportLines, maxChars).text;
		const seq = this._parsedSeq;
		this._layCheckpoint(seq);
		return {
			text: capped.text,
			viewport,
			cursor: this._generation + '.' + seq,
			truncated: truncated || capped.truncated,
			state: this._state(),
		};
	}

	// -- waiting ------------------------------------------------------------------------------

	private _wake(): void {
		const wakers = [...this._wakers];
		this._wakers.clear();
		for (const wake of wakers) {
			wake();
		}
	}

	private _sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
		return new Promise<void>(resolve => {
			const finish = (): void => {
				clearTimeout(timer);
				this._wakers.delete(finish);
				signal?.removeEventListener('abort', finish);
				resolve();
			};
			const timer = setTimeout(finish, ms);
			this._wakers.add(finish);
			signal?.addEventListener('abort', finish, { once: true });
		});
	}

	/** Text of the screen and of what came after `sinceSeq`, for a `text` wait. */
	private _haystack(sinceSeq: number | undefined): string {
		const viewport = this._viewportLines().join('\n');
		const after = this._emu.buffer.active.type === 'normal' ? this._linesSince(sinceSeq) : undefined;
		return after ? viewport + '\n' + after.join('\n') : viewport;
	}

	/**
	 * Ends on the first of: the shell exiting, an abort, the condition asked for, the timeout. Always answers with a
	 * read and the reason; only a missing `text` for a text wait is an error. Polled, never a busy loop: every
	 * round settles the emulator and looks at the screen only if it changed.
	 */
	async wait(o: ScreenWaitOptions): Promise<ScreenWait> {
		if (o.until === 'text' && (typeof o.text !== 'string' || o.text === '')) {
			throw new Error('A text wait needs the text to wait for.');
		}
		const started = Date.now();
		const deadline = started + clampInt(o.timeoutMs, 0, maxWaitMs, 30_000);
		const quietMs = clampInt(o.quietMs, 50, 60_000, defaultQuietMs);
		await this.settle();
		const startSeq = this._parsedSeq;
		const given = this._parseCursor(o.since);
		// Without a `since`, a command wait counts from the keys just sent, else from now.
		const sinceSeq = given ?? (Date.now() - this._lastInputAt < 10_000 && this._inputSeq > 0 ? this._inputSeq : startSeq);
		// The text wait's own place for "what came after": the cursor given, else where the wait began.
		if (given === undefined) {
			this._layCheckpoint(startSeq);
		}
		const textSince = given ?? startSeq;
		let seenVersion = -1;
		let signature = '';
		let changedAt = started;
		let found = false;
		for (;;) {
			await this.settle();
			if (this._version !== seenVersion) {
				seenVersion = this._version;
				const now = this._signature();
				if (now !== signature) {
					signature = now;
					changedAt = Math.max(changedAt, Date.now());
				}
				if (o.until === 'text' && !found && o.text) {
					found = this._haystack(textSince).includes(o.text);
				}
			}
			const now = Date.now();
			let reason: ScreenWaitReason | undefined;
			let mark: Mark | undefined;
			if (o.signal?.aborted) {
				reason = 'aborted';
			} else if (o.until === 'text' && found) {
				reason = 'text';
			} else if (this._exited || this._disposed) {
				reason = 'exit';
			} else if (o.until === 'command' && this._integration !== 'none') {
				mark = [...this._marks].reverse().find(m => m.kind === 'D' && m.result && m.seq > sinceSeq);
				if (mark && now - this._lastOutputAt >= promptDrawMs) {
					reason = 'command';
				}
			} else if ((o.until === 'idle' || o.until === 'command') && now - changedAt >= quietMs) {
				// A `command` wait on a shell that reports nothing is an idle wait, and says so.
				reason = 'idle';
			}
			if (!reason && now >= deadline) {
				reason = 'timeout';
			}
			if (reason) {
				return this._waitResult(o, reason, mark);
			}
			await this._sleep(Math.max(1, Math.min(pollMs, deadline - now)), o.signal);
		}
	}

	private _waitResult(o: ScreenWaitOptions, reason: ScreenWaitReason, mark: Mark | undefined): ScreenWait {
		const read = this.readNow({ since: o.since, scrollback: o.scrollback, maxChars: o.maxChars });
		const result: ScreenWait = { ...read, reason };
		if (reason === 'command' && mark) {
			if (mark.exitCode !== undefined) {
				result.exitCode = mark.exitCode;
			}
			if (this._lastCommand && this._lastCommand.endSeq === mark.seq && this._lastCommand.output !== undefined) {
				result.output = this._lastCommand.output;
			}
		}
		if (reason === 'idle' && looksLikePrompt(read.viewport)) {
			result.maybeAwaitingInput = true;
		}
		return result;
	}
}

/** What `TerminalHost` builds for a new shell; the options are the PTY's size and folder. */
export function createScreenModel(o: ScreenModelOptions): ScreenModel {
	return new ScreenModel(o);
}
