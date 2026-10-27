/*
 * The terminal tabs of the chat view: xterm.js in the chat's own webview.
 *
 * The host owns the shells (a pty per terminal, on the editor's machine) and the
 * list of terminals; this draws them. Only the editor's build contains this
 * file (`__TERMINAL__`, see `chat.ts`), and it is loaded the first time the
 * state names a terminal.
 *
 * What was measured, and why the code is the way it is:
 *
 *  - The Content-Security-Policy blocks xterm's inline styles; `terminalCsp.ts`
 *    fixes that from outside, before the first terminal is made.
 *  - `FitAddon` reads the host's computed size and returns silently at zero, so a
 *    terminal is opened (`open()`) only once its host is shown with a size, one
 *    `ResizeObserver` watches it, and the PTY is told only when columns or rows
 *    really change. Every host stays `visibility: hidden` rather than
 *    `display: none`, so a hidden terminal keeps its size and its scrollback.
 *  - xterm cancels every key it turns into shell input, so the workbench never
 *    sees them: `terminalKeys.ts` lists the chords that must pass through, and
 *    copy and paste go through the host (`copy`, `terminalPasteRequest`), with the
 *    event stopped so the workbench does not run its own as well.
 *  - Output arrives as `terminalData` posted straight to the webview, numbered and
 *    acknowledged as xterm parses it (`terminalFlow.ts`); a replay on attach
 *    restores a screen the page lost.
 *
 * The layout is a column: the stage the hosts
 * lie in (`.terminal-host` is absolutely positioned inside it, so FitAddon fits to
 * what the toolbar and the key bar leave), and the touch key bar
 * (`terminalKeyBar.ts`, only on a touch device or when forced), then the toolbar (`terminalToolbar.ts`) at the very bottom. Every byte that
 * leaves goes through `sendInput`, however it was typed.
 */

import { Terminal, type ILink } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { HostToView, TerminalSettings, TerminalTabSummary, ViewToHost } from '../src/chat/chatProtocol';
import { installTerminalCsp } from './terminalCsp';
import { terminalKeyAction, terminalPlatform } from './terminalKeys';
import { terminalOptions, terminalTheme } from './terminalTheme';
import { AckBatcher, AckLedger, EarlyOutput, OutputSequencer, ackSize } from './terminalFlow';
import { sanitizePaste, splitInput, terminalPasteLimit } from './terminalPaste';
import { lastOutput, type ScreenRow } from './terminalTabs';
import { createKeyBar, readStored, writeStored } from './terminalKeyBar';
import { createToolbar } from './terminalToolbar';
import { createTouchUi } from './terminalTouchUi';
import { findLinks, rangeCoversRow, spanToRange } from './terminalLinks';
import { fontSizeStorageKey, parseFontPref } from './terminalTouch';

export interface TerminalViewOptions {
	readonly app: HTMLElement;
	/** The terminals' container is put right after this element (the chat's main column). */
	readonly after: HTMLElement;
	readonly post: (message: ViewToHost) => void;
	/** The nonce of the script that started this page: `document.currentScript.nonce`, captured while it runs. */
	readonly nonce: string | undefined;
	/** False while something else holds the keyboard on purpose (a tab being renamed): focus is then not taken. */
	readonly canFocus: () => boolean;
	/** "Ask agent": the chat's menu anchored on `anchor`, with the selected text. Absent: the toolbar has no such button. */
	readonly askAgent?: (anchor: HTMLElement, id: string, selection: string) => void;
	/** "Insert": the chat's attachment menu, each choice inserted into this terminal (`terminalInsert`). Absent: no button. */
	readonly insertMenu?: (anchor: HTMLElement, id: string) => void;
	readonly openBrowser?: (anchor: HTMLElement) => void;
	/** A link printed in the terminal was clicked: the built-in browser, or the system's with `external` (⌘ / Ctrl-click). Absent: no links. */
	readonly openLink?: (url: string, external: boolean) => void;
	/** Whether a message may be sent from this surface (the control table). Absent: all. */
	readonly gate?: (type: ViewToHost['type']) => boolean;
	/** The page's surface when it is not the editor (the soft keyboard is then tracked). */
	readonly surface?: () => string | undefined;
	/** Whether the surface lets the user type into a terminal; the key bar and the soft keyboard follow it. Absent: yes. */
	readonly canInput?: () => boolean;
	/** A remote surface: the control lease of each terminal (the website's Watch / Take control). Absent: the editor, always in control. */
	readonly lease?: {
		holder(id: string): 'editor' | 'you' | 'other' | undefined;
		toggle(id: string): void;
		onChange(listener: () => void): void;
	};
}

export interface TerminalView {
	/** The state's terminals and the one in front, drawn. Cheap; called on every state. */
	sync(terminals: readonly TerminalTabSummary[] | undefined, front: string | undefined): void;
	handle(message: HostToView): void;
	/** Whether a node is inside the terminals: the page's own key and focus handlers leave those alone. */
	contains(node: EventTarget | null): boolean;
	/** Focuses the terminal in front; false when none is. */
	focusFront(): boolean;
	hasSelection(id: string): boolean;
	/** The selection, or the last lines of the screen, sent to the conversation in front. */
	sendToChat(id: string): void;
}

/** The last lines of the screen "send last output to the chat" takes. */
const lastLineCount = 60;

interface Entry {
	readonly id: string;
	readonly term: Terminal;
	readonly fit: FitAddon;
	readonly host: HTMLElement;
	readonly exitBar: HTMLElement;
	readonly exitText: HTMLElement;
	readonly acks: AckBatcher;
	/** Which acknowledgements the host can still use: only output that came after the latest replay. */
	readonly ledger: AckLedger;
	readonly sequencer: OutputSequencer;
	readonly observer: ResizeObserver;
	summary: TerminalTabSummary;
	/** The status the last state reported: only a change in it is taken from a state (see `sync`). */
	reported: TerminalTabSummary['status'];
	status: TerminalTabSummary['status'];
	exitCode?: number;
	opened: boolean;
	/** `terminalAttach` has been sent for this xterm. */
	attached: boolean;
	sent?: { readonly cols: number; readonly rows: number };
	/** Something has been written to xterm since it was last cleared. */
	written: boolean;
	layoutFrame?: number;
	focusWhenShown: boolean;
	/** The focus was asked for (a new terminal, a click on its tab), not merely a switch to it: on a touch device only then may the soft keyboard open. */
	focusExplicit: boolean;
	/** The trailing timer of a debounced `terminalResize` (touch devices: the soft keyboard animates the size). */
	resizeTimer?: ReturnType<typeof setTimeout>;
	readonly detachTouch: () => void;
	readonly links?: { dispose(): void };
}

/** A soft keyboard resizes the stage on every frame of its animation: the PTY is told once, this long after the last one. */
const resizeDebounceMs = 150;

export function createTerminalView(options: TerminalViewOptions): TerminalView {
	const { app, post } = options;
	const platform = terminalPlatform(navigator.platform, navigator.userAgent);
	const main = document.createElement('div');
	main.className = 'terminal-main';
	options.after.after(main);
	// The hosts lie over this, not over the whole column: the toolbar above it and the key bar under it keep their own height.
	const stage = document.createElement('div');
	stage.className = 'terminal-stage';

	const entries = new Map<string, Entry>();
	const early = new EarlyOutput();
	let settings: TerminalSettings = {};
	let front: string | undefined;
	let cspInstalled = false;

	/* ------------------------------------------------------------ settings and theme */

	const readVariable = (name: string): string => getComputedStyle(document.body).getPropertyValue(name);

	const coarse = window.matchMedia('(pointer: coarse)');

	function currentOptions() {
		const size = parseFloat(readVariable('--vscode-editor-font-size'));
		const o = terminalOptions(settings, { family: readVariable('--vscode-editor-font-family'), size: Number.isFinite(size) ? size : undefined });
		// A pinch's size is the device's own, kept per device and only where a finger is the pointer.
		const stored = coarse.matches ? parseFontPref(readStored(fontSizeStorageKey)) : undefined;
		return stored ? { ...o, fontSize: stored } : o;
	}

	function applyTheme(): void {
		const theme = terminalTheme(readVariable);
		if (theme.background) { main.style.setProperty('--terminal-background', theme.background); }
		for (const entry of entries.values()) { entry.term.options.theme = theme; }
	}

	function applyOptions(): void {
		const o = currentOptions();
		for (const entry of entries.values()) {
			const term = entry.term;
			term.options.fontFamily = o.fontFamily;
			term.options.fontSize = o.fontSize;
			term.options.lineHeight = o.lineHeight;
			term.options.letterSpacing = o.letterSpacing;
			term.options.cursorStyle = o.cursorStyle;
			term.options.cursorBlink = o.cursorBlink;
			term.options.scrollback = o.scrollback;
			term.options.macOptionIsMeta = o.macOptionIsMeta;
			scheduleLayout(entry);
		}
	}

	// The editor's colour theme changes by rewriting the body's class and style.
	let themeTimer: ReturnType<typeof setTimeout> | undefined;
	new MutationObserver(() => {
		clearTimeout(themeTimer);
		themeTimer = setTimeout(applyTheme, 100);
	}).observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });

	/* ------------------------------------------------------------ layout */

	function shown(entry: Entry): boolean {
		return front === entry.id && app.classList.contains('terminal-front');
	}

	function scheduleLayout(entry: Entry): void {
		if (entry.layoutFrame !== undefined) { return; }
		entry.layoutFrame = requestAnimationFrame(() => {
			entry.layoutFrame = undefined;
			layout(entry);
		});
	}

	/** Opens xterm once its host has a size, fits it, and tells the pty when the size changed. */
	function layout(entry: Entry): void {
		if (!shown(entry) || entry.host.clientWidth === 0 || entry.host.clientHeight === 0) { return; }
		if (!entry.opened) {
			entry.opened = true;
			entry.term.open(entry.host);
			// A touch device types into the key bar's input, not into xterm's own textarea.
			bar.prepare(entry.term);
		}
		try {
			entry.fit.fit();
		} catch {
			return;
		}
		const { cols, rows } = entry.term;
		if (!entry.attached) {
			entry.attached = true;
			entry.sent = { cols, rows };
			// The host releases everything it counted when it takes this: no acknowledgement of earlier output.
			entry.ledger.awaitReplay();
			post({ type: 'terminalAttach', id: entry.id, cols, rows });
		} else if (!entry.sent || entry.sent.cols !== cols || entry.sent.rows !== rows) {
			requestResize(entry);
		}
		if (entry.focusWhenShown) {
			entry.focusWhenShown = false;
			const explicit = entry.focusExplicit;
			entry.focusExplicit = false;
			focusTerminal(entry, explicit);
		}
	}

	/** The pty hears about a new size at once on a desktop, and once the soft keyboard has stopped moving the stage on a touch device. */
	function requestResize(entry: Entry): void {
		if (!bar.touch) { postResize(entry); return; }
		clearTimeout(entry.resizeTimer);
		entry.resizeTimer = setTimeout(() => { entry.resizeTimer = undefined; postResize(entry); }, resizeDebounceMs);
	}

	function postResize(entry: Entry): void {
		const { cols, rows } = entry.term;
		if (!entry.attached || (entry.sent && entry.sent.cols === cols && entry.sent.rows === rows)) { return; }
		entry.sent = { cols, rows };
		post({ type: 'terminalResize', id: entry.id, cols, rows });
	}

	/**
	 * Gives a terminal the keyboard. On a touch device only a focus that was asked for
	 * (`explicit`: a new terminal, a tap) goes to the key bar's input and may open the
	 * soft keyboard; merely switching to a terminal tab must not pop it up, so xterm's
	 * own textarea (read-only, no soft keyboard) takes the focus there.
	 */
	function focusTerminal(entry: Entry, explicit: boolean): void {
		if (!options.canFocus()) { return; }
		if (bar.touch && explicit && bar.focusInput()) { return; }
		entry.term.focus();
	}

	document.addEventListener('visibilitychange', () => {
		// A hidden webview throttles painting: draw the screen again when it is shown.
		const entry = front ? entries.get(front) : undefined;
		if (!document.hidden && entry?.opened && shown(entry)) {
			scheduleLayout(entry);
			entry.term.refresh(0, entry.term.rows - 1);
		}
	});

	/* ------------------------------------------------------------ keys, copy and paste */

	function selectionRows(term: Terminal): ScreenRow[] {
		const buffer = term.buffer.active;
		const rows: ScreenRow[] = [];
		for (let i = Math.max(0, buffer.length - 4 * lastLineCount); i < buffer.length; i++) {
			const line = buffer.getLine(i);
			if (line) { rows.push({ text: line.translateToString(true), wrapped: line.isWrapped }); }
		}
		return rows;
	}

	function sendToChat(id: string): void {
		const entry = entries.get(id);
		if (!entry) { return; }
		const text = entry.term.hasSelection() ? entry.term.getSelection() : lastOutput(selectionRows(entry.term), lastLineCount);
		if (text.trim()) { post({ type: 'terminalToChat', id, text }); }
	}

	function keyHandler(entry: Entry): (event: KeyboardEvent) => boolean {
		return event => {
			const action = terminalKeyAction(event, platform, entry.term.hasSelection());
			switch (action.kind) {
				case 'xterm':
					return true;
				case 'passthrough':
					return false;
				default: {
					// Ours: stopped, so xterm does not type it and the workbench does not act on it too.
					event.preventDefault();
					event.stopPropagation();
					if (event.type !== 'keydown') { return false; }
					if (action.kind === 'copy') {
						const text = entry.term.getSelection();
						if (text) { post({ type: 'copy', text }); }
					} else if (action.kind === 'paste') {
						post({ type: 'terminalPasteRequest', id: entry.id });
					} else if (action.kind === 'selectAll') {
						entry.term.selectAll();
					} else if (action.kind === 'send') {
						post({ type: 'terminalInput', id: entry.id, data: action.data });
					}
					return false;
				}
			}
		};
	}

	/* ------------------------------------------------------------ entries */

	/**
	 * `counted`: the chunks are live `terminalData` the host counted, and are
	 * acknowledged when xterm has parsed them, which is what holds the shell back
	 * when xterm falls behind. The replay, and anything held or dropped against it
	 * or posted before the attach, was released host-side and is not (`AckLedger`).
	 */
	function writeChunks(entry: Entry, chunks: readonly string[], dropped: number, counted: boolean): void {
		const token = entry.ledger.token();
		for (const chunk of chunks) {
			entry.written = true;
			entry.term.write(chunk, counted ? () => entry.ledger.credit(token, ackSize(chunk)) : undefined);
		}
		if (counted && dropped) { entry.ledger.credit(token, dropped); }
	}

	let pasting = false;

	/** Terminal input as the host takes it: in order, in slices it will not refuse. */
	function sendInput(id: string, data: string): void {
		for (const slice of splitInput(data)) { post({ type: 'terminalInput', id, data: slice }); }
	}

	/** A paste, as data: no control character reaches the shell, so no bracketed-paste end marker either. */
	function pasteInto(entry: Entry, text: string): void {
		const clean = sanitizePaste(text);
		if (!clean) { return; }
		// `paste` raises `onData` itself, and a sticky Ctrl must not be applied to a paste.
		pasting = true;
		try { entry.term.paste(clean); } finally { pasting = false; }
	}

	/* ------------------------------------------------------------ links */

	/** The most rows of one wrapped line searched for a link around the row the pointer is on. */
	const maxLinkRows = 20;

	/**
	 * http and https addresses in the logical line (wrapped rows joined) that holds buffer row `y`
	 * (1-based), as xterm's links. A plain click opens the built-in browser; ⌘ (Ctrl elsewhere)
	 * the system's. The cells of each character are counted one by one: a double-width
	 * character is one character and two cells.
	 */
	function linksAt(term: Terminal, y: number): ILink[] | undefined {
		const open = options.openLink;
		if (!open) { return undefined; }
		const buffer = term.buffer.active;
		let first = y - 1;
		while (first > 0 && buffer.getLine(first)?.isWrapped) { first--; }
		const cols = term.cols;
		let text = '';
		const cells: number[] = [];
		for (let row = first; row < buffer.length && row - first < maxLinkRows; row++) {
			const line = buffer.getLine(row);
			if (!line || (row > first && !line.isWrapped)) { break; }
			for (let x = 0; x < cols; x++) {
				const cell = line.getCell(x);
				if (!cell || cell.getWidth() === 0) { continue; }
				const chars = cell.getChars() || ' ';
				for (let i = 0; i < chars.length; i++) { cells.push((row - first) * cols + x); }
				text += chars;
			}
		}
		const links: ILink[] = [];
		for (const span of findLinks(text)) {
			const range = spanToRange(span, cells, cols, first + 1);
			if (!range || !rangeCoversRow(range, y)) { continue; }
			links.push({
				range,
				text: span.url,
				activate: (event: MouseEvent) => open(span.url, platform === 'mac' ? event.metaKey : event.ctrlKey),
			});
		}
		return links.length ? links : undefined;
	}

	/* ------------------------------------------------------------ inserting files */

	const allowed = (type: ViewToHost['type']): boolean => options.gate?.(type) ?? true;
	/** The host's own limit for one file (`pastedFileLimit`, written twice). */
	const insertFileLimit = 64 * 1024 * 1024;

	function filesOf(data: DataTransfer | null | undefined): File[] {
		return data ? [...data.files].filter(file => file.size > 0) : [];
	}

	/** Each file read here and posted as base64: the host writes it to its private folder and inserts the path. */
	function insertFiles(id: string, files: readonly File[]): void {
		if (!allowed('terminalInsert')) { return; }
		for (const file of files) {
			if (file.size > insertFileLimit) { continue; }
			const reader = new FileReader();
			reader.onload = () => {
				const url = typeof reader.result === 'string' ? reader.result : '';
				const comma = url.indexOf(',');
				if (comma < 0) { return; }
				post({ type: 'terminalInsert', id, kind: 'file', file: { name: file.name || 'file', data: url.slice(comma + 1) } });
			};
			reader.readAsDataURL(file);
		}
	}

	/* ------------------------------------------------------------ the toolbar, the key bar and touch */

	const toolbar = createToolbar({
		post,
		askAgent: options.askAgent,
		insertMenu: options.insertMenu,
		openBrowser: options.openBrowser,
		sendToChat,
		selection: id => entries.get(id)?.term.getSelection() ?? '',
		clear: id => { entries.get(id)?.term.clear(); },
		scrollToBottom: id => { entries.get(id)?.term.scrollToBottom(); },
		lease: options.lease,
		gate: options.gate,
	});

	const bar = createKeyBar({
		main,
		stage,
		send: sendInput,
		pasteText: (id, text) => { const entry = entries.get(id); if (entry) { pasteInto(entry, text); } },
		requestPaste: id => post({ type: 'terminalPasteRequest', id }),
		copy: text => post({ type: 'copy', text }),
		surface: options.surface,
		// A remote watcher has no keys: the bar and the soft keyboard come with the lease.
		canInput: () => (options.canInput?.() ?? true) && (!options.lease || (front !== undefined && options.lease.holder(front) === 'you')),
		localClipboard: () => options.surface?.() !== undefined,
	});
	options.lease?.onChange(() => {
		toolbar.update(front ? entries.get(front)?.summary : undefined);
		bar.refresh();
	});

	const touchUi = createTouchUi({
		stage,
		touch: () => bar.touch,
		keys: sendInput,
		copy: text => post({ type: 'copy', text }),
		paste: id => post({ type: 'terminalPasteRequest', id }),
		sendToChat: options.gate?.('terminalToChat') ?? true ? sendToChat : undefined,
		fontSize: (size, final) => {
			for (const entry of entries.values()) { entry.term.options.fontSize = size; scheduleLayout(entry); }
			if (final) { writeStored(fontSizeStorageKey, String(size)); }
		},
		onTap: id => { const entry = entries.get(id); if (entry) { focusTerminal(entry, true); } },
	});

	main.append(stage, bar.el, toolbar.el);

	function create(summary: TerminalTabSummary): Entry {
		// Before the first xterm exists: its styles are made when it is opened.
		if (!cspInstalled) {
			cspInstalled = true;
			installTerminalCsp(options.nonce);
		}
		const o = currentOptions();
		const term = new Terminal({
			...o,
			theme: terminalTheme(readVariable),
			allowTransparency: false,
			allowProposedApi: false,
			// ConPTY reflows its own screen; xterm must not reflow it a second time.
			windowsPty: platform === 'win' ? { backend: 'conpty' } : undefined,
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		// A program must not be able to write the clipboard.
		term.parser.registerOscHandler(52, () => true);

		const host = document.createElement('div');
		host.className = 'terminal-host';
		host.dataset.terminal = summary.id;
		const exitText = document.createElement('span');
		exitText.className = 'terminal-exit-text';
		const restart = document.createElement('button');
		restart.className = 'terminal-exit-restart';
		restart.textContent = 'Restart';
		const exitBar = document.createElement('div');
		exitBar.className = 'terminal-exit';
		exitBar.append(exitText, restart);
		restart.addEventListener('click', () => post({ type: 'restartTerminal', id: summary.id }));
		stage.append(host, exitBar);

		const acks = new AckBatcher(bytes => post({ type: 'terminalAck', id: summary.id, bytes }));
		const detachTouch = touchUi.attach({ id: summary.id, term, host });
		const entry: Entry = {
			id: summary.id, term, fit, host, exitBar, exitText,
			acks,
			ledger: new AckLedger(acks),
			sequencer: new OutputSequencer(),
			observer: new ResizeObserver(() => scheduleLayout(entry)),
			summary, reported: summary.status, status: summary.status, exitCode: summary.exitCode,
			opened: false, attached: false, written: false, focusWhenShown: false, focusExplicit: false,
			detachTouch,
			links: options.openLink ? term.registerLinkProvider({ provideLinks: (y, callback) => callback(linksAt(term, y)) }) : undefined,
		};
		entry.observer.observe(host);
		// A sticky Ctrl or Alt of the key bar applies to what xterm's own textarea typed as well (a hardware keyboard on a tablet).
		term.onData(data => sendInput(summary.id, pasting ? data : bar.applySticky(data)));
		// xterm's own paste event (context menu, middle click, the browser's paste): through the same
		// sanitizer as the host-mediated paste. Captured on the host element, so it runs before xterm's
		// listener on its textarea, which is then never reached.
		host.addEventListener('paste', event => {
			event.preventDefault();
			event.stopPropagation();
			// Files (an image copied from a screenshot tool): saved by the host, their path inserted.
			const files = filesOf(event.clipboardData);
			if (files.length) { insertFiles(summary.id, files); return; }
			const text = event.clipboardData?.getData('text/plain') ?? '';
			// The host's own limit (`terminalPasteLimit`, written twice): a larger paste is not taken.
			if (text && text.length <= terminalPasteLimit) { pasteInto(entry, text); }
		}, true);
		// Files dropped on the terminal: the same, one path each.
		host.addEventListener('dragover', event => {
			if (event.dataTransfer?.types.includes('Files') && allowed('terminalInsert')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }
		});
		host.addEventListener('drop', event => {
			const files = filesOf(event.dataTransfer);
			if (!files.length) { return; }
			event.preventDefault();
			event.stopPropagation();
			insertFiles(summary.id, files);
		});
		term.attachCustomKeyEventHandler(keyHandler(entry));
		entries.set(summary.id, entry);
		// What arrived before the state that names this terminal waits for the replay with the rest.
		for (const chunk of early.take(summary.id)) {
			const result = entry.sequencer.push(chunk.seq, chunk.data);
			writeChunks(entry, result.write, result.dropped, false);
		}
		applyTheme();
		renderExit(entry);
		return entry;
	}

	function dispose(entry: Entry): void {
		entries.delete(entry.id);
		clearTimeout(entry.resizeTimer);
		entry.detachTouch();
		entry.links?.dispose();
		bar.forget(entry.term);
		if (entry.layoutFrame !== undefined) { cancelAnimationFrame(entry.layoutFrame); }
		entry.observer.disconnect();
		entry.acks.dispose();
		entry.term.dispose();
		entry.host.remove();
		entry.exitBar.remove();
	}

	function renderExit(entry: Entry): void {
		const exited = entry.status === 'exited';
		entry.exitBar.classList.toggle('show', exited && front === entry.id);
		if (exited) {
			entry.exitText.textContent = entry.exitCode === undefined ? 'The process ended.' : `The process ended with code ${entry.exitCode}.`;
		}
	}

	/** A shell restarted in the same tab: a clean screen, and the host's replay of the new one. */
	function restarted(entry: Entry): void {
		entry.term.reset();
		entry.written = false;
		// The shell started again: the host zeroed what it counted. Nothing before its replay is acknowledged.
		entry.ledger.awaitReplay();
		const result = entry.sequencer.reset();
		writeChunks(entry, result.write, result.dropped, false);
		clearTimeout(entry.resizeTimer);
		if (entry.opened) {
			entry.attached = false;
			entry.sent = undefined;
			scheduleLayout(entry);
		}
	}

	/* ------------------------------------------------------------ the view's interface */

	return {
		sync(terminals, frontId) {
			const list = terminals ?? [];
			const known = new Set(list.map(t => t.id));
			for (const entry of [...entries.values()]) {
				if (!known.has(entry.id)) { dispose(entry); }
			}
			early.keepOnly(known);
			const previous = front;
			front = frontId && known.has(frontId) ? frontId : undefined;
			for (const summary of list) {
				const entry = entries.get(summary.id) ?? create(summary);
				entry.summary = summary;
				// Only a change in what the state reports counts: a state built a moment before
				// the shell ended must not bring a terminal back to running.
				if (summary.status !== entry.reported) {
					entry.reported = summary.status;
					const before = entry.status;
					entry.status = summary.status;
					entry.exitCode = summary.exitCode;
					if (before === 'exited' && summary.status === 'running') { restarted(entry); }
				} else if (summary.status === 'exited' && entry.exitCode === undefined) {
					entry.exitCode = summary.exitCode;
				}
				renderExit(entry);
				entry.host.classList.toggle('front', front === entry.id);
			}
			app.classList.toggle('terminal-front', front !== undefined);
			const frontEntry = front ? entries.get(front) : undefined;
			bar.setFront(frontEntry ? { id: frontEntry.id, term: frontEntry.term } : undefined);
			touchUi.setFront(front);
			toolbar.update(frontEntry?.summary);
			if (front !== previous && front) {
				const entry = entries.get(front)!;
				entry.focusWhenShown = true;
				entry.focusExplicit = false;
				scheduleLayout(entry);
				if (entry.opened) { requestAnimationFrame(() => entry.term.refresh(0, entry.term.rows - 1)); }
			}
		},

		handle(message) {
			switch (message.type) {
				case 'terminalData': {
					const entry = entries.get(message.id);
					if (!entry) {
						// Not acknowledged, whether kept or dropped: it predates this view's attach, which releases it host-side.
						early.push(message.id, message.seq, message.data);
						return;
					}
					// Output from a shell that had ended is a restarted one: its numbering starts again.
					if (entry.status === 'exited') {
						entry.status = 'running';
						entry.exitCode = undefined;
						restarted(entry);
						renderExit(entry);
					}
					const result = entry.sequencer.push(message.seq, message.data);
					writeChunks(entry, result.write, result.dropped, true);
					return;
				}
				case 'terminalReplay': {
					const entry = entries.get(message.id);
					if (!entry) { return; }
					// A second replay is a screen rebuilt from scratch.
					if (entry.written) { entry.term.reset(); entry.written = false; }
					// Output counted by the host starts after this: what came before is released, and the replay itself was never counted.
					entry.ledger.replayed();
					const result = entry.sequencer.replay(message.seq, message.data);
					writeChunks(entry, result.write, result.dropped, false);
					return;
				}
				case 'terminalExit': {
					const entry = entries.get(message.id);
					if (!entry) { return; }
					entry.status = 'exited';
					entry.exitCode = message.code;
					renderExit(entry);
					return;
				}
				case 'terminalSettings':
					settings = message.settings;
					applyOptions();
					return;
				case 'terminalPaste': {
					const entry = entries.get(message.id);
					if (entry && message.text) { pasteInto(entry, message.text); focusTerminal(entry, true); }
					return;
				}
				case 'terminalFocus': {
					const entry = entries.get(message.id);
					if (!entry) { return; }
					if (!options.canFocus()) { return; }
					if (shown(entry) && entry.opened) {
						focusTerminal(entry, true);
					} else {
						entry.focusWhenShown = true;
						entry.focusExplicit = true;
						scheduleLayout(entry);
					}
					return;
				}
			}
		},

		contains(node) {
			return node instanceof Node && main.contains(node);
		},

		focusFront() {
			const entry = front ? entries.get(front) : undefined;
			if (!entry) { return false; }
			if (!options.canFocus()) { return true; }
			if (entry.opened) { focusTerminal(entry, true); } else { entry.focusWhenShown = true; entry.focusExplicit = true; scheduleLayout(entry); }
			return true;
		},

		hasSelection(id) {
			return entries.get(id)?.term.hasSelection() ?? false;
		},

		sendToChat,
	};
}
