/*
 * The terminal's key bar for touch devices, and the soft keyboard behind it.
 *
 * A phone has no Esc, Ctrl, Tab or arrows, and the keys a shell program needs
 * most are exactly those. This draws a bar of them under the terminal (sticky
 * Ctrl, Alt and Shift, arrows that repeat while held, a drawer of paging keys,
 * symbols and control characters) and owns the one input a soft keyboard types
 * into. The byte rules are in `terminalMobileKeys.ts` and the geometry and
 * preferences in `terminalTouch.ts`; both are under `npm test`. This file is the
 * DOM half and is checked in headless Chrome with touch emulation.
 *
 * What it is, and why:
 *
 *  - One funnel. Every byte — a bar key, the proxy textarea, a hardware
 *    keyboard, xterm's own textarea — goes through the sticky modifiers and then
 *    `send`, which is the view's `sendInput` (`splitInput` slices, one
 *    `terminalInput` message each). The bar adds no message type, so the host's
 *    rules for terminal input hold unchanged.
 *  - On a touch device xterm's own textarea is made read-only with no soft
 *    keyboard (`inputMode: none`), so a tap on the screen never opens it by
 *    itself, and a textarea of ours takes the soft keyboard's input instead. It
 *    keeps one space as its value, so Backspace on an empty box still produces
 *    an event (`proxyInput`). It is never `display: none` or `visibility:
 *    hidden`, which cannot be focused; it is 1px, transparent, 16px font (a
 *    smaller one makes iOS zoom on focus).
 *  - The bar's buttons take the pointer without taking the focus, so the
 *    keyboard does not close under a tap.
 *  - Nothing is written through the `style` attribute (the page's CSP blocks
 *    it): classes, `hidden` and CSSOM `style.setProperty`.
 *  - Per-device preferences are `localStorage`, always in try/catch: the bar
 *    and the keyboard are the phone's, while the website's settings belong to
 *    the editor's machine.
 */

import type { Terminal } from '@xterm/xterm';
import {
	CTRL_LETTERS, DRAWER_ROWS, KEY_ROWS, PROXY_SENTINEL, KeyRepeat, StickyModifiers, keyDefSequence, keyEventSequence, noMods, proxyInput, sequenceWithMods, textSequence,
	type KeyDef, type KeyModes, type ModifierName,
} from './terminalMobileKeys';
import { keyBarStorageKey, keyBarVisible, keyboardStorageKey, parseKeyBarPref, parseKeyboardPref, visibleFrame, type KeyBarPref } from './terminalTouch';
import { terminalPasteLimit } from './terminalPaste';

export interface KeyBarTarget {
	readonly id: string;
	readonly term: Terminal;
}

export interface KeyBarOptions {
	readonly main: HTMLElement;
	readonly stage: HTMLElement;
	/** The view's `sendInput`: in order, in slices the host will not refuse. */
	readonly send: (id: string, data: string) => void;
	/** The view's `pasteInto`: sanitised, and through bracketed paste where the program asked for it. */
	readonly pasteText: (id: string, text: string) => void;
	/** The host reads the editor machine's clipboard (`terminalPasteRequest`). */
	readonly requestPaste: (id: string) => void;
	/** The system clipboard through the host (`copy`). */
	readonly copy: (text: string) => void;
	/** The page's surface when it is not the editor: only then the soft keyboard has to be tracked. */
	readonly surface?: () => string | undefined;
	readonly canInput?: () => boolean;
	/** Whether the paste key may read the viewer's own clipboard (not the editor's). */
	readonly localClipboard?: () => boolean;
}

export interface KeyBar {
	readonly el: HTMLElement;
	/** The primary pointer is a finger. */
	readonly touch: boolean;
	setFront(target: KeyBarTarget | undefined): void;
	/** A terminal's own textarea, once it is open: read-only with no soft keyboard on a touch device. */
	prepare(term: Terminal): void;
	forget(term: Terminal): void;
	/** `data` from xterm's `onData` with the sticky modifiers applied (and used up). */
	applySticky(data: string): string;
	keyboardWanted(): boolean;
	/** Focuses the proxy; false where there is none (not a touch device). */
	focusInput(): boolean;
	/** Recomputes whether the bar shows: what `canInput` answers may have changed. */
	refresh(): void;
	/** The bar is on screen. */
	readonly visible: boolean;
	dispose(): void;
}

export function readStored(key: string): string | null {
	try { return localStorage.getItem(key); } catch { return null; }
}

export function writeStored(key: string, value: string): void {
	try { localStorage.setItem(key, value); } catch { /* the preference is lost, nothing else */ }
}

const modsOf = (term: Terminal): KeyModes => ({ applicationCursorKeys: term.modes.applicationCursorKeysMode });

function icon(name: string): HTMLElement {
	const span = document.createElement('span');
	span.className = `codicon codicon-${name}`;
	span.setAttribute('aria-hidden', 'true');
	return span;
}

export function createKeyBar(options: KeyBarOptions): KeyBar {
	const { main, stage } = options;
	const coarseQuery = window.matchMedia('(pointer: coarse)');
	const sticky = new StickyModifiers();
	const repeat = new KeyRepeat({ set: (fn, ms) => setTimeout(fn, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) });
	const prepared = new Set<Terminal>();
	let front: KeyBarTarget | undefined;
	let pref: KeyBarPref = parseKeyBarPref(readStored(keyBarStorageKey));
	let keyboardOn = parseKeyboardPref(readStored(keyboardStorageKey));
	let drawerOpen = false;
	let composing = false;
	let visible = false;
	let disposed = false;

	/* ------------------------------------------------------------ the bar */

	const el = document.createElement('div');
	el.className = 'terminal-keybar';
	el.setAttribute('role', 'toolbar');
	el.setAttribute('aria-label', 'Terminal keys');

	const live = document.createElement('span');
	live.className = 'terminal-sr';
	live.setAttribute('role', 'status');
	live.setAttribute('aria-live', 'polite');

	const strip = document.createElement('div');
	strip.className = 'terminal-ctrl-strip';
	strip.hidden = true;
	const stripLabel = document.createElement('span');
	stripLabel.className = 'terminal-ctrl-label';
	stripLabel.textContent = 'Ctrl +';
	strip.append(stripLabel);

	const grid = document.createElement('div');
	grid.className = 'terminal-keygrid';
	const drawer = document.createElement('div');
	drawer.className = 'terminal-keygrid terminal-drawer';
	drawer.hidden = true;
	el.append(strip, grid, drawer, live);

	const buttons = new Map<KeyDef, HTMLButtonElement>();
	const modButtons = new Map<ModifierName, HTMLButtonElement>();

	function modesNow(): KeyModes {
		return front ? modsOf(front.term) : { applicationCursorKeys: false };
	}

	function afterKey(): void {
		refreshModifiers();
		// A tap on the bar must not take the soft keyboard away.
		if (keyboardOn && touch()) { focusInput(); }
	}

	function send(data: string): void {
		if (front && data) { options.send(front.id, data); }
	}

	function press(def: KeyDef): void {
		if (!front) { return; }
		switch (def.kind) {
			case 'mod':
				sticky.tap(def.mod, Date.now());
				announce(def.mod);
				break;
			case 'named': case 'text': case 'data': {
				const mods = sticky.consume();
				send(keyDefSequence(def, def.kind === 'data' ? noMods : mods, modesNow()) ?? '');
				break;
			}
			case 'action':
				action(def.action);
				break;
		}
		afterKey();
	}

	function action(name: Extract<KeyDef, { kind: 'action' }>['action']): void {
		if (!front) { return; }
		switch (name) {
			case 'more':
				drawerOpen = !drawerOpen;
				drawer.hidden = !drawerOpen;
				buttons.forEach((button, def) => { if (def.kind === 'action' && def.action === 'more') { button.setAttribute('aria-expanded', String(drawerOpen)); } });
				break;
			case 'keyboard':
				setKeyboard(!keyboardOn);
				break;
			case 'paste':
				if (options.localClipboard?.() && navigator.clipboard?.readText) {
					// Inside the tap: the browser asks (iOS shows its own Paste bubble) and a refusal falls back to the host.
					const id = front.id;
					navigator.clipboard.readText().then(text => { if (text && text.length <= terminalPasteLimit) { options.pasteText(id, text); } }, () => options.requestPaste(id));
				} else {
					options.requestPaste(front.id);
				}
				break;
			case 'selectAll':
				front.term.selectAll();
				break;
			case 'bottom':
				front.term.scrollToBottom();
				break;
			case 'hideBar':
				setPref(coarseQuery.matches ? 'off' : 'auto');
				break;
		}
	}

	function setKeyboard(on: boolean): void {
		keyboardOn = on;
		writeStored(keyboardStorageKey, on ? 'shown' : 'hidden');
		applyProxyMode();
		if (on && touch()) {
			// iOS applies a changed `inputMode` only to a focus that starts again.
			proxy?.blur();
			focusInput();
		}
	}

	function announce(name: ModifierName): void {
		const label = { ctrl: 'Control', alt: 'Alt', shift: 'Shift' }[name];
		const state = sticky.state(name);
		live.textContent = `${label} ${state === 'off' ? 'off' : state === 'armed' ? 'armed' : 'locked'}`;
	}

	function refreshModifiers(): void {
		for (const [name, button] of modButtons) {
			const state = sticky.state(name);
			button.setAttribute('aria-pressed', String(state !== 'off'));
			if (state === 'locked') { button.dataset.lock = ''; } else { delete button.dataset.lock; }
		}
		strip.hidden = sticky.state('ctrl') === 'off';
	}

	function makeKey(def: KeyDef): HTMLButtonElement {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'terminal-key';
		button.dataset.kind = def.kind;
		button.textContent = def.label;
		button.setAttribute('aria-label', def.aria);
		if (def.kind === 'mod') {
			button.setAttribute('aria-pressed', 'false');
			modButtons.set(def.mod, button);
		}
		if (def.kind === 'action' && def.action === 'more') { button.setAttribute('aria-expanded', 'false'); }
		if (def.kind === 'action' && def.action === 'keyboard') { button.classList.add('terminal-key-keyboard'); }
		// Neither the pointer nor the mouse takes the focus from the input: the soft keyboard stays up.
		button.addEventListener('pointerdown', event => { event.preventDefault(); });
		button.addEventListener('mousedown', event => { event.preventDefault(); });
		button.addEventListener('contextmenu', event => { event.preventDefault(); });
		if (def.kind === 'named' && def.repeat) {
			const stop = (): void => { repeat.stop(); button.classList.remove('held'); };
			button.addEventListener('pointerdown', event => {
				if (event.button !== 0) { return; }
				try { button.setPointerCapture(event.pointerId); } catch { /* a pointer that is already gone */ }
				button.classList.add('held');
				repeat.start(() => press(def));
			});
			for (const type of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur'] as const) { button.addEventListener(type, stop); }
			// A keyboard's Enter or Space is a click with no pointer: once. A pointer's click came after the repeat.
			button.addEventListener('click', event => { if (event.detail === 0) { press(def); } });
		} else {
			button.addEventListener('click', () => press(def));
		}
		buttons.set(def, button);
		return button;
	}

	for (const row of KEY_ROWS) { for (const def of row) { grid.append(makeKey(def)); } }
	for (const row of DRAWER_ROWS) { for (const def of row) { drawer.append(makeKey(def)); } }

	for (const letter of CTRL_LETTERS) {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'terminal-key terminal-ctrl-letter';
		button.textContent = letter;
		button.setAttribute('aria-label', `Control ${letter}`);
		button.addEventListener('pointerdown', event => { event.preventDefault(); });
		button.addEventListener('mousedown', event => { event.preventDefault(); });
		button.addEventListener('click', () => {
			if (!front) { return; }
			// Ctrl is armed or locked: one tap sends the control byte with no input method in between.
			send(textSequence(letter.toLowerCase(), sticky.consume()));
			afterKey();
		});
		strip.append(button);
	}

	/** The "show keys" chip: where the bar was hidden on a touch device, so it can come back. */
	const chip = document.createElement('button');
	chip.type = 'button';
	chip.className = 'terminal-keybar-chip';
	chip.hidden = true;
	chip.setAttribute('aria-label', 'Show the key bar');
	chip.append(icon('ellipsis'));
	chip.addEventListener('pointerdown', event => { event.preventDefault(); });
	chip.addEventListener('click', () => setPref('on'));
	stage.append(chip);

	/* ------------------------------------------------------------ the proxy input */

	let proxy: HTMLTextAreaElement | undefined;

	function touch(): boolean {
		return coarseQuery.matches;
	}

	function resetProxy(): void {
		if (!proxy) { return; }
		proxy.value = PROXY_SENTINEL;
		try { proxy.setSelectionRange(PROXY_SENTINEL.length, PROXY_SENTINEL.length); } catch { /* not focusable yet */ }
	}

	function applyProxyMode(): void {
		if (proxy) { proxy.inputMode = keyboardOn ? 'text' : 'none'; }
	}

	function typed(data: string): void {
		if (!front || !data) { return; }
		send(sticky.active ? sequenceWithMods(data, sticky.consume()) : data);
		refreshModifiers();
	}

	function ensureProxy(): HTMLTextAreaElement {
		if (proxy) { return proxy; }
		const area = document.createElement('textarea');
		area.className = 'terminal-kbd';
		area.rows = 1;
		area.setAttribute('aria-label', 'Terminal keyboard input');
		area.setAttribute('autocapitalize', 'none');
		area.setAttribute('autocorrect', 'off');
		area.setAttribute('autocomplete', 'off');
		area.setAttribute('enterkeyhint', 'enter');
		area.setAttribute('data-gramm', 'false');
		area.setAttribute('data-lpignore', 'true');
		area.spellcheck = false;
		proxy = area;
		applyProxyMode();
		resetProxy();
		area.addEventListener('compositionstart', () => { composing = true; });
		area.addEventListener('compositionend', () => {
			composing = false;
			typed(proxyInput(area.value));
			resetProxy();
		});
		area.addEventListener('input', event => {
			// An input method's word is sent when it is done, not letter by letter.
			if (composing || (event as InputEvent).isComposing) { return; }
			typed(proxyInput(area.value, (event as InputEvent).inputType));
			resetProxy();
		});
		area.addEventListener('keydown', event => {
			if (!front) { return; }
			// ⌘C / Ctrl+C with a selection copies it; everything else a hardware keyboard sends goes through `keyEventSequence`.
			if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'c' && front.term.hasSelection()) {
				event.preventDefault();
				options.copy(front.term.getSelection());
				return;
			}
			const bytes = keyEventSequence(event, modesNow(), sticky.snapshot());
			if (bytes === undefined) { return; }
			event.preventDefault();
			sticky.consume();
			send(bytes);
			refreshModifiers();
		});
		area.addEventListener('paste', event => {
			event.preventDefault();
			const text = event.clipboardData?.getData('text/plain') ?? '';
			if (front && text && text.length <= terminalPasteLimit) { options.pasteText(front.id, text); }
		});
		area.addEventListener('focus', () => {
			resetProxy();
			// iOS pans the page to show a focused field: put it back where the page lays itself over the visible frame.
			if (tracking) { window.scrollTo(0, 0); }
		});
		area.addEventListener('blur', event => {
			repeat.stop();
			const to = event.relatedTarget;
			if (!(to instanceof Node && el.contains(to))) { sticky.clear(); refreshModifiers(); }
		});
		stage.append(area);
		return area;
	}

	function focusInput(): boolean {
		if (!touch() || !front || !canFocusProxy()) { return false; }
		ensureProxy().focus({ preventScroll: true });
		return true;
	}

	/** The proxy is also the way in when the bar is hidden on a touch device: the soft keyboard still needs it. */
	function canFocusProxy(): boolean {
		return (options.canInput?.() ?? true) && front !== undefined;
	}

	function prepare(term: Terminal): void {
		prepared.add(term);
		applyXterm(term);
	}

	function applyXterm(term: Terminal): void {
		const area = term.textarea;
		if (!area) { return; }
		// A touch device types into the proxy; xterm's own textarea stays for a hardware keyboard and never opens the keyboard.
		area.readOnly = touch();
		area.inputMode = touch() ? 'none' : '';
	}

	/* ------------------------------------------------------------ the soft keyboard and the visible frame */

	let tracking = false;
	const viewport = window.visualViewport;

	function trackFrame(): void {
		if (!viewport) { return; }
		const frame = visibleFrame(viewport);
		const root = document.documentElement.style;
		root.setProperty('--vv-top', `${frame.top}px`);
		root.setProperty('--vv-left', `${frame.left}px`);
		root.setProperty('--vv-width', `${frame.width}px`);
		root.setProperty('--vv-height', `${frame.height}px`);
	}

	function setTracking(on: boolean): void {
		if (on === tracking || !viewport) { return; }
		tracking = on;
		const root = document.documentElement.style;
		if (on) {
			trackFrame();
			document.body.classList.add('vv-locked');
			viewport.addEventListener('resize', trackFrame);
			viewport.addEventListener('scroll', trackFrame);
		} else {
			viewport.removeEventListener('resize', trackFrame);
			viewport.removeEventListener('scroll', trackFrame);
			document.body.classList.remove('vv-locked');
			for (const name of ['--vv-top', '--vv-left', '--vv-width', '--vv-height']) { root.removeProperty(name); }
		}
	}

	/* ------------------------------------------------------------ visibility and preferences */

	function setPref(next: KeyBarPref): void {
		pref = next;
		writeStored(keyBarStorageKey, next);
		refresh();
	}

	function refresh(): void {
		if (disposed) { return; }
		const canInput = options.canInput?.() ?? true;
		const now = keyBarVisible(pref, touch(), canInput, front !== undefined);
		if (!now) {
			repeat.stop();
			sticky.clear();
			refreshModifiers();
		}
		visible = now;
		main.classList.toggle('has-keybar', now);
		chip.hidden = !(pref === 'off' && touch() && canInput && front !== undefined);
		// Where there is no soft keyboard the keyboard key does nothing: it keeps its place in the grid and goes quiet.
		for (const [def, button] of buttons) {
			if (def.kind === 'action' && def.action === 'keyboard') { button.classList.toggle('terminal-key-off', !touch()); button.setAttribute('aria-hidden', String(!touch())); button.tabIndex = touch() ? 0 : -1; }
		}
		if (!now) { drawerOpen = false; drawer.hidden = true; }
		setTracking(touch() && canInput && front !== undefined && options.surface?.() !== undefined);
		for (const term of prepared) { applyXterm(term); }
	}

	const onPointerChange = (): void => { refresh(); };
	coarseQuery.addEventListener('change', onPointerChange);

	refresh();

	return {
		el,
		get touch() { return touch(); },
		get visible() { return visible; },
		setFront(target) {
			if (front?.id !== target?.id) {
				repeat.stop();
				sticky.clear();
				refreshModifiers();
			}
			front = target;
			refresh();
		},
		prepare,
		forget(term) { prepared.delete(term); },
		applySticky(data) {
			if (!sticky.active || !data) { return data; }
			const out = sequenceWithMods(data, sticky.consume());
			refreshModifiers();
			return out;
		},
		keyboardWanted() { return keyboardOn; },
		focusInput,
		refresh,
		dispose() {
			disposed = true;
			repeat.stop();
			setTracking(false);
			coarseQuery.removeEventListener('change', onPointerChange);
			el.remove();
			chip.remove();
			proxy?.remove();
		},
	};
}
