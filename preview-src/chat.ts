import { localFileLink } from '../src/chat/fileLinks';
import { sleepMinutes, sleepHours, type SleepChoice } from '../src/power/sleepProtocol';
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
	AgentId, AgentQuestion, AgentUsage, ApprovalEntry, UsageAlert, ToolbarParam, ToolbarResult, ToolbarRun, ToolbarSkill, ApprovalKind, ApprovalMode, AttachmentKind, ChatCommand, ChatEntry, ChatStats, ChatSummary, ChatTabStatus, ChatTabSummary, ChatViewState, HostToView, RepoMode, ToolEntry, ViewToHost, WorkdirFolder,
} from '../src/chat/chatProtocol';
import { baseName, searchPaths } from './fileRank';
// Every codicon the bundled font has, one per line (`name,char,code`); bundled
// as text by esbuild, so the icon picker lists exactly what can be drawn.
import codiconCsv from '@vscode/codicons/dist/codicon.csv';

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
const slashButton = button([el('span', { class: 'slash-mark' })], { class: 'ghost round slash-button', title: 'Commands and skills — the agent\'s skills, and clearing or exporting this conversation. Type / in the message box to search them there' });
/** The working folder: where the tab's agent works, and the files of it to attach. */
const workdirButton = button([icon('folder')], { class: 'ghost round workdir-button', title: 'Working folder' });
const agentPill = button([], { class: 'pill', title: 'Agent' });
const modelPill = button([], { class: 'pill', title: 'Model' });
const effortRange = el('input', { class: 'effort-range' });
effortRange.type = 'range';
effortRange.min = '0';
effortRange.step = '1';
const effortLabel = el('span', { class: 'effort-label' });
const effortBox = el('label', { class: 'effort', title: 'Effort' }, effortRange, effortLabel);
const effortButton = button([], { class: 'pill effort-button', title: 'Effort' });
effortButton.hidden = true;
const usageTitle = "Usage — your plan's limits for each agent, and this chat's tokens and cost";
const usageButton = button([el('span', { class: 'u-mark', text: 'U' })], { class: 'ghost round usage-button', title: usageTitle });
const agentsButton = button([], { class: 'pill agents-button', title: 'Agents' });
/** How full the conversation's context is, as a pie that fills; a click compacts it. */
const sleepButton = button([], { class: 'ghost round sleep-button', title: 'Keep computer awake' });
const sleepPopup = el('div', { class: 'popup sleep-popup' });
const contextPie = el('span', { class: 'context-pie' });
const contextButton = button([contextPie], { class: 'ghost round context-button' });
contextButton.hidden = true;
const sendButton = button([icon('arrow-up')], { class: 'send', title: 'Send' });
/**
 * Only while a turn runs and there is something to send: hold it for after the
 * turn. Shown below Send in the input's action column; Send adds the
 * message to the running turn instead.
 */
const queueButton = button([icon('arrow-up')], { class: 'send queue-button', title: 'Send after this turn (⌘Enter)' });
queueButton.hidden = true;
queueButton.addEventListener('click', () => send('queue'));
/** Ask before terminal commands and browser tools, or let them run: one switch for every tab. */
const approveToggle = button([], { class: 'pill approve-toggle' });

// Settings and tools get deliberate rows in a narrow composer.
const toolbarSettings = el('div', { class: 'toolbar-settings' }, agentPill, modelPill, effortBox, effortButton, approveToggle);
const toolbarAttachments = el('span', { class: 'toolbar-attachments' }, plusButton, browserButton, slashButton);
const toolbarEnd = el('span', { class: 'toolbar-end' }, agentsButton, contextButton, usageButton);
const toolbar = el('div', { class: 'toolbar' }, toolbarAttachments, toolbarSettings, toolbarEnd);
/**
 * The box's text drawn again behind it, with the agent's commands in colour:
 * a textarea cannot style part of its text, so this layer shows the text and
 * the textarea above it draws only the caret and the selection, its own
 * glyphs transparent. Same font, padding, wrapping and scroll.
 */
const inputMirror = el('div', { class: 'input-mirror' });
inputMirror.setAttribute('aria-hidden', 'true');
const inputWrap = el('div', { class: 'input-wrap' }, inputMirror, input);
const inputActions = el('div', { class: 'input-actions' },
	el('span', { class: 'send-slot' }, sendButton), el('span', { class: 'send-slot' }, queueButton));
const inputArea = el('div', { class: 'input-area' }, inputWrap, inputActions);
const composer = el('div', { class: 'composer' }, attachmentsRow, inputArea, toolbar);
/** Asked when another agent is picked for a conversation that has started. */
const switchCard = el('div', { class: 'switch-card' });
/** The toolbar skills the tab's agent offers, above the message box. */
const skillAddButton = button([icon('add')], { class: 'skill-button skill-add', title: 'Add skill to toolbar' });
skillAddButton.setAttribute('aria-label', 'Add skill to toolbar');
skillAddButton.dataset.tip = 'Add skill to toolbar';
skillAddButton.addEventListener('click', () => openSkillEditor());
const skillList = el('div', { class: 'skill-list' });
const skillExpandButton = button([icon('chevron-up')], { class: 'skill-button skill-add skill-expand', title: 'Show all skills' });
skillExpandButton.hidden = true;
skillExpandButton.setAttribute('aria-expanded', 'false');
const skillBar = el('div', { class: 'skill-bar' }, skillAddButton, skillList, skillExpandButton);
skillExpandButton.addEventListener('click', () => {
	const expanded = skillBar.classList.toggle('expanded');
	updateSkillExpandButton(expanded);
});
/** A question with choices the agent waits on: answered here, above the message box, a tab per question. */
const questionDock = el('div', { class: 'question-dock' });
questionDock.hidden = true;
const workdirMode = el('span', { class: 'workdir-mode' });
const workdirLocationText = el('span', { class: 'workdir-location-value' });
const workdirLocation = el('span', { class: 'workdir-location' }, workdirLocationText);
const workdirSummary = button([workdirMode, workdirLocation], { class: 'workdir-summary', title: 'Working folder' });
const workdirFooter = el('div', { class: 'workdir-status' }, workdirButton, workdirSummary, sleepButton);
const footer = el('div', { class: 'footer' }, questionDock, switchCard, skillBar, composer, workdirFooter);
workdirSummary.addEventListener('click', () => workdirButton.click());
/** One tab per open conversation, above the thread. */
const tabStrip = el('div', { class: 'tab-strip' });
/**
 * A plan limit near its end, reached, or credits being spent, for the agent of
 * the tab in front: a line between the tabs and the thread. Built once and
 * refilled; see `renderUsageAlert`.
 */
const usageAlertText = el('span', { class: 'usage-alert-text' });
const usageAlertClose = button([icon('close')], { class: 'usage-alert-close' });
const usageAlertBar = el('div', { class: 'usage-alert' },
	el('span', { class: 'u-mark', text: 'U' }), usageAlertText, usageAlertClose);
usageAlertBar.hidden = true;
usageAlertBar.setAttribute('role', 'status');

const menu = el('div', { class: 'popup menu' });
const usagePopup = el('div', { class: 'popup usage-popup' });
const approvalPopup = el('div', { class: 'popup approval-popup' });
/** The "/" palette: a search box over the chat's commands and the agent's skills. */
const palette = el('div', { class: 'popup palette' });
/** The folder button's list: folders to work in, then the files of the one in use. */
const workdirPopup = el('div', { class: 'popup palette workdir-popup' });
/** Adding or editing a toolbar skill: a panel over the chat. */
const skillEditor = el('div', { class: 'history-panel skill-editor' });
/** A toolbar skill's parameters, asked for when it runs; or its run, while it runs. */
const paramsPopup = el('div', { class: 'popup params-popup' });
const historyPanel = el('div', { class: 'history-panel' });
const agentsPanel = el('div', { class: 'history-panel agents-panel' });
/** Which copy of each agent's CLI this project uses: opened from the gear in the agent menu. */
const agentAppsPanel = el('div', { class: 'history-panel agent-apps' });

app.append(sleepPopup, tabStrip, usageAlertBar, thread, blocked, footer, menu, usagePopup, approvalPopup, palette, workdirPopup, paramsPopup, skillEditor, historyPanel, agentsPanel, agentAppsPanel);

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
	if (paletteMode === 'inline') {
		closePalette();
	}
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
		case 'localLinkInfo': {
			const pending = pendingLocalLinkMenu;
			if (pending?.request === message.request) {
				pendingLocalLinkMenu = undefined;
				if (pending.link.isConnected) { linkMenu(pending.link, pending.url, message.directory, message.inWorkspace); }
			}
			return;
		}
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
		case 'toolbarSaved':
			if (skillEditor.classList.contains('open')) {
				closePopups();
				input.focus();
			}
			return;
		case 'toolbarError':
			showEditorError(message.message);
			return;
		case 'githubAnswer':
			// Only the form it answers: closed meanwhile, there is nothing to say.
			if (repoFormError?.isConnected && paramsPopup.classList.contains('open')) {
				if (message.error === undefined) {
					closePopups();
					input.focus();
				} else {
					repoFormError.textContent = message.error;
					repoFormSubmit?.removeAttribute('disabled');
				}
			}
			return;
		case 'workdirFiles':
			// Kept by folder: two listings can be in flight at once, a slow one for
			// the tab left behind arriving after the one for the tab in front.
			workdirListings.set(message.folder, { entries: message.entries, truncated: message.truncated, revision: ++workdirRevision });
			while (workdirListings.size > 8) {
				workdirListings.delete(workdirListings.keys().next().value!);
			}
			if (state) {
				renderWorkdir(state);
			}
			return;
		case 'restoreDraft':
			// Stop gave the queue back: added to what is in the box, never sent.
			if (message.chatId === state?.chatId) {
				if (paletteMode === 'inline') {
					closePalette();
				}
				// A message recalled with ↑ ends its walk here, and the queue is
				// added to the draft from before the walk, not to the message on
				// show: built on the recalled text, the draft typed before ↑ was lost
				// for good, and the queued message — usually the newest in the
				// history, so the one recalled — went in twice. Left walking, the
				// queue given back was lost at the next tab switch instead.
				const base = currentDraft();
				fromHistory = false;
				historyAt = inputHistory.length;
				input.value = base.trim() ? `${base}\n\n${message.text}` : message.text;
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
	const commands = [...knownCommands(state)].join(' ');
	if (commands !== commandsSignature) {
		commandsSignature = commands;
		paintInput();
	}
	renderTabs(state);
	renderSwitch(state);
	renderQuestionDock(state);
	renderThread(state);
	landFlight(state);
	renderAttachments(state);
	renderSelectors(state);
	renderApproveToggle(state);
	renderSend();
	renderContext(state);
	renderSleep();
	renderUsageLevel(state);
	renderUsageAlert(state);
	renderAgents(state);
	renderSkillBar(state);
	renderPalette(state);
	renderWorkdir(state);
	if (agentAppsPanel.classList.contains('open')) {
		fillAgentApps(state);
	}
	scheduleToolbarLayout();
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
	if (closingTab && !s.tabs.some(t => t.id === closingTab && (t.busy || t.queued || t.skillRuns))) {
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
	return JSON.stringify([t.title, t.status, t.agents, t.skillRuns, t.busy, agent]);
}

/**
 * What closing, clearing or replacing a tab's chat stops: its reply, and its
 * agents — the toolbar skills run in the background from it among them, which
 * stop when the tab lets go of the chat.
 */
function stoppedParts(t: ChatTabSummary): string[] {
	const agents = t.agents + (t.skillRuns ?? 0);
	return [t.busy ? 'its reply' : '', agents ? `${agents} agent${agents === 1 ? '' : 's'}` : ''].filter(Boolean);
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
		if (node.tab.busy || node.tab.queued || node.tab.skillRuns) {
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

/** A tab's agents still working, its background toolbar runs included. */
function agentsOf(t: ChatTabSummary): number {
	return t.agents + (t.skillRuns ?? 0);
}

function fillTab(node: TabNode, agent: string | undefined): void {
	const t = node.tab;
	const parts: (HTMLElement | undefined)[] = [
		tabMark(t.status),
		el('span', { class: 'tab-title', text: t.title }),
		agentsOf(t) ? el('span', { class: 'tab-agents', text: String(agentsOf(t)), title: `${agentsOf(t)} agent${agentsOf(t) === 1 ? '' : 's'} working` }) : undefined,
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
	const shown = closing ? JSON.stringify([closing.id, closing.title, closing.agents, closing.skillRuns, closing.busy, closing.queued]) : '';
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
	const parts = stoppedParts(closing);
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
	const shown = JSON.stringify([to?.id, from?.id, tab?.busy, tab?.agents, tab?.skillRuns, s.tabs.length, s.tabLimit]);
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
	const stopping = stoppedParts(tab);
	const stops = stopping.length
		? `This chat is still working; ${stopping.join(' and ')} will be stopped.`
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

/** The row a pointer is pressed in, kept as it is until the press ends; see `renderThread`. */
let pressedRow: Element | undefined;
/** A rebuild of the pressed row was held back, and is due when the press ends. */
let pressedPending = false;

threadInner.addEventListener('pointerdown', event => {
	pressedRow = (event.target as Element).closest('.row') ?? undefined;
});
function pressEnded(): void {
	if (!pressedRow) {
		return;
	}
	pressedRow = undefined;
	if (pressedPending) {
		pressedPending = false;
		// After the click this press belongs to has been dispatched.
		setTimeout(render, 0);
	}
}
window.addEventListener('pointerup', pressEnded);
window.addEventListener('pointercancel', pressEnded);
window.addEventListener('blur', pressEnded);

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
	// The welcome took the spacer's place, and the chat id does not change when
	// a fresh tab gets its first message, so the reset above never put it back:
	// every new conversation sat at the top of the panel until the tab was
	// switched away and back.
	if (spacer.parentElement !== threadInner) {
		threadInner.prepend(spacer);
	}

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
			// Not under a press: a running command's row changes with every
			// chunk of output, and a rebuild between press and release lost the
			// click on it (#365). Its old signature stays, so it is rebuilt once
			// the press ends.
			if (rendered[i] && pressedRow && rendered[i].node.contains(pressedRow)) {
				pressedPending = true;
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
			el('span', { text: p.kind !== 'queue' ? 'Waiting for the agent to take it in'
				: p.skill?.background ? `/${p.skill.name} — runs in the background when this turn ends`
				: p.skill && p.skill.steps === 1 ? `/${p.skill.name} — sent when this turn ends`
				: p.skill ? `/${p.skill.name}, prompt ${p.skill.step} of ${p.skill.steps} — ${p.skill.check ? `sent if: ${p.skill.check}` : 'sent when the turn before it ends'}`
					: 'Sent when this turn ends' }));
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
	// A prompt is rebuilt when the agent's commands change too, so they are
	// marked once they have been listed. A row, when "Fold Tool Calls" changes:
	// without it the rows already on screen kept the old setting until another
	// chat was shown. A row the user opened or closed keeps that either way.
	return entry.kind === 'user' ? `${JSON.stringify(entry)}|${commandsSignature}`
		: `${JSON.stringify(entry)}|${toggled.get(keyOf(entry, i)) ?? ''}|${openByDefault()}`;
}

/** The commands the marks are drawn from, as one string; set at the top of every render. */
let commandsSignature = '';

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
		// The agent is stopped on the user: no phrase of work while it is.
		workingNode.dataset.waiting = s.entries.some(e => e.kind === 'approval' && e.status === 'pending') ? '1' : '';
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
	// The turn is over and agents it (or an earlier one) started still work:
	// said at the very bottom, under "Worked for …" (asked for).
	const runningAgents = last ? agentRows(s).filter(a => a.status === 'running') : [];
	const agents = runningAgents.length;
	// How long the background work has gone on: since the first of them started.
	const agentsSince = agents ? Math.min(...runningAgents.map(a => a.startedAt)) : 0;
	const sig = `${text}|${tokens}|${agents}|${agentsSince}`;
	if (tail.dataset.sig !== sig) {
		tail.dataset.sig = sig;
		// A square where the working star was: the same slot, so the line does
		// not shift when the turn ends.
		tail.replaceChildren(
			text
				? el('div', { class: 'worked' },
					el('span', { class: 'working-glyph done', text: '■' }),
					el('span', { class: 'worked-text', text }),
					tokens ? el('span', {
						class: 'worked-tokens', text: tokens,
						title: `${(p?.tokensIn ?? 0).toLocaleString()} tokens sent${p?.tokensCached ? `, ${p.tokensCached.toLocaleString()} of them from the cache` : ''}; ${(p?.tokensOut ?? 0).toLocaleString()} received`,
					}) : undefined)
				: '',
			agents ? agentsRunningLine(agents, agentsSince) : '');
	}
}

/**
 * "2 agents running · 3m 12s", under a finished turn while agents the chat
 * started are still at work: the working star in front, so it reads as alive,
 * and a click opens the agents list. The time is since the first of them
 * started — how long the background work has gone on; a sum of their times
 * would run ahead of the clock. Built only when the count or that start
 * changes (#365); the time is rewritten in place every second.
 */
function agentsRunningLine(count: number, since: number): HTMLElement {
	const label = `${count} agent${count === 1 ? '' : 's'} running`;
	const line = button([
		el('span', { class: 'working-glyph', text: glyphs[glyphAt] }),
		el('span', { class: 'shimmer agents-running-text', text: agentsRunningText(label, since) }),
	], { class: 'agents-running', title: `${label} — show them` });
	line.dataset.label = label;
	line.dataset.since = String(since);
	line.addEventListener('click', () => openAgentsPanel());
	return line;
}

function agentsRunningText(label: string, since: number): string {
	return since ? `${label} · ${duration(Date.now() - since)}` : label;
}

/**
 * Fifty ways to say "working", each with its past form for the line left
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
	['Cross-checking', 'Cross-checked'], ['Analyzing', 'Analyzed'], ['Mapping it out', 'Mapped it out'],
	['Tracing', 'Traced'], ['Probing', 'Probed'], ['Combing through', 'Combed through'], ['Deliberating', 'Deliberated'],
	['Calibrating', 'Calibrated'], ['Weaving it together', 'Wove it together'], ['Distilling', 'Distilled'],
	['Sifting through', 'Sifted through'], ['Shaping', 'Shaped'], ['Refining', 'Refined'], ['Navigating', 'Navigated'],
	['Surveying', 'Surveyed'], ['Decoding', 'Decoded'], ['Fine-tuning', 'Fine-tuned'], ['Gathering clues', 'Gathered clues'],
	['Laying the groundwork', 'Laid the groundwork'], ['Thinking it through', 'Thought it through'],
	['Lining things up', 'Lined things up'],
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
	const phrase = workingNode.dataset.waiting ? 'Waiting for your answer' : workingPhrase();
	const label = since ? `${phrase}… ${duration(Date.now() - since)}` : `${phrase}…`;
	const text = workingNode.querySelector('.working-text');
	if (text?.textContent !== label) {
		workingNode.replaceChildren(el('span', { class: 'working-glyph', text: glyphs[glyphAt] }), el('span', { class: 'shimmer working-text', text: label }));
	}
}
setInterval(tickWorking, 1000);

/** The time on "N agents running", in place. */
setInterval(() => {
	const line = threadInner.querySelector<HTMLElement>('.agents-running');
	const text = line?.querySelector('.agents-running-text');
	if (line && text) {
		const next = agentsRunningText(line.dataset.label ?? '', Number(line.dataset.since));
		if (text.textContent !== next) {
			text.textContent = next;
		}
	}
}, 1000);

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
	const agentsLine = threadInner.querySelector('.agents-running .working-glyph');
	if (reducedMotion.matches || (!workingNode && !agentsLine && !tabStrip.querySelector('.tab-mark.working'))) {
		return;
	}
	glyphAt = (glyphAt + 1) % glyphs.length;
	for (const glyph of [workingNode?.querySelector('.working-glyph'), agentsLine]) {
		if (glyph) {
			glyph.textContent = glyphs[glyphAt];
		}
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
	question: { icon: 'question', ask: 'The agent asks' },
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
	if (entry.questions) {
		return questionNode(entry, entry.questions);
	}
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
 * A question with choices the agent asked in the middle of its turn —
 * Claude Code's `AskUserQuestion`, Codex's `request_user_input`. The turn
 * waits on it. In the thread it is one row: while it waits, a line pointing at
 * the form above the message box (`questionForm`); once answered, the answers.
 */
function questionNode(entry: ApprovalEntry, questions: readonly AgentQuestion[]): HTMLElement {
	const node = el('div', { class: `row approval question ${entry.status}` },
		el('div', { class: 'approval-head' }, icon('question'), el('span', { text: questions.length > 1 ? `The agent asks ${questions.length} questions` : 'The agent asks' })));
	if (entry.status === 'pending') {
		for (const q of questions) {
			node.append(el('div', { class: 'question-done' }, el('span', { class: 'question-done-q pending', text: q.header || q.question })));
		}
		node.append(el('div', { class: 'approval-outcome', text: 'Waiting for your answer — in the form above the message box' }));
		return node;
	}
	for (const q of questions) {
		const given = entry.answers?.[q.id];
		node.append(el('div', { class: 'question-done' },
			el('span', { class: 'question-done-q', text: q.header || q.question }),
			el('span', { class: 'question-done-a', text: given?.length ? given.join(', ') : '—' })));
	}
	const outcome = entry.status === 'allowed' ? '' : entry.status === 'denied' ? 'Skipped — the agent goes on with its own judgement' : approvalOutcomes.cancelled;
	if (outcome) {
		node.append(el('div', { class: 'approval-outcome', text: outcome }));
	}
	return node;
}

/** The question form shown above the message box, as `<chat id>:<entry id>`, or '' for none. */
let dockShown = '';

/**
 * The oldest question of the chat in front that still waits, as a form above
 * the message box. Built once per question and never on a state post — a
 * rebuild between a press and its release loses the click (#365), and the
 * picks live in `questionDrafts` anyway.
 */
function renderQuestionDock(s: ChatViewState): void {
	const entry = s.entries.find((e): e is ApprovalEntry => e.kind === 'approval' && e.status === 'pending' && !!e.questions?.length);
	const key = entry ? `${s.chatId}:${entry.id}` : '';
	if (key === dockShown) {
		return;
	}
	dockShown = key;
	questionDock.hidden = !entry;
	questionDock.replaceChildren(...(entry ? [questionForm(entry, entry.questions!)] : []));
}

/** What the user has picked in a question form so far, by card and question: kept across rebuilds. */
const questionDrafts = new Map<string, Map<string, { chosen: string[]; other: string; otherOn: boolean }>>();
/** The question each form has open, by card. */
const questionTabs = new Map<string, number>();

/**
 * The form for one card: a tab per question (with more than one), the open
 * question's options and, where the agent takes them, the user's own words;
 * Answer — enabled once every question has an answer — sends them all, Skip
 * tells the agent to go on with its own judgement. Picking one option of a
 * one-choice question moves on to the next question still unanswered.
 */
function questionForm(entry: ApprovalEntry, questions: readonly AgentQuestion[]): HTMLElement {
	let drafts = questionDrafts.get(entry.id);
	if (!drafts) {
		drafts = new Map();
		questionDrafts.set(entry.id, drafts);
	}
	const draftOf = (q: AgentQuestion) => {
		let d = drafts!.get(q.id);
		if (!d) {
			d = { chosen: [], other: '', otherOn: !q.options.length };
			drafts!.set(q.id, d);
		}
		return d;
	};
	// What Answer sends is exactly what the form shows chosen: with the own
	// words row taken on a one-choice question, the options read unchosen, so
	// an empty row is no answer rather than the option picked before it (#430).
	const answerOf = (q: AgentQuestion): string[] => {
		const d = draftOf(q);
		const own = q.other && d.otherOn && d.other.trim() ? [q.secret ? d.other : d.other.trim()] : [];
		if (q.multiSelect) {
			return [...d.chosen, ...own];
		}
		return q.other && d.otherOn ? own : d.chosen.slice(0, 1);
	};
	const answered = (q: AgentQuestion) => answerOf(q).length > 0;

	const node = el('div', { class: 'question-form' });
	const progress = el('span', { class: 'qd-progress' });
	node.append(el('div', { class: 'qd-head' }, icon('question'),
		el('span', { class: 'qd-title', text: questions.length > 1 ? `The agent asks ${questions.length} questions` : 'The agent asks' }),
		progress));
	const tabs: HTMLButtonElement[] = [];
	const blocks: HTMLElement[] = [];
	const submit = button([el('span', { text: 'Answer' })], { class: 'approval-allow' });
	const skip = button([el('span', { text: 'Skip' })], { title: 'Answer nothing: the agent goes on with its own judgement' });

	const show = (index: number) => {
		// Hiding the block that holds the focus drops it to the body, where the
		// number keys and Enter reach nothing: it goes into the block shown.
		const hadFocus = node.contains(document.activeElement);
		questionTabs.set(entry.id, index);
		tabs.forEach((tab, i) => {
			tab.classList.toggle('active', i === index);
			tab.setAttribute('aria-selected', String(i === index));
		});
		blocks.forEach((block, i) => block.hidden = i !== index);
		if (hadFocus) {
			const block = blocks[index];
			block?.querySelector<HTMLElement>('.question-option.chosen, .question-option, .question-other-input')?.focus();
		}
	};
	const current = () => Math.min(questionTabs.get(entry.id) ?? 0, questions.length - 1);
	const allAnswered = () => questions.every(answered);
	const refresh = () => {
		const done = questions.filter(answered).length;
		// Unavailable rather than `disabled`: a disabled button gets no pointer
		// events in VS Code, so its tooltip — the one place that says why — never
		// showed. A press then opens the next question still unanswered.
		submit.classList.toggle('unavailable', done < questions.length);
		submit.setAttribute('aria-disabled', String(done < questions.length));
		submit.title = done < questions.length ? 'Answer every question first' : 'Send the answers and let the agent go on';
		progress.textContent = questions.length > 1 ? `${done} of ${questions.length} answered` : '';
		tabs.forEach((tab, i) => tab.classList.toggle('answered', answered(questions[i])));
	};
	/** The next question still unanswered after `from`, wrapping round; undefined when all are. */
	const nextOpen = (from: number) => {
		for (let k = 1; k <= questions.length; k++) {
			const i = (from + k) % questions.length;
			if (!answered(questions[i])) {
				return i;
			}
		}
		return undefined;
	};
	const send = (allow: boolean) => {
		if (allow && !allAnswered()) {
			// The open question first, while it still needs its answer; then the next that does.
			const next = answered(questions[current()]) ? nextOpen(current()) : current();
			if (next !== undefined) {
				show(next);
			}
			return;
		}
		for (const b of node.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>('button, input, textarea')) {
			b.disabled = true;
		}
		const answers: Record<string, string[]> = {};
		if (allow) {
			for (const q of questions) {
				answers[q.id] = answerOf(q);
			}
		}
		questionDrafts.delete(entry.id);
		questionTabs.delete(entry.id);
		post(allow ? { type: 'approve', id: entry.id, allow: true, answers } : { type: 'approve', id: entry.id, allow: false });
	};

	if (questions.length > 1) {
		const strip = el('div', { class: 'qd-tabs' });
		strip.setAttribute('role', 'tablist');
		questions.forEach((q, i) => {
			const tab = button([icon('check', 'qd-tab-check'), el('span', { class: 'qd-tab-label', text: q.header || `Question ${i + 1}` })], { class: 'qd-tab', title: q.question });
			tab.setAttribute('role', 'tab');
			tab.addEventListener('click', () => show(i));
			tabs.push(tab);
			strip.append(tab);
		});
		node.append(strip);
	}
	const body = el('div', { class: 'qd-body' });
	questions.forEach((q, qi) => {
		const d = draftOf(q);
		const block = el('div', { class: 'question-block' });
		if (q.header && questions.length === 1) {
			block.append(el('span', { class: 'question-header', text: q.header }));
		}
		block.append(el('div', { class: 'question-text', text: q.question }));
		const list = el('div', { class: 'question-options' });
		list.setAttribute('role', q.multiSelect ? 'group' : 'radiogroup');
		const options: HTMLButtonElement[] = [];
		const mark = () => {
			options.forEach((b, i) => {
				const on = d.chosen.includes(q.options[i].label) && !(!q.multiSelect && d.otherOn);
				b.classList.toggle('chosen', on);
				b.setAttribute('aria-checked', String(on));
			});
			otherRow?.classList.toggle('chosen', d.otherOn);
			refresh();
		};
		q.options.forEach((option, i) => {
			const b = button([
				el('span', { class: 'question-key', text: String(i + 1) }),
				el('span', { class: 'question-option-text' },
					el('span', { class: 'question-option-label', text: option.label }),
					option.description ? el('span', { class: 'question-option-description', text: option.description }) : undefined),
				icon(q.multiSelect ? 'check' : 'circle-filled', 'question-check'),
			], { class: `question-option ${q.multiSelect ? 'multi' : 'single'}` });
			b.setAttribute('role', q.multiSelect ? 'checkbox' : 'radio');
			b.addEventListener('click', () => {
				if (q.multiSelect) {
					d.chosen = d.chosen.includes(option.label) ? d.chosen.filter(l => l !== option.label) : [...d.chosen, option.label];
					mark();
					return;
				}
				d.chosen = [option.label];
				d.otherOn = false;
				mark();
				// One choice made: on to the next question that still needs one.
				const next = nextOpen(qi);
				if (next !== undefined && next !== qi) {
					show(next);
				} else if (next === undefined) {
					submit.focus();
				}
			});
			options.push(b);
			list.append(b);
		});
		let otherRow: HTMLElement | undefined;
		if (q.other) {
			const input = q.secret ? el('input') : el('textarea');
			input.className = 'question-other-input';
			if (input instanceof HTMLInputElement) {
				input.type = 'password';
			} else {
				input.rows = 1;
			}
			input.placeholder = q.options.length ? 'Something else — in your own words' : 'Your answer';
			input.value = d.other;
			input.addEventListener('focus', () => {
				if (!d.otherOn) {
					d.otherOn = true;
					mark();
				}
			});
			input.addEventListener('input', () => {
				d.other = input.value;
				d.otherOn = true;
				if (input instanceof HTMLTextAreaElement) {
					input.style.height = 'auto';
					input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
				}
				mark();
			});
			(input as HTMLElement).addEventListener('keydown', event => {
				// Enter answers — or moves to the next question still open —, Shift+Enter is a new line.
				if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
					event.preventDefault();
					send(true);
				}
			});
			otherRow = el('div', { class: 'question-other' }, icon('edit', 'question-other-icon'), input);
			list.append(otherRow);
		}
		block.append(list);
		blocks.push(block);
		body.append(block);
		mark();
	});
	node.append(body);
	// Number keys pick an option of the open question, as the CLIs' own pickers
	// do; outside a text field only.
	node.addEventListener('keydown', event => {
		const target = event.target as HTMLElement;
		if (target.matches('input, textarea') || event.metaKey || event.ctrlKey || event.altKey) {
			return;
		}
		const n = Number(event.key);
		const option = n >= 1 ? blocks[current()]?.querySelectorAll<HTMLButtonElement>('.question-option')[n - 1] : undefined;
		if (option) {
			event.preventDefault();
			// No focus() after: the click may have moved on to the next question, or to
			// Answer, and `show` has put the focus where it belongs.
			option.click();
		} else if (event.key === 'Enter' && !target.matches('button')) {
			send(true);
		}
	});
	submit.addEventListener('click', () => send(true));
	skip.addEventListener('click', () => send(false));
	node.append(el('div', { class: 'approval-actions qd-actions' }, skip, submit));
	show(current());
	refresh();
	return node;
}

/** The approval modes, counted in Auto / Ask / Deny order; empty modes stay hidden. */
function renderApproveToggle(s: ChatViewState): void {
	const rows = approvalCategoryRows(s);
	const modes = rows.map(r => modeOf(s, r.key));
	const auto = modes.filter(m => m === 'auto').length;
	const deny = modes.filter(m => m === 'deny').length;
	const counts = [
		{ mode: 'auto', label: 'Auto', count: auto },
		{ mode: 'ask', label: 'Ask', count: modes.length - auto - deny },
		{ mode: 'deny', label: 'Deny', count: deny },
	].filter(item => item.count > 0);
	const text = counts.map(item => `${item.label} ${item.count}`).join(' • ');
	const title = `Approvals — what the agents may do without asking:\n${rows.map(r => `${r.label}: ${modeLabels[modeOf(s, r.key)]}`).join('\n')}\nCompact (tool calls start folded): ${s.collapseTools ? 'On' : 'Off'}\nClick to change: Auto runs it, Ask asks, Deny refuses.`;
	const shown = JSON.stringify([text, title]);
	if (approveToggle.dataset.shown !== shown) {
		approveToggle.dataset.shown = shown;
		const parts: HTMLElement[] = [el('span', { text: 'Mode' })];
		counts.forEach((item, index) => {
			if (index) { parts.push(el('span', { class: 'mode-separator', text: '•' })); }
			parts.push(el('strong', { class: `mode-count mode-${item.mode}`, text: String(item.count), title: item.label }));
		});
		approveToggle.replaceChildren(...parts);
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
			el('div', { class: 'approval-note', text: 'Auto runs it without asking, Deny refuses it without asking. For this project, in every tab. Your own Claude Code and Codex rules still decide first.' }),
			el('div', { class: 'approval-sep' }),
			compactRow());
		if (focused?.key) {
			approvalPopup.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused.key)}"][data-mode="${focused.mode}"]`)?.focus();
		}
	}
	for (const b of approvalPopup.querySelectorAll<HTMLElement>('.compact-seg')) {
		const on = (b.dataset.compact === 'on') === s.collapseTools;
		b.classList.toggle('on', on);
		b.setAttribute('aria-pressed', String(on));
	}
	const modes = new Set(rows.map(r => modeOf(s, r.key)));
	const all: ApprovalMode | undefined = modes.size === 1 ? [...modes][0] : undefined;
	for (const b of approvalPopup.querySelectorAll<HTMLElement>('.mode-seg:not(.compact-seg)')) {
		const current = b.dataset.key === 'all' ? all : modeOf(s, b.dataset.key ?? '');
		const on = current === b.dataset.mode;
		b.classList.toggle('on', on);
		b.setAttribute('aria-pressed', String(on));
	}
}

/**
 * Compact: tool calls start folded, their input and output shown only when a
 * row is clicked — asked for, in this menu. It is `aiBrowser.chat.collapseToolCalls`
 * ("Fold Tool Calls"), written by the host, so the switch and Settings agree;
 * rows the user opened or closed keep that.
 */
function compactRow(): HTMLElement {
	const seg = (value: 'off' | 'on', text: string) => {
		const b = button([el('span', { text })], { class: 'mode-seg compact-seg' });
		b.dataset.compact = value;
		b.addEventListener('click', () => post({ type: 'setCollapseTools', collapse: value === 'on' }));
		return b;
	};
	const group = el('span', { class: 'mode-segs' }, seg('off', 'Off'), seg('on', 'On'));
	group.setAttribute('role', 'group');
	group.setAttribute('aria-label', 'Compact');
	return el('div', { class: 'approval-row', title: 'Tool calls start folded — click a row to see its input and output. The same as the Fold Tool Calls setting.' },
		el('span', { class: 'approval-row-label', text: 'Compact' }), group);
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
		bubble.append(el('div', { class: 'bubble-text' }, ...markCommands(entry.text, knownCommands(state))));
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

/**
 * The file a Read or an edit row names, as a link: a click opens it in an
 * editor tab (`openFile`), whatever kind of file it is. The row's head is the
 * button that folds the row, so the click is taken in `toolNode` before it.
 */
function fileLink(file: string): HTMLElement {
	const link = el('span', { class: 'subject file-link', text: basename(file), title: `${file}\nClick to open` });
	link.dataset.file = file;
	return link;
}

/**
 * One line under a folded tool row saying what the call does: a command's own
 * description (Claude Code's Bash `description`, Codex's parsed actions —
 * "Read a.txt, Listed files"), an MCP tool's arguments ("selector: #email ·
 * value: me@x.org"). Nothing where the title already says it — a read, an
 * edit, a search, a fetch, an agent, a tool whose detail is in its title.
 */
function toolSummary(t: ToolEntry): string | undefined {
	const cap = (text: string) => {
		const line = text.replace(/\s+/g, ' ').trim();
		return line.length > 240 ? `${line.slice(0, 239)}…` : line || undefined;
	};
	if (t.tool === 'command') {
		// With no command the title already shows the description.
		const command = (t.input ?? '').split('\n')[0].trim();
		return command && t.detail && t.detail.trim() !== command ? cap(t.detail) : undefined;
	}
	if (t.tool !== 'mcp' || !t.input) {
		return undefined;
	}
	try {
		const args: unknown = JSON.parse(t.input);
		if (args && typeof args === 'object' && !Array.isArray(args)) {
			const parts = Object.entries(args as Record<string, unknown>)
				.filter(([, value]) => value !== undefined && value !== null && value !== '')
				.map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
			return parts.length ? cap(parts.join(' · ')) : undefined;
		}
		return cap(typeof args === 'string' ? args : JSON.stringify(args));
	} catch {
		// The input is cut (a tool body past its limit, or one cut for the
		// history), so it no longer parses: read the pretty-printed object's
		// top-level keys line by line rather than show its opening brace.
		const parts = t.input.split('\n')
			.map(line => /^  "((?:[^"\\]|\\.)*)": (.*?),?$/.exec(line))
			.filter((m): m is RegExpExecArray => !!m)
			.map(m => {
				let value = m[2];
				try {
					const parsed: unknown = JSON.parse(value);
					value = typeof parsed === 'string' ? parsed : value;
				} catch {
					// a string cut short loses its closing quote; an object or
					// array opened on this line keeps its text
					value = value.startsWith('"') ? value.slice(1) : value;
				}
				return `${m[1]}: ${value}`;
			});
		return parts.length ? cap(parts.join(' · ')) : undefined;
	}
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
			return [verb('Reading', 'Read'), t.detail ? fileLink(t.detail) : plain(t.name)];
		case 'edit':
			return [
				verb('Editing', 'Edited'), t.detail ? fileLink(t.detail) : plain(t.name),
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

/**
 * Every call with something to show opens by default — its input and output
 * are the point of the row — unless `aiBrowser.chat.collapseToolCalls` folds
 * them all (asked for). A row the user opened or closed keeps that.
 */
function openByDefault(): boolean {
	return !state?.collapseTools;
}

/**
 * A tool call's input or output opens in an editor tab on a click (asked
 * for) — but not a click that ends a text selection, which is someone copying
 * a line (#353), nor one on the block's own copy button.
 */
function opensInTab(block: HTMLElement, name: string, text: () => string): HTMLElement {
	return onPlainClick(block, 'Click to open in an editor tab', () => post({ type: 'openText', name, text: text() }));
}

/** How long a click waits to be sure it is not the first of a double or triple click. */
const multiClickMs = 300;

/**
 * Runs `open` on a plain single click of `block` — not one that ends a text
 * selection (#353), not one on its copy button, and not the first click of a
 * double or triple click: that click arrives before the word or line is
 * selected, so testing the selection then opened a tab under someone selecting
 * a word to copy. The open waits out the double-click window and is dropped
 * if another click comes, or a selection appears, meanwhile.
 */
function onPlainClick(block: HTMLElement, title: string, open: () => void): HTMLElement {
	block.classList.add('opens');
	block.title = title;
	block.addEventListener('click', event => {
		clearTimeout(pendingOpen);
		pendingOpen = undefined;
		if ((event.target as Element).closest('.copy-button') || event.detail > 1 || hasSelection()) {
			return;
		}
		// Not `isConnected` at the end of the wait: a running row is rebuilt
		// within it as a matter of course, and the click was still on this block.
		pendingOpen = setTimeout(() => {
			pendingOpen = undefined;
			if (!hasSelection()) {
				open();
			}
		}, multiClickMs);
	});
	return block;
}

/**
 * The one open waiting out the double-click window — one for the whole view,
 * not one per block: a row rebuilt between the two clicks of a double click
 * puts the second on a new block, which a per-block timer never heard of.
 */
let pendingOpen: ReturnType<typeof setTimeout> | undefined;
document.addEventListener('click', event => {
	if (event.detail > 1) {
		clearTimeout(pendingOpen);
		pendingOpen = undefined;
	}
}, true);

function hasSelection(): boolean {
	const selection = window.getSelection();
	return !!selection && !selection.isCollapsed;
}

function toolNode(t: ToolEntry): HTMLElement {
	const key = `tool:${t.id}`;
	const hasBody = !!(t.input || t.output) && t.tool !== 'read';
	const open = hasBody && (toggled.get(key) ?? openByDefault());
	const status = t.status === 'failed' || t.status === 'running' || t.status === 'stopped' ? t.status : 'done';

	const head = button([
		el('span', { class: `status-dot ${status}` }),
		icon(toolIcons[t.tool], 'tool-icon'),
		el('span', { class: 'activity-title' }, ...toolTitle(t)),
		hasBody && icon('chevron-right', 'chevron'),
	], { class: 'activity-head', title: t.detail && t.tool === 'command' ? t.detail : '' });
	// A row with nothing to unfold still takes a click on the file it names:
	// a disabled button passes no clicks to what is inside it.
	const file = head.querySelector<HTMLElement>('.file-link');
	head.disabled = !hasBody && !file;
	if (!hasBody) {
		head.classList.add('no-body');
	}
	head.addEventListener('click', event => {
		const link = (event.target as Element).closest<HTMLElement>('.file-link');
		if (link?.dataset.file) {
			// A click that ends a selection of the name opens nothing. Only a
			// selection touching the name counts: a press on a button does not
			// collapse a selection elsewhere, so testing for any selection
			// made the name dead while some text in a reply was selected.
			const selection = window.getSelection();
			if (!selection || selection.isCollapsed || !selection.containsNode(link, true)) {
				post({ type: 'openFile', path: link.dataset.file });
			}
			return;
		}
		if (!hasBody) {
			return;
		}
		toggled.set(key, !open);
		render();
	});

	const node = el('div', { class: `row tool ${status}${open ? ' open' : ''}` }, head);
	// Folded, the row still says what the call does or did (asked for): the
	// title names the tool, this line what it was asked to do.
	const summary = open ? undefined : toolSummary(t);
	if (summary) {
		const line = el('div', { class: 'tool-summary', text: summary, title: summary });
		if (hasBody) {
			line.classList.add('unfolds');
			line.addEventListener('click', () => {
				if (hasSelection()) {
					return;
				}
				toggled.set(key, true);
				render();
			});
		}
		node.append(line);
	}
	if (open) {
		node.append(t.tool === 'command' ? execCard(t) : t.tool === 'edit' && t.input ? diffCard(t) : outputCard(t));
	}
	return node;
}

/** The command and its output — the Codex panel's shell block: `$ command`, output pinned to its newest line, a status footer. */
/**
 * A command and its output, `ioLines` lines each and nothing more (asked for,
 * as for IN / OUT): the command's first lines, the output's last — its newest,
 * where a run's result is — and a click opens the whole of either in a tab.
 */
function execCard(t: ToolEntry): HTMLElement {
	const input = (t.input ?? '').replace(/\n+$/, '').split('\n');
	const moreIn = input.length - ioLines;
	const text = el('span', { class: 'exec-text', text: input.slice(0, ioLines).map(line => capLine(line)).join('\n') });
	const command = opensInTab(el('div', { class: 'exec-command' },
		el('span', { class: 'exec-prompt', text: '$' }), text,
		moreIn > 0 ? el('span', { class: 'io-more', text: `${moreIn} more line${moreIn === 1 ? '' : 's'}` }) : undefined,
		copyButton(() => t.input ?? '', 'Copy command')), `${t.name}-in`, () => t.input ?? '');
	cutHint(command, text, moreIn > 0 || input.some(line => line.length > ioLineChars));
	const card = el('div', { class: 'card exec' }, command);
	if (t.output) {
		const lines = t.output.replace(/\n+$/, '').split('\n');
		const earlier = lines.length - ioLines;
		// One line each, scrolled sideways when long: wrapped, the newest line
		// could be the part cut off.
		const pre = el('pre', { text: lines.slice(-ioLines).map(line => capLine(line)).join('\n') });
		const output = opensInTab(el('div', { class: `exec-output${earlier > 0 ? ' cut-above' : ''}` },
			earlier > 0 ? el('span', { class: 'io-more above', text: `${earlier} earlier line${earlier === 1 ? '' : 's'}` }) : undefined,
			pre, copyButton(() => t.output ?? '', 'Copy output')),
		`${t.name}-out`, () => t.output ?? '');
		card.append(output);
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

/**
 * A file change: the counts in its head, then the first `ioLines` removed
 * lines and the first `ioLines` added ones and nothing more (asked for) —
 * no context, no hunk headers — and a line saying how many more there are. A
 * click opens the whole change in VS Code's diff editor; the host builds its
 * two sides from the full text.
 */
function diffCard(t: ToolEntry): HTMLElement {
	const removed: string[] = [];
	const added: string[] = [];
	for (const line of (t.input ?? '').split('\n')) {
		if (line.startsWith('+') && !line.startsWith('+++')) {
			added.push(line);
		} else if (line.startsWith('-') && !line.startsWith('---')) {
			removed.push(line);
		}
	}
	const shown = (lines: string[], cls: string) => lines.slice(0, ioLines).map(line => el('span', { class: `line ${cls}`, text: capLine(line) + '\n' }));
	const pre = el('pre', {}, ...shown(removed, 'del'), ...shown(added, 'add'));
	const moreRemoved = removed.length - ioLines;
	const moreAdded = added.length - ioLines;
	const more = [moreRemoved > 0 ? `${moreRemoved} more removed` : '', moreAdded > 0 ? `${moreAdded} more added` : ''].filter(Boolean).join(' · ');
	const head = el('div', { class: 'card-head' },
		el('span', { class: 'ellipsis', text: t.detail ?? 'Changes', title: t.detail }),
		el('span', { class: 'end' },
			t.added !== undefined && el('span', { class: 'added', text: `+${t.added}` }),
			t.removed !== undefined && el('span', { class: 'removed', text: `−${t.removed}` })));
	// The "more" line sits outside the part that scrolls sideways, or it went
	// with a long line out of sight; the click covers both.
	const body = onPlainClick(el('div', {},
		el('div', { class: 'card-body' }, pre),
		more ? el('div', { class: 'diff-more', text: `${more} · click to open` }) : undefined),
	'Click to open in the diff editor',
	() => post({ type: 'openDiff', name: t.detail ?? 'Changes', diff: t.input ?? '' }));
	return el('div', { class: 'card diff' }, head, body);
}

function outputCard(t: ToolEntry): HTMLElement {
	const card = el('div', { class: 'card io' });
	// IN and OUT show their first `ioLines` lines and nothing more (asked for):
	// the block is that tall, with no scroll, and a click opens the whole text
	// in a tab. Only those lines are put in the page — a tool's output can run
	// to megabytes — each cut at `ioLineChars`; copying takes the whole text.
	const row = (kind: 'in' | 'out', label: string, text: string, copy: string) => {
		const lines = text.replace(/\n+$/, '').split('\n');
		const shown = lines.slice(0, ioLines).map(line => capLine(line)).join('\n');
		const more = lines.length - ioLines;
		const pre = el('pre', { text: shown });
		const block = opensInTab(el('div', { class: `io-row ${kind}` }, el('span', { class: 'io-label', text: label }), pre,
			more > 0 ? el('span', { class: 'io-more', text: `${more} more line${more === 1 ? '' : 's'}` }) : undefined,
			copyButton(() => text, copy)), `${t.name}-${kind}`, () => text);
		cutHint(block, pre, more > 0 || lines.some(line => line.length > ioLineChars));
		return block;
	};
	if (t.input) {
		card.append(row('in', 'IN', t.input, 'Copy input'));
	}
	if (t.output) {
		card.append(row('out', 'OUT', t.output, 'Copy output'));
	}
	return card;
}

/** How many lines of a tool call's IN and OUT are shown; the CSS height (`--io-lines`) says the same. */
const ioLines = 3;
/** The longest a shown line is kept in the page; a click opens the whole of it. */
const ioLineChars = 1000;

function capLine(line: string): string {
	return line.length > ioLineChars ? `${Array.from(line.slice(0, ioLineChars + 1)).slice(0, ioLineChars).join('')}…` : line;
}

/**
 * Fades an IN or OUT block at its foot when there is more than it shows — lines
 * left out, or the three shown wrapping past the block's height.
 */
function cutHint(block: HTMLElement, pre: HTMLElement, cut: boolean): void {
	block.classList.toggle('scroll-more', cut);
	if (!cut) {
		requestAnimationFrame(() => block.classList.toggle('scroll-more', pre.scrollHeight - pre.clientHeight > 2));
	}
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
			const h = el('div', { class: `heading h${Math.min(heading[1].length, 4)} level-${heading[1].length}` });
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
			// Consecutive `>` lines are one quote, a bare `>` between them a paragraph break,
			// or every line became a padded box of its own.
			const q = el('blockquote');
			let para: string[] = [];
			const end = () => {
				if (para.length) {
					const p = el('p');
					para.forEach((text, n) => {
						if (n) {
							p.append(el('br'));
						}
						inline(p, text);
					});
					q.append(p);
					para = [];
				}
			};
			for (let j = i; j < lines.length; j++) {
				const m = /^\s*>\s?(.*)$/.exec(lines[j]);
				if (!m) {
					break;
				}
				i = j;
				if (m[1].trim()) {
					para.push(m[1]);
				} else {
					end();
				}
			}
			end();
			// A lone `>` — a reply still streaming its first quoted word — is no box yet.
			if (q.childElementCount) {
				out.append(q);
			}
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
		el('div', { class: 'code-head' }, el('span', { class: 'code-lang', text: lang || 'text' }), copyButton(() => code)),
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
	const pattern = /(`+)([^`]+?)\1|\*\*([^*]+)\*\*|(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])|\[([^\]]+)\]\((<[^>]+>|[^\s)]+)\)|((?:https?:\/\/|file:\/\/)[^\s<>()[\]`"]+)/g;
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
		} else if (match[6] !== undefined) {
			const destination = match[6].replace(/^<|>$/g, '');
			if (/^https?:\/\//i.test(destination) || localFileLink(destination)) {
				const link = linkNode(destination);
				inline(link, match[5]);
				parent.append(link);
			} else {
				parent.append(match[0]);
			}
		} else {
			// A bare address. Sentence punctuation after it is not part of it:
			// "see https://example.com." ends the sentence, not the URL.
			const url = match[7].replace(/[.,;:!?'*_]+$/, '');
			parent.append(linkNode(url, url));
			at = match.index + url.length;
			continue;
		}
		at = match.index + match[0].length;
	}
	if (at < text.length) {
		parent.append(text.slice(at));
	}
}

const isMacView = navigator.platform.startsWith('Mac');
const modKey = isMacView ? '⌘' : 'Ctrl';

/**
 * A link in a reply. Never an `<a href>`: a click in a webview would navigate
 * the view itself. The host opens it — in the built-in browser, or with
 * ⌘/Ctrl held in the system one — and checks the scheme again there.
 */
function linkNode(url: string, text?: string): HTMLElement {
	const local = !!localFileLink(url);
	const link = el('span', { class: 'link', title: local ? `${url}\nOpen file in editor; project folder in VS Code Explorer, other folder in file manager` : `${url}\nClick: open in AI Browser · ${modKey}+click: system browser`, text });
	link.tabIndex = 0;
	link.addEventListener('keydown', event => {
		if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); post({ type: 'openLink', url, external: false }); }
	});
	link.setAttribute('role', 'link');
	link.addEventListener('click', event => {
		// The row around it may fold or open on a click; this one is the link's.
		event.stopPropagation();
		// A drag that selected the link's text ends in a click too.
		if (event.button !== 0 || hasSelection()) {
			return;
		}
		// On a Mac, Ctrl+click is the right click and opens the menu below.
		post({ type: 'openLink', url, external: isMacView ? event.metaKey : event.ctrlKey });
	});
	link.addEventListener('contextmenu', event => {
		event.preventDefault();
		event.stopPropagation();
		if (local) {
			const request = ++localLinkMenuRequest;
			pendingLocalLinkMenu = { link, url, request };
			post({ type: 'localLinkInfo', url, request });
		} else {
			linkMenu(link, url);
		}
	});
	return link;
}

/** The right-click menu of a link: either browser, or a copy of its address or its text. */
let localLinkMenuRequest = 0;
let pendingLocalLinkMenu: { link: HTMLElement; url: string; request: number } | undefined;

function linkMenu(link: HTMLElement, url: string, directory?: boolean, inWorkspace = false): void {
	const text = link.textContent ?? '';
	// A link in an agent's report sits inside a panel. Closing the panel the
	// menu was opened from hid the link under it and put the menu in the
	// corner, so the panel stays open beneath the menu.
	const panel = [agentsPanel, historyPanel, agentAppsPanel, skillEditor].find(p => p.classList.contains('open') && p.contains(link));
	openMenu(link, [
		...(localFileLink(url) ? [
			...(directory && inWorkspace ? [{ icon: 'files', label: 'Show in VS Code Explorer', shortcut: 'Click', run: () => post({ type: 'openLink', url, external: false }) }] : []),
			...(directory === false ? [{ icon: 'go-to-file', label: 'Open in tab', run: () => post({ type: 'openLink', url, external: false }) }] : []),
			{ icon: 'folder-opened', label: isMacView ? 'Show in Finder' : navigator.platform.startsWith('Win') ? 'Show in File Explorer' : 'Show in File Manager', disabled: directory === undefined,
				run: () => post({ type: 'openLink', url, external: false, reveal: true }) },
		] : [
			{ icon: 'globe', label: 'Open in AI Browser', shortcut: 'Click', run: () => post({ type: 'openLink', url, external: false }) },
			{ icon: 'link-external', label: 'Open in System Browser', shortcut: `${modKey}+Click`, run: () => post({ type: 'openLink', url, external: true }) },
		]),
		{ icon: 'copy', label: 'Copy Link', run: () => post({ type: 'copy', text: url }) },
		{ icon: 'symbol-text', label: 'Copy Link Text', disabled: !text || text === url, run: () => post({ type: 'copy', text }) },
	], url.length > 60 ? `${url.slice(0, 57)}…` : url, undefined, panel);
	if (!menu.classList.contains('open')) {
		return;
	}
	// Opened above the link like every other menu, but a link near the top of
	// the thread has no room there, and `#app` clips what overflows it.
	const box = app.getBoundingClientRect();
	if (menu.getBoundingClientRect().top < box.top + 8) {
		menu.style.bottom = '';
		menu.style.top = `${link.getBoundingClientRect().bottom - box.top + 6}px`;
	}
}

/* ---------------------------------------------------------------- composer */

/** What the chips were built from: rebuilt only when it changes (#365 — a click straddling a rebuild is lost). */
let attachmentsShown = '';

function renderAttachments(s: ChatViewState): void {
	// The state is posted every 40 ms while any tab streams; rebuilding the
	// chips each time swallowed a click on one whose press outlasted a post,
	// and took keyboard focus off it.
	const shown = JSON.stringify(s.attachments.map(c => [c.id, c.kind, c.label, c.reference, c.thumbnail?.length]));
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
		const reference = chip.reference;
		const insert = button([thumb], { class: 'chip-reference', title: `Insert reference ${reference ?? ''}` });
		insert.disabled = !reference;
		// Keep the textarea's selection while pressing the icon or reference.
		insert.addEventListener('mousedown', event => event.preventDefault());
		insert.addEventListener('click', () => { if (reference) { insertAttachmentReference(reference); } });
		const open = button([
			el('span', { class: 'chip-label', text: chip.label }),
		], { class: 'chip-open', title: `Open ${chip.label}` });
		open.addEventListener('click', () => post({ type: 'openAttachment', id: chip.id }));
		const referenceButton = reference ? button([
			el('span', { class: 'chip-reference-label', text: reference }),
		], { class: 'chip-reference', title: `Insert reference ${reference}` }) : undefined;
		referenceButton?.addEventListener('mousedown', event => event.preventDefault());
		referenceButton?.addEventListener('click', () => { if (reference) { insertAttachmentReference(reference); } });
		const root = el('span', { class: 'chip' }, insert, open, referenceButton, remove);
		root.addEventListener('contextmenu', event => {
			event.preventDefault();
			openMenu(root, [
				{ icon: 'go-to-file', label: 'Open in tab', run: () => post({ type: 'openAttachment', id: chip.id }) },
				{ icon: 'mention', label: 'Insert reference', description: reference, disabled: !reference,
					run: () => { if (reference) { insertAttachmentReference(reference); } } },
			], chip.label);
		});
		return root;
	}));
	attachmentsRow.hidden = !s.attachments.length;
}

// A selection is remembered per draft; without one, references append to the message.
let attachmentCaret: { chat: string | undefined; value: string; start: number; end: number } | undefined;
function rememberAttachmentCaret(): void {
	attachmentCaret = { chat: draftChat, value: input.value, start: input.selectionStart, end: input.selectionEnd };
}
input.addEventListener('select', rememberAttachmentCaret);
input.addEventListener('keyup', rememberAttachmentCaret);
input.addEventListener('click', rememberAttachmentCaret);
input.addEventListener('input', rememberAttachmentCaret);
input.addEventListener('blur', rememberAttachmentCaret);

function insertAttachmentReference(reference: string): void {
	const selection = attachmentCaret && attachmentCaret.chat === draftChat && attachmentCaret.value === input.value ? attachmentCaret : undefined;
	const start = selection?.start ?? input.value.length;
	const end = selection?.end ?? start;
	const before = input.value.slice(0, start);
	const after = input.value.slice(end);
	const leading = before && !/\s$/.test(before) ? ' ' : '';
	const trailing = !after || !/^\s/.test(after) ? ' ' : '';
	input.setRangeText(`${leading}${reference}${trailing}`, start, end, 'end');
	input.focus();
	rememberAttachmentCaret();
	// Chip insertion always edits the composer, even after using a skill editor.
	saveDraft();
	autosize();
	renderSend();
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

/**
 * A button's contents replaced only when they change. Every state post — every
 * 40 ms while any tab streams — used to rebuild them, and a click whose press
 * lands on the icon or label and whose release comes after the rebuild never
 * fires (#365): Stop missed 10 of 10 presses at its centre during a reply,
 * the one moment it is pressed, and the agent and model pills likewise.
 */
function setIcon(target: HTMLElement, name: string): void {
	if (target.dataset.shown !== name) {
		target.dataset.shown = name;
		target.replaceChildren(icon(name));
	}
}

function setPill(pill: HTMLElement, label: string): void {
	if (pill.dataset.shown !== label) {
		pill.dataset.shown = label;
		pill.replaceChildren(...pillContent(label));
	}
}

function renderSelectors(s: ChatViewState): void {
	const agent = s.agents.find(a => a.id === s.selection.agent);
	setPill(agentPill, agent?.name ?? (s.detecting ? 'Looking…' : 'No agent'));
	agentPill.disabled = !s.agents.some(a => a.available);
	agentPill.title = `Agent — who answers: Claude Code or Codex${agent?.detail ? `\n${agent.name} ${agent.detail}` : ''}\nClick to pick another; the gear in its menu picks which installed copy.`;

	const model = agent?.models.find(m => m.id === s.selection.model);
	setPill(modelPill, model?.label ?? 'Model');
	modelPill.disabled = !agent?.models.length;
	modelPill.title = `Model — which of the agent's models answers${model?.description ? `\n${model.label}: ${model.description}` : ''}`;

	const efforts = model?.efforts ?? [];
	effortBox.hidden = !efforts.length;
	effortButton.hidden = !efforts.length;
	if (efforts.length) {
		effortRange.max = String(efforts.length - 1);
		effortRange.value = String(Math.max(0, efforts.indexOf(s.selection.effort ?? '')));
		effortLabel.textContent = labelOf(s.selection.effort ?? efforts[0]);
		setPill(effortButton, effortLabel.textContent);
		effortBox.title = `Effort — how hard the model thinks before it answers: ${efforts.map(labelOf).join(' · ')}\nMore effort is slower and uses more of your plan.`;
		effortButton.title = effortBox.title;
		effortButton.classList.toggle('max', effortRange.value === effortRange.max);
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

/**
 * The context pie. It fills with the share of the context window the
 * conversation holds; the tooltip says how much is left. Warning colour from
 * 80 %, error colour from 95 % — where the agents start compacting on their
 * own. Without a window (Claude Code reports it at the end of the first turn)
 * it shows the size alone and stays empty.
 */
function renderContext(s: ChatViewState): void {
	const c = s.context;
	contextButton.hidden = !c;
	if (!c) {
		if (paramsPopup.classList.contains('open') && contextButton.classList.contains('active')) {
			closePopups();
		}
		return;
	}
	// Just compacted (Claude Code): the size before is all that is known, and
	// the pie stays empty until the next reply reports the new one.
	const share = c.window && !c.compacted ? Math.min(1, c.used / c.window) : undefined;
	contextPie.style.setProperty('--fill', `${share === undefined ? 0 : Math.round(share * 1000) / 10}%`);
	contextButton.classList.toggle('warn', share !== undefined && share >= 0.8 && share < 0.95);
	contextButton.classList.toggle('full', share !== undefined && share >= 0.95);
	// Not `disabled`: a disabled button gets no pointer events, so the tooltip
	// saying how full the context is — and why it cannot be compacted now —
	// would never show. Marked instead, and the click refuses.
	const busy = s.running || !!s.tabs.find(t => t.id === s.activeTab)?.busy;
	const unavailable = !c.canCompact || busy;
	contextButton.classList.toggle('unavailable', unavailable);
	contextButton.setAttribute('aria-disabled', String(unavailable));
	const size = contextSize(c);
	const action = !c.canCompact ? 'This agent does not offer compacting.'
		: busy ? 'Compacting is available once the agent has finished.'
		: 'Click to compact the conversation (/compact) — you will be asked first.';
	// Drawn by the view (`hoverTip`), as the skill buttons' are; set only when it changes.
	const tip = `${size}\n${action}`;
	if (contextButton.dataset.tip !== tip) {
		contextButton.dataset.tip = tip;
		contextButton.setAttribute('aria-label', tip);
		if (hoverTip.anchor === contextButton) {
			hoverTip.show(contextButton);
		}
	}
	// The question open while the tab started working, or lost its compacting: it goes.
	if (unavailable && paramsPopup.classList.contains('open') && contextButton.classList.contains('active')) {
		closePopups();
	}
}

/** How full the context is, in words: used and left, in tokens and as a share of the window. */
function contextSize(c: NonNullable<ChatViewState['context']>): string {
	if (c.compacted) {
		return `Context: compacted from ${compact(c.used)} tokens. The new size shows with the agent's next reply.`;
	}
	if (!c.window) {
		return `Context: ${compact(c.used)} tokens used. The window size is not reported yet.`;
	}
	const usedPct = Math.min(100, Math.round(c.used / c.window * 100));
	return `Context used: ${compact(c.used)} (${usedPct}%)\nLeft: ${compact(Math.max(0, c.window - c.used))} (${100 - usedPct}%) of ${compact(c.window)} tokens`;
}

/**
 * A click asks first, in the view — never a modal, which would pause a browser
 * tab beside the chat: compacting replaces the conversation the agent sees
 * with a summary, and cannot be undone. No is the default, as for running a
 * skill again: Enter, Escape and a click elsewhere all leave it as it is.
 */
contextButton.addEventListener('click', () => {
	const c = state?.context;
	if (!state || !c || contextButton.classList.contains('unavailable')) {
		return;
	}
	if (paramsPopup.classList.contains('open') && contextButton.classList.contains('active')) {
		closePopups();
		return;
	}
	const tabId = state.activeTab;
	const yes = button([el('span', { text: 'Yes, compact' })], { class: 'ghost', title: 'Send /compact to the agent' });
	const no = button([el('span', { text: 'No' })], { class: 'primary', title: 'Leave the conversation as it is (Enter)' });
	no.addEventListener('click', () => closePopups());
	yes.addEventListener('click', () => {
		closePopups();
		post({ type: 'compact', tabId });
	});
	paramsPopup.replaceChildren(
		el('div', { class: 'menu-heading', text: 'Compact the conversation?' }),
		el('div', { class: 'run-question', text: `${contextSize(c)}\n\nThe agent replaces the conversation with a summary of it and carries on from there. Details it leaves out of the summary are gone for the agent; the chat here stays as it is.` }),
		el('div', { class: 'form-actions' }, yes, no));
	paramsPopup.onkeydown = event => {
		if (event.key === 'Enter' && !event.isComposing && document.activeElement === no) {
			event.preventDefault();
			closePopups();
		}
	};
	openAbove(paramsPopup, contextButton, 'right');
	contextButton.classList.add('active');
	no.focus();
});

function renderSend(): void {
	const running = state?.running ?? false;
	const hasContent = !!input.value.trim() || !!state?.attachments.length;
	const stop = running && !hasContent;
	setIcon(sendButton, stop ? 'debug-stop' : 'arrow-up');
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
	paintInput();
}

// Fit the actual labels and visible indicators instead of guessing a sidebar breakpoint.
let toolbarLayoutFrame: number | undefined;
let toolbarLayoutShape = '';
function scheduleToolbarLayout(): void {
	if (toolbarLayoutFrame !== undefined) { return; }
	toolbarLayoutFrame = requestAnimationFrame(() => {
		toolbarLayoutFrame = undefined;
		const width = toolbar.clientWidth;
		if (!width) { return; }
		const style = getComputedStyle(toolbar);
		const shape = JSON.stringify([width, style.font, agentPill.textContent, modelPill.textContent,
			effortLabel.textContent, effortButton.hidden, approveToggle.textContent,
			agentsButton.textContent, agentsButton.hidden, contextButton.hidden]);
		if (shape === toolbarLayoutShape) { return; }
		toolbarLayoutShape = shape;
		toolbar.classList.remove('stacked', 'compact-effort');
		// Measure unshrunk settings in both presentations; these temporary styles
		// are removed in the same frame, without replacing or cloning controls.
		toolbarSettings.style.width = 'max-content';
		toolbarSettings.style.maxWidth = 'none';
		const available = width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
		const sides = toolbarAttachments.getBoundingClientRect().width + toolbarEnd.getBoundingClientRect().width;
		const gap = parseFloat(style.columnGap) * 2;
		const fits = () => Math.ceil(sides + toolbarSettings.getBoundingClientRect().width + gap) <= available;
		if (!fits()) { toolbar.classList.add('compact-effort'); }
		if (!fits()) { toolbar.classList.add('stacked'); }
		toolbarSettings.style.removeProperty('width');
		toolbarSettings.style.removeProperty('max-width');
	});
}
new ResizeObserver(scheduleToolbarLayout).observe(toolbar);
void document.fonts.ready.then(() => { toolbarLayoutShape = ''; scheduleToolbarLayout(); });

let inputWidth = 0;
new ResizeObserver(() => {
	const width = inputWrap.clientWidth;
	if (width !== inputWidth) { inputWidth = width; autosize(); }
}).observe(inputWrap);

/** The commands an agent offers, as typed — `/name` for Claude Code, `$name` for Codex. */
function knownCommands(s: ChatViewState | undefined): ReadonlySet<string> {
	const agent = s ? paletteAgent(s) : undefined;
	const known = new Set((agent && s?.commands[agent] || []).map(c => c.insert));
	for (const skill of s ? visibleToolbar(s) : []) {
		known.add(`/${skill.name}`);
		known.add(`$${skill.name}`);
	}
	return known;
}

/**
 * Text with the agent's commands marked — asked for, in the box and in the
 * chat alike. Only a command the agent lists, at the start or after white
 * space, so a path or a price is never marked; trailing punctuation is not
 * part of it. Built from text nodes, so `textContent` is the text unchanged —
 * the copy button and the send's flight read it.
 */
function markCommands(text: string, known: ReadonlySet<string>): Node[] {
	const out: Node[] = [];
	let last = 0;
	const re = /(^|\s)([/$]\S+)/g;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		const name = m[2].replace(/[.,;:!?)]+$/, '');
		if (!known.has(name)) {
			continue;
		}
		const start = m.index + m[1].length;
		if (start > last) {
			out.push(document.createTextNode(text.slice(last, start)));
		}
		out.push(el('span', { class: 'cmd-token', text: name }));
		last = start + name.length;
	}
	if (last < text.length) {
		out.push(document.createTextNode(text.slice(last)));
	}
	return out;
}

/** The mirror behind the box, kept to its text and its scroll. */
function paintInput(): void {
	// A trailing line break needs something after it, or the mirror's last line
	// is one short of the textarea's.
	inputMirror.replaceChildren(...markCommands(input.value, knownCommands(state)), '\u200b');
	inputMirror.scrollTop = input.scrollTop;
}

input.addEventListener('scroll', () => { inputMirror.scrollTop = input.scrollTop; });

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
	if (paletteMode === 'inline') {
		closePalette();
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
	followInlineToken();
});

input.addEventListener('keydown', event => {
	// The inline palette takes the keys that move through it and choose from it.
	if (paletteMode === 'inline' && paletteTarget === input && paletteKey(event)) {
		event.preventDefault();
		event.stopPropagation();
		return;
	}
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
	// "/name args" naming a toolbar skill runs it: the arguments fill its
	// parameters in order, and what is still missing is asked for.
	const invoked = toolbarInvocation(text);
	if (invoked) {
		closePalette();
		input.value = '';
		saveDraft();
		autosize();
		renderSend();
		requestSkill(invoked.skill, skillAnchor(invoked.skill), invoked.values);
		return;
	}
	launchFlight(text);
	closePalette();
	paletteDismissed = undefined;
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

/**
 * `keep`: a panel left open under a menu opened from inside it — a link's
 * right-click menu in an agent's report (see `linkMenu`).
 */
function closePopups(except?: HTMLElement, keep?: HTMLElement): void {
	if (except !== agentsPanel && keep !== agentsPanel) {
		agentsView = undefined;
	}
	// Closed by another popup, the palette is closed: the next "/" opens it
	// rather than reading as a second press that closes it.
	if (except !== palette) {
		paletteMode = undefined;
	}
	if (except !== paramsPopup) {
		paramsPopup.classList.remove('repo-form');
	}
	for (const popup of [sleepPopup, menu, usagePopup, approvalPopup, palette, workdirPopup, paramsPopup, skillEditor, historyPanel, agentsPanel, agentAppsPanel]) {
		if (popup !== except && popup !== keep) {
			popup.classList.remove('open');
		}
	}
	for (const pill of [effortButton, sleepButton, agentPill, modelPill, plusButton, usageButton, approveToggle, slashButton, workdirButton, contextButton]) {
		pill.classList.remove('active');
	}
	// A skill button is a popup's anchor too; the mark only tells a second
	// press of it to close what it opened, and is not drawn (see chat.css).
	for (const { button } of skillButtons.values()) {
		button.classList.remove('active');
	}
	for (const link of document.querySelectorAll('.link.active')) {
		link.classList.remove('active');
	}
}

/** `form`: the GitHub form's own class on the reused parameters popover, set before it is measured; anything else opened there drops it. */
function openAbove(popup: HTMLElement, anchor: HTMLElement, align: 'left' | 'right', keep?: HTMLElement, form?: 'repo-form'): void {
	closePopups(popup, keep);
	popup.classList.remove('repo-form');
	if (form) {
		popup.classList.add(form);
	}
	anchor.classList.add('active');
	// Relative to the view, not the window: the popup is positioned inside
	// `#app`, and the two only coincide when nothing else is laid out around it.
	const box = app.getBoundingClientRect();
	const rect = anchor.getBoundingClientRect();
	popup.style.top = '';
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

/** A menu opened over a panel goes on its own, leaving the panel: true when there was one to close. */
function closeMenuOverPanel(): boolean {
	if (!menu.classList.contains('open') || !menu.classList.contains('over-panel')) {
		return false;
	}
	menu.classList.remove('open', 'over-panel');
	for (const link of document.querySelectorAll('.link.active')) {
		link.classList.remove('active');
	}
	return true;
}

/** Clicks elsewhere in VS Code never reach this webview's document. */
function dismissOutsideView(): void {
	pendingLocalLinkMenu = undefined;
	closePopups();
	hoverTip.hide();
}

window.addEventListener('blur', dismissOutsideView);
document.addEventListener('visibilitychange', () => {
	if (document.hidden) {
		dismissOutsideView();
	}
});

document.addEventListener('mousedown', event => {
	const target = event.target as Node;
	// A menu over a panel closes on any press outside it; the panel then
	// decides for itself below, as for any press.
	if (!menu.contains(target)) {
		closeMenuOverPanel();
	}
	// A click in the box moves the caret the inline palette follows, so it is not a click outside it.
	if (paletteMode === 'inline' && paletteTarget.contains(target)) {
		return;
	}
	// A click inside the editor closes only what is open over it.
	if (skillEditor.classList.contains('open') && skillEditor.contains(target)) {
		if (!palette.contains(target) && !menu.contains(target)) {
			palette.classList.remove('open');
			paletteMode = undefined;
		}
		return;
	}
	if (![workdirFooter, effortButton, sleepPopup, sleepButton, menu, usagePopup, approvalPopup, palette, workdirPopup, paramsPopup, skillBar, historyPanel, agentsPanel, agentAppsPanel, plusButton, usageButton, usageAlertText, agentsButton, agentPill, modelPill, approveToggle, slashButton, workdirButton, contextButton].some(n => n.contains(target))) {
		closePopups();
	}
});

document.addEventListener('keydown', event => {
	// An input method's own Escape drops a candidate, not the form it is typed
	// in: without this, cancelling a conversion closed the toolbar skill editor,
	// the GitHub form or a parameters popover, and what was typed went with it.
	if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) {
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
	// A menu over a panel first, the panel with the next Escape.
	if (closeMenuOverPanel()) {
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
	/** A key or gesture that does the same, shown at the right of the row. */
	readonly shortcut?: string;
	readonly run: () => void;
}

/** A button at the right of a menu's heading. */
interface MenuAction {
	readonly icon: string;
	readonly title: string;
	readonly run: () => void;
}

/** `keep`: the panel the menu is opened from inside, which stays open under it. */
function openMenu(anchor: HTMLElement, items: MenuItem[], heading?: string, action?: MenuAction, keep?: HTMLElement): void {
	if (menu.classList.contains('open') && anchor.classList.contains('active')) {
		closePopups();
		return;
	}
	let headingAction: HTMLButtonElement | undefined;
	if (action) {
		headingAction = button([icon(action.icon)], { class: 'ghost round menu-heading-action', title: action.title });
		headingAction.addEventListener('click', () => {
			if (!closeMenuOverPanel()) {
				closePopups();
			}
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
				item.shortcut ? el('span', { class: 'menu-shortcut', text: item.shortcut }) : '',
				item.checked ? icon('check', 'menu-check') : el('span', { class: 'menu-check' }),
			], { class: 'menu-item' });
			b.disabled = !!item.disabled;
			b.addEventListener('click', () => {
				// Opened over a panel, only the menu goes: the panel stays.
				if (!closeMenuOverPanel()) {
					closePopups();
				}
				item.run();
			});
			return b;
		}));
	// Over a panel the menu is drawn above it: a panel sits over the popups.
	menu.classList.toggle('over-panel', !!keep);
	openAbove(menu, anchor, 'left', keep);
}

effortButton.addEventListener('click', () => {
	const selection = state?.selection;
	const model = state?.agents.find(a => a.id === selection?.agent)?.models.find(m => m.id === selection?.model);
	if (!selection || !model?.efforts.length) { return; }
	openMenu(effortButton, model.efforts.map(effort => ({
		label: labelOf(effort), checked: effort === (selection.effort ?? model.efforts[0]),
		run: () => post({ type: 'select', selection: { ...selection, effort } }),
	})), 'Effort — how hard the model thinks');
});

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

/* ---------------------------------------------------------------- the "/" palette */

/**
 * The "/" palette: the chat's own commands and the agent's skills, behind a
 * search box — asked for, after Claude Code's own: press "/" and type. It
 * opens two ways. From the toolbar's "/" button it carries its own search box,
 * focused at once (`button`). Typed in the message box — "/" or "$" at the start
 * or after a space, for either agent — the box itself is the search, and the
 * palette follows what is typed after the sigil (`inline`). Choosing a skill
 * writes it into the box rather than sending it, so arguments can follow.
 *
 * Skills come from the CLI of the agent the tab uses (`state.commands`), and
 * are asked for again each time the palette opens, so one added meanwhile
 * shows up. Without a search they are grouped by where they come from; with
 * one the matches are ranked in one list, each naming its group.
 */
interface PaletteItem {
	readonly key: string;
	readonly group: string;
	readonly label: string;
	readonly hint?: string;
	readonly detail?: string;
	readonly icon?: string;
	/** Everything the search looks at, lower-cased. */
	readonly haystack: string;
	readonly name: string;
	readonly disabled?: boolean;
	readonly run: () => void;
}

type PaletteMode = 'button' | 'inline';

let paletteMode: PaletteMode | undefined;
/**
 * The text field the palette writes into: the message box, or the toolbar
 * skill editor's prompt. Only the box offers the chat's own commands and the
 * toolbar's skills.
 */
let paletteTarget: HTMLTextAreaElement = input;
/** Where the inline query starts in the box, its sigil included. */
let inlineStart = 0;
/** The box's text when the user closed the inline palette with Escape: not reopened until it changes. */
let paletteDismissed: string | undefined;
let paletteActive = 0;
let paletteItems: PaletteItem[] = [];
/** What the list was built from, so a state post rebuilds it only when that changed (#365). */
let paletteShape = '';

const paletteSearch = el('input', { class: 'palette-search' });
paletteSearch.type = 'text';
paletteSearch.spellcheck = false;
paletteSearch.placeholder = 'Search commands and skills…';
paletteSearch.setAttribute('aria-label', 'Search commands and skills');
const paletteList = el('div', { class: 'palette-list' });
paletteList.setAttribute('role', 'listbox');
palette.append(paletteSearch, paletteList);

function paletteAgent(s: ChatViewState): AgentId | undefined {
	const tab = s.tabs.find(t => t.id === s.activeTab);
	return tab?.agent ?? s.selection.agent;
}

/** Whose skills the palette lists: the editor's agent while it writes a toolbar skill's prompt, else the tab's. */
function paletteSkillsAgent(s: ChatViewState): AgentId | undefined {
	return paletteTarget === input ? paletteAgent(s) : editorAgent(s);
}

const groupNames: Record<ChatCommand['group'], string> = {
	project: 'Project',
	user: 'Personal',
	plugin: 'Plugin',
	synced: 'Synced from claude.ai',
	system: 'Built into Codex',
	builtin: 'Built into Claude Code',
};

function commandGroup(c: ChatCommand): string {
	return c.group === 'plugin' && c.plugin ? `Plugin · ${c.plugin}` : groupNames[c.group];
}

/** Clear and Export, as the "/" button always had them; the second step of each is a menu of its own. */
function chatActions(s: ChatViewState): PaletteItem[] {
	const tab = s.tabs.find(t => t.id === s.activeTab);
	const items: PaletteItem[] = [];
	// Always listed, disabled while there is nothing to act on — hidden, they
	// read as gone in a new tab, the first place a palette is opened.
	const canClear = s.entries.length > 0 || !!tab?.busy || !!tab?.skillRuns;
	const canExport = s.entries.some(e => e.kind === 'user' || e.kind === 'assistant');
	{
		items.push({
			key: 'chat:clear', group: 'Chat', name: 'clear', label: 'Clear conversation', icon: 'clear-all',
			detail: canClear ? 'Start this tab over; the conversation stays in the history' : 'Nothing to clear yet',
			disabled: !canClear,
			haystack: 'clear conversation start over',
			run: () => {
				if (!tab?.busy && !tab?.queued && !tab?.skillRuns) {
					post({ type: 'clearChat' });
					return;
				}
				// The second question in the same place, before anything is stopped.
				openMenu(slashButton, [
					{ icon: 'debug-stop', label: 'Stop and clear', description: 'What the agent is doing stops; queued messages come back to the box', run: () => post({ type: 'clearChat' }) },
					{ icon: 'close', label: 'Cancel', run: () => undefined },
				], 'The agent is still working');
			},
		});
	}
	{
		items.push({
			key: 'chat:export', group: 'Chat', name: 'export', label: 'Export conversation…', icon: 'export',
			detail: canExport ? 'As Markdown, to the clipboard or a file' : 'Nothing to export yet',
			disabled: !canExport,
			haystack: 'export conversation markdown clipboard file save',
			run: () => openMenu(slashButton, [
				{ icon: 'copy', label: 'Copy to clipboard', run: () => post({ type: 'exportChat', to: 'clipboard' }) },
				{ icon: 'save', label: 'Save to file…', description: 'Opens it in an editor tab and asks where to save', run: () => post({ type: 'exportChat', to: 'file' }) },
			], 'Export conversation'),
		});
	}
	const editable = s.toolbar;
	items.push({
		key: 'chat:toolbar-add', group: 'Toolbar', name: 'add-skill', label: 'Add skill to toolbar…', icon: 'add',
		detail: 'A prompt with parameters, as a button above the message box and as /name',
		haystack: 'add skill toolbar button new',
		run: () => openSkillEditor(),
	}, {
		key: 'chat:toolbar-edit', group: 'Toolbar', name: 'edit-skill', label: 'Edit toolbar skill…', icon: 'edit',
		detail: editable.length ? 'Choose one to change' : 'No toolbar skills yet', disabled: !editable.length,
		haystack: 'edit toolbar skill change',
		run: () => chooseToolbarSkill('Edit toolbar skill', skill => openSkillEditor(skill)),
	}, {
		key: 'chat:toolbar-delete', group: 'Toolbar', name: 'delete-skill', label: 'Delete toolbar skill…', icon: 'trash',
		detail: editable.length ? 'Choose one to remove' : 'No toolbar skills yet', disabled: !editable.length,
		haystack: 'delete remove toolbar skill',
		run: () => chooseToolbarSkill('Delete toolbar skill', skill => confirmDeleteSkill(skill, slashButton)),
	});
	return items;
}

function skillItems(s: ChatViewState): PaletteItem[] {
	const agent = paletteSkillsAgent(s);
	return (agent ? s.commands[agent] ?? [] : []).map(c => ({
		key: `${agent}:${c.insert}`,
		group: commandGroup(c),
		name: c.name.toLowerCase(),
		label: c.insert,
		hint: c.hint,
		detail: [c.title, c.description].filter(Boolean).join(' — ') || undefined,
		haystack: [c.name, c.title, c.description, c.plugin].filter(Boolean).join(' ').toLowerCase(),
		run: () => insertCommand(c),
	}));
}

function attachmentItems(s: ChatViewState): PaletteItem[] {
	return s.attachments.flatMap(chip => {
		const reference = chip.reference;
		if (!reference) { return []; }
		return [{
			key: `attachment:${chip.id}`, group: 'Attachments', name: reference.slice(1),
			label: `${reference} ${chip.label}`, icon: attachmentIcon(chip.kind),
			detail: chip.kind, haystack: `${reference} ${chip.label} ${chip.kind}`.toLowerCase(),
			run: () => {
				// closePalette preserves the query bounds before the textarea regains focus.
				input.setRangeText(`${reference} `, inlineStart, inlineEnd, 'end');
				input.focus();
				rememberAttachmentCaret();
				paletteDismissed = input.value;
				afterBoxEdit();
			},
		}];
	});
}

function paletteQuery(): string {
	if (paletteMode === 'button') {
		return paletteSearch.value.trim().toLowerCase();
	}
	const caret = paletteTarget.selectionStart ?? paletteTarget.value.length;
	return paletteTarget.value.slice(inlineStart + 1, caret).toLowerCase();
}

/**
 * Ranks a match: the name starting with the query, then the name holding it,
 * then the rest of the text holding every word of it. No match is undefined.
 */
function rank(item: PaletteItem, query: string): number | undefined {
	if (!query) {
		return 0;
	}
	if (item.name.startsWith(query)) {
		return 0;
	}
	if (item.name.includes(query)) {
		return 1;
	}
	const words = query.split(/\s+/).filter(Boolean);
	return words.every(w => item.haystack.includes(w)) ? 2 : undefined;
}

function buildPalette(s: ChatViewState): void {
	const query = paletteQuery();
	const inline = paletteMode === 'inline';
	// "/" also lists the chat's own commands, "$" only skills. Typed in the box,
	// they come after the skills and only once something is typed after the
	// "/": with "/" alone, Enter chose Clear conversation — the first row — and
	// cleared the tab without a question.
	const sigil = inline ? paletteTarget.value[inlineStart] : '/';
	const box = paletteTarget === input;
	const actions = box && sigil === '/' && (!inline || query) ? chatActions(s) : [];
	const own = box ? toolbarItems(s) : [];
	const all = box && sigil === '@' ? attachmentItems(s)
		: inline ? [...own, ...skillItems(s), ...actions] : [...actions, ...own, ...skillItems(s)];
	const ranked = all.map((item, i) => ({ item, i, r: rank(item, query) }))
		.filter((x): x is { item: PaletteItem; i: number; r: number } => x.r !== undefined);
	if (query) {
		ranked.sort((a, b) => a.r - b.r || a.i - b.i);
	}
	const previous = paletteItems[paletteActive]?.key;
	paletteItems = ranked.map(x => x.item);
	const kept = paletteItems.findIndex(i => i.key === previous && !i.disabled);
	// Never a chat command by default without a query: Enter on a fresh "/"
	// must not clear the conversation. With nothing else to offer, no row is
	// chosen until an arrow key picks one.
	// A row whose name is exactly what was typed wins over the one kept: typing
	// "/review" letter by letter kept "/review-pr", chosen at "/r", and Enter
	// inserted that while the toolbar's own "/review" — listed first, as it
	// takes precedence — sat right above it. An arrow key choice is kept while
	// it is exact too.
	const exact = query ? paletteItems.findIndex(i => !i.disabled && i.name === query) : -1;
	paletteActive = exact >= 0 && paletteItems[kept]?.name !== query ? exact
		: kept >= 0 ? kept
			: query ? stepActive(-1, 1)
				: paletteItems.findIndex(i => !i.disabled && !i.key.startsWith('chat:') && !i.key.startsWith('toolbar:'));

	const nodes: Node[] = [];
	let group: string | undefined;
	paletteItems.forEach((item, index) => {
		if (!query && item.group !== group) {
			group = item.group;
			nodes.push(el('div', { class: 'palette-group', text: group }));
		}
		const row = button([
			item.icon ? icon(item.icon, 'palette-icon') : el('span', { class: 'palette-icon' }),
			el('span', { class: 'palette-text' },
				el('span', { class: 'palette-line' },
					el('span', { class: item.icon ? 'palette-label' : 'palette-label palette-name', text: item.label }),
					item.hint ? el('span', { class: 'palette-hint', text: item.hint }) : undefined,
					query ? el('span', { class: 'palette-tag', text: item.group }) : undefined),
				item.detail ? el('span', { class: 'palette-detail', text: item.detail }) : undefined),
		], { class: 'palette-item' });
		// Not the `disabled` attribute: a disabled button gets no mousedown,
		// so a click on it took focus out of the box.
		if (item.disabled) {
			row.classList.add('disabled');
			row.setAttribute('aria-disabled', 'true');
		}
		row.setAttribute('role', 'option');
		fullRowTip(row, item);
		row.dataset.index = String(index);
		row.addEventListener('mousemove', () => !item.disabled && setPaletteActive(index, false));
		// Not a click: in the inline mode a press would take the caret out of
		// the box first, and with it the query.
		row.addEventListener('mousedown', event => event.preventDefault());
		row.addEventListener('click', () => choosePalette(index));
		nodes.push(row);
	});
	// Typed in the box, a query nothing matches is most likely not a command at
	// all — a path, a price — so the palette stays out of the way, and comes
	// back if the text starts matching again.
	palette.classList.toggle('no-match', paletteMode === 'inline' && !paletteItems.some(i => !i.disabled));
	// Where the agent's skills would be, a line saying why they are not: still
	// being looked for, none, or a listing that failed — the Chat rows alone
	// otherwise read as "this agent has no skills" in all three cases.
	const agent = paletteSkillsAgent(s);
	const listed = agent ? s.commands[agent] : undefined;
	const name = s.agents.find(a => a.id === agent)?.name ?? 'The agent';
	const status = sigil === '@' ? (paletteItems.length ? undefined : 'No matching attachments.')
		: query ? (paletteItems.length ? undefined : 'Nothing matches.')
		: s.detecting && !listed?.length ? `Looking for ${name}'s skills…`
			: !listed ? `${name}'s skills could not be listed.`
				: !listed.length ? `${name} lists no skills.` : undefined;
	if (status) {
		nodes.push(el('div', { class: 'palette-empty', text: status }));
	}
	paletteList.replaceChildren(...nodes);
	setPaletteActive(paletteActive, true);
}

/** The next enabled row from `from` in direction `dir`, wrapping; `from` itself when it is the only one. */
function stepActive(from: number, dir: 1 | -1): number {
	const n = paletteItems.length;
	for (let i = 1; i <= n; i++) {
		const at = ((from + dir * i) % n + n) % n;
		if (!paletteItems[at].disabled) {
			return at;
		}
	}
	return Math.max(0, from);
}

function setPaletteActive(index: number, scroll: boolean): void {
	paletteActive = index;
	for (const row of paletteList.querySelectorAll<HTMLElement>('.palette-item')) {
		const on = Number(row.dataset.index) === index;
		row.classList.toggle('active', on);
		row.setAttribute('aria-selected', String(on));
		if (on && scroll) {
			row.scrollIntoView({ block: 'nearest' });
		}
	}
}

function choosePalette(index: number): void {
	const item = paletteItems[index];
	if (!item || item.disabled) {
		return;
	}
	const typed = paletteMode === 'inline';
	closePalette();
	if (typed && (item.key.startsWith('chat:') || item.key.startsWith('toolbar:'))) {
		// "/clear" typed to reach Clear: the text was the way there, not a message.
		removeInlineToken();
	}
	item.run();
}

/** The "/query" or "$query" being typed, taken out of the box. */
function removeInlineToken(): void {
	const caret = paletteTarget.selectionStart ?? paletteTarget.value.length;
	paletteTarget.value = paletteTarget.value.slice(0, inlineStart) + paletteTarget.value.slice(caret);
	paletteTarget.setSelectionRange(inlineStart, inlineStart);
	afterBoxEdit();
}

function afterBoxEdit(): void {
	if (paletteTarget !== input) {
		paletteTarget.dispatchEvent(new Event('change'));
		return;
	}
	saveDraft();
	autosize();
	renderSend();
}

/**
 * A skill into the message box, followed by a space for its arguments. Typed,
 * it takes the place of what was typed, wherever that is. From the button,
 * Claude Code's goes at the start — over a "/command" already there, since a
 * command is read only there — and Codex's "$name", read anywhere, at the caret.
 */
function insertCommand(c: ChatCommand): void {
	const text = `${c.insert} `;
	let value = paletteTarget.value;
	let caret: number;
	if (paletteWasInline) {
		const end = inlineEnd;
		value = value.slice(0, inlineStart) + text + value.slice(end).replace(/^ /, '');
		caret = inlineStart + text.length;
	} else if (c.insert.startsWith('/') && paletteTarget === input) {
		// Over a "/command" already at the start — a bare "/" or one the agent
		// lists — never over a path the message begins with ("/etc/hosts …").
		const lead = /^\/\S*/.exec(value)?.[0];
		const known = lead === '/' || (lead !== undefined && !!state && (state.commands.claude ?? []).some(k => k.insert === lead));
		const rest = known ? value.slice(lead.length).replace(/^ /, '') : value;
		value = text + rest;
		caret = text.length;
	} else {
		const at = paletteTarget.selectionStart ?? value.length;
		const before = value.slice(0, at);
		const pad = before && !/\s$/.test(before) ? ' ' : '';
		value = before + pad + text + value.slice(paletteTarget.selectionEnd ?? at).replace(/^ /, '');
		caret = at + pad.length + text.length;
	}
	paletteTarget.value = value;
	paletteTarget.focus();
	paletteTarget.setSelectionRange(caret, caret);
	paletteDismissed = paletteTarget.value;
	afterBoxEdit();
}

/** Set as the palette closes, for `insertCommand`: whether it replaces a typed query, and where that ended. */
let paletteWasInline = false;
let inlineEnd = 0;

function closePalette(): void {
	paletteWasInline = paletteMode === 'inline';
	inlineEnd = paletteTarget.selectionStart ?? paletteTarget.value.length;
	paletteMode = undefined;
	palette.classList.remove('open');
	slashButton.classList.remove('active');
}

function openPalette(mode: PaletteMode): void {
	const s = state;
	if (!s) {
		return;
	}
	paletteMode = mode;
	paletteActive = 0;
	paletteShape = '';
	paletteSearch.hidden = mode === 'inline';
	palette.classList.toggle('inline', mode === 'inline');
	if (mode === 'button') {
		paletteTarget = input;
		paletteSearch.value = '';
		palette.style.top = '';
		openAbove(palette, slashButton, 'left');
	} else {
		// In the editor nothing else is open but the editor itself, which stays.
		if (paletteTarget === input) {
			closePopups(palette);
		}
		const box = app.getBoundingClientRect();
		const rect = (paletteTarget === input ? composer : paletteTarget).getBoundingClientRect();
		palette.style.top = '';
		palette.style.bottom = `${box.bottom - rect.top + 6}px`;
		// The editor's prompt sits near the top of the view: under it, then.
		if (paletteTarget !== input && rect.top - box.top < 220) {
			palette.style.bottom = '';
			palette.style.top = `${rect.bottom - box.top + 6}px`;
		}
		palette.style.left = `${Math.max(8, rect.left - box.left)}px`;
		palette.style.right = '';
		palette.classList.add('open');
	}
	renderPalette(s);
	if (mode === 'button') {
		paletteSearch.focus();
	}
	const agent = paletteSkillsAgent(s);
	if (agent && !(mode === 'inline' && paletteTarget.value[inlineStart] === '@')) {
		post({ type: 'listCommands', agent });
	}
}

function renderPalette(s: ChatViewState): void {
	if (!paletteMode) {
		return;
	}
	if (!palette.classList.contains('open')) {
		paletteMode = undefined;
		return;
	}
	// Typed in the box, the query must still be there: the box can be emptied or
	// rewritten under it (a send, another chat, a recalled message), and an empty
	// query matches every skill — the palette came back over an empty box and
	// took ↑ and Enter.
	if (paletteMode === 'inline' && inlineToken() !== inlineStart) {
		closePalette();
		return;
	}
	const agent = paletteSkillsAgent(s);
	const shape = JSON.stringify([agent, paletteTarget === input, s.toolbar, paletteMode === 'inline' ? paletteTarget.value.slice(inlineStart, paletteTarget.selectionStart ?? undefined) : paletteSearch.value,
		s.detecting, agent ? s.commands[agent] : undefined, s.attachments, s.entries.length > 0,
		s.entries.some(e => e.kind === 'user' || e.kind === 'assistant'), s.tabs.find(t => t.id === s.activeTab)?.busy]);
	if (shape === paletteShape) {
		return;
	}
	paletteShape = shape;
	buildPalette(s);
}

/** Moves through the list and chooses from it; true when the key was the palette's. */
function paletteKey(event: KeyboardEvent): boolean {
	if (!paletteMode || event.isComposing) {
		return false;
	}
	const n = paletteItems.filter(i => !i.disabled).length;
	// Hidden for want of a match, the inline palette leaves every key to the box.
	if (paletteMode === 'inline' && !n) {
		return false;
	}
	switch (event.key) {
		case 'ArrowDown':
		case 'ArrowUp':
			if (n) {
				setPaletteActive(stepActive(paletteActive, event.key === 'ArrowDown' ? 1 : -1), true);
			}
			return true;
		case 'Enter':
		case 'Tab':
			// No row chosen yet: typed in the box, the key is the box's (Enter
			// sends); from the button there is nothing to send.
			if (event.shiftKey || !n || paletteActive < 0) {
				return event.key === 'Enter' && paletteMode === 'button';
			}
			choosePalette(paletteActive);
			return true;
		case 'Escape':
			if (paletteMode === 'inline') {
				paletteDismissed = paletteTarget.value;
			}
			closePalette();
			paletteTarget.focus();
			return true;
	}
	return false;
}

/**
 * The query being typed in the box, if any: "/" or "$" at the start of the box
 * or after white space, with no space yet — the caret at its end. Asked for:
 * anywhere in the text, for both agents; the sigil chosen writes the agent's
 * own (`/name` for Claude Code, `$name` for Codex) in its place.
 */
function inlineToken(): number | undefined {
	if (paletteTarget.selectionStart !== paletteTarget.selectionEnd) {
		return undefined;
	}
	const caret = paletteTarget.selectionStart ?? 0;
	const before = paletteTarget.value.slice(0, caret);
	const after = paletteTarget.value.slice(caret);
	if (after && !/^\s/.test(after)) {
		return undefined;
	}
	const m = (paletteTarget === input ? /(^|\s)[/@$]\S*$/ : /(^|\s)[/$]\S*$/).exec(before);
	return m ? m.index + m[1].length : undefined;
}

/** After every edit and caret move in a text field: opens, follows or closes the inline palette. */
function followInlineToken(target: HTMLTextAreaElement = input): void {
	if (paletteMode === 'button') {
		return;
	}
	if (paletteMode === 'inline' && paletteTarget !== target) {
		closePalette();
	}
	paletteTarget = target;
	if (paletteTarget.value !== paletteDismissed) {
		paletteDismissed = undefined;
	}
	const start = paletteDismissed === undefined ? inlineToken() : undefined;
	if (start === undefined) {
		if (paletteMode === 'inline') {
			closePalette();
		}
		return;
	}
	inlineStart = start;
	if (paletteMode !== 'inline') {
		openPalette('inline');
	} else if (state) {
		renderPalette(state);
	}
}

paletteSearch.addEventListener('input', () => state && renderPalette(state));
paletteSearch.addEventListener('keydown', event => {
	if (paletteKey(event)) {
		event.preventDefault();
		event.stopPropagation();
	}
});
input.addEventListener('keyup', event => {
	if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
		followInlineToken();
	}
});
input.addEventListener('click', () => followInlineToken());

slashButton.addEventListener('click', () => {
	if (paletteMode === 'button') {
		closePalette();
		return;
	}
	openPalette('button');
});

/* ---------------------------------------------------------------- the working folder */

/**
 * The folder button, right of "/": where the tab's agent works, and the files
 * of that folder to add to the message — asked for. A search box at the top,
 * focused at once, as in the "/" palette; under it the folders to work in (the
 * one in use, the window's own, those picked lately, and Choose folder…),
 * then the files and folders of the one in use. Without a search the files
 * are the folder's own entries; with one, the best matches from anywhere in
 * it (`searchPaths`). A file or folder chosen is attached as its path.
 *
 * A conversation that has started keeps its folder: another one opens a new
 * tab (`StoredChat.folder`), and the rows say so.
 */
interface WorkdirItem {
	readonly key: string;
	readonly group: string;
	readonly label: string;
	readonly detail?: string;
	readonly icon: string;
	readonly current?: boolean;
	readonly run: () => void;
}

/** Results shown at most for a search; the listing itself can be 20 000 long. */
const workdirResultLimit = 100;
/** The working folder's listing, as the host last sent it. */
const workdirListings = new Map<string, { entries: readonly string[]; truncated: boolean; revision: number }>();
/** Counts the listings that arrived, so one with the same number of entries still rebuilds the list. */
let workdirRevision = 0;

/** The listing of the folder in use, when one has arrived. */
function currentListing(s: ChatViewState) {
	return s.workdir.current ? workdirListings.get(s.workdir.current.path) : undefined;
}
let workdirItems: WorkdirItem[] = [];
let workdirActive = 0;
/** What the list was built from: a state post rebuilds it only when that changed (#365). */
let workdirShape = '';
/** The folder whose files were last asked for while the list is open. */
let workdirAsked: string | undefined;

const workdirSearch = el('input', { class: 'palette-search' });
workdirSearch.type = 'text';
workdirSearch.spellcheck = false;
workdirSearch.placeholder = 'Search folders and files…';
workdirSearch.setAttribute('aria-label', 'Search folders and files');
const workdirList = el('div', { class: 'palette-list' });
workdirList.setAttribute('role', 'listbox');
workdirPopup.append(workdirSearch, workdirList);

function workdirItemsFor(s: ChatViewState, query: string): WorkdirItem[] {
	const w = s.workdir;
	const items: WorkdirItem[] = [];
	const group = 'Working folder';
	const move = w.locked ? ' · opens a new tab' : '';
	const folderRow = (f: WorkdirFolder, origin: string): WorkdirItem => ({
		key: `folder:${f.path}`, group, label: f.name, icon: 'folder', detail: `${f.path} — ${origin}${move}`,
		run: () => post({ type: 'setWorkdir', path: f.path }),
	});
	if (w.current) {
		items.push({
			key: 'folder:current', group, label: w.current.name, icon: 'check', current: true,
			detail: `${w.current.path} — in use${w.locked ? ' by this conversation' : ''}${w.noProject ? '; the home directory, so no project: Codex only reads, and every file counts as outside' : ''}`,
			run: () => input.focus(),
		});
	} else {
		items.push({ key: 'folder:current', group, label: 'No folder', icon: 'check', current: true, detail: 'The home directory, with no project', run: () => input.focus() });
	}
	const seen = new Set(w.current ? [w.current.path] : []);
	for (const f of w.workspace) {
		if (!seen.has(f.path)) {
			seen.add(f.path);
			items.push(folderRow(f, "this window's folder"));
		}
	}
	for (const f of w.recent) {
		if (!seen.has(f.path)) {
			seen.add(f.path);
			items.push(folderRow(f, 'picked recently'));
			if (f.removable) {
				items.push({
					key: `folder:remove:${f.path}`, group, label: `Remove ${f.name}…`, icon: 'trash',
					detail: `Delete the temporary repository copy — ${f.path}`,
					run: () => openMenu(workdirButton, [
						{ icon: 'trash', label: 'Remove', description: 'Changes not pushed are lost', run: () => post({ type: 'removeRepoFolder', path: f.path }) },
						{ icon: 'close', label: 'Cancel', run: () => undefined },
					], `Remove ${f.name}? Changes not pushed are lost.`),
				});
			}
		}
	}
	// Picked in a window with no folder: the way back to none.
	if (w.picked && !w.workspace.length) {
		items.push({ key: 'folder:none', group, label: 'No folder', icon: 'home', detail: `The home directory, with no project${move}`, run: () => post({ type: 'setWorkdir' }) });
	}
	items.push({
		key: 'folder:choose', group, label: 'Choose folder…', icon: 'folder-opened',
		detail: `Any folder on this machine${move}`, run: () => post({ type: 'chooseWorkdir' }),
	});
	items.push(...githubItems(w, move));
	const folders = query ? items.filter(i => i.key === 'folder:choose' || i.key === 'github:open' || [i.label, i.detail].join(' ').toLowerCase().includes(query)) : items;

	const files: WorkdirItem[] = [];
	const listing = currentListing(s);
	if (w.current && listing) {
		const filesGroup = `Files in ${w.current.name}`;
		for (const entry of searchPaths(listing.entries, query, workdirResultLimit)) {
			const isDir = entry.endsWith('/');
			const parent = entry.slice(0, entry.length - baseName(entry).length - (isDir ? 1 : 0));
			files.push({
				key: `file:${entry}`, group: filesGroup, label: isDir ? `${baseName(entry)}/` : baseName(entry),
				icon: isDir ? 'folder' : 'file', detail: parent ? parent.replace(/\/$/, '') : undefined,
				run: () => post({ type: 'attachPath', path: entry }),
			});
		}
	}
	// With a search, the files first: the folders are a handful and rarely what is typed for.
	return query ? [...files, ...folders] : [...folders, ...files];
}

/**
 * The GitHub rows: on a separate copy, what can be done with it; then opening
 * a repository — the form asks which way (`openRepoForm`) — and the ones
 * opened lately, which open the form filled in.
 */
function githubItems(w: ChatViewState['workdir'], move: string): WorkdirItem[] {
	const group = 'GitHub';
	const items: WorkdirItem[] = [];
	if (w.busy) {
		items.push({ key: 'github:busy', group, label: `${w.busy[0].toUpperCase()}${w.busy.slice(1)}…`, icon: 'sync', detail: 'In the status bar while it runs', run: () => input.focus() });
	}
	if (w.copy) {
		const copy = w.copy;
		items.push(
			{ key: 'github:changes', group, label: 'Changes in the copy', icon: 'diff', detail: `Against ${copy.base}, in an editor tab`, run: () => post({ type: 'repoAction', action: 'changes' }) },
			{
				key: 'github:push', group, label: 'Push and open a pull request…', icon: 'git-pull-request', detail: `${copy.branch} into ${copy.base}`,
				run: () => openMenu(workdirButton, [
					{ icon: 'cloud-upload', label: 'Push', description: `Uncommitted changes are committed first, as the chat's title; then ${copy.branch} goes to GitHub and the pull request page opens`, run: () => post({ type: 'repoAction', action: 'push' }) },
					{ icon: 'close', label: 'Cancel', run: () => undefined },
				], `Push to ${copy.repo}?`),
			},
			{ key: 'github:window', group, label: 'Open the copy in a new window', icon: 'empty-window', detail: 'To look at it, or carry on by hand', run: () => post({ type: 'repoAction', action: 'window' }) },
			{
				key: 'github:remove', group, label: 'Remove the copy…', icon: 'trash', detail: 'What was not pushed is lost',
				run: () => openMenu(workdirButton, [
					{ icon: 'trash', label: 'Remove', description: w.locked ? 'This conversation worked there and cannot go on; it stays in the history' : 'The tab goes back to the window\'s folder', run: () => post({ type: 'repoAction', action: 'remove' }) },
					{ icon: 'close', label: 'Cancel', run: () => undefined },
				], 'Remove the copy? Changes not pushed are lost.'),
			},
		);
	}
	for (const r of w.references) {
		items.push({ key: `github:ref:${r.path}`, group, label: `${r.repo} (${r.branch})`, icon: 'book', current: true, detail: `Read beside the project — ${r.path}`, run: () => input.focus() });
	}
	if (w.heldBack?.length) {
		const files = w.heldBack.join(', ');
		items.push({
			key: 'github:trust', group, label: "Trust this repository's settings…", icon: 'shield', detail: `Held back: ${files}`,
			run: () => openMenu(workdirButton, [
				{ icon: 'shield', label: 'Trust and load them', description: `Claude Code loads ${files} from the next message on. Hooks there are shell commands that run on your machine — read them first`, run: () => post({ type: 'trustWorkdir' }) },
				{ icon: 'close', label: 'Cancel', run: () => undefined },
			], "Trust this repository's own settings?"),
		});
	}
	items.push({ key: 'github:open', group, label: 'Open a GitHub repository…', icon: 'github', detail: `Work in a copy, clone it, or read it beside the project${move}`, run: () => openRepoForm('') });
	for (const repo of w.recentRepos) {
		items.push({ key: `github:repo:${repo}`, group, label: repo, icon: 'repo', detail: 'Opened lately', run: () => openRepoForm(repo) });
	}
	return items;
}

/** The GitHub form's error line and Open button, while it is open; `githubAnswer` writes to them. */
let repoFormError: HTMLElement | undefined;
let repoFormSubmit: HTMLButtonElement | undefined;

/**
 * Which way a repository is used — asked for: the choice is the user's, each
 * option saying what it does to their files. The default is a separate copy,
 * or a clone into the folder in use when that is empty.
 */
function openRepoForm(repo: string): void {
	const w = state?.workdir;
	if (!w) {
		return;
	}
	const repoInput = el('input', { class: 'form-input' });
	repoInput.type = 'text';
	repoInput.spellcheck = false;
	repoInput.value = repo;
	repoInput.placeholder = 'owner/name, or its github.com address';
	const branchInput = el('input', { class: 'form-input' });
	branchInput.type = 'text';
	branchInput.spellcheck = false;
	branchInput.placeholder = 'Its default branch';
	const newTab = w.locked ? ' Opens a new tab.' : '';
	const modes: { mode: RepoMode; label: string; detail: string }[] = [
		{ mode: 'copy', label: 'Work in a separate copy', detail: `Cloned into the extension's own storage, on a new branch. Your folders are not touched; the work goes back as a pull request.${newTab}` },
		{
			mode: 'clone', label: w.empty && w.current ? `Clone into ${w.current.name}` : 'Clone into a folder',
			detail: w.empty && w.current ? `It is empty; the agent then works in the clone.` : `You pick the folder; the agent then works in the clone.${newTab}`,
		},
		{ mode: 'reference', label: 'Read it beside this project', detail: 'The agent works here as before and can read the repository; nothing there is changed.' },
	];
	let chosen: RepoMode = w.empty && w.current ? 'clone' : 'copy';
	const options = modes.map(m => {
		const option = button([
			icon('circle-large-outline', 'repo-mode-mark'),
			el('span', { class: 'repo-mode-text' }, el('span', { class: 'repo-mode-label', text: m.label }), el('span', { class: 'repo-mode-detail', text: m.detail })),
		], { class: 'repo-mode' });
		option.setAttribute('role', 'radio');
		option.addEventListener('click', () => { chosen = m.mode; mark(); });
		return { mode: m.mode, option };
	});
	const mark = () => {
		for (const { mode, option } of options) {
			const on = mode === chosen;
			option.classList.toggle('chosen', on);
			option.setAttribute('aria-checked', String(on));
			const glyph = option.querySelector('.repo-mode-mark')!;
			glyph.classList.toggle('codicon-pass-filled', on);
			glyph.classList.toggle('codicon-circle-large-outline', !on);
		}
	};
	mark();
	const error = el('div', { class: 'form-error' });
	const open = button([el('span', { text: 'Open' })], { class: 'primary', title: 'Open (Enter)' });
	const cancel = button([el('span', { text: 'Cancel' })], { class: 'ghost' });
	repoFormError = error;
	repoFormSubmit = open;
	const submit = () => {
		if (!repoInput.value.trim()) {
			error.textContent = 'Which repository?';
			repoInput.focus();
			return;
		}
		error.textContent = chosen === 'clone' && !(w.empty && w.current) ? 'Pick the folder in the dialog…' : '';
		// Until the host answers: one press, one clone.
		open.setAttribute('disabled', '');
		post({ type: 'openRepo', repo: repoInput.value, branch: branchInput.value, mode: chosen });
	};
	open.addEventListener('click', submit);
	cancel.addEventListener('click', () => { closePopups(); input.focus(); });
	paramsPopup.replaceChildren(
		el('div', { class: 'menu-heading', text: 'Open a GitHub repository' }),
		el('label', { class: 'form-row' }, el('span', { class: 'form-label', text: 'Repository' }), repoInput),
		el('label', { class: 'form-row' }, el('span', { class: 'form-label', text: 'Branch (optional)' }), branchInput),
		el('div', { class: 'form-label repo-mode-heading', text: 'How to use it' }),
		el('div', { class: 'repo-modes' }, ...options.map(o => o.option)),
		error,
		el('div', { class: 'form-actions' }, cancel, open));
	paramsPopup.onkeydown = event => {
		if (event.key === 'Enter' && !event.isComposing && (event.target === repoInput || event.target === branchInput)) {
			event.preventDefault();
			submit();
		}
	};
	openAbove(paramsPopup, workdirButton, 'left', undefined, 'repo-form');
	(repo ? branchInput : repoInput).focus();
}

/** What the list says under the files when it has no files to show. */
function workdirStatus(s: ChatViewState, query: string, shown: number): string | undefined {
	const current = s.workdir.current;
	if (!current) {
		return 'No folder in use — choose one to see its files.';
	}
	const listing = currentListing(s);
	if (!listing) {
		return 'Listing the files…';
	}
	if (!listing.entries.length) {
		return 'The folder is empty, or could not be read.';
	}
	if (query && !shown) {
		return 'No file matches.';
	}
	if (listing.truncated) {
		return `Only the first ${listing.entries.length.toLocaleString()} files are listed; the search looks among them.`;
	}
	return undefined;
}

function buildWorkdir(s: ChatViewState): void {
	const query = workdirSearch.value.trim().toLowerCase();
	workdirItems = workdirItemsFor(s, query);
	// Kept only when picked with an arrow key, and only while the search is the
	// one it was picked in. A row chosen by the first letters, or under a
	// pointer passing by, outlived the typing: Enter then attached that file
	// over the best match, or moved the conversation to a folder row (#412's
	// lesson, here).
	const kept = workdirArrowed && workdirArrowed.query === query ? workdirItems.findIndex(i => i.key === workdirArrowed!.key) : -1;
	// With a search the best file is chosen; without one, nothing — Enter on a
	// fresh list must not move the conversation to another folder.
	// With a search only a file is chosen by default: a folder row chosen that
	// way moved the conversation, or opened Choose folder…, on a typo and Enter.
	workdirActive = kept >= 0 ? kept : query && workdirItems[0]?.key.startsWith('file:') ? 0 : -1;
	const nodes: Node[] = [];
	let group: string | undefined;
	const files = workdirItems.filter(i => i.key.startsWith('file:')).length;
	let status = workdirStatus(s, query, files);
	workdirItems.forEach((item, index) => {
		if (item.group !== group) {
			// Without a search the status goes where the files would be, after the
			// folders (a cut listing's note before its files); with one, at the end.
			if (group === 'GitHub' && !query && status) {
				nodes.push(el('div', { class: 'palette-empty', text: status }));
				status = undefined;
			}
			group = item.group;
			nodes.push(el('div', { class: 'palette-group', text: group }));
		}
		const row = button([
			icon(item.icon, 'palette-icon'),
			el('span', { class: 'palette-text' },
				el('span', { class: 'palette-line' }, el('span', { class: 'palette-label', text: item.label })),
				item.detail ? el('span', { class: 'palette-detail', text: item.detail }) : undefined),
		], { class: item.current ? 'palette-item current' : 'palette-item' });
		row.setAttribute('role', 'option');
		fullRowTip(row, item);
		row.dataset.index = String(index);
		row.addEventListener('mousemove', () => setWorkdirActive(index, false));
		// The search box keeps the focus, and with it what is typed.
		row.addEventListener('mousedown', event => event.preventDefault());
		row.addEventListener('click', () => chooseWorkdirItem(index));
		nodes.push(row);
	});
	if (status) {
		nodes.push(el('div', { class: 'palette-empty', text: status }));
	}
	workdirList.replaceChildren(...nodes);
	setWorkdirActive(workdirActive, true);
}

/** The row picked with an arrow key, and the search it was picked in. */
let workdirArrowed: { readonly key: string; readonly query: string } | undefined;

function setWorkdirActive(index: number, scroll: boolean): void {
	workdirActive = index;
	for (const row of workdirList.querySelectorAll<HTMLElement>('.palette-item')) {
		const on = Number(row.dataset.index) === index;
		row.classList.toggle('active', on);
		row.setAttribute('aria-selected', String(on));
		if (on && scroll) {
			row.scrollIntoView({ block: 'nearest' });
		}
	}
}

function chooseWorkdirItem(index: number): void {
	const item = workdirItems[index];
	if (!item) {
		return;
	}
	closePopups();
	item.run();
}

function renderWorkdir(s: ChatViewState): void {
	const w = s.workdir;
	workdirButton.title = w.current
		? `Working folder: ${w.current.path}${w.picked ? '' : " (this window's)"} — where the agent works, and its files to add to the message`
		: 'Working folder: none, the home directory — choose a folder for the agent to work in, and its files to add to the message';
	workdirButton.classList.toggle('picked', w.picked);
	const currentProject = !w.copy && !w.noProject && !!w.current && w.workspace.some(folder => folder.path === w.current?.path);
	const mode = w.copy ? 'GitHub' : w.noProject || !w.current ? 'Home' : currentProject ? 'Current' : 'External';
	const location = w.copy ? `${w.copy.repo} · ${w.copy.branch}` : w.current?.path ?? 'Home directory · no project';
	workdirMode.textContent = mode;
	workdirLocationText.textContent = location;
	workdirLocation.classList.toggle('path-tail', !!w.current && !w.copy);
	const detail = w.copy
		? `GitHub: ${w.copy.repo}\nBranch: ${w.copy.branch} (from ${w.copy.base})\nWorking copy: ${w.current?.path ?? ''}`
		: `${workdirButton.title}${w.noProject ? '\nHome directory, with no project' : ''}`;
	const references = w.references.length ? `\nGitHub references: ${w.references.map(r => r.repo).join(', ')}` : '';
	const summary = `${detail}${references}${w.busy ? `\n${w.busy}…` : ''}`;
	workdirSummary.title = summary;
	workdirSummary.setAttribute('aria-label', `${mode}: ${location}. Click to change working folder or GitHub mode`);
	workdirButton.title = summary;
	workdirButton.setAttribute('aria-label', 'Change working folder or GitHub mode');
	workdirFooter.classList.toggle('github-mode', !!w.copy);
	workdirFooter.classList.toggle('current-project', currentProject);
	workdirFooter.classList.toggle('external-folder', !w.copy && !w.noProject && !!w.current && !currentProject);
	if (!workdirPopup.classList.contains('open')) {
		return;
	}
	const shape = JSON.stringify([w, workdirSearch.value, currentListing(s)?.revision]);
	// Not under a press: a listing arriving between a press and its release
	// rebuilt the rows and lost the click (#365). Rebuilt when the press ends.
	if (workdirPressed) {
		return;
	}
	if (shape === workdirShape) {
		return;
	}
	// A folder moved to while the list is open — another tab, Choose folder…:
	// its files are asked for.
	if (w.current && w.current.path !== workdirAsked) {
		workdirAsked = w.current.path;
		post({ type: 'listWorkdir' });
	}
	workdirShape = shape;
	buildWorkdir(s);
}

function openWorkdir(): void {
	if (!state) {
		return;
	}
	workdirSearch.value = '';
	workdirArrowed = undefined;
	workdirShape = '';
	workdirActive = -1;
	openAbove(workdirPopup, workdirButton, 'left');
	// Asked every time it opens: files come and go while a message is written.
	workdirAsked = state.workdir.current?.path;
	post({ type: 'listWorkdir' });
	renderWorkdir(state);
	workdirSearch.focus();
}

/** A pointer is pressed in the list: it is not rebuilt until the press ends. */
let workdirPressed = false;
workdirList.addEventListener('mousedown', () => { workdirPressed = true; });
document.addEventListener('mouseup', () => {
	if (!workdirPressed) {
		return;
	}
	workdirPressed = false;
	// After the click that this release makes has run.
	setTimeout(() => state && renderWorkdir(state), 0);
});

workdirButton.addEventListener('click', () => {
	if (workdirPopup.classList.contains('open')) {
		closePopups();
		return;
	}
	openWorkdir();
});
workdirSearch.addEventListener('input', () => state && renderWorkdir(state));
workdirSearch.addEventListener('keydown', event => {
	if (event.isComposing) {
		return;
	}
	const n = workdirItems.length;
	switch (event.key) {
		case 'ArrowDown':
		case 'ArrowUp':
			if (n) {
				const dir = event.key === 'ArrowDown' ? 1 : -1;
				setWorkdirActive(((workdirActive < 0 ? (dir === 1 ? -1 : 0) : workdirActive) + dir + n) % n, true);
				workdirArrowed = { key: workdirItems[workdirActive].key, query: workdirSearch.value.trim().toLowerCase() };
			}
			break;
		case 'Enter':
			if (workdirActive >= 0) {
				chooseWorkdirItem(workdirActive);
			}
			break;
		case 'Escape':
			closePopups();
			input.focus();
			break;
		default:
			return;
	}
	event.preventDefault();
	event.stopPropagation();
});

/* ---------------------------------------------------------------- the toolbar of skills */

/**
 * Skills of the chat's own, as buttons above the message box — asked for. A
 * skill is a prompt that may name the agents' skills and take parameters
 * (`{{name}}`); pressed, it asks for the parameters it has and runs: into the
 * chat as a message, or in the background with the result on the clipboard,
 * or silently, the button saying when it is done. It is also a command:
 * `/name` or `$name` in the palette, or sent as a message with its arguments.
 *
 * The bar shows the skills the tab's agent is offered (`agents`). Right-click
 * a button for Edit, Delete and moving it; the "/" menu has the same.
 */

const codiconNames: readonly string[] = codiconCsv.split('\n').slice(1)
	.map(line => line.split(',')[0].trim())
	.filter(name => /^[a-z0-9-]+$/.test(name));

function visibleToolbar(s: ChatViewState): ToolbarSkill[] {
	const agent = paletteAgent(s);
	return s.toolbar.filter(skill => skill.agents === 'all' || skill.agents === agent);
}

/** Each skill's button, kept across posts and updated in place (#365): a run's state changes it often. */
const skillButtons = new Map<string, { button: HTMLButtonElement; shape: string }>();


let draggedSkill: string | undefined;
let skillDragEnded = -Infinity;

function clearSkillDropMarks(): void {
	for (const { button } of skillButtons.values()) {
		button.classList.remove('drop-before', 'drop-after');
	}
}

function makeSkillDraggable(button: HTMLButtonElement, id: string): void {
	button.draggable = true;
	button.addEventListener('dragstart', event => {
		if (!event.dataTransfer) { event.preventDefault(); return; }
		draggedSkill = id;
		event.dataTransfer.effectAllowed = 'move';
		event.dataTransfer.setData('application/x-ai-browser-toolbar-skill', id);
		button.classList.add('dragging');
		hoverTip.hide();
		closePopups();
	});
	button.addEventListener('dragover', event => {
		if (!draggedSkill || draggedSkill === id) { clearSkillDropMarks(); return; }
		event.preventDefault();
		if (event.dataTransfer) { event.dataTransfer.dropEffect = 'move'; }
		clearSkillDropMarks();
		const rect = button.getBoundingClientRect();
		button.classList.add(event.clientX >= rect.left + rect.width / 2 ? 'drop-after' : 'drop-before');
	});
	button.addEventListener('dragleave', () => button.classList.remove('drop-before', 'drop-after'));
	button.addEventListener('drop', event => {
		if (!draggedSkill) { return; }
		event.preventDefault();
		event.stopPropagation();
		const from = draggedSkill;
		const rect = button.getBoundingClientRect();
		const after = event.clientX >= rect.left + rect.width / 2;
		clearSkillDropMarks();
		if (from !== id) { post({ type: 'placeToolbarSkill', id: from, target: id, after }); }
	});
	button.addEventListener('dragend', () => {
		draggedSkill = undefined;
		skillDragEnded = performance.now();
		button.classList.remove('dragging');
		clearSkillDropMarks();
	});
}

function updateSkillExpandButton(expanded: boolean): void {
	skillExpandButton.replaceChildren(icon(expanded ? 'chevron-down' : 'chevron-up'));
	const label = expanded ? 'Collapse skills' : 'Show all skills';
	skillExpandButton.title = label;
	skillExpandButton.dataset.tip = label;
	skillExpandButton.setAttribute('aria-label', label);
	skillExpandButton.setAttribute('aria-expanded', String(expanded));
}

let skillLayoutFrame: number | undefined;
function scheduleSkillLayout(): void {
	if (skillLayoutFrame !== undefined) { return; }
	skillLayoutFrame = requestAnimationFrame(() => {
		skillLayoutFrame = undefined;
		if (!skillBar.clientWidth) { return; }
		const gap = parseFloat(getComputedStyle(skillBar).columnGap) || 0;
		const buttons = Array.from(skillList.children) as HTMLElement[];
		const width = buttons.reduce((sum, b) => sum + b.getBoundingClientRect().width, 0) + Math.max(0, buttons.length - 1) * gap;
		const overflow = width > skillBar.clientWidth - skillAddButton.offsetWidth - gap;
		skillExpandButton.hidden = !overflow;
		if (!overflow && skillBar.classList.contains('expanded')) {
			skillBar.classList.remove('expanded');
			updateSkillExpandButton(false);
		}
	});
}
new ResizeObserver(scheduleSkillLayout).observe(skillBar);

function renderSkillBar(s: ChatViewState): void {
	const skills = visibleToolbar(s);
	const keep = new Set(skills.map(k => k.id));
	for (const [id, entry] of skillButtons) {
		if (!keep.has(id)) {
			entry.button.remove();
			skillButtons.delete(id);
		}
	}
	skills.forEach((skill, index) => {
		let entry = skillButtons.get(skill.id);
		if (!entry) {
			const button = el('button', { class: 'skill-button' });
			button.type = 'button';
			const id = skill.id;
			// ⌘/Ctrl+click queues it for after the running turn, as ⌘Enter queues a message.
			button.addEventListener('click', event => {
				if (!draggedSkill && performance.now() - skillDragEnded > 250) { pressSkill(id, button, event.metaKey || event.ctrlKey); }
			});
			makeSkillDraggable(button, id);
			hoverTip.attach(button);
			button.addEventListener('contextmenu', event => {
				event.preventDefault();
				skillMenu(id, button);
			});
			entry = { button, shape: '' };
			skillButtons.set(skill.id, entry);
		}
		const run = s.toolbarRuns[skill.id];
		const shape = JSON.stringify([skill.icon, skill.label]);
		if (shape !== entry.shape) {
			entry.shape = shape;
			entry.button.replaceChildren(icon(skill.icon), skill.label ? el('span', { class: 'skill-label', text: skill.label }) : '');
		}
		for (const part of ['text', 'border', 'icon'] as const) {
			const tint = skillColor(skill.colors?.[part]);
			entry.button.classList.toggle(`tint-${part}`, !!tint);
			if (tint) {
				entry.button.style.setProperty(`--skill-${part}`, tint);
			} else {
				entry.button.style.removeProperty(`--skill-${part}`);
			}
		}
		for (const status of ['running', 'waiting', 'done', 'failed'] as const) {
			entry.button.classList.toggle(status, run?.status === status);
		}
		const sigil = paletteAgent(s) === 'codex' ? '$' : '/';
		const base = skill.tooltip ?? `${sigil}${skill.name}`;
		const runs = run?.count ? `${run.count} runs` : run?.steps ? `prompt ${run.step} of ${run.steps}` : 'running';
		const note = run?.status === 'running' ? ` — ${run.inChat ? 'running in the chat' : runs}; click to run again or stop`
			: run?.status === 'waiting' ? ' — waiting for your answer, click to answer'
				: run?.message ? ` — ${run.message}` : '';
		// Drawn by the view (`hoverTip`), not a native `title`, which did not show
		// on these buttons in VS Code; set only when it changes.
		const tip = `${base}${note}`;
		if (entry.button.dataset.tip !== tip) {
			entry.button.dataset.tip = tip;
			entry.button.setAttribute('aria-label', tip);
			if (hoverTip.anchor === entry.button) {
				hoverTip.show(entry.button);
			}
		}
		if (skillList.children[index] !== entry.button) {
			skillList.insertBefore(entry.button, skillList.children[index] ?? null);
		}
	});
	scheduleSkillLayout();
}

/**
 * A tooltip drawn in the view, for buttons whose native `title` did not show:
 * after a short rest of the pointer, above the button (below it when there is
 * no room), kept inside `#app`, gone on leave, on a press and on scroll.
 * Reads the button's `data-tip`, so a text that changes while it is up is
 * redrawn in place.
 */
const hoverTip = (() => {
	const node = el('div', { class: 'hover-tip' });
	node.setAttribute('role', 'tooltip');
	let timer: ReturnType<typeof setTimeout> | undefined;
	const api = {
		anchor: undefined as HTMLElement | undefined,
		show(anchor: HTMLElement): void {
			const text = anchor.dataset.tip;
			if (!text || !anchor.isConnected) {
				api.hide();
				return;
			}
			api.anchor = anchor;
			node.textContent = text;
			if (!node.isConnected) {
				app.append(node);
			}
			node.classList.add('open');
			const box = app.getBoundingClientRect();
			const r = anchor.getBoundingClientRect();
			const w = node.offsetWidth;
			const h = node.offsetHeight;
			const left = Math.min(Math.max(4, r.left - box.left + r.width / 2 - w / 2), box.width - w - 4);
			const above = r.top - box.top - h - 6;
			node.style.left = `${Math.max(4, left)}px`;
			node.style.top = `${above >= 4 ? above : r.bottom - box.top + 6}px`;
		},
		hide(): void {
			clearTimeout(timer);
			timer = undefined;
			api.anchor = undefined;
			node.classList.remove('open');
		},
		attach(anchor: HTMLElement): void {
			anchor.addEventListener('mouseenter', () => {
				clearTimeout(timer);
				timer = setTimeout(() => api.show(anchor), api.anchor ? 0 : 450);
			});
			anchor.addEventListener('mouseleave', () => api.hide());
			anchor.addEventListener('mousedown', () => api.hide());
			anchor.addEventListener('focus', () => { if (anchor.matches(':focus-visible')) { api.show(anchor); } });
			anchor.addEventListener('blur', () => api.hide());
		},
	};
	window.addEventListener('scroll', () => api.hide(), true);
	return api;
})();

// The context pie's tooltip: how much of the window is used and how much is left.
hoverTip.attach(contextButton);
hoverTip.attach(skillAddButton);
hoverTip.attach(skillExpandButton);

function toolbarSkill(id: string): ToolbarSkill | undefined {
	return state?.toolbar.find(s => s.id === id);
}

/** A press: answer or stop a run in the background, else run — asking for parameters first. */
function pressSkill(id: string, anchor: HTMLElement, queue = false): void {
	const skill = toolbarSkill(id);
	if (!skill) {
		return;
	}
	if (paramsPopup.classList.contains('open') && anchor.classList.contains('active')) {
		closePopups();
		return;
	}
	if (queue) {
		queueSkill(skill, anchor);
		return;
	}
	requestSkill(skill, anchor, {});
}

/**
 * "Run after this turn": the skill waits in the tab's queue and starts once
 * the agent has finished, as a message queued with ⌘Enter does — into the
 * chat as a message, or in the background for a clipboard or silent skill.
 * With nothing running it starts at once. Not asked "run it again?": queuing
 * another run is what was chosen.
 */
function queueSkill(skill: ToolbarSkill, anchor: HTMLElement): void {
	invokeSkill(skill, anchor, {}, true, state?.activeTab, true);
}

/** The skill's own button when the bar shows it, else the "/" button: where its popovers open. */
function skillAnchor(skill: ToolbarSkill): HTMLElement {
	const entry = skillButtons.get(skill.id);
	return entry?.button.isConnected && !skillBar.hidden ? entry.button : slashButton;
}

/**
 * Every way of starting a skill — its button, the palette, `/name` typed —
 * comes here: one stopped on a question is answered first, and one already
 * running asks before it is run again, "No" being the default (asked for).
 */
function requestSkill(skill: ToolbarSkill, anchor: HTMLElement, given: Readonly<Record<string, string>>): void {
	// The tab it was pressed in, taken now: a popover in between can be answered
	// after another tab came to the front — New Chat in the title bar is a click
	// outside the view, so nothing closes it — and Run then went to that tab.
	const tabId = state?.activeTab;
	const run = state?.toolbarRuns[skill.id];
	if (run?.status === 'waiting' && run.approval) {
		openRunPopup(skill, run, anchor);
		return;
	}
	if (run?.status === 'running' || run?.status === 'waiting') {
		openAgainPopup(skill, run, anchor, given, tabId);
		return;
	}
	invokeSkill(skill, anchor, given, false, tabId);
}

/** Runs a skill whose every parameter has a valid value; otherwise asks for them, `given` filled in. */
function invokeSkill(skill: ToolbarSkill, anchor: HTMLElement, given: Readonly<Record<string, string>>, again: boolean, tabId: string | undefined, queue = false): void {
	const values: Record<string, string> = {};
	for (const p of skill.params) {
		values[p.name] = given[p.name] ?? p.preset ?? '';
	}
	const complete = skill.params.every(p => !valueProblem(p, values[p.name]));
	if (complete && (Object.keys(given).length || !skill.params.length)) {
		postRun(skill, values, again, tabId, queue);
		return;
	}
	openParams(skill, anchor, values, again, tabId, queue);
}

function postRun(skill: ToolbarSkill, values: Record<string, string>, again: boolean, tabId: string | undefined, queue = false): void {
	post({ type: 'runToolbarSkill', id: skill.id, values, tabId, again: again || undefined, queue: queue || undefined });
}

/**
 * "Already running — run it again?" No is the default: it is focused and
 * drawn as the primary button, so Enter answers it, and Escape or a click
 * elsewhere does the same. Stop is offered beside it, since this is the one
 * place a running skill is stopped from.
 */
function openAgainPopup(skill: ToolbarSkill, run: ToolbarRun, anchor: HTMLElement, given: Readonly<Record<string, string>>, tabId: string | undefined): void {
	const name = skill.label ?? skill.name;
	const stop = button([icon('debug-stop'), el('span', { text: 'Stop' })], { class: 'ghost run-stop', title: run.inChat ? 'Stop the tab it runs in' : 'Stop it' });
	const yes = button([el('span', { text: 'Yes' })], { class: 'ghost', title: 'Run it once more' });
	const no = button([el('span', { text: 'No' })], { class: 'primary', title: 'Leave it running (Enter)' });
	stop.addEventListener('click', () => { closePopups(); post({ type: 'stopToolbarSkill', id: skill.id }); });
	no.addEventListener('click', () => closePopups());
	yes.addEventListener('click', () => {
		closePopups();
		invokeSkill(skill, anchor, given, true, tabId);
	});
	const what = run.inChat ? `${name} is still running in the chat.` : run.count ? `${run.count} runs of ${name} are still going.` : `${name} is still running.`;
	paramsPopup.replaceChildren(
		el('div', { class: 'menu-heading', text: name }),
		el('div', { class: 'run-question', text: `${what} Run it again?` }),
		el('div', { class: 'form-actions' }, stop, yes, no));
	paramsPopup.onkeydown = event => {
		// Enter is No whichever button it lands on, unless the user moved to
		// another one with the keyboard on purpose: then that button's own.
		if (event.key === 'Enter' && !event.isComposing && document.activeElement === no) {
			event.preventDefault();
			closePopups();
		}
	};
	openAbove(paramsPopup, anchor, 'left');
	no.focus();
}

/** A theme chart colour by name, or `#rrggbb`; anything else is the theme's own. */
function skillColor(color: string | undefined): string | undefined {
	if (!color) {
		return undefined;
	}
	if ((skillColorNames as readonly string[]).includes(color)) {
		return `var(--vscode-charts-${color})`;
	}
	return /^#[0-9a-f]{6}$/i.test(color) ? color : undefined;
}

const skillColorNames = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;

/**
 * One colour choice of the skill editor: the theme's own, one of its chart
 * colours, or any other from a native colour input. Built once and only
 * marked afterwards: rebuilding would take the colour input out of the page,
 * which closes its picker in the middle of a drag.
 */
function colorChoice(initial: string | undefined): { node: HTMLElement; value(): string | undefined } {
	let chosen = initial;
	const custom = el('input', { class: 'color-custom' });
	custom.type = 'color';
	custom.setAttribute('aria-label', 'Another colour');
	const customIcon = icon('symbol-color');
	const customWrap = el('label', { class: 'color-swatch color-custom-wrap', title: 'Another colour' }, customIcon, custom);
	const swatches = [undefined, ...skillColorNames].map(c => {
		const b = button([c ? '' : icon('circle-slash')], { class: 'color-swatch', title: c ? c[0].toUpperCase() + c.slice(1) : "The theme's own" });
		if (c) {
			b.style.setProperty('--swatch', `var(--vscode-charts-${c})`);
		}
		b.addEventListener('click', () => { chosen = c; mark(); });
		return { c, b };
	});
	const mark = () => {
		for (const { c, b } of swatches) {
			b.classList.toggle('on', chosen === c);
			b.setAttribute('aria-pressed', String(chosen === c));
		}
		const isCustom = !!chosen?.startsWith('#');
		customWrap.classList.toggle('on', isCustom);
		customIcon.style.display = isCustom ? 'none' : '';
		if (isCustom) {
			customWrap.style.setProperty('--swatch', chosen!);
			custom.value = chosen!;
		} else {
			customWrap.style.removeProperty('--swatch');
		}
	};
	custom.addEventListener('input', () => { chosen = custom.value.toLowerCase(); mark(); });
	mark();
	return { node: el('div', { class: 'color-choices' }, ...swatches.map(x => x.b), customWrap), value: () => chosen };
}

/** Why a value does not fit its parameter — the host's rule (`toolbarText.ts`), written again for the form. */
function valueProblem(param: ToolbarParam, value: string): string | undefined {
	const v = value.trim();
	if (!v) {
		return 'A value is needed.';
	}
	if (param.type === 'number' && !/^-?\d+(\.\d+)?$/.test(v)) {
		return 'A number is needed.';
	}
	if (param.type === 'choice' && !param.options?.includes(v)) {
		return `One of ${(param.options ?? []).join(', ')}.`;
	}
	if (param.maxLength !== undefined && Array.from(v).length > param.maxLength) {
		return `At most ${param.maxLength} characters.`;
	}
	return undefined;
}

function openParams(skill: ToolbarSkill, anchor: HTMLElement, values: Record<string, string>, again: boolean, tabId: string | undefined, queue = false): void {
	const fields = skill.params.map(param => {
		let field: HTMLInputElement | HTMLSelectElement;
		if (param.type === 'choice') {
			const select = el('select', { class: 'form-input' });
			for (const option of param.options ?? []) {
				const o = el('option', { text: option });
				o.value = option;
				select.append(o);
			}
			select.value = (param.options ?? []).includes(values[param.name]) ? values[param.name] : (param.options ?? [])[0] ?? '';
			field = select;
		} else {
			const inp = el('input', { class: 'form-input' });
			inp.type = 'text';
			inp.value = values[param.name];
			if (param.type === 'number') {
				inp.inputMode = 'decimal';
			}
			if (param.maxLength) {
				inp.maxLength = param.maxLength;
			}
			field = inp;
		}
		field.setAttribute('aria-label', param.name);
		return { param, field };
	});
	const error = el('div', { class: 'form-error' });
	const run = button([el('span', { text: 'Run' })], { class: 'primary', title: 'Run (Enter)' });
	const submit = () => {
		const out: Record<string, string> = {};
		for (const { param, field } of fields) {
			const problem = valueProblem(param, field.value);
			if (problem) {
				error.textContent = `${param.name}: ${problem}`;
				field.focus();
				return;
			}
			out[param.name] = field.value.trim();
		}
		closePopups();
		postRun(skill, out, again, tabId, queue);
	};
	run.addEventListener('click', submit);
	paramsPopup.replaceChildren(
		el('div', { class: 'menu-heading', text: skill.label ?? skill.name }),
		...fields.map(({ param, field }) => el('label', { class: 'form-row' },
			el('span', { class: 'form-label', text: param.name }), field)),
		error,
		el('div', { class: 'form-actions' }, run));
	paramsPopup.onkeydown = event => {
		if (event.key === 'Enter' && !event.isComposing) {
			event.preventDefault();
			submit();
		}
	};
	openAbove(paramsPopup, anchor, 'left');
	fields[0]?.field.focus();
}

/** A run in the background: the question it waits on, and Stop. */
function openRunPopup(skill: ToolbarSkill, run: ToolbarRun, anchor: HTMLElement): void {
	const stop = button([icon('debug-stop'), el('span', { text: 'Stop' })], { class: 'ghost' });
	stop.addEventListener('click', () => {
		closePopups();
		post({ type: 'stopToolbarSkill', id: skill.id });
	});
	const nodes: Node[] = [el('div', { class: 'menu-heading', text: skill.label ?? skill.name })];
	if (run.status === 'waiting' && run.approval) {
		const allow = button([el('span', { text: 'Allow' })], { class: 'primary' });
		const deny = button([el('span', { text: 'Deny' })], { class: 'ghost' });
		// The question shown, by its id: with two runs of the skill waiting, the
		// skill's id alone answered whichever the host found first.
		const approvalId = run.approval.id;
		allow.addEventListener('click', () => { closePopups(); post({ type: 'toolbarApprove', id: skill.id, approvalId, allow: true }); });
		deny.addEventListener('click', () => { closePopups(); post({ type: 'toolbarApprove', id: skill.id, approvalId, allow: false }); });
		nodes.push(
			el('div', { class: 'run-question', text: run.approval.title }),
			...(run.approval.detail ? [el('pre', { class: 'run-detail', text: run.approval.detail })] : []),
			el('div', { class: 'form-actions' }, stop, deny, allow));
	} else {
		nodes.push(el('div', { class: 'run-question', text: 'Running in the background…' }), el('div', { class: 'form-actions' }, stop));
	}
	paramsPopup.replaceChildren(...nodes);
	paramsPopup.onkeydown = null;
	openAbove(paramsPopup, anchor, 'left');
}

function skillMenu(id: string, anchor: HTMLElement): void {
	const skill = toolbarSkill(id);
	const list = state?.toolbar ?? [];
	const at = list.findIndex(s => s.id === id);
	if (!skill) {
		return;
	}
	const busy = !!state?.tabs.find(t => t.id === state?.activeTab)?.busy;
	openMenu(anchor, [
		{ icon: 'play', label: 'Run', shortcut: 'Click', run: () => requestSkill(skill, anchor, {}) },
		{
			icon: 'list-ordered', label: 'Run after this turn', shortcut: `${modKey}+Click`,
			description: busy ? 'Waits in the queue until the agent has finished' : 'Nothing is running: it runs now',
			run: () => queueSkill(skill, anchor),
		},
		{ icon: 'edit', label: 'Edit toolbar skill…', run: () => openSkillEditor(skill) },
		{ icon: 'trash', label: 'Delete toolbar skill', run: () => confirmDeleteSkill(skill, anchor) },
		{ icon: 'arrow-left', label: 'Move left', disabled: at <= 0, run: () => post({ type: 'moveToolbarSkill', id, by: -1 }) },
		{ icon: 'arrow-right', label: 'Move right', disabled: at < 0 || at >= list.length - 1, run: () => post({ type: 'moveToolbarSkill', id, by: 1 }) },
	], skill.label ?? skill.name);
}

function chooseToolbarSkill(heading: string, then: (skill: ToolbarSkill) => void): void {
	openMenu(slashButton, (state?.toolbar ?? []).map(skill => ({
		icon: skill.icon,
		label: skill.label ? `${skill.label} — ${skill.name}` : skill.name,
		description: skill.tooltip ?? skill.prompt.split('\n')[0],
		run: () => then(skill),
	})), heading);
}

function confirmDeleteSkill(skill: ToolbarSkill, anchor: HTMLElement): void {
	openMenu(anchor, [
		{ icon: 'trash', label: `Delete ${skill.name}`, description: 'It leaves the toolbar and the "/" menu', run: () => post({ type: 'deleteToolbarSkill', id: skill.id }) },
		{ icon: 'close', label: 'Cancel', run: () => undefined },
	], 'Delete toolbar skill?');
}

/** The toolbar skills in the "/" palette, as commands: choosing one runs it. */
function toolbarItems(s: ChatViewState): PaletteItem[] {
	const sigil = paletteAgent(s) === 'codex' ? '$' : '/';
	return visibleToolbar(s).map(skill => ({
		key: `toolbar:${skill.id}`,
		group: 'Toolbar',
		name: skill.name.toLowerCase(),
		label: `${sigil}${skill.name}`,
		icon: skill.icon,
		hint: skill.params.map(p => `<${p.name}>`).join(' ') || undefined,
		detail: skill.label ?? skill.tooltip ?? skill.prompt.split('\n')[0],
		haystack: [skill.name, skill.label, skill.tooltip, skill.prompt].filter(Boolean).join(' ').toLowerCase(),
		run: () => requestSkill(skill, skillAnchor(skill), {}),
	}));
}

/**
 * A message that is a toolbar skill: `/name` or `$name` first, then the
 * arguments — one parameter takes them all, several take one word each and
 * the last the rest.
 */
function toolbarInvocation(text: string): { skill: ToolbarSkill; values: Record<string, string> } | undefined {
	const s = state;
	const m = /^\s*[/$](\S+)(?:\s+([\s\S]*))?$/.exec(text);
	const skill = s && m ? visibleToolbar(s).find(k => k.name === m[1]) : undefined;
	if (!skill || !m) {
		return undefined;
	}
	const args = (m[2] ?? '').trim();
	const values: Record<string, string> = {};
	if (skill.params.length === 1) {
		if (args) {
			values[skill.params[0].name] = args;
		}
	} else if (skill.params.length > 1 && args) {
		const words = args.split(/\s+/);
		skill.params.forEach((p, i) => {
			const value = i === skill.params.length - 1 ? words.slice(i).join(' ') : words[i];
			if (value) {
				values[p.name] = value;
			}
		});
	}
	return { skill, values };
}

/* the editor */

interface DraftParam { name: string; type: ToolbarParam['type']; maxLength: string; preset: string; options: string }

let editorAgents: ToolbarSkill['agents'] = 'all';
let showEditorError: (message: string) => void = () => undefined;

/** Whose skills the editor's prompt offers: the one it is for, or the tab's agent when it is for all. */
function editorAgent(s: ChatViewState): AgentId | undefined {
	return editorAgents === 'all' ? paletteAgent(s) : editorAgents;
}

function formRow(label: string, field: Node, hint?: string): HTMLElement {
	return el('label', { class: 'form-row' },
		el('span', { class: 'form-label', text: label }), field,
		hint ? el('span', { class: 'form-hint', text: hint }) : undefined);
}

function textField(value: string, placeholder = ''): HTMLInputElement {
	const field = el('input', { class: 'form-input' });
	field.type = 'text';
	field.value = value;
	field.placeholder = placeholder;
	field.spellcheck = false;
	return field;
}

function selectField<T extends string>(options: readonly (readonly [T, string])[], value: T): HTMLSelectElement {
	const select = el('select', { class: 'form-input' });
	for (const [v, label] of options) {
		const o = el('option', { text: label });
		o.value = v;
		select.append(o);
	}
	select.value = value;
	return select;
}

/**
 * The editor, over the chat. Built once per opening and never on a state post,
 * so what is typed in it is never rebuilt away. The host checks the skill
 * (`validToolbarSkill`) and answers `toolbarSaved` or `toolbarError`.
 */
function openSkillEditor(skill?: ToolbarSkill): void {
	closePopups();
	const id = skill?.id ?? newId();
	editorAgents = skill?.agents ?? 'all';
	let chosenIcon = skill?.icon ?? 'sparkle';

	const name = textField(skill?.name ?? '', 'pr-review');
	// Lower case only, as the CLIs' own skills are: typed capitals become small
	// ones where they are typed, the caret kept where it was.
	name.autocapitalize = 'off';
	name.spellcheck = false;
	name.addEventListener('input', () => {
		const lower = name.value.toLowerCase();
		if (lower !== name.value) {
			const at = name.selectionStart;
			name.value = lower;
			name.setSelectionRange(at, at);
		}
	});
	const prompt = promptField(skill?.prompt ?? '', 'Review PR {{pr}} with /one-more-review…', 6);

	// The prompts after the first, each sent once the one before it is over —
	// and, where it has a check, only if the agent found the check true.
	const steps: { prompt: string; check: string }[] = (skill?.followUps ?? []).map(f => ({ prompt: f.prompt, check: f.check ?? '' }));
	const stepList = el('div', { class: 'step-list' });
	const paintSteps = () => {
		stepList.replaceChildren(...steps.map((step, i) => {
			const check = el('textarea', { class: 'form-input form-check' });
			check.value = step.check;
			check.rows = 2;
			check.placeholder = 'Optional. E.g. "the tests pass" — empty: always go on';
			check.addEventListener('input', () => { step.check = check.value; });
			const text = promptField(step.prompt, 'The next prompt…', 4);
			text.addEventListener('input', () => { step.prompt = text.value; });
			text.addEventListener('change', () => { step.prompt = text.value; });
			const remove = button([icon('close')], { class: 'ghost round', title: 'Remove this prompt' });
			remove.addEventListener('click', () => { steps.splice(i, 1); paintSteps(); });
			return el('div', { class: 'step-row' },
				el('div', { class: 'step-head' }, el('span', { class: 'form-label', text: `Prompt ${i + 2}` }), remove),
				el('span', { class: 'form-hint', text: `Check after prompt ${i + 1} — the agent judges it, and prompt ${i + 2} runs only if it holds` }),
				check,
				text);
		}));
	};
	paintSteps();
	const addStep = button([icon('add'), el('span', { text: 'Add next prompt' })], { class: 'ghost' });
	addStep.addEventListener('click', () => {
		if (steps.length >= 9) {
			return;
		}
		steps.push({ prompt: '', check: '' });
		paintSteps();
		(stepList.lastElementChild?.querySelector('.form-prompt') as HTMLTextAreaElement | null)?.focus();
	});

	const agents = selectField<ToolbarSkill['agents']>([['all', 'All agents'], ['claude', 'Claude Code only'], ['codex', 'Codex only']], editorAgents);
	agents.addEventListener('change', () => { editorAgents = agents.value as ToolbarSkill['agents']; });

	const results: readonly (readonly [ToolbarResult, string, string])[] = [
		['chat', 'In the chat', 'Sent as a message of the tab it is pressed in'],
		['clipboard', 'To the clipboard', 'Runs in the background; only the marked result is copied'],
		['silent', 'Silently', 'Runs in the background; the button says when it is done'],
		['toast', 'In a notification', 'Runs in the background; the marked result is shown in a VS Code notification, with Copy and Open — which pauses a browser tab on screen until it is dismissed'],
	];
	let chosenResult: ToolbarResult = skill?.result ?? 'chat';
	const resultGroup = el('div', { class: 'form-choices' }, ...results.map(([value, label, hint]) => {
		const radio = el('input');
		radio.type = 'radio';
		radio.name = `result-${id}`;
		radio.checked = value === chosenResult;
		radio.addEventListener('change', () => { chosenResult = value; });
		return el('label', { class: 'form-choice' }, radio, el('span', { class: 'form-choice-text' },
			el('span', { text: label }), el('span', { class: 'form-hint', text: hint })));
	}));

	// How its end is told: not at all, in a sentence of ours, or in the user's own words.
	type NotifyMode = 'none' | 'auto' | 'text';
	let notifyMode: NotifyMode = skill?.notify?.mode ?? 'none';
	const notifyPick = selectField<NotifyMode>([['none', 'No notification'], ['auto', 'Automatic — done, or what went wrong'], ['text', 'My own text']], notifyMode);
	const notifyText = textField(skill?.notify?.mode === 'text' ? skill.notify.text : '', '{{skill}} is {{status}}: {{result}}');
	notifyText.maxLength = 500;
	const notifyTextRow = el('div', { class: 'notify-text' }, notifyText,
		el('span', { class: 'form-hint', text: 'Fills in {{skill}}, {{status}} (done or failed), {{message}}, {{result}} and the parameters by name.' }));
	notifyTextRow.hidden = notifyMode !== 'text';
	notifyPick.addEventListener('change', () => {
		notifyMode = notifyPick.value as NotifyMode;
		notifyTextRow.hidden = notifyMode !== 'text';
		if (notifyMode === 'text') {
			notifyText.focus();
		}
	});

	// The icon: a button showing it, opening a searchable grid of every codicon.
	const iconPreview = el('span', { class: 'icon-preview' });
	const paintIcon = () => iconPreview.replaceChildren(icon(chosenIcon), el('span', { text: chosenIcon }));
	paintIcon();
	const iconButton = button([iconPreview, icon('chevron-down')], { class: 'ghost icon-pick', title: 'Choose an icon' });
	const iconSearch = textField('', 'Search icons…');
	const iconGrid = el('div', { class: 'icon-grid' });
	const iconPanel = el('div', { class: 'icon-panel' }, iconSearch, iconGrid);
	iconPanel.hidden = true;
	const paintGrid = () => {
		const q = iconSearch.value.trim().toLowerCase();
		const names = codiconNames.filter(n => !q || n.includes(q));
		iconGrid.replaceChildren(...names.map(n => {
			const b = button([icon(n)], { class: 'ghost icon-cell', title: n });
			b.classList.toggle('on', n === chosenIcon);
			b.addEventListener('click', () => {
				chosenIcon = n;
				paintIcon();
				iconPanel.hidden = true;
			});
			return b;
		}), names.length ? '' : el('div', { class: 'form-hint', text: 'No icon by that name.' }));
	};
	iconSearch.addEventListener('input', paintGrid);
	iconButton.addEventListener('click', () => {
		iconPanel.hidden = !iconPanel.hidden;
		if (!iconPanel.hidden) {
			paintGrid();
			iconSearch.focus();
		}
	});
	// Three colours, for the label, the border and the icon (asked for).
	const colors = {
		text: colorChoice(skill?.colors?.text),
		border: colorChoice(skill?.colors?.border),
		icon: colorChoice(skill?.colors?.icon),
	};
	const label = textField(skill?.label ?? '', 'Optional');
	const tooltip = textField(skill?.tooltip ?? '', 'Shown on hover; the name when empty');

	// Parameters.
	const drafts: DraftParam[] = (skill?.params ?? []).map(p => ({
		name: p.name, type: p.type, maxLength: p.maxLength ? String(p.maxLength) : '', preset: p.preset ?? '', options: (p.options ?? []).join(', '),
	}));
	const paramList = el('div', { class: 'param-list' });
	const paintParams = () => {
		paramList.replaceChildren(...drafts.map((d, i) => {
			const pName = textField(d.name, 'name');
			pName.addEventListener('input', () => { d.name = pName.value; });
			const pType = selectField<ToolbarParam['type']>([['text', 'Text'], ['number', 'Number'], ['choice', 'Choice']], d.type);
			pType.addEventListener('change', () => { d.type = pType.value as ToolbarParam['type']; paintParams(); });
			const pMax = textField(d.maxLength, 'max length');
			pMax.inputMode = 'numeric';
			pMax.addEventListener('input', () => { d.maxLength = pMax.value; });
			const pPreset = textField(d.preset, 'preset');
			pPreset.addEventListener('input', () => { d.preset = pPreset.value; });
			const pOptions = textField(d.options, 'values, comma-separated');
			pOptions.addEventListener('input', () => { d.options = pOptions.value; });
			const remove = button([icon('close')], { class: 'ghost round', title: 'Remove parameter' });
			remove.addEventListener('click', () => { drafts.splice(i, 1); paintParams(); });
			return el('div', { class: 'param-row' },
				pName, pType, d.type === 'text' ? pMax : undefined, d.type === 'choice' ? pOptions : undefined, pPreset, remove);
		}));
	};
	paintParams();
	const addParam = button([icon('add'), el('span', { text: 'Add parameter' })], { class: 'ghost' });
	addParam.addEventListener('click', () => {
		drafts.push({ name: '', type: 'text', maxLength: '', preset: '', options: '' });
		paintParams();
		(paramList.lastElementChild?.querySelector('input') as HTMLInputElement | null)?.focus();
	});

	const error = el('div', { class: 'form-error' });
	showEditorError = message => { error.textContent = message; };
	const save = button([el('span', { text: skill ? 'Save' : 'Add to toolbar' })], { class: 'primary' });
	const cancel = button([el('span', { text: 'Cancel' })], { class: 'ghost' });
	cancel.addEventListener('click', () => closePopups());
	save.addEventListener('click', () => {
		error.textContent = '';
		const n = name.value.trim();
		if (!/^[a-z0-9][a-z0-9:._-]{0,63}$/.test(n)) {
			error.textContent = 'The name is one word of lower-case letters, digits, "-", "_", ":" or "." — no spaces.';
			name.focus();
			return;
		}
		if (!prompt.value.trim()) {
			error.textContent = 'The prompt is empty.';
			prompt.focus();
			return;
		}
		if (notifyMode === 'text' && !notifyText.value.trim()) {
			error.textContent = 'The notification text is empty.';
			notifyText.focus();
			return;
		}
		const emptyStep = steps.findIndex(step => !step.prompt.trim() && step.check.trim());
		if (emptyStep >= 0) {
			error.textContent = `Prompt ${emptyStep + 2} has a check but no prompt.`;
			return;
		}
		post({
			type: 'saveToolbarSkill', skill: {
				id, name: n, prompt: prompt.value, result: chosenResult, agents: editorAgents, icon: chosenIcon,
				notify: notifyMode === 'auto' ? { mode: 'auto' } : notifyMode === 'text' ? { mode: 'text', text: notifyText.value.trim() } : undefined,
				followUps: steps.filter(step => step.prompt.trim()).map(step => ({ prompt: step.prompt, check: step.check.trim() || undefined })),
				colors: { text: colors.text.value(), border: colors.border.value(), icon: colors.icon.value() },
				label: label.value || undefined, tooltip: tooltip.value || undefined,
				params: drafts.map(d => ({
					name: d.name.trim(), type: d.type,
					maxLength: d.type === 'text' && /^\d+$/.test(d.maxLength.trim()) ? Number(d.maxLength.trim()) : undefined,
					preset: d.preset.trim() || undefined,
					options: d.type === 'choice' ? d.options.split(',').map(o => o.trim()).filter(Boolean) : undefined,
				})),
			},
		});
	});

	skillEditor.replaceChildren(
		panelHead(skill ? 'Edit toolbar skill' : 'Add skill to toolbar'),
		el('div', { class: 'skill-form' },
			formRow('Name', name, 'Called as /name or $name; lower case, no spaces.'),
			formRow('Prompt', prompt, 'Type / or $ for a skill, and {{parameter}} where a value goes.'),
			el('div', { class: 'form-row' },
				el('span', { class: 'form-label', text: 'Next prompts' }),
				el('span', { class: 'form-hint', text: 'Sent one after another, each once the agent has finished the one before — like messages queued with ⌘Enter. A check between two stops the skill there unless it holds.' }),
				stepList, addStep),
			formRow('Available in', agents),
			el('div', { class: 'form-row' }, el('span', { class: 'form-label', text: 'Result' }), resultGroup),
			el('div', { class: 'form-row' }, el('span', { class: 'form-label', text: 'Notify when it ends' }), notifyPick, notifyTextRow,
				el('span', { class: 'form-hint', text: 'A VS Code notification when the skill is done or something went wrong — not when you stop it. A notification pauses a browser tab on screen until it is dismissed.' })),
			el('div', { class: 'form-row' }, el('span', { class: 'form-label', text: 'Icon' }), iconButton, iconPanel),
			el('div', { class: 'form-row' }, el('span', { class: 'form-label', text: 'Colours' }),
				el('div', { class: 'color-parts' },
					el('span', { class: 'form-hint', text: 'Text' }), colors.text.node,
					el('span', { class: 'form-hint', text: 'Border' }), colors.border.node,
					el('span', { class: 'form-hint', text: 'Icon' }), colors.icon.node)),
			formRow('Label', label, 'Shown beside the icon.'),
			formRow('Tooltip', tooltip),
			el('div', { class: 'form-row' },
				el('span', { class: 'form-label', text: 'Parameters' }),
				el('span', { class: 'form-hint', text: 'Asked for when the skill runs; each is required. Use {{name}} in the prompt.' }),
				paramList, addParam),
			error,
			el('div', { class: 'form-actions' }, cancel, save)));
	closePopups(skillEditor);
	skillEditor.classList.add('open');
	name.focus();
}

/**
 * A prompt field of the skill editor: the "/" and "$" palette works in it as
 * in the message box, whichever of the editor's prompts it is.
 */
function promptField(value: string, placeholder: string, rows: number): HTMLTextAreaElement {
	const field = el('textarea', { class: 'form-input form-prompt' });
	field.value = value;
	field.rows = rows;
	field.placeholder = placeholder;
	field.addEventListener('input', () => followInlineToken(field));
	field.addEventListener('keydown', event => {
		if (paletteMode === 'inline' && paletteTarget === field && paletteKey(event)) {
			event.preventDefault();
			event.stopPropagation();
		}
	});
	field.addEventListener('keyup', event => {
		if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
			followInlineToken(field);
		}
	});
	field.addEventListener('click', () => followInlineToken(field));
	return field;
}

function newId(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');
}

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

/**
 * The `U` button takes the colour of the limit closest to running out (asked
 * for): the foreground below 25 %, then towards green by 50 %, yellow by 75 %,
 * orange by 90 % and red by 100 %; a limit reached, or credits being spent, is
 * a red disc. Set through the CSSOM, which the CSP allows, as the pie's fill is.
 */
const usageStops: readonly (readonly [number, string])[] = [
	[25, 'var(--vscode-foreground)'],
	[50, 'var(--vscode-charts-green)'],
	[75, 'var(--vscode-charts-yellow)'],
	[90, 'var(--vscode-charts-orange)'],
	[100, 'var(--vscode-charts-red)'],
];

function usageColor(percent: number): string {
	if (percent < usageStops[0][0]) {
		return usageStops[0][1];
	}
	for (let i = 1; i < usageStops.length; i++) {
		const [to, toColor] = usageStops[i];
		if (percent < to) {
			const [from, fromColor] = usageStops[i - 1];
			const share = Math.round((percent - from) / (to - from) * 100);
			return `color-mix(in srgb, ${toColor} ${share}%, ${fromColor})`;
		}
	}
	return usageStops[usageStops.length - 1][1];
}

function renderUsageLevel(s: ChatViewState): void {
	const u = s.usage;
	const full = !!u && (u.usingCredits || u.percent >= 100);
	const color = u ? usageColor(u.percent) : '';
	if (usageButton.style.getPropertyValue('--usage-color') !== color) {
		if (color) {
			usageButton.style.setProperty('--usage-color', color);
		} else {
			usageButton.style.removeProperty('--usage-color');
		}
	}
	usageButton.classList.toggle('level', !!u);
	usageButton.classList.toggle('limit-full', full);
	const name = u && agentName(s, s.selection.agent);
	const title = !u ? usageTitle
		: `${usageTitle}
${name ? `${name}: ` : ''}${u.label} — ${Math.floor(Math.min(100, u.percent))}% used${u.usingCredits ? ', now spending credits' : ''}`;
	if (usageButton.title !== title) {
		usageButton.title = title;
		// What a screen reader names it by: the colour alone says nothing there.
		usageButton.setAttribute('aria-label', title);
	}
}

function agentName(s: ChatViewState, id: AgentId | undefined): string | undefined {
	return id ? s.agents.find(a => a.id === id)?.name ?? id : undefined;
}

/** The line's words for an alert: which agent, which limit, how far, and when it resets. */
function usageAlertWords(s: ChatViewState, a: UsageAlert): string {
	const name = agentName(s, a.agent) ?? a.agent;
	const where = a.percent >= 100 ? `${a.label} reached` : `${a.label} ${a.percent}% used`;
	const reset = a.resetsAt ? `, resets ${resetText(a.resetsAt)}` : '';
	if (a.kind === 'credits') {
		return `${name} is now spending ${a.agent === 'claude' ? 'usage credits' : 'credits'} — ${where}${reset}`;
	}
	return `${name}: ${where}${reset}`;
}

/** The alert the user closed, hidden until the host's state stops carrying it. */
let closedUsageAlert: string | undefined;

function alertKey(a: UsageAlert): string {
	return `${a.agent}|${a.kind}|${a.label}|${a.percent}`;
}

/**
 * The line is refilled in place, never rebuilt: its close button must not be
 * replaced between a press and its release (#365), and the reset time in its
 * words moves on by itself (refilled every half minute, below).
 *
 * The line takes its height from the thread, so a thread that was following
 * its end is put back at the end when the line comes, goes or wraps: shown
 * while a reply streams (Claude Code reports its limits with a turn's first
 * model request, Codex as a turn goes), 61 px of
 * line left the reply streaming out of sight, `renderThread` reading the
 * thread as scrolled up from then on.
 */
function renderUsageAlert(s: ChatViewState): void {
	const atEnd = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60;
	const height = usageAlertBar.hidden ? 0 : usageAlertBar.offsetHeight;
	fillUsageAlert(s);
	if (atEnd && (usageAlertBar.hidden ? 0 : usageAlertBar.offsetHeight) !== height) {
		thread.scrollTop = thread.scrollHeight;
	}
}

function fillUsageAlert(s: ChatViewState): void {
	const a = s.usageAlert;
	if (closedUsageAlert && (!a || alertKey(a) !== closedUsageAlert)) {
		closedUsageAlert = undefined;
	}
	const show = !!a && !s.blocked && closedUsageAlert === undefined;
	usageAlertBar.hidden = !show;
	if (!show || !a) {
		return;
	}
	const words = usageAlertWords(s, a);
	if (usageAlertText.textContent !== words) {
		usageAlertText.textContent = words;
	}
	usageAlertBar.classList.toggle('reached', a.kind !== 'high');
	const closeTip = a.kind === 'credits'
		? 'Close — it comes back when credits are spent again after this limit has reset'
		: a.percent >= 100
			? 'Close — it comes back once this limit has reset and climbs past 90% again'
			: 'Close — it comes back when this limit goes up by another percent, and at 100%';
	if (usageAlertClose.title !== closeTip) {
		usageAlertClose.title = closeTip;
		usageAlertClose.setAttribute('aria-label', closeTip);
	}
	usageAlertText.title = 'Show your plan\'s limits';
}

usageAlertClose.addEventListener('click', () => {
	const a = state?.usageAlert;
	if (!a || !state) {
		return;
	}
	// Closed from the keyboard, the focus would fall to the body with the button.
	const hadFocus = document.activeElement === usageAlertClose;
	closedUsageAlert = alertKey(a);
	renderUsageAlert(state);
	post({ type: 'dismissUsageAlert', alert: a });
	if (hadFocus) {
		input.focus();
	}
});

/** Whether a selection lies in the line's words. */
function usageAlertSelected(): boolean {
	const selection = window.getSelection();
	return !!selection && !selection.isCollapsed && selection.containsNode(usageAlertText, true);
}

/** The popup the words open, waiting out the double-click window (#408's rule). */
let usageAlertOpen: ReturnType<typeof setTimeout> | undefined;

// Not on a click that ends a selection of its words (#353), nor on any click of
// a double or triple one: opening the popup asks every agent for its usage, and
// starts a probe for Claude Code with no conversation running. The first click
// of a double click arrives before the word is selected, so the open waits
// `multiClickMs` and is dropped if another click or a selection comes.
usageAlertText.addEventListener('click', event => {
	clearTimeout(usageAlertOpen);
	usageAlertOpen = undefined;
	if (event.detail > 1 || usageAlertSelected()) {
		return;
	}
	usageAlertOpen = setTimeout(() => {
		usageAlertOpen = undefined;
		if (!usageAlertSelected() && !usageAlertBar.hidden && !usagePopup.classList.contains('open')) {
			usageButton.click();
		}
	}, multiClickMs);
});

// "Resets in 12 min" moves on with nothing posted; the host posts when a reset
// passes. Not while the words are selected: refilling them takes the selection.
setInterval(() => {
	if (state && !usageAlertBar.hidden && !usageAlertSelected()) {
		renderUsageAlert(state);
	}
}, 30_000);

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

/**
 * The agents the chat's agent started, and the toolbar skills run in the
 * background from this chat (asked for: a run is an agent at work, and nothing
 * showed what it was doing) — in the order they started.
 */
function agentRows(s: ChatViewState): ToolEntry[] {
	const own = s.entries.filter((e): e is ToolEntry => e.kind === 'tool' && e.tool === 'agent');
	return s.skillAgents?.length ? [...own, ...s.skillAgents].sort((a, b) => a.startedAt - b.startedAt) : own;
}

function renderAgents(s: ChatViewState): void {
	const agents = agentRows(s);
	const running = agents.filter(a => a.status === 'running').length;
	// The button stays while the chat has agents, so their list and reports can
	// be opened after they finish; the number beside it counts only those still
	// running (asked for), and with none it is the icon alone — not a 0, and not
	// the total, which read as agents at work.
	agentsButton.hidden = !agents.length;
	agentsButton.classList.toggle('live', running > 0);
	const count = running ? String(running) : '';
	if (agentsButton.dataset.count !== count || !agentsButton.firstChild) {
		agentsButton.dataset.count = count;
		agentsButton.replaceChildren(icon('hubot'), ...(count ? [el('span', { text: count })] : []));
	}
	const total = `${agents.length} agent${agents.length === 1 ? '' : 's'} in this chat`;
	agentsButton.title = running ? `${running} running · ${total}` : `${total}, none running — show them`;
	agentsButton.setAttribute('aria-label', agentsButton.title);
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
	openAgentsPanel();
});

/** The agents list over the chat; also opened from "N agents running" under a turn. */
function openAgentsPanel(): void {
	agentsView = {};
	closePopups(agentsPanel);
	fillAgents(currentAgents(), true);
	agentsPanel.classList.add('open');
}

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
			return a.agent?.waiting ? 'Waiting for your answer' : a.status === 'running' && a.agent?.lastTool ? `Running · ${a.agent.lastTool}` : statusLabel(a);
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
		el('div', { class: 'agent-line', text: info?.origin === 'toolbar' ? 'Started from the toolbar' : spawnedBy(info?.type) }),
		liveSpan('div', selected, 'card', 'agent-line'));
	const report = info?.summary ?? (selected.status !== 'running' ? selected.output : undefined);
	const question = info?.waiting;
	if (question && info?.skill) {
		// A background toolbar run stopped on a question: answered here as on its button.
		const answer = (allow: boolean) => () => post({ type: 'toolbarApprove', id: info.skill!, approvalId: question.id, allow });
		const allow = button([el('span', { text: 'Allow' })], { class: 'primary' });
		allow.addEventListener('click', answer(true));
		const deny = button([el('span', { text: 'Deny' })], { class: 'ghost' });
		deny.addEventListener('click', answer(false));
		body.append(el('div', { class: 'agent-question' },
			el('div', { class: 'run-question', text: question.title }),
			question.detail ? el('pre', { class: 'run-detail', text: question.detail }) : undefined,
			el('div', { class: 'form-actions' }, deny, allow)));
	}
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

/**
 * A palette row whose name, hint or description is cut short gets a tooltip
 * with all of it (asked for, with the sideways scroll gone). Measured on
 * hover, once laid out; a row that fits gets none.
 */
function fullRowTip(row: HTMLElement, item: { label: string; hint?: string; detail?: string }): void {
	row.addEventListener('mouseenter', () => {
		const cut = [...row.querySelectorAll<HTMLElement>('.palette-label, .palette-hint, .palette-detail')]
			.some(node => node.scrollWidth > node.clientWidth + 1);
		const full = [item.hint ? `${item.label} ${item.hint}` : item.label, item.detail].filter(Boolean).join('\n');
		if (cut) {
			row.title = full;
		} else {
			row.removeAttribute('title');
		}
	});
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


/* The assertion belongs to this window; the OS coordinator combines windows. */
function cupIcon(full: boolean): SVGSVGElement {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 16 16');
	svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
	svg.setAttribute('aria-hidden', 'true');
	const path = document.createElementNS(svg.namespaceURI, 'path');
	path.setAttribute('d', 'M2 3.5h9v5a4.5 4.5 0 0 1-9 0z M11 4h1.5a2 2 0 0 1 0 4H11 M1 14h12');
	path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.2');
	if (full) {
		const liquid = document.createElementNS(svg.namespaceURI, 'path');
		liquid.setAttribute('d', 'M3 6h7v2.5a3.5 3.5 0 0 1-7 0z');
		liquid.setAttribute('fill', 'currentColor'); svg.append(liquid);
	}
	svg.append(path); return svg;
}
let sleepSignature = '';
function renderSleep(): void {
	const sleep = state?.sleep;
	const active = sleep?.active === true;
	const seconds = Math.max(0, Math.ceil(((sleep?.until ?? 0) - Date.now()) / 1000));
	const countdown = `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds / 60 % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
	const tip = sleep?.error ? `Cannot keep computer awake: ${sleep.error}`
		: sleep?.mode === 'timer' ? `Keep awake: ${countdown}${active ? '' : ' — starting…'}`
		: sleep?.mode === 'agents' ? 'Keep awake until all agents and subagents in this window finish'
		: 'Keep computer awake — off in this window';
	sleepButton.title = tip; sleepButton.setAttribute('aria-label', tip);
	sleepButton.setAttribute('aria-pressed', String(active));
	const signature = JSON.stringify([sleep?.mode, sleep?.minutes, active, sleep?.error]);
	if (signature !== sleepSignature) {
		sleepSignature = signature; sleepButton.replaceChildren(cupIcon(active));
		buildSleepPopup();
	}
	const status = sleepPopup.querySelector('.sleep-status');
	if (status) {
		status.textContent = tip;
		status.classList.toggle('sleep-enabled-status', !!sleep && (sleep.mode === 'timer' || sleep.mode === 'agents') && !sleep.error);
	}
}
function buildSleepPopup(): void {
	const sleep = state?.sleep;
	const choose = (choice: SleepChoice) => { post({ type: 'setSleep', choice }); closePopups(); };
	const option = (label: string, choice: SleepChoice, selected: boolean) => {
		const b = button([label], { class: 'sleep-option' });
		b.classList.toggle('selected', selected); b.setAttribute('aria-pressed', String(selected));
		b.addEventListener('click', () => choose(choice)); return b;
	};
	const minutes = el('div', { class: 'sleep-options' });
	for (const n of sleepMinutes) { minutes.append(option(String(n), { mode: 'timer', minutes: n }, sleep?.mode === 'timer' && sleep.minutes === n)); }
	const hours = el('div', { class: 'sleep-options' });
	for (const n of sleepHours) { hours.append(option(String(n), { mode: 'timer', minutes: n * 60 }, sleep?.mode === 'timer' && sleep.minutes === n * 60)); }
	const agentsOption = option('Until agents and subagents finish in this window', { mode: 'agents' }, sleep?.mode === 'agents');
	agentsOption.classList.add('sleep-agents-option');
	agentsOption.prepend(icon('hubot'));
	sleepPopup.replaceChildren(el('div', { class: 'sleep-heading', text: 'Keep this window awake' }),
		el('div', { class: 'sleep-status' }), el('div', { class: 'sleep-label', text: 'Minutes' }), minutes,
		el('div', { class: 'sleep-label', text: 'Hours' }), hours,
		agentsOption);
	if (sleep && sleep.mode !== 'off') {
		const off = option('Turn off for this window', { mode: 'off' }, false);
		off.prepend(icon('circle-slash'));
		sleepPopup.append(off);
	}
}
sleepButton.addEventListener('click', () => {
	if (sleepPopup.classList.contains('open')) { closePopups(); return; }
	buildSleepPopup(); renderSleep(); openAbove(sleepPopup, sleepButton, 'right');
});
sleepPopup.addEventListener('keydown', event => { if (event.key === 'Escape') { closePopups(); sleepButton.focus(); } });
setInterval(renderSleep, 1000);
