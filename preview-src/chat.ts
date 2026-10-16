/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * The AI Browser chat view, inside its webview.
 *
 * The extension host owns every bit of state and sends it whole; this script
 * renders it and reports what the user did. Kept here: the unsent draft of each
 * conversation (through `setState`, so a reload does not lose a sentence) and
 * which rows the user opened or closed.
 *
 * The look follows the Claude Code and Codex panels, read from their shipped
 * stylesheets — see "The AI Browser chat" in CLAUDE.md for which part came from
 * which. Two layout rules carry most of it: the conversation is anchored to the
 * bottom (a growing spacer above the first turn), and each turn's prompt is
 * `position: sticky` inside its turn, so the prompt being answered stays at the
 * top while its reply scrolls under it.
 *
 * **Nothing from a model or a page is ever parsed as HTML.** Replies are
 * rendered by a small Markdown reader below that builds DOM nodes and sets
 * `textContent`; there is no `innerHTML` anywhere in this file.
 */

import type {
	AgentUsage, ApprovalEntry, ApprovalKind, ApprovalMode, AttachmentKind, ChatEntry, ChatStats, ChatSummary, ChatTabStatus, ChatTabSummary, ChatViewState, HostToView, ToolEntry, ViewToHost,
} from '../src/chat/chatProtocol';

interface ViewState {
	/** Before tabs: the one draft there was. Read once, into the first conversation shown. */
	draft?: string;
	/** The unsent draft of each open conversation, by chat id. */
	drafts?: Record<string, string>;
}

interface VsCodeApi {
	postMessage(message: ViewToHost): void;
	getState(): ViewState | undefined;
	setState(state: ViewState): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const post = (message: ViewToHost) => vscode.postMessage(message);

/* ---------------------------------------------------------------- dom */

type Child = Node | string | undefined | false;

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: { class?: string; text?: string; title?: string } = {},
	...children: Child[]
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (props.class) {
		node.className = props.class;
	}
	if (props.text !== undefined) {
		node.textContent = props.text;
	}
	if (props.title) {
		node.title = props.title;
	}
	for (const child of children) {
		if (child !== undefined && child !== false) {
			node.append(child);
		}
	}
	return node;
}

function icon(name: string, extra = ''): HTMLElement {
	return el('i', { class: `codicon codicon-${name} ${extra}`.trim() });
}

function button(content: Child[], props: { class?: string; title?: string } = {}): HTMLButtonElement {
	const b = el('button', props, ...content);
	b.type = 'button';
	if (props.title) {
		b.setAttribute('aria-label', props.title);
	}
	return b;
}

function copyButton(text: () => string, title = 'Copy'): HTMLButtonElement {
	const b = button([icon('copy')], { class: 'copy-button', title });
	b.addEventListener('click', event => {
		event.stopPropagation();
		post({ type: 'copy', text: text() });
		b.replaceChildren(icon('check'));
		setTimeout(() => b.replaceChildren(icon('copy')), 1200);
	});
	return b;
}

/* ---------------------------------------------------------------- layout */

const app = document.getElementById('app')!;

const thread = el('div', { class: 'thread' });
const threadInner = el('div', { class: 'thread-inner' });
thread.append(threadInner);
const blocked = el('div', { class: 'blocked' });

const attachmentsRow = el('div', { class: 'attachments' });
const input = el('textarea', { class: 'input' });
input.rows = 1;
input.placeholder = 'Ask about this page, or anything…';

// Every button of the bottom bar says what it does, and its key where it has
// one — asked for: the icons alone did not say it.
const plusButton = button([icon('add')], { class: 'ghost round', title: 'Attach to the message — a screenshot or an element of the page, its address, or a file' });
const browserButton = button([icon('globe')], { class: 'ghost round', title: 'Open a new browser tab' });
/** "/": the chat's own commands — clear or export this conversation. A square and a slash, both drawn in CSS (`.slash-mark`). */
const slashButton = button([el('span', { class: 'slash-mark' })], { class: 'ghost round slash-button', title: 'Chat commands — clear this conversation, or export it to the clipboard or a file' });
const agentPill = button([], { class: 'pill', title: 'Agent' });
const modelPill = button([], { class: 'pill', title: 'Model' });
const effortRange = el('input', { class: 'effort-range' });
effortRange.type = 'range';
effortRange.min = '0';
effortRange.step = '1';
const effortLabel = el('span', { class: 'effort-label' });
const effortBox = el('label', { class: 'effort', title: 'Effort' }, effortRange, effortLabel);
const usageButton = button([el('span', { text: 'U' })], { class: 'ghost round usage-button', title: "Usage — your plan's limits for each agent, and this chat's tokens and cost" });
const agentsButton = button([], { class: 'pill agents-button', title: 'Agents' });
const sendButton = button([icon('arrow-up')], { class: 'send', title: 'Send' });
/** Only while a turn runs and there is something to send: hold it for after the turn. */
const queueButton = button([icon('list-ordered')], { class: 'ghost round queue-button', title: 'Send after this turn (⌘Enter)' });
queueButton.hidden = true;
queueButton.addEventListener('click', () => send('queue'));
/** Ask before terminal commands and browser tools, or let them run: one switch for every tab. */
const approveToggle = button([], { class: 'pill approve-toggle' });

// The right-hand buttons (agents, usage, send) are one group pushed to the end,
// so a narrow side bar wraps them together onto the next line, still at the right.
const toolbar = el('div', { class: 'toolbar' },
	plusButton, browserButton, slashButton, agentPill, modelPill, effortBox, approveToggle, el('span', { class: 'toolbar-end' }, agentsButton, usageButton, queueButton, sendButton));
const composer = el('div', { class: 'composer' }, attachmentsRow, input, toolbar);
/** Asked when another agent is picked for a conversation that has started. */
const switchCard = el('div', { class: 'switch-card' });
const footer = el('div', { class: 'footer' }, switchCard, composer);
/** One tab per open conversation, above the thread. */
const tabStrip = el('div', { class: 'tab-strip' });

const menu = el('div', { class: 'popup menu' });
const usagePopup = el('div', { class: 'popup usage-popup' });
const approvalPopup = el('div', { class: 'popup approval-popup' });
const historyPanel = el('div', { class: 'history-panel' });
const agentsPanel = el('div', { class: 'history-panel agents-panel' });
/** Which copy of each agent's CLI this project uses: opened from the gear in the agent menu. */
const agentAppsPanel = el('div', { class: 'history-panel agent-apps' });

app.append(tabStrip, thread, blocked, footer, menu, usagePopup, approvalPopup, historyPanel, agentsPanel, agentAppsPanel);

/* ---------------------------------------------------------------- state */

let state: ChatViewState | undefined;

/** Rows the user opened or closed by hand, by key; everything else uses its default. The shown chat's. */
let toggled = new Map<string, boolean>();
/**
 * Per open conversation: which rows were opened or closed, and where it was
 * scrolled to ('bottom' when following its end). Moving between tabs is
 * routine, and coming back to a tab used to find it on the previous tab's
 * scroll position, not following a reply that was streaming, with every row
 * the user had opened closed again.
 */
const toggledByChat = new Map<string, Map<string, boolean>>();
const scrollByChat = new Map<string, number | 'bottom'>();

const savedView = vscode.getState();
const drafts: Record<string, string> = { ...(savedView?.drafts ?? {}) };
/** The conversation whose draft the box holds, and the tab it is in. */
let draftChat: string | undefined;
let draftTab: string | undefined;

/** What the box holds as a draft: during a ↑ walk, the text from before the walk, not the message recalled. */
function currentDraft(): string {
	return fromHistory ? historyDraft : input.value;
}

function saveDraft(): void {
	if (draftChat) {
		drafts[draftChat] = currentDraft();
	}
	vscode.setState({ drafts });
}

/**
 * Each conversation keeps its own draft: moving to another tab puts this one's
 * away and brings that one's back. Drafts of conversations no longer open are
 * dropped, or the view state would grow with every chat ever started.
 */
function followDraft(s: ChatViewState): void {
	if (s.chatId === draftChat) {
		draftTab = s.activeTab;
		return;
	}
	if (draftChat) {
		drafts[draftChat] = currentDraft();
		// The same tab with another chat — one opened into it from the history,
		// or the other agent taking its place: the text was written to go there.
		if (s.activeTab === draftTab && !drafts[s.chatId]) {
			drafts[s.chatId] = drafts[draftChat];
			delete drafts[draftChat];
		}
	}
	const first = draftChat === undefined;
	draftChat = s.chatId;
	draftTab = s.activeTab;
	input.value = drafts[s.chatId] ?? (first ? savedView?.draft ?? '' : '');
	historyAt = inputHistory.length;
	fromHistory = false;
	const open = new Set(s.tabs.map(t => t.chatId));
	for (const id of Object.keys(drafts)) {
		if (!open.has(id) || !drafts[id]) {
			delete drafts[id];
		}
	}
	vscode.setState({ drafts });
	autosize();
}

window.addEventListener('message', (event: MessageEvent<HostToView>) => {
	const message = event.data;
	switch (message.type) {
		case 'state':
			state = message.state;
			render();
			return;
		case 'history':
			if (message.refresh) {
				// A delete changed the list: update a panel that is open, and leave
				// a closed one closed — the user may have shut it in between.
				if (historyPanel.classList.contains('open')) {
					fillHistory(message.chats);
				}
			} else {
				toggleHistory(message.chats);
			}
			return;
		case 'usage':
			renderUsage(message.usage, message.stats, message.loading);
			return;
		case 'restoreDraft':
			// Stop gave the queue back: added to what is in the box, never sent.
			if (message.chatId === state?.chatId) {
				input.value = input.value.trim() ? `${input.value}\n\n${message.text}` : message.text;
				autosize();
				saveDraft();
				renderSend();
				input.focus();
			} else {
				drafts[message.chatId] = drafts[message.chatId] ? `${drafts[message.chatId]}\n\n${message.text}` : message.text;
				saveDraft();
			}
			return;
		case 'focusInput':
			// Not while a tab is being renamed: the host asks for this on every tab
			// selection, and a reply that arrives after the double-click closed
			// the name field the moment it opened.
			if (!editingTab) {
				input.focus();
			}
			return;
		case 'agentStopFailed':
			stoppingAgents.delete(message.id);
			if (agentsView) {
				fillAgents(currentAgents(), true);
			}
			return;
		case 'inputHistory': {
			// It arrives after a send, which may be after the user has started
			// walking again; a walk in progress keeps its place.
			const atEnd = historyAt >= inputHistory.length;
			inputHistory = [...message.items];
			historyAt = atEnd ? inputHistory.length : Math.min(historyAt, inputHistory.length);
			return;
		}
	}
});

function render(): void {
	if (!state) {
		return;
	}
	app.classList.toggle('is-blocked', !!state.blocked);
	blocked.textContent = state.blocked ?? '';
	followDraft(state);
	renderTabs(state);
	renderSwitch(state);
	renderThread(state);
	landFlight(state);
	renderAttachments(state);
	renderSelectors(state);
	renderApproveToggle(state);
	renderSend();
	renderAgents(state);
	if (agentAppsPanel.classList.contains('open')) {
		fillAgentApps(state);
	}
}

/* ---------------------------------------------------------------- tabs */

/**
 * One tab per open conversation. A tab that is not in front goes on working —
 * its mark says how it is doing, and it counts its agents — and closing one
 * that is working stops it, so that asks first, here in the strip. The strip
 * is never rebuilt: each tab keeps its element (see `TabNode`). "+" is not
 * there at all once the tabs reach the limit (asked for: a disabled button
 * read as broken), and comes back when one is closed.
 */
/** The tab whose close is being confirmed. */
let closingTab: string | undefined;
/** The tab being renamed: its label is an input until Enter, Escape or a click elsewhere. */
let editingTab: string | undefined;

/**
 * Each tab's element is kept for as long as the tab is open and updated in
 * place, rather than the strip being rebuilt: the tab in front is wider, and a
 * width can only transition on an element that is still there when the class
 * changes. Within a tab only the label is refilled, and only when what it shows
 * changed — a rebuild between a press and its release loses the click (#365).
 */
interface TabNode {
	readonly root: HTMLElement;
	readonly label: HTMLButtonElement;
	readonly close: HTMLButtonElement;
	tab: ChatTabSummary;
	shown: string;
	/** A name just given, shown until the state carries it; see `startRename`. */
	pendingTitle?: { readonly title: string; readonly until: number };
}

const tabNodes = new Map<string, TabNode>();
const tabRow = el('div', { class: 'tab-row' });
const tabAdd = button([icon('add')], { class: 'ghost round tab-add', title: 'New chat' });
tabAdd.addEventListener('click', () => post({ type: 'newTab' }));
const tabConfirm = el('div', { class: 'tab-confirm' });
/** The first click of a possible double-click, by tab; see the label's click handler. */
let firstClick: { readonly id: string; readonly at: number } | undefined;
const doubleClickMs = 600;
tabConfirm.hidden = true;
let confirmShown = '';
let frontTab: string | undefined;

function renderTabs(s: ChatViewState): void {
	if (closingTab && !s.tabs.some(t => t.id === closingTab && (t.busy || t.queued))) {
		closingTab = undefined;
	}
	if (editingTab && !s.tabs.some(t => t.id === editingTab)) {
		editingTab = undefined;
	}
	if (!tabStrip.contains(tabRow)) {
		tabStrip.replaceChildren(tabRow, tabConfirm);
	}
	const open = new Set(s.tabs.map(t => t.id));
	for (const [id, node] of tabNodes) {
		if (!open.has(id)) {
			node.root.remove();
			tabNodes.delete(id);
		}
	}
	s.tabs.forEach((summary, i) => {
		const node = tabNodes.get(summary.id) ?? tabNode(summary);
		const pending = node.pendingTitle;
		if (pending && (summary.title === pending.title || performance.now() > pending.until)) {
			node.pendingTitle = undefined;
		}
		const t = node.pendingTitle ? { ...summary, title: node.pendingTitle.title } : summary;
		node.tab = t;
		const agent = t.agent ? s.agents.find(a => a.id === t.agent)?.name ?? t.agent : undefined;
		const shown = tabShown(t, agent);
		if (shown !== node.shown && editingTab !== t.id) {
			node.shown = shown;
			fillTab(node, agent);
		}
		node.root.classList.toggle('active', t.id === s.activeTab);
		node.root.classList.toggle('running', t.running);
		// Moved only when out of place: re-inserting an element ends its transition.
		if (tabRow.children[i] !== node.root) {
			tabRow.insertBefore(node.root, tabRow.children[i] ?? null);
		}
	});
	if (s.tabs.length >= s.tabLimit) {
		tabAdd.remove();
	} else if (tabRow.lastElementChild !== tabAdd) {
		tabRow.append(tabAdd);
	}
	renderTabConfirm(s);
	if (s.activeTab !== frontTab) {
		frontTab = s.activeTab;
		// After the width has settled, or it scrolls to where the tab was going.
		setTimeout(() => tabNodes.get(s.activeTab)?.root.scrollIntoView({ block: 'nearest', inline: 'nearest' }), 340);
	}
}

function tabShown(t: ChatTabSummary, agent: string | undefined): string {
	return JSON.stringify([t.title, t.status, t.agents, t.busy, agent]);
}

function tabNode(t: ChatTabSummary): TabNode {
	const label = button([], { class: 'tab-label' });
	const close = button([icon('close')], { class: 'tab-close' });
	const root = el('div', { class: 'tab' }, label, close);
	const node: TabNode = { root, label, close, tab: t, shown: '' };
	label.addEventListener('click', event => {
		// The second click of a double-click can land on another tab: the
		// first one selects this tab, the strip's widths move, and the pointer is
		// over a neighbour by the time it clicks again. The double-click belongs
		// to the tab the first click was on.
		const now = performance.now();
		if (event.detail >= 2 && firstClick && now - firstClick.at < doubleClickMs) {
			return;
		}
		firstClick = { id: node.tab.id, at: now };
		post({ type: 'selectTab', id: node.tab.id });
	});
	label.addEventListener('dblclick', () => {
		const first = firstClick && performance.now() - firstClick.at < doubleClickMs ? tabNodes.get(firstClick.id) : undefined;
		firstClick = undefined;
		startRename(first ?? node);
	});
	label.addEventListener('keydown', event => {
		if (event.key === 'F2') {
			event.preventDefault();
			startRename(node);
		}
	});
	close.addEventListener('click', () => {
		if (node.tab.busy || node.tab.queued) {
			closingTab = node.tab.id;
			if (state) {
				renderTabs(state);
			}
			tabConfirm.querySelector<HTMLButtonElement>('.confirm-cancel')?.focus();
		} else {
			post({ type: 'closeTab', id: node.tab.id });
		}
	});
	tabNodes.set(t.id, node);
	return node;
}

function fillTab(node: TabNode, agent: string | undefined): void {
	const t = node.tab;
	const parts: (HTMLElement | undefined)[] = [
		tabMark(t.status),
		el('span', { class: 'tab-title', text: t.title }),
		t.agents ? el('span', { class: 'tab-agents', text: String(t.agents), title: `${t.agents} agent${t.agents === 1 ? '' : 's'} working` }) : undefined,
	];
	node.label.replaceChildren(...parts.filter((p): p is HTMLElement => !!p));
	node.label.title = `${agent ? `${t.title} — ${agent}` : t.title}\nDouble-click to rename`;
	node.close.title = t.busy ? 'Close (stops what it is doing)' : 'Close';
}

/**
 * Renaming in place: Enter or a click elsewhere keeps the name, Escape keeps
 * the old one. An empty name changes nothing. The label shows the new name at
 * once, so it does not flick back for the 40 ms until the host's state says so.
 */
function startRename(node: TabNode): void {
	if (editingTab === node.tab.id) {
		return;
	}
	editingTab = node.tab.id;
	const before = node.tab.title;
	const field = el('input', { class: 'tab-rename' });
	field.value = before;
	field.maxLength = 80;
	field.setAttribute('aria-label', 'Tab name');
	let done = false;
	/** `fromKeys`: Enter or Escape. A click elsewhere keeps the focus where it went. */
	const finish = (keep: boolean, fromKeys: boolean) => {
		if (done) {
			return;
		}
		done = true;
		const name = field.value.replace(/\s+/g, ' ').trim();
		editingTab = undefined;
		field.remove();
		node.label.hidden = false;
		if (keep && name && name !== before) {
			post({ type: 'renameTab', id: node.tab.id, title: name });
			node.tab = { ...node.tab, title: name };
			// Shown until the host's state says so: a post it built before it read
			// the rename would otherwise show the old name for a moment.
			node.pendingTitle = { title: name, until: performance.now() + 2000 };
		}
		const agent = node.tab.agent ? state?.agents.find(a => a.id === node.tab.agent)?.name ?? node.tab.agent : undefined;
		node.shown = tabShown(node.tab, agent);
		fillTab(node, agent);
		if (fromKeys) {
			node.label.focus();
		}
	};
	field.addEventListener('keydown', event => {
		// Enter and Escape inside an IME composition pick or drop a candidate.
		if (event.isComposing || event.keyCode === 229) {
			return;
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			finish(true, true);
		} else if (event.key === 'Escape') {
			// Not the document's Escape too, which would close a popup or the switch card.
			event.preventDefault();
			event.stopPropagation();
			finish(false, true);
		}
	});
	field.addEventListener('blur', () => finish(true, false));
	node.label.hidden = true;
	node.root.insertBefore(field, node.close);
	field.focus();
	field.select();
}

/** The close is not confirmed: focus goes back to the tab's own close button, not to the page. */
function cancelClosing(): void {
	const id = closingTab;
	closingTab = undefined;
	if (state) {
		renderTabs(state);
	}
	if (id) {
		tabNodes.get(id)?.close.focus();
	}
}

function renderTabConfirm(s: ChatViewState): void {
	const closing = closingTab ? s.tabs.find(t => t.id === closingTab) : undefined;
	const shown = closing ? JSON.stringify([closing.id, closing.title, closing.agents, closing.busy, closing.queued]) : '';
	if (shown === confirmShown) {
		return;
	}
	confirmShown = shown;
	tabConfirm.hidden = !closing;
	if (!closing) {
		tabConfirm.replaceChildren();
		return;
	}
	const yes = button([el('span', { text: 'Stop and close' })], { class: 'confirm-danger' });
	yes.addEventListener('click', () => {
		closingTab = undefined;
		post({ type: 'closeTab', id: closing.id });
		if (state) {
			renderTabs(state);
		}
	});
	const no = button([el('span', { text: 'Cancel' })], { class: 'confirm-cancel' });
	no.addEventListener('click', () => cancelClosing());
	const parts = [
		closing.busy ? 'its reply' : '',
		closing.agents ? `${closing.agents} agent${closing.agents === 1 ? '' : 's'}` : '',
	].filter(Boolean);
	const queued = closing.queued ? `${closing.queued} queued message${closing.queued === 1 ? '' : 's'} will not be sent.` : '';
	const text = parts.length
		? `"${closing.title}" is still working. Closing it stops ${parts.join(' and ')}.${queued ? ` ${queued}` : ''}`
		: `"${closing.title}": ${queued}`;
	tabConfirm.replaceChildren(el('span', { text }), yes, no);
}

/**
 * The mark in front of a tab's title: the working star while it works (the
 * glyph of the working line, turned by the same timer), a green dot for work
 * finished out of sight, an orange one for work that ended in an error, and
 * nothing once it is finished and read — nor before the first message. A tab whose
 * agent waits for an approval shows a pulsing ring instead of the star: the
 * work is stopped on the user, and the tab may not be the one in front.
 */
const tabMarks: Record<ChatTabStatus, string> = {
	waiting: 'Waiting for your answer',
	working: 'Working',
	unread: 'Finished — not read yet',
	failed: 'Ended with an error',
	read: 'Finished',
};

function tabMark(status: ChatTabStatus | undefined): HTMLElement | undefined {
	// Finished and read needs no mark at all — asked for: the grey square it
	// used to show said nothing a plain tab does not.
	if (!status || status === 'read') {
		return undefined;
	}
	return el('span', {
		class: `tab-mark ${status}`,
		title: tabMarks[status],
		text: status === 'working' ? glyphs[glyphAt] : undefined,
	});
}

/* ---------------------------------------------------------------- switching agents */

let switchShown = '';

/**
 * Another agent was picked for a conversation that has started. A conversation
 * belongs to one agent, so the question is what happens to this one: a new tab
 * beside it, this one closed in favour of the other agent, or this one handed
 * over to it as a file.
 */
function renderSwitch(s: ChatViewState): void {
	const tab = s.tabs.find(t => t.id === s.activeTab);
	const to = s.switchTo ? s.agents.find(a => a.id === s.switchTo) : undefined;
	const from = tab?.agent ? s.agents.find(a => a.id === tab.agent) : undefined;
	const shown = JSON.stringify([to?.id, from?.id, tab?.busy, tab?.agents, s.tabs.length, s.tabLimit]);
	if (shown === switchShown) {
		return;
	}
	switchShown = shown;
	if (!to || !tab) {
		switchCard.hidden = true;
		switchCard.replaceChildren();
		return;
	}
	const full = s.tabs.length >= s.tabLimit;
	const option = (choice: 'newTab' | 'replace' | 'continue', title: string, detail: string, disabled = false) => {
		const b = button([el('span', { class: 'switch-title', text: title }), el('span', { class: 'switch-detail', text: detail })], { class: 'switch-option' });
		b.disabled = disabled;
		b.addEventListener('click', () => post({ type: 'switchAgent', choice }));
		return b;
	};
	const fullNote = `${s.tabs.length} chats are open — close one first.`;
	const stops = tab.busy
		? `This chat is still working; its reply${tab.agents ? ` and ${tab.agents} agent${tab.agents === 1 ? '' : 's'}` : ''} will be stopped.`
		: 'This chat closes and stays in the history.';
	const cancel = button([el('span', { text: 'Cancel' })], { class: 'switch-cancel' });
	cancel.addEventListener('click', () => post({ type: 'switchAgent', choice: 'cancel' }));
	switchCard.hidden = false;
	switchCard.replaceChildren(
		el('div', { class: 'switch-head', text: `This chat is with ${from?.name ?? 'another agent'}. Switch to ${to.name}?` }),
		option('newTab', `New tab with ${to.name}`, full ? fullNote : 'This chat stays open and keeps working.', full),
		option('continue', `Continue in ${to.name}`, full ? fullNote : `This conversation is saved to a file and handed to ${to.name} in a new tab.`, full),
		option('replace', `Close this chat, start ${to.name}`, stops),
		cancel);
}

/* ---------------------------------------------------------------- thread */

interface Turn {
	/** Index of the user entry, or -1 for what came before the first message. */
	readonly prompt: number;
	readonly rows: number[];
}

function turnsOf(entries: readonly ChatEntry[]): Turn[] {
	const turns: Turn[] = [];
	let current: Turn | undefined;
	entries.forEach((entry, i) => {
		if (entry.kind === 'user') {
			current = { prompt: i, rows: [] };
			turns.push(current);
		} else {
			if (!current) {
				current = { prompt: -1, rows: [] };
				turns.push(current);
			}
			current.rows.push(i);
		}
	});
	return turns;
}

/**
 * Rendering is keyed: each entry's DOM is rebuilt only when the entry (or the
 * user's open/closed choice for it) changed. A streaming reply changes its last
 * row many times a second, and rebuilding the whole thread on every post would
 * lose the selection and the scroll position under the reader.
 */
let renderedChat = '';
let rendered: { sig: string; node: HTMLElement }[] = [];
let turnNodes: { root: HTMLElement; rows: HTMLElement; tail: HTMLElement }[] = [];
const spacer = el('div', { class: 'spacer' });
let workingNode: HTMLElement | undefined;

/** What the welcome was built from; see the empty-chat branch of `renderThread`. */
let welcomeShown = '';

function renderThread(s: ChatViewState): void {
	const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60;
	let stick = atBottom;
	let restore: number | undefined;

	if (s.chatId !== renderedChat || s.entries.length < rendered.length) {
		// Open/closed choices are keyed by position, so they belong to one chat:
		// carried over, the next chat opened its own rows at the same indices.
		if (s.chatId !== renderedChat) {
			if (renderedChat) {
				scrollByChat.set(renderedChat, atBottom ? 'bottom' : thread.scrollTop);
			}
			const saved = scrollByChat.get(s.chatId);
			stick = saved === undefined || saved === 'bottom';
			restore = typeof saved === 'number' ? saved : undefined;
			toggled = toggledByChat.get(s.chatId) ?? new Map<string, boolean>();
			toggledByChat.set(s.chatId, toggled);
			const open = new Set(s.tabs.map(t => t.chatId));
			for (const id of [...toggledByChat.keys(), ...scrollByChat.keys()]) {
				if (!open.has(id)) {
					toggledByChat.delete(id);
					scrollByChat.delete(id);
				}
			}
		}
		renderedChat = s.chatId;
		rendered = [];
		turnNodes = [];
		workingNode = undefined;
		threadInner.replaceChildren(spacer);
	}

	if (!s.entries.length) {
		// No spacer here: an empty chat centres its welcome in the panel rather
		// than anchoring it to the bottom like a conversation. Rebuilt only when
		// what it shows changes: another tab streaming posts the state every
		// 40 ms, and each rebuild restarted the welcome's fade-in — the
		// changelog blinked while a different tab was thinking.
		const shown = JSON.stringify([s.news, s.newsHidden, s.detecting, s.agents.map(a => [a.name, a.available, a.problem])]);
		if (shown !== welcomeShown || !threadInner.querySelector('.welcome')) {
			welcomeShown = shown;
			threadInner.replaceChildren(welcome(s));
		}
		rendered = [];
		turnNodes = [];
		return;
	}
	welcomeShown = '';
	threadInner.querySelector('.welcome')?.remove();

	const turns = turnsOf(s.entries);
	const lastTurn = turns.length - 1;
	turns.forEach((turn, t) => {
		let nodes = turnNodes[t];
		if (!nodes) {
			const root = el('section', { class: 'turn' });
			const rows = el('div', { class: 'rows' });
			const tail = el('div', { class: 'turn-tail' });
			root.append(rows, tail);
			threadInner.append(root);
			nodes = turnNodes[t] = { root, rows, tail };
		}
		const indices = turn.prompt >= 0 ? [turn.prompt, ...turn.rows] : turn.rows;
		for (const i of indices) {
			const entry = s.entries[i];
			const sig = signature(entry, i);
			if (rendered[i]?.sig === sig) {
				continue;
			}
			const node = entryNode(entry, i);
			if (rendered[i]) {
				rendered[i].node.replaceWith(node);
			} else if (entry.kind === 'user') {
				nodes.root.prepend(node);
			} else {
				nodes.rows.append(node);
			}
			rendered[i] = { sig, node };
		}
		renderTail(nodes.tail, s, turn, t === lastTurn);
	});
	renderPendingSends(s);

	if (stick) {
		thread.scrollTop = thread.scrollHeight;
	} else if (restore !== undefined) {
		thread.scrollTop = restore;
	}
}

/**
 * Messages not in the conversation yet, below it: one sent during a turn that
 * Claude Code has not taken in ("Waiting for the agent"), and the queue
 * (⌘/Ctrl+Enter, "Sent when this turn ends", with an x to take it back). Built
 * like prompts, so a sent message's flight lands on its row here.
 */
const pendingBox = el('div', { class: 'pending-sends' });
let pendingShown = '';

function renderPendingSends(s: ChatViewState): void {
	if (threadInner.lastElementChild !== pendingBox) {
		threadInner.append(pendingBox);
	}
	const shown = JSON.stringify(s.pendingSends);
	if (shown === pendingShown) {
		return;
	}
	pendingShown = shown;
	pendingBox.replaceChildren(...s.pendingSends.map(p => {
		const bubble = el('div', { class: 'bubble' });
		if (p.attachments.length) {
			bubble.append(el('div', { class: 'bubble-attachments' }, ...p.attachments.map(label => el('span', { class: 'chip small', text: label }))));
		}
		if (p.text) {
			bubble.append(el('div', { class: 'bubble-text', text: p.text }));
		}
		const note = el('div', { class: 'pending-note' },
			icon(p.kind === 'queue' ? 'list-ordered' : 'loading'),
			el('span', { text: p.kind === 'queue' ? 'Sent when this turn ends' : 'Waiting for the agent to take it in' }));
		if (p.kind === 'queue') {
			const remove = button([icon('close')], { class: 'pending-remove', title: 'Do not send' });
			remove.addEventListener('click', () => post({ type: 'unqueue', id: p.id }));
			note.append(remove);
		}
		return el('div', { class: `prompt pending-send ${p.kind}` }, bubble, note);
	}));
}

/**
 * What decides whether a row is rebuilt. A prompt's open state is left out: the
 * bubble toggles its own class, and rebuilding it on the next post (every 40 ms
 * while a reply streams) took the reader's selection with it.
 */
function signature(entry: ChatEntry, i: number): string {
	return entry.kind === 'user' ? JSON.stringify(entry) : `${JSON.stringify(entry)}|${toggled.get(keyOf(entry, i)) ?? ''}`;
}

function keyOf(entry: ChatEntry, i: number): string {
	return entry.kind === 'tool' ? `tool:${entry.id}` : entry.kind === 'approval' ? `approval:${entry.id}` : `${entry.kind}:${i}`;
}

/** The line under a turn: the live "Working…" while it runs, "Worked for …" once it is done. */
function renderTail(tail: HTMLElement, s: ChatViewState, turn: Turn, last: boolean): void {
	const prompt = turn.prompt >= 0 ? s.entries[turn.prompt] : undefined;
	if (last && s.running) {
		if (!workingNode || workingNode.parentElement !== tail) {
			workingNode = el('div', { class: 'working' });
			tail.replaceChildren(workingNode);
			delete tail.dataset.sig;
		}
		const startedAt = prompt?.kind === 'user' ? prompt.at : undefined;
		workingNode.dataset.since = startedAt ? String(startedAt) : '';
		tickWorking();
		return;
	}
	if (workingNode?.parentElement === tail) {
		workingNode = undefined;
	}
	const p = prompt?.kind === 'user' ? prompt : undefined;
	const worked = p?.workedMs;
	const text = worked !== undefined ? `${workedPhrase(p?.at)} for ${duration(worked)}` : '';
	// Tokens only when the agent reported them for this turn: ↑ sent, ↓ received.
	const tokens = p?.tokensIn !== undefined ? `↑ ${compact(p.tokensIn)}  ↓ ${compact(p.tokensOut ?? 0)}` : '';
	const sig = `${text}|${tokens}`;
	if (tail.dataset.sig !== sig) {
		tail.dataset.sig = sig;
		// A square where the working star was: the same slot, so the line does
		// not shift when the turn ends.
		tail.replaceChildren(text
			? el('div', { class: 'worked' },
				el('span', { class: 'working-glyph done', text: '■' }),
				el('span', { class: 'worked-text', text }),
				tokens ? el('span', {
					class: 'worked-tokens', text: tokens,
					title: `${(p?.tokensIn ?? 0).toLocaleString()} tokens sent${p?.tokensCached ? `, ${p.tokensCached.toLocaleString()} of them from the cache` : ''}; ${(p?.tokensOut ?? 0).toLocaleString()} received`,
				}) : undefined)
			: '');
	}
}

/**
 * Thirty ways to say "working", each with its past form for the line left
 * behind when the turn ends ("Browsing…" → "Browsed for 42s"). While a turn
 * runs, a random one is shown and replaced by another every eight seconds, so
 * a long turn does not sit on one word. The past form is chosen from the
 * turn's start time, so it stays the same through every re-render and reload.
 */
const phrases: readonly (readonly [string, string])[] = [
	['Working', 'Worked'], ['Thinking', 'Thought'], ['Browsing', 'Browsed'], ['Exploring', 'Explored'],
	['Reading', 'Read'], ['Pondering', 'Pondered'], ['Digging in', 'Dug in'], ['Reasoning', 'Reasoned'],
	['Investigating', 'Investigated'], ['Untangling', 'Untangled'], ['Piecing it together', 'Pieced it together'],
	['Weighing options', 'Weighed options'], ['Connecting the dots', 'Connected the dots'], ['Sketching', 'Sketched'],
	['Tinkering', 'Tinkered'], ['Considering', 'Considered'], ['Mulling it over', 'Mulled it over'],
	['Looking closer', 'Looked closer'], ['Scanning', 'Scanned'], ['Inspecting', 'Inspected'], ['Puzzling', 'Puzzled'],
	['Brewing', 'Brewed'], ['Crafting', 'Crafted'], ['Figuring it out', 'Figured it out'],
	['Charting a course', 'Charted a course'], ['Following the thread', 'Followed the thread'],
	['Sorting it out', 'Sorted it out'], ['Assembling', 'Assembled'], ['Polishing', 'Polished'],
	['Cross-checking', 'Cross-checked'],
];
const phraseEveryMs = 8000;
let phraseAt = Math.floor(Math.random() * phrases.length);
let phraseSince = Date.now();

function workingPhrase(): string {
	if (Date.now() - phraseSince >= phraseEveryMs) {
		// Another one, never the same twice in a row.
		phraseAt = (phraseAt + 1 + Math.floor(Math.random() * (phrases.length - 1))) % phrases.length;
		phraseSince = Date.now();
	}
	return phrases[phraseAt][0];
}

function workedPhrase(seed: number | undefined): string {
	return phrases[Math.abs(Math.floor((seed ?? 0) / 1000)) % phrases.length][1];
}

function tickWorking(): void {
	if (!workingNode) {
		return;
	}
	const since = Number(workingNode.dataset.since);
	const phrase = workingPhrase();
	const label = since ? `${phrase}… ${duration(Date.now() - since)}` : `${phrase}…`;
	const text = workingNode.querySelector('.working-text');
	if (text?.textContent !== label) {
		workingNode.replaceChildren(el('span', { class: 'working-glyph', text: glyphs[glyphAt] }), el('span', { class: 'shimmer working-text', text: label }));
	}
}
setInterval(tickWorking, 1000);

/**
 * The mark in front of "Working…": a star that changes shape, there and back,
 * every 120 ms. A glyph rather than a spinner icon, because a turning circle
 * reads as "loading" and this is the agent working, which can take minutes.
 * Under reduced motion it stays on one shape.
 */
const glyphs = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
let glyphAt = 0;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
setInterval(() => {
	if (reducedMotion.matches || (!workingNode && !tabStrip.querySelector('.tab-mark.working'))) {
		return;
	}
	glyphAt = (glyphAt + 1) % glyphs.length;
	const glyph = workingNode?.querySelector('.working-glyph');
	if (glyph) {
		glyph.textContent = glyphs[glyphAt];
	}
	for (const mark of tabStrip.querySelectorAll('.tab-mark.working')) {
		mark.textContent = glyphs[glyphAt];
	}
}, 120);

/**
 * The empty chat: what AI Browser is, and what is new. Both come from NEWS.md
 * in the installed extension (`news` in the state) — the introduction as the
 * lead, the newest entries below it in small print — so the text is edited in
 * that file, not here. Until it has been read, or if it cannot be, the welcome
 * says what the agents can do with what is available.
 */
function welcome(s: ChatViewState): HTMLElement {
	const available = s.agents.filter(a => a.available);
	const box = el('div', { class: 'welcome' },
		icon('globe', 'welcome-icon'),
		el('div', { class: 'welcome-title', text: 'AI Browser' }));
	const lead = el('div', { class: 'welcome-text' });
	inline(lead, s.news?.intro || 'Work with the pages you have open, right inside VS Code.');
	box.append(lead);
	box.append(el('div', { class: 'welcome-hint', text: available.length
		? `Ask ${available.map(a => a.name).join(' or ')} below. Use + to attach a screenshot, an element or the page address.`
		: s.detecting ? 'Looking for Claude Code and Codex…' : 'No agent is available yet.' }));
	for (const agent of s.agents.filter(a => !a.available && a.problem)) {
		box.append(el('div', { class: 'welcome-problem', text: `${agent.name}: ${agent.problem}` }));
	}
	if (s.news?.entries.length) {
		const toggle = (hidden: boolean, label: string) => {
			const b = button([el('span', { text: label })], { class: 'news-toggle', title: label });
			b.addEventListener('click', () => post({ type: 'setNewsHidden', hidden }));
			return b;
		};
		if (s.newsHidden) {
			box.append(el('div', { class: 'news news-collapsed' }, toggle(false, 'Show changelog')));
		} else {
			const news = el('div', { class: 'news' }, el('div', { class: 'news-heading', text: "What's new" }));
			for (const entry of s.news.entries) {
				const items = el('ul', { class: 'news-items' });
				for (const item of entry.items) {
					const li = el('li');
					inline(li, item);
					items.append(li);
				}
				news.append(el('div', { class: 'news-entry' }, el('div', { class: 'news-title', text: entry.title }), items));
			}
			news.append(toggle(true, 'Hide changelog'));
			box.append(news);
		}
	}
	return box;
}

function entryNode(entry: ChatEntry, i: number): HTMLElement {
	switch (entry.kind) {
		case 'user':
			return promptNode(entry, i);
		case 'assistant': {
			// Copies the reply as it came, Markdown and all; shown on hover.
			const copy = copyButton(() => entry.text, 'Copy reply');
			copy.classList.add('message-copy');
			// Beside the Markdown, not in it: as its last child the button took the
			// `.markdown > :last-child` rule, and every reply kept its last block's
			// bottom margin.
			return el('div', { class: 'row assistant' }, el('div', { class: 'markdown' }, renderMarkdown(entry.text)), copy);
		}
		case 'thinking':
			return thinkingNode(entry, i);
		case 'tool':
			return toolNode(entry);
		case 'approval':
			return approvalNode(entry);
		case 'notice':
			return el('div', { class: 'row notice' }, icon('info'), el('span', { text: entry.text }));
		case 'error':
			return el('div', { class: 'row error' }, icon('error'), el('span', { text: entry.text }));
	}
}

const approvalLabels: Record<ApprovalKind, { icon: string; ask: string }> = {
	web: { icon: 'cloud', ask: 'Go to the internet?' },
	browser: { icon: 'globe', ask: 'Use the browser?' },
	command: { icon: 'terminal', ask: 'Run this command?' },
	edit: { icon: 'edit', ask: 'Change this file?' },
	outside: { icon: 'folder-opened', ask: 'Use a file outside the project?' },
	mcp: { icon: 'plug', ask: 'Use this tool?' },
	other: { icon: 'tools', ask: 'Use this tool?' },
};

const approvalOutcomes: Record<Exclude<ApprovalEntry['status'], 'pending'>, string> = {
	allowed: 'Allowed',
	denied: 'Denied',
	cancelled: 'No longer needed',
};

/** The approval menu's key for a card: written twice, see `approvalKey` in chatTab.ts (the webview imports types only). */
function approvalKeyOf(entry: { readonly what: string; readonly server?: string }): string {
	return entry.what === 'mcp' ? `mcp:${entry.server ?? ''}` : entry.what;
}

/** The fixed categories of the approval menu, in its order; servers go before `other`. */
const approvalRows: readonly { readonly key: string; readonly label: string; readonly hint: string }[] = [
	{ key: 'web', label: 'Internet', hint: 'Fetching pages and searching the web (Claude Code); network access for a command (Codex)' },
	{ key: 'browser', label: 'AI Browser', hint: "This window's browser tools: reading, clicking, filling, screenshots" },
	{ key: 'command', label: 'Terminal', hint: 'Shell commands, and input to a command already running' },
	{ key: 'edit', label: 'Files in the project', hint: 'Writing and editing files inside the open folder' },
	{ key: 'outside', label: 'Files outside the project', hint: 'Reading or writing files outside the open folder, or write access under another folder' },
];
const approvalOther = { key: 'other', label: 'Other tools', hint: 'Anything that is none of the above' };

function approvalCategoryRows(s: ChatViewState): { key: string; label: string; hint: string }[] {
	return [
		...approvalRows,
		...s.approvals.servers.map(server => ({ key: `mcp:${server}`, label: `MCP · ${server}`, hint: `The tools of the ${server} MCP server` })),
		approvalOther,
	];
}

function approvalLabelOf(s: ChatViewState, key: string): string {
	return approvalCategoryRows(s).find(r => r.key === key)?.label ?? key;
}

function modeOf(s: ChatViewState, key: string): ApprovalMode {
	return s.approvals.policy[key] ?? 'ask';
}

/**
 * An agent asking before it uses a tool. Answered here, never in a modal (a
 * dialog pauses the browser). "Always allow" and "Always deny" also set the
 * card's category in the approval menu, so the same kind of question does not
 * come back; the menu beside the model changes it again.
 */
function approvalNode(entry: ApprovalEntry): HTMLElement {
	const label = approvalLabels[entry.what];
	const node = el('div', { class: `row approval ${entry.status}` },
		el('div', { class: 'approval-head' }, icon(label.icon), el('span', { text: entry.what === 'mcp' && entry.server ? `${label.ask} (${entry.server})` : label.ask })),
		el('div', { class: 'approval-title', text: entry.title }));
	// Refused by the menu: one short line — what, and that it was refused.
	const quiet = entry.status === 'denied' && entry.auto;
	if (entry.detail && !quiet) {
		node.append(el('div', { class: 'approval-detail', text: entry.detail }));
	}
	if (quiet) {
		node.classList.add('quiet');
	}
	if (entry.status !== 'pending') {
		node.append(el('div', { class: 'approval-outcome', text: entry.auto ? `${approvalOutcomes[entry.status]} automatically` : approvalOutcomes[entry.status] }));
		return node;
	}
	const answer = (allow: boolean) => {
		for (const b of node.querySelectorAll('button')) {
			b.disabled = true;
		}
		post({ type: 'approve', id: entry.id, allow });
	};
	const key = approvalKeyOf(entry);
	const category = state ? approvalLabelOf(state, key) : key;
	const allow = button([el('span', { text: 'Allow' })], { class: 'approval-allow' });
	allow.addEventListener('click', () => answer(true));
	const deny = button([el('span', { text: 'Deny' })], { class: 'approval-deny' });
	deny.addEventListener('click', () => answer(false));
	const always = (mode: ApprovalMode, text: string) => {
		const b = button([el('span', { text })], {
			class: 'approval-always',
			title: `${text} — "${category}" in this project from now on. The approval button in the bottom bar changes it.`,
		});
		b.addEventListener('click', () => {
			post({ type: 'setApprovalMode', key, mode });
			answer(mode === 'auto');
		});
		return b;
	};
	node.append(el('div', { class: 'approval-actions' }, allow, deny, always('auto', 'Always allow'), always('deny', 'Always deny')));
	return node;
}

/**
 * The composer's approval button: a summary of the menu's modes. "Ask" while
 * every category asks, "Auto" or "Deny" while every one does that, and
 * otherwise what differs — "Auto 2 · Deny 1".
 */
function renderApproveToggle(s: ChatViewState): void {
	const rows = approvalCategoryRows(s);
	const modes = rows.map(r => modeOf(s, r.key));
	const auto = modes.filter(m => m === 'auto').length;
	const deny = modes.filter(m => m === 'deny').length;
	const text = auto === modes.length ? 'Auto' : deny === modes.length ? 'Deny' : !auto && !deny ? 'Ask'
		: [auto ? `Auto ${auto}` : '', deny ? `Deny ${deny}` : ''].filter(Boolean).join(' · ');
	const title = `Approvals — what the agents may do without asking:\n${rows.map(r => `${r.label}: ${modeLabels[modeOf(s, r.key)]}`).join('\n')}\nClick to change: Auto runs it, Ask asks, Deny refuses.`;
	const shown = JSON.stringify([text, title]);
	if (approveToggle.dataset.shown !== shown) {
		approveToggle.dataset.shown = shown;
		approveToggle.classList.toggle('on', auto > 0);
		approveToggle.replaceChildren(icon(auto ? 'unlock' : 'shield'), el('span', { text }));
		approveToggle.title = title;
		approveToggle.setAttribute('aria-label', `Approvals: ${text}`);
	}
	if (approvalPopup.classList.contains('open')) {
		renderApprovalMenu(s);
	}
}

const modeLabels: Record<ApprovalMode, string> = { auto: 'Auto', ask: 'Ask', deny: 'Deny' };
let approvalMenuRows = '';

/**
 * The approval menu: a row per category with Auto · Ask · Deny, and "All" on
 * top, which sets every row at once and shows no choice while they differ.
 * A choice changes the buttons in place: rebuilt for every change, as it first
 * was, the clicked button was replaced and keyboard focus fell to the page
 * (#365). It is rebuilt only when the rows themselves change (a server
 * appearing), and focus then goes back to the button it was on.
 */
function renderApprovalMenu(s: ChatViewState, force = false): void {
	const rows = approvalCategoryRows(s);
	const keys = JSON.stringify(rows.map(r => r.key));
	if (force || keys !== approvalMenuRows || !approvalPopup.firstChild) {
		const focused = document.activeElement instanceof HTMLElement && approvalPopup.contains(document.activeElement)
			? { key: document.activeElement.dataset.key, mode: document.activeElement.dataset.mode }
			: undefined;
		approvalMenuRows = keys;
		const row = (key: string, label: string, hint: string, strong = false) => {
			const segments = (['auto', 'ask', 'deny'] as const).map(mode => {
				const b = button([el('span', { text: modeLabels[mode] })], { class: `mode-seg ${mode}` });
				b.dataset.key = key;
				b.dataset.mode = mode;
				b.addEventListener('click', () => post({ type: 'setApprovalMode', key, mode }));
				return b;
			});
			const group = el('span', { class: 'mode-segs' }, ...segments);
			group.setAttribute('role', 'group');
			group.setAttribute('aria-label', label);
			return el('div', { class: `approval-row${strong ? ' all' : ''}`, title: hint },
				el('span', { class: 'approval-row-label', text: label }), group);
		};
		approvalPopup.replaceChildren(
			el('div', { class: 'menu-heading' }, el('span', { text: 'Before a tool runs' })),
			row('all', 'All', 'Every category at once', true),
			el('div', { class: 'approval-sep' }),
			...rows.map(r => row(r.key, r.label, r.hint)),
			el('div', { class: 'approval-note', text: 'Auto runs it without asking, Deny refuses it without asking. For this project, in every tab. Your own Claude Code and Codex rules still decide first.' }));
		if (focused?.key) {
			approvalPopup.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused.key)}"][data-mode="${focused.mode}"]`)?.focus();
		}
	}
	const modes = new Set(rows.map(r => modeOf(s, r.key)));
	const all: ApprovalMode | undefined = modes.size === 1 ? [...modes][0] : undefined;
	for (const b of approvalPopup.querySelectorAll<HTMLElement>('.mode-seg')) {
		const current = b.dataset.key === 'all' ? all : modeOf(s, b.dataset.key ?? '');
		const on = current === b.dataset.mode;
		b.classList.toggle('on', on);
		b.setAttribute('aria-pressed', String(on));
	}
}

approveToggle.addEventListener('click', () => {
	if (approvalPopup.classList.contains('open')) {
		closePopups();
		return;
	}
	if (state) {
		renderApprovalMenu(state, true);
	}
	openAbove(approvalPopup, approveToggle, 'left');
});

/**
 * A turn's prompt. Sticky inside its turn: while its reply scrolls, it stays at
 * the top, and the next turn's prompt pushes it away — the Claude Code panel's
 * `.message.stickyHeader`. Long prompts are clamped; a click shows all of it.
 */
function promptNode(entry: Extract<ChatEntry, { kind: 'user' }>, i: number): HTMLElement {
	const key = keyOf(entry, i);
	const bubble = el('div', { class: 'bubble' });
	if (entry.attachments.length) {
		bubble.append(el('div', { class: 'bubble-attachments' },
			...entry.attachments.map(label => el('span', { class: 'chip small', text: label }))));
	}
	if (entry.text) {
		bubble.append(el('div', { class: 'bubble-text', text: entry.text }));
		const copy = copyButton(() => entry.text, 'Copy prompt');
		copy.classList.add('message-copy');
		bubble.append(copy);
	}
	bubble.classList.toggle('expanded', toggled.get(key) === true);
	bubble.addEventListener('click', () => {
		// A drag that selected text ends in a click too; it is a selection, not
		// a request to fold the prompt.
		if (window.getSelection()?.toString()) {
			return;
		}
		toggled.set(key, !bubble.classList.contains('expanded'));
		bubble.classList.toggle('expanded');
	});
	return el('div', { class: 'prompt' }, bubble);
}

function thinkingNode(entry: Extract<ChatEntry, { kind: 'thinking' }>, i: number): HTMLElement {
	const key = keyOf(entry, i);
	const active = entry.endedAt === undefined;
	const open = toggled.get(key) ?? false;
	const label = active ? 'Thinking' : `Thought for ${duration((entry.endedAt ?? entry.startedAt) - entry.startedAt)}`;
	const head = button([
		el('span', { class: active ? 'shimmer' : '', text: label }),
		icon('chevron-right', 'chevron'),
	], { class: 'activity-head' });
	const node = el('div', { class: `row thinking${open ? ' open' : ''}` }, head);
	if (open) {
		const body = el('div', { class: 'thinking-body markdown' }, renderMarkdown(entry.text));
		node.append(body);
		if (active) {
			requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
		}
	}
	head.addEventListener('click', () => {
		toggled.set(key, !open);
		render();
	});
	return node;
}

/* ---------------------------------------------------------------- tools */

const toolIcons: Record<ToolEntry['tool'], string> = {
	command: 'terminal', read: 'file', edit: 'edit', search: 'search', web: 'globe', agent: 'hubot', mcp: 'plug', other: 'tools',
};

function basename(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** "Ran `npm test`", "Read a.txt", "Edited app.ts +3 −1" — the Codex panel's activity rows. */
function toolTitle(t: ToolEntry): Child[] {
	const running = t.status === 'running';
	const verb = (now: string, past: string) => el('span', { class: 'verb', text: running ? now : past });
	const mono = (text: string, title?: string) => el('span', { class: 'mono', text, title });
	const plain = (text: string, title?: string) => el('span', { class: 'subject', text, title });
	switch (t.tool) {
		case 'command': {
			const command = (t.input ?? '').split('\n')[0];
			return [verb('Running', 'Ran'), mono(command || t.detail || t.name, t.input)];
		}
		case 'read':
			return [verb('Reading', 'Read'), plain(t.detail ? basename(t.detail) : t.name, t.detail)];
		case 'edit':
			return [
				verb('Editing', 'Edited'), plain(t.detail ? basename(t.detail) : t.name, t.detail),
				t.added !== undefined && el('span', { class: 'added', text: `+${t.added}` }),
				t.removed !== undefined && el('span', { class: 'removed', text: `−${t.removed}` }),
			];
		case 'search':
			return [verb('Searching', 'Searched'), plain(t.detail ?? t.name, t.detail)];
		case 'web':
			return [verb('Browsing', t.name === 'WebSearch' || t.name === 'Web search' ? 'Searched the web' : 'Fetched'), t.detail ? plain(t.detail, t.detail) : undefined];
		case 'agent':
			return [verb('Delegating', 'Delegated'), plain(t.detail ?? t.name, t.detail)];
		case 'mcp':
		case 'other':
			return [verb('Calling', 'Called'), plain(t.name), t.detail ? el('span', { class: 'faint', text: t.detail }) : undefined];
	}
}

/** Commands and edits open by default — the command and its answer are the point of the row. */
function openByDefault(t: ToolEntry): boolean {
	return t.tool === 'command' || (t.tool === 'edit' && !!t.input);
}

function toolNode(t: ToolEntry): HTMLElement {
	const key = `tool:${t.id}`;
	const hasBody = !!(t.input || t.output) && t.tool !== 'read';
	const open = hasBody && (toggled.get(key) ?? openByDefault(t));
	const status = t.status === 'failed' || t.status === 'running' || t.status === 'stopped' ? t.status : 'done';

	const head = button([
		el('span', { class: `status-dot ${status}` }),
		icon(toolIcons[t.tool], 'tool-icon'),
		el('span', { class: 'activity-title' }, ...toolTitle(t)),
		hasBody && icon('chevron-right', 'chevron'),
	], { class: 'activity-head', title: t.detail && t.tool === 'command' ? t.detail : '' });
	head.disabled = !hasBody;
	head.addEventListener('click', () => {
		toggled.set(key, !open);
		render();
	});

	const node = el('div', { class: `row tool ${status}${open ? ' open' : ''}` }, head);
	if (open) {
		node.append(t.tool === 'command' ? execCard(t) : t.tool === 'edit' && t.input ? diffCard(t) : outputCard(t));
	}
	return node;
}

/** The command and its output — the Codex panel's shell block: `$ command`, output pinned to its newest line, a status footer. */
function execCard(t: ToolEntry): HTMLElement {
	const command = el('div', { class: 'exec-command' },
		el('span', { class: 'exec-prompt', text: '$' }), el('span', { text: t.input ?? '' }),
		copyButton(() => t.input ?? '', 'Copy command'));
	const card = el('div', { class: 'card exec' }, command);
	if (t.output) {
		const pre = el('pre', { text: t.output.replace(/\n+$/, '') });
		card.append(el('div', { class: 'exec-output' }, pre, copyButton(() => t.output ?? '', 'Copy output')));
		requestAnimationFrame(() => { pre.scrollTop = pre.scrollHeight; });
	}
	const footerText = t.status === 'running'
		? el('span', { class: 'shimmer', text: 'Running…' })
		: t.status === 'stopped'
			? el('span', { class: 'exit stopped', text: 'Stopped' })
			: t.status === 'failed'
			? el('span', { class: 'exit failed', text: t.exitCode !== undefined ? `Exit code ${t.exitCode}` : 'Failed' })
			: el('span', { class: 'exit ok' }, icon('check'), el('span', { text: t.output ? 'Success' : 'No output' }));
	card.append(el('div', { class: 'exec-footer' },
		t.detail ? el('span', { class: 'faint ellipsis', text: t.detail }) : undefined,
		el('span', { class: 'end' }, footerText)));
	return card;
}

function diffCard(t: ToolEntry): HTMLElement {
	const lines = (t.input ?? '').split('\n');
	const pre = el('pre', {}, ...lines.map(line => {
		const cls = line.startsWith('+') && !line.startsWith('+++') ? 'line add'
			: line.startsWith('-') && !line.startsWith('---') ? 'line del'
				: line.startsWith('@@') ? 'line hunk' : 'line';
		return el('span', { class: cls, text: line + '\n' });
	}));
	const head = el('div', { class: 'card-head' },
		el('span', { class: 'ellipsis', text: t.detail ?? 'Changes', title: t.detail }),
		el('span', { class: 'end' },
			t.added !== undefined && el('span', { class: 'added', text: `+${t.added}` }),
			t.removed !== undefined && el('span', { class: 'removed', text: `−${t.removed}` })));
	return el('div', { class: 'card diff' }, head, el('div', { class: 'card-body' }, pre));
}

function outputCard(t: ToolEntry): HTMLElement {
	const card = el('div', { class: 'card io' });
	if (t.input) {
		card.append(el('div', { class: 'io-row' }, el('span', { class: 'io-label', text: 'IN' }), el('pre', { text: t.input })));
	}
	if (t.output) {
		card.append(el('div', { class: 'io-row' }, el('span', { class: 'io-label', text: 'OUT' }), el('pre', { text: t.output }),
			copyButton(() => t.output ?? '')));
	}
	return card;
}

/** 812, 34.6k, 1.2M */
function compact(n: number): string {
	if (n < 1000) {
		return String(n);
	}
	if (n < 1_000_000) {
		return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
	}
	return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

function duration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) {
		return `${s}s`;
	}
	const m = Math.floor(s / 60);
	return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/* ---------------------------------------------------------------- markdown */

/**
 * As much Markdown as a chat reply needs: fenced code (an unclosed fence, as a
 * streaming reply has, runs to the end), headings, bullet and numbered lists,
 * block quotes, tables, rules, paragraphs, and inline code, bold, italics and
 * links. Every piece of text goes in through `textContent`.
 */
function renderMarkdown(text: string): DocumentFragment {
	const out = document.createDocumentFragment();
	const lines = text.split('\n');
	let paragraph: string[] = [];
	let list: HTMLElement | undefined;
	/** A list indented under the last item of `list`, which keeps its own numbering. */
	let sub: HTMLElement | undefined;

	const flush = () => {
		if (paragraph.length) {
			const p = el('p');
			paragraph.forEach((line, i) => {
				if (i) {
					p.append(el('br'));
				}
				inline(p, line);
			});
			out.append(p);
			paragraph = [];
		}
		list = undefined;
		sub = undefined;
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(line);
		if (fence) {
			flush();
			const code: string[] = [];
			for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) {
				code.push(lines[i]);
			}
			out.append(codeBlock(code.join('\n'), fence[2]));
			continue;
		}
		if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
			flush();
			// The header, the separator, then every following line with a pipe:
			// the separator and body rows may leave out their outer pipes.
			const rows: string[] = [line, lines[i + 1]];
			for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) {
				rows.push(lines[i]);
			}
			i--;
			out.append(table(rows));
			continue;
		}
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			flush();
			const h = el('div', { class: `heading h${Math.min(heading[1].length, 4)}` });
			inline(h, heading[2]);
			out.append(h);
			continue;
		}
		if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
			flush();
			out.append(el('hr'));
			continue;
		}
		const quote = /^\s*>\s?(.*)$/.exec(line);
		if (quote) {
			flush();
			const q = el('blockquote');
			inline(q, quote[1]);
			out.append(q);
			continue;
		}
		const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
		if (bullet) {
			const ordered = /\d/.test(bullet[2]);
			if (paragraph.length) {
				flush();
			}
			const li = el('li');
			inline(li, bullet[3]);
			// An indented item belongs to a list of its own inside the item above
			// it. Appended to the outer list, "1. First / 1. sub / 2. sub /
			// 2. Second" numbered the outer items on through the sub-items, so
			// "Second" read as 4.
			const parentItem = list?.lastElementChild;
			if (bullet[1].length >= 2 && parentItem) {
				if (!sub || (sub.tagName === 'OL') !== ordered || sub.parentElement !== parentItem) {
					sub = newList(ordered, bullet[2]);
					parentItem.append(sub);
				}
				sub.append(li);
				continue;
			}
			sub = undefined;
			if (!list || (list.tagName === 'OL') !== ordered) {
				list = newList(ordered, bullet[2]);
				out.append(list);
			}
			list.append(li);
			continue;
		}
		if (!line.trim()) {
			flush();
			continue;
		}
		list = undefined;
		paragraph.push(line);
	}
	flush();
	return out;
}

/**
 * A list starting at the number the model wrote, not at 1: a blank line or an
 * indented paragraph between items starts a new list here, and "1. … 2. … 3."
 * with text between them rendered as 1, 1, 1.
 */
function newList(ordered: boolean, marker: string): HTMLElement {
	const list = el(ordered ? 'ol' : 'ul');
	const start = parseInt(marker, 10);
	if (ordered && start > 1 && list instanceof HTMLOListElement) {
		list.start = start;
	}
	return list;
}

/** `|---|:--:|`, `---|---`, `|---|` — every cell dashes, with optional colons. Linear, unlike the pattern it replaced. */
function isTableSeparator(line: string): boolean {
	if (!line.includes('|') || !line.includes('-')) {
		return false;
	}
	const cells = tableCells(line);
	return cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c));
}

/**
 * A table row's cells. A pipe inside inline code, or escaped as `\|`, is text,
 * not a column: split blindly, `` `a|b` `` became two cells.
 */
function tableCells(row: string): string[] {
	let text = row.trim();
	if (text.startsWith('|')) {
		text = text.slice(1);
	}
	if (text.endsWith('|') && !text.endsWith('\\|')) {
		text = text.slice(0, -1);
	}
	const cells: string[] = [];
	let cell = '';
	let code = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '\\' && text[i + 1] === '|') {
			cell += '|';
			i++;
		} else if (c === '`') {
			code = !code;
			cell += c;
		} else if (c === '|' && !code) {
			cells.push(cell.trim());
			cell = '';
		} else {
			cell += c;
		}
	}
	cells.push(cell.trim());
	return cells;
}

function codeBlock(code: string, lang: string): HTMLElement {
	return el('div', { class: 'code-block' },
		el('div', { class: 'code-head' }, el('span', { text: lang || 'text' }), copyButton(() => code)),
		el('pre', {}, el('code', { text: code })));
}

function table(rows: string[]): HTMLElement {
	const cells = tableCells;
	const t = el('table');
	const head = el('tr');
	for (const c of cells(rows[0])) {
		const th = el('th');
		inline(th, c);
		head.append(th);
	}
	t.append(el('thead', {}, head));
	const body = el('tbody');
	for (const row of rows.slice(2)) {
		const tr = el('tr');
		for (const c of cells(row)) {
			const td = el('td');
			inline(td, c);
			tr.append(td);
		}
		body.append(tr);
	}
	t.append(body);
	return el('div', { class: 'table-wrap' }, t);
}

/**
 * Lines longer than this are shown as plain text. The inline pattern backtracks
 * on long runs of backticks or `[` — measured at 0.5–0.9 s for 40 000 of them —
 * and a streaming reply is re-rendered every 40 ms, so one odd line (a model
 * echoing page text) would stall the view on every post.
 */
const inlineLimit = 4000;

function inline(parent: HTMLElement, text: string): void {
	if (text.length > inlineLimit) {
		parent.append(text);
		return;
	}
	const pattern = /(`+)([^`]+?)\1|\*\*([^*]+)\*\*|(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
	let at = 0;
	for (const match of text.matchAll(pattern)) {
		if (match.index > at) {
			parent.append(text.slice(at, match.index));
		}
		if (match[2] !== undefined) {
			parent.append(el('code', { text: match[2] }));
		} else if (match[3] !== undefined) {
			// Formatted recursively: `**\`npm test\`**` is how replies name
			// files, and as plain text it showed the backticks.
			const strong = el('strong');
			inline(strong, match[3]);
			parent.append(strong);
		} else if (match[4] !== undefined) {
			const em = el('em');
			inline(em, match[4]);
			parent.append(em);
		} else {
			// A link's address is shown, never followed: a click in a webview
			// would navigate the view itself.
			const link = el('span', { class: 'link', title: match[6] });
			inline(link, match[5]);
			parent.append(link);
		}
		at = match.index + match[0].length;
	}
	if (at < text.length) {
		parent.append(text.slice(at));
	}
}

/* ---------------------------------------------------------------- composer */

/** What the chips were built from: rebuilt only when it changes (#365 — a click straddling a rebuild is lost). */
let attachmentsShown = '';

function renderAttachments(s: ChatViewState): void {
	// The state is posted every 40 ms while any tab streams; rebuilding the
	// chips each time swallowed a click on one whose press outlasted a post,
	// and took keyboard focus off it.
	const shown = JSON.stringify(s.attachments.map(c => [c.id, c.kind, c.label, c.thumbnail?.length]));
	if (shown === attachmentsShown) {
		return;
	}
	attachmentsShown = shown;
	attachmentsRow.replaceChildren(...s.attachments.map(chip => {
		const remove = button([icon('close')], { class: 'chip-remove', title: 'Remove' });
		remove.addEventListener('click', () => post({ type: 'removeAttachment', id: chip.id }));
		let thumb: HTMLElement = icon(attachmentIcon(chip.kind));
		if (chip.thumbnail) {
			const img = el('img', { class: 'thumb' });
			img.src = chip.thumbnail;
			img.alt = '';
			thumb = img;
		}
		// The chip itself opens what it attaches, in an editor tab; the x removes it.
		const open = button([thumb, el('span', { class: 'chip-label', text: chip.label })], { class: 'chip-open', title: `Open ${chip.label}` });
		open.addEventListener('click', () => post({ type: 'openAttachment', id: chip.id }));
		return el('span', { class: 'chip' }, open, remove);
	}));
	attachmentsRow.hidden = !s.attachments.length;
}

function attachmentIcon(kind: AttachmentKind): string {
	switch (kind) {
		case 'screenshot': return 'device-camera';
		case 'element': return 'inspect';
		case 'page': return 'link';
		case 'file': return 'file';
	}
}

function pillContent(label: string): Node[] {
	return [el('span', { class: 'pill-label', text: label }), icon('chevron-down', 'pill-chevron')];
}

function renderSelectors(s: ChatViewState): void {
	const agent = s.agents.find(a => a.id === s.selection.agent);
	agentPill.replaceChildren(...pillContent(agent?.name ?? (s.detecting ? 'Looking…' : 'No agent')));
	agentPill.disabled = !s.agents.some(a => a.available);
	agentPill.title = `Agent — who answers: Claude Code or Codex${agent?.detail ? `\n${agent.name} ${agent.detail}` : ''}\nClick to pick another; the gear in its menu picks which installed copy.`;

	const model = agent?.models.find(m => m.id === s.selection.model);
	modelPill.replaceChildren(...pillContent(model?.label ?? 'Model'));
	modelPill.disabled = !agent?.models.length;
	modelPill.title = `Model — which of the agent's models answers${model?.description ? `\n${model.label}: ${model.description}` : ''}`;

	const efforts = model?.efforts ?? [];
	effortBox.hidden = !efforts.length;
	if (efforts.length) {
		effortRange.max = String(efforts.length - 1);
		effortRange.value = String(Math.max(0, efforts.indexOf(s.selection.effort ?? '')));
		effortLabel.textContent = labelOf(s.selection.effort ?? efforts[0]);
		effortBox.title = `Effort — how hard the model thinks before it answers: ${efforts.map(labelOf).join(' · ')}\nMore effort is slower and uses more of your plan.`;
		effortBox.classList.toggle('max', effortRange.value === effortRange.max);
	}
}

function labelOf(effort: string): string {
	return effort === 'xhigh' ? 'X-High' : effort.charAt(0).toUpperCase() + effort.slice(1);
}

/**
 * Whether a message can go anywhere. While detection runs the host waits for it,
 * so sending is allowed; once it is over with no agent, the draft stays in the
 * box — the send button used to clear it into a refusal.
 */
function canSend(): boolean {
	return !!state && (state.detecting || state.agents.some(a => a.available));
}

function renderSend(): void {
	const running = state?.running ?? false;
	const hasContent = !!input.value.trim() || !!state?.attachments.length;
	const stop = running && !hasContent;
	sendButton.replaceChildren(icon(stop ? 'debug-stop' : 'arrow-up'));
	const queueKey = `${navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl+'}Enter`;
	sendButton.title = stop ? 'Stop — end what the agent is doing now'
		: !canSend() ? 'No agent is available'
		: running ? `Add to the running turn (Enter) — the agent takes it into what it is doing. ${queueKey} queues it for when the turn ends instead.`
		: 'Send (Enter) — Shift+Enter starts a new line';
	queueButton.hidden = !running || !hasContent || !canSend();
	queueButton.title = `Queue — send this when the agent finishes the current turn (${queueKey}). Enter adds it to the turn instead.`;
	sendButton.setAttribute('aria-label', stop ? 'Stop' : 'Send');
	sendButton.classList.toggle('stop', stop);
	sendButton.disabled = !stop && (!hasContent || !canSend());
}

effortRange.addEventListener('input', () => {
	const s = state?.selection ?? {};
	const agent = state?.agents.find(a => a.id === s.agent);
	const efforts = agent?.models.find(m => m.id === s.model)?.efforts ?? [];
	const effort = efforts[Number(effortRange.value)];
	if (effort) {
		effortLabel.textContent = labelOf(effort);
		effortBox.classList.toggle('max', effortRange.value === effortRange.max);
		post({ type: 'select', selection: { agent: s.agent, model: s.model, effort } });
	}
});

function autosize(): void {
	input.style.height = 'auto';
	input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}

/*
 * ↑ / ↓ walk through the messages sent before, as in a terminal: ↑ is older,
 * ↓ newer, and past the newest the text typed before walking comes back.
 * ↑ starts a walk only from an empty box or with the caret at the very start —
 * a long paragraph wraps onto several lines in a narrow side bar, and ↑ there
 * means "the line above", so "no line break before the caret" was not enough:
 * it swapped a draft for the last message. Once walking, ↑ goes on from the
 * first line of the message shown and ↓ from its last. A recalled message is
 * entered at its end, so ↑ first climbs through one of several lines.
 * Typing makes the current text the new starting point, but the draft from
 * before the walk is kept: an edited recalled message is history, not a draft.
 */
let inputHistory: string[] = [];
let historyAt = 0;
let historyDraft = '';
/** The box shows, or was edited from, a recalled message. */
let fromHistory = false;

/** An unedited recalled message is on show. */
function walking(): boolean {
	return historyAt < inputHistory.length && input.value === inputHistory[historyAt];
}

function recall(step: -1 | 1): boolean {
	const next = historyAt + step;
	if (next < 0 || next > inputHistory.length) {
		return false;
	}
	if (historyAt === inputHistory.length && !fromHistory) {
		historyDraft = input.value;
	}
	historyAt = next;
	fromHistory = next < inputHistory.length;
	input.value = fromHistory ? inputHistory[next] : historyDraft;
	input.setSelectionRange(input.value.length, input.value.length);
	saveDraft();
	autosize();
	renderSend();
	return true;
}

input.addEventListener('input', () => {
	historyAt = inputHistory.length;
	fromHistory &&= input.value !== '';
	saveDraft();
	autosize();
	renderSend();
});

input.addEventListener('keydown', event => {
	if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
		event.preventDefault();
		// ⌘Enter (Ctrl+Enter elsewhere) queues it for after the running turn;
		// Enter adds it to the turn — asked for. With nothing running both send.
		send(event.metaKey || event.ctrlKey ? 'queue' : undefined);
		return;
	}
	if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.isComposing
		&& !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
		&& input.selectionStart === input.selectionEnd) {
		const caret = input.selectionStart;
		const onFirstLine = !input.value.slice(0, caret).includes('\n');
		const onLastLine = !input.value.slice(caret).includes('\n');
		const up = !input.value || caret === 0 || (walking() && onFirstLine);
		const down = walking() && onLastLine;
		if ((event.key === 'ArrowUp' && up && recall(-1)) || (event.key === 'ArrowDown' && down && recall(1))) {
			event.preventDefault();
		}
	}
});

sendButton.addEventListener('click', () => {
	if (sendButton.classList.contains('stop')) {
		post({ type: 'stop' });
	} else {
		send();
	}
});

/** `queue`: held until the running turn ends (⌘/Ctrl+Enter); otherwise added to it (Enter). */
function send(mode?: 'queue'): void {
	const text = input.value;
	if ((!text.trim() && !state?.attachments.length) || !canSend()) {
		return;
	}
	launchFlight(text);
	// The host decides whether there is anything to queue behind: the queue can
	// still be waiting to go out for a moment after the turn has ended.
	post({ type: 'send', text, tabId: state?.activeTab, mode });
	historyAt = inputHistory.length;
	historyDraft = '';
	fromHistory = false;
	input.value = '';
	saveDraft();
	autosize();
	renderSend();
	// A sent message always brings the thread down to it.
	requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });
}

/* ---------------------------------------------------------------- the message flying into the chat */

/**
 * A message sent goes from the box into the chat: its text is lifted out of
 * the box where it was typed, and flies to where its prompt appears in the
 * thread — asked for. The prompt's own text is hidden until the flight lands,
 * so there is one copy of the words on screen at every moment. The target is
 * the prompt the host adds, which arrives with a state post a moment later;
 * if none comes (a send still waiting for the agents to be found, a refusal),
 * the text fades where it is. Under reduced motion nothing flies.
 */
interface Flight {
	readonly id: string;
	readonly ghost: HTMLElement;
	readonly text: string;
	readonly chatId: string;
	/**
	 * How many prompts with this text were in the thread when it was sent: this
	 * message's is the next one. Counted on the very nodes it lands on, so a
	 * prompt with no text (attachments alone) or the queue's place in the thread
	 * cannot put it off by one, which a count of entries did.
	 */
	readonly sameBefore: number;
	landed: boolean;
	animation?: Animation;
}

let flight: Flight | undefined;
let flightIds = 0;
const flightWaitMs = 1500;
const flightMs = 420;

function promptsWithText(text: string): HTMLElement[] {
	return [...threadInner.querySelectorAll<HTMLElement>('.prompt .bubble-text')].filter(p => p.textContent === text);
}

function launchFlight(text: string): void {
	dropFlight();
	if (!text.trim() || !state || reducedMotion.matches) {
		return;
	}
	const box = input.getBoundingClientRect();
	const style = getComputedStyle(input);
	const left = box.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth);
	const top = box.top + parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth);
	const width = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
	const height = input.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
	const ghost = el('div', { class: 'flight', text });
	Object.assign(ghost.style, {
		left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`,
		font: style.font, lineHeight: style.lineHeight, color: style.color,
	});
	document.body.append(ghost);
	const launched: Flight = { id: String(++flightIds), ghost, text, chatId: state.chatId, sameBefore: promptsWithText(text).length, landed: false };
	flight = launched;
	setTimeout(() => {
		if (flight === launched && !launched.landed) {
			dropFlight();
		}
	}, flightWaitMs);
}

/** Shows again the prompt nodes a flight hid — its own only, never another flight's target. */
function unhide(current: Flight): void {
	for (const hidden of threadInner.querySelectorAll<HTMLElement>(`[data-flight="${current.id}"]`)) {
		hidden.style.visibility = '';
		delete hidden.dataset.flight;
	}
}

function hide(current: Flight, target: HTMLElement): void {
	target.style.visibility = 'hidden';
	target.dataset.flight = current.id;
}

/**
 * A flight that will not land fades where it is. One that has landed but not
 * yet taken off — superseded between the landing and its frame — is cleared
 * too: left alone, its copy of the words stayed on screen and its prompt hidden.
 */
function dropFlight(): void {
	const current = flight;
	flight = undefined;
	if (!current || (current.landed && current.animation)) {
		return;
	}
	unhide(current);
	current.ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-out' })
		.finished.catch(() => undefined).finally(() => current.ghost.remove());
}

/** This message's prompt: the next one with its text after those there were when it was sent. */
function flightTarget(current: Flight): HTMLElement | undefined {
	return promptsWithText(current.text)[current.sameBefore];
}

function landFlight(s: ChatViewState): void {
	const current = flight;
	if (!current) {
		return;
	}
	if (s.chatId !== current.chatId) {
		// Mid-landing too: finishing over another chat would put this message's
		// words over a conversation it is not in.
		current.animation?.cancel();
		current.animation = undefined;
		dropFlight();
		return;
	}
	const target = flightTarget(current);
	if (current.landed) {
		// A prompt rebuilt in flight (its entry changed) comes back visible, and the
		// words would show twice; the new node is hidden too.
		if (target) {
			hide(current, target);
		}
		return;
	}
	if (!target) {
		return;
	}
	current.landed = true;
	hide(current, target);
	// After the thread has scrolled to the new prompt, or the flight aims at
	// where the prompt was before the scroll.
	requestAnimationFrame(() => {
		if (flight !== current) {
			unhide(current);
			current.ghost.remove();
			return;
		}
		const aim = flightTarget(current) ?? target;
		const from = current.ghost.getBoundingClientRect();
		const to = aim.getBoundingClientRect();
		const toStyle = getComputedStyle(aim);
		const flown = current.ghost.animate([
			{ left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` },
			{ left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px`, font: toStyle.font, lineHeight: toStyle.lineHeight, color: toStyle.color },
		], { duration: flightMs, easing: 'cubic-bezier(.23, 1, .32, 1)', fill: 'forwards' });
		current.animation = flown;
		flown.finished.catch(() => undefined).finally(() => {
			unhide(current);
			current.ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90 })
				.finished.catch(() => undefined).finally(() => current.ghost.remove());
			if (flight === current) {
				flight = undefined;
			}
		});
	});
}

composer.addEventListener('mousedown', event => {
	if (event.target === composer || event.target === toolbar) {
		event.preventDefault();
		input.focus();
	}
});

/* ---------------------------------------------------------------- popups */

function closePopups(except?: HTMLElement): void {
	if (except !== agentsPanel) {
		agentsView = undefined;
	}
	for (const popup of [menu, usagePopup, approvalPopup, historyPanel, agentsPanel, agentAppsPanel]) {
		if (popup !== except) {
			popup.classList.remove('open');
		}
	}
	for (const pill of [agentPill, modelPill, plusButton, usageButton, approveToggle, slashButton]) {
		pill.classList.remove('active');
	}
}

function openAbove(popup: HTMLElement, anchor: HTMLElement, align: 'left' | 'right'): void {
	closePopups(popup);
	anchor.classList.add('active');
	// Relative to the view, not the window: the popup is positioned inside
	// `#app`, and the two only coincide when nothing else is laid out around it.
	const box = app.getBoundingClientRect();
	const rect = anchor.getBoundingClientRect();
	popup.style.bottom = `${box.bottom - rect.top + 6}px`;
	if (align === 'left') {
		popup.style.left = `${Math.max(8, rect.left - box.left)}px`;
		popup.style.right = '';
	} else {
		popup.style.right = `${Math.max(8, box.right - rect.right)}px`;
		popup.style.left = '';
	}
	popup.classList.add('open');
	// Kept inside the view: `#app` clips what overflows it, and a menu opened
	// from a pill near a narrow side bar's right edge lost its right side —
	// with the agent menu's gear, the one way into the agent settings, in it.
	const overflow = popup.getBoundingClientRect().right - (box.right - 8);
	if (align === 'left' && overflow > 0) {
		popup.style.left = `${Math.max(8, rect.left - box.left - overflow)}px`;
	}
}

document.addEventListener('mousedown', event => {
	const target = event.target as Node;
	if (![menu, usagePopup, approvalPopup, historyPanel, agentsPanel, agentAppsPanel, plusButton, usageButton, agentsButton, agentPill, modelPill, approveToggle, slashButton].some(n => n.contains(target))) {
		closePopups();
	}
});

document.addEventListener('keydown', event => {
	if (event.key !== 'Escape') {
		return;
	}
	// The innermost question first: a close being confirmed, then the switch card.
	if (closingTab && state) {
		cancelClosing();
		return;
	}
	if (state?.switchTo) {
		post({ type: 'switchAgent', choice: 'cancel' });
		return;
	}
	closePopups();
});

interface MenuItem {
	readonly icon?: string;
	readonly label: string;
	readonly description?: string;
	readonly checked?: boolean;
	readonly disabled?: boolean;
	readonly run: () => void;
}

/** A button at the right of a menu's heading. */
interface MenuAction {
	readonly icon: string;
	readonly title: string;
	readonly run: () => void;
}

function openMenu(anchor: HTMLElement, items: MenuItem[], heading?: string, action?: MenuAction): void {
	if (menu.classList.contains('open') && anchor.classList.contains('active')) {
		closePopups();
		return;
	}
	let headingAction: HTMLButtonElement | undefined;
	if (action) {
		headingAction = button([icon(action.icon)], { class: 'ghost round menu-heading-action', title: action.title });
		headingAction.addEventListener('click', () => {
			closePopups();
			action.run();
		});
	}
	menu.replaceChildren(
		heading ? el('div', { class: 'menu-heading' }, el('span', { text: heading }), headingAction) : '',
		...items.map(item => {
			const b = button([
				item.icon ? icon(item.icon, 'menu-icon') : el('span', { class: 'menu-icon' }),
				el('span', { class: 'menu-text' },
					el('span', { class: 'menu-label', text: item.label }),
					item.description ? el('span', { class: 'menu-description', text: item.description }) : undefined),
				item.checked ? icon('check', 'menu-check') : el('span', { class: 'menu-check' }),
			], { class: 'menu-item' });
			b.disabled = !!item.disabled;
			b.addEventListener('click', () => {
				closePopups();
				item.run();
			});
			return b;
		}));
	openAbove(menu, anchor, 'left');
}

agentPill.addEventListener('click', () => {
	const s = state;
	if (!s) {
		return;
	}
	openMenu(agentPill, s.agents.map(a => ({
		icon: a.id === 'claude' ? 'sparkle' : 'hubot',
		label: a.name,
		description: a.available ? a.detail?.split(':')[0] : a.problem,
		checked: a.id === s.selection.agent,
		disabled: !a.available,
		run: () => post({ type: 'select', selection: { agent: a.id } }),
	})), 'Agent', { icon: 'gear', title: 'Which Claude Code and Codex apps to use', run: openAgentApps });
});

/* agent apps */

/**
 * Which copy of each agent's CLI this project uses. Detection finds every copy
 * — on PATH, in the usual install places, inside the assistant's own VS Code
 * extension — and uses the newest (Auto); here a project can pick one by hand.
 * VS Code's own `aiBrowser.chat.<agent>Path` setting still overrides both, and
 * a button opens it. Rebuilt only when what it shows changes: a native select
 * whose element is replaced closes under the user's pointer.
 */
let agentAppsShown = '';

function openAgentApps(): void {
	closePopups(agentAppsPanel);
	agentAppsShown = '';
	if (state) {
		fillAgentApps(state);
	}
	agentAppsPanel.classList.add('open');
}

/**
 * A pick waiting for the detection it started: shown in its select until that
 * detection has answered, or the select would jump back to the old copy for as
 * long as detection takes, which reads as the pick being refused.
 */
const pendingPicks = new Map<string, { readonly value: string; readonly at: number; sawDetecting: boolean }>();

function fillAgentApps(s: ChatViewState): void {
	for (const [id, pick] of pendingPicks) {
		if (s.detecting) {
			pick.sawDetecting = true;
		} else if (pick.sawDetecting || Date.now() - pick.at > 10_000) {
			// Answered — or refused by the host, which then starts no detection.
			pendingPicks.delete(id);
		}
	}
	const shape = JSON.stringify([s.detecting, [...pendingPicks], s.agents.map(a => [a.id, a.available, a.problem, a.copies, a.binary, a.choice, a.pinMissing, a.pinned])]);
	if (shape === agentAppsShown) {
		return;
	}
	agentAppsShown = shape;
	const body = el('div', { class: 'history-list agent-apps-body' },
		el('div', { class: 'agents-sub', text: s.detecting
			? 'Looking for the installed copies…'
			: 'Which copy of each agent this project uses. Auto picks the newest one found. Changing it ends a reply in progress with that agent; the conversation carries on with the new copy.' }));
	for (const agent of s.agents) {
		const copies = agent.copies ?? [];
		const label = (copy: { version?: string; source: string; path: string }) => {
			const text = `${copy.version ?? 'unknown version'} — ${copy.source}`;
			// Two copies alike in version and origin (two PATH directories) are
			// told apart by their folder: a native select shows no tooltip.
			const alike = copies.filter(c => `${c.version ?? 'unknown version'} — ${c.source}` === text).length > 1;
			return alike ? `${text} — ${copy.path.replace(/\/[^/]*$/, '')}` : text;
		};
		// Under Auto, the copy Auto is actually using — with equal versions that
		// can be another one than the first listed.
		const autoCopy = (agent.choice === 'auto' ? copies.find(c => c.path === agent.binary) : undefined) ?? copies[0];
		const select = el('select', { class: 'agent-app-select' });
		const auto = el('option', { text: autoCopy ? `Auto — newest (${autoCopy.version ?? 'unknown version'}, ${autoCopy.source})` : 'Auto — newest' });
		auto.value = '';
		select.append(auto);
		for (const copy of copies) {
			const option = el('option', { text: label(copy), title: copy.path });
			option.value = copy.path;
			select.append(option);
		}
		let value = agent.choice === 'pinned' && agent.binary ? agent.binary : '';
		if (agent.pinMissing) {
			// Shown as picked, so that choosing Auto is a change and clears it;
			// selected as Auto, it could not be cleared at all.
			const missing = el('option', { text: `Not found: ${agent.pinned === 'bundled' ? 'the copy bundled with the extension' : agent.pinned ?? 'the copy picked'}` });
			missing.value = '\u0000missing';
			missing.disabled = true;
			select.append(missing);
			value = missing.value;
		}
		select.value = pendingPicks.get(agent.id)?.value ?? value;
		select.disabled = s.detecting || agent.choice === 'setting' || !copies.length;
		select.addEventListener('change', () => {
			pendingPicks.set(agent.id, { value: select.value, at: Date.now(), sawDetecting: false });
			post({ type: 'setAgentBinary', agent: agent.id, path: select.value || undefined });
		});

		const setting = button([el('span', { text: agent.choice === 'setting' ? 'Open the setting' : 'Set a path in VS Code settings…' })], { class: 'agent-app-link' });
		setting.addEventListener('click', () => post({ type: 'openAgentSetting', agent: agent.id }));

		const notes: HTMLElement[] = [];
		if (agent.choice === 'setting') {
			notes.push(el('div', { class: 'agent-app-note', text: `Set by aiBrowser.chat.${agent.id}Path in VS Code settings, which overrides the choice here.` }));
		} else if (agent.pinMissing && copies.length) {
			notes.push(el('div', { class: 'agent-app-note warn', text: 'The copy picked for this project is no longer found; the newest is used. Pick Auto to stop looking for it.' }));
		}
		// Whatever keeps it from working — a setting naming no executable, a
		// picked copy that is signed out or lists no models — is said here, where
		// the copy is chosen.
		if (!agent.available && agent.problem && !s.detecting) {
			notes.push(el('div', { class: 'agent-app-note warn', text: agent.problem }));
		}
		body.append(el('div', { class: 'agent-app' },
			el('div', { class: 'agent-app-name', text: agent.name }),
			select,
			agent.binary ? el('div', { class: 'agent-app-path', text: `In use: ${agent.binary}`, title: agent.binary }) : undefined,
			...notes,
			setting));
	}
	agentAppsPanel.replaceChildren(panelHead('Agent apps'), body);
}

modelPill.addEventListener('click', () => {
	const s = state;
	const agent = s?.agents.find(a => a.id === s.selection.agent);
	if (!s || !agent) {
		return;
	}
	openMenu(modelPill, agent.models.map(m => ({
		label: m.label,
		description: m.description,
		checked: m.id === s.selection.model,
		run: () => post({ type: 'select', selection: { agent: agent.id, model: m.id } }),
	})), `${agent.name} models`);
});

/* the browser button */

browserButton.addEventListener('click', () => post({ type: 'openBrowser' }));

/**
 * The "/" menu. Clear starts the tab over (the conversation stays in the
 * history), asking first when the tab is working, as closing it does; Export
 * asks where to — the clipboard, or a new editor tab to save.
 */
slashButton.addEventListener('click', () => {
	const tab = state?.tabs.find(t => t.id === state?.activeTab);
	const empty = !state?.entries.length;
	openMenu(slashButton, [
		{
			icon: 'clear-all', label: 'Clear conversation', disabled: empty && !tab?.busy,
			description: 'Start this tab over; the conversation stays in the history',
			run: () => {
				if (!tab?.busy && !tab?.queued) {
					post({ type: 'clearChat' });
					return;
				}
				// The second question in the same place, before anything is stopped.
				openMenu(slashButton, [
					{ icon: 'debug-stop', label: 'Stop and clear', description: 'What the agent is doing stops; queued messages come back to the box', run: () => post({ type: 'clearChat' }) },
					{ icon: 'close', label: 'Cancel', run: () => undefined },
				], 'The agent is still working');
			},
		},
		{
			icon: 'export', label: 'Export conversation…', disabled: !state?.entries.some(e => e.kind === 'user' || e.kind === 'assistant'),
			description: 'As Markdown, to the clipboard or a file',
			run: () => openMenu(slashButton, [
				{ icon: 'copy', label: 'Copy to clipboard', run: () => post({ type: 'exportChat', to: 'clipboard' }) },
				{ icon: 'save', label: 'Save to file…', description: 'Opens it in an editor tab and asks where to save', run: () => post({ type: 'exportChat', to: 'file' }) },
			], 'Export conversation'),
		},
	], 'Chat');
});

/* "+" */

const attachItems: { kind: AttachmentKind; icon: string; label: string; needsTab: boolean }[] = [
	{ kind: 'screenshot', icon: 'device-camera', label: 'Screenshot of the page', needsTab: true },
	{ kind: 'element', icon: 'inspect', label: 'Element from the page…', needsTab: true },
	{ kind: 'page', icon: 'link', label: 'Page address', needsTab: true },
	{ kind: 'file', icon: 'file', label: 'File…', needsTab: false },
];

plusButton.addEventListener('click', () => {
	// Without the grant no tab can be seen at all, so "open a page" would send
	// the user the wrong way (Recipe, step 3: two guards, two messages).
	const pageProblem = !state?.browserApi
		? 'Browser API not enabled — use "Enable Browser API" in the status bar'
		: !state.hasBrowserTab ? 'Open a page in the browser first' : undefined;
	openMenu(plusButton, attachItems.map(item => ({
		icon: item.icon,
		label: item.label,
		description: item.needsTab ? pageProblem : undefined,
		disabled: item.needsTab && !!pageProblem,
		run: () => post({ type: 'attach', kind: item.kind }),
	})), 'Attach');
});

/* "U" */

usageButton.addEventListener('click', () => {
	if (usagePopup.classList.contains('open')) {
		closePopups();
		return;
	}
	renderUsage([], undefined, true);
	openAbove(usagePopup, usageButton, 'right');
	post({ type: 'usage' });
});

function renderUsage(usage: readonly AgentUsage[], stats: ChatStats | undefined, loading: boolean): void {
	const sections: HTMLElement[] = [];
	if (loading) {
		sections.push(el('div', { class: 'usage-loading' }, el('span', { class: 'shimmer', text: 'Asking the agents…' })));
	}
	for (const u of usage) {
		const name = state?.agents.find(a => a.id === u.agent)?.name ?? u.agent;
		const section = el('div', { class: 'usage-section' },
			el('div', { class: 'usage-head' },
				el('span', { class: 'usage-agent', text: name }),
				u.plan ? el('span', { class: 'usage-plan', text: u.plan }) : undefined));
		for (const w of u.windows) {
			const used = Math.max(0, Math.min(100, w.usedPercent));
			const fill = el('div', { class: 'bar-fill' });
			fill.style.width = `${used}%`;
			const bar = el('div', { class: `bar${used >= 80 ? ' high' : ''}` }, fill);
			section.append(el('div', { class: 'usage-window' },
				el('div', { class: 'usage-row' },
					el('span', { text: w.label }),
					el('span', { class: 'usage-value', text: `${Math.round(used)}%` })),
				bar,
				w.resetsAt ? el('div', { class: 'usage-reset', text: `Resets ${resetText(w.resetsAt)}` }) : undefined));
		}
		for (const note of u.notes) {
			section.append(el('div', { class: 'usage-note', text: note }));
		}
		if (u.error) {
			section.append(el('div', { class: 'usage-error', text: u.error }));
		}
		sections.push(section);
	}
	if (!loading && !usage.length) {
		sections.push(el('div', { class: 'usage-note', text: 'No agent is available.' }));
	}
	if (stats && stats.turns) {
		const rows: [string, string][] = [
			['Messages', String(stats.turns)],
			['Input tokens', stats.inputTokens.toLocaleString()],
			['Cached', stats.cachedTokens.toLocaleString()],
			['Output tokens', stats.outputTokens.toLocaleString()],
		];
		if (stats.costUsd !== undefined) {
			rows.push(['Cost (API prices)', `$${stats.costUsd.toFixed(stats.costUsd < 1 ? 4 : 2)}`]);
		}
		sections.push(el('div', { class: 'usage-section' },
			el('div', { class: 'usage-head' }, el('span', { class: 'usage-agent', text: 'This chat' })),
			...rows.map(([k, v]) => el('div', { class: 'usage-row' }, el('span', { text: k }), el('span', { class: 'usage-value', text: v })))));
	}
	usagePopup.replaceChildren(...sections);
}

function resetText(at: number): string {
	const minutes = Math.round((at - Date.now()) / 60000);
	if (minutes <= 0) {
		return 'now';
	}
	if (minutes < 60) {
		return `in ${minutes} min`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 48) {
		return `in ${hours} h ${minutes % 60} min`;
	}
	return `on ${new Date(at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}`;
}

/* agents */

/**
 * The agents the chat's agent started — Claude Code's `Agent` calls, Codex's
 * `spawnAgent` — read from the chat's own rows, so nothing is asked of the CLI.
 * The toolbar button counts the running ones (or, with none running, shows the
 * total, muted) and is hidden while the chat has none. It opens a list; a row
 * opens the agent's card, laid out after the Claude Code panel's: status, type,
 * model, time, tokens, its report, then its prompt and its tool calls folded.
 */
let agentsView: { selected?: string } | undefined;

function agentRows(s: ChatViewState): ToolEntry[] {
	return s.entries.filter((e): e is ToolEntry => e.kind === 'tool' && e.tool === 'agent');
}

function renderAgents(s: ChatViewState): void {
	const agents = agentRows(s);
	const running = agents.filter(a => a.status === 'running').length;
	agentsButton.hidden = !agents.length;
	agentsButton.classList.toggle('live', running > 0);
	const count = String(running || agents.length);
	if (agentsButton.textContent !== count) {
		agentsButton.replaceChildren(icon('hubot'), el('span', { text: count }));
	}
	agentsButton.title = `${running} running · ${agents.length} agent${agents.length === 1 ? '' : 's'} in this chat`;
	if (agentsView && !agents.length) {
		// New Chat, or another chat from the history, with the panel open: its
		// button is gone, so the panel goes too rather than reading "0 agents".
		closePopups();
	} else if (agentsView) {
		fillAgents(agents);
	}
}

agentsButton.addEventListener('click', () => {
	if (agentsPanel.classList.contains('open')) {
		closePopups();
		return;
	}
	agentsView = {};
	closePopups(agentsPanel);
	fillAgents(currentAgents(), true);
	agentsPanel.classList.add('open');
});

function statusLabel(a: ToolEntry): string {
	return a.status === 'running' ? 'Running' : a.status === 'done' ? 'Finished' : a.status === 'stopped' ? 'Stopped' : 'Failed';
}

/** `claude-haiku-5-5` → `Haiku 5.5`; other ids as they are. */
function modelName(id: string | undefined): string | undefined {
	const m = id ? /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id) : undefined;
	return m ? `${m[1].charAt(0).toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}` : id;
}

function agentTitle(a: ToolEntry): string {
	return a.detail || (a.input ?? '').split('\n')[0] || a.name;
}

function agentNumbers(a: ToolEntry): string {
	const ms = a.agent?.durationMs ?? ((a.endedAt ?? Date.now()) - a.startedAt);
	return [duration(ms), a.agent?.tokens !== undefined ? `${compact(a.agent.tokens)} tokens` : undefined].filter(Boolean).join(' · ');
}

/**
 * The parts of an agent's row and card that change while it works — time,
 * tokens, the tool it is on — keyed by `data-live`. They are rewritten in
 * place; everything else is rebuilt only when it changes (`agentsShape`).
 * Rebuilding on every state post (every 40 ms while a reply streams) swallowed
 * clicks whose press and release straddled a post, cleared any selection in the
 * report and threw focus to the body — while agents run, which is when the
 * panel is used.
 */
function agentLive(a: ToolEntry, part: string): string {
	switch (part) {
		case 'status':
			return a.status === 'running' && a.agent?.lastTool ? `Running · ${a.agent.lastTool}` : statusLabel(a);
		case 'numbers':
			return ` · ${agentNumbers(a)}`;
		default: {
			const uses = a.agent?.toolUses;
			return [agentNumbers(a), uses !== undefined ? `${uses} tool use${uses === 1 ? '' : 's'}` : undefined].filter(Boolean).join(' · ');
		}
	}
}

function liveSpan(tag: 'span' | 'div', a: ToolEntry, part: string, cls: string): HTMLElement {
	const node = el(tag, { class: cls, text: agentLive(a, part) });
	node.dataset.live = `${a.id}\n${part}`;
	return node;
}

/** Agents the user asked to stop, until their row says they have. */
const stoppingAgents = new Set<string>();

/**
 * Stops one agent: the turn and the other agents go on. Only a running agent
 * has the button, and it says so while the CLI takes it.
 */
function stopButton(a: ToolEntry): HTMLButtonElement {
	const stopping = stoppingAgents.has(a.id);
	const b = button([icon('debug-stop'), el('span', { text: stopping ? 'Stopping…' : 'Stop' })], { class: 'agent-stop', title: 'Stop this agent' });
	b.disabled = stopping;
	b.addEventListener('click', event => {
		event.stopPropagation();
		stoppingAgents.add(a.id);
		post({ type: 'stopAgent', id: a.id });
		fillAgents(currentAgents(), true);
	});
	return b;
}

/** What the panel shows, minus the parts `agentLive` keeps current. */
function agentsShape(agents: ToolEntry[]): string {
	// Only the agents shown can say they have stopped: a stop still pending in
	// another tab is not this list's to clear.
	for (const id of stoppingAgents) {
		if (agents.some(a => a.id === id && a.status !== 'running')) {
			stoppingAgents.delete(id);
		}
	}
	return JSON.stringify([agentsView?.selected ?? '', [...stoppingAgents], agents.map(a => {
		const { tokens: _t, durationMs: _d, toolUses: _u, lastTool: _l, ...rest } = a.agent ?? { calls: [] };
		return [a.id, a.status, a.detail, a.input, a.agent?.summary ? '' : a.output, rest];
	})]);
}

let agentsShown = '';
let agentsPending = false;
let agentsPointer = false;
let agentsTimer: ReturnType<typeof setInterval> | undefined;

function selectionInAgents(): boolean {
	const sel = document.getSelection();
	return !!sel && !sel.isCollapsed && !!sel.anchorNode && agentsPanel.contains(sel.anchorNode);
}

function refreshAgentsLive(agents: ToolEntry[]): void {
	const byId = new Map(agents.map(a => [a.id, a]));
	for (const node of agentsPanel.querySelectorAll<HTMLElement>('[data-live]')) {
		const [id, part] = (node.dataset.live ?? '').split('\n');
		const a = byId.get(id);
		const text = a ? agentLive(a, part) : undefined;
		if (text !== undefined && node.textContent !== text) {
			node.textContent = text;
		}
	}
}

function currentAgents(): ToolEntry[] {
	return state ? agentRows(state) : [];
}

agentsPanel.addEventListener('pointerdown', () => { agentsPointer = true; });
window.addEventListener('pointerup', () => {
	agentsPointer = false;
	// After the click this press belongs to has been dispatched.
	if (agentsPending) {
		setTimeout(() => fillAgents(currentAgents()), 0);
	}
});
document.addEventListener('selectionchange', () => {
	if (agentsPending && !agentsPointer && !selectionInAgents()) {
		fillAgents(currentAgents());
	}
});

function fillAgents(agents: ToolEntry[], force = false): void {
	if (!agentsView) {
		return;
	}
	agentsTimer ??= setInterval(() => {
		if (!agentsView) {
			clearInterval(agentsTimer);
			agentsTimer = undefined;
			return;
		}
		refreshAgentsLive(currentAgents());
	}, 1000);
	const shape = agentsShape(agents);
	if (!force && shape === agentsShown) {
		refreshAgentsLive(agents);
		return;
	}
	if (!force && (agentsPointer || selectionInAgents())) {
		agentsPending = true;
		refreshAgentsLive(agents);
		return;
	}
	agentsPending = false;
	agentsShown = shape;
	// Keep the reader where they were unless they moved between the list and a card.
	const view = agentsView.selected ?? '';
	const scroll = agentsPanel.dataset.view === view ? agentsPanel.querySelector('.history-list')?.scrollTop ?? 0 : 0;
	agentsPanel.dataset.view = view;
	const restore = () => {
		const list = agentsPanel.querySelector('.history-list');
		if (list) {
			list.scrollTop = scroll;
		}
	};
	const close = button([icon('close')], { class: 'ghost round', title: 'Close' });
	close.addEventListener('click', () => closePopups());
	const selected = agentsView.selected ? agents.find(a => a.id === agentsView!.selected) : undefined;

	if (!selected) {
		const head = panelHead('Agents');
		const running = agents.filter(a => a.status === 'running').length;
		const list = el('div', { class: 'history-list' },
			el('div', { class: 'agents-sub', text: `${agents.length} agent${agents.length === 1 ? '' : 's'}${running ? ` · ${running} running` : ''} · click an agent for details` }));
		for (const a of [...agents].reverse()) {
			const row = button([
				el('span', { class: `agent-dot ${a.status}` }),
				el('span', { class: 'agent-text' },
					el('span', { class: 'agent-title', text: agentTitle(a) }),
					el('span', { class: 'agent-meta' },
						liveSpan('span', a, 'status', a.status === 'running' ? 'agent-live' : ''),
						liveSpan('span', a, 'numbers', ''))),
				icon('chevron-right', 'agent-chevron'),
			], { class: 'agent-row', title: agentTitle(a) });
			row.addEventListener('click', () => {
				agentsView = { selected: a.id };
				fillAgents(currentAgents(), true);
			});
			list.append(a.status === 'running' ? el('div', { class: 'agent-item' }, row, stopButton(a)) : row);
		}
		agentsPanel.replaceChildren(head, list, panelFooter());
		restore();
		return;
	}

	const back = button([icon('arrow-left')], { class: 'ghost round', title: 'All agents' });
	back.addEventListener('click', () => {
		agentsView = {};
		fillAgents(currentAgents(), true);
	});
	const head = el('div', { class: 'history-head agent-head' },
		el('span', { class: 'agent-head-title' }, back, el('span', { class: `agent-dot ${selected.status}` }), el('span', { class: 'agent-title', text: agentTitle(selected), title: agentTitle(selected) })),
		el('span', { class: 'agent-head-end' }, selected.status === 'running' ? stopButton(selected) : undefined, close));
	const info = selected.agent;
	const body = el('div', { class: 'history-list agent-card' },
		el('div', { class: 'agent-line', text: [statusLabel(selected), info?.type, modelName(info?.model), info?.background ? 'background' : undefined].filter(Boolean).join(' · ') }),
		el('div', { class: 'agent-line', text: spawnedBy(info?.type) }),
		liveSpan('div', selected, 'card', 'agent-line'));
	const report = info?.summary ?? (selected.status !== 'running' ? selected.output : undefined);
	body.append(report
		? el('div', { class: 'agent-report markdown' }, renderMarkdown(report))
		: el('div', { class: 'agent-report' }, el('span', { class: selected.status === 'running' ? 'shimmer' : 'faint', text: selected.status === 'running' ? 'Working…' : 'No report.' })));
	if (selected.input) {
		body.append(fold(`agent-prompt:${selected.id}`, 'Prompt', el('div', { class: 'agent-prompt', text: selected.input })));
	}
	const calls = info?.calls ?? [];
	body.append(fold(`agent-calls:${selected.id}`, `Tool calls (${calls.length})`,
		el('div', { class: 'agent-calls' }, ...calls.map(c => el('div', { class: 'agent-call' },
			el('span', { class: 'agent-call-name', text: c.name }),
			c.detail ? el('span', { class: 'agent-call-detail', text: c.detail, title: c.detail }) : undefined)))));
	agentsPanel.replaceChildren(head, body, panelFooter());
	restore();
}

/** A Close at the bottom of a long panel — asked for: the X at the top is far once the list is scrolled. */
function panelFooter(): HTMLElement {
	const close = button([el('span', { text: 'Close' })], { class: 'panel-close', title: 'Close (Escape)' });
	close.addEventListener('click', () => closePopups());
	return el('div', { class: 'panel-footer' }, close);
}

/** Codex names an agent by its path, `/root/<parent>/<agent>`; the one before it started it. */
function spawnedBy(type: string | undefined): string {
	const path = type?.startsWith('/') ? type.split('/').filter(Boolean) : [];
	return path.length > 2 ? `Spawned by ${path[path.length - 2].replace(/[_-]+/g, ' ')}` : 'Spawned by the main agent';
}

/** A folded section that stays as the user left it across re-renders. */
function fold(key: string, label: string, content: HTMLElement): HTMLElement {
	const details = el('details', { class: 'agent-fold' }, el('summary', {}, icon('chevron-right', 'chevron'), el('span', { text: label })), content);
	details.open = toggled.get(key) ?? false;
	details.addEventListener('toggle', () => toggled.set(key, details.open));
	return details;
}

/* history */

function toggleHistory(chats: readonly ChatSummary[]): void {
	if (historyPanel.classList.contains('open')) {
		closePopups();
		return;
	}
	fillHistory(chats);
	closePopups(historyPanel);
	historyPanel.classList.add('open');
}

/**
 * The heading of a panel drawn over the chat: a back arrow before the title and
 * a close button at the right, both closing it — the arrow is where a back
 * button is looked for in a side bar.
 */
function panelHead(title: string): HTMLElement {
	const back = button([icon('arrow-left')], { class: 'ghost round', title: 'Back' });
	back.addEventListener('click', () => closePopups());
	const close = button([icon('close')], { class: 'ghost round', title: 'Close' });
	close.addEventListener('click', () => closePopups());
	return el('div', { class: 'history-head' }, el('span', { class: 'panel-title' }, back, el('span', { text: title })), close);
}

function fillHistory(chats: readonly ChatSummary[]): void {
	const header = panelHead('History');

	const list = el('div', { class: 'history-list' });
	if (!chats.length) {
		list.append(el('div', { class: 'history-empty', text: 'No chats yet.' }));
	}
	for (const chat of chats) {
		const open = button([
			el('span', { class: 'history-title', text: chat.title }),
			el('span', { class: 'history-meta', text: `${state?.agents.find(a => a.id === chat.agent)?.name ?? chat.agent} · ${ago(chat.updatedAt)}` }),
		], { class: 'history-item', title: chat.title });
		open.classList.toggle('current', chat.id === state?.chatId);
		open.addEventListener('click', () => {
			closePopups();
			post({ type: 'openChat', id: chat.id });
		});
		const remove = button([icon('trash')], { class: 'ghost round history-delete', title: 'Delete' });
		remove.addEventListener('click', () => post({ type: 'deleteChat', id: chat.id }));
		list.append(el('div', { class: 'history-row' }, open, remove));
	}
	historyPanel.replaceChildren(header, list);
}

function ago(at: number): string {
	const minutes = Math.round((Date.now() - at) / 60000);
	if (minutes < 1) {
		return 'just now';
	}
	if (minutes < 60) {
		return `${minutes} min ago`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `${hours} h ago`;
	}
	return new Date(at).toLocaleDateString();
}

autosize();
post({ type: 'ready' });
