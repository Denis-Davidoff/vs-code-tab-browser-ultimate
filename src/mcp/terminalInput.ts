/**
 * What an agent may type into a terminal, as pure rules: the named keys and the
 * bytes they send, which text is a single typeable line, and the fingerprint of
 * an input that the approval grant (`terminalGrants.ts`) is matched on.
 *
 * A leaf with no imports, under test, because it is read by both sides of an
 * approval: `terminalTools.ts` validates the call with it, and the chat mints
 * the grant from the CLI's own copy of the arguments with it. The two must
 * normalise a call to the same string, or an approved input is refused (or,
 * worse, a different one allowed) — which is why there is one function and not
 * a copy in each.
 *
 * **Arrow keys are the CSI forms (`ESC [ A`), never `ESC O A`.** Whether a
 * terminal is in application cursor-key mode (DECCKM) is known to the view's
 * xterm and not to the host, and the screen model does not report it. Shells,
 * readline, vim and less accept the CSI form in both modes; a program that
 * reads only the SS3 form while in application mode is rare enough that the
 * tool says so rather than guessing.
 */

/** The named keys of `terminal_key`, in the order the refusal lists them. */
export const terminalKeyNames: readonly string[] = [
	'enter', 'esc', 'tab', 'shift-tab', 'backspace', 'delete', 'space',
	'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
	...Array.from({ length: 26 }, (_, i) => `ctrl-${String.fromCharCode(97 + i)}`),
	...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
];

const fixedBytes: Readonly<Record<string, string>> = {
	'enter': '\r',
	'esc': '\x1b',
	'tab': '\t',
	'shift-tab': '\x1b[Z',
	'backspace': '\x7f',
	'delete': '\x1b[3~',
	'space': ' ',
	'up': '\x1b[A',
	'down': '\x1b[B',
	'right': '\x1b[C',
	'left': '\x1b[D',
	'home': '\x1b[H',
	'end': '\x1b[F',
	'pageup': '\x1b[5~',
	'pagedown': '\x1b[6~',
	'f1': '\x1bOP', 'f2': '\x1bOQ', 'f3': '\x1bOR', 'f4': '\x1bOS',
	'f5': '\x1b[15~', 'f6': '\x1b[17~', 'f7': '\x1b[18~', 'f8': '\x1b[19~',
	'f9': '\x1b[20~', 'f10': '\x1b[21~', 'f11': '\x1b[23~', 'f12': '\x1b[24~',
};

const aliases: Readonly<Record<string, string>> = {
	escape: 'esc', return: 'enter', cr: 'enter', del: 'delete', bksp: 'backspace',
	pgup: 'pageup', 'page-up': 'pageup', pgdn: 'pagedown', 'page-down': 'pagedown', pgdown: 'pagedown',
	'shift+tab': 'shift-tab', 'shift_tab': 'shift-tab', backtab: 'shift-tab',
	arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
};

/** Most keys one `terminal_key` call may press. */
export const terminalMaxKeys = 32;
/** Longest line `terminal_send` types. */
export const terminalMaxText = 4000;

/** The canonical name of a key as a model may spell it, or `undefined` when it is none we send. */
export function normalizeKeyName(raw: string): string | undefined {
	const name = raw.trim().toLowerCase();
	if (Object.hasOwn(fixedBytes, name)) {
		return name;
	}
	if (Object.hasOwn(aliases, name)) {
		return aliases[name];
	}
	const ctrl = /^(?:ctrl|control)[-+_ ]?([a-z])$/.exec(name) ?? /^\^([a-z])$/.exec(name);
	return ctrl ? `ctrl-${ctrl[1]}` : undefined;
}

/** The bytes of one canonical key name: `ctrl-c` is 0x03. */
export function keyBytes(canonical: string): string | undefined {
	if (Object.hasOwn(fixedBytes, canonical)) {
		return fixedBytes[canonical];
	}
	const ctrl = /^ctrl-([a-z])$/.exec(canonical);
	return ctrl ? String.fromCharCode(ctrl[1].charCodeAt(0) - 96) : undefined;
}

export type KeyPlan =
	| { readonly ok: true; readonly names: readonly string[]; readonly bytes: string }
	| { readonly ok: false; readonly error: string };

/** A model's `keys` argument as the canonical names and the bytes they send, or the refusal it reads. */
export function planKeys(keys: unknown): KeyPlan {
	if (!Array.isArray(keys) || keys.length === 0) {
		return { ok: false, error: '`keys` must be a non-empty array of key names, for example ["up", "enter"].' };
	}
	if (keys.length > terminalMaxKeys) {
		return { ok: false, error: `At most ${terminalMaxKeys} keys per call; send the rest in another call.` };
	}
	const names: string[] = [];
	for (const key of keys) {
		const name = typeof key === 'string' ? normalizeKeyName(key) : undefined;
		if (!name) {
			const shown = typeof key === 'string' ? JSON.stringify(key.length > 40 ? `${key.slice(0, 40)}…` : key) : typeof key;
			return { ok: false, error: `Unknown key ${shown}. Named keys: ${terminalKeyNames.join(', ')}. Type text with terminal_send.` };
		}
		names.push(name);
	}
	return { ok: true, names, bytes: names.map(n => keyBytes(n)!).join('') };
}

const badCharacters = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]');

/**
 * Why `text` cannot be typed by `terminal_send`, or `undefined` when it can.
 *
 * One line only, and no control character: what the approval card shows must be
 * exactly what the shell receives. A line break would run a second command the
 * card did not make a line of its own, ESC could carry a bracketed-paste end
 * marker, and the C1 range holds the 8-bit CSI. The bidirectional overrides are
 * refused too — they reorder what a card shows without changing what is typed.
 */
export function typedTextProblem(text: string): string | undefined {
	if (text.length > terminalMaxText) {
		return `The text is longer than ${terminalMaxText} characters; type it in parts.`;
	}
	const bad = badCharacters.exec(text);
	if (bad) {
		const code = bad[0].charCodeAt(0);
		const line = code === 10 || code === 13;
		return `The text holds a control character (U+${code.toString(16).toUpperCase().padStart(4, '0')})${line ? ': terminal_send types one line, so send each command in its own call' : ''}. Use terminal_key for Enter, Tab, Escape, arrows and Ctrl keys.`;
	}
	return undefined;
}

/** A text argument as the tool reads it: a string, or the number the model meant as text. */
function asText(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value;
	}
	return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}

/** The two tools that type, as `terminalInputTools` in `agentProtocol.ts` names them (written twice). */
export type TerminalInputTool = 'terminal_send' | 'terminal_key';

/**
 * The string an approved input is matched on: the terminal, and exactly what
 * would be typed — the text and whether Enter follows, or the canonical keys.
 * `undefined` for arguments that are not a valid call, which are refused by the
 * tool before any grant is looked at. Extra arguments (how long to wait for the
 * result) are not part of what is approved.
 */
export function terminalInputFingerprint(tool: TerminalInputTool, args: unknown): string | undefined {
	if (typeof args !== 'object' || args === null || Array.isArray(args)) {
		return undefined;
	}
	const given = args as Record<string, unknown>;
	const id = typeof given.terminalId === 'string' ? given.terminalId.trim() : '';
	if (!id) {
		return undefined;
	}
	if (tool === 'terminal_send') {
		const text = given.text === undefined ? '' : asText(given.text);
		const enter = given.enter === undefined ? true : given.enter;
		if (text === undefined || typeof enter !== 'boolean') {
			return undefined;
		}
		return JSON.stringify([id, text, enter]);
	}
	const plan = planKeys(given.keys);
	return plan.ok ? JSON.stringify([id, plan.names]) : undefined;
}

/** The slice of `TerminalGrants` the minting needs; structural, so this leaf imports nothing. */
export interface GrantStore {
	mint(chatId: string, tool: string, fingerprint?: string): void;
}

/**
 * Mints the grant for an approved terminal input (`ApprovalRequest.terminal`):
 * exact when the CLI's arguments were read, a wildcard when it gave none, none
 * for arguments that are not a valid call or for a tool that only looks.
 * Returns whether one was minted.
 */
export function mintTerminalGrant(grants: GrantStore, chatId: string, approval: { readonly tool: string; readonly args?: unknown; readonly read?: boolean }): boolean {
	if (approval.read || (approval.tool !== 'terminal_send' && approval.tool !== 'terminal_key')) {
		return false;
	}
	if (approval.args === undefined) {
		grants.mint(chatId, approval.tool);
		return true;
	}
	const fingerprint = terminalInputFingerprint(approval.tool, approval.args);
	if (fingerprint === undefined) {
		return false;
	}
	grants.mint(chatId, approval.tool, fingerprint);
	return true;
}
