/*
 * What goes from the terminal view to the shell as typed or pasted text.
 *
 * Two pure rules, both under `npm test`:
 *
 *  - A paste is data, never control: `sanitizePaste` removes every control
 *    character a terminal would act on, so a clipboard holding `ESC [ 2 0 1 ~`
 *    cannot end the shell's bracketed paste early and have the rest run as typed
 *    input. xterm only rewrites newlines and adds the markers itself.
 *  - One `terminalInput` message stays small: `splitInput` cuts what xterm
 *    emits (a paste is ONE `onData` event) into ordered slices, so a large paste
 *    is neither refused by the host's per-message limit nor posted as one
 *    message of megabytes.
 *
 * Written twice: the host's `terminalPaste` path (`chatView._pasteIntoTerminal`)
 * applies the same rule to the text it reads from the clipboard; the host and the
 * view are separate bundles and share no code. Keep the two in step.
 *
 * Nothing here has a parameter property or an enum: `npm test` runs this file
 * through Node's type stripping.
 */

/** The most one `terminalInput` message carries, in UTF-16 units. The host's own limit is 1 000 000. */
export const terminalInputSlice = 64 * 1024;

/** The largest paste the view takes from xterm's own `paste` event; the host's `terminalPasteLimit`, written twice. */
export const terminalPasteLimit = 4_000_000;

// C0 except tab, line feed and carriage return; DEL; and C1 (U+0080–U+009F, which includes the 8-bit CSI U+009B).
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/**
 * Text for `Terminal.paste`: no ESC (so no bracketed-paste marker, no escape
 * sequence of any kind) and no other control character but \t \r \n. Repeated
 * until stable: removing one character can never join two others into a control
 * today, but the loop keeps the result a fixed point of the rule whatever is
 * added to it later.
 */
export function sanitizePaste(text: string): string {
	let current = text;
	for (;;) {
		const next = current.replace(controls, '');
		if (next === current) { return next; }
		current = next;
	}
}

/**
 * `data` in order as slices of at most `max` units, never cutting a surrogate
 * pair: the host's JSON reader (serde, behind Codex) refuses a lone surrogate.
 * Concatenated, the slices are exactly `data`. Empty in, nothing out.
 */
export function splitInput(data: string, max: number = terminalInputSlice): string[] {
	const size = Math.max(2, Math.floor(max));
	const slices: string[] = [];
	let start = 0;
	while (start < data.length) {
		let end = Math.min(data.length, start + size);
		if (end < data.length) {
			const last = data.charCodeAt(end - 1);
			const next = data.charCodeAt(end);
			// Between the halves of a pair: take the pair into the next slice.
			if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) { end--; }
		}
		slices.push(data.slice(start, end));
		start = end;
	}
	return slices;
}
