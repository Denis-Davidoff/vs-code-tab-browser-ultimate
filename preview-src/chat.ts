import { overlayBounds, fitOverlay } from './overlayPosition';
import { chatTabDragType, parseChatTabTransfer } from './tabDrag';
import { createVsCodeChatHost } from './chatHost';
import { historyPeriodRange, type HistoryPeriod } from './historyPeriod';
import type { TemporaryStorage } from '../src/core/temporaryFiles';
import { aiFeatures, defaultFeaturePrompts, featureAgent, featurePromptLimit, readFeatureAiSettings, type AiFeature, type FeatureAiSettings, type FeatureEffort } from '../src/chat/featureAi';
import { createRecordingEncoder } from './recording';
import { clipboardFiles, fileBase64 } from './clipboardFiles';
import { pastedFileLimit } from '../src/chat/pastedFiles';
import { maxRecordingSeconds, minRecordingSeconds, readRecordingQuality, readRecordingSeconds, recordingProfiles, type RecordingQuality } from '../src/browser/recordingQuality';
import { localFileLink } from '../src/chat/fileLinks';
import { namesFile, resolveFileIcon, type FileIconTable } from '../src/chat/fileIconTable';
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
	AgentId, AgentQuestion, AgentUsage, ApprovalEntry, UsageAlert, ToolbarParam, ToolbarResult, ToolbarRun, ToolbarSkill, ApprovalKind, ApprovalMode, AttachmentChip, AttachmentKind, ChatCommand, ChatEntry, ChatStats, ChatSummary, ChatTabStatus, ChatTabSummary, ChatViewMode, ChatViewState, HostToView, RepoMode, ToolEntry, ViewToHost, VoiceEvent, WorkdirFolder, GitBranchState, GitRemoteAction, WorkdirGitStatus,
} from '../src/chat/chatProtocol';
import { baseName, searchPaths } from './fileRank';
// Every codicon the bundled font has, one per line (`name,char,code`); bundled
// as text by esbuild, so the icon picker lists exactly what can be drawn.
import codiconCsv from '@vscode/codicons/dist/codicon.csv';

const vscode = createVsCodeChatHost();
const post = (message: ViewToHost) => vscode.postMessage(message);

// Reuse the editor's actual theme tokens in the Chrome surface, including custom themes.
if (!window.aiBrowserChatHost) {
	const reportTheme = () => {
		const style = getComputedStyle(document.body);
		const tokens = Object.fromEntries(Array.from(style).filter(key => key.startsWith('--vscode-')).map(key => [key, style.getPropertyValue(key).trim()]));
		post({ type: 'reportTheme', tokens });
	};
	new MutationObserver(reportTheme).observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
	queueMicrotask(reportTheme);
}

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

/** Search controls share an inset clear button, including programmatically filled queries. */
function clearableSearch(field: HTMLInputElement): HTMLElement {
	const clear = button([icon('close')], { class: 'palette-search-clear', title: 'Clear search' });
	clear.addEventListener('click', event => {
		event.stopPropagation();
		if (field.disabled) { return; }
		field.value = '';
		field.dispatchEvent(new Event('input', { bubbles: true }));
		field.focus();
	});
	return el('div', { class: 'palette-search-field' }, field, clear);
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
const chromeConnectionBanner = el('div', { class: 'chrome-connection-banner' });
chromeConnectionBanner.hidden = true;
chromeConnectionBanner.setAttribute('role', 'alert');
let chromeConnectionShown: string | undefined;
function renderChromeConnection(request: ChatViewState['chromeConnectionRequest']): void {
	chromeConnectionBanner.hidden = !request;
	if (!request || request.id === chromeConnectionShown) { return; }
	chromeConnectionShown = request.id;
	const allow = button(['Allow'], { class: 'primary' });
	const deny = button(['Deny'], { class: 'ghost' });
	const answer = (yes: boolean) => {
		allow.disabled = deny.disabled = true;
		post({ type: 'answerChromeConnection', id: request.id, allow: yes });
	};
	allow.addEventListener('click', () => answer(true));
	deny.addEventListener('click', () => answer(false));
	chromeConnectionBanner.replaceChildren(
		el('strong', { text: 'Connect Chrome to this chat panel?' }),
		el('span', { text: 'Chrome will be able to read and send messages, choose a model and respond to approval requests. Use Disconnect Chrome Chat to revoke access.' }),
		el('code', { text: request.extensionId }),
		el('div', { class: 'chrome-connection-actions' }, allow, deny));
}

const attachmentsRow = el('div', { class: 'attachments' });
const pasteStatus = el('div', { class: 'paste-status' });
pasteStatus.hidden = true;
pasteStatus.setAttribute('role', 'status');
let pendingPasteCount = 0;
let pasteSequence = 0;
let pasteQueue = Promise.resolve();
const pastedFileRequests = new Map<string, (error?: string) => void>();
const videoRecordingLabel = el('span', { class: 'video-recording-label' });
const videoPauseButton = button([icon('debug-pause')], { class: 'ghost', title: 'Pause video recording' });
const videoStopButton = button([icon('debug-stop')], { class: 'ghost', title: 'Stop video recording' });
const videoRecordingBar = el('div', { class: 'video-recording-bar' }, icon('record'), videoRecordingLabel,
	el('span', { class: 'video-recording-controls' }, videoPauseButton, videoStopButton));
videoRecordingBar.hidden = true;
videoRecordingBar.setAttribute('role', 'status');
let videoIsPaused = false;
videoPauseButton.addEventListener('click', () => post({ type: 'controlRecording', action: videoIsPaused ? 'resume' : 'pause' }));
videoStopButton.addEventListener('click', () => post({ type: 'controlRecording', action: 'stop' }));
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
effortRange.setAttribute('aria-label', 'Reasoning effort');
const effortBox = el('label', { class: 'effort' }, effortRange);
const ultracodeInput = el('input', { class: 'ultracode-input' });
ultracodeInput.type = 'checkbox';
ultracodeInput.setAttribute('aria-label', 'Ultracode — automatic workflows');
const ultracodeBox = el('label', { class: 'ultracode-toggle' }, ultracodeInput,
	el('span', { class: 'ultracode-indicator' }, el('span', { class: 'ultracode-symbol', text: '✦' })));
ultracodeBox.hidden = true;
const usageTitle = "Usage — your plan's limits for each agent, and this chat's tokens and cost";
const usageRing = ringMeter(el('span', { class: 'ring-mark', text: 'U' }));
const usageButton = button([usageRing], { class: 'ghost round usage-button', title: usageTitle });
const agentsButton = button([], { class: 'pill agents-button', title: 'Agents' });
/** How full the conversation's context is, as a pie that fills; a click compacts it. */
const sleepPopup = el('div', { class: 'popup sleep-popup' });
const featureSettingsPanel = el('div', { class: 'popup feature-settings' });
featureSettingsPanel.setAttribute('role', 'dialog');
featureSettingsPanel.tabIndex = -1;
featureSettingsPanel.setAttribute('aria-label', 'Chat Settings');
const contextPie = ringMeter(el('span', { text: 'C' }));
contextPie.classList.add('context-pie');
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
const toolbarSettings = el('div', { class: 'toolbar-settings' }, agentPill, modelPill, effortBox, ultracodeBox, approveToggle);
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
/** Below Send: record a voice message — asked for. The host records it; a webview may not open the microphone. */
const micButton = button([icon('mic')], { class: 'ghost round mic-button', title: 'Record a voice message' });
/**
 * The recording, across the message box while it lasts: the input's waveform,
 * the time, the limit and what is left, and the three keys. The box's text
 * stays underneath and comes back when it ends.
 */
const voiceWave = el('canvas', { class: 'voice-wave' });
const voiceTime = el('span', { class: 'voice-time' });
const voiceHint = el('span', { class: 'voice-hint' });
const voiceBar = el('div', { class: 'voice-bar' },
	el('span', { class: 'voice-dot' }), voiceWave, el('span', { class: 'voice-info' }, voiceTime, voiceHint));
voiceBar.hidden = true;
voiceBar.tabIndex = -1;
// The bar replaces the box a screen reader was in, so what it says is announced: the hint line
// (the keys, "Transcribing…"), not the time, which changes 25 times a second.
voiceBar.setAttribute('aria-label', 'Voice message');
voiceHint.setAttribute('role', 'status');
inputWrap.append(voiceBar);
/**
 * Why a voice message could not be made, above the box rather than over it: the box stays
 * usable, and no key is taken to close it. A click, or a few seconds, takes it away.
 */
const voiceError = el('div', { class: 'voice-error' });
voiceError.hidden = true;
voiceError.setAttribute('role', 'alert');
const inputActions = el('div', { class: 'input-actions' },
	el('span', { class: 'send-slot' }, sendButton), el('span', { class: 'send-slot' }, micButton), el('span', { class: 'send-slot' }, queueButton));
const inputArea = el('div', { class: 'input-area' }, inputWrap, inputActions);
const composer = el('div', { class: 'composer' }, videoRecordingBar, attachmentsRow, pasteStatus, voiceError, inputArea, toolbar);
/** Asked when another agent is picked for a conversation that has started. */
const switchCard = el('div', { class: 'switch-card' });
/** The toolbar skills the tab's agent offers, above the message box. */
const skillAddButton = button([icon('wand')], { class: 'skill-button skill-add', title: 'Add skill to toolbar' });
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
const gitChanged = el('span', { class: 'git-changed' }, '+0');
const gitDeleted = el('span', { class: 'git-deleted' }, '−0');
const gitRefresh = button([icon('refresh')], { class: 'ghost round', title: 'Refresh Git status' });
gitRefresh.setAttribute('aria-label', 'Refresh Git status');
const gitRefreshSlot = el('span', { class: 'git-refresh-slot' }, gitRefresh);
gitRefreshSlot.dataset.tip = 'Refresh Git status';
const branchName = el('span', { class: 'git-branch-name' }, '…');
const branchButton = button([icon('git-branch'), branchName, icon('chevron-down')], { class: 'ghost git-branch-button', title: 'Switch or manage Git branches' });
branchButton.setAttribute('aria-haspopup', 'dialog');
branchButton.setAttribute('aria-expanded', 'false');
const commitIcon = icon('git-commit');
const gitStagedCount = el('span', { class: 'git-staged-count', title: 'Staged files' });
const gitUnstagedCount = el('span', { class: 'git-unstaged-count', title: 'Unstaged files' });
const commitButton = button([commitIcon, 'Commit', gitStagedCount, gitUnstagedCount, icon('chevron-down')], { class: 'ghost git-commit-button', title: 'Git changes and commit' });
commitButton.setAttribute('aria-haspopup', 'dialog');
commitButton.setAttribute('aria-expanded', 'false');
const gitStatus = el('div', { class: 'git-status' }, branchButton, commitButton, gitRefreshSlot);
gitStatus.hidden = true;
let gitFolder: string | undefined;
let gitPending = false;
function refreshGitStatus(): void {
 if (!gitFolder || gitPending) { return; }
 gitPending = true;
 gitRefresh.disabled = true;
 gitPopupRefresh.disabled = true;
 branchRefresh.disabled = true;
 post({ type: 'refreshWorkdirGit' });
}
gitRefresh.addEventListener('click', refreshGitStatus);
gitStatus.addEventListener('mouseenter', refreshGitStatus);
commitButton.addEventListener('focus', refreshGitStatus);
setInterval(() => { if (!document.hidden) { refreshGitStatus(); } }, 15_000);
const workdirFooter = el('div', { class: 'workdir-status' }, workdirButton, workdirSummary, gitStatus);
const commitNoticeText = el('span', { class: 'git-commit-notice-text' });
const commitFix = button(['Fix with current model'], { class: 'git-commit-fix' });
const commitDismiss = button([icon('close')], { class: 'ghost round', title: 'Dismiss commit result' });
commitDismiss.setAttribute('aria-label', 'Dismiss commit result');
const commitNotice = el('div', { class: 'git-commit-notice' }, commitNoticeText, commitFix, commitDismiss);
commitNotice.setAttribute('role', 'status');
commitNotice.setAttribute('aria-live', 'polite');
commitNotice.hidden = true;
function answerCommit(type: 'fixGitCommit' | 'dismissGitCommit'): void {
	const commit = state?.workdir.commit;
	if (!gitFolder || !state || !commit) { return; }
	post({ type, folder: gitFolder, id: commit.id, tabId: state.activeTab });
}
commitFix.addEventListener('click', () => { commitFix.disabled = true; answerCommit('fixGitCommit'); });
commitDismiss.addEventListener('click', () => answerCommit('dismissGitCommit'));
const footer = el('div', { class: 'footer' }, questionDock, switchCard, skillBar, composer, workdirFooter, commitNotice);
workdirSummary.addEventListener('click', () => workdirButton.click());
/** One tab per open conversation, above the thread. */
const tabStrip = el('nav', { class: 'tab-strip' });
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
/** The conversation in front is open in Chrome's side panel: what is typed there appears here. */
const chromeMirrorLine = el('div', { class: 'chrome-mirror' }, icon('broadcast'),
	el('span', { text: 'Connected from Google Chrome — messages sent there appear here. Closing the Chrome panel does not stop the agent.' }));
chromeMirrorLine.hidden = true;
chromeMirrorLine.setAttribute('role', 'status');
usageAlertBar.setAttribute('role', 'status');

const menu = el('div', { class: 'popup menu' });
const usagePopup = el('div', { class: 'popup usage-popup' });
const approvalPopup = el('div', { class: 'popup approval-popup' });
/** The "/" palette: a search box over the chat's commands and the agent's skills. */
const palette = el('div', { class: 'popup palette' });
/** The folder button's list: folders to work in, then the files of the one in use. */
const workdirPopup = el('div', { class: 'popup palette workdir-popup' });
const gitPopup = el('div', { class: 'popup palette git-changes-popup' });
gitPopup.id = 'git-changes-popup';
gitPopup.setAttribute('role', 'dialog');
gitPopup.setAttribute('aria-label', 'Git changes and commit');
commitButton.setAttribute('aria-controls', gitPopup.id);
const gitPopupRefresh = button([icon('refresh')], { class: 'ghost round', title: 'Refresh Git changes' });
gitPopupRefresh.setAttribute('aria-label', 'Refresh Git changes');
gitPopupRefresh.disabled = gitPending;
gitPopupRefresh.addEventListener('click', () => { gitPopupPinned = true; refreshGitStatus(); });
const gitPopupHeader = el('div', { class: 'git-changes-heading' }, el('strong', {}, 'Git changes'),
 el('div', { class: 'git-changes-heading-tools' }, el('span', { class: 'git-change-totals' }, gitChanged, gitDeleted), gitPopupRefresh));
const gitPopupError = el('div', { class: 'git-branch-error' });
gitPopupError.setAttribute('role', 'status');
const gitPopupList = el('div', { class: 'git-changes-list' });
const gitPopupActions = el('div', { class: 'git-changes-actions' });
gitPopup.append(gitPopupHeader, gitPopupError, gitPopupList, gitPopupActions);
let gitFiles: WorkdirGitStatus | undefined;
let gitError = '';
let gitIndexPending = false;
let gitPopupPinned = false;
let gitPopupPressed = false;
let gitPopupShape = '';
let gitOpenTimer: ReturnType<typeof setTimeout> | undefined;
let gitCloseTimer: ReturnType<typeof setTimeout> | undefined;

function changeGitFiles(action: 'stage' | 'unstage', path?: string): void {
	if (!gitFolder || !state || gitIndexPending) { return; }
	gitPopupPinned = true;
	gitIndexPending = true;
	gitError = '';
	renderGitChanges();
	post({ type: 'gitIndexAction', folder: gitFolder, tabId: state.activeTab, action, path });
}
function commitGitFiles(scope: 'staged' | 'all'): void {
	if (!gitFolder || !state || gitIndexPending) { return; }
	closePopups();
	post({ type: 'gitCommit', folder: gitFolder, tabId: state.activeTab, scope });
}
const fileThemeFonts = new Map<string, string>();
/** The font family a file icon theme's font is loaded under, loading it once. */
function fileThemeFont(url: string): string {
 let family = fileThemeFonts.get(url);
 if (!family) {
  family = `git-file-theme-${fileThemeFonts.size}`;
  fileThemeFonts.set(url, family);
  const font = new FontFace(family, `url(${JSON.stringify(url)})`);
  void font.load().then(loaded => document.fonts.add(loaded)).catch(() => {});
 }
 return family;
}

/** The selected file icon theme, from the host (`fileIcons`); unset with none selected. */
let fileIconTable: FileIconTable | undefined;
/**
 * Changes with every table that differs from the one before, so the rows
 * already drawn are drawn again with it — and only then: the host sends the
 * table on every theme, association or extension change, mostly unchanged.
 */
let fileIconsSignature = '';
let fileIconsShown = 'null';

/**
 * The Explorer's icon for a file or folder name (a folder ends with `/`), from
 * the file icon theme — or nothing, where there is no theme or it has no icon
 * for the name. The glyph is drawn by `::before` from `data-char`, so it is not
 * part of the text: copying a reply or a prompt copies no private-use character.
 */
function themeFileIcon(name: string): HTMLElement | undefined {
 const data = fileIconTable ? resolveFileIcon(fileIconTable, name) : undefined;
 if (!data || !(data.image || (data.font && data.character))) { return undefined; }
 const node = el('span', { class: 'theme-file-icon' });
 node.setAttribute('aria-hidden', 'true');
 if (data.image) {
  node.style.backgroundImage = `url(${JSON.stringify(data.image)})`;
 } else {
  node.dataset.char = data.character;
  node.style.fontFamily = fileThemeFont(data.font!);
  node.style.color = data.color ?? '';
  // On `::before` only: the box keeps the text's size, so it is one line tall.
  if (data.size) { node.style.setProperty('--icon-size', data.size); }
 }
 return node;
}

/**
 * Text nodes with an icon put in front of each token that names a file
 * (`namesFile`, outside inline code): how a prompt shows `src/chat/chatView.ts`.
 * Other nodes are passed through as they are.
 */
function withFileIcons(nodes: readonly Node[]): Node[] {
 if (!fileIconTable) { return [...nodes]; }
 const table = fileIconTable;
 const out: Node[] = [];
 for (const node of nodes) {
  if (node.nodeType !== Node.TEXT_NODE) { out.push(node); continue; }
  const text = node.textContent ?? '';
  let last = 0;
  // Greedy, with sentence punctuation taken off the end in code: a lazy token
  // with a lookahead for that punctuation backtracked quadratically on a long
  // run of dots (200 ms for 20 000, measured).
  for (const m of text.matchAll(/(^|[\s(\["'«])([^\s()\[\]"'«»,;!?]+)/g)) {
   let end = m[2].length;
   while (end > 0 && (m[2][end - 1] === '.' || m[2][end - 1] === ':')) { end--; }
   const token = m[2].slice(0, end);
   if (!token) { continue; }
   const start = m.index + m[1].length;
   const fileIcon = namesFile(table, token, false) ? themeFileIcon(token) : undefined;
   if (!fileIcon) { continue; }
   if (start > last) { out.push(document.createTextNode(text.slice(last, start))); }
   out.push(fileIcon, document.createTextNode(token));
   last = start + token.length;
  }
  out.push(last ? document.createTextNode(text.slice(last)) : node);
 }
 return out;
}

function gitFileIcon(file: import('../src/chat/chatProtocol').GitStatusFile): HTMLElement {
 const data = file.icon;
 const node = el('span', { class: 'git-file-icon' });
 node.setAttribute('aria-hidden', 'true');
 if (data?.image) {
  const image = el('img');
  image.src = data.image;
  image.alt = '';
  node.append(image);
 } else if (data?.font && data.character) {
  node.style.fontFamily = fileThemeFont(data.font);
  node.style.color = data.color ?? '';
  node.style.fontSize = data.size ?? '16px';
  node.textContent = data.character;
 }
 return node;
}
function renderGitChanges(): void {
	const staged = gitFiles?.staged.length ?? 0;
	const unstaged = gitFiles?.unstaged.length ?? 0;
	gitStagedCount.textContent = staged ? String(staged) : '';
	gitStagedCount.hidden = staged === 0;
	gitUnstagedCount.textContent = unstaged ? String(unstaged) : '';
	gitUnstagedCount.hidden = unstaged === 0;
	gitChanged.textContent = gitFiles ? `+${gitFiles.changed}` : '—';
	gitDeleted.textContent = gitFiles ? `−${gitFiles.deleted}` : '';
	commitButton.setAttribute('aria-label', `Git changes and commit. Staged: ${staged} files. Unstaged: ${unstaged} files.`);
	if (!gitPopup.classList.contains('open') || gitPopupPressed) { return; }
	const commit = state?.workdir.commit;
	const committing = commit?.phase === 'generating' || commit?.phase === 'committing';
	const commitChoice = readFeatureAiSettings(state?.featureAi).commitMessage;
	const commitAgentId = featureAgent(commitChoice, state?.selection.agent, id => !!state?.agents.some(a => a.id === id && a.available && a.models.length > 0));
	const commitAgent = state?.agents.find(a => a.id === commitAgentId && a.available);
	const modelAvailable = !!commitAgent?.models.length;
	const busyReason = committing ? commit?.message ?? 'Committing…' : gitIndexPending ? 'Updating Git changes…' : branchBusy ? 'Switching branch…' : state?.running ? 'Wait for the agent to finish before changing Git files.' : '';
	const commitReason = busyReason || (!modelAvailable ? 'Choose an available agent for commit messages in Chat Settings.' : '');
	const shape = JSON.stringify([gitFiles, gitError, busyReason, commitReason, commitAgentId, commitChoice.effort]);
	if (shape === gitPopupShape) { return; }
	gitPopupShape = shape;
	gitPopupError.textContent = gitError;
	gitPopupList.replaceChildren();
	gitPopupActions.replaceChildren();
	if (!gitFiles) {
		gitPopupList.append(el('div', { class: 'git-branch-empty' }, gitError || 'Loading Git changes…'));
		return;
	}
	for (const [label, files, action] of [['Staged', gitFiles.staged, 'unstage'], ['Unstaged', gitFiles.unstaged, 'stage']] as const) {
		const all = button([icon(action === 'stage' ? 'add' : 'discard')], { class: 'ghost round', title: action === 'stage' ? 'Stage all files' : 'Unstage all files (keep working changes)' });
		all.setAttribute('aria-label', action === 'stage' ? 'Stage all files' : 'Unstage all files');
		all.disabled = !files.length || !!busyReason;
		all.addEventListener('click', () => changeGitFiles(action));
		gitPopupList.append(el('div', { class: 'git-changes-group' }, el('strong', {}, `${label} (${files.length})`), all));
		if (!files.length) { gitPopupList.append(el('div', { class: 'git-branch-empty' }, 'No files')); }
		for (const file of files) {
			const name = file.originalPath ? `${file.originalPath} → ${file.path}` : file.path;
			const move = button([icon(action === 'stage' ? 'add' : 'discard')], { class: 'ghost round', title: `${action === 'stage' ? 'Stage' : 'Unstage'} ${file.path}` });
			move.setAttribute('aria-label', `${action === 'stage' ? 'Stage' : 'Unstage'} ${file.path}`);
			move.disabled = !!busyReason;
			move.addEventListener('click', () => changeGitFiles(action, file.path));
			// The letter stands at the right, before the stage button, as in Source Control.
			const statusMark = el('span', {
				class: `git-status-letter ${file.status === 'M' ? 'git-modified' : file.status === '?' ? 'git-changed' : file.status === 'D' ? 'git-deleted' : ''}`,
				title: file.status === '?' ? 'New — file not yet tracked by Git' : file.status === 'M' ? 'Modified file' : file.status,
			}, file.status === '?' ? 'N' : file.status);
			const open = button([name], { class: file.status === 'D' ? 'git-file git-deleted git-file-open' : 'git-file git-file-open', title: `Open ${label.toLowerCase()} diff: ${name}` });
			open.addEventListener('click', () => {
				if (!gitFolder || !state) { return; }
				gitPopupPinned = true;
				post({ type: 'openGitDiff', folder: gitFolder, tabId: state.activeTab, path: file.path, staged: label === 'Staged' });
			});
			gitPopupList.append(el('div', { class: 'git-changes-file' }, gitFileIcon(file), open, statusMark, move));
		}
	}
	const note = (text: string) => gitPopupActions.append(el('div', { class: 'git-changes-hint' }, text));
	const commitAction = (label: string, scope: 'staged' | 'all') => {
		const action = button([icon('git-commit'), label], { class: 'git-changes-commit', title: commitReason || `Generate a commit message with ${commitAgent?.name ?? 'the configured agent'}` });
		action.disabled = !!commitReason;
		action.addEventListener('click', () => commitGitFiles(scope));
		gitPopupActions.append(action);
	};
	if (staged && unstaged) {
		note('What would you like to commit?');
		commitAction(`Commit staged (${staged})`, 'staged');
		commitAction('Commit all changes', 'all');
	} else if (staged) { commitAction(`Commit staged (${staged})`, 'staged'); }
	else if (unstaged) {
		note('Nothing staged. Add all changed files to Staged?');
		const stage = button([icon('add'), 'Stage all files'], { class: 'git-changes-commit' });
		stage.disabled = !!busyReason;
		stage.addEventListener('click', () => changeGitFiles('stage'));
		gitPopupActions.append(stage);
	} else { note('No changes to commit.'); }
	if (busyReason || (staged && commitReason)) { note(busyReason || commitReason); }
	if (staged && !modelAvailable && !busyReason) {
		const choose = button(['Choose model…'], { class: 'ghost' });
		choose.addEventListener('click', () => { closePopups(); modelPill.click(); });
		gitPopupActions.append(choose);
	}
}
function openGitChanges(pin: boolean): void {
	if (!gitFolder) { return; }
	if (!pin && document.querySelector('.popup.open') && !gitPopup.classList.contains('open')) { return; }
	if (pin) { gitPopupPinned = true; }
	if (!gitPopup.classList.contains('open')) {
		openAbove(gitPopup, commitButton, 'right');
		gitPopupShape = '';
	}
	commitButton.setAttribute('aria-expanded', 'true');
	renderGitChanges();
	refreshGitStatus();
}
function closeGitHover(): void {
	clearTimeout(gitOpenTimer);
	clearTimeout(gitCloseTimer);
	gitCloseTimer = setTimeout(() => {
		if (!gitPopupPinned && gitPopup.classList.contains('open')) { closePopups(); }
	}, 250);
}
commitButton.addEventListener('click', () => {
	clearTimeout(gitOpenTimer); clearTimeout(gitCloseTimer);
	if (gitPopup.classList.contains('open') && gitPopupPinned) { closePopups(); return; }
	openGitChanges(true);
	gitPopup.querySelector<HTMLButtonElement>('.git-changes-commit:not(:disabled)')?.focus();
});
commitButton.addEventListener('mouseenter', () => {
	clearTimeout(gitCloseTimer);
	gitOpenTimer = setTimeout(() => openGitChanges(false), 150);
});
commitButton.addEventListener('mouseleave', closeGitHover);
gitPopup.addEventListener('mouseenter', () => clearTimeout(gitCloseTimer));
gitPopup.addEventListener('mouseleave', closeGitHover);
gitPopup.addEventListener('focusin', () => { gitPopupPinned = true; });
gitPopup.addEventListener('mousedown', () => { gitPopupPressed = true; gitPopupPinned = true; });
document.addEventListener('mouseup', () => {
	if (!gitPopupPressed) { return; }
	gitPopupPressed = false;
	setTimeout(renderGitChanges, 0);
});

const branchPopup = el('div', { class: 'popup palette git-branch-popup' });
branchPopup.id = 'git-branch-popup';
branchPopup.setAttribute('role', 'dialog');
branchPopup.setAttribute('aria-label', 'Git branches');
branchButton.setAttribute('aria-controls', branchPopup.id);
const branchSearch = el('input', { class: 'palette-search' });
branchSearch.type = 'text';
branchSearch.placeholder = 'Find or create a branch…';
branchSearch.setAttribute('aria-label', 'Find or create a branch');
branchSearch.spellcheck = false;
const branchError = el('div', { class: 'git-branch-error' });
branchError.setAttribute('role', 'status');
const branchCreate = button([icon('add'), 'Create branch…'], { class: 'git-branch-create' });
const branchRestoreStash = button(['Return & Apply Stash'], { class: 'git-branch-create' });
branchRestoreStash.hidden = true;
branchRestoreStash.addEventListener('click', () => {
	if (!gitFolder || branchBusy) { return; }
	post({ type: 'restoreBranchStash', folder: gitFolder });
});
const branchList = el('div', { class: 'palette-list git-branch-list' });
const branchSearchRow = el('div', { class: 'git-branch-search-row' });
const branchMagic = button([icon('sparkle')], { class: 'ghost round git-branch-magic', title: 'Generate branch name automatically' });
branchMagic.dataset.tip = 'Generate branch name automatically';
branchMagic.setAttribute('aria-label', branchMagic.dataset.tip);
const branchRefresh = button([icon('refresh')], { class: 'ghost round', title: 'Refresh Git branches' });
branchRefresh.setAttribute('aria-label', 'Refresh Git branches');
branchRefresh.disabled = gitPending;
branchRefresh.addEventListener('click', refreshGitStatus);
branchSearchRow.append(clearableSearch(branchSearch), branchMagic, branchRefresh);
/** The current branch against its remote: Publish, Push, Pull, and the pull request page. */
const branchSync = el('div', { class: 'git-branch-sync' });
branchPopup.append(branchSearchRow, branchSync, branchError, branchRestoreStash, branchCreate, branchList);
let branchNameSequence = 0;
let branchNamePending: { id: number; tabId: string; folder: string; query: string } | undefined;
branchMagic.addEventListener('click', () => {
 if (!state || !gitFolder || branchBusy || branchNamePending) { return; }
 branchNamePending = { id: ++branchNameSequence, tabId: state.activeTab, folder: gitFolder, query: branchSearch.value };
 branchError.textContent = 'Generating branch name…';
 post({ type: 'gitBranchName', ...branchNamePending });
 renderBranches();
});
let branchState: GitBranchState | undefined;
let branchBusy = false;
let branchDeleting: string | undefined;
let branchRenderedShape = "";
/** A push the host asked about first; Push sends it again with `confirmed`. */
let remoteConfirm: { action: GitRemoteAction; remote?: string; text: string; key: string } | undefined;
/** The remote picked to publish to, where there are several. */
let publishRemoteChoice: string | undefined;
function runRemoteAction(action: GitRemoteAction, remote?: string, confirmed?: string): void {
	if (!gitFolder || branchBusy) { return; }
	branchBusy = true;
	remoteConfirm = undefined;
	branchError.textContent = action === 'publish' ? 'Publishing branch…' : action === 'push' ? 'Pushing…' : 'Pulling…';
	post({ type: 'gitRemoteAction', folder: gitFolder, action, ...(remote ? { remote } : {}), ...(confirmed ? { confirmed } : {}) });
	renderBranches();
}
function renderBranchSync(): void {
	branchSync.replaceChildren();
	const current = branchState?.current;
	if (!branchState || !current) { branchSync.hidden = true; return; }
	branchSync.hidden = false;
	if (remoteConfirm) {
		const confirmation = remoteConfirm;
		const no = button(['Cancel'], { class: 'primary' });
		const yes = button([confirmation.action === 'publish' ? 'Publish' : 'Push'], { class: 'ghost' });
		no.addEventListener('click', () => { remoteConfirm = undefined; renderBranches(); branchSearch.focus(); });
		yes.addEventListener('click', () => runRemoteAction(confirmation.action, confirmation.remote, confirmation.key));
		branchSync.append(el('div', { class: 'git-branch-sync-text wrap' }, confirmation.text), el('div', { class: 'git-branch-sync-actions form-actions' }, yes, no));
		return;
	}
	const remotes = branchState.remotes ?? [];
	const upstream = branchState.upstream;
	const actions = el('div', { class: 'git-branch-sync-actions' });
	const action = (label: string, iconName: string, tip: string, run: () => void) => {
		const b = button([icon(iconName), label], { class: 'git-branch-sync-button', title: tip });
		b.disabled = branchBusy;
		b.addEventListener('click', run);
		actions.append(b);
		return b;
	};
	let text: string;
	if (!upstream || upstream.gone) {
		if (!remotes.length) {
			branchSync.append(el('div', { class: 'git-branch-sync-text muted' }, `${current} · no remote to publish to`));
			return;
		}
		text = upstream?.gone ? `${current} · its branch on ${upstream.remote} was deleted` : `${current} · not published`;
		const names = remotes.map(r => r.name);
		const preset = upstream?.gone && names.includes(upstream.remote) ? upstream.remote : names.includes('origin') ? 'origin' : names[0];
		if (!publishRemoteChoice || !names.includes(publishRemoteChoice)) { publishRemoteChoice = preset; }
		if (names.length > 1) {
			const select = el('select', { class: 'git-branch-remote' });
			select.setAttribute('aria-label', 'Remote to publish to');
			for (const name of names) {
				const option = el('option', {}, name);
				option.value = name;
				option.selected = name === publishRemoteChoice;
				select.append(option);
			}
			select.disabled = branchBusy;
			select.addEventListener('change', () => { publishRemoteChoice = select.value; });
			actions.append(select);
		}
		action('Publish branch', 'cloud-upload', `Push ${current} and set its upstream`, () => runRemoteAction('publish', publishRemoteChoice));
	} else {
		const target = `${upstream.remote}/${upstream.branch}`;
		const counts = [upstream.ahead ? `↑${upstream.ahead}` : '', upstream.behind ? `↓${upstream.behind}` : ''].filter(Boolean).join(' ');
		text = `${target}${counts ? ` · ${counts}` : ' · up to date'}`;
		if (upstream.ahead && upstream.behind) {
			text += ' · diverged — merge or rebase yourself';
		} else if (upstream.ahead) {
			action('Push', 'arrow-up', `Push ${upstream.ahead} commit${upstream.ahead === 1 ? '' : 's'} to ${target}`, () => runRemoteAction('push'));
		} else if (upstream.behind) {
			action('Pull', 'arrow-down', `Fetch and fast-forward to ${target}`, () => runRemoteAction('pull'));
		}
		if (branchState.pullRequest) {
			const url = branchState.pullRequest;
			const pr = action('Pull request', 'git-pull-request', `Open the pull request page on GitHub — ${isMacView ? '⌘' : 'Ctrl'}-click for the system browser`, () => undefined);
			pr.disabled = false;
			pr.addEventListener('click', event => { post({ type: 'openLink', url, external: isMacView ? event.metaKey : event.ctrlKey }); });
		}
	}
	branchSync.append(el('div', { class: 'git-branch-sync-text', title: text }, text), actions);
}
function runBranchAction(action: 'switch' | 'create' | 'delete', name: string, remote = false): void {
	if (!gitFolder || branchBusy) { return; }
	branchBusy = true;
	branchError.textContent = action === 'delete' ? 'Deleting branch…' : 'Switching branch…';
	post({ type: 'gitBranchAction', folder: gitFolder, action, name, remote });
	renderBranches();
}
function renderBranches(): void {
	const query = branchSearch.value.trim();
	const shape = JSON.stringify([branchState, query, branchBusy, branchDeleting, gitPending, !!branchNamePending, remoteConfirm]);
	if (shape === branchRenderedShape) { return; }
	branchRenderedShape = shape;
	renderBranchSync();
	branchSearch.disabled = branchBusy;
	branchRestoreStash.hidden = !branchState?.savedStash;
	branchRestoreStash.disabled = branchBusy;
	branchRestoreStash.textContent = branchState?.savedStash ? `Return to ${branchState.savedStash.branch} & Apply Stash` : 'Return & Apply Stash';
 branchMagic.disabled = branchBusy || !branchState || !!branchNamePending;
 branchMagic.classList.toggle('loading', !!branchNamePending);
 branchError.classList.toggle('generating', !!branchNamePending);
	branchCreate.textContent = query ? `+ Create “${query}” from ${branchState?.current || 'HEAD'}` : '+ Create a new branch (enter name above)';
	branchCreate.disabled = branchBusy || !branchState || !query || !!branchState?.branches.some(b => !b.remote && b.name === query);
	branchList.replaceChildren();
	if (!branchState) {
		branchList.append(el('div', { class: 'git-branch-empty' }, gitPending ? 'Loading branches…' : 'No Git repository available'));
		return;
	}
	for (const remote of [false, true]) {
		const matches = branchState.branches.filter(b => b.remote === remote && b.name.toLowerCase().includes(query.toLowerCase()));
		if (!matches.length) { continue; }
		branchList.append(el('div', { class: 'git-group-title' }, remote ? 'Remote branches' : 'Local branches'));
		for (const branch of matches) {
			const current = !remote && branch.name === branchState.current;
			const select = button([icon(current ? 'check' : 'git-branch', current ? 'git-current-check' : ''), el('span', { class: 'git-branch-row-name' }, branch.name)], { class: current ? 'git-branch-select current' : 'git-branch-select', title: current ? 'Current branch' : `Switch to ${branch.name}` });
			if (current) { select.setAttribute('aria-current', 'true'); }
			select.disabled = current || branchBusy;
			select.addEventListener('click', () => runBranchAction('switch', branch.name, remote));
			const row = el('div', { class: 'git-branch-row' }, select);
			if (!remote && !current) {
				const remove = button([branchDeleting === branch.name ? 'Delete?' : icon('trash')], { class: 'ghost git-branch-delete', title: `Delete local branch ${branch.name}` });
				remove.setAttribute('aria-label', `Delete local branch ${branch.name}`);
				remove.disabled = branchBusy;
				remove.addEventListener('click', () => {
					if (branchDeleting === branch.name) { runBranchAction('delete', branch.name); }
					else {
						branchDeleting = branch.name;
						renderBranches();
						[...branchList.querySelectorAll<HTMLButtonElement>('.git-branch-delete')]
							.find(button => button.getAttribute('aria-label') === `Delete local branch ${branch.name}`)?.focus();
					}
				});
				row.append(remove);
				if (branchDeleting === branch.name) {
					const cancel = button(['Cancel'], { class: 'ghost' });
					cancel.disabled = branchBusy;
					cancel.addEventListener('click', () => {
						branchDeleting = undefined;
						renderBranches();
						[...branchList.querySelectorAll<HTMLButtonElement>('.git-branch-delete')]
							.find(button => button.getAttribute('aria-label') === `Delete local branch ${branch.name}`)?.focus();
					});
					row.append(cancel);
				}
			}
			branchList.append(row);
		}
	}
	if (!branchList.childElementCount) { branchList.append(el('div', { class: 'git-branch-empty' }, 'No matching branches')); }
}
branchButton.addEventListener('click', () => {
	if (branchPopup.classList.contains('open')) { closePopups(); return; }
	branchSearch.value = '';
	branchDeleting = undefined;
	remoteConfirm = undefined;
	branchError.textContent = '';
	renderBranches();
	openAbove(branchPopup, branchButton, 'right');
	branchButton.setAttribute('aria-expanded', 'true');
	refreshGitStatus();
	branchSearch.focus();
});
branchSearch.addEventListener('input', () => { branchDeleting = undefined; renderBranches(); });
branchCreate.addEventListener('click', () => runBranchAction('create', branchSearch.value.trim()));
branchSearch.addEventListener('keydown', event => {
	if (event.isComposing) { return; }
	if (event.key === 'Enter') {
		event.preventDefault();
		// Only the branch named exactly is switched to from the search box;
		// anything else typed is a new branch, and nothing typed does nothing.
		// The first branch that merely contained the text used to be checked
		// out — any branch on an empty box, `experiment-old` for "exp" while
		// the row offered to create "exp". A row picked with ↓ has the focus,
		// and Enter there is that row's own button.
		const exact = branchState?.branches.find(b => b.name === branchSearch.value.trim());
		if (exact) { if (exact.remote || exact.name !== branchState?.current) { runBranchAction('switch', exact.name, exact.remote); } }
		else if (!branchCreate.disabled) { branchCreate.click(); }
	} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
		event.preventDefault();
		const choices = branchNavItems();
		(event.key === 'ArrowDown' ? choices[0] : choices.at(-1))?.focus();
	}
});
/**
 * Everything ↑ / ↓ walks in the branches window, top to bottom: the current
 * branch's Publish / Push / Pull / Pull request, Return & Apply Stash, Create,
 * then each branch row's switch button. One order, so the keys reach every
 * action and not only the list. A remote select is left to Tab — arrows on it
 * change its value.
 */
function branchNavItems(): HTMLButtonElement[] {
	return [...branchPopup.querySelectorAll<HTMLButtonElement>(
		'.git-branch-sync button, .git-branch-create, .git-branch-select',
	)].filter(b => !b.disabled && !b.hidden && b.offsetParent !== null);
}
branchPopup.addEventListener('keydown', event => {
	if (event.isComposing || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { return; }
	// The key's own target, never `document.activeElement`: ↓ in the search box
	// focuses the first item and the event then bubbles here, where the active
	// element is already that item — reading it moved the focus a second step.
	// The search box has its own keys; a select's arrows change its value.
	const focused = event.target;
	if (!(focused instanceof HTMLButtonElement) || !branchPopup.contains(focused)) { return; }
	event.preventDefault();
	if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
		// Across one row: a branch's switch and delete buttons, or Cancel beside a pending delete.
		const row = focused.closest('.git-branch-row, .git-branch-sync-actions');
		const actions = [...(row?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
		const index = actions.indexOf(focused as HTMLButtonElement);
		actions[Math.max(0, Math.min(actions.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)))]?.focus();
		return;
	}
	const choices = branchNavItems();
	if (event.key === 'Home' || event.key === 'End') {
		(event.key === 'Home' ? choices[0] : choices.at(-1))?.focus();
		return;
	}
	// A delete or Cancel button walks from its row's switch button.
	const anchor = focused.closest('.git-branch-row')?.querySelector<HTMLButtonElement>('.git-branch-select') ?? focused;
	const index = choices.indexOf(anchor);
	const next = index + (event.key === 'ArrowDown' ? 1 : -1);
	if (next < 0) { branchSearch.focus(); } else { choices[Math.min(next, choices.length - 1)]?.focus(); }
});
branchPopup.addEventListener('keydown', event => {
	if (event.isComposing || event.key !== 'Escape') { return; }
	event.preventDefault();
	event.stopPropagation();
	closePopups();
	branchButton.focus();
});

/** Adding or editing a toolbar skill: a panel over the chat. */
const skillEditor = el('div', { class: 'history-panel skill-editor' });
/** A toolbar skill's parameters, asked for when it runs; or its run, while it runs. */
const paramsPopup = el('div', { class: 'popup params-popup' });
/**
 * The anchor of the parameters popover while it holds a form the user types
 * into — the GitHub form, a toolbar skill's parameters — and undefined while
 * it holds a question or nothing. Set after `openAbove`, which clears it.
 */
let paramsFormAnchor: HTMLElement | undefined;
const historyPanel = el('div', { class: 'history-panel' });
const agentsPanel = el('div', { class: 'history-panel agents-panel' });
/** Which copy of each agent's CLI this project uses: opened from the gear in the agent menu. */
const agentAppsPanel = el('div', { class: 'history-panel agent-apps' });

const chatMain = el('main', { class: 'chat-main' }, chromeConnectionBanner, chromeMirrorLine, usageAlertBar, thread, blocked, footer);
app.append(featureSettingsPanel, sleepPopup, tabStrip, chatMain, menu, usagePopup, approvalPopup, palette, workdirPopup, branchPopup, gitPopup, paramsPopup, skillEditor, historyPanel, agentsPanel, agentAppsPanel);

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
let chatDrawerCollapsed = savedView?.chatDrawerCollapsed ?? false;
let chatDrawerSide: 'left' | 'right' = savedView?.chatDrawerSide === 'right' ? 'right' : 'left';
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
	vscode.setState({ drafts, chatDrawerCollapsed, chatDrawerSide, panel: state?.panel ?? savedView?.panel });
	post({ type: 'saveDrafts', drafts });
}

/**
 * Each conversation keeps its own draft: moving to another tab puts this one's
 * away and brings that one's back. Drafts of conversations no longer open are
 * dropped, or the view state would grow with every chat ever started.
 */
function followDraft(s: ChatViewState): void {
	// Prune departed background chats even when the selected conversation is unchanged.
	const openChats = new Set(s.tabs.map(tab => tab.chatId));
	for (const id of Object.keys(drafts)) { if (!openChats.has(id)) { delete drafts[id]; } }
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
	vscode.setState({ drafts, chatDrawerCollapsed, chatDrawerSide, panel: state?.panel ?? savedView?.panel });
	post({ type: 'saveDrafts', drafts });
	autosize();
}

let recordingEncoder: { id: string; encoder: ReturnType<typeof createRecordingEncoder> } | undefined;
window.addEventListener('unload', () => recordingEncoder?.encoder.dispose());
window.addEventListener('message', (event: MessageEvent<HostToView>) => {
	const message = event.data;
	switch (message.type) {
		case 'pastedFileResult':
			pastedFileRequests.get(message.id)?.(message.error);
			return;
		case 'recordingStatus': {
			videoRecordingBar.hidden = !message.state;
			videoIsPaused = message.state === 'paused';
			const seconds = Math.floor(message.seconds);
			const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
			videoRecordingLabel.textContent = message.state === 'starting' ? 'Starting video recording…'
				: message.state === 'stopping' ? 'Saving video…' : `${videoIsPaused ? 'Video paused' : 'Recording video'} · ${time}`;
			videoRecordingBar.classList.toggle('paused', videoIsPaused);
			videoPauseButton.replaceChildren(icon(videoIsPaused ? 'debug-continue' : 'debug-pause'));
			videoPauseButton.title = videoIsPaused ? 'Resume video recording' : 'Pause video recording';
			videoPauseButton.disabled = videoStopButton.disabled = message.state !== 'recording' && message.state !== 'paused';
			return;
		}
		case 'recording': {
			if (message.message.type === 'open') {
				recordingEncoder?.encoder.dispose();
				const encoder = createRecordingEncoder(reply => post({ type: 'recording', id: message.id, message: reply }));
				recordingEncoder = { id: message.id, encoder };
				post({ type: 'recording', id: message.id, message: { type: 'ready' } });
			} else if (recordingEncoder?.id === message.id) {
				if (message.message.type === 'close') { recordingEncoder.encoder.dispose(); recordingEncoder = undefined; }
				else { recordingEncoder.encoder.receive(message.message); }
			}
			return;
		}
		case 'state':
			state = message.state;
			renderChromeConnection(state.chromeConnectionRequest);
			render();
			vscode.setState({ drafts, chatDrawerCollapsed, chatDrawerSide, panel: state.panel });
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
		case 'voice':
			onVoice(message.event);
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
  case 'gitBranchNameResult': {
   const pending = branchNamePending;
   if (!pending || pending.id !== message.id) { return; }
   branchNamePending = undefined;
   if (state?.activeTab === pending.tabId && gitFolder === pending.folder && branchPopup.classList.contains('open') && !branchBusy && branchSearch.value === pending.query) {
    branchError.textContent = message.error ?? '';
    if (message.name) { branchSearch.value = message.name; branchDeleting = undefined; branchSearch.focus(); }
   }
   renderBranches();
   return;
  }
  case 'gitBranchResult': {
   if (message.folder !== gitFolder) { return; }
   branchBusy = false;
   branchDeleting = undefined;
   branchError.textContent = message.error ?? '';
   renderBranches();
   renderGitChanges();
   if (!message.error) {
    if (message.action === 'delete') {
     if (branchPopup.classList.contains('open')) { branchSearch.focus(); }
    } else { closePopups(); branchButton.focus(); }
   }
   return;
  }
  case 'gitRemoteResult': {
   if (message.folder !== gitFolder) { return; }
   branchBusy = false;
   branchError.textContent = message.error ?? '';
   remoteConfirm = message.confirm ? { action: message.action, ...(message.action === 'publish' && publishRemoteChoice ? { remote: publishRemoteChoice } : {}), text: message.confirm, key: message.confirmKey ?? '' } : undefined;
   renderBranches();
   if (remoteConfirm && branchPopup.classList.contains('open')) { branchSync.querySelector<HTMLButtonElement>('button.primary')?.focus(); }
   return;
  }
  case 'gitIndexResult': {
   if (message.folder !== gitFolder) { return; }
   gitIndexPending = false;
   if (message.error) { gitError = message.error; }
   renderGitChanges();
   return;
  }
  case 'workdirGit': {
   if (message.folder !== gitFolder) { return; }
   gitPending = false;
   gitRefresh.disabled = false;
   gitPopupRefresh.disabled = false;
   branchRefresh.disabled = false;
   gitFiles = message.status;
   if (message.error) { gitError = message.error; }
   else if (!gitIndexPending) { gitError = ''; }
   branchState = message.branches;
   branchName.textContent = branchState ? branchState.current || 'Detached HEAD' : 'Git';
   branchButton.title = branchState ? `Current branch: ${branchState.current || 'Detached HEAD'} — switch or manage branches` : message.error ?? 'Git branches unavailable';
   if (branchPopup.classList.contains('open')) { renderBranches(); }
   renderGitChanges();
   return;
  }
		case 'fileIcons': {
			const shown = JSON.stringify(message.table ?? null);
			if (shown === fileIconsShown) { return; }
			fileIconsShown = shown;
			fileIconTable = message.table;
			fileIconsSignature = String(Number(fileIconsSignature || 0) + 1);
			render();
			return;
		}
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
		case 'temporaryStorage':
			temporaryStorageBusy = false;
			temporaryStorageState = message.storage;
			renderTemporaryStorage(message.error);
			return;
		case 'openSettings':
            openFeatureSettings();
            return;
        case 'featureAiSaved':
            featureSettingsSaving = false;
            if (!message.error && message.settings) { featureSettingsDraft = readFeatureAiSettings(message.settings); }
            if (!message.error) { videoQualityDraft = readRecordingQuality(message.recordingQuality); videoSecondsDraft = readRecordingSeconds(message.recordingSeconds); }
            featureSettingsStatus.textContent = message.error ? `Could not save settings: ${message.error}` : 'Settings saved.';
            featureSettingsSave.disabled = false;
            for (const select of featureSettingsPanel.querySelectorAll('select')) {
                if (select.dataset.field === 'recordingQuality') { select.value = videoQualityDraft; select.disabled = false; continue; }
                if (select.dataset.field === 'recordingUnit') { select.value = lengthFields(videoSecondsDraft ?? 300).unit; select.disabled = false; continue; }
                const choice = featureSettingsDraft[select.dataset.feature as AiFeature];
                select.value = select.dataset.field === 'agent' ? choice.agent : choice.effort;
                select.disabled = false;
            }
            for (const field of featureSettingsPanel.querySelectorAll<HTMLTextAreaElement>('textarea[data-feature]')) {
                const feature = field.dataset.feature as AiFeature;
                field.value = featureSettingsDraft[feature].prompt ?? defaultFeaturePrompts[feature]; field.disabled = false;
            }
            for (const reset of featureSettingsPanel.querySelectorAll<HTMLButtonElement>('.feature-prompt-reset')) { reset.disabled = false; }
            for (const length of featureSettingsPanel.querySelectorAll<HTMLInputElement>('input[data-field="recordingSeconds"]')) {
                length.value = String(lengthFields(videoSecondsDraft ?? 300).value); length.disabled = false; length.removeAttribute('aria-invalid');
            }
            return;
		case 'openSleep':
			buildSleepPopup(); renderSleep(); openSleepPopup();
			return;
		case 'hydrateDrafts':
			Object.assign(drafts, message.drafts);
			return;
		case 'setTabDraft':
			drafts[message.chatId] = message.text;
			if (state?.chatId === message.chatId) {
				fromHistory = false; historyAt = inputHistory.length; input.value = message.text;
				autosize(); saveDraft(); renderSend(); input.focus();
			}
			return;
		case 'readTabDraft': {
			saveDraft();
			const tab = state?.tabs.find(tab => tab.id === message.tabId && tab.chatId === message.chatId);
			post({ type: 'tabDraft', request: message.request,
				draft: tab ? (message.tabId === draftTab ? currentDraft() : drafts[message.chatId] ?? '') : undefined });
			return;
		}
		case 'historyChatOpen':
			openMenu(tabAdd, [
				{ icon: 'arrow-right', label: 'Move here', description: `Move the live chat from ${message.source}.`, run: () => post({ type: 'resolveHistoryChat', id: message.id, action: 'move' }) },
				{ icon: 'link-external', label: `Show in ${message.source}`, run: () => post({ type: 'resolveHistoryChat', id: message.id, action: 'show' }) },
			], 'This chat is already open');
			return;
		case 'chooseNewChatLocation':
			chooseNewChatLocation();
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
	renderVoice();
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
	chromeMirrorLine.hidden = !state.chromeMirror;
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
	readonly compactNumber: number;
	readonly root: HTMLElement;
	readonly label: HTMLButtonElement;
	readonly close: HTMLButtonElement;
	tab: ChatTabSummary;
	shown: string;
	/** A name just given, shown until the state carries it; see `startRename`. */
	pendingTitle?: { readonly title: string; readonly until: number };
}

let nextCompactTabNumber = 1;
const tabNodes = new Map<string, TabNode>();
const wideChat = matchMedia('(min-width: 1000px)');
const tabRow = el('div', { class: 'tab-row' });
tabRow.id = 'chat-tab-list';
const drawerToggle = button([], { class: 'ghost round chat-drawer-toggle' });
drawerToggle.setAttribute('aria-controls', tabRow.id);
const drawerSideToggle = button([], { class: 'ghost round chat-drawer-side-toggle' });
const drawerHeader = el('div', { class: 'chat-drawer-header' },
	el('span', { class: 'chat-drawer-title', text: 'Chats' }), drawerToggle);
const drawerFooter = el('div', { class: 'chat-drawer-footer' }, drawerSideToggle);
function updateChatDrawer(): void {
	app.classList.toggle('chat-drawer-collapsed', chatDrawerCollapsed);
	app.classList.toggle('chat-drawer-right', chatDrawerSide === 'right');
	const nextSide = chatDrawerSide === 'left' ? 'right' : 'left';
	const sideLabel = `Move chat sidebar to the ${nextSide}`;
	drawerSideToggle.title = sideLabel;
	drawerSideToggle.setAttribute('aria-label', sideLabel);
	drawerSideToggle.replaceChildren(icon(`arrow-${nextSide}`));
	const label = chatDrawerCollapsed ? 'Expand chat sidebar' : 'Collapse chat sidebar';
	drawerToggle.title = label;
	drawerToggle.setAttribute('aria-label', label);
	drawerToggle.setAttribute('aria-expanded', String(!chatDrawerCollapsed));
	const toggleDirection = chatDrawerCollapsed ? nextSide : chatDrawerSide;
	drawerToggle.replaceChildren(icon(`chevron-${toggleDirection}`));
	// The narrow strip remains horizontal regardless of the drawer preference.
	tabStrip.setAttribute('aria-label', wideChat.matches ? 'Chat sidebar' : 'Open chats');
	if (wideChat.matches) {
		requestAnimationFrame(() => tabNodes.get(state?.activeTab ?? '')?.root.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
	}
}
drawerSideToggle.addEventListener('click', () => {
	chatDrawerSide = chatDrawerSide === 'left' ? 'right' : 'left';
	updateChatDrawer();
	saveDraft();
});
drawerToggle.addEventListener('click', () => {
	chatDrawerCollapsed = !chatDrawerCollapsed;
	updateChatDrawer();
	saveDraft();
});
wideChat.addEventListener('change', () => {
	for (const { root } of tabNodes.values()) { tabResizeEnds.get(root)?.(); }
	updateChatDrawer();
});
updateChatDrawer();
const tabAdd = button([icon('add'), el('span', { class: 'tab-add-label', text: 'New chat' })], { class: 'ghost round tab-add', title: 'New chat' });
function chooseNewChatLocation(): void {
	openMenu(tabAdd, [
		{ icon: 'comment-discussion', label: 'Here in chat', run: () => post({ type: 'newTab', location: 'here' }) },
		{ icon: 'files', label: 'In a new tab', run: () => post({ type: 'newTab', location: 'tab' }) },
		{ icon: 'link-external', label: 'In a new window', run: () => post({ type: 'newTab', location: 'window' }) },
	], 'Open new chat');
}
tabAdd.addEventListener('click', () => post({ type: 'newTab', location: 'here' }));
const tabConfirm = el('div', { class: 'tab-confirm' });
/** The first click of a possible double-click, by tab; see the label's click handler. */
let firstClick: { readonly id: string; readonly at: number } | undefined;
const doubleClickMs = 600;
tabConfirm.hidden = true;
let confirmShown = '';
let frontTab: string | undefined;
let draggedChatTab: { id: string; draft: string } | undefined;
let chatTabDragEnded = -Infinity;

function clearTabDropMarks(): void {
	for (const { root } of tabNodes.values()) { root.classList.remove('drop-before', 'drop-after'); }
}

/** Reordering follows the visible list's axis. */
function tabDropAfter(event: DragEvent, rect: DOMRect): boolean {
	return wideChat.matches ? event.clientY >= rect.top + rect.height / 2 : event.clientX >= rect.left + rect.width / 2;
}

function makeTabDraggable(node: TabNode): void {
	const { root } = node;
	root.draggable = true;
	root.addEventListener('dragstart', event => {
		if (!event.dataTransfer || editingTab || node.close.contains(event.target as Node)) { event.preventDefault(); return; }
		saveDraft();
		draggedChatTab = { id: node.tab.id, draft: node.tab.id === draftTab ? currentDraft() : drafts[node.tab.chatId] ?? '' };
		event.dataTransfer.effectAllowed = 'move';
		event.dataTransfer.setData(chatTabDragType, JSON.stringify({ source: state?.surfaceId, id: node.tab.id, token: state?.dragToken }));
		post({ type: 'beginTabDrag', id: node.tab.id, draft: draggedChatTab.draft });
		root.classList.add('dragging');
		closePopups();
	});
	root.addEventListener('dragover', event => {
		if (!draggedChatTab) { return; }
		event.preventDefault();
		event.stopPropagation();
		if (event.dataTransfer) { event.dataTransfer.dropEffect = 'move'; }
		clearTabDropMarks();
		const rect = root.getBoundingClientRect();
		if (draggedChatTab.id !== node.tab.id) { root.classList.add(tabDropAfter(event, rect) ? 'drop-after' : 'drop-before'); }
		const bounds = tabRow.getBoundingClientRect();
		if (wideChat.matches) {
			if (event.clientY < bounds.top + 24) { tabRow.scrollTop -= 12; }
			if (event.clientY > bounds.bottom - 24) { tabRow.scrollTop += 12; }
		} else {
			if (event.clientX < bounds.left + 24) { tabRow.scrollLeft -= 12; }
			if (event.clientX > bounds.right - 24) { tabRow.scrollLeft += 12; }
		}
	});
	root.addEventListener('dragleave', () => root.classList.remove('drop-before', 'drop-after'));
	root.addEventListener('drop', event => {
		if (!draggedChatTab) { return; }
		event.preventDefault();
		event.stopPropagation();
		if (draggedChatTab.id !== node.tab.id) {
			const rect = root.getBoundingClientRect();
			post({ type: 'placeTab', id: draggedChatTab.id, target: node.tab.id, after: tabDropAfter(event, rect) });
		}
		clearTabDropMarks();
	});
	root.addEventListener('dragend', () => {
		draggedChatTab = undefined;
		chatTabDragEnded = performance.now();
		root.classList.remove('dragging');
		clearTabDropMarks();
	});
}

tabRow.addEventListener('dragover', event => {
	if (!draggedChatTab) { return; }
	event.preventDefault();
	if (event.dataTransfer) { event.dataTransfer.dropEffect = 'move'; }
});
tabRow.addEventListener('drop', event => {
	if (!draggedChatTab) { return; }
	event.preventDefault();
	const last = state?.tabs.at(-1);
	if (last && last.id !== draggedChatTab.id) { post({ type: 'placeTab', id: draggedChatTab.id, target: last.id, after: true }); }
	clearTabDropMarks();
});
// Cross-webview drags carry an opaque token; the source host retains the draft.
app.addEventListener('dragover', event => {
	if (draggedChatTab || !event.dataTransfer?.types.includes(chatTabDragType)) { return; }
	event.preventDefault();
	event.dataTransfer.dropEffect = 'move';
	app.classList.add('receiving-chat-tab');
});
app.addEventListener('dragleave', event => {
	if (!event.relatedTarget || !app.contains(event.relatedTarget as Node)) { app.classList.remove('receiving-chat-tab'); }
});
app.addEventListener('drop', event => {
	app.classList.remove('receiving-chat-tab');
	if (draggedChatTab || !event.dataTransfer?.types.includes(chatTabDragType)) { return; }
	event.preventDefault();
	event.stopPropagation();
	const transfer = parseChatTabTransfer(event.dataTransfer.getData(chatTabDragType));
	if (transfer) { post({ type: 'acceptTabDrop', ...transfer }); }
});



function renderTabs(s: ChatViewState): void {
	if (closingTab && !s.tabs.some(t => t.id === closingTab && (t.busy || t.queued || t.skillRuns))) {
		closingTab = undefined;
	}
	if (editingTab && !s.tabs.some(t => t.id === editingTab)) {
		editingTab = undefined;
	}
	if (!tabStrip.contains(tabRow)) {
		tabStrip.replaceChildren(drawerHeader, tabRow, tabConfirm, drawerFooter);
	}
	const open = new Set(s.tabs.map(t => t.id));
	for (const [id, node] of tabNodes) {
		if (!open.has(id)) {
			if (draggedChatTab?.id === id) { draggedChatTab = undefined; chatTabDragEnded = performance.now(); }
			node.root.remove();
			tabNodes.delete(id);
		}
	}
	const switching = frontTab !== undefined && s.activeTab !== frontTab;
	const tabsBefore = switching ? tabWidths() : undefined;
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
		node.root.classList.toggle('chrome-mirrored', t.chrome === true);
		node.label.setAttribute('aria-current', t.id === s.activeTab ? 'page' : 'false');
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
	if (tabsBefore && frontTab) {
		animateTabSwitch(tabsBefore, [frontTab, s.activeTab]);
	}
	if (s.activeTab !== frontTab) {
		frontTab = s.activeTab;
		// After the width has settled, or it scrolls to where the tab was going.
		setTimeout(() => tabNodes.get(s.activeTab)?.root.scrollIntoView({ block: 'nearest', inline: 'nearest' }), 340);
	}
}

function tabWidths(): Map<string, number> {
	const widths = new Map<string, number>();
	for (const [id, node] of tabNodes) {
		if (node.root.isConnected) { widths.set(id, node.root.getBoundingClientRect().width); }
	}
	return widths;
}

/** Ends a tab's switch animation early, letting go of its held width. */
const tabResizeEnds = new WeakMap<HTMLElement, () => void>();

/**
 * The tab left and the tab chosen change width together: each is held at the
 * width it had, then both are let go to their new width in the same frame, with
 * one linear transition. Transitioning the CSS limits instead clamped each tab
 * against its own title at a different moment, so the two moved out of step.
 */
function animateTabSwitch(before: Map<string, number>, ids: string[]): void {
	const nodes = ids.map(id => ({ id, root: tabNodes.get(id)?.root }))
		.filter((n): n is { id: string; root: HTMLElement } => !!n.root?.isConnected);
	// A switch still under way gives up its held widths first, so both are measured free.
	for (const { root } of nodes) { tabResizeEnds.get(root)?.(); }
	if (wideChat.matches || matchMedia('(prefers-reduced-motion: reduce)').matches) { return; }
	const moving = nodes.flatMap(({ id, root }) => {
		const from = before.get(id);
		const to = root.getBoundingClientRect().width;
		return from === undefined || Math.abs(from - to) < 0.5 ? [] : [{ root, from, to }];
	});
	for (const { root, from } of moving) {
		const style = root.style;
		style.transition = 'none';
		style.flexShrink = '0';
		// The limits do not transition, so they are lifted while the width moves.
		style.minWidth = '0';
		style.maxWidth = 'none';
		style.width = `${from}px`;
	}
	void tabRow.offsetWidth; // the held widths are laid out before the transition starts
	for (const { root, to } of moving) {
		const style = root.style;
		root.classList.add('resizing');
		style.transition = '';
		style.width = `${to}px`;
		const end = (): void => {
			root.removeEventListener('transitionend', onEnd);
			clearTimeout(timer);
			tabResizeEnds.delete(root);
			root.classList.remove('resizing');
			style.transition = style.width = style.minWidth = style.maxWidth = style.flexShrink = '';
		};
		const onEnd = (event: TransitionEvent): void => {
			if (event.target === root && event.propertyName === 'width') { end(); }
		};
		const timer = setTimeout(end, 400);
		root.addEventListener('transitionend', onEnd);
		tabResizeEnds.set(root, end);
	}
}

function tabShown(t: ChatTabSummary, agent: string | undefined): string {
	return JSON.stringify([t.title, t.status, t.agents, t.skillRuns, t.busy, agent, t.chrome]);
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
	const compactNumber = nextCompactTabNumber++;
	root.style.setProperty('--tab-identity', `hsl(${(compactNumber * 137.508) % 360} 55% 67%)`);
	const node: TabNode = { root, label, close, tab: t, shown: '', compactNumber };
	makeTabDraggable(node);
	root.addEventListener('contextmenu', event => {
		event.preventDefault();
		event.stopPropagation();
		const destinations = (state?.chatSurfaces ?? []).filter(surface => surface.id !== state?.surfaceId);
		const draft = () => {
			saveDraft();
			return node.tab.id === draftTab ? currentDraft() : drafts[node.tab.chatId] ?? '';
		};
		const items: MenuItem[] = state?.panel ? [] : [
			{ icon: 'link-external', label: 'Move to a new window', run: () => post({ type: 'moveTabToNew', id: node.tab.id, location: 'window', draft: draft() }) },
			{ icon: 'files', label: 'Move to a new tab', run: () => post({ type: 'moveTabToNew', id: node.tab.id, location: 'tab', draft: draft() }) },
		];
		items.push(...destinations.map(surface => ({
			icon: 'arrow-right', label: surface.label, description: surface.description,
			run: () => {
				saveDraft();
				post({ type: 'moveTabTo', id: node.tab.id, target: surface.id,
					draft: node.tab.id === draftTab ? currentDraft() : drafts[node.tab.chatId] ?? '' });
			},
		})));
		if (node.tab.canResumeInTerminal) {
			items.push({ icon: 'terminal', label: 'Continue in terminal', disabled: node.tab.busy || !!node.tab.queued || !!node.tab.skillRuns, run: () => post({ type: 'resumeInTerminal', id: node.tab.chatId }) });
		}
		const compact = wideChat.matches && chatDrawerCollapsed;
		if (compact) { items.push({ icon: 'close', label: 'Close chat', run: () => node.close.click() }); }
		openMenu(label, items.length ? items : [{ label: 'No other chat is open', disabled: true, run: () => {} }],
			compact ? node.tab.title : `Move chat to · ${(state?.chatSurfaces ?? []).length} open views`);
	});
	label.addEventListener('click', event => {
		if (performance.now() - chatTabDragEnded < 250) { return; }
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
	const compactMark = t.status === 'working' || t.status === 'waiting' ? tabMark(t.status)
		: icon(t.status === 'failed' ? 'error' : t.status === 'read' || t.status === 'unread' ? 'check' : 'comment');
	compactMark?.removeAttribute('title');
	const compact = el('span', { class: `tab-compact status-${t.status ?? 'new'}` },
		el('span', { class: 'tab-compact-number', text: String(node.compactNumber) }), compactMark);
	compact.setAttribute('aria-hidden', 'true');
	const parts: (HTMLElement | undefined)[] = [
		compact,
		tabMark(t.status),
		el('span', { class: 'tab-title', text: t.title }),
		agentsOf(t) ? el('span', { class: 'tab-agents', text: agentsOf(t) > 99 ? '99+' : String(agentsOf(t)), title: `${agentsOf(t)} agent${agentsOf(t) === 1 ? '' : 's'} working` }) : undefined,
	];
	node.label.replaceChildren(...parts.filter((p): p is HTMLElement => !!p));
	const description = `${agent ? `${t.title} — ${agent}` : t.title}\n${t.status ? tabMarks[t.status] : 'New chat'}${agentsOf(t) ? ` · ${agentsOf(t)} agent${agentsOf(t) === 1 ? '' : 's'} running` : ''}${t.chrome ? ' · open in Google Chrome' : ''}`;
	node.label.setAttribute('aria-label', description);
	node.label.title = `${description}\nDouble-click to rename. Drag to reorder. Right-click for chat actions.`;
	node.close.title = t.busy ? 'Close (stops what it is doing)' : 'Close';
}

/**
 * Renaming in place: Enter or a click elsewhere keeps the name, Escape keeps
 * the old one. An empty name changes nothing. The label shows the new name at
 * once, so it does not flick back for the 40 ms until the host's state says so.
 */
function startRename(node: TabNode): void {
	if (wideChat.matches && chatDrawerCollapsed) {
		chatDrawerCollapsed = false; updateChatDrawer(); saveDraft();
	}
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
	if (closing && wideChat.matches && chatDrawerCollapsed) {
		chatDrawerCollapsed = false; updateChatDrawer(); saveDraft();
	}
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
 * The mark in front of a tab's title: a CSS orbit spinner while it works,
 * a green dot for work
 * finished out of sight, an orange one for work that ended in an error, and
 * nothing once it is finished and read — nor before the first message. A tab whose
 * agent waits for an approval shows a pulsing warning ring instead of the spinner: the
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
let turnNodes: { root: HTMLElement; summary: HTMLElement; rows: HTMLElement; tail: HTMLElement }[] = [];
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

let stickyFrame = 0;
/** Shrinks each prompt stuck over its reply in step with the scroll, from its
 *  whole height down to four lines; the room it lost is given to what follows it in the turn so the rows
 *  below stay put (chat.css, `.prompt.shrunk`). */
function fitStickyPrompts(): void {
	stickyFrame = 0;
	const top = thread.getBoundingClientRect().top;
	for (const prompt of thread.querySelectorAll<HTMLElement>('.prompt')) {
		if (prompt === openedPrompt) {
			continue;
		}
		const content = prompt.querySelector<HTMLElement>('.prompt-content');
		const turn = prompt.parentElement;
		if (!content || !turn) {
			continue;
		}
		const full = content.scrollHeight;
		// Four whole lines of the text, whatever sits above it (attachments),
		// so the last of them is never cut.
		const text = content.querySelector<HTMLElement>('.bubble-text');
		const lineOf = (node: HTMLElement) => parseFloat(getComputedStyle(node).lineHeight) || 18;
		const min = Math.min(full, text
			? text.offsetTop - content.offsetTop + lineOf(text) * 4
			: lineOf(content) * 4);
		const scrolled = Math.max(0, top - turn.getBoundingClientRect().top);
		const height = Math.max(min, full - scrolled);
		prompt.classList.toggle('compact', height < full && height <= min + 0.5);
		if (height >= full) {
			prompt.classList.remove('shrunk');
			content.style.maxHeight = '';
			turn.style.removeProperty('--prompt-room');
		} else {
			prompt.classList.add('shrunk');
			content.style.maxHeight = `${height}px`;
			turn.style.setProperty('--prompt-room', `${full - height}px`);
		}
	}
}
function scheduleStickyPrompts(): void {
	if (!stickyFrame) {
		stickyFrame = requestAnimationFrame(fitStickyPrompts);
	}
}
// Fitted in the scroll event itself, not a frame later: a frame behind, the
// prompt and the rows under it were out of step while the scroll was fast.
thread.addEventListener('scroll', fitStickyPrompts, { passive: true });

/** A prompt down to its four lines, opened by a click to at most half the
 *  thread's height over the rows under it; the margin keeps the rows where they
 *  were. It closes on a click elsewhere, or 3 s after the pointer leaves it; the wheel scrolls it alone, never the chat
 *  behind it. */
let openedPrompt: HTMLElement | undefined;
/** The open message closes by itself 3 s after the pointer leaves it. */
let promptLeaveTimer: ReturnType<typeof setTimeout> | undefined;
function cancelPromptLeave(): void {
	if (promptLeaveTimer !== undefined) {
		clearTimeout(promptLeaveTimer);
		promptLeaveTimer = undefined;
	}
}
function openPrompt(prompt: HTMLElement): void {
	const content = prompt.querySelector<HTMLElement>('.prompt-content');
	if (!content) {
		return;
	}
	collapsePrompt();
	const full = content.scrollHeight;
	const height = Math.min(full, thread.clientHeight / 2);
	openedPrompt = prompt;
	prompt.classList.add('open');
	content.style.maxHeight = `${height}px`;
	prompt.parentElement?.style.setProperty('--prompt-room', `${full - height}px`);
	content.scrollTop = 0;
}
function collapsePrompt(): void {
	cancelPromptLeave();
	const prompt = openedPrompt;
	if (!prompt) {
		return;
	}
	openedPrompt = undefined;
	prompt.classList.remove('open');
	const content = prompt.querySelector<HTMLElement>('.prompt-content');
	if (content) {
		content.scrollTop = 0;
	}
	fitStickyPrompts();
}
document.addEventListener('mousedown', event => {
	if (openedPrompt && !openedPrompt.contains(event.target as Node)) {
		collapsePrompt();
	}
}, true);
window.addEventListener('resize', scheduleStickyPrompts);

function renderThread(s: ChatViewState): void {
	scheduleStickyPrompts();
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
			const summary = el('div', { class: 'turn-summary' });
			const rows = el('div', { class: 'rows' });
			const tail = el('div', { class: 'turn-tail' });
			root.append(summary, rows, tail);
			threadInner.append(root);
			nodes = turnNodes[t] = { root, summary, rows, tail };
		}
		// Minimal: the turn's work folds under its summary line unless opened.
		const folded = s.viewMode === 'minimal' && turn.prompt >= 0
			&& turn.rows.some(i => isBackground(s.entries[i])) && !toggled.get(turnKey(turn));
		nodes.root.classList.toggle('minimal-folded', folded);
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
		for (const i of turn.rows) {
			rendered[i]?.node.classList.toggle('background', isBackground(s.entries[i]));
		}
		renderSummary(nodes.summary, s, turn, t === lastTurn);
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
	const shown = JSON.stringify([s.pendingSends, s.queuePaused, s.activeTab]);
	if (shown === pendingShown) {
		return;
	}
	pendingShown = shown;
	// Held by `chat_pause`: said above the queue, or nothing would say why it
	// does not go out. Shown with an empty queue too — a message queued now waits.
	const paused: HTMLElement[] = [];
	if (s.queuePaused) {
		const tabId = s.activeTab;
		const resume = button([icon('debug-continue'), el('span', { text: 'Resume' })], { class: 'pending-resume', title: 'Send what is queued once the tab is idle' });
		resume.addEventListener('click', () => post({ type: 'resumeQueue', tabId }));
		paused.push(el('div', { class: 'pending-note queue-paused' }, icon('debug-pause'),
			el('span', { text: `Queue paused by ${s.queuePaused.by} — nothing queued goes out until it is resumed` }), resume));
	}
	pendingBox.replaceChildren(...paused, ...s.pendingSends.map(p => {
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
	return entry.kind === 'user' ? `${JSON.stringify(entry)}|${commandsSignature}|${fileIconsSignature}`
		: `${JSON.stringify(entry)}|${toggled.get(keyOf(entry, i)) ?? ''}|${openByDefault()}|${fileIconsSignature}`;
}

/** The commands the marks are drawn from, as one string; set at the top of every render. */
let commandsSignature = '';

function keyOf(entry: ChatEntry, i: number): string {
	return entry.kind === 'tool' ? `tool:${entry.id}` : entry.kind === 'approval' ? `approval:${entry.id}` : `${entry.kind}:${i}`;
}

/**
 * Minimal mode's split of a turn: the replies, errors, notices and a question
 * still waiting stay in view; tool calls, thinking and answered approvals are
 * the turn's work, folded under its summary line.
 */
function isBackground(entry: ChatEntry | undefined): boolean {
	return entry?.kind === 'tool' || entry?.kind === 'thinking' || (entry?.kind === 'approval' && entry.status !== 'pending');
}

function turnKey(turn: Turn): string {
	return `turn:${turn.prompt}`;
}

function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

/**
 * Minimal mode's line under a prompt (asked for): how much work the turn did —
 * tool calls, agents, thinking, approvals, and its tokens once it ends — with
 * a chevron; a click opens that turn as Compact shows it, another folds it
 * back. While the turn runs, a second line under it names the latest piece of
 * work, the way its own row would title it, and is replaced by the next. The
 * button is built once and its text set in place, so a post between a press
 * and its release does not lose the click (#365).
 */
function renderSummary(box: HTMLElement, s: ChatViewState, turn: Turn, last: boolean): void {
	const work = s.viewMode === 'minimal' && turn.prompt >= 0
		? turn.rows.map(i => s.entries[i]).filter(isBackground) : [];
	if (!work.length) {
		if (box.firstChild) {
			box.replaceChildren();
			delete box.dataset.sig;
		}
		return;
	}
	const tools = work.filter((e): e is ToolEntry => e.kind === 'tool');
	const agents = tools.filter(t => t.tool === 'agent').length;
	const calls = tools.length - agents;
	const thoughts = work.filter(e => e.kind === 'thinking').length;
	const approvals = work.filter(e => e.kind === 'approval').length;
	const prompt = s.entries[turn.prompt];
	const parts = [
		calls && plural(calls, 'tool call'),
		agents && plural(agents, 'agent'),
		thoughts && plural(thoughts, 'thought'),
		approvals && plural(approvals, 'approval'),
		prompt?.kind === 'user' && prompt.tokensIn !== undefined && `↑ ${compact(prompt.tokensIn)} ↓ ${compact(prompt.tokensOut ?? 0)}`,
	].filter(Boolean).join(' · ');
	const open = toggled.get(turnKey(turn)) === true;
	const running = last && s.running;
	let head = box.querySelector<HTMLButtonElement>(':scope > .turn-summary-head');
	if (!head) {
		head = button([icon('chevron-right', 'chevron'), el('span', { class: 'turn-summary-text' })], { class: 'turn-summary-head' });
		head.addEventListener('click', () => {
			const key = box.dataset.key;
			if (key) {
				toggled.set(key, toggled.get(key) !== true);
				render();
			}
		});
		box.replaceChildren(head);
	}
	box.dataset.key = turnKey(turn);
	box.classList.toggle('open', open);
	head.setAttribute('aria-expanded', String(open));
	head.title = open ? 'Fold this message\'s work' : 'Show this message\'s tool calls and thinking';
	const text = head.querySelector('.turn-summary-text')!;
	if (text.textContent !== parts) {
		text.textContent = parts;
	}
	// The latest piece of work, while the turn runs and its work is folded.
	const latest = running && !open ? work[work.length - 1] : undefined;
	const sig = latest ? JSON.stringify(latest.kind === 'thinking' ? [latest.kind, latest.endedAt === undefined] : latest) : '';
	if (box.dataset.sig === sig) {
		return;
	}
	box.dataset.sig = sig;
	box.querySelector(':scope > .turn-summary-now')?.remove();
	if (!latest) {
		return;
	}
	const now = el('div', { class: 'turn-summary-now' });
	if (latest.kind === 'tool') {
		// Plain colour, never the shimmer: `background-clip: text` draws nothing
		// inside a parent that clips for its ellipsis (#360).
		now.append(icon(toolIcons[latest.tool], 'tool-icon'), el('span', {}, ...toolTitle(latest)));
	} else if (latest.kind === 'thinking') {
		const active = latest.endedAt === undefined;
		now.append(icon('lightbulb', 'tool-icon'), el('span', { text: active ? 'Thinking' : `Thought for ${duration((latest.endedAt ?? latest.startedAt) - latest.startedAt)}` }));
	} else if (latest.kind === 'approval') {
		now.append(icon('shield', 'tool-icon'), el('span', { text: latest.title }));
	}
	// The file name in a title is a link elsewhere; here the line is only a label.
	for (const link of now.querySelectorAll('.file-link')) {
		link.classList.remove('file-link');
	}
	box.append(now);
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
	// The model that answered, when it is not the one picked — what Gemini's Auto chose.
	const models = Array.isArray(p?.models) ? p.models.filter(m => typeof m === 'string').join(', ') : '';
	// The turn is over and agents it (or an earlier one) started still work:
	// said at the very bottom, under "Worked for …" (asked for).
	const runningAgents = last ? agentRows(s).filter(a => a.status === 'running') : [];
	const agents = runningAgents.length;
	// How long the background work has gone on: since the first of them started.
	const agentsSince = agents ? Math.min(...runningAgents.map(a => a.startedAt)) : 0;
	const sig = `${text}|${tokens}|${models}|${agents}|${agentsSince}`;
	if (tail.dataset.sig !== sig) {
		tail.dataset.sig = sig;
		// A square where the working star was: the same slot, so the line does
		// not shift when the turn ends.
		tail.replaceChildren(
			text
				? el('div', { class: 'worked' },
					el('span', { class: 'working-glyph done', text: '■' }),
					el('span', { class: 'worked-text', text }),
					models ? el('span', { class: 'worked-model', text: models, title: `Answered by ${models} — the model chosen for this turn` }) : undefined,
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
	if (reducedMotion.matches || (!workingNode && !agentsLine)) {
		return;
	}
	glyphAt = (glyphAt + 1) % glyphs.length;
	for (const glyph of [workingNode?.querySelector('.working-glyph'), agentsLine]) {
		if (glyph) {
			glyph.textContent = glyphs[glyphAt];
		}
	}
}, 120);

/**
 * The empty chat: what AI Browser is, and what is new. Both come from NEWS.md
 * in the installed extension (`news` in the state) — the introduction as the
 * lead, the newest entries in a dialog opened by a link — so the text is edited
 * in that file, not here. Until it has been read, or if it cannot be, the welcome
 * says what the agents can do with what is available.
 */
function showChromeInstall(trigger: HTMLElement): void {
	const heading = el('h2', { class: 'news-dialog-title', text: 'Install AI Browser for Chrome' });
	heading.id = 'chrome-install-title';
	const close = button([icon('close')], { class: 'ghost round', title: 'Close installation guide' });
	close.setAttribute('aria-label', 'Close installation guide');
	const steps = el('ol', { class: 'news-items' });
	for (const text of [
		'Download the ZIP and extract it to a folder you will keep.',
		'Open chrome://extensions in Chrome and enable Developer mode.',
		'Click Load unpacked and select the extracted folder containing manifest.json.',
		'Open AI Browser from Chrome’s Extensions menu and click Connect.',
		'Click Allow in your VS Code chat. If several editor windows are open, choose one in Chrome first.',
	]) { steps.append(el('li', { text })); }
	const dialog = el('dialog', { class: 'news-dialog' },
		el('div', { class: 'news-dialog-header' }, heading, close),
		el('div', { class: 'news' }, steps));
	dialog.setAttribute('aria-labelledby', heading.id);
	close.addEventListener('click', () => dialog.close());
	dialog.addEventListener('click', event => {
		const bounds = dialog.getBoundingClientRect();
		if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right
			|| event.clientY < bounds.top || event.clientY > bounds.bottom)) { dialog.close(); }
	});
	dialog.addEventListener('close', () => {
		dialog.remove();
		if (trigger.isConnected) { trigger.focus(); }
	}, { once: true });
	document.body.append(dialog);
	dialog.showModal();
}

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
		: s.detecting ? 'Looking for Claude Code, Codex and Gemini CLI…' : 'No agent is available yet.' }));
	for (const agent of s.agents.filter(a => !a.available && a.problem)) {
		box.append(el('div', { class: 'welcome-problem', text: `${agent.name}: ${agent.problem}` }));
	}
	if (s.news?.features?.length) {
		// What is worth trying first, between the hint and the changelog link.
		const list = el('ul', { class: 'welcome-features' });
		for (const feature of s.news.features) {
			const text = el('span', { class: 'welcome-feature-text' });
			inline(text, feature.text);
			if (feature.title === 'Chrome extension') {
				// ZIP downloads belong in the system browser.
				for (const link of text.querySelectorAll<HTMLElement>('[role="link"]')) {
					const url = link.title.split('\n')[0];
					if (!/^https:\/\/github\.com\/Denis-Davidoff\/vs-code-tab-browser-ultimate\/raw\/.+\.zip$/.test(url)) { continue; }
					link.title = 'Download Chrome extension ZIP';
					link.classList.add('welcome-feature-link');
					const download = (event: Event) => {
						event.preventDefault();
						event.stopImmediatePropagation();
						post({ type: 'openLink', url, external: true });
					};
					link.addEventListener('click', download, { capture: true });
					link.addEventListener('keydown', event => {
						if (event.key === 'Enter') { download(event); }
					}, { capture: true });
				}
				const install = button(['How to install'], { class: 'welcome-feature-link' });
				install.setAttribute('aria-haspopup', 'dialog');
				install.addEventListener('click', () => showChromeInstall(install));
				text.append(' ', install);
			}
			list.append(el('li', { class: 'welcome-feature' },
				icon(/^[a-z0-9-]+$/.test(feature.icon) ? feature.icon : 'star', 'welcome-feature-icon'),
				el('span', {},
					el('span', { class: 'welcome-feature-title', text: feature.title }),
					el('span', { text: ' — ' }),
					text)));
		}
		box.append(list);
	}
	if (s.news?.entries.length) {
		const link = el('a', { class: 'news-toggle', text: 'Show changelog' });
		link.href = '#changelog';
		link.setAttribute('aria-haspopup', 'dialog');
		link.addEventListener('click', event => {
			event.preventDefault();
			const heading = el('h2', { class: 'news-dialog-title', text: "What's new" });
			heading.id = 'changelog-title';
			const close = button([icon('close')], { class: 'ghost round', title: 'Close changelog' });
			close.setAttribute('aria-label', 'Close changelog');
			const news = el('div', { class: 'news' });
			for (const entry of s.news!.entries) {
				const items = el('ul', { class: 'news-items' });
				for (const item of entry.items) {
					const li = el('li');
					inline(li, item);
					items.append(li);
				}
				news.append(el('div', { class: 'news-entry' }, el('div', { class: 'news-title', text: entry.title }), items));
			}
			const dialog = el('dialog', { class: 'news-dialog' },
				el('div', { class: 'news-dialog-header' }, heading, close), news);
			dialog.setAttribute('aria-labelledby', heading.id);
			close.addEventListener('click', () => dialog.close());
			dialog.addEventListener('click', event => {
				const bounds = dialog.getBoundingClientRect();
				if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right
					|| event.clientY < bounds.top || event.clientY > bounds.bottom)) {
					dialog.close();
				}
			});
			dialog.addEventListener('close', () => {
				dialog.remove();
				if (link.isConnected) { link.focus(); }
			}, { once: true });
			document.body.append(dialog);
			dialog.showModal();
		});
		box.append(link);
	}
	return box;
}

/**
 * "Ask another agent", beside a reply's copy button: one agent and model, and
 * the question this reply answers goes to it in a new tab. Another opinion is
 * another press. The conversation's own agent and model are not offered —
 * they gave this answer. Every reply has it, while the turn runs too: what is
 * sent is the question, not the reply.
 */
function opinionButton(index: number): HTMLButtonElement {
	const b = button([icon('comment-discussion')], { class: 'copy-button message-copy opinion-button', title: 'Ask another agent — in a new tab' });
	b.setAttribute('aria-label', 'Ask another agent');
	b.addEventListener('click', event => {
		event.stopPropagation();
		const s = state;
		if (!s) {
			return;
		}
		const items: MenuItem[] = [];
		for (const agent of s.agents.filter(a => a.available)) {
			for (const model of agent.models) {
				const own = agent.id === s.selection.agent && model.id === s.selection.model;
				items.push({
					icon: agent.id === 'claude' ? 'sparkle' : agent.id === 'gemini' ? 'star-full' : 'hubot',
					label: `${agent.name} · ${model.label}`,
					description: own ? 'This conversation' : undefined,
					disabled: own,
					run: () => post({ type: 'secondOpinion', chatId: s.chatId, index, agent: agent.id, model: model.id }),
				});
			}
		}
		if (!items.length) {
			items.push({ label: s.detecting ? 'Looking for agents…' : 'No agent is available', disabled: true, run: () => { } });
		}
		openMenu(b, items, 'Ask another agent — opens a new tab');
	});
	return b;
}

function entryNode(entry: ChatEntry, i: number): HTMLElement {
	switch (entry.kind) {
		case 'user':
			return promptNode(entry);
		case 'assistant': {
			// Copies the reply as it came, Markdown and all; shown on hover.
			const copy = copyButton(() => entry.text, 'Copy reply');
			copy.classList.add('message-copy');
			const opinion = opinionButton(i);
			// Beside the Markdown, not in it: as its last child the button took the
			// `.markdown > :last-child` rule, and every reply kept its last block's
			// bottom margin.
			return el('div', { class: 'row assistant' }, el('div', { class: 'markdown' }, renderMarkdown(entry.text)), opinion, copy);
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
	chat: { icon: 'comment-discussion', ask: 'Control the chat?' },
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
	{ key: 'chat', label: 'Chat control', hint: 'Stopping an agent, pausing a chat\'s queue, keeping the computer awake' },
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

/** A uniform mode shows its name; mixed modes show counts in Auto / Ask / Deny order. */
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
	const uniform = counts.length === 1;
	const text = counts.map(item => uniform ? item.label : `${item.label} ${item.count}`).join(' • ');
	const title = `Approvals — what the agents may do without asking:\n${rows.map(r => `${r.label}: ${modeLabels[modeOf(s, r.key)]}`).join('\n')}\nView mode: ${viewModeLabels[s.viewMode]}\nClick to change: Auto runs it, Ask asks, Deny refuses.`;
	const shown = JSON.stringify([text, title]);
	if (approveToggle.dataset.shown !== shown) {
		approveToggle.dataset.shown = shown;
		const glyphs: Record<string, string> = { auto: 'zap', ask: 'question', deny: 'circle-slash' };
		const parts = counts.map(item => {
			const glyph = icon(glyphs[item.mode]); glyph.setAttribute('aria-hidden', 'true');
			return el('span', { class: `mode-group mode-${item.mode}`, title: `${item.label}: ${item.count}` },
				glyph, el('strong', { class: 'mode-count', text: uniform ? item.label : String(item.count) }));
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
			el('div', { class: 'approval-note', text: 'Auto runs it without asking, Deny refuses it without asking. For this project, in every tab. Your own Claude Code, Codex and Gemini CLI rules still decide first.' }),
			el('div', { class: 'approval-sep' }),
			viewModeRow());
		if (focused?.key) {
			approvalPopup.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused.key)}"][data-mode="${focused.mode}"]`)?.focus();
		}
	}
	for (const b of approvalPopup.querySelectorAll<HTMLElement>('.view-seg')) {
		const on = b.dataset.view === s.viewMode;
		b.classList.toggle('on', on);
		b.setAttribute('aria-pressed', String(on));
	}
	const modes = new Set(rows.map(r => modeOf(s, r.key)));
	const all: ApprovalMode | undefined = modes.size === 1 ? [...modes][0] : undefined;
	for (const b of approvalPopup.querySelectorAll<HTMLElement>('.mode-seg:not(.view-seg)')) {
		const current = b.dataset.key === 'all' ? all : modeOf(s, b.dataset.key ?? '');
		const on = current === b.dataset.mode;
		b.classList.toggle('on', on);
		b.setAttribute('aria-pressed', String(on));
	}
}

const viewModeLabels: Record<ChatViewMode, string> = { minimal: 'Minimal', compact: 'Compact', standard: 'Standard' };
const viewModeHints: Record<ChatViewMode, string> = {
	minimal: 'Only your messages and the replies. Each message\'s tool calls and thinking fold under one line — click it to see them.',
	compact: 'Every tool call shown, folded — click a row to see its input and output.',
	standard: 'Every tool call shown unfolded, with its input and output.',
};

/**
 * View Mode — asked for, replacing the Compact switch: Minimal, Compact and
 * Standard. It is `aiBrowser.chat.viewMode`, written by the host, so the menu
 * and Settings agree; rows the user opened or closed keep that.
 */
function viewModeRow(): HTMLElement {
	const seg = (mode: ChatViewMode) => {
		const b = button([el('span', { text: viewModeLabels[mode] })], { class: 'mode-seg view-seg', title: viewModeHints[mode] });
		b.dataset.view = mode;
		b.setAttribute('aria-label', viewModeLabels[mode]);
		b.addEventListener('click', () => post({ type: 'setViewMode', mode }));
		return b;
	};
	const group = el('span', { class: 'mode-segs' }, seg('minimal'), seg('compact'), seg('standard'));
	group.setAttribute('role', 'group');
	group.setAttribute('aria-label', 'View mode');
	return el('div', { class: 'approval-row view-row', title: 'How much of the agents\' work the chat shows. The same as the View Mode setting.' },
		el('span', { class: 'approval-row-label', text: 'View Mode' }), group);
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
 * `.message.stickyHeader`. Shown whole in place; once stuck to the top it
 * shrinks with the scroll down to a four-line preview (`fitStickyPrompts`),
 * and hovering reveals the content in a bounded scroll area.
 */
function promptNode(entry: Extract<ChatEntry, { kind: 'user' }>): HTMLElement {
	const bubble = el('div', { class: 'bubble' });
	const content = el('div', { class: 'prompt-content' });
	content.tabIndex = 0;
	content.setAttribute('aria-label', 'Prompt and attachments');
	bubble.append(content);
	if (entry.attachments.length) {
		content.append(el('div', { class: 'bubble-attachments' },
			...entry.attachments.map((label, index) => {
				const file = entry.attachmentFiles?.[index];
				const kind = entry.attachmentKinds?.[index];
				const attachmentIconNode = (file ? themeFileIcon(file) : undefined) ?? (kind ? icon(attachmentIcon(kind)) : undefined);
				return el('span', { class: 'chip small', title: label }, attachmentIconNode, el('span', { class: 'chip-label', text: label }));
			})));
	}
	if (entry.text) {
		content.append(el('div', { class: 'bubble-text' }, ...withFileIcons(markCommands(entry.text, knownCommands(state)))));
		const copy = copyButton(() => entry.text, 'Copy prompt');
		copy.classList.add('message-copy');
		bubble.append(copy);
	}
	const prompt = el('div', { class: 'prompt' }, bubble);
	bubble.addEventListener('click', event => {
		if ((event.target as HTMLElement).closest('button') || !window.getSelection()?.isCollapsed) {
			return;
		}
		if (prompt === openedPrompt) {
			return;
		}
		if (prompt.classList.contains('compact')) {
			openPrompt(prompt);
		}
	});
	prompt.addEventListener('mouseenter', () => {
		if (prompt === openedPrompt) {
			cancelPromptLeave();
		}
	});
	prompt.addEventListener('mouseleave', () => {
		if (prompt === openedPrompt) {
			cancelPromptLeave();
			promptLeaveTimer = setTimeout(() => {
				if (prompt === openedPrompt) {
					collapsePrompt();
				}
			}, 3000);
		}
	});
	// overscroll-behavior holds the chat only while the text itself scrolls; an
	// open message that fits needs the wheel stopped here.
	content.addEventListener('wheel', event => {
		if (prompt === openedPrompt && content.scrollHeight <= content.clientHeight) {
			event.preventDefault();
		}
	}, { passive: false });
	return prompt;
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
	const link = el('span', { class: 'subject file-link', title: `${file}\nClick to open` }, themeFileIcon(basename(file)), basename(file));
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
	/** One frame per indentation level: nested lists attach to the preceding item at that level. */
	const listFrames: { indent: number; list: HTMLElement; parentItem?: HTMLElement; lastItem: HTMLElement; lastNumber?: number }[] = [];

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
		listFrames.length = 0;
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
			inline(li, bullet[3].trim());
			// Codex and other Markdown streams indent nested markers by two or four
			// spaces. Clamp skipped indentation to one level so mixed conventions
			// still produce the hierarchy instead of flattening descendants.
			const spaces = bullet[1].replace(/\t/g, '    ').length;
			const requestedIndent = Math.floor(spaces / 2);
			let indent = Math.min(requestedIndent, listFrames.length);
			// Some streams add indentation before a numbered sibling. At any depth,
			// keep a continuing number beside its sibling instead of opening a
			// spurious nested list.
			if (ordered && listFrames.length > 0 && requestedIndent >= listFrames.length) {
				const previous = listFrames[listFrames.length - 1];
				if ((previous.list.tagName === 'OL') && previous.lastNumber === parseInt(bullet[2], 10) - 1) {
					indent = listFrames.length - 1;
				}
			}
			listFrames.length = Math.min(listFrames.length, indent + 1);
			const parentItem = indent > 0 ? listFrames[indent - 1]?.lastItem : undefined;
			let frame = listFrames[indent];
			if (!frame || (frame.list.tagName === 'OL') !== ordered || frame.parentItem !== parentItem) {
				const target = newList(ordered, bullet[2]);
				if (parentItem) {
					parentItem.append(target);
				} else {
					out.append(target);
				}
				frame = { indent, list: target, parentItem, lastItem: li };
				listFrames[indent] = frame;
			}
			frame.list.append(li);
			frame.lastItem = li;
			if (ordered) { frame.lastNumber = parseInt(bullet[2], 10); }
			else { delete frame.lastNumber; }
			continue;
		}
		if (!line.trim()) {
			// Blank lines are allowed between Markdown list items and must not
			// reset the parent item needed to attach the next nested level.
			if (!listFrames.length) { flush(); }
			continue;
		}
		listFrames.length = 0;
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
			// `src/a.ts` is how replies name files; the icon goes before the code.
			const name = match[2].trim();
			const fileIcon = fileIconTable && namesFile(fileIconTable, name, true) ? themeFileIcon(name) : undefined;
			parent.append(...(fileIcon ? [fileIcon] : []), el('code', { text: match[2] }));
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
				const local = localFileLink(destination);
				const fileIcon = local ? themeFileIcon(local.path) : undefined;
				if (fileIcon) { link.prepend(fileIcon); }
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
	const shown = JSON.stringify([
		s.attachments.map(c => [c.id, c.kind, c.label, c.reference, c.thumbnail?.length]),
		s.suggestions.map(c => [c.id, c.kind, c.label]),
		fileIconsSignature,
	]);
	if (shown === attachmentsShown) {
		return;
	}
	attachmentsShown = shown;
	attachmentsRow.replaceChildren(...s.attachments.map(chip => {
		const remove = button([icon('close')], { class: 'chip-remove', title: 'Remove — an open file or page goes back to being a suggestion' });
		remove.addEventListener('click', () => post({ type: 'removeAttachment', id: chip.id }));
		let thumb: HTMLElement = chipIcon(chip);
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
		// The remove button leads, as the "+" of a suggestion does, so the two
		// read as one control that turns a chip on and off.
		const root = el('span', { class: 'chip' }, remove, insert, open, referenceButton);
		root.addEventListener('contextmenu', event => {
			event.preventDefault();
			openMenu(root, [
				{ icon: 'go-to-file', label: 'Open in tab', run: () => post({ type: 'openAttachment', id: chip.id }) },
				...(chip.kind === 'video' ? [{ icon: 'save', label: 'Save video as…', run: () => post({ type: 'saveAttachment', id: chip.id }) }] : []),
				{ icon: 'mention', label: 'Insert reference', description: reference, disabled: !reference,
					run: () => { if (reference) { insertAttachmentReference(reference); } } },
			], chip.label);
		});
		return root;
	}), ...s.suggestions.map(suggestionChip));
	attachmentsRow.hidden = !s.attachments.length && !s.suggestions.length;
}

/**
 * What could be attached and is not: the file or the browser tab the user has
 * open, dashed, with a "+" where an attached chip has its remove button. The
 * "+" attaches it; removing the attached chip brings the suggestion back.
 */
function suggestionChip(chip: AttachmentChip): HTMLElement {
	const what = chip.kind === 'sharedPage' ? 'the page open in the browser' : 'the file open in the editor';
	const add = button([icon('add')], { class: 'chip-remove chip-add', title: `Attach ${what}` });
	add.addEventListener('mousedown', event => event.preventDefault());
	add.addEventListener('click', () => post({ type: 'acceptSuggestion', id: chip.id }));
	return el('span', { class: 'chip suggested', title: `Suggested: ${chip.label} — press + to attach ${what}` },
		add, chipIcon(chip), el('span', { class: 'chip-label', text: chip.label }));
}

/**
 * A chip's icon: the file icon theme's for a chip that carries one file or
 * folder (`iconName` — a pasted image, a file attached from the "+" menu, the
 * Explorer or the folder list, a selection of a file), the kind's codicon for
 * the rest and wherever the theme has none.
 */
function chipIcon(chip: AttachmentChip): HTMLElement {
	return (chip.iconName ? themeFileIcon(chip.iconName) : undefined) ?? icon(attachmentIcon(chip.kind));
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
		case 'page': return 'globe';
		case 'sharedPage': return 'globe';
		case 'selection': return 'code';
		case 'file': return 'file';
		case 'voice': return 'mic';
		case 'video': return 'device-camera-video';
		case 'annotation': return 'comment';
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
	agentPill.title = `Agent — who answers: Claude Code, Codex or Gemini CLI${agent?.detail ? `\n${agent.name} ${agent.detail}` : ''}\nClick to pick another; the gear in its menu picks which installed copy.`;

	const model = agent?.models.find(m => m.id === s.selection.model);
	setPill(modelPill, model?.label ?? 'Model');
	modelPill.disabled = !agent?.models.length;
	modelPill.title = `Model — which of the agent's models answers${model?.description ? `\n${model.label}: ${model.description}` : ''}`;

	ultracodeBox.hidden = s.selection.agent !== 'claude' || s.selection.ultracode === undefined;
	ultracodeInput.checked = s.selection.ultracode === true;
	ultracodeBox.dataset.tip = `UltraCode: ${ultracodeInput.checked ? 'On' : 'Off'}\nLet Claude organize dynamic workflows and subagents at the selected effort. May use more of your plan. Requires Claude Code 2.1.284 or later. Changes apply to the next message once the current work finishes.`;
	if (hoverTip.anchor === ultracodeBox) { hoverTip.show(ultracodeBox); }
	const efforts = model?.efforts ?? [];
	effortBox.hidden = !efforts.length;
	if (efforts.length) {
		effortRange.max = String(efforts.length - 1);
		effortRange.value = String(Math.max(0, efforts.indexOf(s.selection.effort ?? '')));
		updateEffortAppearance(efforts[Number(effortRange.value)]);
	}
}

/** Fixed geometry: only the thumb colour and immediate tooltip change with effort. */
function updateEffortAppearance(effort: string): void {
	const label = labelOf(effort);
	effortRange.setAttribute('aria-valuetext', label);
	effortBox.dataset.effort = effort;
	effortBox.dataset.tip = `Effort: ${label}\nMore effort takes longer and uses more of your plan.`;
	if (hoverTip.anchor === effortBox) { hoverTip.show(effortBox); }
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
	return !pendingPasteCount && !!state && (state.detecting || state.agents.some(a => a.available));
}

/** Smooth colour landmarks: grey, white, green, yellow, orange, red. */
function contextColor(share: number | undefined): string {
	const stops: readonly [number, string][] = [
		[0, 'var(--fg-3)'], [0.25, 'var(--context-neutral, #eeeeee)'],
		[0.5, '#86bc88'], [0.75, '#dfcf70'], [0.9, '#e8a064'], [1, '#e27777'],
	];
	const value = share === undefined || !Number.isFinite(share) ? 0 : Math.max(0, Math.min(1, share));
	for (let i = 1; i < stops.length; i++) {
		const [end, to] = stops[i];
		const [start, from] = stops[i - 1];
		if (value <= end) {
			const percent = Math.round((value - start) / (end - start) * 100);
			return `color-mix(in srgb, ${from}, ${to} ${percent}%)`;
		}
	}
	return stops[stops.length - 1][1];
}

/**
 * A hollow ring whose arc fills clockwise from the top, with an optional mark
 * (a letter, a codicon) in its middle — `.ring-meter` in chat.css.
 */
function ringMeter(mark?: HTMLElement): HTMLElement {
	if (mark) {
		mark.classList.add('ring-mark');
	}
	return el('span', { class: 'ring-meter' }, ...(mark ? [mark] : []));
}

/** How much of the ring is drawn, 0 to 1; unknown draws the track alone. Set only when it changes. */
function setRingFill(ring: HTMLElement, share: number | undefined): void {
	const value = share === undefined || !Number.isFinite(share) ? 0 : Math.max(0, Math.min(1, share));
	const fill = `${Math.round(value * 1000) / 10}%`;
	if (ring.style.getPropertyValue('--fill') !== fill) {
		ring.style.setProperty('--fill', fill);
	}
}

/** The ring fills with context usage; unknown/compacted usage remains empty and grey. */
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
	setRingFill(contextPie, share);
	contextPie.style.setProperty('--ring-color', contextColor(share));
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

ultracodeInput.addEventListener('change', () => {
	if (!state || ultracodeBox.hidden) { return; }
	post({ type: 'select', selection: { ...state.selection, ultracode: ultracodeInput.checked } });
});

effortRange.addEventListener('input', () => {
	const s = state?.selection ?? {};
	const agent = state?.agents.find(a => a.id === s.agent);
	const efforts = agent?.models.find(m => m.id === s.model)?.efforts ?? [];
	const effort = efforts[Number(effortRange.value)];
	if (effort) {
		updateEffortAppearance(effort);
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
			effortBox.hidden, ultracodeBox.hidden, approveToggle.textContent,
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

input.addEventListener('paste', event => {
	if (!event.clipboardData || !state) { return; }
	const files = clipboardFiles(event.clipboardData);
	if (!files.length) { return; }
	event.preventDefault();
	const tabId = state.activeTab;
	const chatId = state.chatId;
	const text = event.clipboardData.getData('text/plain');
	if (text) {
		input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
		input.dispatchEvent(new Event('input', { bubbles: true }));
	}
	pendingPasteCount += files.length;
	pasteStatus.hidden = false;
	pasteStatus.textContent = 'Adding clipboard files…';
	renderSend();
	pasteQueue = pasteQueue.then(async () => {
		const errors: string[] = [];
		for (const file of files) {
			try {
				if (file.size > pastedFileLimit) { throw new Error(`${file.name}: files must be 64 MB or smaller.`); }
				const base64 = await fileBase64(file);
				const id = `paste-${++pasteSequence}`;
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(() => {
						pastedFileRequests.delete(id);
						reject(new Error(`${file.name}: attachment timed out.`));
					}, 120_000);
					pastedFileRequests.set(id, error => {
						clearTimeout(timer);
						pastedFileRequests.delete(id);
						error ? reject(new Error(`${file.name}: ${error}`)) : resolve();
					});
					post({ type: 'pasteFile', id, tabId, chatId, name: file.name, mime: file.type, base64 });
				});
			} catch (error) {
				errors.push(error instanceof Error ? error.message : String(error));
			} finally {
				pendingPasteCount--;
				renderSend();
			}
		}
		pasteStatus.textContent = errors.length ? errors.join(' ') : pendingPasteCount ? 'Adding clipboard files…' : '';
		pasteStatus.hidden = !pasteStatus.textContent;
	});
});

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

/* ---------------------------------------------------------------- voice messages */

/**
 * The recording as the view sees it. `starting`: asked for, the helper not recording yet;
 * `finishing`: stopped, the transcript on its way. A refusal is not a phase: it is shown
 * above the box (`voiceError`) and the view is idle again.
 */
type VoicePhase = 'idle' | 'starting' | 'recording' | 'limit' | 'finishing';
let voicePhase: VoicePhase = 'idle';
/** `finishing` after Space: the box is back to write in, and the bar is gone — only the button says it is transcribing. */
let voiceAttaching = false;
/** The helper is fetching the language's model; said when the recording ends, which may be before it is done. */
let voiceDownloading = false;
let voiceSeconds = 0;
let voiceLocale = '';
/** The newest levels, oldest first; as many as the bar has room for. */
let voiceLevels: number[] = [];
/** Escape before the helper had started: cancelled the moment it does. */
let voicePendingCancel = false;
/** Where the caret was when the recording ended: the transcript goes in there. */
let voiceCaret: number | undefined;
let voiceErrorTimer: ReturnType<typeof setTimeout> | undefined;

micButton.addEventListener('click', () => {
	if (voicePhase === 'idle') {
		if (state?.voice.available === false) {
			// Not posted: the host would answer with the same reason.
			showVoiceError(state.voice.reason ?? 'Voice messages are not available here.');
		} else {
			startVoice();
		}
	} else if (voicePhase === 'recording' || voicePhase === 'limit') {
		// The button pressed again: the same as Space, attached and kept to write beside.
		stopVoice('attach');
	}
});

voiceError.addEventListener('click', hideVoiceError);

function showVoiceError(message: string): void {
	voiceError.textContent = message;
	voiceError.hidden = false;
	clearTimeout(voiceErrorTimer);
	voiceErrorTimer = setTimeout(hideVoiceError, 8000);
}

function hideVoiceError(): void {
	clearTimeout(voiceErrorTimer);
	voiceError.hidden = true;
}

function startVoice(): void {
	hideVoiceError();
	closePalette();
	voicePhase = 'starting';
	voiceAttaching = false;
	voiceDownloading = false;
	voiceSeconds = 0;
	voiceLevels = [];
	voicePendingCancel = false;
	renderVoice();
	voiceBar.focus();
	post({ type: 'voiceStart' });
}

function stopVoice(action: 'send' | 'attach'): void {
	voiceCaret = input.selectionStart ?? input.value.length;
	voicePhase = 'finishing';
	voiceAttaching = action === 'attach';
	renderVoice();
	if (voiceAttaching) {
		// Space means "keep writing": the box is given back now, not when the transcript lands.
		input.focus();
	}
	post({ type: 'voiceStop', action });
}

function cancelVoice(): void {
	if (voicePhase === 'starting') {
		voicePendingCancel = true;
	} else if (voicePhase !== 'idle') {
		post({ type: 'voiceCancel' });
	}
	endVoice();
}

function endVoice(): void {
	// The focus goes back to the box only from the bar: after Space it is already there, and
	// the user may have moved on since.
	const fromBar = voicePhase !== 'idle' && !voiceAttaching;
	voicePhase = 'idle';
	voiceAttaching = false;
	renderVoice();
	if (fromBar && (document.activeElement === voiceBar || document.activeElement === document.body)) {
		input.focus();
	}
}

function onVoice(event: VoiceEvent): void {
	switch (event.phase) {
		case 'starting':
			return;
		case 'recording':
			if (voicePendingCancel) {
				voicePendingCancel = false;
				post({ type: 'voiceCancel' });
				return;
			}
			if (voicePhase !== 'starting' && voicePhase !== 'recording') {
				return;
			}
			if (voicePhase === 'starting') {
				voiceLocale = event.locale ?? '';
				voicePhase = 'recording';
			}
			voiceSeconds = event.seconds;
			voiceLevels.push(event.level);
			if (voiceLevels.length > 400) {
				voiceLevels.splice(0, voiceLevels.length - 400);
			}
			renderVoice();
			return;
		case 'limit':
			if (voicePhase === 'recording') {
				voicePhase = 'limit';
				voiceSeconds = event.seconds;
				renderVoice();
			}
			return;
		case 'downloading':
			// Sent once, at the start, while the user is still speaking: kept for when it ends.
			if (voicePhase !== 'idle') {
				voiceDownloading = true;
				renderVoice();
			}
			return;
		case 'transcribing':
			if (voicePhase !== 'idle') {
				voiceDownloading = false;
				renderVoice();
			}
			return;
		case 'done':
			// Only the recording on screen: one discarded with Escape while it was being
			// transcribed sends nothing — the host takes its chip back.
			if (voicePhase !== 'finishing') {
				return;
			}
			endVoice();
			if (event.text) {
				insertTranscript(event.text);
			}
			if (event.send) {
				send();
			} else {
				renderSend();
			}
			return;
		case 'cancelled':
			if (voicePhase !== 'idle') {
				endVoice();
			}
			return;
		case 'error':
			// A refusal for a recording already thrown away says nothing.
			if (voicePhase === 'idle' && !voicePendingCancel) {
				return;
			}
			voicePendingCancel = false;
			endVoice();
			showVoiceError(event.message);
			return;
	}
}

/**
 * While a recording is on screen the three keys are its — asked for: Enter sends it at once,
 * Space attaches it and leaves the box to write in, Escape throws it away. Taken in the capture
 * phase, before the box sees them — but only from the composer and the bar: a key typed into
 * another field (a tab being renamed, a form) is that field's.
 */
document.addEventListener('keydown', event => {
	const ours = voicePhase === 'starting' || voicePhase === 'recording' || voicePhase === 'limit' || (voicePhase === 'finishing' && !voiceAttaching);
	if (!ours || event.isComposing || event.keyCode === 229) {
		return;
	}
	const target = event.target;
	if (target instanceof Node && target !== document.body && !composer.contains(target)) {
		return;
	}
	if (event.key === 'Escape') {
		event.preventDefault();
		event.stopPropagation();
		cancelVoice();
	} else if (event.key === 'Enter' || event.key === ' ') {
		event.preventDefault();
		event.stopPropagation();
		// Enter only ends the recording, as Space does — asked for: the transcript goes into the
		// box to be read, and sending is the box's own Enter after that.
		if (!event.repeat && (voicePhase === 'recording' || voicePhase === 'limit')) {
			stopVoice('attach');
		}
	}
}, true);

function renderVoice(): void {
	const bar = voicePhase !== 'idle' && !voiceAttaching;
	voiceBar.hidden = !bar;
	inputWrap.classList.toggle('voice-on', bar);
	voiceBar.classList.toggle('live', voicePhase === 'recording');
	voiceBar.classList.toggle('waiting', voicePhase === 'starting' || voicePhase === 'finishing');
	const recording = voicePhase === 'recording' || voicePhase === 'limit';
	micButton.classList.toggle('recording', recording);
	micButton.classList.toggle('transcribing', voicePhase === 'finishing');
	micButton.setAttribute('aria-pressed', String(recording));
	setIcon(micButton, voicePhase === 'finishing' ? 'loading' : 'mic');
	micButton.querySelector('.codicon')?.classList.toggle('codicon-modifier-spin', voicePhase === 'finishing');
	const available = state?.voice.available ?? false;
	micButton.setAttribute('aria-disabled', String(!available && voicePhase === 'idle'));
	const max = state?.voice.maxSeconds ?? 300;
	const finishing = voiceDownloading
		? `Getting the speech model${voiceLocale ? ` for ${voiceLocale}` : ''} — once per language…`
		: 'Transcribing…';
	const title = voicePhase === 'idle'
		? (available ? `Record a voice message — up to ${clock(max)}, transcribed on this Mac` : (state?.voice.reason ?? 'Voice messages are not available'))
		: voicePhase === 'starting' ? 'Starting the microphone…'
		: recording ? 'Stop and write the words into the message box (Enter, Space) — Esc discards it'
		: voiceAttaching ? `${finishing} The words will go into the message box.` : finishing;
	if (micButton.title !== title) {
		micButton.title = title;
	}
	if (!bar) {
		return;
	}
	voiceTime.textContent = voicePhase === 'starting' ? '' : `${clock(voiceSeconds)} / ${clock(max)} · ${clock(Math.max(0, max - voiceSeconds))} left`;
	voiceHint.textContent = voicePhase === 'starting' ? 'Starting the microphone…'
		: voicePhase === 'recording' ? 'Enter or Space to stop · Esc discard'
		: voicePhase === 'limit' ? 'Limit reached — Enter or Space to stop · Esc discard'
		: finishing;
	drawWave();
}

/** The levels as bars, the newest at the right, mirrored about the middle. */
function drawWave(): void {
	const ratio = window.devicePixelRatio || 1;
	const width = voiceWave.clientWidth, height = voiceWave.clientHeight;
	if (!width || !height) {
		return;
	}
	if (voiceWave.width !== Math.round(width * ratio) || voiceWave.height !== Math.round(height * ratio)) {
		voiceWave.width = Math.round(width * ratio);
		voiceWave.height = Math.round(height * ratio);
	}
	const g = voiceWave.getContext('2d');
	if (!g) {
		return;
	}
	g.setTransform(ratio, 0, 0, ratio, 0, 0);
	g.clearRect(0, 0, width, height);
	g.fillStyle = getComputedStyle(voiceWave).color;
	const step = 3, bar = 2;
	const count = Math.floor(width / step);
	const levels = voiceLevels.slice(-count);
	const start = width - levels.length * step;
	levels.forEach((level, i) => {
		const h = Math.max(2, Math.min(height, level * level * height * 1.6));
		g.fillRect(start + i * step, (height - h) / 2, bar, h);
	});
}

/**
 * The transcript written into the box where the caret was when the recording ended, spaced from
 * the text around it, and the caret put at the end of the box. Typed after a Space, the rest of
 * the message comes after the transcript, which is the order it was said and written in.
 */
function insertTranscript(text: string): void {
	if (paletteMode === 'inline') {
		closePalette();
	}
	const value = input.value;
	const at = Math.min(Math.max(0, voiceCaret ?? value.length), value.length);
	const before = value.slice(0, at), after = value.slice(at);
	const lead = before && !/\s$/.test(before) ? ' ' : '';
	const tail = after && !/^\s/.test(after) ? ' ' : '';
	input.value = before + lead + text + tail + after;
	// The caret goes to the end of the whole text — asked for — ready to go on writing or press Enter.
	input.setSelectionRange(input.value.length, input.value.length);
	input.scrollTop = input.scrollHeight;
	fromHistory = false;
	historyAt = inputHistory.length;
	paintInput();
	autosize();
	saveDraft();
	input.focus();
}

function clock(seconds: number): string {
	const whole = Math.max(0, Math.floor(seconds));
	return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

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
 if (except !== branchPopup) { branchButton.setAttribute('aria-expanded', 'false'); branchNamePending = undefined; }
 if (except !== gitPopup) {
  gitPopupPinned = false;
  commitButton.setAttribute('aria-expanded', 'false');
  clearTimeout(gitOpenTimer); clearTimeout(gitCloseTimer);
 }
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
		if (keep !== paramsPopup) {
			paramsFormAnchor = undefined;
		}
	}
	for (const popup of [featureSettingsPanel, sleepPopup, menu, usagePopup, approvalPopup, palette, workdirPopup, branchPopup, gitPopup, paramsPopup, skillEditor, historyPanel, agentsPanel, agentAppsPanel]) {
		if (popup !== except && popup !== keep) {
			popup.classList.remove('open');
		}
	}
	for (const pill of [tabAdd, agentPill, modelPill, plusButton, usageButton, approveToggle, slashButton, workdirButton, branchButton, commitButton, contextButton]) {
		pill.classList.remove('active');
	}
	// A skill button is a popup's anchor too; the mark only tells a second
	// press of it to close what it opened, and is not drawn (see chat.css).
	for (const { button } of skillButtons.values()) {
		button.classList.remove('active');
	}
	for (const link of document.querySelectorAll('.link.active, .tab-label.active')) {
		link.classList.remove('active');
	}
}

/** `form`: the GitHub form's own class on the reused parameters popover, set before it is measured; anything else opened there drops it. */
function openAbove(popup: HTMLElement, anchor: HTMLElement, align: 'left' | 'right', keep?: HTMLElement, form?: 'repo-form'): void {
	closePopups(popup, keep);
	if (popup === paramsPopup) {
		paramsFormAnchor = undefined;
	}
	popup.classList.remove('repo-form');
	if (form) {
		popup.classList.add(form);
	}
	anchor.classList.add('active');
	// Relative to the view, not the window: the popup is positioned inside
	// `#app`, and the two only coincide when nothing else is laid out around it.
	const box = app.getBoundingClientRect();
	const rect = anchor.getBoundingClientRect();
	popup.style.maxHeight = '';
	popup.style.maxWidth = '';
	popup.style.minWidth = '';
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
	// Top-of-chat anchors need the menu below them; #app clips menus above it.
	const above = Math.max(0, rect.top - box.top - 14);
	const below = Math.max(0, box.bottom - rect.bottom - 14);
	const height = popup.getBoundingClientRect().height;
	if (height > above && below > above) {
		popup.style.bottom = '';
		popup.style.top = `${rect.bottom - box.top + 6}px`;
		popup.style.maxHeight = `${Math.min(height, below)}px`;
	} else if (height > above) {
		popup.style.maxHeight = `${above}px`;
	}
	constrainOverlay(popup);
}

/** Covers every popup path, including context menus and inline palettes. */
function constrainOverlay(node: HTMLElement): void {
	const appRect = app.getBoundingClientRect();
	const viewport = window.visualViewport;
	const bounds = overlayBounds(appRect, {
		left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
		right: (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth),
		bottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight),
	}, node.classList.contains('hover-tip') ? 4 : 8);
	if (node.offsetWidth > bounds.width) {
		node.style.minWidth = '0'; node.style.maxWidth = `${bounds.width}px`;
	}
	if (node.offsetHeight > bounds.height) { node.style.maxHeight = `${bounds.height}px`; }
	const position = fitOverlay(bounds, node.offsetLeft, node.offsetTop, node.offsetWidth, node.offsetHeight);
	const left = `${position.left}px`, top = `${position.top}px`;
	if (node.style.left !== left) { node.style.left = left; }
	if (node.style.top !== top) { node.style.top = top; }
	if (node.style.right) { node.style.right = ''; }
	if (node.style.bottom) { node.style.bottom = ''; }
}
let overlayFrame: number | undefined;
function scheduleOverlayLayout(): void {
	if (overlayFrame !== undefined) { return; }
	overlayFrame = requestAnimationFrame(() => {
		overlayFrame = undefined;
		for (const node of app.querySelectorAll<HTMLElement>('.popup.open, .hover-tip.open')) { constrainOverlay(node); }
	});
}
const overlayResize = new ResizeObserver(scheduleOverlayLayout);
overlayResize.observe(app);
for (const node of app.querySelectorAll<HTMLElement>('.popup')) { overlayResize.observe(node); }
new MutationObserver(scheduleOverlayLayout).observe(app, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
window.addEventListener('resize', scheduleOverlayLayout);
window.visualViewport?.addEventListener('resize', scheduleOverlayLayout);
window.visualViewport?.addEventListener('scroll', scheduleOverlayLayout);

/** A menu opened over a panel goes on its own, leaving the panel: true when there was one to close. */
function closeMenuOverPanel(): boolean {
	if (!menu.classList.contains('open') || !menu.classList.contains('over-panel')) {
		return false;
	}
	menu.classList.remove('open', 'over-panel');
	for (const link of document.querySelectorAll('.link.active, .tab-label.active')) {
		link.classList.remove('active');
	}
	return true;
}

/**
 * The open form holding what the user typed and has not saved: it outlives
 * the view losing focus, as the composer's draft does. Reopening any of them
 * rebuilds it from stored state, so closing it on a blur threw the text away —
 * a click into a file, Cmd+Tab, the side bar collapsed, or the skill editor's
 * own native colour picker, which takes the focus out of the document.
 */
function formHoldingInput(): HTMLElement | undefined {
	for (const form of [skillEditor, featureSettingsPanel]) {
		if (form.classList.contains('open')) {
			return form;
		}
	}
	return paramsFormAnchor && paramsPopup.classList.contains('open') ? paramsPopup : undefined;
}

/**
 * Clicks elsewhere in VS Code never reach this webview's document. Menus and
 * questions close; a form being filled in stays, with its anchor still marked
 * so a second press of it closes it rather than building it afresh. Escape,
 * its own buttons and a press elsewhere in the view still close it.
 */
function dismissOutsideView(): void {
	pendingLocalLinkMenu = undefined;
	const form = formHoldingInput();
	const anchor = form === paramsPopup ? paramsFormAnchor : undefined;
	closePopups(form);
	anchor?.classList.add('active');
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
	if (![workdirSummary, gitRefreshSlot, effortBox, ultracodeBox, featureSettingsPanel, sleepPopup, menu, usagePopup, approvalPopup, palette, workdirPopup, branchPopup, gitPopup, paramsPopup, skillBar, historyPanel, agentsPanel, agentAppsPanel, plusButton, usageButton, usageAlertText, agentsButton, agentPill, modelPill, approveToggle, slashButton, workdirButton, branchButton, commitButton, contextButton].some(n => n.contains(target))) {
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
	if (gitPopup.classList.contains('open')) {
		closePopups();
		commitButton.focus();
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

/**
 * `keep`: the panel the menu is opened from inside, which stays open under it.
 * `note`: a warning under the heading, in the chart orange.
 */
function openMenu(anchor: HTMLElement, items: MenuItem[], heading?: string, action?: MenuAction, keep?: HTMLElement, note?: string): void {
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
		note ? el('div', { class: 'menu-note', text: note }) : '',
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


agentPill.addEventListener('click', () => {
	const s = state;
	if (!s) {
		return;
	}
	openMenu(agentPill, s.agents.map(a => ({
		icon: a.id === 'claude' ? 'sparkle' : a.id === 'gemini' ? 'star-full' : 'hubot',
		label: a.name,
		description: a.available ? a.detail?.split(':')[0] : a.problem,
		checked: a.id === s.selection.agent,
		disabled: !a.available,
		run: () => post({ type: 'select', selection: { agent: a.id } }),
	})), 'Agent', { icon: 'gear', title: 'Which Claude Code, Codex and Gemini CLI apps to use', run: openAgentApps });
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
	})), `${agent.name} models`, undefined, undefined,
	// Measured: a model Gemini CLI lists, Auto's pick included, can go
	// unanswered for an account while the CLI retries in silence.
	agent.id === 'gemini'
		? 'Not every model listed here may work for your account: some can be unavailable or overloaded for reasons outside AI Browser. If no reply comes, pick another model.'
		: undefined);
});

/* the browser button */

// Asks where the page opens: the editor's own browser, or Google Chrome — whose
// tabs the browser tools then drive the same way.
function browserMenuItems(): MenuItem[] {
	const items: MenuItem[] = [
		{ icon: 'globe', label: 'Google Chrome', run: () => post({ type: 'openBrowser', where: 'chrome' }) },
	];
	if (state?.nativeBrowser && state.nativeBrowser !== 'unsupported') {
		items.push({ icon: 'window', label: 'VS Code Browser',
			description: state.nativeBrowser === 'granted' ? 'Open inside the editor'
				: state.nativeBrowser === 'awaitingRestart' ? 'Quit and reopen the editor to finish setup'
					: 'Enable native tabs — requires quitting and reopening the editor',
			run: () => post({ type: 'openBrowser', where: 'vscode' }),
		});
	}
	return items;
}

browserButton.addEventListener('click', () => openMenu(browserButton, browserMenuItems(), 'Open a new tab in'));

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
/** The row an arrow key last moved to: the one way a typed chat command becomes the chosen row without its exact name. */
let paletteArrowPick: string | undefined;
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
palette.append(clearableSearch(paletteSearch), paletteList);

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
	if (tab?.canResumeInTerminal) {
		items.push({ key: 'chat:terminal', group: 'Chat', name: 'terminal', label: 'Continue in terminal', icon: 'terminal',
			detail: 'Continue this session in a terminal tab; this chat tab closes',
			disabled: tab.busy || !!tab.queued || !!tab.skillRuns, haystack: 'terminal resume continue cli',
			run: () => post({ type: 'resumeInTerminal', id: tab.chatId }),
		});
	}
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
 * `nameOnly`: the name alone counts — for the chat's own commands typed in the
 * box, where "/start" in a sentence found Clear conversation by its description.
 */
function rank(item: PaletteItem, query: string, nameOnly = false): number | undefined {
	if (!query) {
		return 0;
	}
	if (item.name.startsWith(query)) {
		return 0;
	}
	if (item.name.includes(query)) {
		return 1;
	}
	if (nameOnly) {
		return undefined;
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
	// Typed, a chat command is reached by its name and only chosen on purpose:
	// "Our API has POST /start" or "do it all /over" matched Clear conversation
	// through its description, it became the first row, and Enter cleared the
	// tab — idle, without a question — instead of sending the message. So it
	// matches by name alone and is the chosen row only when its name is exactly
	// what was typed or an arrow key picked it.
	const typedAction = (item: PaletteItem) => inline && item.key.startsWith('chat:');
	const ranked = all.map((item, i) => ({ item, i, r: rank(item, query, typedAction(item)) }))
		.filter((x): x is { item: PaletteItem; i: number; r: number } => x.r !== undefined);
	if (query) {
		ranked.sort((a, b) => a.r - b.r || a.i - b.i);
	}
	const previous = paletteItems[paletteActive]?.key;
	paletteItems = ranked.map(x => x.item);
	const kept = paletteItems.findIndex(i => i.key === previous && !i.disabled && (!typedAction(i) || i.key === paletteArrowPick));
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
			: query ? (inline ? paletteItems.findIndex(i => !i.disabled && !typedAction(i)) : stepActive(-1, 1))
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
	paletteArrowPick = undefined;
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
				paletteArrowPick = paletteItems[paletteActive]?.key;
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
workdirPopup.append(clearableSearch(workdirSearch), workdirList);

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
	paramsFormAnchor = workdirButton;
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
	const folder = w.current?.path;
	gitStatus.hidden = !folder;
	if (folder !== gitFolder) {
		closePopups();
		gitFolder = folder;
		branchState = undefined;
		branchBusy = false;
		branchDeleting = undefined;
		branchName.textContent = '…';
		gitPending = false;
		gitChanged.textContent = '…';
		gitDeleted.textContent = '';
		gitFiles = undefined;
		gitError = '';
		gitIndexPending = false;
		gitPopupShape = '';
		refreshGitStatus();
	}
	const commit = w.commit;
	const committing = commit?.phase === 'generating' || commit?.phase === 'committing';
	const modelAvailable = s.agents.some(a => a.id === s.selection.agent && a.available);
	commitButton.disabled = false;
	renderGitChanges();
	branchButton.disabled = committing;
	commitButton.setAttribute('aria-busy', String(committing));
	commitIcon.className = committing ? 'codicon codicon-loading codicon-modifier-spin' : 'codicon codicon-git-commit';
	commitButton.title = committing ? commit.message ?? 'Committing…' : 'Git changes and commit';
	commitNotice.hidden = commit?.phase !== 'error';
	commitNotice.dataset.phase = commit?.phase ?? '';
	commitNoticeText.textContent = commit?.message ?? '';
	commitFix.hidden = commit?.phase !== 'error';
	commitFix.disabled = !modelAvailable || s.running;
	commitFix.title = `Ask ${s.selection.model ?? 'the current model'} to diagnose and fix this commit error`;
	workdirButton.title = w.current
		? `Working folder: ${w.current.path}${w.picked ? '' : " (this window's)"} — where the agent works, and its files to add to the message`
		: 'Working folder: none, the home directory — choose a folder for the agent to work in, and its files to add to the message';
	workdirButton.classList.toggle('picked', w.picked);
	const currentProject = !w.copy && !w.noProject && !!w.current && w.workspace.some(folder => folder.path === w.current?.path);
	const mode = w.copy ? 'Git' : w.noProject || !w.current ? 'Home' : currentProject ? '' : 'Ext';
	const location = w.copy ? `${w.copy.repo} · ${w.copy.branch}` : w.current?.path ?? 'Home directory · no project';
	workdirMode.textContent = mode;
	workdirMode.hidden = !mode;
	workdirLocationText.textContent = location;
	workdirLocation.classList.toggle('path-tail', !!w.current && !w.copy);
	const detail = w.copy
		? `GitHub: ${w.copy.repo}\nBranch: ${w.copy.branch} (from ${w.copy.base})\nWorking copy: ${w.current?.path ?? ''}`
		: `${workdirButton.title}${w.noProject ? '\nHome directory, with no project' : ''}`;
	const references = w.references.length ? `\nGitHub references: ${w.references.map(r => r.repo).join(', ')}` : '';
	const summary = `${detail}${references}${w.busy ? `\n${w.busy}…` : ''}`;
	workdirSummary.title = summary;
	workdirSummary.setAttribute('aria-label', `${mode ? `${mode}: ` : ''}${location}. Click to change working folder or GitHub mode`);
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
	overlayResize.observe(node);
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
			if (anchor === effortBox) {
				const value = el('strong', { text: effortRange.getAttribute('aria-valuetext') ?? '' });
				value.style.color = getComputedStyle(anchor).getPropertyValue('--effort-colour');
				node.replaceChildren('Effort: ', value, '\nMore effort takes longer and uses more of your plan.');
			} else if (anchor === ultracodeBox) {
				node.replaceChildren(el('strong', { class: 'ultracode-tip-name', text: 'UltraCode' }), text.slice('UltraCode'.length));
			} else {
				node.textContent = text;
			}
			if (!node.isConnected) {
				app.append(node);
			}
			node.style.maxHeight = ''; node.style.maxWidth = '';
			node.classList.add('open');
			const box = app.getBoundingClientRect();
			const r = anchor.getBoundingClientRect();
			const w = node.offsetWidth;
			const h = node.offsetHeight;
			const left = Math.min(Math.max(4, r.left - box.left + r.width / 2 - w / 2), box.width - w - 4);
			const above = r.top - box.top - h - 6;
			node.style.left = `${Math.max(4, left)}px`;
			node.style.top = `${above >= 4 ? above : r.bottom - box.top + 6}px`;
			constrainOverlay(node);
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
hoverTip.attach(gitRefreshSlot);
hoverTip.attach(branchMagic);
hoverTip.attach(contextButton);
hoverTip.attach(ultracodeBox);
ultracodeInput.addEventListener('focus', () => hoverTip.show(ultracodeBox));
ultracodeInput.addEventListener('blur', () => hoverTip.hide());
// Effort is shown immediately, including while dragging or changing it with the keyboard.
effortBox.addEventListener('mouseenter', () => hoverTip.show(effortBox));
effortBox.addEventListener('mouseleave', () => hoverTip.hide());
effortRange.addEventListener('focus', () => hoverTip.show(effortBox));
effortRange.addEventListener('blur', () => hoverTip.hide());
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
	paramsFormAnchor = anchor;
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

	const agents = selectField<ToolbarSkill['agents']>([['all', 'All agents'], ['claude', 'Claude Code only'], ['codex', 'Codex only'], ['gemini', 'Gemini CLI only']], editorAgents);
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
	{ kind: 'video', icon: 'device-camera-video', label: 'Record the browser page', needsTab: true },
	{ kind: 'screenshot', icon: 'device-camera', label: 'Screenshot of the page', needsTab: true },
	{ kind: 'element', icon: 'inspect', label: 'Element from the page…', needsTab: true },
	{ kind: 'page', icon: 'link', label: 'Page address', needsTab: true },
	{ kind: 'sharedPage', icon: 'link-external', label: 'Share page', needsTab: true },
	{ kind: 'annotation', icon: 'comment-add', label: 'Add annotation…', needsTab: true },
	{ kind: 'file', icon: 'file', label: 'File…', needsTab: false },
];

plusButton.addEventListener('click', () => {
	// Without the grant no tab can be seen at all, so "open a page" would send
	// the user the wrong way (Recipe, step 3: two guards, two messages).
	const pageProblem = !state?.browserApi
		? 'Open Google Chrome or VS Code Browser first'
		: !state.hasBrowserTab ? 'Open a page in the browser first' : undefined;
	openMenu(plusButton, [...browserMenuItems(), ...attachItems.map(item => ({
		icon: item.icon,
		label: item.label,
		description: item.needsTab ? pageProblem : undefined,
		disabled: item.needsTab && !!pageProblem,
		run: () => post({ type: 'attach', kind: item.kind }),
	}))], 'Attach');
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
	setRingFill(usageRing, u ? u.percent / 100 : undefined);
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
			if (a.status === 'running' && a.agent?.health === 'unresponsive') { return 'No response · Check connection or stop the agent'; }
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
		if (agents.some(a => a.id === id && (a.status !== 'running' || a.agent?.health === 'unresponsive'))) {
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
		el('div', { class: 'agent-line', text: [agentLive(selected, 'status'), info?.type, modelName(info?.model), info?.background ? 'background' : undefined].filter(Boolean).join(' · ') }),
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
		: el('div', { class: 'agent-report' }, el('span', { class: selected.status === 'running' && info?.health !== 'unresponsive' ? 'shimmer' : 'faint', text: info?.health === 'unresponsive' && selected.status === 'running' ? 'The backend is not responding. Check the connection or retry Stop.' : selected.status === 'running' ? 'Working…' : 'No report.' })));
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

let historyAgentFilter = '';
let historyPeriodFilter: HistoryPeriod = 'all';

function fillHistory(chats: readonly ChatSummary[]): void {
	const header = panelHead('History');
	const agents = new Map(state?.agents.map(agent => [agent.id, agent.name]));
	for (const chat of chats) {
		if (!agents.has(chat.agent)) { agents.set(chat.agent, chat.agent); }
	}
	const filter = selectField<string>([['', 'All agents'], ...agents], historyAgentFilter);
	filter.setAttribute('aria-label', 'Filter history by agent');
	filter.addEventListener('change', () => {
		historyAgentFilter = filter.value;
		fillHistory(chats);
		historyPanel.querySelector<HTMLSelectElement>('.history-filter select')?.focus();
	});
	const filters = el('label', { class: 'history-filter' }, el('span', { text: 'Agent' }), filter);
	const period = selectField<HistoryPeriod>([
		['all', 'All time'], ['today', 'Today'], ['yesterday', 'Yesterday'],
		['week', 'This week'], ['month', 'This month'], ['lastMonth', 'Last month'],
	], historyPeriodFilter);
	period.setAttribute('aria-label', 'Filter history by period');
	period.addEventListener('change', () => {
		historyPeriodFilter = period.value as HistoryPeriod;
		fillHistory(chats);
		historyPanel.querySelector<HTMLSelectElement>('.history-period-filter select')?.focus();
	});
	const periodFilters = el('label', { class: 'history-filter history-period-filter' }, el('span', { text: 'Period' }), period);
	const [start, end] = historyPeriodRange(historyPeriodFilter);
	const visibleChats = chats.filter(chat => (!historyAgentFilter || chat.agent === historyAgentFilter)
		&& chat.updatedAt >= start && chat.updatedAt < end);

	const list = el('div', { class: 'history-list' });
	if (!visibleChats.length) {
		list.append(el('div', { class: 'history-empty', text: chats.length ? 'No chats match these filters.' : 'No chats yet.' }));
	}
	for (const chat of visibleChats) {
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
		const terminal = button([icon('terminal')], { class: 'ghost round history-delete', title: 'Continue in terminal' });
		terminal.hidden = !chat.canResumeInTerminal;
		terminal.addEventListener('click', () => { closePopups(); post({ type: 'resumeInTerminal', id: chat.id }); });
		list.append(el('div', { class: 'history-row' }, open, terminal, remove));
	}
	historyPanel.replaceChildren(header, filters, periodFilters, list);
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


/* The popup of the title bar's cup; the window's choice, voted to the OS coordinator. */
let sleepSignature = '';
/** The tab a tab-scoped hold waits on, by name, for the tooltip and the popup. */
function sleepTabTitle(tabId: string | undefined): string {
	const title = state?.tabs.find(t => t.id === tabId)?.title;
	return title ? `\u201c${title}\u201d` : 'this tab';
}
function renderSleep(): void {
	const sleep = state?.sleep;
	const active = sleep?.active === true;
	const seconds = Math.max(0, Math.ceil(((sleep?.until ?? 0) - Date.now()) / 1000));
	const countdown = `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds / 60 % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
	const tabScoped = sleep?.mode === 'agents' && sleep.scope === 'tab';
	const tip = sleep?.error ? `Cannot keep computer awake: ${sleep.error}`
		: sleep?.mode === 'timer' ? `Keep awake: ${countdown}${active ? '' : ' — starting…'}`
		: tabScoped ? `Keep awake until the agents and subagents in ${sleepTabTitle(sleep.tabId)} finish`
		: sleep?.mode === 'agents' ? 'Keep awake until the agents and subagents in every tab finish'
		: sleep?.automaticActive ? 'Keep awake automatically while tasks are active in any tab'
		: sleep?.automatic ? 'Automatic awake is enabled — waiting for active tasks'
		: 'Keep computer awake — off';
	// The tab in front and the watched tab's name decide which row reads as chosen.
	const signature = JSON.stringify([sleep?.mode, sleep?.minutes, sleep?.scope, sleep?.tabId, active, sleep?.error, sleep?.automatic, sleep?.automaticActive,
		state?.activeTab, tabScoped ? sleepTabTitle(sleep.tabId) : '', sleepTabTitle(state?.activeTab)]);
	if (signature !== sleepSignature) {
		sleepSignature = signature;
		buildSleepPopup();
	}
	const status = sleepPopup.querySelector('.sleep-status');
	if (status) {
		status.textContent = tip;
		status.classList.toggle('sleep-enabled-status', !!sleep && (sleep.mode === 'timer' || sleep.mode === 'agents' || sleep.automaticActive) && !sleep.error);
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
	/** A wide row: an icon, a label, and a line under it saying what it waits on. */
	const wideOption = (glyph: string, label: string, detail: string, choice: SleepChoice, selected: boolean) => {
		const b = option('', choice, selected);
		b.replaceChildren(icon(glyph), el('span', { class: 'sleep-option-text' },
			el('span', { class: 'sleep-option-label', text: label }), el('span', { class: 'sleep-option-detail', text: detail })));
		if (selected) { b.append(icon('check')); }
		b.classList.add('sleep-agents-option');
		return b;
	};
	const minutes = el('div', { class: 'sleep-options' });
	for (const n of sleepMinutes) { minutes.append(option(String(n), { mode: 'timer', minutes: n }, sleep?.mode === 'timer' && sleep.minutes === n)); }
	const hours = el('div', { class: 'sleep-options' });
	for (const n of sleepHours) { hours.append(option(String(n), { mode: 'timer', minutes: n * 60 }, sleep?.mode === 'timer' && sleep.minutes === n * 60)); }
	const tabId = state?.activeTab;
	const watched = sleep?.mode === 'agents' && sleep.scope === 'tab' ? sleep.tabId : undefined;
	const thisTab = tabId ? wideOption('comment-discussion', 'This tab', `Until the agents and subagents in ${sleepTabTitle(tabId)} finish`,
		{ mode: 'agents', scope: 'tab', tabId }, watched === tabId) : undefined;
	const allTabs = wideOption('hubot', 'All tabs', 'Until the agents and subagents in every tab of this window finish',
		{ mode: 'agents', scope: 'window' }, sleep?.mode === 'agents' && sleep.scope !== 'tab');
	sleepPopup.replaceChildren(el('div', { class: 'sleep-heading', text: 'Keep computer awake' }),
		el('div', { class: 'sleep-status' }),
		el('div', { class: 'sleep-label', text: 'For a time — the whole app' }),
		el('div', { class: 'sleep-label sleep-sublabel', text: 'Minutes' }), minutes,
		el('div', { class: 'sleep-label sleep-sublabel', text: 'Hours' }), hours,
		el('div', { class: 'sleep-label', text: 'Until the agents finish' }),
		...(thisTab ? [thisTab] : []), allTabs);
	// Another tab holds it: say so, so moving the hold here is a visible change.
	if (watched && watched !== tabId) {
		sleepPopup.append(el('div', { class: 'sleep-note', text: `Now held by ${sleepTabTitle(watched)}.` }));
	}
	if (sleep && sleep.mode !== 'off') {
		const off = option(sleep.automatic ? 'Turn off manual awake' : 'Turn off', { mode: 'off' }, false);
		off.prepend(icon('circle-slash'));
		sleepPopup.append(off);
	}
	const automatic = el('input'); automatic.type = 'checkbox'; automatic.checked = sleep?.automatic === true;
	automatic.addEventListener('change', () => {
		post({ type: 'setAutomaticAwake', enabled: automatic.checked });
		automatic.checked = sleep?.automatic === true;
	});
	sleepPopup.append(el('label', { class: 'sleep-automatic' }, automatic,
		el('span', {}, el('span', { text: 'Keep awake automatically while tasks are running' }),
			el('span', { class: 'sleep-option-detail', text: 'Across all chat tabs · turns off when all tasks finish' }))));
}
/**
 * Opened from the cup in the view's title bar, which is outside the webview:
 * so the popup hangs from the view's top right corner, under that button.
 */
function openSleepPopup(): void {
	closePopups(sleepPopup);
	sleepPopup.style.bottom = '';
	sleepPopup.style.left = '';
	sleepPopup.style.top = '6px';
	sleepPopup.style.right = '8px';
	sleepPopup.classList.add('open');
	sleepPopup.querySelector<HTMLButtonElement>('.sleep-option.selected, .sleep-option')?.focus();
}
sleepPopup.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.isComposing) { closePopups(); input.focus(); } });
setInterval(renderSleep, 1000);


/* ---------------------------------------------------------------- feature settings */

let featureSettingsSaving = false;
const featureSettingsStatus = el('div', { class: 'feature-settings-status' });
featureSettingsStatus.setAttribute('role', 'status');
const featureSettingsSave = button(['Save'], { class: 'feature-settings-save' });
let featureSettingsDraft: FeatureAiSettings = readFeatureAiSettings(undefined);
let videoQualityDraft: RecordingQuality = 'high';
/** The maximum video length being edited, in seconds; `undefined` while what is typed is out of range. */
let videoSecondsDraft: number | undefined = 300;

/** The length as the two fields show it: whole minutes when it is one, else seconds. */
function lengthFields(seconds: number): { value: number; unit: 'min' | 's' } {
	return seconds % 60 === 0 ? { value: seconds / 60, unit: 'min' } : { value: seconds, unit: 's' };
}

let temporaryStorageState: TemporaryStorage | undefined;
let temporaryStorageBusy = false;
const temporaryStorageContent = el('div', { class: 'feature-settings-content temporary-storage' });
function renderTemporaryStorage(error?: string): void {
 const storage = temporaryStorageState;
 const format = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
 const status = el('p', { text: error || (temporaryStorageBusy ? 'Working…' : storage
  ? `${storage.files} files · ${format(storage.bytes)}${storage.deleted ? ` · Deleted ${storage.deleted}` : ''}${storage.skipped ? ` · Protected ${storage.skipped}` : ''}${storage.errors ? ` · Errors ${storage.errors}` : ''}` : 'Refresh to inspect temporary files.') });
 status.setAttribute('role', 'status');
 const actions = el('div', { class: 'temporary-storage-actions' });
 for (const [action, label] of [['refresh', 'Refresh'], ['project', 'Clean project'], ['all', 'Delete all temporary files']] as const) {
  const control = button([label], { class: action === 'all' ? 'temporary-delete-all' : 'ghost' });
  control.disabled = temporaryStorageBusy || (action !== 'refresh' && (!!storage?.busy || !storage)) || (action === 'project' && !storage?.project);
  control.addEventListener('click', () => {
   temporaryStorageBusy = true; renderTemporaryStorage(); post({ type: 'temporaryStorage', action, ...(action === 'project' ? { project: storage?.project } : {}) });
  });
  actions.append(control);
 }
 temporaryStorageContent.replaceChildren(
  el('p', { text: 'Files are grouped in ~/.ai-browser/projects by project. Shared disposable files live in ~/.ai-browser/shared. Project-local reports and exports use .ai-browser/.' }),
  el('p', { class: 'temporary-project', text: storage?.project ? `Current project: ${storage.project} · ${storage.projectFiles} files · ${format(storage.projectBytes)}` : 'No project selected.' }), status, actions,
  el('p', { text: 'Cleaning removes local files permanently; old chat links to them may stop working. Draft attachments, active requests and files owned by another running window are protected. Files created in the last minute are kept. Isolated AI request files are protected for 24 hours. AI request instructions and connection files are normally removed automatically.' }),
 );
 if (storage?.busy) { temporaryStorageContent.append(el('p', { text: storage.busy })); }
 if (storage && !storage.folders.length) { temporaryStorageContent.append(el('p', { text: 'No temporary folders found.' })); }
 for (const folder of storage?.folders ?? []) {
  temporaryStorageContent.append(el('div', { class: 'temporary-folder' },
   el('code', { text: folder.path }),
   el('span', { text: `${folder.files} files · ${format(folder.bytes)} · ${folder.protected} protected` })));
 }
}
function createTemporarySettings(): HTMLElement {
 renderTemporaryStorage();
 return temporaryStorageContent;
}

function openFeatureSettings(): void {
	if (!state) { return; }
	closePopups(featureSettingsPanel);
	if (!featureSettingsSaving) { featureSettingsDraft = readFeatureAiSettings(state.featureAi); videoQualityDraft = readRecordingQuality(state.recordingQuality); videoSecondsDraft = readRecordingSeconds(state.recordingSeconds); }
	featureSettingsStatus.textContent = featureSettingsSaving ? 'Saving…' : '';
	featureSettingsSave.disabled = featureSettingsSaving;
	const close = button([icon('close')], { title: 'Close settings', class: 'ghost' });
	close.setAttribute('aria-label', 'Close settings');
	close.addEventListener('click', () => { closePopups(); input.focus(); });
	const heading = el('div', { class: 'feature-settings-heading' }, el('strong', { text: 'Chat Settings' }), close);
	const tabs = el('div', { class: 'feature-settings-tabs' });
	tabs.setAttribute('role', 'tablist');
	tabs.setAttribute('aria-orientation', 'vertical');
	const tab = button(['AI features'], { class: 'feature-settings-tab' });
	tab.id = 'feature-ai-tab';
	tab.setAttribute('role', 'tab');
	tab.setAttribute('aria-selected', 'true');
	tab.setAttribute('aria-controls', 'feature-ai-content');
	tabs.append(tab);
	const videoTab = button(['Video recording'], { class: 'feature-settings-tab' });
	videoTab.id = 'video-quality-tab';
	videoTab.setAttribute('role', 'tab'); videoTab.setAttribute('aria-selected', 'false');
	videoTab.setAttribute('aria-controls', 'video-quality-content');
	tabs.append(videoTab);
	const temporaryTab = button(['Temporary files'], { class: 'feature-settings-tab' });
	temporaryTab.id = 'temporary-files-tab';
	temporaryTab.setAttribute('role', 'tab'); temporaryTab.setAttribute('aria-selected', 'false');
	temporaryTab.setAttribute('aria-controls', 'temporary-files-content');
	tabs.append(temporaryTab);
	const temporaryContent = createTemporarySettings();
	temporaryContent.id = 'temporary-files-content'; temporaryContent.hidden = true;
	temporaryContent.setAttribute('role', 'tabpanel'); temporaryContent.setAttribute('aria-labelledby', temporaryTab.id);
	const videoContent = el('div', { class: 'feature-settings-content' });
	videoContent.id = 'video-quality-content'; videoContent.hidden = true;
	videoContent.setAttribute('role', 'tabpanel'); videoContent.setAttribute('aria-labelledby', videoTab.id);
	const quality = el('select'); quality.dataset.field = 'recordingQuality';
	quality.setAttribute('aria-label', 'Video recording quality'); quality.disabled = featureSettingsSaving;
	for (const key of ['balanced', 'high', 'maximum'] as const) {
		const option = el('option', { text: recordingProfiles[key].label }); option.value = key; quality.append(option);
	}
	quality.value = videoQualityDraft;
	quality.addEventListener('change', () => { videoQualityDraft = readRecordingQuality(quality.value); featureSettingsStatus.textContent = 'Unsaved changes.'; });
	// The maximum length: a number and its unit, 10 s to 1 h. Out of range,
	// Save is held back with the reason rather than quietly clamping.
	const shown = lengthFields(videoSecondsDraft ?? 300);
	const length = el('input'); length.type = 'number'; length.min = '1'; length.step = '1';
	length.dataset.field = 'recordingSeconds'; length.value = String(shown.value);
	length.setAttribute('aria-label', 'Maximum video length'); length.disabled = featureSettingsSaving;
	const unit = el('select'); unit.dataset.field = 'recordingUnit';
	unit.setAttribute('aria-label', 'Maximum video length unit'); unit.disabled = featureSettingsSaving;
	for (const [value, label] of [['s', 'seconds'], ['min', 'minutes']] as const) {
		const option = el('option', { text: label }); option.value = value; unit.append(option);
	}
	unit.value = shown.unit;
	const lengthChanged = () => {
		const value = Number(length.value);
		const seconds = length.value.trim() && Number.isFinite(value) ? Math.round(value * (unit.value === 'min' ? 60 : 1)) : NaN;
		const inRange = seconds >= minRecordingSeconds && seconds <= maxRecordingSeconds;
		videoSecondsDraft = inRange ? seconds : undefined;
		length.setAttribute('aria-invalid', String(!inRange));
		featureSettingsSave.disabled = featureSettingsSaving || !inRange;
		featureSettingsStatus.textContent = inRange ? 'Unsaved changes.' : 'The maximum length is 10 seconds to 1 hour.';
	};
	length.addEventListener('input', lengthChanged); unit.addEventListener('change', lengthChanged);
	videoContent.append(el('div', { class: 'feature-settings-row' }, el('strong', { text: 'Video recording' }),
		el('label', {}, el('span', { text: 'Quality' }), quality),
		el('label', { class: 'video-length' }, el('span', { text: 'Maximum length' }), el('span', { class: 'video-length-fields' }, length, unit))),
		el('p', { text: 'High is the default. Maximum preserves more detail and creates larger files. Resolution is limited by the source page.' }),
		el('p', { text: 'A recording stops by itself at the maximum length — 5 minutes unless you change it, from 10 seconds up to 1 hour; paused time does not count. In its last 30 seconds the Stop button on the browser tab blinks red and the status bar counts down. Changes apply to the next recording and are shared across projects.' }));
	const content = el('div', { class: 'feature-settings-content' });
	content.id = 'feature-ai-content';
	content.setAttribute('role', 'tabpanel');
	content.setAttribute('aria-labelledby', tab.id);
	content.append(el('p', { text: 'Choose an agent and effort for each feature. Auto follows the current chat agent. Changes apply to future requests.' }));
	const labels: Record<AiFeature, string> = { commitMessage: 'Commit messages', branchName: 'Branch names', chatTitle: 'Chat titles' };
	for (const feature of aiFeatures) {
		const row = el('div', { class: 'feature-settings-row' });
		row.append(el('strong', { text: labels[feature] }));
		const agent = el('select');
		agent.setAttribute('aria-label', `${labels[feature]} agent`);
		agent.dataset.feature = feature;
		agent.dataset.field = 'agent';
		for (const [value, label] of [['auto', 'Current agent (Auto)'], ['claude', 'Claude Code'], ['codex', 'Codex']]) {
			const available = value === 'auto' || state.agents.some(a => a.id === value && a.available);
			const option = el('option', { text: `${label}${available ? '' : ' (unavailable)'}` });
			option.value = value;
			agent.append(option);
		}
		agent.value = featureSettingsDraft[feature].agent;
		agent.disabled = featureSettingsSaving;
		const effort = el('select');
		effort.setAttribute('aria-label', `${labels[feature]} effort`);
		effort.dataset.feature = feature;
		effort.dataset.field = 'effort';
		for (const [value, label] of [['minimum', 'Minimum'], ['medium', 'Medium'], ['maximum', 'Maximum']]) {
			const option = el('option', { text: label });
			option.value = value;
			effort.append(option);
		}
		effort.value = featureSettingsDraft[feature].effort;
		effort.disabled = featureSettingsSaving;
		agent.addEventListener('change', () => {
			featureSettingsDraft = { ...featureSettingsDraft, [feature]: { ...featureSettingsDraft[feature], agent: agent.value as 'auto' | AgentId } };
			featureSettingsStatus.textContent = 'Unsaved changes.';
		});
		effort.addEventListener('change', () => {
			featureSettingsDraft = { ...featureSettingsDraft, [feature]: { ...featureSettingsDraft[feature], effort: effort.value as FeatureEffort } };
			featureSettingsStatus.textContent = 'Unsaved changes.';
		});
		row.append(el('label', {}, el('span', { text: 'Agent' }), agent), el('label', {}, el('span', { text: 'Effort' }), effort));
		const prompt = el('textarea', { class: 'feature-system-prompt' });
		prompt.dataset.feature = feature; prompt.rows = 7; prompt.maxLength = featurePromptLimit;
		prompt.setAttribute('aria-label', `${labels[feature]} system prompt`);
		prompt.value = featureSettingsDraft[feature].prompt ?? defaultFeaturePrompts[feature];
		prompt.disabled = featureSettingsSaving;
		prompt.addEventListener('input', () => {
			featureSettingsDraft = { ...featureSettingsDraft, [feature]: { ...featureSettingsDraft[feature], prompt: prompt.value } };
			featureSettingsStatus.textContent = 'Unsaved changes.';
		});
		const reset = button(['Restore default prompt'], { class: 'ghost feature-prompt-reset' });
		reset.disabled = featureSettingsSaving;
		reset.addEventListener('click', () => {
			const { prompt: _oldPrompt, ...choice } = featureSettingsDraft[feature];
			featureSettingsDraft = { ...featureSettingsDraft, [feature]: choice };
			prompt.value = defaultFeaturePrompts[feature]; featureSettingsStatus.textContent = 'Unsaved changes.';
		});
		row.append(el('label', { class: 'feature-prompt-field' }, el('span', { text: 'System prompt' }), prompt), reset);
		content.append(row);
	}
	content.append(el('p', { class: 'feature-settings-note', text: "Commit messages use the selected agent's remembered chat model or its default. Branch names and chat titles use an available lightweight model. Effort is mapped to the levels supported by that model. Custom prompts apply to future requests; output format and length checks still apply. Empty prompts use the defaults. Settings are shared across projects." }));
	const selectTab = (selected: 'ai' | 'video' | 'temporary') => {
		content.hidden = selected !== 'ai'; videoContent.hidden = selected !== 'video'; temporaryContent.hidden = selected !== 'temporary';
		tab.setAttribute('aria-selected', String(selected === 'ai')); videoTab.setAttribute('aria-selected', String(selected === 'video'));
		temporaryTab.setAttribute('aria-selected', String(selected === 'temporary'));
		featureSettingsSave.hidden = selected === 'temporary';
	};
	tab.addEventListener('click', () => selectTab('ai')); videoTab.addEventListener('click', () => selectTab('video'));
	temporaryTab.addEventListener('click', () => {
		selectTab('temporary');
		if (!temporaryStorageBusy) { temporaryStorageBusy = true; renderTemporaryStorage(); post({ type: 'temporaryStorage', action: 'refresh' }); }
	});
	featureSettingsSave.hidden = false;
	const sections = [tab, videoTab, temporaryTab];
	tabs.addEventListener('keydown', event => {
		const index = sections.indexOf(document.activeElement as HTMLButtonElement);
		if (index < 0 || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) { return; }
		event.preventDefault();
		const next = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1
			: (index + (event.key === 'ArrowDown' ? 1 : -1) + sections.length) % sections.length;
		sections[next].click(); sections[next].focus();
	});
	featureSettingsPanel.replaceChildren(heading,
		el('div', { class: 'feature-settings-layout' }, tabs,
			el('div', { class: 'feature-settings-main' }, content, videoContent, temporaryContent,
				el('div', { class: 'feature-settings-actions' }, featureSettingsStatus, featureSettingsSave))));
	featureSettingsPanel.classList.add('open');
	featureSettingsPanel.focus();
}
featureSettingsSave.addEventListener('click', () => {
	if (featureSettingsSaving) { return; }
	if (videoSecondsDraft === undefined) { return; }
	featureSettingsSaving = true;
	featureSettingsSave.disabled = true;
	for (const field of featureSettingsPanel.querySelectorAll<HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement | HTMLInputElement>('select, textarea, .feature-prompt-reset, input[data-field="recordingSeconds"]')) { field.disabled = true; }
	featureSettingsStatus.textContent = 'Saving…';
	post({ type: 'saveFeatureAi', settings: featureSettingsDraft, recordingQuality: videoQualityDraft, recordingSeconds: videoSecondsDraft });
});
featureSettingsPanel.addEventListener('keydown', event => {
	if (event.key === 'Escape' && !event.isComposing) { event.stopPropagation(); closePopups(); input.focus(); }
});
