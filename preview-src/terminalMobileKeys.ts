/*
 * The terminal's soft keys: which bytes a key of the key bar, the soft
 * keyboard's proxy input or a hardware keyboard on a phone sends to the shell.
 *
 * Pure on purpose (no DOM, no relative value imports, no enum or parameter
 * property: `npm test` runs it through Node's type stripping). Everything here
 * follows xterm's own encoding, which is what a shell and its programs expect:
 *
 *  - Arrows, Home and End are `ESC [ X` normally and `ESC O X` while the program
 *    set application cursor keys (DECCKM: vim, less, tmux, htop do). Modified,
 *    they are `ESC [ 1 ; m X` whatever the mode — as xterm does. The old key bar of
 *    this project always sent `ESC [ A` and so broke arrows in those programs.
 *  - The modifier parameter `m` is 1 + shift(1) + alt(2) + ctrl(4).
 *  - Alt is a prefix `ESC` (meta sends escape); Ctrl on a letter is the control
 *    character; modifiers on text hit its FIRST code point only.
 *
 * Every byte that leaves a touch device goes through `sendInput` in the view, so
 * the host's rules for `terminalInput` apply unchanged: nothing here is a new way
 * into the shell.
 */

/** `term.modes.applicationCursorKeysMode`. */
export interface KeyModes {
	readonly applicationCursorKeys: boolean;
}

export interface Modifiers {
	readonly ctrl: boolean;
	readonly alt: boolean;
	readonly shift: boolean;
}

export const noMods: Modifiers = { ctrl: false, alt: false, shift: false };

export type NamedKey =
	| 'Escape' | 'Tab' | 'Enter' | 'Backspace' | 'Delete' | 'Insert'
	| 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'
	| 'Home' | 'End' | 'PageUp' | 'PageDown'
	| 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6' | 'F7' | 'F8' | 'F9' | 'F10' | 'F11' | 'F12';

const ESC = '\x1b';

export function anyMod(m: Modifiers): boolean {
	return m.ctrl || m.alt || m.shift;
}

/** xterm's modifier parameter: 1 + shift(1) + alt(2) + ctrl(4). */
export function modParam(m: Modifiers): number {
	return 1 + (m.shift ? 1 : 0) + (m.alt ? 2 : 0) + (m.ctrl ? 4 : 0);
}

const cursorFinal: Partial<Record<NamedKey, string>> = {
	ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F',
};
const tildeNumber: Partial<Record<NamedKey, number>> = {
	Insert: 2, Delete: 3, PageUp: 5, PageDown: 6,
	F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24,
};
const ss3Final: Partial<Record<NamedKey, string>> = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S' };

/** The bytes of a named key with `m` held, in the cursor-key mode `modes` says. */
export function namedKeySequence(key: NamedKey, m: Modifiers, modes: KeyModes): string {
	const param = modParam(m);
	const modified = param > 1;
	const cursor = cursorFinal[key];
	if (cursor) {
		if (modified) { return `${ESC}[1;${param}${cursor}`; }
		return `${ESC}${modes.applicationCursorKeys ? 'O' : '['}${cursor}`;
	}
	const tilde = tildeNumber[key];
	if (tilde !== undefined) { return modified ? `${ESC}[${tilde};${param}~` : `${ESC}[${tilde}~`; }
	const ss3 = ss3Final[key];
	if (ss3) { return modified ? `${ESC}[1;${param}${ss3}` : `${ESC}O${ss3}`; }
	switch (key) {
		case 'Tab':
			// Shift+Tab is ESC [ Z (Claude Code uses it); Alt adds the escape prefix.
			if (m.shift) { return m.alt ? `${ESC}${ESC}[Z` : `${ESC}[Z`; }
			return m.alt ? `${ESC}\t` : '\t';
		case 'Enter':
			return m.alt ? `${ESC}\r` : '\r';
		case 'Backspace': {
			const byte = m.ctrl ? '\x08' : '\x7f';
			return m.alt ? `${ESC}${byte}` : byte;
		}
		case 'Escape':
			return m.alt ? `${ESC}${ESC}` : ESC;
		default:
			return '';
	}
}

/** The control character for `ch` (xterm's table), or undefined when Ctrl does nothing to it. */
export function ctrlChar(ch: string): string | undefined {
	if (ch.length !== 1) { return undefined; }
	if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) { return String.fromCharCode(ch.charCodeAt(0) & 0x1f); }
	switch (ch) {
		case ' ': case '@': case '2': return '\x00';
		case '[': case '3': return '\x1b';
		case '\\': case '4': return '\x1c';
		case ']': case '5': return '\x1d';
		case '^': case '6': return '\x1e';
		case '_': case '/': case '-': case '7': return '\x1f';
		case '?': case '8': return '\x7f';
		default: return undefined;
	}
}

function firstCodePoint(text: string): { readonly head: string; readonly rest: string } {
	const cp = text.codePointAt(0);
	if (cp === undefined) { return { head: '', rest: '' }; }
	const head = String.fromCodePoint(cp);
	return { head, rest: text.slice(head.length) };
}

/** `text` with `m` held. The modifiers apply to the first code point; the rest passes unchanged (an IME word, a paste). */
export function textSequence(text: string, m: Modifiers): string {
	const { head, rest } = firstCodePoint(text);
	if (!head) { return ''; }
	if (!anyMod(m)) { return text; }
	let out = m.shift && head.length === 1 && head >= 'a' && head <= 'z' ? head.toUpperCase() : head;
	if (m.ctrl) { out = ctrlChar(out) ?? out; }
	if (m.alt) { out = ESC + out; }
	return out + rest;
}

const cursorData = /^\x1b(?:\[(?:1;(\d+))?|O)([ABCDHF])$/;
const ss3Data = /^\x1b(?:\[1;(\d+)|O)([PQRS])$/;
// Only the numbers of keys: ESC [ 200 ~ and ESC [ 201 ~ are the bracketed-paste markers, not a key.
const tildeData = /^\x1b\[(2|3|5|6|15|17|18|19|20|21|23|24)(?:;(\d+))?~$/;

/** Adds `m` to a parameter xterm already put in a sequence (a hardware key held with a sticky one). */
function mergedParam(existing: string | undefined, m: Modifiers): number {
	const bits = existing ? Number(existing) - 1 : 0;
	return 1 + (bits | (modParam(m) - 1));
}

/**
 * The data xterm's `onData` produced, with `m` applied: how a sticky Ctrl or Alt
 * reaches a program from xterm's own textarea. Escape sequences of keys get the
 * modifier parameter; text gets `textSequence`; any other escape sequence (a
 * bracketed paste marker, a mouse report) is left alone.
 */
export function sequenceWithMods(data: string, m: Modifiers): string {
	if (!data || !anyMod(m)) { return data; }
	let match = cursorData.exec(data);
	if (match) { return `${ESC}[1;${mergedParam(match[1], m)}${match[2]}`; }
	match = ss3Data.exec(data);
	if (match) { return `${ESC}[1;${mergedParam(match[1], m)}${match[2]}`; }
	match = tildeData.exec(data);
	if (match) { return `${ESC}[${match[1]};${mergedParam(match[2], m)}~`; }
	if (data === '\t') { return namedKeySequence('Tab', m, { applicationCursorKeys: false }); }
	if (data === '\r') { return namedKeySequence('Enter', m, { applicationCursorKeys: false }); }
	if (data === '\x7f') { return namedKeySequence('Backspace', m, { applicationCursorKeys: false }); }
	if (data === ESC) { return namedKeySequence('Escape', m, { applicationCursorKeys: false }); }
	if (data.charCodeAt(0) === 0x1b) { return data; }
	return textSequence(data, m);
}

/** A keydown as the key bar's proxy input sees it. */
export interface HardKeyEvent {
	readonly key: string;
	readonly ctrlKey: boolean;
	readonly altKey: boolean;
	readonly shiftKey: boolean;
	readonly metaKey: boolean;
	readonly isComposing?: boolean;
	readonly keyCode?: number;
}

const namedKeys: ReadonlySet<string> = new Set<NamedKey>([
	'Escape', 'Tab', 'Enter', 'Backspace', 'Delete', 'Insert',
	'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
	'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

export function isNamedKey(key: string): key is NamedKey {
	return namedKeys.has(key);
}

/**
 * The bytes for a keydown on the proxy textarea (a hardware keyboard on a phone
 * or tablet), or undefined: let the `input` event deal with it. Undefined for a
 * composing input method, for ⌘ chords, and for a plain printable character with
 * no Ctrl or Alt held (the text arrives as an `input` event).
 */
export function keyEventSequence(e: HardKeyEvent, modes: KeyModes, sticky: Modifiers = noMods): string | undefined {
	if (e.isComposing || e.keyCode === 229) { return undefined; }
	if (e.metaKey) { return undefined; }
	if (isNamedKey(e.key)) {
		return namedKeySequence(e.key, { ctrl: e.ctrlKey || sticky.ctrl, alt: e.altKey || sticky.alt, shift: e.shiftKey || sticky.shift }, modes);
	}
	const point = firstCodePoint(e.key);
	if (!point.head || point.rest) { return undefined; }
	const ctrl = e.ctrlKey || sticky.ctrl;
	const alt = e.altKey || sticky.alt;
	// AltGr arrives as Ctrl+Alt and types a character: the input event has it.
	if (e.ctrlKey && e.altKey && !/^[a-z]$/i.test(e.key)) { return undefined; }
	// The event's own shift is already in `key`; only a sticky one still has to be applied.
	const shift = sticky.shift;
	if (!ctrl && !alt && !shift) { return undefined; }
	return textSequence(e.key, { ctrl, alt, shift });
}

/** What the proxy textarea keeps in its value, so Backspace on an empty box still produces an event. */
export const PROXY_SENTINEL = ' ';

// C0 except tab and carriage return; DEL; C1. Line breaks have been turned into \r by then.
const proxyControls = /[\u0000-\u0008\u000a-\u000c\u000e-\u001f\u007f-\u009f]/g;

/**
 * The bytes for an `input` event on the proxy textarea, whose value is kept at
 * one space (`PROXY_SENTINEL`) with the caret behind it. A leading sentinel is
 * not text; an emptied value or a backward delete is Backspace, a forward delete
 * is Delete, a line break is Enter. Control characters other than tab and Enter
 * are dropped: a keyboard's text is text, and an ESC here would be a way to
 * type a sequence the user never pressed.
 */
export function proxyInput(value: string, inputType?: string): string {
	switch (inputType) {
		case 'deleteContentBackward': return '\x7f';
		case 'deleteContentForward': return `${ESC}[3~`;
		case 'deleteWordBackward': return '\x17';
		case 'deleteSoftLineBackward': case 'deleteHardLineBackward': return '\x15';
		case 'insertLineBreak': case 'insertParagraph': return '\r';
		default: break;
	}
	if (value === '') { return '\x7f'; }
	const text = value.startsWith(PROXY_SENTINEL) ? value.slice(PROXY_SENTINEL.length) : value;
	return text.replace(/\r\n|\n/g, '\r').replace(proxyControls, '');
}

/* ------------------------------------------------------------------ sticky modifiers */

export type ModifierName = 'ctrl' | 'alt' | 'shift';
export type StickyState = 'off' | 'armed' | 'locked';

/** A second tap inside this many milliseconds locks a modifier. */
export const lockWithinMs = 400;

/**
 * Ctrl, Alt and Shift as a touch keyboard has them: tap once and the next byte
 * sent carries it (armed), tap twice quickly and it stays until tapped again
 * (locked). The clock is passed in, so it is testable.
 */
export class StickyModifiers {
	private readonly _state: Record<ModifierName, StickyState> = { ctrl: 'off', alt: 'off', shift: 'off' };
	private readonly _tapped: Record<ModifierName, number> = { ctrl: -Infinity, alt: -Infinity, shift: -Infinity };

	tap(name: ModifierName, now: number): StickyState {
		const current = this._state[name];
		if (current === 'locked') {
			this._state[name] = 'off';
		} else if (current === 'armed') {
			this._state[name] = now - this._tapped[name] <= lockWithinMs ? 'locked' : 'off';
		} else {
			this._state[name] = 'armed';
		}
		this._tapped[name] = now;
		return this._state[name];
	}

	state(name: ModifierName): StickyState {
		return this._state[name];
	}

	/** What is held right now, armed or locked. */
	snapshot(): Modifiers {
		return { ctrl: this._state.ctrl !== 'off', alt: this._state.alt !== 'off', shift: this._state.shift !== 'off' };
	}

	/** The modifiers for the byte about to be sent: armed ones are used up, locked ones stay. */
	consume(): Modifiers {
		const used = this.snapshot();
		for (const name of ['ctrl', 'alt', 'shift'] as const) {
			if (this._state[name] === 'armed') { this._state[name] = 'off'; }
		}
		return used;
	}

	/** Everything off: a terminal switch, an exit, a blur. */
	clear(): void {
		for (const name of ['ctrl', 'alt', 'shift'] as const) { this._state[name] = 'off'; }
	}

	get active(): boolean {
		return this._state.ctrl !== 'off' || this._state.alt !== 'off' || this._state.shift !== 'off';
	}
}

/* ------------------------------------------------------------------ key repeat */

export interface RepeatTimers {
	readonly set: (fn: () => void, ms: number) => unknown;
	readonly clear: (handle: unknown) => void;
}

export const repeatDelayMs = 380;
export const repeatIntervalMs = 70;
export const repeatFastIntervalMs = 35;
/** After this many repeats the interval drops to `repeatFastIntervalMs`. */
export const repeatFastAfter = 12;

/** Holding a key: once at once, again after `repeatDelayMs`, then every `repeatIntervalMs`, faster after a while. */
export class KeyRepeat {
	private _handle: unknown;
	private _running = false;
	private _count = 0;
	private readonly _timers: RepeatTimers;

	constructor(timers: RepeatTimers) {
		this._timers = timers;
	}

	start(fn: () => void): void {
		this.stop();
		this._running = true;
		this._count = 0;
		fn();
		const step = (delay: number): void => {
			this._handle = this._timers.set(() => {
				if (!this._running) { return; }
				fn();
				this._count++;
				step(this._count >= repeatFastAfter ? repeatFastIntervalMs : repeatIntervalMs);
			}, delay);
		};
		step(repeatDelayMs);
	}

	/** Idempotent; nothing fires after it. */
	stop(): void {
		this._running = false;
		if (this._handle !== undefined) {
			this._timers.clear(this._handle);
			this._handle = undefined;
		}
	}

	get running(): boolean {
		return this._running;
	}
}

/* ------------------------------------------------------------------ the layout, as data */

export type KeyAction = 'keyboard' | 'more' | 'paste' | 'selectAll' | 'bottom' | 'hideBar';

export type KeyDef =
	/** A named key: modified by the sticky modifiers, DECCKM-aware. */
	| { readonly kind: 'named'; readonly label: string; readonly aria: string; readonly key: NamedKey; readonly repeat?: true }
	/** Text: the sticky modifiers apply to it. */
	| { readonly kind: 'text'; readonly label: string; readonly aria: string; readonly text: string }
	/** Fixed bytes (a control character): the sticky modifiers are not applied to it. */
	| { readonly kind: 'data'; readonly label: string; readonly aria: string; readonly data: string }
	| { readonly kind: 'mod'; readonly label: string; readonly aria: string; readonly mod: ModifierName }
	| { readonly kind: 'action'; readonly label: string; readonly aria: string; readonly action: KeyAction };

const named = (label: string, aria: string, key: NamedKey, repeat?: true): KeyDef => ({ kind: 'named', label, aria, key, repeat });
const text = (label: string, aria: string, value: string = label): KeyDef => ({ kind: 'text', label, aria, text: value });
const control = (letter: string): KeyDef => ({ kind: 'data', label: `^${letter}`, aria: `Control ${letter}`, data: ctrlChar(letter) ?? '' });

/** The two rows that are always shown (eight equal columns). */
export const KEY_ROWS: readonly (readonly KeyDef[])[] = [
	[
		named('Esc', 'Escape', 'Escape'),
		named('Tab', 'Tab', 'Tab'),
		{ kind: 'mod', label: 'Ctrl', aria: 'Control, sticky', mod: 'ctrl' },
		{ kind: 'mod', label: 'Alt', aria: 'Alt, sticky', mod: 'alt' },
		{ kind: 'mod', label: 'Shift', aria: 'Shift, sticky', mod: 'shift' },
		named('Home', 'Home', 'Home'),
		named('↑', 'Arrow up', 'ArrowUp', true),
		named('End', 'End', 'End'),
	],
	[
		{ kind: 'action', label: '⌨', aria: 'Show or hide the keyboard', action: 'keyboard' },
		text('/', 'Slash'),
		text('-', 'Hyphen'),
		text('|', 'Vertical bar'),
		named('←', 'Arrow left', 'ArrowLeft', true),
		named('↓', 'Arrow down', 'ArrowDown', true),
		named('→', 'Arrow right', 'ArrowRight', true),
		{ kind: 'action', label: '⋯', aria: 'More keys', action: 'more' },
	],
];

/** What the "more" button opens: paging, the symbols a soft keyboard hides, control characters and the bar's own actions. */
export const DRAWER_ROWS: readonly (readonly KeyDef[])[] = [
	[
		named('PgUp', 'Page up', 'PageUp', true),
		named('PgDn', 'Page down', 'PageDown', true),
		named('Del', 'Delete', 'Delete', true),
		named('⏎', 'Enter', 'Enter'),
		{ kind: 'data', label: '⇧Tab', aria: 'Shift Tab', data: namedKeySequence('Tab', { ctrl: false, alt: false, shift: true }, { applicationCursorKeys: false }) },
		text('~', 'Tilde'),
		text('_', 'Underscore'),
		text('\\', 'Backslash'),
	],
	[
		text('`', 'Backtick'),
		text(':', 'Colon'),
		text('$', 'Dollar'),
		text('&', 'Ampersand'),
		{ kind: 'action', label: 'Paste', aria: 'Paste', action: 'paste' },
		{ kind: 'action', label: 'All', aria: 'Select all', action: 'selectAll' },
		{ kind: 'action', label: '⤓', aria: 'Scroll to the bottom', action: 'bottom' },
		{ kind: 'action', label: 'Hide', aria: 'Hide the key bar', action: 'hideBar' },
	],
	['C', 'D', 'Z', 'L', 'R', 'A', 'E', 'W'].map(control),
	['U', 'O', 'K', 'B', 'F', 'X', 'N', 'P'].map(control),
];

/** The letters offered on the strip above the bar while Ctrl is armed or locked. */
export const CTRL_LETTERS: readonly string[] = ['A', 'C', 'D', 'E', 'K', 'L', 'O', 'R', 'U', 'W', 'Z'];

/** The bytes a key definition sends with `m` held; undefined for a mod or an action, which send nothing themselves. */
export function keyDefSequence(def: KeyDef, m: Modifiers, modes: KeyModes): string | undefined {
	switch (def.kind) {
		case 'named': return namedKeySequence(def.key, m, modes);
		case 'text': return textSequence(def.text, m);
		case 'data': return def.data;
		default: return undefined;
	}
}
