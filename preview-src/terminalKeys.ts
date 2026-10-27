/*
 * Which keys of a focused terminal belong to the shell and which to the editor.
 *
 * VS Code forwards every key typed in a webview to the workbench, but xterm
 * cancels (stops) any key it turns into shell input, so a cancelled key never
 * reaches the workbench. The terminal therefore has to say, per key, whether
 * xterm may take it. This is VS Code's own `commandsToSkipShell` idea, cut down
 * to a short explicit list: every chord that passes through is a chord the shell
 * can no longer have.
 *
 * Pure on purpose — `terminalView.ts` only asks and acts — so the table is under
 * `npm test`. No DOM, no relative value imports.
 */

export type TerminalPlatform = 'mac' | 'win' | 'linux';

/** The `navigator.platform` of the webview, as one of the three the table knows. */
export function terminalPlatform(platform: string, userAgent = ''): TerminalPlatform {
	if (/mac|iphone|ipad/i.test(platform) || /mac os/i.test(userAgent)) { return 'mac'; }
	if (/win/i.test(platform) || /windows/i.test(userAgent)) { return 'win'; }
	return 'linux';
}

export interface TerminalKeyEvent {
	readonly type: string;
	readonly key: string;
	readonly ctrlKey: boolean;
	readonly metaKey: boolean;
	readonly altKey: boolean;
	readonly shiftKey: boolean;
	readonly isComposing?: boolean;
	readonly keyCode?: number;
}

/**
 * - `xterm`: xterm handles it (shell input, or nothing).
 * - `passthrough`: xterm leaves it alone and it bubbles to the workbench.
 * - `copy` / `paste` / `selectAll`: done by the view through the host, and the event is stopped so the workbench does not also run its own.
 * - `send`: this text goes to the shell instead of what xterm would send.
 */
export type TerminalKeyAction =
	| { readonly kind: 'xterm' | 'passthrough' | 'copy' | 'paste' | 'selectAll' }
	| { readonly kind: 'send'; readonly data: string };

const xterm: TerminalKeyAction = { kind: 'xterm' };
const passthrough: TerminalKeyAction = { kind: 'passthrough' };
const copy: TerminalKeyAction = { kind: 'copy' };
const paste: TerminalKeyAction = { kind: 'paste' };

/** What a key does in a terminal on `platform`; `hasSelection` is whether xterm has text selected. */
export function terminalKeyAction(e: TerminalKeyEvent, platform: TerminalPlatform, hasSelection: boolean): TerminalKeyAction {
	// An input method's candidate keys are its own.
	if (e.isComposing || e.keyCode === 229) { return xterm; }
	const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
	const { ctrlKey: ctrl, metaKey: meta, altKey: alt, shiftKey: shift } = e;

	// The command palette and the editor switcher, on every platform.
	if (key === 'F1' && !ctrl && !meta && !alt) { return passthrough; }
	if (ctrl && !meta && !alt && (key === 'Tab' || key === 'PageUp' || key === 'PageDown')) { return passthrough; }

	if (platform === 'mac') {
		if (meta && !ctrl && !alt) {
			if (!shift) {
				if (key === 'c') { return copy; }
				if (key === 'v') { return paste; }
				if (key === 'a') { return { kind: 'selectAll' }; }
				// The line editing VS Code's terminal gives ⌘ and ⌫.
				if (key === 'ArrowLeft') { return { kind: 'send', data: '\x01' }; }
				if (key === 'ArrowRight') { return { kind: 'send', data: '\x05' }; }
				if (key === 'Backspace') { return { kind: 'send', data: '\x15' }; }
			}
			// ⌘P, ⇧⌘P, ⌘T, ⌘W, ⌘K ...: the editor's.
			return passthrough;
		}
		// ⌥← and ⌥→ move by word in a shell; xterm would send a sequence readline does not know.
		if (alt && !ctrl && !meta && !shift) {
			if (key === 'ArrowLeft') { return { kind: 'send', data: '\x1bb' }; }
			if (key === 'ArrowRight') { return { kind: 'send', data: '\x1bf' }; }
		}
		return xterm;
	}

	// Windows and Linux. AltGr arrives as Ctrl+Alt: it types characters and is the shell's.
	if (alt) { return xterm; }
	if (ctrl && !meta) {
		if (shift) {
			if (key === 'c') { return copy; }
			if (key === 'v') { return paste; }
			// Ctrl+Shift+letter means nothing to a shell (a terminal sends the plain control
			// character), and the workbench binds many of them: the palette, the views, search.
			if (key.length === 1 && key >= 'a' && key <= 'z') { return passthrough; }
			return xterm;
		}
		if (key === 'v') { return paste; }
		if (key === 'c' && hasSelection) { return copy; }
		if (key === 'Insert') { return copy; }
		// Toggles the workbench's terminal panel.
		if (key === '`') { return passthrough; }
		return xterm;
	}
	if (shift && !ctrl && !meta && key === 'Insert') { return paste; }
	return xterm;
}
