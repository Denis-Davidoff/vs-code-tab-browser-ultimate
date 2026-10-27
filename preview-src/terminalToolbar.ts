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
 *  - Send to chat: the selection, or the last lines, attached to the chat in front.
 *  - Clear and Scroll to bottom: local to this view.
 *  - The agent mark: shown while a conversation has the terminal pinned: who, a
 *    "typing" dot while the agent's input is arriving, and the emergency stop —
 *    Pause agent / Resume agent (`setTerminalAgentControl`).
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
	readonly sendToChat: (id: string) => void;
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
	status.hidden = true;

	const mark = document.createElement('span');
	mark.className = 'terminal-agent-mark';
	mark.hidden = true;
	const dot = document.createElement('span');
	dot.className = 'terminal-agent-dot';
	const markText = document.createElement('span');
	markText.className = 'terminal-agent-text';
	mark.append(codicon('hubot'), dot, markText);

	const spacer = document.createElement('span');
	spacer.className = 'terminal-toolbar-spacer';

	function button(iconName: string, label: string, onClick: (button: HTMLButtonElement) => void): HTMLButtonElement {
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'terminal-tool';
		const text = document.createElement('span');
		text.className = 'terminal-tool-label';
		text.textContent = label;
		b.append(codicon(iconName), text);
		b.setAttribute('aria-label', label);
		b.title = label;
		// The terminal keeps its focus (and the soft keyboard stays up) under a pointer press.
		b.addEventListener('pointerdown', event => { event.preventDefault(); });
		b.addEventListener('mousedown', event => { event.preventDefault(); });
		b.addEventListener('click', () => onClick(b));
		return b;
	}

	const pause = button('debug-pause', 'Pause agent', () => {
		if (!current) { return; }
		// `paused` is released by this button and only by this one (or by the host).
		options.post({ type: 'setTerminalAgentControl', id: current.id, allowed: current.agentControl === 'paused' });
	});
	pause.classList.add('terminal-tool-agent');
	const ask = button('sparkle', 'Ask agent', anchor => {
		if (current && options.askAgent) { options.askAgent(anchor, current.id, options.selection(current.id)); }
	});
	ask.classList.add('terminal-tool-ask');
	const browser = button('globe', 'Browser', anchor => { options.openBrowser?.(anchor); });
	const insert = button('add', 'Insert', anchor => { if (current && options.insertMenu) { options.insertMenu(anchor, current.id); } });
	insert.classList.add('terminal-tool-insert');
	insert.title = 'Insert a page, element, screenshot, file or selection into the input (not sent)';
	const toChat = button('comment-discussion', 'Send to chat', () => { if (current) { options.sendToChat(current.id); } });
	const clear = button('clear-all', 'Clear', () => { if (current) { options.clear(current.id); } });
	const bottom = button('fold-down', 'Scroll to bottom', () => { if (current) { options.scrollToBottom(current.id); } });
	const lease = button('eye', 'Take control', () => { if (current && options.lease) { options.lease.toggle(current.id); } });
	lease.classList.add('terminal-tool-lease');
	lease.hidden = true;
	for (const b of [insert, browser, clear, bottom]) { b.classList.add('icon-only'); }
	// Three zones: state and input on the left, the agent actions in the middle, the screen actions at the right edge.
	const group = (name: string, ...children: HTMLElement[]) => {
		const g = document.createElement('span');
		g.className = `terminal-toolbar-group ${name}`;
		g.append(...children);
		return g;
	};
	void spacer;
	el.append(group('start', status, mark, lease, insert, browser, pause), group('middle', ask, toChat), group('end', clear, bottom));

	function set(node: HTMLElement, key: 'textContent' | 'title', value: string): void {
		if (node[key] !== value) { node[key] = value; }
	}

	function setHidden(node: HTMLElement, hidden: boolean): void {
		if (node.hidden !== hidden) { node.hidden = hidden; }
	}

	return {
		el,
		update(summary) {
			current = summary;
			if (!summary) { return; }
			// The name is the tab's own: it is not repeated here. The folder stays a tooltip of the row.
			set(el, 'title', summary.cwd ?? '');
			const exited = summary.status === 'exited';
			setHidden(status, !exited);
			set(status, 'textContent', exited ? (summary.exitCode === undefined ? 'Ended' : `Ended (${summary.exitCode})`) : '');
			const pinned = summary.pinnedBy !== undefined;
			setHidden(mark, !pinned);
			if (pinned) {
				const text = agentMarkText(summary);
				set(markText, 'textContent', text);
				set(mark, 'title', text);
				mark.classList.toggle('typing', summary.agentActive === true);
				mark.classList.toggle('paused', summary.agentControl === 'paused');
				mark.classList.toggle('watch', summary.pinMode === 'watch');
			}
			const paused = summary.agentControl === 'paused';
			setHidden(pause, !pinned || !allowed('setTerminalAgentControl'));
			const pauseLabel = paused ? 'Resume agent' : 'Pause agent';
			if (pause.getAttribute('aria-label') !== pauseLabel) {
				pause.setAttribute('aria-label', pauseLabel);
				pause.title = paused ? 'Let the agent type here again' : 'Stop the agent from typing here (the pin stays)';
				set(pause.querySelector<HTMLElement>('.terminal-tool-label')!, 'textContent', pauseLabel);
				(pause.firstChild as HTMLElement).className = `codicon codicon-${paused ? 'play' : 'debug-pause'}`;
			}
			pause.setAttribute('aria-pressed', String(paused));
			setHidden(ask, !options.askAgent || !allowed('terminalAskAgent'));
			setHidden(browser, !options.openBrowser || exited);
			setHidden(insert, !options.insertMenu || exited || !allowed('terminalInsert'));
			setHidden(toChat, !allowed('terminalToChat'));
			setHidden(lease, !options.lease || !allowed('terminalInput') || exited);
			if (options.lease) {
				const t = leaseText(options.lease.holder(summary.id));
				if (lease.getAttribute('aria-label') !== t.label) {
					lease.setAttribute('aria-label', t.label);
					set(lease.querySelector<HTMLElement>('.terminal-tool-label')!, 'textContent', t.label);
					(lease.firstChild as HTMLElement).className = `codicon codicon-${t.pressed ? 'keyboard' : 'eye'}`;
				}
				set(lease, 'title', t.title);
				lease.setAttribute('aria-pressed', String(t.pressed));
			}
		},
	};
}
