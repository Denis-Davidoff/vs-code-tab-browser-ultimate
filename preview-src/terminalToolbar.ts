/*
 * The row above a terminal: its state (the name is the tab's), what the agent is doing in it,
 * and the few things done to the terminal as a whole.
 *
 * One toolbar for all terminals, acting on the one in front (`update`). It is
 * built once and only changed in place, never rebuilt on a state post: a press
 * that straddles a rebuild never produces its click (the chat's rule #365), and
 * states arrive every 40 ms while a reply streams.
 *
 *  - Ask agent: opens the chat's own menu (the view's `askAgent`) anchored on the
 *    button, with the selected text (a selection is what the user is asking about).
 *  - Send to chat: the selection, or the last lines, attached to a chat picked from a menu.
 *  - Watch only (a switch, right of the two): shown only while the terminal is pinned to a conversation;
 *    on, that conversation's agent may read the screen and not type. It re-pins with the other mode.
 *  - Clear and Scroll to bottom: local to this view.
 *  - Messages (icon only): shown by chat.ts while the terminal is docked to a conversation;
 *    it asks for the toggle with a bubbling `terminal-messages-toggle` event.
 *    (The agent mark and the Pause button were removed from here: Pause agent lives in the tab's menu.)
 *
 * The buttons keep the terminal's focus on a pointer press, so the keyboard stays
 * where it was. Narrow widths hide the labels (`container` query in `chat.css`).
 */

import type { TerminalTabSummary, ViewToHost } from '../src/chat/chatProtocol';

export interface ToolbarOptions {
	readonly post: (message: ViewToHost) => void;
	/** "Ask agent": the chat's menu, anchored on `anchor`, with the selected text. Absent: no button. */
	readonly askAgent?: (anchor: HTMLElement, id: string, selection: string) => void;
	/** "Insert": the chat's menu of things to put into this terminal's input (page, element, screenshot, file …). Absent: no button. */
	readonly insertMenu?: (anchor: HTMLElement, id: string) => void;
	readonly openBrowser?: (anchor: HTMLElement) => void;
	/** "Send to chat": `anchor` is the button, for the menu of conversations to choose from. */
	readonly sendToChat: (id: string, anchor?: HTMLElement) => void;
	readonly selection: (id: string) => string;
	readonly clear: (id: string) => void;
	readonly scrollToBottom: (id: string) => void;
	/** Whether a message may be sent from here (the control table of the surface). Default: all. */
	readonly gate?: (type: ViewToHost['type']) => boolean;
	/** A remote surface (the website): who may type, and the Watch / Take control toggle. Absent: no button. */
	readonly lease?: {
		holder(id: string): 'editor' | 'you' | 'other' | undefined;
		toggle(id: string): void;
	};
	/** Draws a button's tooltip from its `data-tip` (the chat's own `hoverTip`). Absent: a native `title`. */
	readonly tooltip?: (anchor: HTMLElement) => void;
}

/** The Watch only switch's tooltip: what it means for the agent of the conversation that holds the terminal. */
export function watchTip(on: boolean, owner?: string): string {
	const who = owner ? `«${owner}»'s agent` : 'The agent';
	return on ? `Watch only is on: ${who} reads this terminal and cannot type` : `Watch only is off: ${who} may type here (each input approved)`;
}

/** Where the terminal in front is scrolled: at its end, above it, or above it with output arrived since. */
export type ScrollState = 'bottom' | 'up' | 'new';

/** The Scroll to bottom button's tooltip for a scroll state. Exported for tests. */
export function scrollTip(state: ScrollState): string {
	if (state === 'new') { return 'Scroll to bottom — new output below'; }
	if (state === 'up') { return 'Scroll to bottom'; }
	return 'Already at the bottom';
}

/**
 * The next button for an arrow key in the toolbar (the ARIA toolbar pattern: one tab stop,
 * arrows move between the buttons, Home and End jump). Exported for tests.
 */
export function rovingIndex(key: string, index: number, count: number): number | undefined {
	if (count <= 0) { return undefined; }
	if (key === 'ArrowRight' || key === 'ArrowDown') { return (index + 1) % count; }
	if (key === 'ArrowLeft' || key === 'ArrowUp') { return (index - 1 + count) % count; }
	if (key === 'Home') { return 0; }
	if (key === 'End') { return count - 1; }
	return undefined;
}

/** The lease button's label and tooltip. Exported for tests. */
export function leaseText(holder: 'editor' | 'you' | 'other' | undefined): { label: string; title: string; pressed: boolean } {
	if (holder === 'you') { return { label: 'In control', title: 'You are typing into this terminal. Click to go back to watching.', pressed: true }; }
	if (holder === 'other') { return { label: 'Take control', title: 'Another viewer is typing. Take control to type here instead.', pressed: false }; }
	return { label: 'Take control', title: 'You are watching. Take control to type into this terminal.', pressed: false };
}

export interface Toolbar {
	readonly el: HTMLElement;
	/** The terminal in front, or undefined for none. Cheap: only what changed is written. */
	update(summary: TerminalTabSummary | undefined): void;
	/** Where the terminal in front is scrolled: Scroll to bottom is quiet at the end and lit with new output above it. */
	setScroll(state: ScrollState): void;
}

function codicon(name: string): HTMLElement {
	const span = document.createElement('span');
	span.className = `codicon codicon-${name}`;
	span.setAttribute('aria-hidden', 'true');
	return span;
}

/** What the mark says about the pin, in words. Exported for tests. */
export function agentMarkText(summary: Pick<TerminalTabSummary, 'pinnedBy' | 'agentControl' | 'agentActive' | 'pinMode'>): string {
	const pin = summary.pinnedBy;
	if (!pin) { return ''; }
	const title = pin.title.trim() || 'a conversation';
	if (summary.pinMode === 'watch') { return `Agent watching · ${title}`; }
	if (summary.agentControl === 'paused') { return `Agent paused · ${title}`; }
	return summary.agentActive ? `Agent typing · ${title}` : `Agent · ${title}`;
}

export function createToolbar(options: ToolbarOptions): Toolbar {
	const allowed = (type: ViewToHost['type']): boolean => options.gate?.(type) ?? true;
	let current: TerminalTabSummary | undefined;

	const el = document.createElement('div');
	el.className = 'terminal-toolbar';
	el.setAttribute('role', 'toolbar');
	el.setAttribute('aria-label', 'Terminal');

	const status = document.createElement('span');
	status.className = 'terminal-toolbar-status';
	status.setAttribute('role', 'status');
	status.hidden = true;
	const statusText = document.createElement('span');
	status.append(codicon('debug-stop'), statusText);

	const spacer = document.createElement('span');
	spacer.className = 'terminal-toolbar-spacer';

	/** The tooltip: drawn (`data-tip`, and an empty `title` so the row's folder does not show under it) or native. */
	function setTip(node: HTMLElement, text: string): void {
		if (options.tooltip) {
			if (node.dataset.tip !== text) { node.dataset.tip = text; }
			if (node.title !== '') { node.title = ''; }
		} else if (node.title !== text) {
			node.title = text;
		}
	}

	function button(iconName: string, label: string, onClick: (button: HTMLButtonElement) => void): HTMLButtonElement {
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'terminal-tool';
		const text = document.createElement('span');
		text.className = 'terminal-tool-label';
		text.textContent = label;
		b.append(codicon(iconName), text);
		b.setAttribute('aria-label', label);
		setTip(b, label);
		if (options.tooltip) { options.tooltip(b); }
		b.tabIndex = -1;
		// The terminal keeps its focus (and the soft keyboard stays up) under a pointer press.
		b.addEventListener('pointerdown', event => { event.preventDefault(); });
		b.addEventListener('mousedown', event => { event.preventDefault(); });
		b.addEventListener('click', () => onClick(b));
		return b;
	}

	// Show / hide the conversation's messages above the input; chat.ts owns the state and listens for the event.
	const messages = button('comment', 'Show messages', () => { el.dispatchEvent(new CustomEvent('terminal-messages-toggle', { bubbles: true })); });
	messages.classList.add('terminal-tool-messages');
	messages.hidden = true;
	const ask = button('sparkle', 'Ask agent', anchor => {
		if (current && options.askAgent) { options.askAgent(anchor, current.id, options.selection(current.id)); }
	});
	ask.classList.add('terminal-tool-ask');
	const browser = button('globe', 'Browser', anchor => { options.openBrowser?.(anchor); });
	const insert = button('add', 'Insert', anchor => { if (current && options.insertMenu) { options.insertMenu(anchor, current.id); } });
	insert.classList.add('terminal-tool-insert');
	setTip(insert, 'Insert a page, element, screenshot, file or selection into the input — not sent');
	setTip(ask, 'Ask an agent about this terminal (the selection, if any, goes with it)');
	setTip(browser, 'Open a browser page');
	const toChat = button('comment-discussion', 'Send to chat', anchor => { if (current) { options.sendToChat(current.id, anchor); } });
	setTip(toChat, 'Send the selection, or the last lines, to a chat you choose');
	// A switch, not a button: it says a state. Shown only while a conversation holds the terminal (a pin).
	const watch = button('eye', 'Watch only', () => {
		const owner = current?.pinnedBy;
		if (!current || !owner) { return; }
		const on = watch.getAttribute('aria-checked') !== 'true';
		// Shown at once; the next state confirms it (or puts it back, if the host refused).
		watch.setAttribute('aria-checked', String(on));
		setTip(watch, watchTip(on));
		options.post({ type: 'pinTerminal', id: current.id, tabId: owner.tabId, pinned: true, mode: on ? 'watch' : 'control' });
	});
	watch.classList.add('terminal-tool-watch');
	watch.setAttribute('role', 'switch');
	watch.setAttribute('aria-checked', 'false');
	const knob = document.createElement('span');
	knob.className = 'terminal-switch';
	knob.setAttribute('aria-hidden', 'true');
	watch.append(knob);
	watch.hidden = true;
	const clear = button('clear-all', 'Clear', () => { if (current) { options.clear(current.id); } });
	setTip(clear, 'Clear the screen and scrollback (the shell keeps running)');
	const bottom = button('arrow-down', 'Scroll to bottom', () => { if (current) { options.scrollToBottom(current.id); } });
	bottom.classList.add('terminal-tool-bottom');
	const newDot = document.createElement('span');
	newDot.className = 'terminal-tool-dot';
	newDot.setAttribute('aria-hidden', 'true');
	bottom.append(newDot);
	bottom.classList.add('at-bottom');
	bottom.setAttribute('aria-disabled', 'true');
	setTip(bottom, scrollTip('bottom'));
	const lease = button('eye', 'Take control', () => { if (current && options.lease) { options.lease.toggle(current.id); } });
	lease.classList.add('terminal-tool-lease');
	lease.hidden = true;
	for (const b of [insert, browser, messages, clear, bottom]) { b.classList.add('icon-only'); }
	// Three zones: state and input on the left, the agent actions in the middle, the screen actions at the right edge.
	const group = (name: string, ...children: HTMLElement[]) => {
		const g = document.createElement('span');
		g.className = `terminal-toolbar-group ${name}`;
		g.append(...children);
		return g;
	};
	void spacer;
	el.append(group('start', status, lease, insert, browser, messages), group('middle', ask, toChat, watch), group('end', clear, bottom));

	// One tab stop for the whole row; the arrows move inside it (the ARIA toolbar pattern).
	const visibleButtons = (): HTMLButtonElement[] =>
		[...el.querySelectorAll<HTMLButtonElement>('button.terminal-tool')].filter(b => !b.hidden && b.offsetParent !== null);
	let roving: HTMLButtonElement | undefined;
	function syncTabStop(): void {
		const buttons = visibleButtons();
		if (!roving || !buttons.includes(roving)) { roving = buttons[0]; }
		for (const b of buttons) {
			const want = b === roving ? 0 : -1;
			if (b.tabIndex !== want) { b.tabIndex = want; }
		}
	}
	el.addEventListener('focusin', event => {
		const target = event.target as HTMLElement;
		if (target instanceof HTMLButtonElement && target.classList.contains('terminal-tool')) { roving = target; syncTabStop(); }
	});
	el.addEventListener('keydown', event => {
		if (event.altKey || event.ctrlKey || event.metaKey) { return; }
		const buttons = visibleButtons();
		const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
		if (index < 0) { return; }
		const next = rovingIndex(event.key, index, buttons.length);
		if (next === undefined) { return; }
		event.preventDefault();
		event.stopPropagation();
		roving = buttons[next];
		syncTabStop();
		roving.focus();
	});
	let scroll: ScrollState = 'bottom';

	function set(node: HTMLElement, key: 'textContent' | 'title', value: string): void {
		if (node[key] !== value) { node[key] = value; }
	}

	function setHidden(node: HTMLElement, hidden: boolean): void {
		if (node.hidden !== hidden) { node.hidden = hidden; }
	}

	return {
		el,
		setScroll(state) {
			if (state === scroll) { return; }
			scroll = state;
			bottom.classList.toggle('at-bottom', state === 'bottom');
			bottom.classList.toggle('has-new', state === 'new');
			bottom.setAttribute('aria-disabled', String(state === 'bottom'));
			setTip(bottom, scrollTip(state));
		},
		update(summary) {
			current = summary;
			if (!summary) { return; }
			// The name is the tab's own: it is not repeated here. The folder stays a tooltip of the row.
			set(el, 'title', summary.cwd ?? '');
			const exited = summary.status === 'exited';
			setHidden(status, !exited);
			set(statusText, 'textContent', exited ? (summary.exitCode === undefined ? 'Ended' : `Ended · ${summary.exitCode}`) : '');
		status.classList.toggle('failed', exited && summary.exitCode !== undefined && summary.exitCode !== 0);
			setHidden(ask, !options.askAgent || !allowed('terminalAskAgent'));
			setHidden(browser, !options.openBrowser || exited);
			setHidden(insert, !options.insertMenu || exited || !allowed('terminalInsert'));
			setHidden(toChat, !allowed('terminalToChat'));
			// An agent's own CLI is never pinned; a shell is, once Ask agent or "+" → Terminal… gave it to a chat.
			const pinned = !!summary.pinnedBy && !summary.agent;
			setHidden(watch, !pinned || !allowed('pinTerminal'));
			const watching = pinned && summary.pinMode === 'watch';
			if (watch.getAttribute('aria-checked') !== String(watching)) { watch.setAttribute('aria-checked', String(watching)); }
			setTip(watch, watchTip(watching, summary.pinnedBy?.title));
			setHidden(lease, !options.lease || !allowed('terminalInput') || exited);
			if (options.lease) {
				const t = leaseText(options.lease.holder(summary.id));
				if (lease.getAttribute('aria-label') !== t.label) {
					lease.setAttribute('aria-label', t.label);
					set(lease.querySelector<HTMLElement>('.terminal-tool-label')!, 'textContent', t.label);
					(lease.firstChild as HTMLElement).className = `codicon codicon-${t.pressed ? 'keyboard' : 'eye'}`;
				}
				setTip(lease, t.title);
				lease.setAttribute('aria-pressed', String(t.pressed));
			}
			syncTabStop();
		},
	};
}
