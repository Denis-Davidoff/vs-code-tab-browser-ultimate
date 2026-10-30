import { currentVisibleTurns, windowEntries } from './core/entryWindow';
import { remoteOpenHint } from './remoteTerminalView';
import { GitFetchScheduler } from './gitFetch';
import type { ExchangeUiMessage } from './exchangeUiProtocol';
import { remoteRefusal } from './core/commands';
import { remoteScope } from './core/remoteScope';
import { exchangeConnection } from './exchangeConnection';
import { annotationPointContext } from '../browser/annotationData';
import { AsyncLocalStorage } from 'node:async_hooks';
import { chromeChatCommandFeature } from './chromeChatCompatibility';
import { ChatPanelCatalog } from './chatPanelCatalog';
import { chatProjectId, legacyProjectTabs, type SavedChatTabs } from './chatProject';
import { ChatStateSurfaces, type ChatStateSurface } from './chatSurface';
import type { ChromeElementAttachment } from './chromeChatProtocol';
import { bindAttachmentReference } from './attachmentReferences';
import { readChatPanelIdentity, type ChatPanelIdentity } from './chatPanelState';
import { comparablePath, trackTemporaryFile, temporaryStorage } from '../core/temporaryFiles';
import { featureAgent, featureAiKey, defaultFeaturePrompts, featureEffort, readFeatureAiSettings, type AiFeature } from './featureAi';
import { availableBranchName, titleModel } from './autoTitle';
import { localFileLink } from './fileLinks';
import { SleepControl } from '../power/sleepControl';
import { sleepHours, sleepMinutes, exchangeAwakeMinutes, readExchangeAwakeMinutes, type SleepChoice } from '../power/sleepProtocol';
import { VoiceRecording, voiceHelperPath, voiceUnavailable } from './voiceRecorder';
import { tidyTranscript, voiceChipLabel, voiceLocalePattern, voiceMaxSeconds, voicePromptText, type HelperLine } from './voiceText';
import { privateTempDirectory, projectTempDirectory, legacyPrivateTempDirectory, writeExclusive } from '../core/safeFiles';
import { pastedFileLimit, pastedFileName, pastedImageType } from './pastedFiles';
import { annotationClipboardText } from '../browser/annotationData';
import type { BrowserRecording, RecordingDestination, RecordingEncoder } from '../browser/recording';
import { readRecordingQuality, readRecordingSeconds, recordingQualityKey, recordingSecondsKey } from '../browser/recordingQuality';
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { attachmentReference, preserveAttachmentReference } from './attachmentReferences';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';
import * as vscode from 'vscode';
import { AgentRegistry, agentNames, isAgentId, type BrowserServer } from './agents';
import { sweepBrowserConfigs, writeTerminalBrowserConfig } from './claudeAgent';

/** The environment variable a resumed `codex` reads the browser server's authorization from. */
const terminalAuthEnv = 'AI_BROWSER_MCP_AUTH';
const terminalTabEnv = 'AI_BROWSER_MCP_TAB';
import { geminiPath } from './geminiAgent';
import { piPath } from './piAgent';
import { piResumeArgs } from './piProtocol';
import type { OpenRouterConfig } from './openrouterAgent';
import {
	fetchOpenRouterCatalog, localEndpoint, openrouterEndpoint, openrouterKeySecret, openrouterModelsKey, readOpenRouterModels, searchOpenRouterCatalog, validateOpenRouterKey, validateOpenRouterModels,
	openrouterCatalogTtlMs, type OpenRouterCatalogEntry,
} from './openrouterProtocol';
import { bundledPin } from './agentBinary';
import { TerminalSet, type TerminalStarter, type TerminalTab } from './terminalTab';
import { AgentTypingGate, UnreadTracker } from './terminalControl';
import { TerminalPins, isPinMode, pinChipId, terminalOfPinChip, watchRefusal, type PinInfo, type PinMode } from './terminalPins';
import { isTerminalInsertKind, terminalInsertPayload, type TerminalInsertItem, type TerminalInsertKind } from './terminalInsert';
import { TerminalRefusal, type TerminalAgentApi } from '../mcp/terminalTools';
import { mintTerminalGrant, planKeys, typedTextProblem } from '../mcp/terminalInput';
import { TerminalGrants } from '../mcp/terminalGrants';
import { chooseTerminalCwd, clampTerminalLimit, nextTerminalName, profilePlatform, readTerminalSettings, terminalChatText, closesEmptyPanel, terminalName, terminalPasteLimit, sanitizePaste, terminalSettingKeys, userScopedSetting } from './terminalLogic';
import { plainText, resolveShell, safeTailStart, scrubEnv, terminalAvailability, TerminalHost, type ShellProfileSettings } from '../terminal/terminalHost';
import { JsonLineProcess } from './agentProcess';
import { ChatTab, isHome, newChat, reopened, started, storedEntries, storedTextLimit, type Attachment, type SkillStep, type StoredChat, type TabHost } from './chatTab';
import { chatTranscript, secondOpinionText, transcriptFileName, type OpinionContext } from './transcript';
import { diffSides } from './diffSides';
import { listWorkdir, type WorkdirListing } from './workdir';
import { compareUrl, parseRepo, pullRequestUrl, repoSlug, validBranch, workBranchName, type RepoRef } from './githubRepo';
import { cloneInto, copyChanges, isEmptyFolder, isOurWorktree, makeCopy, makeReference, pushCopy, removeCopy, storedCopyRepo, removeStoredCopy, managedCopy } from './repoWork';
import { GitAccess } from './gitAccess';
import { changeGitIndex } from './gitIndex';
import { commitChanges } from './gitCommit';
import { branchCommand, branchRefFormat, parseGitBranches, publishRemote, pushesDefaultBranch } from './gitBranchState';
import { gitExtensionErrorText, gitRepositoryFor } from './gitExtension';
import { gitDiffSides } from './gitDiff';
import { assertSwitchReady, switchAndUpdate, type SwitchResult } from './gitBranchSwitch';
import { parseGitStatus } from './gitStatus';
import { ghPrFields, ghRunFields, githubListLimit, parseApiPullRequests, parseApiRuns, parseGhPullRequests, parseGhRuns, pickGithubRemote, type GithubSource, type GithubStatus } from './githubStatus';
import { parseRemoteUrls } from './gitBranchState';
import { chatResourceRoots, loadFileIconTable, themedGitFiles } from './fileIconTheme';
import type { FileIconTable } from './fileIconTable';
import { runGit } from './repoWork';
import { gitBinary } from '../core/gitBinary';
import { cleanUpReportsIn, writeChatTranscript } from '../elements/assistants';
import { savePng } from '../browser/clipboardImage';
import type { BrowserController } from '../browser/browserController';
import { tabs as tabSource } from '../browser/tabSource';
import type { AnnotationChange } from '../browser/pageAnnotations';
import { chromeAnnotationSessions } from '../browser/chromeAnnotationSessions';
import type { PageAnnotation } from '../browser/annotationData';
import type {
	AgentId, AllAgentsChat, AgentUsage, ApprovalMode, AttachmentChip, AttachmentKind, ChatSummary, GitCommitState,
	ChatAccess, ChatNews, ChatTabSummary, ChatViewState, HostToView, RepoMode, Selection, ToolbarRun, ToolbarSkill, UsageAlert, UsageWindow, ViewToHost, VoiceEvent, WorkdirFolder, WorkdirState,
	ChatViewMode, ToolEntry, TerminalSupport, TerminalTabSummary, ChatSound, ChatSoundSettings,
} from './chatProtocol';
import { chatSounds } from './chatProtocol';
import { pickElementContext, pickForChat } from '../elements/elementPicker';
import { parseNews } from './news';
import { confirm, refuse } from '../core/notify';
import { timedInformation } from '../core/timedToast';
import { capAt, plainInLabel, plainInNotification, plainInPrompt } from '../core/notifyText';
import { browserApiState, onDidChangeGrantState, type BrowserApiState, hostIsRemote, isBrowserApiGranted, workspaceIsRemoteFromHost } from '../setup/proposedApi';
import { pageTitle } from '../translate/translateText';
import { generateUuid } from '../core/uuid';
import { runRowPrefix, ToolbarRuns, type SkillEnd } from './toolbarRun';
import type { ChatControl } from '../mcp/chatTools';
import { adaptSigils, fillPrompt, notificationText, toolbarLimits, validToolbarSkill } from './toolbarText';
import { closeAlert, closestLimit, currentLimits, mergeLimits, nextReset, readClosedAlerts, settleClosed, usageAlertFor, usageCheckDue, type ClosedAlerts, type LimitState, type TurnWeight } from './usageAlert';

/**
 * The AI Browser chat: a webview view in its own container in the secondary (right) side bar.
 *
 * **This is not the webview *panel* that CLAUDE.md closes to new features.**
 * That one hosts a page in an iframe and pays for it with every shortcut; this
 * one hosts our own UI and nothing else, and sits in a side bar, where it never
 * paints over a browser tab — so nothing here pauses the page
 * (breaks-silently #10). The same is why nothing below shows a QuickPick or a
 * modal: history, usage and the "+" menu are all drawn inside the view.
 *
 * The host owns the state and the webview renders it: every change is a whole
 * `ChatViewState`, coalesced to one post per 40 ms while text streams in.
 */

/**
 * **The chat lives in the secondary (right) side bar only**, beside Claude
 * Code's and Codex's, which is where people look for it. The `secondarySidebar`
 * view container contribution exists from VS Code 1.106; an older host ignores
 * it, so there the chat is simply absent — a left-hand fallback was built and
 * removed on request.
 */
export const chatViewId = 'aiBrowser.chat';

/**
 * Set below VS Code 1.106, and it has to exist although there is no fallback
 * container: **a view whose container the host does not know is not dropped,
 * it is moved into Explorer** ("View container '…' does not exist and all views
 * registered to it will be added to 'Explorer'"). So the view carries
 * `when: !aiBrowser.chatUnsupported`, and the chat's commands are hidden
 * from the palette by the same key — on those hosts `aiBrowser.chat.focus` does
 * not exist and every one of them would fail. Claude Code and Codex gate their
 * secondary side bar views on the same version.
 */
export const chatUnsupportedContextKey = 'aiBrowser.chatUnsupported';

/**
 * Set while the chat cannot run in this window — Restricted Mode or a remote
 * window (`chatBlocked`) — and cleared when the folder is trusted. The chat's
 * entries in the browser tab menu and its repeat buttons are gated on it, so a
 * remembered "Add … to AI Browser Chat" falls back to its Copy twin there
 * rather than refusing on every press (#223's shape).
 */
export const chatBlockedContextKey = 'aiBrowser.chatBlocked';

/**
 * Why the chat cannot run in this window at all, or `undefined`.
 *
 * - **VS Code before 1.106.** The view is hidden there by a context key, but a
 *   key is set at activation and the view can resolve first; this keeps any CLI
 *   from starting there regardless of which lands first.
 * - **Restricted Mode.** Both CLIs load the project's own configuration —
 *   Claude Code runs `.claude/settings.json` hooks, which are shell commands —
 *   so starting one in a folder the user has not trusted runs that folder's
 *   code. The same reasoning as Connect Codex and `git` (breaks-silently #208).
 * - **A remote window.** This extension runs on the local machine there, and
 *   the CLIs and the project are on the remote, so a CLI started here would
 *   work on the wrong machine.
 */
export function chatBlocked(): string | undefined {
	if (!supportsSecondarySidebar(vscode.version)) {
		return vscode.l10n.t("The chat needs VS Code 1.106 or later.");
	}
	if (!vscode.workspace.isTrusted) {
		return vscode.l10n.t("The chat is not available in Restricted Mode: Claude Code and Codex load this folder's own configuration, which can run commands. Trust the folder to use it.");
	}
	if (workspaceIsRemoteFromHost()) {
		return vscode.l10n.t("The chat is not available in a remote window yet: AI Browser runs on this machine, while the project is on the remote one.");
	}
	return undefined;
}

/** Whether this VS Code takes a `secondarySidebar` view container: 1.106 or later. */
export function supportsSecondarySidebar(version: string): boolean {
	const [major = 0, minor = 0] = version.split('.').map(part => parseInt(part, 10));
	return major > 1 || (major === 1 && minor >= 106);
}

const historyKey = 'aiBrowser.chat.history';
const selectionKey = 'aiBrowser.chat.selection';
/** The toolbar's skills, in order; global, so every project has the same toolbar. */
const toolbarKey = 'aiBrowser.chat.toolbar';
/**
 * A toolbar skill's prompts after the first, by skill id — kept apart from the
 * skills themselves, which an older build reads and writes back whole: it
 * rebuilds each skill without the field it does not know, so a toolbar edit
 * in a window not yet reloaded after an update stripped every skill's next
 * prompts. An older build never touches this key.
 */
const toolbarStepsKey = 'aiBrowser.chat.toolbarSteps';
/**
 * What came after 0.7.4 to a toolbar skill, by skill id, kept apart for the same
 * reason: `toast` (the result shown in a notification — stored in the skill
 * itself as `silent`, which is what an older build then does) and `notify`.
 * An older build reads an unknown `result` as `chat` and writes it back so.
 */
const toolbarExtrasKey = 'aiBrowser.chat.toolbarExtras';
/** The longest text a skill's notification shows; Open has the whole result. */
const skillToastLimit = 1_000;
const newsHiddenKey = 'aiBrowser.chat.newsHiddenAt';
/**
 * The plan-limit lines the user closed, by agent: each limit's percentage when
 * it was closed, and whether credits were being spent; see `usageAlert.ts`.
 * Global, like the plan it describes: closed in one window, closed in all.
 */
const closedAlertsKey = 'aiBrowser.chat.usageAlertsClosed';
/**
 * How long after a turn's end the plan is asked for: the provider counts the
 * turn's usage a moment after answering it.
 */
const usageCheckDelayMs = 2_000;
const inputHistoryKey = 'aiBrowser.chat.inputHistory';
const inputHistoryLimit = 100;
/**
 * The copy of each agent's CLI this project picked by hand, by path; absent is
 * Auto, the newest. Per project because a project can need an older CLI, and in
 * `workspaceState`, which only this UI writes — a repository cannot set it.
 */
const agentBinariesKey = 'aiBrowser.chat.agentBinaries';
/**
 * The approval menu, per workspace: a project is what a user trusts with
 * commands. `autoApproveKey` is the on/off toggle it replaced, read once to
 * carry an "on" over as terminal and browser on Auto.
 */
const approvalPolicyKey = 'aiBrowser.chat.approvalPolicy';
const approvalServersKey = 'aiBrowser.chat.approvalServers';
const autoApproveKey = 'aiBrowser.chat.autoApprove';
/** The menu's fixed categories, in its order; MCP servers come between `outside` and `other`. */
export const approvalCategories = ['web', 'browser', 'chat', 'command', 'edit', 'outside', 'other'] as const;
const approvalModes: readonly ApprovalMode[] = ['auto', 'ask', 'deny'];
/** Servers listed in the menu at most: one row each, and each is an agent's own config. */
const approvalServerLimit = 30;
/** The chats open as tabs, by chat id, and the one in front; restored with the window. */
const openTabsKey = 'aiBrowser.chat.openTabs';
/** The most of a terminal's screen that is kept across a restart of the editor, in UTF-16 units. */
const terminalHistoryUnits = 150_000;
/**
 * At most this many tabs, `aiBrowser.chat.tabLimit`: 10 unless set, 30 at most.
 * Each Claude Code tab is a `claude` process of its own (a Codex tab is only a
 * thread of the one app-server), and tabs working at once spend the plan's
 * limits at once — which is why there is a ceiling at all.
 */
export const defaultTabLimit = 10;
export const maxTabLimit = 30;
const tabLimitSetting = 'aiBrowser.chat.tabLimit';
const terminalLimitSetting = 'aiBrowser.chat.terminalLimit';
/** The most of a terminal's screen attached to a conversation (a paste into one is `terminalPasteLimit`, `terminalLogic.ts`). */
const terminalSelectionLimit = 4_000_000;
const collapseToolsSetting = 'aiBrowser.chat.collapseToolCalls';
const viewModeSetting = 'aiBrowser.chat.viewMode';
const chatViewModes: readonly ChatViewMode[] = ['minimal', 'compact', 'standard'];

/**
 * The thread's view mode: `aiBrowser.chat.viewMode` where it is set, else the
 * older Fold Tool Calls switch it replaced — off was Standard, anything else
 * Compact — so nobody's choice changed when the three modes came. Read with
 * `inspect`, not `get`, which would answer the declared default and hide the
 * older setting. A value that is not one of the three is not a choice.
 */
function readViewMode(): ChatViewMode {
	const config = vscode.workspace.getConfiguration();
	const info = config.inspect<unknown>(viewModeSetting);
	for (const value of [info?.workspaceFolderValue, info?.workspaceValue, info?.globalValue]) {
		if (typeof value === 'string' && (chatViewModes as readonly string[]).includes(value)) {
			return value as ChatViewMode;
		}
	}
	return config.get<unknown>(collapseToolsSetting) === false ? 'standard' : 'compact';
}
const automaticAwakeKey = 'aiBrowser.chat.automaticAwake';
/** The most of a tool's input or output opened in a tab; past it the text is cut with a line saying so. */
const openTextLimit = 2_000_000;

/** The setting as a whole number in range; anything else is the default (#184's rule). */
export function tabLimit(): number {
	const value = vscode.workspace.getConfiguration().get<unknown>(tabLimitSetting);
	return typeof value === 'number' && Number.isInteger(value) && value >= 1
		? Math.min(value, maxTabLimit)
		: defaultTabLimit;
}

/** Terminal tabs are counted apart from conversations: a shell spends no plan, a Claude tab does. */
export function terminalLimit(): number {
	return clampTerminalLimit(vscode.workspace.getConfiguration().get<unknown>(terminalLimitSetting));
}
const historyLimit = 50;
/** The folders picked with the folder button lately, newest first; for every window. */
const recentFoldersKey = 'aiBrowser.chat.recentFolders';
const recentFolderLimit = 8;
/** The GitHub repositories opened lately, `owner/name`, newest first; for every window. */
const recentReposKey = 'aiBrowser.chat.recentRepos';
/**
 * Folders the extension fetched from GitHub — copies and clones — whose own
 * Claude Code settings the user has not trusted yet; for every window. Kept
 * until trusted, at most `untrustedLimit` (the oldest drop off, and are then
 * trusted — never the other way round for a folder nobody marked).
 */
const untrustedFoldersKey = 'aiBrowser.chat.untrustedFolders';
const untrustedLimit = 200;
/** A project's own configuration files, which the folder button names when it holds them back. */
const projectConfigFiles = ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json', '.gemini/settings.json'];
/** A folder's listing is reused for this long: the button is opened again and again while a message is written. */
const workdirListingMs = 15_000;
/** Editor events come in bursts (a folder of files opened at once): one Git read for the lot. */
const gitEventDebounceMs = 300;
/**
 * The scheme a composer chip's text opens under: a read-only document, which
 * an untitled one is not — closing it would ask to save what was only shown.
 */
const attachmentScheme = 'ai-browser-attachment';
/** How long the globe button waits for the browser tab it opens, to attach it. */
const livePageWaitMs = 15_000;
/** Texts and images of chips opened recently, by chip id; a chip's content never changes. */
const openedAttachmentLimit = 30;
/** A conversation handed over in the message itself, with no folder to write it to: its newest part. */
const transcriptInlineLimit = 60_000;
const postDelayMs = 40;
/** A tab name, as typed into the tab: kept to what a tab, a history row and a heading can show. */
const tabTitleLimit = 80;

interface RememberedSelection {
	ultracode?: boolean;
	agent?: AgentId;
	models: Partial<Record<AgentId, string>>;
	/** Keyed by `<agent>:<model>`, so each model keeps its own position. */
	efforts: Record<string, string>;
}

/**
 * A toolbar skill sent into the chat, one per press: a list per skill, since a
 * second run (asked "run it again?") must not overwrite the first, whose end is
 * told on its own. `sending` until the send settles — before that the tab may
 * not be busy yet (detection can take seconds); `chains`, a skill of several
 * prompts, running while any of them still waits in the tab's queue — between
 * two of them the tab is idle for a moment, and the button would otherwise read
 * "done".
 */
interface ChatSkillRun {
	readonly tab: ChatTab;
	/** The conversation it was sent into: a tab cleared or given another since let go of it. */
	readonly chatId: string;
	sending: boolean;
	readonly chains?: string[];
	/** What its notification is made of, once its work in the tab is over. */
	readonly skill: ToolbarSkill;
	readonly values: Readonly<Record<string, string>>;
	/** The tab's Stop was pressed: the end is the user's, and is not told. */
	stopped?: boolean;
}


/** A voice message being recorded: for which tab and conversation, and what Enter or Space asked for. */
interface Voice {
	readonly recording: VoiceRecording;
	readonly tab: ChatTab;
	readonly chatId: string;
	action?: 'send' | 'attach';
}
interface GitCommitJob {
	state: GitCommitState;
	readonly controller: AbortController;
	readonly tab: ChatTab;
	readonly chatId: string;
	agent?: AgentId;
	proposedMessage?: string;
}

interface ChatServices {
	registry: AgentRegistry;
	git: GitAccess;
	panels: ChatPanelCatalog;
	runs: ToolbarRuns;
	views: Set<ChatViewProvider>;
}

/** What a push question is about: a yes counts only for the same push and the same question. */
/**
 * What a website session may not do through `chat.command` is the website's
 * column of `COMMANDS` (src/chat/core/commands.ts), checked in `remoteScope`
 * with the other refusals both entry points share; this adds the checks that
 * an inner id names the shared conversation. Approvals stay in the
 * editor (a remote Auto would run commands with no card), and nothing may
 * reach chats that were not shared, local files, terminals or the agent
 * binaries. A type with no row is refused. An inner id has to name the shared
 * conversation itself.
 */
/** `aiBrowser.chat.remoteTerminalShell` / `remoteTerminalAgent`: whether Chrome and the website may open a plain shell / an agent's CLI (application scope, read at every decision). */
export function remoteTerminalOpenSetting(kind: 'shell' | 'agent'): boolean {
	return vscode.workspace.getConfiguration('aiBrowser.chat').inspect<boolean>(kind === 'shell' ? 'remoteTerminalShell' : 'remoteTerminalAgent')?.globalValue === true;
}

/** `aiBrowser.chat.remoteTerminal`, read at every decision (application scope: a workspace cannot switch it on). */
export function remoteTerminalSetting(): boolean {
	return vscode.workspace.getConfiguration('aiBrowser.chat').inspect<boolean>('remoteTerminal')?.globalValue === true;
}

function exchangeRefusal(message: ExchangeUiMessage, tab: ChatTab, chatId: string): void {
	const m = message as { type: string; id?: unknown; tabId?: unknown; chatId?: unknown };
	if ((m.type === 'closeTab' || m.type === 'selectTab' || m.type === 'renameTab') && m.id !== tab.id) { throw new Error('This conversation is not shared.'); }
	if (m.type === 'resumeQueue' && m.tabId !== tab.id) { throw new Error('This conversation is not shared.'); }
	if (m.type === 'secondOpinion' && m.chatId !== chatId) { throw new Error('This conversation is not shared.'); }
}

function pushKey(action: string, branch: string, remote: string, target: string, question: string): string {
	return JSON.stringify([action, branch, remote, target, question]);
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private static _chromeConnectionRequest?: { id: string; extensionId: string; finish: (source?: string) => void };

	public static requestChromeConnection(id: string, extensionId: string, signal: AbortSignal): Promise<string | undefined> {
		if (signal.aborted || this._chromeConnectionRequest) { return Promise.resolve(undefined); }
		return new Promise(resolve => {
			const aborted = () => finish();
			const finish = (source?: string) => {
				if (this._chromeConnectionRequest?.id !== id) { return; }
				this._chromeConnectionRequest = undefined;
				signal.removeEventListener('abort', aborted);
				for (const view of this._surfaces.values()) { view._post(); }
				resolve(source);
			};
			this._chromeConnectionRequest = { id, extensionId, finish };
			signal.addEventListener('abort', aborted, { once: true });
			for (const view of this._surfaces.values()) { view._post(); }
		});
	}
	private readonly _stateSurfaces = new ChatStateSurfaces();
	private _themeTokens?: Record<string, string>;

	public static chromeSources(): { id: string; label: string; description: string; panelId: string }[] {
		return [...this._surfaces.values()].filter(view => !view._disposed && !!view._view).map(view => ({
			id: view._surfaceId, label: view._surfaceLabel(), description: view._active.chat.title, panelId: view._panelIdentity?.id ?? 'sidebar',
		}));
	}

	/** The panel holding a conversation, else the side bar's, else any open one: where a resumed Chrome goes. */
	public static chromeSourceFor(chatId: string | undefined, holding = false): string | undefined {
		const open = [...this._surfaces.values()].filter(view => !view._disposed && !!view._view);
		const owner = (chatId ? open.find(view => view._tabs.some(tab => tab.chat.id === chatId)) : undefined)?._surfaceId;
		if (holding) { return owner; }
		return owner
			?? open.find(view => !view._panelIdentity)?._surfaceId ?? open[0]?._surfaceId;
	}

	public static observeChromeSource(id: string, surface: ChatStateSurface): vscode.Disposable {
		const view = this._surfaces.get(id);
		if (!view || view._disposed || !view._view) { throw new Error('The source chat is no longer open'); }
		return view._stateSurfaces.attach(surface, chatId => view._stateFor(chatId), () => view._post());
	}
	/**
	 * The terminals of a surface as the Exchange hub sees them: only those shared with the website,
	 * and none while the window is blocked or the setting is off (re-asked on every call).
	 */
	public static exchangeTerminals(id: string): { find(terminalId: string): TerminalTab | undefined; shared(): TerminalTabSummary[]; support(): TerminalSupport; blocked(): boolean } {
		const live = () => { const view = this._surfaces.get(id); return view && !view._disposed ? view : undefined; };
		const blocked = () => { const view = live(); return !view || !!view._blocked() || !remoteTerminalSetting(); };
		return {
			blocked,
			find: terminalId => { const view = live(); const terminal = blocked() ? undefined : view?._terminals.find(terminalId); return terminal?.remote ? terminal : undefined; },
			shared: () => { const view = live(); return !view || blocked() ? [] : view._terminals.tabs.filter(t => t.remote).map(t => t.summary()); },
			support: () => { const view = live(); return view ? view._terminalSupport() : { available: false, reason: 'The chat is closed.' }; },
		};
	}

	public static exchangeViewerConnected(id: string): void {
		const view=this._surfaces.get(id);
		if(!view||view._disposed)return;
		const minutes=readExchangeAwakeMinutes(vscode.workspace.getConfiguration('aiBrowser.chat').get('exchangeKeepAwakeMinutes',60));
		view._sleep.connected(minutes);
	}

	public static async commandChromeSource(id: string, chatId: string, message: ViewToHost, picked: readonly ChromeElementAttachment[] = [], reply?: (message: HostToView, chatId?: string) => void, canonical?: (item:ChromeElementAttachment)=>Attachment|undefined): Promise<void> {
		// The website's `send` comes through here too, after its own check.
		const { view, tab } = remoteScope('chrome', this._surfaces.get(id), v => !v._disposed && v._view ? v._tabs.find(t => t.chat.id === chatId) : undefined, v => v._blocked(), remoteRefusal('chrome', message.type));
		if (chromeChatCommandFeature(message) !== 'chat') {
			await view._receiveChromeFooter(tab, message, reply); return;
		}
		if (message.type === 'newTerminal' || message.type === 'closeTerminal' || message.type === 'renameTerminal' || message.type === 'restartTerminal') {
			// The bridge asked for consent before this (`ChromeChatBridge._terminalConsentFor`).
			if (message.type === 'newTerminal' && message.pinTo !== undefined) { throw new Error('Pinning a terminal is done in VS Code.'); }
			await view._remoteTerminalCommand(tab, message); return;
		}
		if (message.type === 'send') {
			const stopGeneration = tab.stopGeneration;
			const attachments: Attachment[] = await Promise.all(picked.map(async element => {
				const canonicalItem=canonical?.(element);
				if(canonicalItem){const chip={...canonicalItem.chip};bindAttachmentReference(chip,element.reference);return {...canonicalItem,chip};}
				const chip = { id: element.id, kind: element.kind ?? 'element' as const, label: element.label };
				bindAttachmentReference(chip, element.reference);
				if (!element.file) { return { chip, text: element.text, ...(element.annotation ? { chromeAnnotation: { ...element.annotation, chatId } } : {}) }; }
				const data = Buffer.from(element.file.base64, 'base64');
				if (data.toString('base64') !== element.file.base64) { throw new Error('Invalid attachment data.'); }
				const project = view._workdir(tab);
				const saved = await writeExclusive(await projectTempDirectory(project, 'files'), `${generateUuid()}-${pastedFileName(element.file.name)}`, data);
				await trackTemporaryFile(saved, project);
				const imageType = pastedImageType(element.file.name, element.file.mime);
				return { chip, file: vscode.Uri.file(saved), text: `${element.text}\nAttached file: ${saved}`,
					image: imageType ? { mediaType: imageType, base64: element.file.base64 } : undefined };
			}));
			if (!view._tabs.includes(tab) || tab.chat.id !== chatId) { throw new Error('The destination chat is no longer open.'); }
			if (tab.stopGeneration !== stopGeneration) { throw new Error('The message was cancelled by Stop.'); }
			const selection = view._selection(tab);
			if (view._registry.detecting || !selection.agent || !selection.model || !view._registry.backend(selection.agent)) {
				throw new Error('Wait for an available agent and model in the editor.');
			}
			// Chrome has its own draft: never consume the editor's unsent attachments.
			void view._rememberInput(message.text);
			if (message.mode === 'queue' || tab.pendingSends.length || tab.paused) {
				tab.enqueue(message.text, attachments);
				view._drainQueues();
			} else {
				// Acceptance must not block Stop or an approval while a CLI is starting.
				void view._send(message.text, tab.id, attachments).catch(error => {
					tab.push({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
					tab.push({ kind: 'notice', text: `Not sent: ${message.text}` });
				});
			}
		} else if (message.type === 'openBrowser') {
			if(message.where!=='vscode')throw new Error('Open Chrome tabs in the Chrome side panel.');
			if(!isBrowserApiGranted())throw new Error('Enable the native browser API in VS Code and restart the editor before opening a remote browser tab.');
			view._awaitOpenedPage(tab);
			await tabSource.open('about:blank',{where:'vscode',preserveFocus:true});
		} else if (message.type === 'stop') {
			view._stopTab(tab);
		} else if (message.type === 'select' || message.type === 'switchAgent') {
			const scope = {tab, chatId, reply, remote: true};
			await view._chromeCommand.run(scope, () => view._receive(message));
			scope.chatId = scope.tab.chat.id;
			view._postMessage({type:'state', state:view._state()});
			if(scope.chatId!==chatId)reply?.({type:'focusInput'},scope.chatId);
			return;
		} else {
			await view._receive(message);
		}
		view._postMessage({ type: 'state', state: view._state() });
	}


	/** The web client uses the same controller with its conversation in async request scope. */
	private static readonly _exchangeAnnotationOwners=new Map<vscode.BrowserTab,{view:ChatViewProvider;chatId:string;reply:(message:HostToView,chatId?:string)=>void;ignored:Set<string>}>();
	private readonly _exchangeDrafts=new Map<string,Map<string,Attachment>>();
	public static releaseExchangeSource(id:string):void {
		const view=this._surfaces.get(id);view?._exchangeDrafts.clear();
		for(const [page,owner] of this._exchangeAnnotationOwners)if(owner.view._surfaceId===id)this._exchangeAnnotationOwners.delete(page);
	}
	public static async commandExchangeSource(id: string, chatId: string, message: ExchangeUiMessage, picked: readonly ChromeElementAttachment[] = [], reply?: (message: HostToView, chatId?: string) => void, browserTab?:vscode.BrowserTab): Promise<void> {
		const { view, tab } = remoteScope('exchange', this._surfaces.get(id), v => !v._disposed && v._view ? v._tabs.find(t => t.chat.id === chatId) : undefined, v => v._blocked(), message.type === 'history' ? undefined : remoteRefusal('exchange', message.type));
		exchangeRefusal(message, tab, chatId);
		if (message.type === 'newTerminal' || message.type === 'closeTerminal' || message.type === 'renameTerminal' || message.type === 'restartTerminal') {
			await view._remoteTerminalCommand(tab, message); return;
		}
		if (message.type === 'send') { await this.commandChromeSource(id, chatId, message, picked, reply,item=>view._exchangeDrafts.get(chatId)?.get(item.id)); return; }
		if(message.type==='removeAttachment'){
			view._exchangeDrafts.get(chatId)?.delete(message.id);
			for(const owner of this._exchangeAnnotationOwners.values())if(owner.view===view&&owner.chatId===chatId)owner.ignored.add(message.id);
			return;
		}
		if(message.type==='openBrowser'){
			// Chrome on the editor's machine: its tabs then appear in the website's Browser panel.
			if(message.where==='chrome'){const page=await vscode.commands.executeCommand<vscode.BrowserTab|undefined>('aiBrowser.openInChrome');if(!page)throw new Error('Google Chrome could not be opened on the VS Code machine.');}
			else {
				if(!isBrowserApiGranted())throw new Error('Enable the native browser API in VS Code and restart the editor before opening a remote browser tab.');
				// The no-argument workbench command opens the local address prompt.
				// Remote control needs an actual page target before it can navigate.
				await tabSource.open('about:blank',{where:'vscode',preserveFocus:true});
			}
			reply?.({type:'exchangeBrowser'},chatId);return;
		}
		if(message.type==='openLink'){
			if(!browserTab)throw new Error('Select a tab in the website Browser panel first.');
			const url=new URL(message.url);if(!['http:','https:'].includes(url.protocol))throw new Error('Only HTTP and HTTPS links can open in the remote browser.');
			await view._browser.remoteInput(view._browser.tabIdOf(browserTab),{action:'navigate',url:url.href});
			reply?.({type:'exchangeBrowser'},chatId);return;
		}
				if(message.type==='setWorkdir'&&message.path!==undefined){
			if(/[\0\r\n]/.test(message.path))throw new Error('Enter an absolute folder path on the computer running VS Code.');
			let folder=message.path.trim();
			if(folder==='~'||folder.startsWith('~/'))folder=path.join(os.homedir(),folder.slice(1));
			if(!folder||/[\0\r\n]/.test(folder)||!path.isAbsolute(folder))throw new Error('Enter an absolute folder path on the computer running VS Code.');
			if(!isDirectory(folder))throw new Error('The folder does not exist on the computer running VS Code.');
			message={type:'setWorkdir',path:folder};
		}
		if (message.type === 'closeTab') {
			await view._receive(message); reply?.({type:'focusInput'}, view._active.chat.id); return;
		}
		const scope = {tab,chatId,reply,remote:true};
		await view._chromeCommand.run(scope, async () => {
			if (message.type === 'ready') {
				reply?.({type:'inputHistory',items:view._inputHistory()},scope.chatId);
				for(const item of view._exchangeDrafts.get(chatId)?.values()??[])reply?.({type:'exchangeAttachment',id:item.chip.id,label:item.chip.label,text:item.text,kind:'annotation'},chatId);
			} else if (message.type === 'attach') {
				if(!browserTab)throw new Error('Select a tab in the website Browser panel first.');
				if(!['annotation','pointAnnotation','page','screenshot','element'].includes(message.kind))throw new Error('This attachment is available only in the local VS Code chat.');
				if(message.kind==='annotation'||message.kind==='pointAnnotation'){
					if(!reply)throw new Error('Remote annotation receiver is unavailable.');
					const owner={view,chatId,reply,ignored:new Set<string>()};this._exchangeAnnotationOwners.set(browserTab,owner);
					const existing=view._browser.annotationsOf(browserTab);
					if(existing)view._syncExchangeAnnotations({tab:browserTab,url:existing.url,records:existing.records,created:[],removed:[]},owner);
					try{await view._browser.annotateTab(browserTab,message.kind==='pointAnnotation'?'point':'element');}
					catch(error){if(this._exchangeAnnotationOwners.get(browserTab)===owner)this._exchangeAnnotationOwners.delete(browserTab);throw error;}
					reply({type:'exchangeBrowser',message:'Click the remote page to add an annotation.'},chatId);
				}else{
					if(message.kind==='element')reply?.({type:'exchangeBrowser',message:'Click an element in the remote page to attach it.'},chatId);
					const item=await view._makeAttachment(message.kind,browserTab,true);
					if(item){
						const file=item.image?{name:'screenshot.png',mime:item.image.mediaType,base64:item.image.base64}:undefined;
						if(file&&file.base64.length>5_333_336)throw new Error('Screenshot exceeds the 4 MB attachment limit.');
						reply?.({type:'exchangeAttachment',id:item.chip.id,label:item.chip.label,text:item.text??item.chip.label,kind:message.kind==='screenshot'?'screenshot':message.kind==='page'?'page':'element',file},chatId);
					}
				}
			} else if (message.type === 'history') { view.showHistory(); }
			else if (chromeChatCommandFeature(message) !== 'chat') { await view._receiveChromeFooter(scope.tab,message,reply); }
			else { await view._receive(message); }
		});
		if (scope.tab.chat.id !== scope.chatId) { scope.chatId = scope.tab.chat.id; }
		if (scope.chatId !== chatId) { reply?.({type:'focusInput'},scope.chatId); }
		view._post();
	}

	private readonly _chromeCommand = new AsyncLocalStorage<{ tab: ChatTab; chatId: string; remote?: boolean; reply?: (message: HostToView, chatId?: string) => void }>();

	/** Async request scope keeps folder/skill/Git actions bound to Chrome's conversation. */
	private async _receiveChromeFooter(tab: ChatTab, message: ViewToHost, reply?: (message: HostToView, chatId?: string) => void): Promise<void> {
		if ('tabId' in message && message.tabId !== undefined && message.tabId !== tab.id) { throw new Error('The destination conversation changed. Try again.'); }
		const scope = { tab, chatId: tab.chat.id, reply, remote: this._chromeCommand.getStore()?.remote };
		await this._chromeCommand.run(scope, async () => {
			const target = message.type === 'runToolbarSkill' ? { ...message, tabId: tab.id } : message;
			if (target.type === 'refreshWorkdirGit') {
				const folder = this._workdir(tab);
				if (folder) { await this._readWorkdirGit(folder, target.fetch); }
			} else if (target.type === 'attachPath') {
				const folder = this._workdir(tab);
				if (!folder || !target.path || /[\0\r\n]/.test(target.path)) { throw new Error('Invalid project path.'); }
				const file = path.resolve(folder, target.path), relative = path.relative(folder, file);
				if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) { throw new Error('Select a path inside the working folder.'); }
				const stat = await fs.promises.stat(file);
				if (!this._tabs.includes(tab) || tab.chat.id !== scope.chatId || this._workdir(tab) !== folder) { throw new Error('The destination conversation changed. Select the file again.'); }
				reply?.({ type: 'chromeAttachment', label: `${path.basename(file)}${stat.isDirectory() ? '/' : ''}`, text: `Attached ${stat.isDirectory() ? 'folder' : 'file'}: ${file}` }, tab.chat.id);
			} else { await this._receive(target); }
		});
		this._postMessage({ type: 'state', state: this._state() });
		if (scope.tab !== tab) { reply?.({ type: 'focusInput' }, scope.tab.chat.id); }
	}

	/**
	 * The state of one conversation of this panel as if it were in front, for a
	 * surface pinned to it. Synchronous, so nothing else can see the swap; it
	 * does not mark the tab read, since nobody in the editor is looking at it.
	 */
	private _stateFor(chatId?: string): ChatViewState {
		if (this._chromeCommand?.getStore()) { return this._chromeCommand.exit(() => this._stateFor(chatId)); }
		const tab = chatId ? this._tabs.find(t => t.chat.id === chatId) : undefined;
		if (!tab || tab === this._active) { return this._state(); }
		return this._asActive(tab, () => this._state());
	}

	/**
	 * Stop is for everything this tab was going to do: the queue does not go
	 * out after it. What was queued comes back to the box, attachments with it,
	 * to send or drop.
	 */
	private _stopTab(tab: ChatTab): void {
		this._giveBackQueue(tab);
		tab.stop();
		// A skill sent into this tab was stopped by the user, not ended: no notification.
		for (const run of [...this._chatSkillTabs.values()].flat()) {
			if (run.tab === tab) {
				run.stopped = true;
			}
		}
		this._post();
	}

	private _peeking = false;
	/** Runs a synchronous step with `tab` in front, then puts the real one back. */
	private _asActive<T>(tab: ChatTab, run: () => T): T {
		const active = this._active, peeking = this._peeking;
		this._active = tab; this._peeking = true;
		try { return run(); }
		finally { this._active = active; this._peeking = peeking; }
	}
	private static readonly _terminalSessions = new Map<string, vscode.Terminal>();
	/**
	 * Which conversation tab each terminal is pinned to, for every surface of this extension host: a
	 * tab moved to another surface keeps its pins, and a terminal is resolved across all of them.
	 * Memory only — terminal ids die with the host. See `terminalPins.ts`.
	 */
	private static readonly _pins = new TerminalPins();
	/**
	 * The approvals of typing into a terminal: minted when the user (or the approval menu) answers the
	 * card of a `terminal_send` / `terminal_key`, consumed by the tool (`src/mcp/terminalGrants.ts`).
	 * One store for every surface.
	 */
	public static readonly terminalGrants = new TerminalGrants();
	private static readonly _surfaces = new Map<string, ChatViewProvider>();
	private static _sharedServices?: ChatServices;
	private readonly _surfaceId = generateUuid();
	private readonly _surfaceNumber: number = 1;
	private readonly _dragToken = generateUuid();
	private _surfaceSignature = '';
	private readonly _draftRequests = new Map<string, { resolve: (draft: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; tab: ChatTab; chatId: string }>();
	private _tabDrag?: { id: string; chatId: string; draft: string; at: number };
	private readonly _sleep: SleepControl;
	private _view: Pick<vscode.WebviewView, 'webview' | 'visible' | 'onDidChangeVisibility' | 'onDidDispose'> | undefined;
	private readonly _attachmentScheme = `${attachmentScheme}-${generateUuid()}`;
	private static _openingWindow = false;
	private _panel?: vscode.WebviewPanel;
	private readonly _windows = new Set<vscode.WebviewPanel>();
	private readonly _pendingPanels = new Map<string, ChatViewProvider>();
	private readonly _savedDrafts = new Map<string, string>();
	private _draftSaveTimer?: ReturnType<typeof setTimeout>;
	private _shuttingDown = false;
	private _lifetimeOwner?: ChatViewProvider;
	private readonly _services: ChatServices;
	private _viewReady = false;
	private _queued: HostToView[] = [];
	private readonly _registry: AgentRegistry;
	/** The open conversations, in the order of their tabs; `_active` is the one shown. */
	private _tabs: ChatTab[] = [];
	private _frontActive!: ChatTab;
	private get _active(): ChatTab { const scope = this._chromeCommand?.getStore(); return scope?.remote ? scope.tab : this._frontActive; }
	private set _active(tab: ChatTab) { const scope = this._chromeCommand?.getStore(); if (scope?.remote) { scope.tab = tab; scope.chatId = tab.chat.id; } else { this._frontActive = tab; } }
	/**
	 * The terminal tabs and the one in front. Never in `_tabs`: they are not
	 * conversations, and `_active` stays the last conversation while one shows.
	 * A conversation is selected → `clearFront`, never through the `_active`
	 * setter, which `_asActive` swaps for a moment.
	 */
	private readonly _terminals = new TerminalSet(
		() => terminalLimit(),
		message => this._postTerminal(message),
		() => { this._post(); this._scheduleTerminalSave(); },
		() => ({ gate: new AgentTypingGate(), unread: new UnreadTracker() }),
	);
	private _terminalHostInstance: TerminalHost | undefined;
	/** A terminal was left (`_leaveTerminal`) and the state that says so has not been posted yet. */
	private _terminalLeftPending = false;
	/** A `focusInput` was asked for meanwhile: posted right after that state, as `terminalFocus` is. */
	private _focusAfterState = false;
	/** Terminals being started: counted against the limit before they are tabs. */
	private _terminalsStarting = 0;
	/** The agent picked for a conversation that has started with another: asked about in the view. */
	private readonly _agentSwitches = new WeakMap<ChatTab, AgentId>();
	private get _switchTo(): AgentId | undefined { return this._agentSwitches.get(this._active); }
	private set _switchTo(agent: AgentId | undefined) { const tab = this._active; if (agent) { this._agentSwitches.set(tab, agent); } else { this._agentSwitches.delete(tab); } }
	private _tabsSaved = '';
	/** NEWS.md from the installed extension, read once; see `news.ts`. */
	private _news: ChatNews | undefined;
	private readonly _attachmentTexts = new Map<string, string>();
	/** Live page chips, by chip id, and the browser tab each follows. */
	private readonly _livePages = new Map<string, vscode.BrowserTab>();
	private _livePageWatch: vscode.Disposable | undefined;
	/**
	 * Page annotations, by annotation id: the chat tab that took it first (closing
	 * that tab deletes it), the browser tab it is on, and its chips in any tab.
	 */
	private readonly _annotationLinks = new Map<string, { chat: ChatTab; page: vscode.BrowserTab; chipIds: string[] }>();
	/** The globe button's wait for the tab it opens. */
	private _pendingOpen: vscode.Disposable | undefined;
	private readonly _attachmentImages = new Map<string, vscode.Uri>();
	private readonly _tabHost: TabHost = {
		ultracodeDefault: () => this._context.globalState.get<RememberedSelection>(selectionKey)?.ultracode ?? this._remembered.ultracode ?? false,
		cwd: () => this._windowCwd(),
		projectRoot: () => vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file')?.uri.fsPath,
		ownSettings: folder => !this._untrusted(folder),
		changed: () => { this._post(); this._drainQueues(); },
		limits: (agent, windows, usingCredits) => this._noteLimits(agent, windows, usingCredits, false),
		turnEnded: (agent, weight) => this._turnEnded(agent, weight),
		authenticationError: (agent, text) => this._registry.authenticationError(agent, text),
		save: chat => this._save(chat),
		inHistory: id => this._history().some(c => c.id === id),
		approvalMode: key => this._approvalPolicy()[key] ?? 'ask',
		noteServer: server => this._noteServer(server),
		released: chatId => this._runs.stopChat(chatId),
		pinnedTerminals: tab => ChatViewProvider._pinnedInfos(tab),
		dropPins: tab => { if (ChatViewProvider._pins.dropTab(tab.id).length) { ChatViewProvider._postAll(); } },
		mintTerminalGrant: (chatId, approval) => { mintTerminalGrant(ChatViewProvider.terminalGrants, chatId, approval); },
	};
	private _remembered: RememberedSelection;
	private readonly _runs = new ToolbarRuns({
		approvalMode: key => this._approvalPolicy()[key] ?? 'ask',
		noteServer: server => this._noteServer(server),
		changed: () => { for (const view of this._services.views) { view._post(); } },
		ended: (skill, end) => this._skillEnded(skill, end),
	});
	/** What is known of each agent's plan limits; see `_noteLimits`. */
	private readonly _limits = new Map<AgentId, LimitState>();
	/** When each agent's plan was last asked for after a turn; see `usageCheckDue`. */
	private readonly _usageAsked = new Map<AgentId, number>();
	/** An agent's plan being asked for after a turn, by its timer while it waits. */
	private readonly _usageChecks = new Map<AgentId, ReturnType<typeof setTimeout> | undefined>();
	/** Posts when the next limit of the agent in front resets, so the line and `U` follow it. */
	private _resetTimer: { at: number; timer: ReturnType<typeof setTimeout> } | undefined;
	private _postTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly _subscriptions: vscode.Disposable[] = [];
	private _nativeBrowser: BrowserApiState | undefined;
	private readonly _projectId: string;

	/**
	 * `browserServer`: the extension's MCP server while it runs, handed to every
	 * CLI the chat starts so the agents have the browser tools without Connect.
	 */
	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _browser: BrowserController,
		private readonly _browserServer: () => BrowserServer | undefined = () => undefined,
		private readonly _recording?: BrowserRecording,
		private readonly _detachedChat?: StoredChat,
		_transfer?: { tab?: ChatTab; services: ChatServices },
		private readonly _restoredPanel?: ChatPanelIdentity,
	) {
		// Freeze the owner for this surface: changing a working folder must not
		// move its saved conversation set into another project's session.
		this._projectId = chatProjectId(vscode.workspace.workspaceFile?.toString(),
			(vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.toString()), _context.storageUri?.toString());
		if (_restoredPanel) { this._surfaceNumber = _restoredPanel.number; }
		const shared = _transfer?.services ?? ChatViewProvider._sharedServices;
		this._registry = shared?.registry ?? new AgentRegistry(() => this._cwd(), id => this._agentBinaries()[id], _browserServer, () => !this._untrusted(this._cwd()), this._openrouterConfig());
		void sweepBrowserConfigs().catch(() => { /* swept with the temp directory */ });
		if (shared) { this._runs = shared.runs; this._gitAccess = shared.git; }
		this._services = shared ?? { registry: this._registry, git: this._gitAccess,
			panels: new ChatPanelCatalog(_context.workspaceState, `aiBrowser.chat.panelCatalog.project.${this._projectId}`, panel => {
				const old = _context.workspaceState.get<SavedChatTabs>(`${openTabsKey}.panel.${panel.id}`);
				const tabs = legacyProjectTabs(old, this._projectId);
				return Array.isArray(tabs?.ids) && tabs.ids.length > 0;
			}), runs: this._runs, views: new Set() };
		if (!_restoredPanel && _detachedChat) { this._surfaceNumber = this._freeSurfaceNumber(); }
		this._services.views.add(this);
		ChatViewProvider._sharedServices = this._services;
		if (_restoredPanel) {
			for (const [id, draft] of Object.entries(this._services.panels.panels.get(_restoredPanel.id)?.drafts ?? {})) { this._savedDrafts.set(id, draft); }
		}
		this._subscriptions.push(exchangeConnection.onDidChange(() => this._post()));
		this._subscriptions.push(this._registry.onDidChange(() => this._post()));
		if (_recording) { this._subscriptions.push(_recording.onDidChange(() => this._postRecording())); }
		this._remembered = _context.globalState.get<RememberedSelection>(selectionKey) ?? { models: {}, efforts: {} };
		if (_restoredPanel) {
			this._restoreTabs();
		} else if (_detachedChat) {
			this._active = _transfer?.tab ?? new ChatTab(this._tabHost, _detachedChat);
			this._tabs.push(this._active);
		} else {
			this._restoreTabs();
		}
		const savedStashes = _context.workspaceState.get<Record<string, { hash: string; branch: string }[]>>('aiBrowser.branchStashes') ?? {};
		for (const [folder, entries] of Object.entries(savedStashes)) {
			if (!Array.isArray(entries)) { continue; }
			const valid = entries.filter(entry => entry && /^[a-f0-9]{40,64}$/.test(entry.hash) && typeof entry.branch === 'string' && !entry.branch.startsWith('-') && !/[\0\r\n]/.test(entry.branch));
			if (valid.length) { this._branchStashes.set(folder, valid); }
		}
		this._sleep = new SleepControl(
			// A tab that has closed works no more, so a hold scoped to it ends; nor
			// does a queue held by `chat_pause`, or it would hold the computer for good.
			tabId => (tabId === undefined ? this._tabs : this._tabs.filter(t => t.id === tabId))
				.some(t => t.busy || t.waiting || (t.queuedCount > 0 && !t.paused) || this._runs.runningIn(t.chat.id) > 0),
			() => { this._publishSleep(); this._post(); },
			hostIsRemote() ? "Sleep prevention requires a local VS Code window." : undefined,
		);
		this._sleep.setAutomatic(_context.globalState.get(automaticAwakeKey) === true);
		void this._readNews();
		// "Continue in …" writes into the conversation's folder; the activation
		// sweep reaches only the workspace's.
		void cleanUpReportsIn([...this._recentFolders(), ...this._tabs.flatMap(t => t.chat.folder !== undefined ? [t.chat.folder] : [])]);

		this._subscriptions.push(this._browser.onDidChangeAnnotations(change => this._onAnnotations(change)));
		this._subscriptions.push(this._registry.onDidReplace(e => this._onBackendReplaced(e.agent, e.gone)));
		// Every read of a plan whole — detection's, the U popup's, the checks
		// after a turn — replaces what was known of it.
		this._subscriptions.push(this._registry.onDidReadUsage(u => this._noteLimits(u.agent, u.windows, u.usingCredits, true)));
		// A lower limit closes nothing: the tabs open stay, and "+" comes back
		// once enough of them are closed.
		this._subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('workbench.iconTheme') || e.affectsConfiguration('files.associations')) { this._gitEventRefresh(); this._postFileIcons(); }
			if (terminalSettingKeys.some(key => e.affectsConfiguration(key))) { this._postTerminalSettings(); }
			if (e.affectsConfiguration('aiBrowser.chat.sound') || e.affectsConfiguration('aiBrowser.chat.notifications')) { this._post(); }
			if (e.affectsConfiguration('aiBrowser.chat.remoteTerminal')) { this._postMessage({ type: 'remoteTerminalSettings', remoteTerminal: remoteTerminalSetting(), shell: remoteTerminalOpenSetting('shell'), agent: remoteTerminalOpenSetting('agent') }); }
			if (e.affectsConfiguration(terminalLimitSetting) || e.affectsConfiguration(tabLimitSetting) || e.affectsConfiguration(collapseToolsSetting) || e.affectsConfiguration(viewModeSetting) || e.affectsConfiguration('aiBrowser.chat.exchangeKeepAwakeMinutes') || e.affectsConfiguration('aiBrowser.chat.remoteTerminal') || e.affectsConfiguration('aiBrowser.chat.remoteTerminalShell') || e.affectsConfiguration('aiBrowser.chat.remoteTerminalAgent')) {
				this._post();
			}
		}));
		// These change only how the footer's files are drawn (their icons), so
		// they go through `_gitEventRefresh`: debounced, and only while the view
		// is on screen.
		this._subscriptions.push(vscode.window.onDidChangeActiveColorTheme(() => { this._gitEventRefresh(); this._postFileIcons(); }));
		// The suggested file follows the text editor in front.
		this._subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => this._post()));
		this._subscriptions.push(vscode.window.onDidChangeWindowState(() => this._post()));
		// A selection there is suggested in its place. Every cursor move fires
		// this, so the state is posted only when the selection itself changes.
		let lastSelection: string | undefined;
		this._subscriptions.push(vscode.window.onDidChangeTextEditorSelection(event => {
			if (event.textEditor !== vscode.window.activeTextEditor) { return; }
			const key = editorSelectionKey(event.textEditor);
			if (key === lastSelection) { return; }
			lastSelection = key;
			this._post();
		}));
		// …and the suggested page the editor tab in front, which a switch to a
		// non-text editor or between groups changes without that event.
		this._subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(event => {
			if (!this._shuttingDown) {
				for (const tab of event.closed) {
					for (const pending of this._pendingPanels.values()) {
						if (tab.label === pending._surfaceLabel() && tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('aiBrowser.chat.window')) { pending.dispose(); }
					}
				}
			}
			this._post();
		}));
		this._subscriptions.push(vscode.window.tabGroups.onDidChangeTabGroups(() => this._post()));
		// Changing a document's language fires close/open events in VS Code.
		this._subscriptions.push(vscode.workspace.onDidOpenTextDocument(() => this._gitEventRefresh()));
		this._subscriptions.push(vscode.workspace.onDidCloseTextDocument(() => this._gitEventRefresh()));
		this._subscriptions.push(vscode.extensions.onDidChange(() => { this._gitEventRefresh(); this._postFileIcons(); }));
		this._subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(this._attachmentScheme, {
			// An editor restored after a reload asks for a chip this window never
			// held, and gets a sentence rather than an empty page.
			provideTextDocumentContent: uri => uri.path.startsWith('/git-diff-empty/') ? '' : this._attachmentTexts.get(uri.query)
				?? vscode.l10n.t("This attachment was shown in an earlier session and is no longer available. Attach it again to see it."),
		}));
		// Trust granted while the view was showing its Restricted Mode notice:
		// detection never ran, so run it now rather than wait for a Refresh.
		this._subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => {
			this._post();
			if (this._viewReady && !this._blocked() && !this._registry.detecting) {
				void this._registry.detect();
			}
		}));
		// Only to keep the "+" menu's page entries in step with the open tabs of
		// both browsers. `tabSource` reads the proposal behind the grant (#11).
		this._subscriptions.push(
			tabSource.onDidOpen(() => this._post()),
			tabSource.onDidClose(() => this._post()),
			tabSource.onDidChangeActive(() => this._post()),
			// The suggested page's chip names the page, which can change under it.
			tabSource.onDidChangeState(() => this._post()),
		);
		const refreshNativeBrowser = async () => {
			this._nativeBrowser = await browserApiState();
			this._post();
		};
		void refreshNativeBrowser();
		this._subscriptions.push(onDidChangeGrantState(() => void refreshNativeBrowser()));
		ChatViewProvider._surfaces.set(this._surfaceId, this);
		if (!this._panelIdentity) { this._restorePendingPanels(); }
	}

	/**
	 * The news shown in an empty chat comes from the installed extension's own
	 * NEWS.md — not the repository, which a user does not have — so it always
	 * describes the build that is running. Read once: it cannot change without
	 * an update, and an update restarts the extension host.
	 */
	private async _readNews(): Promise<void> {
		try {
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this._context.extensionUri, 'NEWS.md'));
			this._news = parseNews(new TextDecoder().decode(bytes));
			this._post();
		} catch {
			// No news is not an error: the welcome falls back to its own line.
		}
	}

	/** The menu's modes; a key not set asks. The old toggle's "on" reads as terminal and browser on Auto. */
	private _approvalPolicy(): Record<string, ApprovalMode> {
		const stored = this._context.workspaceState.get<unknown>(approvalPolicyKey);
		if (stored && typeof stored === 'object') {
			return Object.fromEntries(Object.entries(stored as Record<string, unknown>)
				.filter((e): e is [string, ApprovalMode] => approvalModes.includes(e[1] as ApprovalMode)));
		}
		return this._context.workspaceState.get<boolean>(autoApproveKey) === true ? { command: 'auto', browser: 'auto' } : {};
	}

	private _approvalServers(): string[] {
		const stored = this._context.workspaceState.get<unknown>(approvalServersKey);
		return Array.isArray(stored) ? stored.filter((s): s is string => typeof s === 'string' && s !== '') : [];
	}

	/** A server is listed in the menu once an agent has asked about one of its tools. */
	private _noteServer(server: string): void {
		const servers = this._approvalServers();
		// The name is the key the menu's mode is looked up by, so it is listed as
		// it is or not at all — a cut name would never match its server again.
		if (servers.includes(server) || servers.length >= approvalServerLimit || server.length > 80) {
			return;
		}
		this._context.workspaceState.update(approvalServersKey, [...servers, server].sort()).then(() => this._post(), () => { /* a convenience */ });
	}

	private _newsHidden(): boolean {
		const hiddenAt = this._context.globalState.get<string>(newsHiddenKey);
		return hiddenAt !== undefined && hiddenAt === (this._news?.entries[0]?.title ?? '');
	}

	/* ------------------------------------------------------------ webview */
	private _postRecording(): void {
		const current = this._recording?.current;
		const phase = current?.state;
		this._postMessage({ type: 'recordingStatus', seconds: current?.durationSeconds ?? 0,
			state: phase === 'starting' || phase === 'recording' || phase === 'paused' || phase === 'stopping' ? phase : undefined });
	}
	private _videoEncoder?: { id: string; messages: vscode.EventEmitter<any>; host: RecordingEncoder };

	public createRecordingEncoder(id: string): RecordingEncoder {
		this._videoEncoder?.host.dispose();
		const messages = new vscode.EventEmitter<any>();
		const closed = new vscode.EventEmitter<void>();
		let disposed = false;
		const host: RecordingEncoder = {
			webview: { onDidReceiveMessage: messages.event, postMessage: message => {
				if (disposed || !this._view || !this._viewReady) { return Promise.resolve(false); }
				return this._view.webview.postMessage({ type: 'recording', id, message });
			} },
			onDidDispose: closed.event,
			dispose: () => {
				if (disposed) { return; }
				disposed = true;
				if (this._videoEncoder?.id === id) { this._videoEncoder = undefined; }
				this._postMessage({ type: 'recording', id, message: { type: 'close' } });
				closed.fire(); messages.dispose(); closed.dispose();
			},
		};
		this._videoEncoder = { id, messages, host };
		// Defer until the recording host has subscribed to ready/error events.
		void Promise.resolve().then(async () => {
			if (disposed) { return; }
			const needsView = !this._viewReady;
			this._postMessage({ type: 'recording', id, message: { type: 'open' } });
			if (needsView) {
				await this._focusView();
				await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
			}
		}).catch(error => messages.fire({ type: 'error', error: String(error) }));
		return host;
	}

	private async _focusView(): Promise<void> {
		if (!this._panel && this._panelIdentity) { await this._materializePanel(); }
		if (this._panel) { this._panel.reveal(); }
		else { await vscode.commands.executeCommand(`${chatViewId}.focus`); }
	}

	public resolveWebviewView(view: vscode.WebviewView): void {
		this._bindView(view);
	}

	private _bindView(view: NonNullable<ChatViewProvider['_view']>): void {
		this._view = view;
		for (const surface of ChatViewProvider._surfaces.values()) { surface._post(); }
		this._viewReady = false;
		const media = vscode.Uri.joinPath(this._context.extensionUri, 'media');
		// With the icon theme's folder from the start: adding it at the first
		// theme read would make VS Code reload the page (`chatResourceRoots`).
		view.webview.options = { enableScripts: true, localResourceRoots: chatResourceRoots(media) };
		view.webview.html = this._html(view.webview, media);
		view.webview.onDidReceiveMessage((message: ViewToHost) => {
			this._receive(message).catch(err => this._fail(err));
		}, undefined, this._subscriptions);
		// Shown again: the tab in front is read now, not at its next change — and
		// the footer's Git state, if an editor event was let pass while hidden.
		view.onDidChangeVisibility(() => {
			this._post();
			if (view.visible && this._gitStale) { this._gitEventRefresh(); }
		}, undefined, this._subscriptions);
		view.onDidDispose(() => {
			if (this._view === view) {
				this._stateSurfaces.dispose();
				this._view = undefined;
				for (const surface of ChatViewProvider._surfaces.values()) { surface._post(); }
				this._viewReady = false;
				// The terminals' shells go on, as they do for a hidden view; what was
				// in flight to the page that is gone is given back.
				this._terminals.detachAll();
				this._videoEncoder?.host.dispose();
				// Nothing can show what a conversation does once its view is gone,
				// so its CLI is not left working unseen on the user's quota. The
				// chat is saved and resumes from the history; Codex's app-server
				// then goes idle and shuts down on its own.
				// `'view'`: the same tabs are shown again when the view comes back,
				// and must not come back marked closed.
				for (const tab of this._tabs) {
					tab.close('view');
				}
				// The toolbar's background runs too: their button and its question
				// went with the view. The skills sent into the chat ended with their
				// tabs' turns, the user's doing — not told.
				for (const tab of this._tabs) { this._runs.stopChat(tab.chat.id); }
				this._chatSkillTabs.clear();
				// A recording nobody can see is not left listening to the microphone.
				this._voiceCancel();
			}
		}, undefined, this._subscriptions);
	}

	private _html(webview: vscode.Webview, media: vscode.Uri): string {
		const nonce = generateUuid();
		const uri = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, name)).toString();
		return /* html */ `<!DOCTYPE html>
			<html>
			<head>
				<meta http-equiv="Content-type" content="text/html;charset=UTF-8">
				<meta http-equiv="Content-Security-Policy" content="
					default-src 'none';
					font-src data: ${webview.cspSource};
					img-src data: ${webview.cspSource};
					media-src blob:;
					style-src ${webview.cspSource} 'nonce-${nonce}';
					script-src 'nonce-${nonce}';
					">
				<meta name="viewport" content="width=device-width, initial-scale=1">
				<link rel="stylesheet" href="${uri('codicon.css')}">
				<link rel="stylesheet" href="${uri('xterm.css')}">
				<link rel="stylesheet" href="${uri('chat.css')}">
			</head>
			<body>
				<div id="app"></div>
				<script nonce="${nonce}" src="${uri('chat.js')}"></script>
			</body>
			</html>`;
	}

	/**
	 * Until the webview's script has said `ready`, a post is lost — it is not
	 * queued by VS Code — so anything sent before that waits here. A view the
	 * user has never opened is the common case: a title-bar command reveals it
	 * and posts in the same breath.
	 */
	private _fileIconsRequest = 0;
	private _fileIconTable?: FileIconTable;
	/**
	 * The file icon theme's table for the names in the conversation, sent on
	 * `ready` and whenever the theme, the colour theme's kind, an association or
	 * the installed extensions change. Only to a live view: a table is a
	 * snapshot, and `ready` asks for a fresh one. The newest request wins.
	 */
	private _postFileIcons(): void {
		const view = this._view;
		if (!view || !this._viewReady) { return; }
		const request = ++this._fileIconsRequest;
		const media = vscode.Uri.joinPath(this._context.extensionUri, 'media');
		loadFileIconTable(view.webview, media).catch(() => undefined).then(table => {
			if (request !== this._fileIconsRequest) { return; }
			this._fileIconTable = table;
			if (this._view === view && this._viewReady) {
				void view.webview.postMessage({ type: 'fileIcons', table } satisfies HostToView);
			}
		});
	}

	private _postMessage(message: HostToView): void {
		const command = this._chromeCommand?.getStore();
		if (command && message.type !== 'state') {
			if (this._tabs.includes(command.tab) && command.tab.chat.id === command.chatId) { command.reply?.(message, command.chatId); }
			return;
		}
		if (message.type === 'workdirGit') { this._stateSurfaces.broadcast(message); }
		if (message.type === 'state') {
			const shown = message.state.chatId;
			this._stateSurfaces.publish(chatId => !chatId || chatId === shown ? message.state : this._stateFor(chatId));
		}
		if (!this._view || !this._viewReady) {
			// `workdirGit` is a snapshot, not an event: a stale one is worth
			// nothing to a view that asks for its own on `ready`, and queued it
			// piled up for the window's lifetime — one per document opened —
			// while the chat view was never opened.
			if (message.type !== 'state' && message.type !== 'workdirGit') {
				this._queued.push(message);
			}
			return;
		}
		// `typeof`: tests lift `_postMessage` into a sandbox without the rest of the class.
		void this._view.webview.postMessage(message.type === 'state' && typeof this._windowed === 'function' ? { type: 'state', state: this._windowed(message.state) } : message);
	}

	/**
	 * The editor's view is sent the last turns of the conversation too, not all of it: a long chat
	 * kept every entry in the webview's DOM and memory. Earlier turns come with `loadEarlier`; a
	 * `reset` from a view back at the end drops them again. Per conversation, back to the default
	 * when another one is shown.
	 */
	private _editorPrompts = 0;
	private _editorWindowChat?: string;
	private _windowed(state: ChatViewState): ChatViewState {
		if (this._editorWindowChat !== state.chatId) { this._editorWindowChat = state.chatId; this._editorPrompts = currentVisibleTurns(); }
		const window = windowEntries(state.entries, this._editorPrompts);
		return window.offset ? { ...state, entries: window.entries, entriesOffset: window.offset } : state;
	}

	/** Coalesces state posts: a streaming reply changes the state many times a frame. */
	private _sleepShown?: boolean;
	/** The voice message being recorded, the tab it is for, and what Enter or Space asked for. */
	private _voice?: Voice;
	/** Bumped by every start and cancel: a start that awaited across one of them goes no further. */
	private _voiceGeneration = 0;
	/** The chip the last transcript left, until the next start: what a cancel that crossed it takes back. */
	private _voiceAttached?: { tab: ChatTab; chipId: string };
	/** The title bar shows an empty or a filled cup, by context key. */
	private _publishSleep(): void {
		if (this._panelIdentity) { return; }
		const on = this._sleep.state.mode !== 'off' || this._sleep.state.automaticActive === true;
		if (on !== this._sleepShown) {
			this._sleepShown = on;
			void vscode.commands.executeCommand('setContext', 'aiBrowser.keepAwakeActive', on);
		}
	}

	private _post(): void {
		if (this._chromeCommand?.getStore()) { this._chromeCommand.exit(() => this._post()); return; }
		if (this._disposed) { return; }
		if (this._postTimer) {
			return;
		}
		this._postTimer = setTimeout(() => {
			this._postTimer = undefined;
			const signature = `${this._surfaceLabel()}|${this._tabs.length}|${this._active.chat.title}|${this._active.chat.folder ?? ''}`;
			if (signature !== this._surfaceSignature) {
				this._surfaceSignature = signature;
				if (this._panel) { this._panel.title = this._surfaceLabel(); }
				for (const surface of ChatViewProvider._surfaces.values()) { if (surface !== this) { surface._post(); } }
			}
			this._postMessage({ type: 'state', state: this._state() });
			// The view now shows the conversation the terminal gave way to: its box can take the focus.
			this._terminalLeftPending = false;
			if (this._focusAfterState) {
				this._focusAfterState = false;
				this._postMessage({ type: 'focusInput' });
			}
			// Said after the state that shows the tab, or the view has nothing to focus yet.
			const focus = this._terminals.takeFocus();
			if (focus) { this._postTerminal({ type: 'terminalFocus', id: focus }); }
			this._saveTabs();
		}, postDelayMs);
	}

	private _surfaceLabel(): string {
		return this._panelIdentity ? `AI Browser #${this._surfaceNumber}` : 'AI Browser (sidebar)';
	}

	private _state(): ChatViewState {
		if (this._chromeCommand?.getStore()) { return this._chromeCommand.exit(() => this._state()); }
		// Whatever the tab in front finished is read once the view shows it. A
		// view in another side bar container, or collapsed, is not looked at.
		// Not while a terminal shows: the conversation behind it is not looked at.
		if (this._view?.visible && !this._peeking && !this._terminals.front) {
			this._active.seen();
		}
		const mirrored = this._stateSurfaces.chatIds(this._active.chat.id, 'chrome');
		const limit = tabLimit();
		const selection = this._selection();
		const viewMode = readViewMode();
		this._active.attachmentReferences.assign(this._active.attachments.map(a => a.chip));
		return {
			chromeConnectionRequest: ChatViewProvider._chromeConnectionRequest ? {
				id: ChatViewProvider._chromeConnectionRequest.id, extensionId: ChatViewProvider._chromeConnectionRequest.extensionId,
			} : undefined,
			themeTokens: this._themeTokens,
			sound: soundSettings(),
			windowFocused: vscode.window.state.focused,
			themeKind: vscode.window.activeColorTheme.kind,
			panel: this._panelIdentity,
			surfaceId: this._surfaceId,
			dragToken: this._dragToken,
			chatSurfaces: [...ChatViewProvider._surfaces.values()].filter(surface => (!!surface._view || !!surface._panelIdentity) && !surface._disposed).map(surface => ({
				id: surface._surfaceId, label: surface._surfaceLabel(), ...(surface._panel || surface._panelIdentity ? {} : { main: true as const }),
				description: `${surface._active.chat.title} · ${surface._tabs.length} chats · ${surface._active.chat.folder ?? surface._windowCwd()}`,
			})),
			sleep: this._sleep.state,
			exchangeConnection: { ...exchangeConnection.state, keepAwakeMinutes: readExchangeAwakeMinutes(vscode.workspace.getConfiguration('aiBrowser.chat').get('exchangeKeepAwakeMinutes',60)) },
			featureAi: readFeatureAiSettings(this._context.globalState.get(featureAiKey)),
			recordingQuality: readRecordingQuality(this._context.globalState.get(recordingQualityKey)),
			recordingSeconds: readRecordingSeconds(this._context.globalState.get(recordingSecondsKey)),
			voice: this._voiceAvailability(),
			blocked: this._blocked(),
			detecting: this._registry.detecting,
			agents: this._registry.agents,
			selection,
			...this._usageState(selection.agent),
			chatId: this._active.chat.id,
			entries: this._active.chat.entries,
			running: this._active.running,
			// The pins first: they are the conversation's, not a draft's, and carry no `@N`.
			attachments: [...this._pinChips(this._active), ...this._active.attachments.map(a => ({ ...a.chip, reference: attachmentReference(a.chip) }))],
			suggestions: this._suggestions().map(s => s.chip),
			pendingSends: this._active.pendingSends,
			...(this._active.paused ? { queuePaused: { by: this._active.paused.by } } : {}),
			tabs: this._tabs.map((tab): ChatTabSummary => ({
				id: tab.id,
				chatId: tab.chat.id,
				canResumeInTerminal: !!tab.chat.ref,
				title: tab.title ?? vscode.l10n.t("New chat"),
				agent: tab.started ? tab.chat.agent : undefined,
				...this._tabModel(tab),
				running: tab.running,
				agents: tab.agentsRunning,
				skillRuns: this._runs.runningIn(tab.chat.id),
				busy: tab.busy,
				queued: tab.queuedCount,
				status: tab.status,
				...(mirrored.has(tab.chat.id) ? { chrome: true } : {}),
				...this._pinnedSummary(tab),
			})),
			...(mirrored.has(this._active.chat.id) && !this._peeking ? { chromeMirror: true } : {}),
			activeTab: this._active.id,
			access: this._access(),
			tabLimit: limit,
			terminals: this._terminals.tabs.map(t => this._terminalSummary(t)),
			...(this._terminals.front ? { terminalFront: this._terminals.front } : {}),
			terminalSupport: this._terminalSupport(),
			approvals: { policy: this._approvalPolicy(), servers: this._approvalServers() },
			switchTo: this._switchTo,
			commands: this._registry.commandsFor(this._cwd()),
			toolbar: this._toolbar(),
			toolbarRuns: this._toolbarRunsState(),
			skillAgents: this._runs.rows(this._active.chat.id),
			viewMode,
			collapseTools: viewMode !== 'standard',
			context: this._contextState(),
			workdir: this._workdirState(),
			hasBrowserTab: this._browser.hasOpenTabs,
			browserApi: tabSource.available(),
			nativeBrowser: this._nativeBrowser,
			news: this._news,
			newsHidden: this._newsHidden(),
		};
	}

	/**
	 * The context pie of the tab in front: shown once its agent has reported a
	 * size, for the agent the conversation belongs to. Compacting is offered
	 * only where the agent has it — Claude Code lists `/compact` among its
	 * commands (it may not, on a build that drops it); Codex always takes
	 * `thread/compact/start`.
	 */
	private _contextState(): ChatViewState['context'] {
		const tab = this._active;
		const stats = tab.chat.stats;
		if (!tab.started || stats.contextTokens === undefined) {
			return undefined;
		}
		const agent = tab.chat.agent;
		// Gemini CLI's `/compress` is not among the commands it handles over ACP.
		const canCompact = agent === 'codex' || (agent === 'claude' && !!this._registry.commandsFor(this._cwd()).claude?.some(c => c.name === 'compact'));
		return { used: stats.contextTokens, window: stats.contextWindow, compacted: stats.contextCompacted, canCompact };
	}

	/**
	 * The pie was clicked: the agent's own compaction, sent as `/compact` —
	 * Claude Code runs it from a stream-json message, and `CodexSession` turns it
	 * into `thread/compact/start`. Shown in the conversation as the prompt
	 * `/compact`, as both agents' own UIs show it. Not while the tab works: the
	 * view disables the pie then, and a click racing a new turn is dropped
	 * rather than queued behind it.
	 */
	private async _compact(tabId: string): Promise<void> {
		const tab = this._tabs.find(t => t.id === tabId);
		if (!tab || tab.busy || !tab.started || this._blocked()) {
			return;
		}
		// `given` is empty: the chips in the box belong to the next message.
		await this._send('/compact', tab.id, []);
	}

	/**
	 * Why the chat cannot run in this window at all.
	 *
	 * - **Restricted Mode.** Both CLIs load the project's own configuration —
	 *   Claude Code runs `.claude/settings.json` hooks, which are shell commands
	 *   — so starting one in a folder the user has not trusted runs that
	 *   folder's code. The same reasoning as Connect Codex and `git`
	 *   (breaks-silently #208).
	 * - **A remote window.** This extension runs on the local machine there, and
	 *   the CLIs and the project are on the remote, so a CLI started here would
	 *   work on the wrong machine.
	 */
	private _blocked(): string | undefined {
		return chatBlocked();
	}

	/* ------------------------------------------------------------ messages */

	private async _receive(message: ViewToHost): Promise<void> {
		switch (message.type) {
			case 'connectExchange':
				await exchangeConnection.connect({ url: message.url, pointId: message.pointId, key: message.key, password: message.password }, this._surfaceId);
				return;
			case 'disconnectExchange':
				exchangeConnection.disconnect();
				return;
			case 'setExchangeKeepAwake':
				if((exchangeAwakeMinutes as readonly number[]).includes(message.minutes)){
					await vscode.workspace.getConfiguration('aiBrowser.chat').update('exchangeKeepAwakeMinutes',message.minutes,vscode.ConfigurationTarget.Global);
				}
				return;
			case 'answerChromeConnection':
				if (ChatViewProvider._chromeConnectionRequest?.id === message.id) {
					ChatViewProvider._chromeConnectionRequest.finish(message.allow === true ? this._surfaceId : undefined);
				}
				return;
			case 'reportTheme': {
				if (!message.tokens || typeof message.tokens !== 'object') { return; }
				this._themeTokens = Object.fromEntries(Object.entries(message.tokens).slice(0, 2000).filter(([key, value]) =>
					/^--vscode-[a-zA-Z0-9-]+$/.test(key) && typeof value === 'string' && value.length < 500 && !/[;{}]/.test(value) && !/url\(/i.test(value)));
				this._post(); return;
			}
			case 'controlRecording':
				await this._recording?.control(message.action);
				return;
			case 'recording':
				if (this._videoEncoder?.id === message.id) { this._videoEncoder.messages.fire(message.message); }
				return;
			case 'voiceStart':
				await this._voiceStart();
				return;
			case 'voiceStop':
				if (this._voice && !this._voice.recording.ended && (message.action === 'send' || message.action === 'attach')) {
					this._voice.action = message.action;
					this._voice.recording.stop();
				}
				return;
			case 'voiceCancel':
				this._voiceCancel(true);
				return;
			case 'temporaryStorage':
				if (message.action === 'refresh' || message.action === 'all' || message.action === 'project') { await this._temporaryFiles(message.action, message.project); }
				return;
			case 'openrouter':
				await this._openrouterAction(message);
				return;
			case 'soundSettings':
				await this._soundSettings(message);
				return;
			case 'loadEarlier':
				// Chrome and the website answer it in their own bridge; one reaching here is the editor's view.
				if (this._chromeCommand?.getStore() || message.chatId !== this._editorWindowChat) { break; }
				this._editorPrompts = message.reset ? currentVisibleTurns() : this._editorPrompts + currentVisibleTurns();
				this._postMessage({ type: 'state', state: this._state() });
				break;
			case 'osNotify':
				osNotify(message.title, message.text);
				return;
			case 'remoteTerminalSettings':
				await this._remoteTerminalSettings(message);
				return;
			case 'saveFeatureAi':
				try {
					const settings = readFeatureAiSettings(message.settings);
					await this._context.globalState.update(featureAiKey, settings);
					const recordingQuality = readRecordingQuality(message.recordingQuality ?? this._context.globalState.get(recordingQualityKey));
					await this._context.globalState.update(recordingQualityKey, recordingQuality);
					await vscode.commands.executeCommand('setContext', 'aiBrowser.recordingQuality', recordingQuality);
					// Read through the same clamp the recording uses: the view checks the
					// range too, but what it sends is not trusted.
					const recordingSeconds = readRecordingSeconds(message.recordingSeconds ?? this._context.globalState.get(recordingSecondsKey));
					await this._context.globalState.update(recordingSecondsKey, recordingSeconds);
					this._postMessage({ type: 'state', state: this._state() });
					this._postMessage({ type: 'featureAiSaved', settings, recordingQuality, recordingSeconds });
				} catch (error) {
					this._postMessage({ type: 'featureAiSaved', error: error instanceof Error ? error.message : String(error) });
				}
				return;
			case 'setAutomaticAwake':
				if (typeof message.enabled === 'boolean') {
					await this._context.globalState.update(automaticAwakeKey, message.enabled);
					this._sleep.setAutomatic(message.enabled);
				}
				return;
			case 'setSleep':
				// A tab closed while the popup was open: nothing to wait for.
				if (message.choice?.mode === 'agents' && message.choice.scope === 'tab') {
					const tabId = message.choice.tabId;
					if (!this._tabs.some(t => t.id === tabId)) {
						return;
					}
				}
				this._sleep.choose(message.choice);
				return;
			case 'ready': {
				this._viewReady = true;
				// A page that (re)loads has no screens: each terminal is given its own
				// when the view's xterm for it says `terminalAttach`.
				this._terminals.detachAll();
				this._postRecording();
				// A queue held while there was no view goes out now that there is one.
				this._drainQueues();
				// The last table known goes before the first state, so a chat is
				// drawn with its icons once rather than drawn and then drawn again;
				// the fresh read below changes nothing in the view when it is equal.
				if (this._fileIconTable) { void this._view?.webview.postMessage({ type: 'fileIcons', table: this._fileIconTable } satisfies HostToView); }
				this._postMessage({ type: 'hydrateDrafts', drafts: Object.fromEntries(this._savedDrafts) });
				this._postMessage({ type: 'state', state: this._state() });
				const queued = this._queued;
				this._queued = [];
				queued.forEach(m => this._postMessage(m));
				this._postMessage({ type: 'inputHistory', items: this._inputHistory() });
				// Nothing was read while there was no view (see `_refreshWorkdirGit`),
				// so the footer starts from a fresh read rather than from nothing.
				void this._refreshWorkdirGit();
				this._postFileIcons();
				if (!this._blocked() && !this._registry.detecting && !this._registry.agents.some(a => a.available || a.problem)) {
					await this._registry.detect();
				}
				void this._restoreTerminals().catch(() => undefined);
				return;
			}
			case 'refreshAgents':
				if (!this._blocked()) {
					await this._registry.detect();
				}
				return;
			case 'saveToolbarSkill':
				await this._saveToolbarSkill(message.skill);
				return;
			case 'deleteToolbarSkill':
				this._runs.forget(message.id);
				// Sent into the chat: its turn goes on, but the skill is gone — not told.
				this._chatSkillTabs.delete(message.id);
				await this._storeToolbar(this._toolbar().filter(s => s.id !== message.id));
				return;
			case 'placeToolbarSkill': {
				if (message.id === message.target) { return; }
				const list = [...this._toolbar()];
				const from = list.findIndex(s => s.id === message.id);
				if (from < 0 || !list.some(s => s.id === message.target)) { return; }
				const [skill] = list.splice(from, 1);
				const target = list.findIndex(s => s.id === message.target);
				list.splice(target + (message.after === true ? 1 : 0), 0, skill);
				await this._storeToolbar(list);
				return;
			}
			case 'moveToolbarSkill': {
				const list = [...this._toolbar()];
				const at = list.findIndex(s => s.id === message.id);
				const to = at + (message.by === -1 ? -1 : 1);
				if (at < 0 || to < 0 || to >= list.length) {
					return;
				}
				[list[at], list[to]] = [list[to], list[at]];
				await this._storeToolbar(list);
				return;
			}
			case 'runToolbarSkill':
				await this._runToolbarSkill(message.id, message.values, message.tabId, message.again === true, message.queue === true);
				return;
			case 'toolbarApprove':
				if (typeof message.approvalId === 'string') {
					this._runs.answer(message.id, message.approvalId, message.allow === true);
				}
				return;
			case 'stopToolbarSkill': {
				this._runs.stop(message.id);
				// Into the chat: Stop is the tab's own Stop, as the composer's is —
				// and a skill of several prompts drops the ones not sent yet, which
				// an idle moment between two of them would otherwise still send.
				const runs = this._chatSkillTabs.get(message.id) ?? [];
				for (const run of runs) {
					for (const chain of run.chains ?? []) {
						run.tab.dropSteps(chain);
					}
				}
				for (const tab of new Set(runs.map(run => run.tab))) {
					if (this._tabs.includes(tab) && tab.busy) {
						this._giveBackQueue(tab);
						tab.stop();
					}
				}
				this._chatSkillTabs.delete(message.id);
				this._post();
				return;
			}
			case 'setWorkdir':
				await this._setWorkdir(typeof message.path === 'string' ? message.path : undefined);
				return;
			case 'chooseWorkdir':
				await this._chooseWorkdir();
				return;
			case 'gitIndexAction':
				await this._changeGitIndex(message);
				return;
			case 'openGitDiff':
				await this._openGitDiff(message);
				return;
			case 'gitCommit':
				await this._commitWorkdir(message.folder, message.tabId, message.scope, message.push === true);
				return;
			case 'fixGitCommit':
			case 'dismissGitCommit':
				await this._answerCommit(message);
				return;
			case 'gitBranchName':
                await this._suggestBranchName(message);
                return;
			case 'gitBranchAction':
				await this._gitBranchAction(message);
				return;
			case 'gitRemoteAction':
				await this._gitRemoteAction(message);
				return;
			case 'restoreBranchStash':
				await this._restoreBranchStash(message.folder);
				return;
			case 'refreshWorkdirGit':
				await this._refreshWorkdirGit(message.fetch);
				return;
			case 'listWorkdir':
				await this._listWorkdir();
				return;
			case 'attachPath':
				if (typeof message.path === 'string') {
					await this._attachPath(message.path);
				}
				return;
			case 'openRepo':
				await this._openRepo(message.repo, message.branch, message.mode);
				return;
			case 'removeRepoFolder':
				if (typeof message.path === 'string') { await this._removeRepoFolder(message.path); }
				return;
			case 'repoAction':
				await this._repoAction(message.action);
				return;
			case 'trustWorkdir':
				await this._trustWorkdir();
				return;
			case 'listCommands':
				if (!this._blocked() && isAgentId(message.agent) && !this._registry.detecting) {
					await this._registry.refreshCommands(message.agent, this._cwd(), !this._untrusted(this._cwd()));
				}
				return;
			case 'select':
				this._select(message.selection);
				return;
			case 'send':
				if (message.mode === 'queue') {
					this._queue(message.text, message.tabId);
					return;
				}
				await this._send(message.text, message.tabId);
				return;
			case 'clearChat':
				this._clearChat();
				return;
			case 'compact':
				if (typeof message.tabId === 'string') {
					await this._compact(message.tabId);
				}
				return;
			case 'exportChat':
				await this._exportChat(message.to === 'file' ? 'file' : 'clipboard');
				return;
			case 'unqueue':
				for (const tab of this._tabs) {
					tab.unqueue(message.id);
				}
				return;
			case 'resumeQueue':
				// By id: the post that showed another tab may be behind the click.
				this._tabs.find(t => t.id === message.tabId)?.resume();
				this._drainQueues();
				return;
			case 'stop':
				this._stopTab(this._active);
				return;
			case 'openDiff':
				await this._openDiff(message.name, message.diff);
				return;
			case 'openText':
				await this._openText(message.name, message.text);
				return;
			case 'openAttachment':
				await this._openAttachment(message.id, message.entry);
				return;
			case 'saveAttachment': {
				const attachment = this._active.attachments.find(a => a.chip.id === message.id);
				if (!attachment?.file || attachment.chip.kind !== 'video') { return; }
				const target = await vscode.window.showSaveDialog({ defaultUri: attachment.file });
				if (target && target.toString() !== attachment.file.toString()) {
					await vscode.workspace.fs.copy(attachment.file, target, { overwrite: true });
				}
				return;
			}
			case 'approve':
				// The card is in whichever tab holds it; an id is unique to its question.
				for (const tab of this._tabs) {
					tab.answer(message.id, message.allow === true, message.answers);
				}
				return;
			case 'setApprovalMode': {
				if (!approvalModes.includes(message.mode)) {
					return;
				}
				const keys = message.key === 'all'
					? [...approvalCategories, ...this._approvalServers().map(server => `mcp:${server}`)]
					: [message.key];
				// A server's key is honoured whether or not the menu lists it — the
				// list stops at 30 — or a card's "Always" would do nothing for it.
				const valid = keys.filter(key => (approvalCategories as readonly string[]).includes(key) || (key.startsWith('mcp:') && key.length > 4 && key.length <= 84));
				if (!valid.length) {
					return;
				}
				const policy: Record<string, ApprovalMode> = { ...this._approvalPolicy() };
				for (const key of valid) {
					policy[key] = message.mode;
				}
				await this._context.workspaceState.update(approvalPolicyKey, policy).then(undefined, () => { /* a convenience */ });
				// The policy is the workspace's, so every chat surface of the window
				// answers its waiting cards and redraws its menu — not only this one.
				for (const view of ChatViewProvider._surfaces.values()) {
					for (const tab of view._tabs) {
						tab.approvalModesChanged();
					}
					view._post();
				}
				this._runs.approvalModesChanged();
				return;
			}
			case 'stopAgent':
				if (message.id.startsWith(runRowPrefix)) {
					if (!this._runs.stopRow(message.id)) {
						this._postMessage({ type: 'agentStopFailed', id: message.id });
					}
					return;
				}
				if (!await this._active.stopAgent(message.id)) {
					this._postMessage({ type: 'agentStopFailed', id: message.id });
				}
				return;
			case 'newTab':
				await this.newChat(message.location);
				return;
			case 'placeTerminal':
				if (this._terminals.place(message.id, message.target, message.after)) { this._scheduleTerminalSave(); }
				break;
			case 'placeTab':
				this._placeTab(message.id, message.target, message.after);
				return;
			case 'beginTabDrag': {
				const tab = this._tabs.find(t => t.id === message.id);
				if (tab && typeof message.draft === 'string') { this._tabDrag = { id: tab.id, chatId: tab.chat.id, draft: message.draft, at: Date.now() }; }
				return;
			}
			case 'acceptTabDrop':
				this._acceptTabDrop(message.source, message.id, message.token);
				return;
			case 'moveTabTo': {
				const destination = ChatViewProvider._surfaces.get(message.target);
				if (destination && !destination._view && destination._panelIdentity) { await destination._focusView(); }
				const tab = this._tabs.find(t => t.id === message.id);
				if (destination && tab && typeof message.draft === 'string' && this._moveTabInto(tab, destination, message.draft)) {
					await destination._focusView();
				}
				return;
			}
			case 'moveTerminalTo': {
				const destination = ChatViewProvider._surfaces.get(message.target);
				if (destination && !destination._view) { await destination._focusView(); }
				if (destination && this._moveTerminalInto(message.id, destination)) { await destination._focusView(); }
				return;
			}
			case 'moveTerminalToNew':
				if (message.location === 'tab' || message.location === 'window') { await this._detachTerminal(message.id, message.location); }
				return;
			case 'moveTabToNew':
				if (!this._panelIdentity && (message.location === 'tab' || message.location === 'window')) {
					await this._detachTab(message.id, typeof message.draft === 'string' ? message.draft : '', message.location);
				}
				return;
			case 'selectTab':
				this._selectTab(message.id);
				return;
			case 'renameTab': {
				// One line, and short: it is a tab label, a history row and a transcript heading.
				const title = typeof message.title === 'string' ? capAt(message.title.replace(/\s+/g, ' ').trim(), tabTitleLimit) : '';
				if (title) {
					const tab = this._tabs.find(t => t.id === message.id);
					if (tab) { this._titleRequests.get(tab)?.abort(); tab.rename(title); }
				}
				return;
			}
			case 'closeTab':
				this._closeTab(message.id);
				return;
			case 'switchAgent':
				await this._switchAgent(message.choice);
				return;
			case 'secondOpinion':
				await this._secondOpinion(message.chatId, message.index, message.agent, message.model);
				return;
			case 'setAgentBinary':
				await this._setAgentBinary(message.agent, message.path);
				return;
			case 'authenticateAgent':
			case 'checkAgentAuthentication':
				if (this._blocked() || !isAgentId(message.agent)) return;
				if (message.type === 'authenticateAgent') await this._registry.authenticate(message.agent);
				else await this._registry.checkAuthentication(message.agent);
				return;
			case 'openAgentSetting':
				await vscode.commands.executeCommand('workbench.action.openSettings', `aiBrowser.chat.${message.agent}Path`);
				return;
			case 'attach':
				await this._attach(message.kind);
				return;
			case 'pasteFile':
				await this._pasteFile(message);
				return;
			case 'removeAttachment': {
				// A pin's chip is a binding, not a draft attachment: its X unpins.
				const pinned = terminalOfPinChip(message.id);
				if (pinned !== undefined) {
					if (ChatViewProvider._pins.unpin(this._active.id, pinned)) { ChatViewProvider._postAll(); }
					return;
				}
				this._active.attachments = this._active.attachments.filter(a => a.chip.id !== message.id);
				this._livePages.delete(message.id);
				this._post();
				return;
			}
			case 'acceptSuggestion': {
				// Taken from what is open now, not from what the chip showed: the
				// suggestion is the editor or tab in front, and only that is accepted.
				const suggestion = this._suggestions().find(s => s.chip.id === message.id);
				const tab = this._active;
				const attachment = suggestion && await suggestion.accept();
				if (attachment && this._tabs.includes(tab)) {
					tab.attachments.push(attachment);
				}
				this._post();
				return;
			}
			case 'usage':
				await this._usage();
				return;
			case 'dismissUsageAlert':
				this._dismissUsageAlert(message.alert);
				return;
			case 'saveDrafts': {
				if (!message.drafts || typeof message.drafts !== 'object') { return; }
				this._savedDrafts.clear();
				for (const tab of this._tabs) {
					const draft = Object.prototype.hasOwnProperty.call(message.drafts, tab.chat.id) ? message.drafts[tab.chat.id] : undefined;
					if (typeof draft === 'string') { this._savedDrafts.set(tab.chat.id, draft); }
				}
				clearTimeout(this._draftSaveTimer);
				this._draftSaveTimer = setTimeout(() => { this._draftSaveTimer = undefined; this._saveTabs(); }, 150);
				return;
			}
			case 'tabDraft': {
				const pending = this._draftRequests.get(message.request);
				if (!pending) { return; }
				this._draftRequests.delete(message.request); clearTimeout(pending.timer);
				if (typeof message.draft === 'string' && this._tabs.includes(pending.tab) && pending.tab.chat.id === pending.chatId) { pending.resolve(message.draft); }
				else { pending.reject(new Error('The source chat changed before its draft was read.')); }
				return;
			}
			case 'resolveHistoryChat':
				await this._resolveHistoryChat(message.id, message.action);
				return;
			case 'openChat':
				this._openChat(message.id);
				return;
			case 'resumeInTerminal':
				await this._resumeInTerminal(message.id);
				return;
			case 'tabAccess':
				if (typeof message.tabId === 'string') {
					this._browser.setTabOwner(message.tabId, message.take ? this._active.chat.id : undefined);
					this._post();
				}
				return;
			case 'listAllAgents':
				this.showAllAgents(true);
				return;
			case 'githubStatus':
				if (typeof message.folder === 'string') { await this._githubStatus(message.folder, message.signIn === true); }
				return;
			case 'listHistory':
				this.showHistory(true);
				return;
			case 'deleteChat':
				await this._deleteChat(message.id);
				return;
			case 'newChat':
				await this.newChat(message.location);
				return;
			case 'copy':
				await vscode.env.clipboard.writeText(message.text);
				return;
			case 'newTerminal':
				await this.newTerminal(message.agent, message.pinTo);
				return;
			case 'pinTerminal':
				this._pinTerminalMessage(message.id, message.tabId, message.pinned, message.mode);
				return;
			case 'terminalAskAgent':
				await this._terminalAskAgent(message.id, message.target, message.selection, message.mode);
				return;
			case 'setTerminalAgentControl':
				this._terminals.find(message.id)?.setAgentControl(message.allowed === true);
				return;
			case 'setTerminalRemote':
				// Only the editor grants it, and only while the window allows terminals on the website at all.
				if (message.remote === true && !remoteTerminalSetting()) { refuse(vscode.l10n.t("Turn on the setting AI Browser › Chat: Remote Terminal first.")); return; }
				this._terminals.find(message.id)?.setRemote(message.remote === true);
				return;
			case 'selectTerminal':
				this._terminals.select(message.id);
				return;
			case 'closeTerminal':
				this._closeTerminal(message.id);
				return;
			case 'renameTerminal':
				// One line, and short, as a conversation's name is.
				if (this._terminals.find(message.id)?.rename(terminalName(message.name))) { this._post(); }
				return;
			case 'restartTerminal':
				await this._restartTerminal(message.id);
				return;
			case 'terminalAttach': {
				const tab = this._terminals.find(message.id);
				if (!tab) { return; }
				// The settings first: the font decides the cells the screen is drawn in.
				this._postTerminalSettings();
				tab.attach(message.cols, message.rows);
				return;
			}
			case 'terminalInput':
				this._terminals.find(message.id)?.input(message.data);
				return;
			case 'terminalResize':
				this._terminals.find(message.id)?.resize(message.cols, message.rows);
				return;
			case 'terminalAck':
				this._terminals.find(message.id)?.ack(message.bytes);
				return;
			case 'terminalPasteRequest':
				await this._pasteIntoTerminal(message.id);
				return;
			case 'terminalInsert':
				await this._insertIntoTerminal(message.id, message.kind, message.file);
				return;
			case 'runInTerminal':
				await this._runInTerminal(message.text, message.target, message.id);
				return;
			case 'terminalToChat':
				await this._terminalToChat(message.id, message.text);
				return;
			case 'setNewsHidden':
				// Remembered as the newest entry at the moment of hiding, in
				// `globalState`: hidden in every window, and shown again by itself
				// once a release adds an entry — hiding the changelog once must not
				// mean never hearing of a new feature.
				try {
					await this._context.globalState.update(newsHiddenKey, message.hidden ? this._news?.entries[0]?.title ?? '' : undefined);
				} catch {
					// Best effort: the choice is a convenience.
				}
				// Kept in globalState: every chat surface shows it at once.
				for (const view of ChatViewProvider._surfaces.values()) { view._post(); }
				return;
			case 'openBrowser':
				if (message.where === 'vscode' && !isBrowserApiGranted()) {
					await vscode.commands.executeCommand('aiBrowser.enableBrowserApi');
					return;
				}
				await this._openBrowser(message.where);
				return;
			case 'localLinkInfo':
				await this._localLinkInfo(message.url, message.request);
				return;
			case 'openLink':
				await this._openLink(message.url, message.external, message.reveal);
				return;
			case 'openFile':
				await this._openFile(message.path);
				return;
			case 'setViewMode':
				if ((chatViewModes as readonly unknown[]).includes(message.mode)) {
					await this._setViewMode(message.mode);
				}
				return;
		}
	}

	/**
	 * The approval menu's View Mode writes `aiBrowser.chat.viewMode` — one
	 * setting, so the menu and Settings never disagree; the change comes back
	 * through `onDidChangeConfiguration` and the post it makes. Written where it
	 * is in force: a workspace value (of this setting, or of the older Fold Tool
	 * Calls it is read from while unset) would shadow a user-level write, and
	 * the menu would then do nothing. A settings.json VS Code cannot parse
	 * refuses the write, which is said in the status bar.
	 */
	private async _setViewMode(mode: ChatViewMode): Promise<void> {
		const config = vscode.workspace.getConfiguration();
		const own = config.inspect<unknown>(viewModeSetting);
		const older = config.inspect<unknown>(collapseToolsSetting);
		const workspace = own?.workspaceValue !== undefined
			|| (own?.globalValue === undefined && older?.workspaceValue !== undefined);
		try {
			await config.update(viewModeSetting, mode, workspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
		} catch (error) {
			refuse(vscode.l10n.t('Could not change the chat view mode: {0}', plainInLabel(error instanceof Error ? error.message : String(error))));
			this._post();
		}
	}

	/**
	 * A file a tool row names, clicked: opened as a preview tab of the active
	 * group through `vscode.open`, so each kind gets its own editor — text in
	 * the text editor, an image in the image preview, anything else in what
	 * VS Code picks for it. The path is the agent's: absolute as both CLIs give
	 * it, `~/…` as Claude Code itself expands it, and a relative one is taken
	 * from the working directory the agents run in. Only a file that exists is
	 * opened; anything else is refused in the status bar, never a toast over
	 * the browser.
	 */
	private async _openFile(file: unknown, line?: number, column?: number, reveal = false): Promise<void> {
		if (typeof file !== 'string' || !file || file.length > 4096 || /[\0\n\r]/.test(file)) {
			return;
		}
		const expanded = file === '~' || file.startsWith('~/') ? path.join(os.homedir(), file.slice(1)) : file;
		const uri = vscode.Uri.file(path.resolve(this._cwd(), expanded));
		try {
			const stat = await vscode.workspace.fs.stat(uri);
			if (reveal || (stat.type & vscode.FileType.Directory)) {
				const inProject = !reveal && !!vscode.workspace.getWorkspaceFolder(uri);
				await vscode.commands.executeCommand(inProject ? 'revealInExplorer' : 'revealFileInOS', uri);
				return;
			}
		} catch {
			refuse(vscode.l10n.t('{0} is not there any more.', plainInLabel(file)));
			return;
		}
		try {
			const position = line !== undefined ? new vscode.Position(Math.max(0, line - 1), Math.max(0, (column ?? 1) - 1)) : undefined;
			await vscode.commands.executeCommand('vscode.open', uri, { preview: true, viewColumn: vscode.ViewColumn.Active, selection: position ? new vscode.Range(position, position) : undefined } satisfies vscode.TextDocumentShowOptions);
		} catch (error) {
			refuse(vscode.l10n.t('Could not open {0}: {1}', plainInLabel(file), plainInLabel(error instanceof Error ? error.message : String(error))));
		}
	}

	/**
	 * A link a model wrote: local paths open existing files or reveal folders.
	 * Other links allow only http/https, never command: or vscode:. The built-in browser goes through
	 * `aiBrowser.show`, which honours `useIntegratedBrowser` and the grant like
	 * every other way in; with ⌘/Ctrl held it is the system browser.
	 */
	private async _localLinkInfo(url: unknown, request: number): Promise<void> {
		let directory: boolean | undefined;
		let inWorkspace = false;
		const local = typeof url === 'string' && localFileLink(url);
		if (local && local.path.length <= 4096) {
			const file = local.path;
			const expanded = file === '~' || file.startsWith('~/') ? path.join(os.homedir(), file.slice(1)) : file;
			try {
				const uri = vscode.Uri.file(path.resolve(this._cwd(), expanded));
				const stat = await vscode.workspace.fs.stat(uri);
				inWorkspace = !!vscode.workspace.getWorkspaceFolder(uri);
				directory = !!(stat.type & vscode.FileType.Directory);
			} catch { /* Missing links still offer copying their path. */ }
		}
		this._postMessage({ type: 'localLinkInfo', request, directory, inWorkspace });
	}

	private async _openLink(url: unknown, external: unknown, reveal?: boolean): Promise<void> {
		if (typeof url !== 'string') { return; }
		const local = localFileLink(url);
		if (local) {
			await this._openFile(local.path, local.line, local.column, reveal === true);
			return;
		}
		let parsed: URL;
		try {
			parsed = new URL(String(url));
		} catch {
			return;
		}
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return;
		}
		const address = parsed.toString();
		try {
			if (external === true) {
				if (!await vscode.env.openExternal(vscode.Uri.parse(address, true))) {
					refuse(vscode.l10n.t('Could not open the link in the system browser.'));
				}
			} else {
				await vscode.commands.executeCommand('aiBrowser.show', address);
			}
		} catch (error) {
			refuse(vscode.l10n.t('Could not open the link: {0}', plainInLabel(error instanceof Error ? error.message : String(error))));
		}
	}

	/* ------------------------------------------------------------ toolbar */

	/** The toolbar's skills as stored, each checked again: `globalState` is not ours alone to write. */
	private _toolbar(): ToolbarSkill[] {
		const raw = this._context.globalState.get<unknown[]>(toolbarKey);
		const steps = this._context.globalState.get<unknown>(toolbarStepsKey);
		const extras = this._context.globalState.get<unknown>(toolbarExtrasKey);
		const byId = (store: unknown, id: unknown) => typeof id === 'string' && store && typeof store === 'object' && Object.prototype.hasOwnProperty.call(store, id)
			? (store as Record<string, unknown>)[id] : undefined;
		const out: ToolbarSkill[] = [];
		for (const item of Array.isArray(raw) ? raw : []) {
			let merged: unknown = item;
			if (item && typeof item === 'object' && !Array.isArray(item)) {
				const record = item as { id?: unknown; followUps?: unknown; result?: unknown; notify?: unknown };
				const extra = byId(extras, record.id) as { toast?: unknown; notify?: unknown } | undefined;
				merged = {
					...record,
					followUps: record.followUps ?? byId(steps, record.id),
					// `toast` only over the `silent` it was stored as: a skill an older build
					// changed to another result since keeps that one.
					result: record.result === 'silent' && extra?.toast === true ? 'toast' : record.result,
					notify: record.notify ?? extra?.notify,
				};
			}
			// A stored notification this build cannot take — a longer text a newer build
			// allowed, a hand edit — is dropped, not the skill: the next save would
			// otherwise delete it with its next prompts. Refused only from the editor.
			let skill = validToolbarSkill(merged);
			if (typeof skill === 'string' && merged && typeof merged === 'object' && (merged as { notify?: unknown }).notify !== undefined) {
				skill = validToolbarSkill({ ...merged, notify: undefined });
			}
			if (typeof skill !== 'string' && !out.some(s => s.id === skill.id || s.name.toLowerCase() === skill.name.toLowerCase())) {
				out.push(skill);
			}
		}
		return out.slice(0, toolbarLimits.skills);
	}

	/**
	 * Writes the toolbar; false when the write failed, which the caller says
	 * (#255). Swallowed, the editor closed as if a skill were saved that was not.
	 */
	private async _storeToolbar(list: readonly ToolbarSkill[]): Promise<boolean> {
		// The next prompts under a key of their own (`toolbarStepsKey`); the
		// skills without them, as an older build reads them.
		const steps: Record<string, unknown> = {};
		const extras: Record<string, unknown> = {};
		for (const skill of list) {
			if (skill.followUps?.length) {
				steps[skill.id] = skill.followUps;
			}
			if (skill.result === 'toast' || skill.notify) {
				extras[skill.id] = { toast: skill.result === 'toast' || undefined, notify: skill.notify };
			}
		}
		const plain = list.map(({ followUps: _, notify: __, ...skill }) => ({ ...skill, result: skill.result === 'toast' ? 'silent' : skill.result }));
		const stored = await Promise.all([
			this._context.globalState.update(toolbarStepsKey, steps),
			this._context.globalState.update(toolbarExtrasKey, extras),
			this._context.globalState.update(toolbarKey, plain),
		]).then(() => true, () => false);
		this._post();
		if (!stored) {
			refuse(vscode.l10n.t("The toolbar could not be saved."));
		}
		return stored;
	}

	/**
	 * A skill from the editor: added when its id is new, replaced otherwise.
	 * Refused — the editor stays open with the reason — when it does not hold
	 * together, when another toolbar skill has its name, or past the limit.
	 */
	private async _saveToolbarSkill(raw: unknown): Promise<void> {
		const skill = validToolbarSkill(raw);
		if (typeof skill === 'string') {
			this._postMessage({ type: 'toolbarError', message: skill });
			return;
		}
		const list = this._toolbar();
		const at = list.findIndex(s => s.id === skill.id);
		if (list.some(s => s.id !== skill.id && s.name.toLowerCase() === skill.name.toLowerCase())) {
			this._postMessage({ type: 'toolbarError', message: vscode.l10n.t("Another toolbar skill is named {0}.", skill.name) });
			return;
		}
		if (at < 0 && list.length >= toolbarLimits.skills) {
			this._postMessage({ type: 'toolbarError', message: vscode.l10n.t("The toolbar holds at most {0} skills.", toolbarLimits.skills) });
			return;
		}
		const next = [...list];
		if (at < 0) {
			next.push(skill);
		} else {
			next[at] = skill;
		}
		if (await this._storeToolbar(next)) {
			this._postMessage({ type: 'toolbarSaved', id: skill.id });
		} else {
			this._postMessage({ type: 'toolbarError', message: vscode.l10n.t("The skill could not be saved. Try again.") });
		}
	}

	/**
	 * A toolbar skill pressed, or sent as `/name`. Into the chat it is a message
	 * of the tab it was pressed in; to the clipboard or silently it is a run of
	 * its own (`ToolbarRuns`), on the same agent, model and effort as that tab.
	 * The skills it names are written the way that agent reads them, so one
	 * offered to every agent works on either.
	 */
	/**
	 * The background runs, and each skill sent into the chat whose turn is still
	 * running there — so its button too says it is running, and asks before a
	 * second press runs it again.
	 */
	private _toolbarRunsState(): Record<string, ToolbarRun> {
		const out = this._runs.state;
		for (const [id, runs] of [...this._chatSkillTabs]) {
			const left = runs.filter(run => {
				const { tab } = run;
				if (!this._tabs.includes(tab) || tab.chat.id !== run.chatId) {
					// The tab closed, was cleared or given another conversation: the
					// user let go of the skill's turn, which is not told.
					return false;
				}
				if (run.sending || tab.busy || !!run.chains?.some(c => tab.hasSteps(c))) {
					return true;
				}
				// Its work in the chat is over: told as the skill asks, unless the user stopped it.
				if (!run.stopped && this._view) {
					this._skillEnded(run.skill, { status: tab.status === 'failed' ? 'failed' : 'done', values: run.values });
				}
				return false;
			});
			if (!left.length) {
				this._chatSkillTabs.delete(id);
			} else {
				this._chatSkillTabs.set(id, left);
				out[id] ??= { status: 'running', inChat: true };
			}
		}
		return out;
	}

	/** The skills sent into the chat whose work there is not over, by skill id; see `ChatSkillRun`. */
	private readonly _chatSkillTabs = new Map<string, ChatSkillRun[]>();

	private _addChatRun(run: ChatSkillRun): void {
		this._chatSkillTabs.set(run.skill.id, [...this._chatSkillTabs.get(run.skill.id) ?? [], run]);
	}

	/**
	 * `queue` ("Run after this turn", ⌘/Ctrl+click): the skill waits in the
	 * tab's queue and runs once the turn has ended — its prompts as queued
	 * messages, or, for a clipboard or silent skill, the background run started
	 * by the drain (`QueuedRun`). It is not refused as "still running": another
	 * run later is what was asked for.
	 */
	private async _runToolbarSkill(id: string, values: Readonly<Record<string, string>>, tabId?: string, again = false, queue = false, waitForGit = false): Promise<void> {
		const skill = this._toolbar().find(s => s.id === id);
		const tab = tabId ? this._tabs.find(t => t.id === tabId) : this._active;
		if (skill && !tab) {
			// The tab it was pressed in closed while its popover was open.
			refuse(vscode.l10n.t("{0} was not run: the chat tab it was pressed in is closed.", skill.name));
			return;
		}
		if (!skill || !tab || this._blocked()) {
			return;
		}
		if (this._registry.detecting) {
			// `_send` asks this after its own wait, and finds nothing to wait for
			// once this one has run — so it is asked here: a tab that closed, or
			// was given another chat from the history, meanwhile is not the one
			// the skill was pressed for (#368).
			const chat = tab.chat;
			await this._registry.detect();
			if (!this._tabs.includes(tab) || tab.chat !== chat) {
				refuse(vscode.l10n.t("{0} was not run: its chat tab changed while the agents were being found.", skill.name));
				return;
			}
		}
		const { agent, model, effort } = this._selection(tab);
		if (!agent || !model) {
			refuse(vscode.l10n.t("No agent is available to run {0}.", skill.name));
			return;
		}
		if (skill.agents !== 'all' && skill.agents !== agent) {
			refuse(vscode.l10n.t("{0} is for {1} only.", skill.name, agentNames[skill.agents]));
			return;
		}
		const filled = fillPrompt(skill, values);
		if ('error' in filled) {
			refuse(filled.error);
			return;
		}
		const commands = this._registry.commandsFor(tab.cwd)[agent] ?? [];
		const steps = filled.steps.map(step => ({ ...step, text: adaptSigils(step.text, commands) }));
		// The parameters as given, for the placeholders of the skill's notification.
		const stringValues: Record<string, string> = {};
		for (const param of skill.params) {
			const value = values[param.name];
			stringValues[param.name] = typeof value === 'string' ? value.trim() : '';
		}
		// The button asks before running a skill again; a press that did not ask
		// (two clicks inside one post) is not taken as a yes.
		const inChat = (this._chatSkillTabs.get(skill.id) ?? []).some(run => run.sending || run.tab.busy || !!run.chains?.some(c => run.tab.hasSteps(c)));
		if (!again && !queue && (this._runs.isRunning(skill.id) || inChat)) {
			refuse(vscode.l10n.t("{0} is still running.", skill.name));
			return;
		}
		if (queue && skill.result !== 'chat') {
			tab.enqueue(steps[0].text, [], undefined, { skillId: skill.id, name: skill.name, values: { ...values } });
			this._drainQueues();
			return;
		}
		if (skill.result === 'chat' && (steps.length > 1 || queue)) {
			// Several prompts: all of them into the tab's queue, the one ⌘Enter
			// fills, each sent once the turn before it is over and its check has
			// passed (`ChatTab._gateNextStep`). The first goes there too, rather
			// than straight out: sent while a turn runs it would be steered into
			// that turn, and the steps after it would gate on somebody else's reply.
			const chain = generateUuid();
			steps.forEach((step, i) => tab.enqueue(step.text, [], {
				chain, name: skill.name, step: i + 1, steps: steps.length, check: step.check,
			}));
			// A run of its own beside any earlier one: the skill's Stop drops every
			// chain, and each run is told on its own end.
			this._addChatRun({ tab, chatId: tab.chat.id, sending: false, chains: [chain], skill, values: stringValues });
			this._post();
			this._drainQueues();
			return;
		}
		if (skill.result === 'chat') {
			// Its own attachments — none — not the chips in the box, which are
			// the user's next message.
			const entry: ChatSkillRun = { tab, chatId: tab.chat.id, sending: true, skill, values: stringValues };
			this._addChatRun(entry);
			this._post();
			try {
				await this._send(steps[0].text, tab.id, []);
			} finally {
				entry.sending = false;
				this._post();
			}
			return;
		}
		const backend = this._registry.backend(agent);
		if (!backend) {
			refuse(vscode.l10n.t("No agent is available to run {0}.", skill.name));
			return;
		}
		// In the folder of the tab it was pressed in, which is that conversation's project.
		if (!isDirectory(tab.cwd)) {
			refuse(vscode.l10n.t("The folder this conversation works in is gone: {0}.", plainInLabel(tab.cwd)));
			return;
		}
		const chat = tab.chat;
		try {
			await this._gitAccess.launch(tab.cwd,
				() => !this._disposed && this._tabs.includes(tab) && tab.chat === chat,
				() => this._runs.start(skill, steps, stringValues, chat.id, backend, model, effort, tab.cwd, tab.projectRoot, !this._untrusted(tab.cwd)), waitForGit);
		} catch (error) {
			refuse(error instanceof Error ? error.message : String(error));
		}
	}

	/**
	 * A toolbar skill's run ended on its own — in the background or in the chat —
	 * and is told as the skill asks: its result in a notification (`toast`), with
	 * Copy and Open for the whole of it, and/or a notification of the end, ours
	 * (`auto`) or the user's own text with its placeholders filled in.
	 *
	 * A notification pauses a browser tab on screen until it is dismissed (see
	 * "A notification pauses the built-in browser" in CLAUDE.md); these are asked
	 * for, per skill, and the editor says so. Everything shown goes through
	 * `plainInNotification`: a result is a model's text, and a notification body
	 * opens `[x](command:…)` as a one-click command (#124).
	 */
	private _skillEnded(skill: ToolbarSkill, end: SkillEnd): void {
		const name = skill.label ?? skill.name;
		const failed = end.status === 'failed';
		const toast = skill.result === 'toast' && !failed && end.result !== undefined;
		const status = failed ? vscode.l10n.t("failed") : vscode.l10n.t("done");
		let text: string | undefined;
		if (skill.notify?.mode === 'text') {
			text = notificationText(skill.notify.text, { ...end.values, skill: name, status, message: end.message ?? '', result: end.result ?? '' });
			if (toast && !/\{\{\s*result\s*\}\}/.test(skill.notify.text)) {
				text = `${text} — ${end.result}`;
			}
		} else if (toast) {
			text = `${name}: ${end.result}`;
		} else if (skill.notify?.mode === 'auto' || skill.result === 'toast') {
			// Ours; a `toast` skill that ended with nothing to show says why even unasked.
			// "Done." says nothing the sentence does not; anything else — why a check
			// stopped the skill, where the result went — is said after the name.
			const said = end.message && end.message !== vscode.l10n.t("Done.") ? end.message : undefined;
			text = failed
				? end.message ? vscode.l10n.t("{0} failed: {1}", name, end.message) : vscode.l10n.t("{0} ended with an error — see its chat.", name)
				: said ? `${name}: ${said}` : vscode.l10n.t("{0} is done.", name);
		}
		if (!text) {
			return;
		}
		const shown = plainInNotification(text, skillToastLimit);
		const copy = vscode.l10n.t("Copy");
		const open = vscode.l10n.t("Open");
		const result = toast ? end.result! : undefined;
		const buttons = result !== undefined ? [copy, open] : [];
		const shownNow = failed ? vscode.window.showWarningMessage(shown, ...buttons) : vscode.window.showInformationMessage(shown, ...buttons);
		void Promise.resolve(shownNow).then(async choice => {
			if (result === undefined) {
				return;
			}
			if (choice === copy) {
				await vscode.env.clipboard.writeText(result);
				confirm(vscode.l10n.t("{0}: copied to the clipboard.", name));
			} else if (choice === open) {
				await this._openText(skill.name, result);
			}
		}).catch(err => refuse(err instanceof Error ? err.message : String(err)));
	}

	private _fail(err: unknown): void {
		this._active.push({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
	}

	/* ------------------------------------------------------------ selection */

	/**
	 * The agent, model and effort in force, made valid against what was
	 * detected: an agent that is no longer available, a model it no longer
	 * lists or an effort the model does not take falls back rather than being
	 * sent to a CLI that would refuse it.
	 */
	private _selection(tab = (this._chromeCommand?.getStore()?.tab ?? this._active)): Selection {
		const agents = this._registry.agents;
		const available = agents.filter(a => a.available);
		const agent = tab.started
			? agents.find(a => a.id === tab.chat.agent)
			: available.find(a => a.id === this._remembered.agent) ?? available[0];
		if (!agent) {
			return {};
		}
		const model = agent.models.find(m => m.id === this._remembered.models[agent.id])
			?? agent.models.find(m => m.isDefault)
			?? agent.models[0];
		if (!model) {
			return { agent: agent.id };
		}
		const remembered = this._remembered.efforts[`${agent.id}:${model.id}`];
		const effort = model.efforts.includes(remembered) ? remembered : model.defaultEffort ?? model.efforts[0];
		return { agent: agent.id, model: model.id, effort,
			ultracode: agent.id === 'claude' && model.efforts.includes('xhigh') ? tab.chat.ultracode ?? false : undefined };
	}

	/** The label of the model a tab's agent uses, when the detected agent lists it (`ChatTabSummary.model`). */
	private _tabModel(tab: ChatTab): { model?: string } {
		const { agent, model } = this._selection(tab);
		const label = this._registry.agents.find(a => a.id === agent)?.models.find(m => m.id === model)?.label;
		return label ? { model: `${agent} → ${shortModelName(label)}` } : {};
	}

	private _select(selection: Selection): void {
		const before = this._selection();
		// A conversation belongs to one agent: another agent picked for one that
		// has started is a question — a new tab beside it, in its place, or
		// carrying it on — asked in the view, and the remembered agent waits for
		// the answer.
		const switching = !!selection.agent && selection.agent !== before.agent && this._active.started;
		const next: RememberedSelection = {
			ultracode: selection.agent === 'claude' && typeof selection.ultracode === 'boolean' ? selection.ultracode : this._context.globalState.get<RememberedSelection>(selectionKey)?.ultracode ?? this._remembered.ultracode,
			agent: switching ? this._remembered.agent : selection.agent ?? this._remembered.agent,
			models: { ...this._remembered.models },
			efforts: { ...this._remembered.efforts },
		};
		if (selection.agent && selection.model) {
			next.models[selection.agent] = selection.model;
		}
		if (selection.agent && selection.model && selection.effort) {
			next.efforts[`${selection.agent}:${selection.model}`] = selection.effort;
		}
		if (!switching && selection.agent === 'claude' && typeof selection.ultracode === 'boolean') {
			this._active.chat.ultracode = selection.ultracode;
			void this._save(this._active.chat);
			this._saveTabs();
		}
		this._remembered = next;
		void this._context.globalState.update(selectionKey, next).then(undefined, () => { /* best effort */ });

		this._switchTo = switching ? selection.agent : undefined;
		this._post();
	}

	/* ------------------------------------------------------------ turns */

	/**
	 * `given`: a queued message's own attachments, sent instead of what the box
	 * holds — which is the user's next message, not this one's.
	 */
	private async _send(text: string, tabId?: string, given?: Attachment[], step?: SkillStep): Promise<void> {
		const queued = given !== undefined;
		// The tab it was typed in, whatever is in front by now: the state post
		// that shows another tab is up to 40 ms behind the click that chose it.
		const tab = tabId ? this._tabs.find(t => t.id === tabId) : this._active;
		if (this._blocked()) {
			// A skill prompt not sent stops its skill: the next one's check, if it
			// has one, was never asked, and the steps after it lose their place.
			if (tab && step) {
				tab.stepNotSent(step, vscode.l10n.t("the chat cannot run in this window"));
			}
			return;
		}
		if (!tab) {
			this._notSent(text);
			return;
		}
		const chat = tab.chat;
		const stopGeneration = tab.stopGeneration;
		// Sent while the agents were still being looked for: wait for the answer
		// rather than refuse. Refusing lost the message — the webview clears its
		// draft on send — and told the user to install an agent that was there.
		if (this._registry.detecting) {
			await this._registry.detect();
			// Detection can take seconds, and meanwhile the tab may have closed,
			// been replaced, or been given another chat from the history. Sent
			// anyway, the message went into a conversation it was not written for,
			// or started a CLI for a tab nothing showed or could stop (#339).
			if (tab.stopGeneration !== stopGeneration) { return; }
			if (!this._tabs.includes(tab) || tab.chat !== chat) {
				if (step && this._tabs.includes(tab)) {
					tab.dropSteps(step.chain);
				}
				this._notSent(text);
				return;
			}
		}
		// Remembered for ↑ even when it is refused below: that is when getting
		// the text back matters most. A queued message was remembered when queued.
		if (!queued) {
			void this._rememberInput(text);
		}
		const { agent, model, effort, ultracode } = this._selection(tab);
		const backend = agent && this._registry.backend(agent);
		if (!agent || !model || !backend) {
			const problems = this._registry.agents.map(a => a.problem).filter(Boolean);
			tab.push({ kind: 'error', text: problems.length ? problems.join('\n') : vscode.l10n.t("No agent is available. Install Claude Code or Codex, then press Refresh.") });
			// Kept in the chat rather than lost, so it can be copied and sent again.
			if (text.trim()) {
				tab.push({ kind: 'notice', text: vscode.l10n.t("Not sent: {0}", text) });
			}
			if (step) {
				tab.stepNotSent(step, vscode.l10n.t("no agent is available"));
			}
			return;
		}
		// A conversation from the history keeps the folder it worked in, which
		// may have been moved or deleted since; the CLI would then fail to start
		// with a message about its own executable.
		if (tab.chat.folder !== undefined && !isDirectory(tab.chat.folder)) {
			tab.push({ kind: 'error', text: vscode.l10n.t("The folder this conversation works in is gone: {0}. Pick another one with the folder button — it opens a new tab.", tab.chat.folder) });
			if (text.trim()) {
				tab.push({ kind: 'notice', text: vscode.l10n.t("Not sent: {0}", text) });
			}
			if (step) {
				tab.stepNotSent(step, vscode.l10n.t("its folder is gone"));
			}
			return;
		}
		try {
			await this._gitAccess.launch(tab.cwd,
				() => !this._disposed && this._tabs.includes(tab) && tab.chat === chat && tab.stopGeneration === stopGeneration,
				async () => {
					const attachments = given ?? tab.attachments;
					if (!text.trim() && !attachments.length) {
						return;
					}
					if (!given) {
						tab.takeDraftAttachments();
					}
					// Only the tab in front's card: a queued message going out in another
					// tab must not close the question the user is reading here.
					if (tab === this._active) {
						this._switchTo = undefined;
					}
					const needsTitle = !tab.started && !tab.chat.named;
					const titleContext = [text.slice(0, 1000), ...attachments.slice(0, 5).map(a => a.chip.label.slice(0, 80))].join('\n').slice(0, 1200);
					const sent = tab.send(text, attachments, agent, model, effort, backend, step, ultracode);
					if (needsTitle) { this._generateTabTitle(tab, agent, titleContext); }
					const delivered = await sent;
					this._saveTabs();
					if (delivered) { this._removeSentAnnotations(attachments); }
				}, queued);
		} catch (error) {
			if (tab.stopGeneration !== stopGeneration) { return; }
			if (this._tabs.includes(tab) && tab.chat === chat) {
				tab.push({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
				if (step) { tab.stepNotSent(step, 'Git is updating the repository'); }
			}
			if (!queued && text.trim()) {
				if (tab === this._active && tab.chat === chat) {
					this._postMessage({ type: 'restoreDraft', chatId: chat.id, text });
				} else { this._notSent(text); }
			}
		}
	}

	private readonly _branchNameRequests = new Map<ChatTab, AbortController>();
	private readonly _featureRequestAgents = new WeakMap<AbortController, AgentId>();
	private readonly _branchNameRequestIds = new WeakMap<AbortController, number>();

	private readonly _titleRequests = new Map<ChatTab, AbortController>();

	private _featureSelection(feature: AiFeature, tab: ChatTab, currentAgent = this._selection(tab).agent) {
		const choice = readFeatureAiSettings(this._context.globalState.get(featureAiKey))[feature];
		const agent = featureAgent(choice, currentAgent, id => this._registry.agents.some(a => a.id === id && a.available && a.models.length > 0));
		const available = this._registry.agents.find(a => a.id === agent && a.available);
		if (!available || !agent) { throw new Error('The agent selected for this feature is unavailable. Open Chat Settings to choose another.'); }
		const selection = this._selection(tab);
		const model = feature === 'commitMessage'
			? available.models.find(m => m.id === (selection.agent === agent ? selection.model : this._remembered.models[agent]))
				?? available.models.find(m => m.isDefault) ?? available.models[0]
			: titleModel(available.models);
		if (!model) { throw new Error(feature === 'commitMessage' ? 'No model is available for the selected agent.' : 'No lightweight model is available for the selected agent.'); }
		return { agent, model, effort: featureEffort(model, choice.effort), prompt: choice.prompt ?? defaultFeaturePrompts[feature] };
	}

	private _generateTabTitle(tab: ChatTab, agent: AgentId, context: string): void {
		let selected: ReturnType<ChatViewProvider['_featureSelection']>;
		try { selected = this._featureSelection('chatTitle', tab, agent); } catch { return; }
		const backend = this._registry.backend(selected.agent);
		if (!backend?.generateTitle) { return; }
		const model = { ...selected.model, efforts: selected.effort ? [selected.effort] : [] };
		this._titleRequests.get(tab)?.abort();
		const chatId = tab.chat.id;
		const controller = new AbortController();
		this._titleRequests.set(tab, controller);
		this._featureRequestAgents.set(controller, selected.agent);
		void backend.generateTitle(model, context, controller.signal, undefined, selected.prompt).then(title => {
			if (title && !controller.signal.aborted && this._tabs.includes(tab)) { tab.applyGeneratedTitle(chatId, title); }
		}).catch(() => undefined).finally(() => {
			if (this._titleRequests.get(tab) === controller) { this._titleRequests.delete(tab); }
		});
	}

	/**
	 * ⌘/Ctrl+Enter: held for after the running turn, with the attachments in
	 * the box. Sent at once when nothing is running — there is nothing to wait for.
	 */
	private _queue(text: string, tabId?: string): void {
		const tab = tabId ? this._tabs.find(t => t.id === tabId) : this._active;
		if (!tab) {
			this._notSent(text);
			return;
		}
		// Nothing to wait for: no turn, nothing queued or waiting before it —
		// and no hold: a paused queue keeps what is queued, this message too.
		if (!tab.running && !tab.busy && !tab.pendingSends.length && !tab.paused) {
			void this._send(text, tab.id).catch(err => this._fail(err));
			return;
		}
		const attachments = tab.attachments;
		if (!text.trim() && !attachments.length) {
			return;
		}
		void this._rememberInput(text);
		tab.takeDraftAttachments();
		tab.enqueue(text, attachments);
	}

	/** Tabs whose next queued message is on its way, to the timer and through the send. */
	private readonly _draining = new Map<ChatTab, ReturnType<typeof setTimeout> | undefined>();
	private _disposed = false;

	/**
	 * Sends a tab's next queued message once its turn is over — not at the
	 * instant it ends: Claude Code may start a turn of its own right after one
	 * (`requesting`, milliseconds later), and a send then would be taken into
	 * it. So the tab must still be idle a moment later, **and still hold the
	 * conversation the message was queued in**. Not while there is no view: the
	 * view going stopped this tab's work, and a message nobody sees go out would
	 * start a CLI for it. A tab stays draining until its send has gone through,
	 * so a send waiting on detection is not followed by the next one.
	 */
	private _drainQueues(): void {
		if (this._disposed || !this._view) {
			return;
		}
		for (const tab of this._tabs) {
			if (!tab.readyForQueued || this._draining.has(tab)) {
				continue;
			}
			const chat = tab.chat;
			this._draining.set(tab, setTimeout(() => {
				this._draining.set(tab, undefined);
				if (this._disposed || !this._view || !this._tabs.includes(tab) || tab.chat !== chat || !tab.readyForQueued) {
					this._draining.delete(tab);
					return;
				}
				const next = tab.dequeue();
				if (!next) {
					this._draining.delete(tab);
					return;
				}
				// A background skill queued for after the turn starts here,
				// checked again as a press would be; the next queued item waits
				// for it to be started, not for it to finish.
				const started = next.background
					? this._runToolbarSkill(next.background.skillId, next.background.values, tab.id, true, false, true)
					: this._send(next.text, tab.id, next.attachments, next.step);
				started
					.catch(err => this._fail(err))
					.finally(() => {
						this._draining.delete(tab);
						this._drainQueues();
					});
			}, 500));
		}
	}

	/**
	 * "Clear conversation": the tab in front starts a new, empty one with the
	 * same agent, the old one staying in the history — what Claude Code's own
	 * `/clear` does. What the tab was doing stops (the view asked first when it
	 * was busy), its queue goes back into the box, and a name the user gave the
	 * tab stays on it.
	 */
	private _clearChat(): void {
		const tab = this._active;
		if (!tab.chat.entries.length && !tab.busy && !this._runs.runningIn(tab.chat.id)) {
			return;
		}
		this._giveBackQueue(tab);
		const next = newChat(tab.chat.agent);
		next.folder = tab.chat.folder;
		next.copy = tab.chat.copy;
		next.references = tab.chat.references;
		if (tab.chat.named) {
			next.title = tab.chat.title;
			next.named = true;
		}
		// The terminals pinned to the tab stay: Clear changes the chat under it, not the work beside it.
		tab.start(next, true);
		this._switchTo = undefined;
		this._post();
		this._focusInput();
	}

	/**
	 * "Export conversation": the conversation as Markdown, the transcript the
	 * other agent is handed (`chatTranscript`). To a file, it opens as a new
	 * editor tab and Save As is asked for, so the user picks where it goes.
	 * **The editor's language is plain text** although the name ends in `.md`:
	 * a reply or a page's text in a Markdown editor makes `[x](command:…)` a link
	 * that runs a command on Cmd+click (#371).
	 */
	private async _exportChat(to: 'clipboard' | 'file'): Promise<void> {
		const chat = this._active.chat;
		if (!chat.entries.some(e => e.kind === 'user' || e.kind === 'assistant')) {
			refuse(vscode.l10n.t("Nothing to export yet."));
			return;
		}
		const now = new Date();
		const text = chatTranscript(chat.title, agentNames[chat.agent], chat.entries, now);
		if (to === 'clipboard') {
			await vscode.env.clipboard.writeText(text);
			confirm(vscode.l10n.t("Conversation copied as Markdown."));
			return;
		}
		try {
			const folder = this._active.chat.folder ?? vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file')?.uri.fsPath ?? os.homedir();
			const uri = vscode.Uri.file(path.join(folder, transcriptFileName(chat.title, now))).with({ scheme: 'untitled' });
			const doc = await vscode.languages.setTextDocumentLanguage(await vscode.workspace.openTextDocument(uri), 'plaintext');
			const edit = new vscode.WorkspaceEdit();
			edit.insert(doc.uri, new vscode.Position(0, 0), text);
			await vscode.workspace.applyEdit(edit);
			await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false });
			await vscode.commands.executeCommand('workbench.action.files.saveAs');
		} catch (err) {
			refuse(vscode.l10n.t("Could not open the export: {0}", plainInLabel(err instanceof Error ? err.message : String(err), 120)));
		}
	}

	/**
	 * A tab letting go of its conversation keeps none of its queue: written for
	 * that conversation, it goes back into the message box, as Stop gives it —
	 * never on to whatever the tab holds next.
	 */
	private _giveBackQueue(tab: ChatTab): void {
		const queued = tab.takeQueued();
		if (!queued.length) {
			return;
		}
		tab.attachmentReferences.assign(tab.attachments.map(a => a.chip));
		const texts = queued.map(q => tab.attachmentReferences.restore(q.attachments.map(a => a.chip), q.text));
		tab.attachments.push(...queued.flatMap(q => q.attachments));
		this._postMessage({ type: 'restoreDraft', chatId: tab.chat.id, text: texts.filter(Boolean).join('\n\n') });
	}

	/** A message whose tab went away before it could be sent: kept in the chat in front, to send again. */
	private _notSent(text: string): void {
		if (text.trim()) {
			this._active.push({ kind: 'notice', text: vscode.l10n.t("Not sent, its chat was closed or changed: {0}", text) });
		}
	}

	/**
	 * What the composer's ↑ / ↓ walk through: the messages sent from this
	 * workspace, oldest first, the newest last. Per workspace rather than per
	 * user, like the chat history itself — a prompt is usually about the project
	 * it was written in. A repeat of the newest is not stored twice.
	 */
	private _inputHistory(): string[] {
		return this._context.workspaceState.get<string[]>(inputHistoryKey) ?? [];
	}

	private async _rememberInput(text: string): Promise<void> {
		// A pasted log is not worth recalling, and 100 of them would be rewritten
		// on every send.
		if (!text.trim() || text.length > storedTextLimit) {
			return;
		}
		const items = this._inputHistory();
		if (items[items.length - 1] !== text) {
			items.push(text);
		}
		const kept = items.slice(-inputHistoryLimit);
		try {
			await this._context.workspaceState.update(inputHistoryKey, kept);
		} catch {
			// A convenience; the message itself is sent regardless.
		}
		this._postMessage({ type: 'inputHistory', items: kept });
	}

	/* ------------------------------------------------------------ voice messages */

	/** Whether this machine can record, asked once: it does not change while the window runs, and the state is built every 40 ms. */
	private _voiceMachine?: { reason?: string };

	private _voiceAvailability(): ChatViewState['voice'] {
		this._voiceMachine ??= { reason: voiceUnavailable(this._context.extensionPath, hostIsRemote()) };
		const reason = this._blocked() ?? this._voiceMachine.reason;
		return { available: !reason, reason, maxSeconds: voiceMaxSeconds };
	}

	/**
	 * The microphone button: the helper records for the tab in front until Enter, Space or
	 * Escape. Recorded in the extension host because a webview may not open the microphone —
	 * VS Code grants `vscode-webview://` no `media` permission.
	 */
	private async _voiceStart(): Promise<void> {
		const { reason } = this._voiceAvailability();
		if (reason) {
			this._postVoice({ phase: 'error', message: reason });
			return;
		}
		// One recording at a time. One still live here was started for a view that has gone
		// without telling us — a webview reload — and nobody can see or end it: it goes.
		this._voiceCancel();
		this._voiceAttached = undefined;
		const generation = ++this._voiceGeneration;
		const tab = this._active;
		const chatId = tab.chat.id;
		this._postVoice({ phase: 'starting' });
		let file: string;
		try {
			file = path.join(await projectTempDirectory(tab.cwd, 'captures'), `voice-${generateUuid()}.m4a`);
			await trackTemporaryFile(file, tab.cwd);
		} catch (err) {
			this._postVoice({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
			return;
		}
		// A cancel, a newer start, the view closing or the provider going while that was awaited.
		if (this._disposed || !this._view || generation !== this._voiceGeneration) {
			return;
		}
		const locale = vscode.workspace.getConfiguration('aiBrowser.chat').get<unknown>('voiceLanguage');
		let current: Voice | undefined;
		const recording = new VoiceRecording(voiceHelperPath(this._context.extensionPath), file, voiceMaxSeconds,
			typeof locale === 'string' && voiceLocalePattern.test(locale) ? locale : '',
			line => { if (current && this._voice === current) { this._voiceEvent(current, line); } });
		current = { recording, tab, chatId };
		this._voice = current;
	}

	/** Voice events reach a view that is there, or nobody: queued, 25 levels a second would pile up for the next one. */
	private _postVoice(event: VoiceEvent): void {
		if (this._view && this._viewReady) {
			void this._view.webview.postMessage({ type: 'voice', event } satisfies HostToView);
		}
	}

	private _voiceEvent(voice: Voice, line: HelperLine): void {
		switch (line.e) {
			case 'ready':
				this._postVoice({ phase: 'recording', level: 0, seconds: 0, locale: line.locale });
				return;
			case 'level':
				this._postVoice({ phase: 'recording', level: line.v, seconds: line.t });
				return;
			case 'limit':
				this._postVoice({ phase: 'limit', seconds: line.t });
				return;
			case 'status':
				this._postVoice({ phase: line.v });
				return;
			case 'error': {
				this._voice = undefined;
				const message = line.code === 'denied'
					? vscode.l10n.t("Microphone access is off for VS Code. Turn it on in System Settings › Privacy & Security › Microphone, then quit and reopen VS Code.")
					: line.code === 'locale'
						? vscode.l10n.t("{0} Set aiBrowser.chat.voiceLanguage to a language macOS can transcribe.", line.message)
						: line.message;
				this._postVoice({ phase: 'error', message });
				return;
			}
			case 'text': {
				this._voice = undefined;
				const transcript = tidyTranscript(line.v);
				if (!transcript) {
					this._postVoice({ phase: 'error', message: vscode.l10n.t("Nothing was heard in the recording.") });
					return;
				}
				// The usual case, asked for: the words go into the message box like typed text,
				// where they can be read and changed before sending. Only the box in front can
				// take them, and only while it still holds the conversation it was recorded for.
				if (voice.tab === this._active && voice.tab.chat.id === voice.chatId) {
					this._postVoice({ phase: 'done', send: voice.action === 'send', text: transcript });
					return;
				}
				// Otherwise — another tab in front, the tab cleared — a chip on the tab it was
				// recorded for (or the one in front if that one closed), never sent unseen.
				const tab = this._tabs.includes(voice.tab) ? voice.tab : this._active;
				const chipId = generateUuid();
				tab.attachments.push({
					chip: { id: chipId, kind: 'voice', label: voiceChipLabel(transcript, line.t) },
					text: voicePromptText(transcript, line.t),
					spoken: transcript,
				});
				this._voiceAttached = { tab, chipId };
				// The state goes first and at once, not coalesced: the view's Enter sends
				// what it holds, and the chip must be in it by then.
				clearTimeout(this._postTimer);
				this._postTimer = undefined;
				this._postMessage({ type: 'state', state: this._state() });
				this._postVoice({ phase: 'done', send: false });
				return;
			}
		}
	}

	/**
	 * Escape, the view closing, the provider going. With nothing recording, a cancel from the view
	 * crossed the transcript on its way — Enter, then Escape within the transcription — and the
	 * chip that transcript left is taken back: the user threw it away. The view posts a cancel
	 * only while it shows a recording, never after the transcript has reached it.
	 */
	private _voiceCancel(fromView = false): void {
		this._voiceGeneration++;
		const voice = this._voice;
		this._voice = undefined;
		if (voice && !voice.recording.ended) {
			voice.recording.cancel();
			this._postVoice({ phase: 'cancelled' });
			return;
		}
		const attached = this._voiceAttached;
		this._voiceAttached = undefined;
		if (fromView && attached) {
			const index = attached.tab.attachments.findIndex(a => a.chip.id === attached.chipId);
			if (index >= 0) {
				attached.tab.attachments.splice(index, 1);
				this._post();
			}
		}
	}

	/* ------------------------------------------------------------ attachments */

	public get temporaryProject(): string | undefined { return this._workdir(); }

	private _temporaryCleaning = false;
	private async _temporaryFiles(action: 'refresh' | 'all' | 'project', expectedProject?: string): Promise<void> {
		if (this._temporaryCleaning) { return; }
		this._temporaryCleaning = true;
		try {
			const project = this._workdir();
			if (action === 'project' && (!project || expectedProject !== project)) { throw new Error('The selected project changed. Refresh the temporary files list before cleaning.'); }
			const isBusy = () => this._recording?.current || this._voice || this._tabs.some(tab => tab.busy || tab.waiting || tab.queuedCount > 0 || this._runs.runningIn(tab.chat.id) > 0)
				|| [...this._gitCommits.values()].some(job => job.state.phase === 'generating' || job.state.phase === 'committing') || this._branchNameRequests.size || this._titleRequests.size;
			const busy = isBusy();
			const root = await privateTempDirectory();
			const legacy = await legacyPrivateTempDirectory();
			const storage = await temporaryStorage({ root, legacyRoots: legacy ? [legacy] : [], inventory: await privateTempDirectory('inventory'),
				project, projects: [...this._recentFolders(), ...this._tabs.map(tab => tab.cwd), ...this._workspaceFolders().map(folder => folder.path)],
				protectedFiles: this._tabs.flatMap(tab => tab.attachments.flatMap(attachment => attachment.file ? [attachment.file.fsPath] : [])),
				cleanup: action === 'refresh' ? undefined : action,
				// Compared in one spelling: on Windows `fsPath` lowercases the drive
				// letter and the scanned paths do not, so a plain `===` never matched
				// and the draft's own file was deleted.
				protect: file => !!isBusy() || this._tabs.some(tab => tab.attachments.some(attachment => !!attachment.file && comparablePath(attachment.file.fsPath) === comparablePath(file))),
				busy: busy ? 'Finish active recordings and agent requests before cleaning temporary files.' : undefined,
			});
			this._postMessage({ type: 'temporaryStorage', storage });
		} catch (error) {
			this._postMessage({ type: 'temporaryStorage', error: error instanceof Error ? error.message : String(error) });
		} finally { this._temporaryCleaning = false; }
	}

	public recordingProject(chatId: string): string | undefined {
		const tab = this._tabs.find(tab => tab.chat.id === chatId);
		return tab ? this._workdir(tab) : undefined;
	}

	public recordingDestination(chatId?: string): RecordingDestination | undefined {
		if (this._disposed || this._blocked()) { return undefined; }
		const tab = chatId ? this._tabs.find(tab => tab.chat.id === chatId) : this._active;
		if (!tab) { return undefined; }
		const original = tab.chat.id;
		return (result, file) => {
			if (this._disposed || !this._tabs.includes(tab) || tab.chat.id !== original) { return false; }
			tab.attachments.push({
				chip: { id: generateUuid(), kind: 'video', label: `Video · ${result.durationSeconds.toFixed(1)}s` }, file,
				text: `Recorded browser video: ${file.fsPath}\nFormat: ${result.mimeType}; duration: ${result.durationSeconds.toFixed(1)} seconds; size: ${result.bytes} bytes.\nThis attachment is a local video file reference, not native video input.`,
			});
			this._post();
			return true;
		};
	}

	private async _pasteFile(message: Extract<ViewToHost, { type: 'pasteFile' }>): Promise<void> {
		let saved: string | undefined;
		try {
			const tab = this._tabs.find(tab => tab.id === message.tabId && tab.chat.id === message.chatId);
			if (!tab) { throw new Error('The destination chat is no longer open.'); }
			if (typeof message.base64 !== 'string' || message.base64.length > Math.ceil(pastedFileLimit / 3) * 4
				|| message.base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(message.base64)) {
				throw new Error('Invalid clipboard file or file exceeds 64 MB.');
			}
			const data = Buffer.from(message.base64, 'base64');
			if (data.toString('base64') !== message.base64) { throw new Error('Invalid clipboard file.'); }
			if (data.length > pastedFileLimit) { throw new Error('Clipboard files must be 64 MB or smaller.'); }
			const name = pastedFileName(message.name);
			const project = this._workdir(tab);
			saved = await writeExclusive(await projectTempDirectory(project, 'files'), `${generateUuid()}-${name}`, data);
			await trackTemporaryFile(saved, project);
			if (this._disposed || !this._tabs.includes(tab) || tab.chat.id !== message.chatId) {
				throw new Error('The destination chat is no longer open.');
			}
			const imageType = pastedImageType(name, message.mime);
			const video = message.mime.startsWith('video/') || /\.(mp4|webm|mov|m4v|avi|mkv)$/i.test(name);
			tab.attachments.push({
				chip: { id: generateUuid(), kind: video ? 'video' : 'file', label: name, ...(video ? {} : { iconName: name }) },
				file: vscode.Uri.file(saved),
				text: `Attached file: ${saved}`,
				image: imageType ? { mediaType: imageType, base64: message.base64 } : undefined,
			});
			this._post();
			// Publish chips before acknowledging so attachment-only messages can be sent immediately.
			this._postMessage({ type: 'state', state: this._state() });
			this._postMessage({ type: 'pastedFileResult', id: message.id });
		} catch (error) {
			if (saved) { await fs.promises.unlink(saved).catch(() => {}); }
			this._postMessage({ type: 'pastedFileResult', id: message.id, error: error instanceof Error ? error.message : String(error) });
		}
	}

	/**
	 * One line for a page-address attachment: which tab it came from, by the id
	 * `browser_tabs` lists, and how the `ai-browser` tools reach it. Tool names
	 * by suffix, since each client puts its own prefix on them (#144); the
	 * agent must check its actual target: caller-specific pins and assignments
	 * can override the tab in front.
	 */
	private _tabNote(tab: vscode.BrowserTab): string {
		if (!this._browserServer()) {
			return 'Browser tools: the ai-browser MCP server is off (aiBrowser.mcp.enabled), so the page cannot be read or driven from here.\nFor this page, use only the built-in ai-browser MCP as your browser; do not use other browser tools or launch a separate browser. If it is unavailable, report that instead of switching tools.';
		}
		const id = this._browser.tabIdOf(tab);
		const active = this._browser.focusedTab === tab ? 'active' : 'not active';
		return `Browser tab ${id} (${active}). ai-browser MCP tools: names end in browser_state, browser_snapshot, browser_click… Check browser_state before acting; pins or sharing may target another tab. If needed, use browser_select_tab with "${id}"; if sharing prevents selection, ask the user to assign this tab.\nFor this page, use only the built-in ai-browser MCP as your browser; do not use other browser tools or launch a separate browser. If it is unavailable, report that instead of switching tools.`;
	}

	/** A page-address attachment for `tab`, under the chip id given. */
	private _pageAttachment(tab: vscode.BrowserTab, id: string, kind: 'page' | 'sharedPage' = 'page'): Attachment {
		const title = plainInPrompt(pageTitle(tab.title, tab.url));
		return {
			chip: { id, kind, label: title || tab.url },
			text: `The page the user is looking at: ${tab.url}${title ? ` — "${title}"` : ''}\n${this._tabNote(tab)}`,
		};
	}

	/** Keeps a draft attachment synchronized with its browser tab. */
	private _trackLivePage(id: string, page: vscode.BrowserTab): void {
		this._livePages.set(id, page);
		this._watchLivePages();
	}

	/** Explicit Chrome opens attach their result, never a page discovered while connecting. */
	private async _openBrowser(where?: 'vscode' | 'chrome'): Promise<void> {
		if (where !== 'chrome') {
			this._awaitOpenedPage(this._active);
			await vscode.commands.executeCommand('aiBrowser.newTab');
			return;
		}
		this._pendingOpen?.dispose();
		this._pendingOpen = undefined;
		const chat = this._active;
		const page = await vscode.commands.executeCommand<vscode.BrowserTab | undefined>('aiBrowser.openInChrome');
		if (!page || !this._tabs.includes(chat) || !tabSource.all.includes(page)) { return; }
		const attachment = this._pageAttachment(page, generateUuid());
		chat.attachments.push(attachment);
		this._trackLivePage(attachment.chip.id, page);
		this._post();
	}

	/**
	 * The globe button: the browser tab it opens is attached to the chat tab it
	 * was pressed in as a page address, and the chip follows that page — its
	 * address, title and whether it is the active tab — until the message is
	 * sent or the chip removed. The tab is the first one opened within
	 * {@link livePageWaitMs} of the press; the panel opens none, and then nothing
	 * is attached.
	 */
	private _awaitOpenedPage(chat: ChatTab): void {
		this._pendingOpen?.dispose();
		this._pendingOpen = undefined;
		let opened: vscode.Disposable | undefined;
		try {
			opened = tabSource.onDidOpen(page => {
				if (tabSource.isChrome(page)) { return; }
				done.dispose();
				const target = this._tabs.includes(chat) ? chat : this._active;
				const attachment = this._pageAttachment(page, generateUuid());
				target.attachments.push(attachment);
				this._trackLivePage(attachment.chip.id, page);
				this._post();
			});
		} catch {
			return;
		}
		const timer = setTimeout(() => done.dispose(), livePageWaitMs);
		const done = new vscode.Disposable(() => {
			clearTimeout(timer);
			opened?.dispose();
			if (this._pendingOpen === done) { this._pendingOpen = undefined; }
		});
		this._pendingOpen = done;
	}

	/** Subscribes, once, to what changes a live page chip. */
	private _watchLivePages(): void {
		if (this._livePageWatch) {
			return;
		}
		try {
			this._livePageWatch = vscode.Disposable.from(
				tabSource.onDidChangeState(() => this._refreshLivePages()),
				tabSource.onDidChangeActive(() => this._refreshLivePages()),
				tabSource.onDidClose(page => {
					let changed = false;
					for (const [id, tracked] of this._livePages) {
						if (tracked !== page) { continue; }
						this._livePages.delete(id);
						for (const chat of this._tabs) {
							const index = chat.attachments.findIndex(a => a.chip.id === id);
							if (index !== -1) {
								chat.attachments.splice(index, 1);
								changed = true;
							}
						}
					}
					if (changed) {
						this._post();
					}
				}),
			);
		} catch {
			// The grant went away; the chips simply stop following.
		}
	}

	/** Rebuilds every live page chip still waiting in a draft, and forgets the rest. */
	private _refreshLivePages(): void {
		let changed = false;
		for (const [id, page] of this._livePages) {
			const holder = this._tabs.find(t => t.attachments.some(a => a.chip.id === id));
			if (!holder) {
				// Sent, removed, or its chat tab closed.
				this._livePages.delete(id);
				continue;
			}
			const index = holder.attachments.findIndex(a => a.chip.id === id);
			const old = holder.attachments[index];
			const kind = old.chip.kind === 'sharedPage' ? 'sharedPage' : 'page';
			const next = this._pageAttachment(page, id, kind);
			if (next.text !== old.text || next.chip.label !== old.chip.label) {
				holder.attachmentReferences.assign(holder.attachments.map(a => a.chip));
				preserveAttachmentReference(old.chip, next.chip);
				holder.attachments[index] = next;
				changed = true;
			}
		}
		if (changed) {
			this._post();
		}
	}

	/** The chip and prompt text of one page annotation; the note is the user's, the element context the page's. */
	private _annotationAttachment(record: PageAnnotation, url: string, page: vscode.BrowserTab, id: string): Attachment {
		const tabId = this._browser.tabIdOf(page);
		const note = record.text.trim();
		const label = `#${record.number} ${record.element.tag}${note ? ` — ${note.replace(/\s+/g, ' ')}` : ''}`;
		const text = [
			`Page annotation #${record.number} on ${url}`,
			`Note: ${note ? JSON.stringify(record.text) : '(empty)'}`,
			`Element (untrusted page data): <${record.element.tag}> ${JSON.stringify(record.element.selector)}${record.element.text ? ` text ${JSON.stringify(record.element.text)}` : ''}${record.element.role ? ` role ${JSON.stringify(record.element.role)}` : ''}`,
      ...annotationPointContext(record),
			`Annotation ID ${record.id}, browser tab ${tabId}. The marker is removed from the page once this message is sent, so this text is the annotation.`,
		].join('\n');
		return { chip: { id, kind: 'annotation', label: capAt(plainInLabel(label, 120), 120) }, text };
	}

	/**
	 * A new annotation is attached to the chat tab in front and bound to it;
	 * its chips follow the note as it is typed, and go when the annotation does.
	 * One annotation can have a chip in several chat tabs ("+" → Add annotation
	 * attaches the page's existing ones too), but only the first binds it.
	 */
	private _onAnnotations(change: AnnotationChange): void {
		const remote=ChatViewProvider._exchangeAnnotationOwners.get(change.tab);
		if(remote?.view===this)this._syncExchangeAnnotations(change,remote);
		let changed = false;
		for (const id of change.removed) {
			const link = this._annotationLinks.get(id);
			if (!link) { continue; }
			this._annotationLinks.delete(id);
			for (const chat of this._tabs) {
				const kept = chat.attachments.filter(a => !link.chipIds.includes(a.chip.id));
				if (kept.length !== chat.attachments.length) { chat.attachments = kept; changed = true; }
			}
		}
		const blocked = this._blocked();
		for (const record of change.records) {
			const link = this._annotationLinks.get(record.id);
			if (!link) {
				if(remote)continue;
				if (blocked || !change.created.includes(record.id) || !this._active) { continue; }
				this._attachAnnotation(this._active, record, change.url, change.tab);
				changed = true;
				continue;
			}
			for (const chat of this._tabs) {
				const index = chat.attachments.findIndex(a => link.chipIds.includes(a.chip.id));
				if (index < 0) { continue; }
				const old = chat.attachments[index];
				const next = this._annotationAttachment(record, change.url, change.tab, old.chip.id);
				if (next.text !== old.text || next.chip.label !== old.chip.label) {
					chat.attachmentReferences.assign(chat.attachments.map(a => a.chip));
					preserveAttachmentReference(old.chip, next.chip);
					chat.attachments[index] = next;
					changed = true;
				}
			}
		}
		if (changed) { this._post(); }
	}
	private _syncExchangeAnnotations(change:AnnotationChange,owner:{chatId:string;reply:(message:HostToView,chatId?:string)=>void;ignored:Set<string>}):void {
		if(this._disposed||!this._tabs.some(tab=>tab.chat.id===owner.chatId))return;
		const drafts=this._exchangeDrafts.get(owner.chatId)??new Map<string,Attachment>();this._exchangeDrafts.set(owner.chatId,drafts);
		for(const id of change.removed){if(drafts.delete(id))owner.reply({type:'exchangeAttachment',id,removed:true},owner.chatId);owner.ignored.delete(id);}
		const assistant=this._browser.annotationsOf(change.tab)?.agentMade;
		for(const record of change.records){
			if(assistant?.has(record.id)||owner.ignored.has(record.id)||(!drafts.has(record.id)&&drafts.size>=8))continue;
			const item={...this._annotationAttachment(record,change.url,change.tab,record.id),exchangeAnnotation:{tabId:this._browser.tabIdOf(change.tab),id:record.id}};
			const previous=drafts.get(record.id);drafts.set(record.id,item);
			if(previous?.text!==item.text||previous?.chip.label!==item.chip.label)owner.reply({type:'exchangeAttachment',id:record.id,label:item.chip.label,text:item.text,kind:'annotation'},owner.chatId);
		}
	}

	/**
	 * Adds an annotation's chip to `chat`'s draft, binding the annotation to it if
	 * nothing has. An assistant's marker is never attached or bound: it is not
	 * the user's note, and a bound one would go when this tab closes.
	 */
	private _attachAnnotation(chat: ChatTab, record: PageAnnotation, url: string, page: vscode.BrowserTab): boolean {
		if (this._browser.annotationsOf(page)?.agentMade.has(record.id)) { return false; }
		let link = this._annotationLinks.get(record.id);
		if (link && chat.attachments.some(a => link!.chipIds.includes(a.chip.id))) { return false; }
		if (!link) {
			link = { chat, page, chipIds: [] };
			this._annotationLinks.set(record.id, link);
		}
		const chipId = generateUuid();
		link.chipIds.push(chipId);
		chat.attachments.push(this._annotationAttachment(record, url, page, chipId));
		return true;
	}

	/**
	 * Annotations sent in a message are taken off the page (asked for): the
	 * message carries their note and element, so the marker has done its job.
	 * Only once the agent took the message — a send that failed keeps them, as
	 * the chips go back to nobody. The store's "removed" then takes the chips
	 * other chat tabs hold for them and drops their links (`_onAnnotations`).
	 */
	private _removeSentAnnotations(attachments: readonly Attachment[]): void {
		for (const item of attachments) {
			if(item.exchangeAnnotation){
				const annotation=item.exchangeAnnotation;
				for(const [chatId,drafts] of this._exchangeDrafts)if(drafts.delete(item.chip.id)){
					for(const owner of ChatViewProvider._exchangeAnnotationOwners.values())if(owner.view===this&&owner.chatId===chatId){owner.ignored.add(annotation.id);owner.reply({type:'exchangeAttachment',id:item.chip.id,removed:true},chatId);}
				}
				void this._browser.remoteTab(annotation.tabId).then(page=>this._browser.removeAnnotations(page,[annotation.id])).catch(()=>{});
			}
			if (item.chromeAnnotation) {
				try { void chromeAnnotationSessions.removeSent(item.chromeAnnotation).catch(error => refuse(`Could not remove the sent Chrome annotation: ${String(error)}`)); }
				catch (error) { refuse(`Could not remove the sent Chrome annotation: ${String(error)}`); }
			}
		}
		const sent = new Set(attachments.filter(a => a.chip.kind === 'annotation').map(a => a.chip.id));
		if (!sent.size) { return; }
		const byPage = new Map<vscode.BrowserTab, string[]>();
		for (const [id, link] of this._annotationLinks) {
			if (link.chipIds.some(chip => sent.has(chip))) {
				byPage.set(link.page, [...byPage.get(link.page) ?? [], id]);
			}
		}
		for (const [page, ids] of byPage) {
			this._browser.removeAnnotations(page, ids).catch(err => refuse(vscode.l10n.t('Could not remove the sent annotations from the page: {0}', plainInLabel(err instanceof Error ? err.message : String(err), 120))));
		}
	}

	/** Closing a chat tab deletes the annotations bound to it. */
	private _dropAnnotationsOf(chat: ChatTab): void {
		for(const item of this._exchangeDrafts.get(chat.chat.id)?.values()??[]){const note=item.exchangeAnnotation;if(note)void this._browser.remoteTab(note.tabId).then(page=>this._browser.removeAnnotations(page,[note.id])).catch(()=>{});}
		this._exchangeDrafts.delete(chat.chat.id);
		for(const [page,owner] of ChatViewProvider._exchangeAnnotationOwners)if(owner.view===this&&owner.chatId===chat.chat.id)ChatViewProvider._exchangeAnnotationOwners.delete(page);
		const byPage = new Map<vscode.BrowserTab, string[]>();
		let changed = false;
		for (const [id, link] of this._annotationLinks) {
			if (link.chat !== chat) { continue; }
			this._annotationLinks.delete(id);
			byPage.set(link.page, [...byPage.get(link.page) ?? [], id]);
			// The link goes now, so the store's "removed" will find nothing: take the
			// chips other tabs hold for it here, or they outlive the annotation.
			for (const other of this._tabs) {
				const kept = other.attachments.filter(a => !link.chipIds.includes(a.chip.id));
				if (kept.length !== other.attachments.length) { other.attachments = kept; changed = true; }
			}
		}
		if (changed) { this._post(); }
		for (const [page, ids] of byPage) {
			this._browser.removeAnnotations(page, ids).catch(err => refuse(vscode.l10n.t("Could not delete the annotations of the closed chat: {0}", plainInLabel(err instanceof Error ? err.message : String(err), 120))));
		}
	}

	private async _attach(kind: AttachmentKind): Promise<void> {
		const tab = this._active;
		const attachment = await this._makeAttachment(kind);
		if (attachment) {
			tab.attachments.push(attachment);
			this._post();
			this._focusInput();
		}
	}

	/**
	 * The browser tab menu's "AI Browser Chat ▸": something from the page in
	 * front, attached to the chat tab in front, and the chat shown. The page is
	 * the one whose menu it was — focused by construction — and the pick, which
	 * waits for a click there, comes before the chat is revealed.
	 */
	public async addFromBrowser(what: 'element' | 'cssPath' | 'cssLocation' | 'xpath' | 'screenshot' | 'page'): Promise<void> {
		const blocked = this._blocked();
		if (blocked) {
			refuse(blocked);
			return;
		}
		const tab = this._active;
		const page = this._browser.focusedTab ?? this._browser.userTab;
		let attachment: Attachment | undefined;
		try {
			attachment = await this._fromBrowser(what, page);
		} catch (err) {
			// A capture can fail — the tab closing, the page not answering — and
			// a command that throws gets VS Code's own error toast, over the page
			// just captured (#10). From the chat's "+" the same failure lands in the
			// chat; from the tab's menu it goes to the status bar.
			refuse(vscode.l10n.t("Could not attach from the page: {0}", plainInLabel(err instanceof Error ? err.message : String(err), 120)));
			return;
		}
		if (!attachment) {
			return;
		}
		// The chat tab it was asked from, or the one in front if that one closed meanwhile.
		(this._tabs.includes(tab) ? tab : this._active).attachments.push(attachment);
		// A chip added to a conversation is for looking at it: a terminal in front gives way.
		this._leaveTerminal();
		this._post();
		await this._focusView();
		this._focusInput();
	}

	/** What `addFromBrowser` attaches; may throw — a capture can fail — which the caller reports. */
	private async _fromBrowser(what: 'element' | 'cssPath' | 'cssLocation' | 'xpath' | 'screenshot' | 'page', page: vscode.BrowserTab | undefined): Promise<Attachment | undefined> {
		if (what === 'cssPath' || what === 'cssLocation' || what === 'xpath') {
			if (!tabSource.available() || !page) {
				return this._makeAttachment('element', page);
			} else if (!this._browser.onScreen(page)) {
				// From the palette with a file in front, the page can be covered, and a
				// pick there waits for a click the user cannot make (#355).
				refuse(vscode.l10n.t("\"{0}\" is not on screen — bring its tab to the front, then attach.", plainInLabel(pageTitle(page.title, page.url), 60)));
			} else {
				const picked = await pickForChat(page, what === 'cssPath' ? 'css' : what);
				if (picked) {
					const kindLabel = what === 'xpath' ? vscode.l10n.t("XPath") : what === 'cssPath' ? vscode.l10n.t("CSS path") : vscode.l10n.t("CSS path + location");
					return { chip: { id: generateUuid(), kind: 'element', label: plainInPrompt(`${kindLabel} · ${picked.descriptor}`, 50) }, text: picked.text };
				}
			}
			return undefined;
		}
		return this._makeAttachment(what, page);
	}

	/** `page`: the browser tab to attach from; the one the user last had in front when absent. */
	private async _makeAttachment(kind: AttachmentKind, page?: vscode.BrowserTab, remote=false): Promise<Attachment | undefined> {
		const id = generateUuid();
		if (kind === 'video') {
			if (!this._recording) { throw new Error('Video recording is unavailable.'); }
			await this._recording.start(undefined, 'chat');
			return undefined;
		}
		if (kind === 'voice' || kind === 'selection' || kind === 'terminal') {
			// Created by their dedicated controls, never asked for through "+" (a terminal is a pin, `pinTerminal`).
			return undefined;
		}
		if (kind === 'file') {
			const picked = await vscode.window.showOpenDialog({
				canSelectMany: false,
				defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
				openLabel: vscode.l10n.t("Attach"),
			});
			const file = picked?.[0];
			if (!file) {
				return undefined;
			}
			const shown = vscode.workspace.asRelativePath(file, false);
			// The path, not the contents: both agents read files themselves, and
			// a large file pasted into the prompt would cost the whole context.
			return { chip: { id, kind, label: path.basename(file.fsPath), iconName: path.basename(file.fsPath) }, file, text: `Attached file: ${file.fsPath}${shown !== file.fsPath ? ` (${shown} in the workspace)` : ''}` };
		}

		// Two refusals, because the fixes are unrelated (Recipe, step 3): without
		// the grant no tab can be seen at all, open or not.
		if (!tabSource.available()) {
			refuse(vscode.l10n.t("Open Google Chrome or enable native browser tabs to attach a page."));
			return undefined;
		}
		const tab = page ?? this._browser.userTab;
		if (!tab) {
			refuse(this._browser.hasOpenTabs
				? vscode.l10n.t("Several browser tabs are open — click into the one to attach from, then try again.")
				: vscode.l10n.t("No browser tab is open to attach from."));
			return undefined;
		}

		switch (kind) {
			case 'page':
				return this._pageAttachment(tab, id);
			case 'sharedPage': {
				const attachment = this._pageAttachment(tab, id, 'sharedPage');
				this._trackLivePage(id, tab);
				return attachment;
			}
			case 'screenshot': {
				if (!remote && !this._browser.onScreen(tab)) {
					refuse(vscode.l10n.t("\"{0}\" is not on screen — bring its tab to the front, then attach.", plainInLabel(pageTitle(tab.title, tab.url), 60)));
					return undefined;
				}
				const shot = await this._browser.capture(false, tab);
				const base64 = shot.png.toString('base64');
				const title = plainInPrompt(pageTitle(tab.title, tab.url), 40);
				return {
					chip: { id, kind, label: title ? vscode.l10n.t("Screenshot · {0}", title) : vscode.l10n.t("Screenshot"), thumbnail: `data:image/png;base64,${base64}` },
					text: shot.url ? `The attached image is a screenshot of ${shot.url}.` : undefined,
					image: { mediaType: 'image/png', base64 },
				};
			}
			case 'element': {
				// A pick waits for a click on the page; on a page the user cannot
				// see, that is a wait for something they cannot do.
				if (!remote && !this._browser.onScreen(tab)) {
					refuse(vscode.l10n.t("\"{0}\" is not on screen — bring its tab to the front, then attach.", plainInLabel(pageTitle(tab.title, tab.url), 60)));
					return undefined;
				}
				const markdown = await pickElementContext(tab);
				if (!markdown) {
					return undefined;
				}
				const heading = /^Element:\s*(.+)$/m.exec(markdown)?.[1]?.trim();
				return { chip: { id, kind, label: heading ? plainInPrompt(heading, 40) : vscode.l10n.t("Element") }, text: markdown };
			}
			case 'pointAnnotation':
			case 'annotation': {
				if(!remote)ChatViewProvider._exchangeAnnotationOwners.delete(tab);
				// Starts the page's annotation picker; the chip arrives when the note is
				// made, through `_onAnnotations`, in the chat tab in front.
				if (!this._browser.onScreen(tab)) {
					refuse(vscode.l10n.t("\"{0}\" is not on screen — bring its tab to the front, then attach.", plainInLabel(pageTitle(tab.title, tab.url), 60)));
					return undefined;
				}
				// The page's notes already there come along (asked for): a chip each in
				// the chat tab this was pressed in, unless it holds one already. An
				// assistant's marker is not the user's note and is left out.
				const existing = this._browser.annotationsOf(tab);
				if (existing && this._active) {
					let added = false;
					for (const record of existing.records) {
						if (existing.agentMade.has(record.id)) { continue; }
						added = this._attachAnnotation(this._active, record, existing.url, tab) || added;
					}
					if (added) { this._post(); }
				}
				await this._browser.annotateTab(tab, kind === 'pointAnnotation' ? 'point' : 'element');
				confirm(kind === 'pointAnnotation' ? "Click anywhere on the page to add an annotation (Esc to cancel)." : "Click a page element to add an annotation (Esc to cancel).");
				return undefined;
			}
		}
	}

	/**
	 * A composer chip clicked: what it attaches, in an editor tab — the file
	 * itself; a screenshot as an image, written beside the screenshots; an
	 * element, a page address or a handed-over conversation as a read-only text.
	 * A tab of the active group, among the other editors, as a preview so the
	 * next chip reuses it. `Beside` was the first version and split the editor
	 * area into a new group on every first click, which read as a separate window.
	 */
	private async _openAttachment(id: string, entryIndex?: number): Promise<void> {
		const entry = Number.isInteger(entryIndex) ? this._active.chat.entries[entryIndex!] : undefined;
		const saved = entry?.kind === 'user' ? entry.attachmentData?.find(a => a.chip.id === id) : undefined;
		const attachment = entryIndex === undefined ? this._active.attachments.find(a => a.chip.id === id)
			: saved ? { ...saved, file: saved.file ? vscode.Uri.parse(saved.file) : undefined } : undefined;
		if (!attachment) {
			return;
		}
		const options: vscode.TextDocumentShowOptions = { preview: true, viewColumn: vscode.ViewColumn.Active };
		try {
			if (attachment.file) {
				await vscode.commands.executeCommand('vscode.open', attachment.file, options);
				return;
			}
			if (attachment.image) {
				let uri = this._attachmentImages.get(id);
				// The screenshots directory is swept after a day, so a chip kept that
				// long has lost its file: written again rather than opened missing.
				if (uri && !await vscode.workspace.fs.stat(uri).then(() => true, () => false)) {
					uri = undefined;
				}
				if (!uri) {
					uri = await savePng(Buffer.from(attachment.image.base64, 'base64'), `attachment-${fileSafe(attachment.chip.label)}.png`);
					remember(this._attachmentImages, id, uri);
				}
				await vscode.commands.executeCommand('vscode.open', uri, options);
				return;
			}
			if (attachment.text) {
				remember(this._attachmentTexts, id, attachment.text);
				// Plain text, not Markdown: the text is page-written — an element's id, a
				// page title — and a Markdown editor turns `[x](command:…)` in it into a
				// link that runs a command on Cmd+click, the sink of #124 and #132.
				const uri = vscode.Uri.from({ scheme: this._attachmentScheme, path: `/${fileSafe(attachment.chip.label)}.txt`, query: id });
				await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), options);
			}
		} catch (err) {
			refuse(vscode.l10n.t("Could not open the attachment: {0}", err instanceof Error ? err.message : String(err)));
		}
	}

	/**
	 * A tool call's input or output in an editor tab — read-only and plain text,
	 * for the reason a chip's text is: a command's output or a page's markup can
	 * hold `[x](command:…)`, which a Markdown editor makes a link that runs a
	 * command (#371). A preview, so the next one opened reuses the tab.
	 */
	private async _openText(name: unknown, text: unknown): Promise<void> {
		if (typeof text !== 'string' || typeof name !== 'string') {
			return;
		}
		const body = text.length > openTextLimit
			? `${capAt(text, openTextLimit)}\n\n${vscode.l10n.t("[Cut here: the text goes on for {0} more characters.]", text.length - openTextLimit)}`
			: text;
		const id = `text-${generateUuid()}`;
		remember(this._attachmentTexts, id, body);
		const uri = vscode.Uri.from({ scheme: this._attachmentScheme, path: `/${fileSafe(name)}.txt`, query: id });
		try {
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true, viewColumn: vscode.ViewColumn.Active });
		} catch (err) {
			refuse(vscode.l10n.t("Could not open the text: {0}", err instanceof Error ? err.message : String(err)));
		}
	}

	/**
	 * A diff card in VS Code's diff editor, as a tab of the active group (asked
	 * for): the two sides built from the card's own text (`diffSides`), each a
	 * read-only plain-text document like `_openText`'s, for the same reason. Not
	 * the file on disk: it may have changed since, and the card is what the
	 * agent did. A preview, so the next one reuses the tab.
	 */
	private async _openDiff(name: unknown, diff: unknown): Promise<void> {
		if (typeof diff !== 'string' || typeof name !== 'string') {
			return;
		}
		const { before, after } = diffSides(capAt(diff, openTextLimit));
		const base = fileSafe(name.split(/[\\/]/).pop() || name);
		const side = (label: string, text: string) => {
			const id = `text-${generateUuid()}`;
			remember(this._attachmentTexts, id, text);
			return vscode.Uri.from({ scheme: this._attachmentScheme, path: `/${base} (${label}).txt`, query: id });
		};
		const left = side('before', before);
		const right = side('after', after);
		try {
			await vscode.commands.executeCommand('vscode.diff', left, right, vscode.l10n.t("{0} (changes)", plainInPrompt(name, 80)), { preview: true, viewColumn: vscode.ViewColumn.Active });
		} catch (err) {
			refuse(vscode.l10n.t("Could not open the changes: {0}", err instanceof Error ? err.message : String(err)));
		}
	}

	/* ------------------------------------------------------------ usage */

	/**
	 * New figures for `agent`'s plan. `whole`: a full read, which replaces what
	 * was known; otherwise a turn's own report, which updates the limits it
	 * names. A close that no longer applies — the limit reset — is forgotten,
	 * so the next climb shows the line again; only the limits this report
	 * names are judged (see `settleClosed`).
	 */
	private _noteLimits(agent: AgentId, windows: readonly UsageWindow[], usingCredits: boolean | undefined, whole: boolean): void {
		if (this._disposed) {
			return;
		}
		// What has reset since is dropped first (`currentLimits`), so a sparse
		// report of the new period cannot bring back the old period's credits.
		const state = mergeLimits(currentLimits(this._limits.get(agent), Date.now()), windows, usingCredits, whole);
		this._limits.set(agent, state);
		const closed = this._closedAlerts();
		const settled = settleClosed(closed, agent, state, new Set(windows.map(w => w.label)));
		if (settled !== closed) {
			void this._context.globalState.update(closedAlertsKey, settled).then(undefined, () => undefined);
		}
		this._post();
	}

	private _closedAlerts(): ClosedAlerts {
		return readClosedAlerts(this._context.globalState.get<unknown>(closedAlertsKey));
	}

	/**
	 * The `U` button's level and the limit line, for the agent of the tab in
	 * front: the line is about the plan the next message spends.
	 */
	private _usageState(agent: AgentId | undefined): Pick<ChatViewState, 'usage' | 'usageAlert'> {
		const now = Date.now();
		const known = agent ? this._limits.get(agent) : undefined;
		this._watchReset(nextReset(known, now));
		const state = currentLimits(known, now);
		const closest = closestLimit(state);
		if (!agent || !state || !closest) {
			return {};
		}
		return {
			usage: { percent: closest.usedPercent, label: closest.label, usingCredits: state.usingCredits },
			usageAlert: usageAlertFor(agent, state, this._closedAlerts()),
		};
	}

	/**
	 * A post when `at` passes: a limit that resets takes the line and `U`'s
	 * colour with it (`currentLimits`) without waiting for the next message.
	 * At most an hour ahead, then looked at again: a timer's delay is capped,
	 * and a weekly reset is days away.
	 */
	private _watchReset(at: number | undefined): void {
		if (this._disposed || this._resetTimer?.at === at) {
			return;
		}
		clearTimeout(this._resetTimer?.timer);
		this._resetTimer = undefined;
		if (at === undefined) {
			return;
		}
		const timer = setTimeout(() => {
			this._resetTimer = undefined;
			this._post();
		}, Math.min(Math.max(0, at - Date.now()) + 1_000, 3_600_000));
		this._resetTimer = { at, timer };
	}

	/**
	 * The line closed: what it stood for stays closed until the limit moves on.
	 * Closed as it was shown, which the view sends: a figure that arrived while
	 * the click was on its way was never seen.
	 */
	private _dismissUsageAlert(alert: unknown): void {
		const a = alert as Partial<UsageAlert> | undefined;
		const agent = a?.agent;
		if (!isAgentId(agent)) {
			return;
		}
		const shown: UsageAlert | undefined = typeof a?.label === 'string' && typeof a.percent === 'number' && Number.isFinite(a.percent)
			&& (a.kind === 'high' || a.kind === 'reached' || a.kind === 'credits')
			? { agent, kind: a.kind, label: a.label, percent: a.percent }
			: undefined;
		const closed = closeAlert(this._closedAlerts(), agent, currentLimits(this._limits.get(agent), Date.now()), shown);
		void this._context.globalState.update(closedAlertsKey, closed).then(() => this._post(), () => this._post());
		this._post();
	}

	/**
	 * A turn ended: the plan is asked for when `usageCheckDue` says so — after
	 * a big request, more readily near a limit, otherwise now and then — and
	 * only of a process already running. Between those, the turns' own reports
	 * (Claude Code's `rate_limit_event`, Codex's `account/rateLimits/updated`)
	 * keep the figures current at no cost.
	 */
	private _turnEnded(agent: AgentId, weight: TurnWeight): void {
		const now = Date.now();
		if (this._disposed || this._usageChecks.has(agent)
			|| !usageCheckDue(now, this._usageAsked.get(agent), weight, closestLimit(currentLimits(this._limits.get(agent), now))?.usedPercent)) {
			return;
		}
		const before = this._usageAsked.get(agent);
		this._usageAsked.set(agent, now);
		const timer = setTimeout(() => {
			this._usageChecks.set(agent, undefined);
			const backend = this._disposed ? undefined : this._registry.backend(agent);
			// A check that read nothing — no process running any more, a request
			// that failed — does not count: the next turn may ask again.
			const read = backend ? backend.usage(true).then(u => !u.error, () => false) : Promise.resolve(false);
			void read.then(ok => {
				this._usageChecks.delete(agent);
				if (!ok && this._usageAsked.get(agent) === now) {
					if (before === undefined) {
						this._usageAsked.delete(agent);
					} else {
						this._usageAsked.set(agent, before);
					}
				}
			});
		}, usageCheckDelayMs);
		this._usageChecks.set(agent, timer);
	}

	private async _usage(): Promise<void> {
		const agents = this._registry.agents.filter(a => a.available);
		const stats = (this._chromeCommand?.getStore()?.tab ?? this._active).started ? { ...(this._chromeCommand?.getStore()?.tab ?? this._active).chat.stats } : undefined;
		this._postMessage({ type: 'usage', usage: [], stats, loading: true });
		const usage = await Promise.all(agents.map(async a => {
			const backend = this._registry.backend(a.id);
			const answer: AgentUsage = backend
				? await backend.usage()
				: { agent: a.id, windows: [], notes: [], error: vscode.l10n.t("Not running.") };
			// A turn's own limit report is newer than nothing, if the read failed.
			const live = this._limits.get(a.id);
			return answer.error && live?.windows.length ? { ...answer, windows: live.windows, usingCredits: live.usingCredits, error: undefined } : answer;
		}));
		this._postMessage({ type: 'usage', usage, stats, loading: false });
	}

	/* ------------------------------------------------------------ history */

	/** Hand the saved native session to its CLI in an editor terminal. */
	private async _resumeInTerminal(id: string): Promise<void> {
		const existing = ChatViewProvider._terminalSessions.get(id);
		if (existing) { existing.show(); return; }
		const blocked = this._blocked();
		if (blocked) { void vscode.window.showWarningMessage(blocked); return; }
		const open = this._findOpenChat(id);
		const chat = open?.tab.chat ?? this._history().find(c => c.id === id);
		if (!chat?.ref || !isAgentId(chat.agent)) { return; }
		if (chat.agent === 'openrouter') {
			// OpenRouter is an HTTP API with no CLI behind it: there is nothing to resume in a terminal.
			void vscode.window.showInformationMessage(vscode.l10n.t("OpenRouter conversations have no CLI, so they cannot be continued in a terminal."));
			return;
		}
		if (open && (open.tab.busy || open.tab.queuedCount || open.surface._runs.runningIn(id))) {
			void vscode.window.showInformationMessage(vscode.l10n.t("Wait for this conversation and its agents to finish, and send or remove queued messages before opening it in a terminal."));
			return;
		}
		const cwd = open?.tab.cwd ?? chat.folder ?? this._windowCwd();
		if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
			void vscode.window.showWarningMessage(vscode.l10n.t("The conversation's folder no longer exists."));
			return;
		}
		const registry = open?.surface._registry ?? this._registry;
		const binary = registry.agents.find(a => a.id === chat.agent)?.binary;
		if (!binary) {
			void vscode.window.showWarningMessage(vscode.l10n.t("The agent's CLI was not found. Refresh Agents and try again."));
			return;
		}
		// Do not close the chat or create its terminal while another turn keeps
		// Codex's shared process (and this conversation's writer lock) alive.
		if (chat.agent === 'codex') {
			const codex = registry.backend?.('codex') as { release?(threadId: string): Promise<boolean> } | undefined;
			if (codex?.release && !await codex.release(chat.ref)) {
				void vscode.window.showInformationMessage(vscode.l10n.t('Another Codex conversation is still working. Wait for it to finish, then choose Continue in VS Code terminal again. This chat remains open.'));
				return;
			}
			if (open && (open.tab.busy || open.tab.queuedCount || open.surface._runs.runningIn(id))) { return; }
		}
		// What resumes a conversation: Codex `resume <id>`, OpenCode `-s <id>` (the session ref is OpenCode's own
		// session id — measured), Pi `--session <id>` (from the same folder, or Pi asks to fork it), the rest `--resume <id>`.
		const args = chat.agent === 'codex' ? ['resume', chat.ref]
			: chat.agent === 'opencode' ? ['-s', chat.ref]
			: chat.agent === 'pi' ? piResumeArgs(chat.ref)
			: ['--resume', chat.ref];
		// Not measured for either: browser tools in their TUI. OpenCode and Pi are started plainly, with the user's own
		// configuration; a folder held back stays held back (OpenCode's project config, Pi's project trust).
		if (chat.agent === 'pi' && this._untrusted(cwd)) { args.push('--no-approve'); }
		// Preserve the chat's restriction on project hooks in untrusted managed copies.
		if (chat.agent === 'claude' && this._untrusted(cwd)) { args.push('--setting-sources=user', '--strict-mcp-config'); }
		// The terminal CLI is not ours, so it gets the browser server the chat's
		// own processes get at start; without it the conversation lost the browser
		// tools on the move. The tab the conversation was working on (a Chrome one
		// included) goes along, which seeds the terminal session's selection.
		const launch = await this._browserCliLaunch(chat.agent, chat.id);
		args.push(...launch.args);
		const env = launch.env, config = launch.config;
		// Closing releases the live backend, keeping the conversation in history.
		if (open) { open.surface._closeTab(open.tab.id); }
		// Claude Code and Gemini run a process per conversation: let it exit first.
		if (open) { await JsonLineProcess.stopped(); }
		if (ChatViewProvider._terminalSessions.has(id)) {
			if (config) { fs.rm(config, { force: true }, () => undefined); }
			ChatViewProvider._terminalSessions.get(id)?.show();
			return;
		}
		const terminal = vscode.window.createTerminal({
			name: `${agentNames[chat.agent]} · ${chat.title}`,
			cwd, shellPath: binary, shellArgs: args,
			env: { ...env, PATH: chat.agent === 'pi' ? piPath(binary) : geminiPath(binary), CLAUDECODE: null, CLAUDE_CODE_ENTRYPOINT: null,
				...(chat.agent === 'gemini' && this._untrusted(cwd) ? { GEMINI_CLI_TRUST_WORKSPACE: 'false' } : {}),
				...(chat.agent === 'opencode' && this._untrusted(cwd) ? { OPENCODE_DISABLE_PROJECT_CONFIG: 'true' } : {}) },
			location: vscode.TerminalLocation.Editor,
			iconPath: new vscode.ThemeIcon('terminal'),
		});
		ChatViewProvider._terminalSessions.set(id, terminal);
		const closed = vscode.window.onDidCloseTerminal(t => {
			if (t !== terminal) { return; }
			ChatViewProvider._terminalSessions.delete(id);
			closed.dispose();
			if (config) { fs.rm(config, { force: true }, () => undefined); }
		});
		terminal.show();
	}

	/**
	 * What an agent's CLI is given to reach this window's browser server when it
	 * runs outside the chat's own processes — in an editor terminal or in a
	 * terminal tab. Claude Code reads a `0600` `--mcp-config` file (the token is
	 * never in argv, where every local user could read it); Codex takes the
	 * server through `-c` overrides and the token from the environment.
	 * `config`, when there is one, is the file to remove when the CLI is done.
	 * Gemini reads servers from settings files only and is not covered; OpenCode and Pi are started plainly.
	 */
	private async _browserCliLaunch(agent: AgentId, chatId: string | undefined): Promise<{ args: string[]; env: Record<string, string>; config?: string }> {
		const args: string[] = [];
		const env: Record<string, string> = {};
		const server = this._browserServer?.();
		const tabId = chatId ? this._browser?.tabIdForChat?.(chatId) : undefined;
		let config: string | undefined;
		if (server && agent === 'claude') {
			config = await writeTerminalBrowserConfig(server, tabId);
			if (config) { args.push('--mcp-config', config); }
		} else if (server && agent === 'codex') {
			args.push('-c', `mcp_servers.ai-browser.url=${JSON.stringify(server.url)}`,
				'-c', 'mcp_servers.ai-browser.http_headers={}',
				'-c', `mcp_servers.ai-browser.env_http_headers={Authorization="${terminalAuthEnv}"${tabId ? `, "X-AI-Browser-Tab"="${terminalTabEnv}"` : ''}}`);
			env[terminalAuthEnv] = `Bearer ${server.token}`;
			if (tabId) { env[terminalTabEnv] = tabId; }
		}
		return { args, env, ...(config ? { config } : {}) };
	}

	/* ------------------------------------------------------------ terminal tabs */

	/**
	 * A conversation takes the front back from a terminal (a state post will say so). Returns whether a terminal was in front.
	 * Until that state has been posted the view still shows the terminal, so a `focusInput` sent now would focus the xterm that
	 * is about to be hidden and leave the focus on the page's body: `_focusInput` waits for the state instead.
	 */
	private _leaveTerminal(): boolean {
		const changed = this._terminals.clearFront();
		if (changed) { this._terminalLeftPending = true; }
		return changed;
	}

	/** Asks the view to focus its message box (or the terminal in front) — after the state, when a terminal was just left. */
	private _focusInput(): void {
		if (this._terminalLeftPending) { this._focusAfterState = true; return; }
		this._postMessage({ type: 'focusInput' });
	}

	private _terminalHost(): TerminalHost {
		return this._terminalHostInstance ??= new TerminalHost();
	}

	/**
	 * Direct to the view, never through `_postMessage`: that queues everything
	 * until the view is ready (a hidden view would pile output up, #488) and
	 * diverts messages while a remote command runs. Nothing is kept for a view
	 * that is not there — the session's tail is what a view is given when its
	 * xterm says `terminalAttach`.
	 */
	private _postTerminal(message: HostToView): void {
		if (this._view && this._viewReady) { void this._view.webview.postMessage(message); }
	}

	/**
	 * The agents whose own CLI can start in a terminal tab: every agent the registry found with a binary, so a new
	 * agent is offered with no change here. Claude Code and Codex get the browser server injected as in "Continue in
	 * VS Code terminal"; Gemini reads servers from its settings files only (Connect Gemini CLI).
	 */
	private _terminalAgents(): AgentId[] {
		return this._registry.agents.filter(a => a.available && !!a.binary).map(a => a.id);
	}

	/** Whether a terminal can start here, and why not. */
	private _terminalSupport(): TerminalSupport {
		const blocked = this._blocked();
		if (blocked) { return { available: false, reason: blocked }; }
		const availability = terminalAvailability();
		if (!availability.ok) { return { available: false, reason: availability.reason ?? vscode.l10n.t("The terminal is not available.") }; }
		const website = remoteTerminalSetting() ? { allowed: true as const }
			: { allowed: false as const, reason: vscode.l10n.t("Turn on the setting AI Browser › Chat: Remote Terminal first.") };
		return { available: true, limit: terminalLimit(), agents: this._terminalAgents(), website };
	}

	private _postTerminalSettings(): void {
		const config = vscode.workspace.getConfiguration();
		this._postTerminal({ type: 'terminalSettings', settings: readTerminalSettings(key => config.get<unknown>(key)) });
	}

	private _shellProfileSettings(): ShellProfileSettings {
		// The user's settings and the defaults only: a workspace's `.vscode/settings.json` must not choose the program a
		// terminal runs (`userScopedSetting`).
		const config = vscode.workspace.getConfiguration('terminal.integrated');
		const platform = profilePlatform(process.platform);
		const defaultProfile = userScopedSetting(config.inspect<unknown>(`defaultProfile.${platform}`));
		const profiles = userScopedSetting(config.inspect<unknown>(`profiles.${platform}`));
		return {
			...(typeof defaultProfile === 'string' && defaultProfile ? { defaultProfile } : {}),
			...(profiles && typeof profiles === 'object' && !Array.isArray(profiles) ? { profiles: profiles as ShellProfileSettings['profiles'] } : {}),
		};
	}

	private get _terminalsStorageKey(): string { return `${this._tabsStorageKey}.terminals`; }
	private _terminalsSaved: string | undefined;
	private _terminalSaveTimer: ReturnType<typeof setTimeout> | undefined;
	private _terminalsRestored = false;

	/** Terminals survive a restart of the editor: their folder, name and screen are kept, the shell starts again there. */
	private _saveTerminals(): void {
		clearTimeout(this._terminalSaveTimer);
		this._terminalSaveTimer = undefined;
		if (this._terminalsRestoring || (!this._terminalsRestored && !this._terminals.size)) { return; }
		const items = this._terminals.tabs.map(t => {
			let screen = t.screenSnapshot();
			if (screen.length > terminalHistoryUnits) { screen = screen.slice(safeTailStart(screen, screen.length - terminalHistoryUnits)); }
			return { id: t.id, name: t.name, cwd: t.cwd, ...(t.agent ? { agent: t.agent } : {}), ...(t.remote ? { remote: true } : {}), screen };
		});
		const value = { items, front: this._terminals.front };
		const json = JSON.stringify(value);
		// While terminals live their screens keep changing: look again in a while.
		if (items.length && !this._disposed) { this._scheduleTerminalSave(15_000); }
		if (json === this._terminalsSaved) { return; }
		this._terminalsSaved = json;
		this._context.workspaceState.update(this._terminalsStorageKey, value).then(undefined, () => { /* a convenience */ });
	}

	private _scheduleTerminalSave(delay = 4000): void {
		if (this._terminalSaveTimer || this._disposed) { return; }
		this._terminalSaveTimer = setTimeout(() => { this._terminalSaveTimer = undefined; this._saveTerminals(); }, delay);
		this._terminalSaveTimer.unref?.();
	}
	private _terminalsRestoring = false;

	private async _restoreTerminals(): Promise<void> {
		if (this._terminalsRestored || this._disposed) { return; }
		const saved = this._context.workspaceState.get<{ items?: unknown; front?: unknown }>(this._terminalsStorageKey);
		const items = Array.isArray(saved?.items) ? saved.items as Array<Record<string, unknown>> : [];
		if (!items.length || this._terminals.size) { this._terminalsRestored = true; return; }
		const support = this._terminalSupport();
		if (!support.available) { return; }
		this._terminalsRestored = true;
		this._terminalsRestoring = true;
		try {
			for (const item of items.slice(0, support.limit)) {
				if (this._disposed) { return; }
				const id = typeof item.id === 'string' && item.id ? item.id : generateUuid();
				const agent = typeof item.agent === 'string' && support.agents.includes(item.agent as AgentId) ? item.agent as AgentId : undefined;
				const cwd = chooseTerminalCwd([typeof item.cwd === 'string' ? item.cwd : undefined, this._windowCwd(), os.homedir()], isDirectory);
				if (!cwd) { continue; }
				const name = terminalName(typeof item.name === 'string' ? item.name : '') || vscode.l10n.t("Terminal");
				let history = typeof item.screen === 'string' ? item.screen : '';
				if (history) {
					// A full-screen program that was open is not: leave its screen, reset colours, then say what happened.
					history += `\x1b[?1049l\x1b[?25h\x1b[0m\r\n\x1b[2m── restored after restart · new session in ${cwd} ──\x1b[0m\r\n`;
				}
				try {
					await this._terminals.create(id, name, cwd, agent, this._terminalStarter(cwd, agent), { background: true, ...(item.remote === true && remoteTerminalSetting() ? { remote: true } : {}), ...(history ? { history } : {}) });
				} catch { /* that terminal is skipped; the others still come back */ }
			}
			if (typeof saved?.front === 'string') { this._terminals.setFront(saved.front); }
		} finally {
			this._terminalsRestoring = false;
		}
		this._post();
		this._saveTerminals();
	}

	/**
	 * How one terminal's process is started — and started again by Restart: the
	 * shell VS Code's own terminal would use, or an agent's CLI. The environment is
	 * the host's without what only the editor and the chat should hold
	 * (`scrubEnv`); the agent's gets the browser server's token on purpose.
	 */
	private _terminalStarter(cwd: string, agent: AgentId | undefined): TerminalStarter {
		return async (handlers, size) => {
			let file: string;
			let args: string[];
			let extra: Record<string, string> = {};
			let cleanup: (() => void) | undefined;
			if (agent) {
				const binary = this._registry.agents.find(a => a.id === agent)?.binary;
				if (!binary) { throw new Error(vscode.l10n.t("The agent's CLI was not found. Refresh Agents and try again.")); }
				file = binary;
				args = [];
				// Like the chat's own process in a folder fetched from GitHub: its settings are held back.
				if (agent === 'claude' && this._untrusted(cwd)) { args.push('--setting-sources=user', '--strict-mcp-config'); }
				const launch = await this._browserCliLaunch(agent, undefined);
				args.push(...launch.args);
				extra = { ...launch.env, PATH: agent === 'pi' ? piPath(binary) : geminiPath(binary) };
				// OpenCode and Pi: their own TUI, started plainly (no browser tools — not measured for a terminal).
				// A folder fetched from GitHub keeps its project configuration and trust held back.
				if (agent === 'opencode' && this._untrusted(cwd)) { extra.OPENCODE_DISABLE_PROJECT_CONFIG = 'true'; }
				if (agent === 'pi' && this._untrusted(cwd)) { args.push('--no-approve'); }
				// A folder fetched from GitHub: Gemini must not load its settings, hooks or servers.
				if (agent === 'gemini' && this._untrusted(cwd)) { extra.GEMINI_CLI_TRUST_WORKSPACE = 'false'; }
				const config = launch.config;
				if (config) { cleanup = () => fs.rm(config, { force: true }, () => undefined); }
			} else {
				({ file, args } = resolveShell(process.platform, process.env, this._shellProfileSettings()));
			}
			// `claude` refuses to start inside what it takes for another Claude Code session.
			const { CLAUDE_CODE_ENTRYPOINT: _entrypoint, ...base } = process.env;
			try {
				const session = this._terminalHost().create({
					file, args, cwd, env: scrubEnv(base, extra), cols: size.cols, rows: size.rows,
					onData: handlers.onData, onExit: handlers.onExit,
				});
				return { session, cleanup };
			} catch (error) {
				cleanup?.();
				throw error;
			}
		};
	}

	/**
	 * A new terminal tab in the folder of the conversation in front, in front itself; `agent` starts that agent's own CLI.
	 * `pinTo` (a conversation tab id): made for that conversation's agent — in its folder, in the background (the view
	 * stays where it is) and pinned to it.
	 */
	public async newTerminal(agent?: AgentId, pinTo?: string): Promise<void> {
		const support = this._terminalSupport();
		if (!support.available) { refuse(support.reason); return; }
		let owner: ChatTab | undefined;
		if (pinTo !== undefined) {
			owner = typeof pinTo === 'string' ? this._tabs.find(t => t.id === pinTo) : undefined;
			if (!owner) { refuse(vscode.l10n.t("That conversation is no longer open.")); return; }
			// An agent's own CLI is a conversation of its own: nothing for another agent to drive.
			if (agent !== undefined) { refuse(vscode.l10n.t("A terminal for an agent to use is a shell; an agent's own CLI cannot be pinned.")); return; }
		}
		if (agent !== undefined && !support.agents.includes(agent)) {
			refuse(vscode.l10n.t("{0} is not available as a terminal. Refresh Agents and try again.", agent in agentNames ? agentNames[agent] : String(agent)));
			return;
		}
		if (this._terminals.size + this._terminalsStarting >= support.limit) {
			refuse(vscode.l10n.t("{0} terminals are open — close one to open another.", this._terminals.size));
			return;
		}
		// The folder of the conversation in front (a terminal showing does not change which); the window's, then home, if that is gone.
		const cwd = chooseTerminalCwd([(owner ?? this._active).cwd, this._windowCwd(), os.homedir()], isDirectory);
		if (!cwd) { refuse(vscode.l10n.t("The terminal's folder no longer exists.")); return; }
		const name = agent ? nextTerminalName(this._terminals.names(), agentNames[agent], true) : nextTerminalName(this._terminals.names(), vscode.l10n.t("Terminal"));
		this._terminalsStarting++;
		try {
			const terminal = await this._terminals.create(generateUuid(), name, cwd, agent, this._terminalStarter(cwd, agent), { background: !!owner });
			if (owner) {
				if (this._tabs.includes(owner)) { this._pinTerminalTo(terminal.id, owner); }
				// The conversation was closed while the shell started: nobody asked for it any more.
				else { this._closeTerminal(terminal.id); }
			}
		} catch (error) {
			if (!this._disposed) { void vscode.window.showWarningMessage(vscode.l10n.t("Could not start the terminal: {0}", plainInNotification(error instanceof Error ? error.message : String(error), 300))); }
		} finally {
			this._terminalsStarting--;
		}
	}

	/**
	 * Terminal lifecycle from the Exchange website (the surface has already checked encryption and
	 * consent): the setting and the window are checked again here, a new terminal is made shared, in
	 * the background and in the folder of the shared conversation, and only shared terminals may be
	 * closed, renamed or restarted. Failures are thrown, so the website's command result says why.
	 */
	private async _remoteTerminalCommand(tab: ChatTab, message: Extract<ViewToHost, { type: 'newTerminal' | 'closeTerminal' | 'renameTerminal' | 'restartTerminal' }>): Promise<void> {
		if (!remoteTerminalSetting()) { throw new Error('Terminals are off for Chrome and the website: in VS Code, turn on the setting “AI Browser › Chat: Remote Terminal” (aiBrowser.chat.remoteTerminal).'); }
		if (this._blocked()) { throw new Error(this._blocked()!); }
		if (message.type !== 'newTerminal') {
			const terminal = this._terminals.find(message.id);
			if (!terminal?.remote) { throw new Error('This terminal is not shared for remote access.'); }
			if (message.type === 'closeTerminal') { this._closeTerminal(message.id); }
			else if (message.type === 'restartTerminal') { await this._restartTerminal(message.id); }
			else if (terminal.rename(terminalName(message.name))) { this._post(); }
			return;
		}
		const support = this._terminalSupport();
		if (!support.available) { throw new Error(support.reason); }
		const agent = message.agent;
		if (agent === undefined && !remoteTerminalOpenSetting('shell')) { throw new Error(remoteOpenHint('shell')); }
		if (agent !== undefined && !remoteTerminalOpenSetting('agent')) { throw new Error(remoteOpenHint('agent')); }
		if (agent !== undefined && !support.agents.includes(agent)) { throw new Error('That agent is not available as a terminal.'); }
		if (this._terminals.size + this._terminalsStarting >= support.limit) { throw new Error(`${this._terminals.size} terminals are open — close one to open another.`); }
		const cwd = chooseTerminalCwd([tab.cwd, this._windowCwd(), os.homedir()], isDirectory);
		if (!cwd) { throw new Error("The terminal's folder no longer exists."); }
		const name = agent ? nextTerminalName(this._terminals.names(), agentNames[agent], true) : nextTerminalName(this._terminals.names(), vscode.l10n.t("Terminal"));
		this._terminalsStarting++;
		try {
			await this._terminals.create(generateUuid(), name, cwd, agent, this._terminalStarter(cwd, agent), { background: true, remote: true });
		} finally {
			this._terminalsStarting--;
		}
	}

	/* ------------------------------------------------------------ pinned terminals */

	/** Every provider that is alive: a terminal belongs to one, a conversation tab can be on any. */
	private static _liveSurfaces(): ChatViewProvider[] {
		return [...ChatViewProvider._surfaces.values()].filter(s => !s._disposed);
	}

	/** The surfaces redraw: a pin changed what a terminal's strip and a conversation's chips show, possibly on two of them. */
	private static _postAll(): void {
		for (const surface of ChatViewProvider._liveSurfaces()) { surface._post(); }
	}

	/** A terminal by id, wherever it lives. */
	private static _terminalAcross(id: string): { surface: ChatViewProvider; terminal: TerminalTab } | undefined {
		for (const surface of ChatViewProvider._liveSurfaces()) {
			const terminal = surface._terminals.find(id);
			if (terminal) { return { surface, terminal }; }
		}
		return undefined;
	}

	/** A conversation tab by its id, wherever it is open. */
	private static _tabAcross(tabId: string): { surface: ChatViewProvider; tab: ChatTab } | undefined {
		for (const surface of ChatViewProvider._liveSurfaces()) {
			const tab = surface._tabs.find(t => t.id === tabId);
			if (tab) { return { surface, tab }; }
		}
		return undefined;
	}

	/** The conversation tab that holds the chat `chatId` — what an agent's capability header names. */
	private static _tabOfChat(chatId: string): { surface: ChatViewProvider; tab: ChatTab } | undefined {
		for (const surface of ChatViewProvider._liveSurfaces()) {
			const tab = surface._tabs.find(t => t.chat.id === chatId);
			if (tab) { return { surface, tab }; }
		}
		return undefined;
	}

	private static _pinInfo(terminal: TerminalTab): PinInfo {
		const size = terminal.size;
		return {
			id: terminal.id, name: terminal.name, status: terminal.status, ...(terminal.exitCode !== undefined ? { exitCode: terminal.exitCode } : {}),
			cwd: terminal.cwd, cols: size.cols, rows: size.rows, agentControl: terminal.agentControlAllowed ? 'allowed' : 'paused',
			...(ChatViewProvider._pins.mode(terminal.id) === 'watch' ? { mode: 'watch' as const } : {}),
		};
	}

	/** The Access tab of the conversation in front. */
	private _access(): ChatAccess {
		const chatId = this._active.chat.id;
		const names = new Map<string, string>();
		for (const surface of ChatViewProvider._surfaces.values()) { for (const t of surface._tabs) { names.set(t.chat.id, t.chat.title); } }
		const watchers = this._stateSurfaces.watchers(chatId, chatId);
		return {
			tabs: this._browser.accessTabs(chatId).map(t => ({ ...t, ...(t.ownerChat ? { ownerName: names.get(t.ownerChat) ?? 'a closed chat' } : {}), ownerChat: undefined })),
			chrome: watchers.chrome,
			...(watchers.website !== undefined ? { website: watchers.website } : {}),
			terminals: ChatViewProvider._pinnedInfos(this._active).map(p => ({ id: p.id, name: p.name, watch: p.mode === 'watch' })),
		};
	}

	/** The live terminals pinned to a conversation tab, in pin order. */
	private static _pinnedInfos(tab: ChatTab): PinInfo[] {
		return ChatViewProvider._pins.pinsOf(tab.id)
			.map(id => ChatViewProvider._terminalAcross(id)?.terminal)
			.filter((t): t is TerminalTab => !!t)
			.map(t => ChatViewProvider._pinInfo(t));
	}

	/** The composer's chips for the terminals pinned to `tab`: derived each time, never stored, no `@N`. */
	private _pinChips(tab: ChatTab): AttachmentChip[] {
		return ChatViewProvider._pinnedInfos(tab).map(pin => ({
			id: pinChipId(pin.id), kind: 'terminal' as const, pinned: true as const, terminalId: pin.id,
			label: pin.status === 'exited' ? vscode.l10n.t("{0} (exited)", pin.name) : pin.mode === 'watch' ? vscode.l10n.t("{0} (watch only)", pin.name) : pin.name,
			terminalStatus: pin.status,
			...(pin.mode === 'watch' ? { terminalWatch: true as const } : {}),
		}));
	}

	/** What a conversation's tab says of its pins (`ChatTabSummary.terminals`). */
	private _pinnedSummary(tab: ChatTab): { terminals?: { id: string; name: string; status: 'running' | 'exited' }[] } {
		const pins = ChatViewProvider._pinnedInfos(tab);
		return pins.length ? { terminals: pins.map(p => ({ id: p.id, name: p.name, status: p.status })) } : {};
	}

	/** A terminal's strip entry with its owner: who may drive it, and whether the user stopped that. */
	private _terminalSummary(terminal: TerminalTab): TerminalTabSummary {
		const summary = terminal.summary();
		const owner = ChatViewProvider._pins.owner(terminal.id);
		const held = owner !== undefined ? ChatViewProvider._tabAcross(owner)?.tab : undefined;
		if (!held) { return summary; }
		return {
			...summary,
			pinnedBy: { tabId: held.id, title: held.title ?? vscode.l10n.t("New chat"), ...(held.started ? { agent: held.chat.agent } : {}) },
			agentControl: terminal.agentControlAllowed ? 'allowed' : 'paused',
			pinMode: ChatViewProvider._pins.mode(terminal.id) ?? 'control',
		};
	}

	/** A line in a conversation, where it has begun: a fresh tab shows its welcome and gets no notice. */
	private static _noticeIn(tab: ChatTab, text: string): void {
		if (tab.started) { tab.push({ kind: 'notice', text }); }
	}

	/**
	 * Pins `terminalId` (one of this surface's terminals) to a conversation tab. The agent of that conversation may then read
	 * it and, with the user's approval of each input, type into it. One owner at a time: another conversation's pin moves,
	 * and both conversations say so. Refused in the status bar for an agent's own CLI (self-control makes no sense).
	 */
	private _pinTerminalTo(terminalId: string, tab: ChatTab, mode: PinMode = 'control'): boolean {
		const terminal = this._terminals.find(terminalId);
		if (!terminal) { return false; }
		const support = this._terminalSupport();
		if (!support.available) { refuse(support.reason); return false; }
		if (terminal.agent) {
			refuse(vscode.l10n.t("{0} is an agent's own CLI: it cannot be given to a conversation to drive.", terminal.name));
			return false;
		}
		const result = ChatViewProvider._pins.pin(tab.id, terminal.id, mode);
		if (result.already) { return true; }
		if (result.movedFrom !== undefined) {
			const previous = ChatViewProvider._tabAcross(result.movedFrom)?.tab;
			if (previous) { ChatViewProvider._noticeIn(previous, vscode.l10n.t("Terminal \"{0}\" was moved to another conversation.", plainInPrompt(terminal.name, 80))); }
			ChatViewProvider._noticeIn(tab, vscode.l10n.t("Terminal \"{0}\" was moved here from another conversation.", plainInPrompt(terminal.name, 80)));
		}
		ChatViewProvider._postAll();
		return true;
	}

	/** `pinTerminal`: from the composer's chip menu, the "+" menu and the terminal's own menu. */
	private _pinTerminalMessage(id: unknown, tabId: unknown, pinned: unknown, mode?: unknown): void {
		if (typeof id !== 'string' || typeof tabId !== 'string') { return; }
		const tab = this._tabs.find(t => t.id === tabId);
		if (!tab) { return; }
		if (pinned === true) {
			this._pinTerminalTo(id, tab, isPinMode(mode) ? mode : 'control');
		} else if (ChatViewProvider._pins.unpin(tab.id, id)) {
			ChatViewProvider._postAll();
		}
	}

	/** A terminal was closed (or its surface is going): its pin is dropped and the conversation told. `quiet`: this surface's own tabs are going too. */
	private _terminalGone(id: string, name: string, quiet = false): void {
		const owner = ChatViewProvider._pins.dropTerminal(id);
		if (owner === undefined) { return; }
		const held = ChatViewProvider._tabAcross(owner);
		if (held && !(quiet && held.surface === this)) {
			ChatViewProvider._noticeIn(held.tab, vscode.l10n.t("Terminal \"{0}\" was closed; its pin was removed.", plainInPrompt(name, 80)));
		}
	}

	private _closeTerminal(id: unknown): void {
		const terminal = this._terminals.find(id);
		if (!terminal) { return; }
		const name = terminal.name;
		this._terminals.close(id);
		this._terminalGone(terminal.id, name);
		ChatViewProvider._postAll();
	}

	/**
	 * "Ask agent" from a terminal: a new conversation (in the terminal's folder) or an open one gets the terminal pinned,
	 * the terminal's selected text as context, and comes to the front with the composer focused. Nothing is prefilled and
	 * nothing is sent: the user asks. The tab limit is checked before anything changes, so a refusal leaves the terminal in front.
	 */
	private async _terminalAskAgent(id: string, target: { kind: 'new'; agent?: AgentId } | { kind: 'tab'; tabId: string }, selection: unknown, mode?: unknown): Promise<void> {
		const terminal = this._terminals.find(id);
		if (!terminal || !target || typeof target !== 'object') { return; }
		const support = this._terminalSupport();
		if (!support.available) { refuse(support.reason); return; }
		if (terminal.agent) {
			refuse(vscode.l10n.t("{0} is an agent's own CLI: ask in that CLI, or in a shell terminal.", terminal.name));
			return;
		}
		let tab: ChatTab | undefined;
		if (target.kind === 'new') {
			const agent = target.agent !== undefined ? target.agent : this._remembered.agent ?? this._registry.agents.find(a => a.available)?.id;
			if (agent === undefined || !isAgentId(agent) || !this._registry.agents.some(a => a.id === agent && a.available)) {
				refuse(vscode.l10n.t("No agent is available. Refresh Agents and try again."));
				return;
			}
			if (this._tabs.length >= tabLimit()) {
				refuse(vscode.l10n.t("{0} chats are open — close one to open another.", this._tabs.length));
				return;
			}
			tab = this._addTab(agent);
			if (!tab) { return; }
			// A fresh tab sends with the remembered agent.
			this._select({ agent });
			// The conversation works where the terminal is; with the window's own folder it simply follows the window.
			tab.setFolder(terminal.cwd === this._windowCwd() ? undefined : terminal.cwd);
			tab.chat.references = undefined;
		} else if (target.kind === 'tab' && typeof target.tabId === 'string') {
			tab = this._tabs.find(t => t.id === target.tabId);
			if (!tab) { refuse(vscode.l10n.t("That conversation is no longer open.")); return; }
		} else { return; }
		if (!this._pinTerminalTo(id, tab, isPinMode(mode) ? mode : 'control')) { return; }
		if (typeof selection === 'string' && selection.trim()) {
			const shaped = terminalChatText(plainText(selection.length > terminalSelectionLimit ? selection.slice(-terminalSelectionLimit) : selection), terminal.name, terminal.cwd);
			if (shaped) { tab.attachments.push({ chip: { id: generateUuid(), kind: 'selection', label: shaped.label }, text: shaped.text }); }
		}
		if (target.kind === 'tab') {
			// `_addTab` has done this for a new one.
			this._selectTab(tab.id);
		}
		this._leaveTerminal();
		this._post();
		this._focusInput();
	}

	private async _restartTerminal(id: string): Promise<void> {
		const tab = this._terminals.find(id);
		if (!tab || tab.status !== 'exited' || this._blocked()) { return; }
		try {
			await tab.restart();
		} catch (error) {
			if (!this._disposed) { void vscode.window.showWarningMessage(vscode.l10n.t("Could not start the terminal: {0}", plainInNotification(error instanceof Error ? error.message : String(error), 300))); }
			this._post();
		}
	}

	/** Paste goes through the host: `navigator.clipboard` in a webview depends on the host granting it. */
	private async _pasteIntoTerminal(id: string): Promise<void> {
		const tab = this._terminals.find(id);
		if (!tab?.running) { return; }
		const raw = await vscode.env.clipboard.readText();
		if (!raw) { return; }
		// Refused loudly, never accepted and then dropped on the way to the shell: anything under the limit is fully writable.
		if (raw.length > terminalPasteLimit) {
			refuse(vscode.l10n.t("The clipboard is too large to paste into a terminal."));
			return;
		}
		// No escape sequence may travel with a paste: one that ends the shell's bracketed paste early runs the rest as typed input.
		const text = sanitizePaste(raw);
		if (!text) { return; }
		this._postTerminal({ type: 'terminalPaste', id, text });
	}

	/**
	 * "Insert into terminal" (`terminalInsert.ts`): the user — never an agent, so no approval card — puts a page address,
	 * an element, a screenshot, a file, a selection, a video or the page's annotations into a terminal's input, mostly for a
	 * terminal agent (Claude Code, Codex CLI) running there. Text goes in as text; a binary item is written to the private
	 * temp directory (0600) and its path goes in. Bracketed when the program asked for it (DECSET 2004), sanitised, and
	 * never followed by Enter: the user sends it.
	 */
	private async _insertIntoTerminal(id: unknown, kind: unknown, file: unknown): Promise<void> {
		const terminal = this._terminals.find(id);
		if (!terminal?.running || !isTerminalInsertKind(kind) || this._blocked()) { return; }
		let item: TerminalInsertItem | undefined;
		try {
			item = await this._terminalInsertItem(terminal, kind, file);
		} catch (error) {
			refuse(vscode.l10n.t("Could not insert into the terminal: {0}", plainInLabel(error instanceof Error ? error.message : String(error), 200)));
			return;
		}
		// A pick or a dialog can take a while: the terminal may be gone by then.
		if (!item || this._disposed || this._terminals.find(terminal.id) !== terminal || !terminal.running) { return; }
		let bracketed = false;
		try { bracketed = (await terminal.readScreen({ maxChars: 1 })).state.bracketedPaste === true; } catch { /* no model: plain */ }
		const bytes = terminalInsertPayload(item, bracketed, sanitizePaste);
		if (!bytes) { refuse(vscode.l10n.t("Nothing to insert, or it is too long for a terminal.")); return; }
		terminal.input(bytes);
		this._terminals.select(terminal.id);
		this._post();
		this._postTerminal({ type: 'terminalFocus', id: terminal.id });
	}

	/** What `_insertIntoTerminal` writes, materialised; `undefined` when the user cancelled or nothing was there. */
	private async _terminalInsertItem(terminal: TerminalTab, kind: TerminalInsertKind, file: unknown): Promise<TerminalInsertItem | undefined> {
		const saveBinary = async (folder: 'captures' | 'files', name: string, data: Uint8Array): Promise<string> => {
			const saved = await writeExclusive(await projectTempDirectory(terminal.cwd, folder), name, data);
			await trackTemporaryFile(saved, terminal.cwd);
			return saved;
		};
		switch (kind) {
			case 'file': {
				if (file !== undefined) {
					// Dropped on, or pasted into, the terminal: checked like the composer's pasted files.
					const f = file as { name?: unknown; data?: unknown };
					if (typeof f.name !== 'string' || typeof f.data !== 'string' || f.data.length > Math.ceil(pastedFileLimit / 3) * 4
						|| f.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(f.data)) {
						throw new Error('Invalid file, or it is over 64 MB.');
					}
					const data = Buffer.from(f.data, 'base64');
					if (data.toString('base64') !== f.data || data.length > pastedFileLimit) { throw new Error('Invalid file, or it is over 64 MB.'); }
					return { paths: [await saveBinary('files', `${generateUuid()}-${pastedFileName(f.name)}`, data)] };
				}
				const picked = await vscode.window.showOpenDialog({ canSelectMany: true, defaultUri: vscode.Uri.file(terminal.cwd), openLabel: vscode.l10n.t("Insert") });
				return picked?.length ? { paths: picked.filter(u => u.scheme === 'file').map(u => u.fsPath) } : undefined;
			}
			case 'video': {
				// The recordings this project made, or any video: their path, as the CLIs read files themselves.
				const picked = await vscode.window.showOpenDialog({
					canSelectMany: false, defaultUri: vscode.Uri.file(await projectTempDirectory(terminal.cwd, 'captures')),
					filters: { [vscode.l10n.t("Videos")]: ['mp4', 'webm', 'mov', 'm4v'] }, openLabel: vscode.l10n.t("Insert"),
				});
				return picked?.[0]?.scheme === 'file' ? { paths: [picked[0].fsPath] } : undefined;
			}
			case 'selection': {
				const editor = vscode.window.activeTextEditor ?? this._lastTextEditorForInsert();
				const text = editor ? editor.selections.filter(sel => !sel.isEmpty).map(sel => editor.document.getText(sel)).join('\n') : '';
				if (!text) { refuse(vscode.l10n.t("Select some text in an editor first.")); return undefined; }
				return { text };
			}
			default:
				break;
		}
		if (!tabSource.available()) { refuse(vscode.l10n.t("Open Google Chrome or enable native browser tabs to insert a page.")); return undefined; }
		const tab = this._browser.userTab;
		if (!tab) {
			refuse(this._browser.hasOpenTabs
				? vscode.l10n.t("Several browser tabs are open — click into the one to insert from, then try again.")
				: vscode.l10n.t("No browser tab is open to insert from."));
			return undefined;
		}
		switch (kind) {
			case 'page': {
				const title = plainInPrompt(pageTitle(tab.title, tab.url), 200);
				return { text: title ? `${tab.url} (${title})` : tab.url };
			}
			case 'element':
				return { text: (await this._fromBrowser('element', tab))?.text ?? '' };
			case 'screenshot': {
				if (!this._browser.onScreen(tab)) {
					refuse(vscode.l10n.t("\"{0}\" is not on screen — bring its tab to the front, then insert.", plainInLabel(pageTitle(tab.title, tab.url), 60)));
					return undefined;
				}
				const shot = await this._browser.capture(false, tab);
				return { paths: [await saveBinary('captures', `screenshot-${generateUuid()}.png`, shot.png)] };
			}
			case 'annotation': {
				const notes = this._browser.annotationsOf(tab);
				const records = notes?.records.filter(r => !notes.agentMade.has(r.id)) ?? [];
				if (!notes || !records.length) { refuse(vscode.l10n.t("This page has no annotations — add one with Add Annotation Marker.")); return undefined; }
				return { text: records.map(r => annotationClipboardText(r, notes.url)).join('\n\n') };
			}
		}
	}

	/** The last text editor that is visible, for a selection while focus is in the chat view. */
	private _lastTextEditorForInsert(): vscode.TextEditor | undefined {
		return vscode.window.visibleTextEditors.find(e => e.selections.some(sel => !sel.isEmpty));
	}

	/**
	 * Selected text, or the last lines of a screen, as context for the conversation
	 * in front: a chip like an editor selection's, and that conversation shown.
	 * The text is a shell's output — data, as every attachment is.
	 */
	/** A shell code block from a reply, typed where the user picked and sent with Enter. The click is the consent. */
	private async _runInTerminal(text: unknown, target: unknown, id: unknown): Promise<void> {
		if (typeof text !== 'string' || !text.trim() || text.length > 990_000) { return; }
		const blocked = this._blocked();
		if (blocked) { refuse(blocked); return; }
		// A reply's text: what the code block cannot show (ESC, C1, a lone CR) is not typed into a shell.
		const command = sanitizePaste(text.replace(/\r\n/g, '\n').replace(/\r/g, ' ')).replace(/\r/g, '').replace(/\n+$/, '');
		if (!command.trim()) { return; }
		if (target === 'vscode') {
			const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal({ name: 'AI Browser', cwd: this._active.cwd });
			terminal.show(false);
			terminal.sendText(command, true);
			return;
		}
		let tab = target === 'tab' && typeof id === 'string' ? this._terminals.find(id) : undefined;
		if (target === 'newTab') {
			const before = new Set(this._terminals.tabs.map(t => t.id));
			await this.newTerminal(undefined, undefined);
			tab = this._terminals.tabs.find(t => !before.has(t.id));
			if (!tab) { return; } // newTerminal already said why (the limit, no terminal support).
		}
		if (!tab) { refuse(vscode.l10n.t("That terminal tab is gone.")); return; }
		this._terminals.select(tab.id);
		this._post();
		// Each line as typed, then Enter; a just-started shell gets a moment to print its prompt.
		setTimeout(() => tab!.input(command.replace(/\n/g, '\r') + '\r'), target === 'newTab' ? 400 : 0);
	}

	private async _terminalToChat(id: string, text: unknown): Promise<void> {
		const tab = this._terminals.find(id);
		if (!tab || typeof text !== 'string' || this._blocked()) { return; }
		const shaped = terminalChatText(plainText(text.length > terminalSelectionLimit ? text.slice(-terminalSelectionLimit) : text), tab.name, tab.cwd);
		if (!shaped) {
			refuse(vscode.l10n.t("There is no text in the terminal to attach."));
			return;
		}
		this._active.attachments.push({ chip: { id: generateUuid(), kind: 'selection', label: shaped.label }, text: shaped.text });
		this._leaveTerminal();
		this._post();
		this._focusInput();
	}

	/**
	 * What the OpenRouter agent reads from the editor: the key from SecretStorage
	 * (per request, never cached), the models and the endpoint, and the saved
	 * entries of a conversation to rebuild it from — an open tab's first, since
	 * it may not have been saved yet.
	 */
	private _openrouterConfig(): OpenRouterConfig {
		return {
			apiKey: async () => { const key = (await this._context.secrets.get(openrouterKeySecret))?.trim(); return key || undefined; },
			models: () => this._context.globalState.get<unknown>(openrouterModelsKey),
			endpoint: () => vscode.workspace.getConfiguration('aiBrowser.chat').inspect<string>('openrouterEndpoint')?.globalValue,
			entries: ref => {
				for (const surface of ChatViewProvider._surfaces.values()) {
					const tab = surface._disposed ? undefined : surface._tabs.find(t => t.chat.ref === ref);
					if (tab) { return tab.chat.entries; }
				}
				return this._history().find(c => c.ref === ref)?.entries;
			},
		};
	}

	/** OpenRouter's catalogue, kept for ten minutes and shared by every chat surface; one request at a time. */
	private static readonly _openrouterCatalogs = new Map<string, { at: number; entries: OpenRouterCatalogEntry[] }>();
	private static readonly _openrouterCatalogRequests = new Map<string, Promise<OpenRouterCatalogEntry[]>>();

	/** The Sound section of Chat Settings: `aiBrowser.chat.sound.*`, written for the user. */
	private async _soundSettings(message: Extract<ViewToHost, { type: 'soundSettings' }>): Promise<void> {
		if (message.action === 'set') {
			const config = vscode.workspace.getConfiguration('aiBrowser.chat.sound');
			try {
				if (typeof message.enabled === 'boolean') { await config.update('enabled', message.enabled, vscode.ConfigurationTarget.Global); }
				if (typeof message.activeChat === 'boolean') { await config.update('activeChat', message.activeChat, vscode.ConfigurationTarget.Global); }
				if (typeof message.sound === 'string' && (chatSounds as readonly string[]).includes(message.sound)) { await config.update('name', message.sound, vscode.ConfigurationTarget.Global); }
				const notify = vscode.workspace.getConfiguration('aiBrowser.chat.notifications');
				if (typeof message.notify === 'boolean') { await notify.update('enabled', message.notify, vscode.ConfigurationTarget.Global); }
				if (typeof message.notifyAway === 'boolean') { await notify.update('onlyWhenAway', message.notifyAway, vscode.ConfigurationTarget.Global); }
				if (typeof message.repeat === 'number' && Number.isFinite(message.repeat)) { await config.update('repeat', Math.round(Math.min(5, Math.max(1, message.repeat))), vscode.ConfigurationTarget.Global); }
				if (typeof message.volume === 'number' && Number.isFinite(message.volume)) { await config.update('volume', Math.round(Math.min(200, Math.max(0, message.volume))), vscode.ConfigurationTarget.Global); }
			} catch (error) {
				void vscode.window.showErrorMessage(vscode.l10n.t('The setting was not changed: {0}', error instanceof Error ? error.message : String(error)));
			}
		}
		this._post();
	}

	/** The Remote terminals section of Chat Settings: reads and writes the three user settings. */
	private async _remoteTerminalSettings(message: Extract<ViewToHost, { type: 'remoteTerminalSettings' }>): Promise<void> {
		const read = (error?: string): void => {
			this._postMessage({ type: 'remoteTerminalSettings', remoteTerminal: remoteTerminalSetting(), shell: remoteTerminalOpenSetting('shell'), agent: remoteTerminalOpenSetting('agent'), ...(error ? { error } : {}) });
		};
		if (message.action === 'set') {
			const keys = ['remoteTerminal', 'remoteTerminalShell', 'remoteTerminalAgent'];
			if (!keys.includes(message.key) || typeof message.value !== 'boolean') { read(vscode.l10n.t('Unknown setting.')); return; }
			try {
				// Global only: these are application-scoped, so a workspace value would be ignored anyway.
				await vscode.workspace.getConfiguration('aiBrowser.chat').update(message.key, message.value, vscode.ConfigurationTarget.Global);
			} catch (error) {
				read(vscode.l10n.t('The setting was not changed: {0}', error instanceof Error ? error.message : String(error)));
				return;
			}
		}
		read();
	}

	/**
	 * The OpenRouter section of Chat Settings. The key goes in through `setKey` and
	 * is never posted back: the view learns only whether one is stored. Every
	 * answer carries the canonical key state and model list, so the view shows
	 * what is saved rather than what it sent. A change re-reads the agent's models
	 * (`redetect` keeps its backend and its sessions).
	 */
	private async _openrouterAction(message: Extract<ViewToHost, { type: 'openrouter' }>): Promise<void> {
		const state = async (extra: { error?: string; notice?: string; catalog?: Extract<HostToView, { type: 'openrouter' }>['catalog'] } = {}): Promise<void> => {
			const keySet = !!(await this._context.secrets.get(openrouterKeySecret))?.trim();
			this._postMessage({ type: 'openrouter', keySet, models: readOpenRouterModels(this._context.globalState.get<unknown>(openrouterModelsKey), true), ...extra });
		};
		const changed = () => { void this._registry.redetect('openrouter').catch(() => undefined); };
		try {
			switch (message.action) {
				case 'load':
					await state();
					return;
				case 'setKey': {
					const checked = validateOpenRouterKey(message.key);
					if ('error' in checked) { await state({ error: checked.error }); return; }
					await this._context.secrets.store(openrouterKeySecret, checked.key);
					changed();
					await state({ notice: vscode.l10n.t('API key stored.') });
					return;
				}
				case 'removeKey':
					await this._context.secrets.delete(openrouterKeySecret);
					changed();
					await state({ notice: vscode.l10n.t('API key removed.') });
					return;
				case 'saveModels': {
					const checked = validateOpenRouterModels(message.models);
					if ('error' in checked) { await state({ error: checked.error }); return; }
					await this._context.globalState.update(openrouterModelsKey, checked.models);
					changed();
					await state({ notice: vscode.l10n.t('Models saved.') });
					return;
				}
				case 'catalog': {
					const query = typeof message.query === 'string' ? message.query.slice(0, 100) : '';
					// A server on this computer is asked in place of OpenRouter when the view names one; only loopback is accepted.
					const asked = message.endpoint !== undefined && message.endpoint !== '' ? localEndpoint(message.endpoint) : undefined;
					const endpoint = asked ?? openrouterEndpoint(vscode.workspace.getConfiguration('aiBrowser.chat').inspect<string>('openrouterEndpoint')?.globalValue);
					// Correlate with the typed address even when invalid; the canonical URL is only for adding a model.
					const echo = { ...(typeof message.endpoint === 'string' ? { requestedEndpoint: message.endpoint } : {}), ...(asked && 'url' in asked ? { endpoint: asked.url } : {}) };
					if ('error' in endpoint) { await state({ catalog: { query, ...echo, items: [], total: 0, error: endpoint.error } }); return; }
					try {
						const entries = await this._openrouterEntries(endpoint.url, message.refresh === true, asked !== undefined);
						const found = searchOpenRouterCatalog(entries, query);
						// A local server's list carries no capabilities; Add assumes tools, so the rows say the same.
						const items = asked !== undefined ? found.entries.map(e => ({ ...e, tools: true })) : found.entries;
						await state({ catalog: { query, ...echo, items, total: found.total } });
					} catch (error) {
						await state({ catalog: { query, ...echo, items: [], total: 0, error: error instanceof Error ? error.message : String(error) } });
					}
					return;
				}
			}
		} catch (error) {
			await state({ error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async _openrouterEntries(endpoint: string, refresh: boolean, local: boolean): Promise<OpenRouterCatalogEntry[]> {
		const cached = ChatViewProvider._openrouterCatalogs.get(endpoint);
		if (cached && !refresh && Date.now() - cached.at < openrouterCatalogTtlMs) { return cached.entries; }
		let request = ChatViewProvider._openrouterCatalogRequests.get(endpoint);
		if (!request) {
			const promise = fetchOpenRouterCatalog((url, init) => fetch(url, init), endpoint, undefined, local).then(entries => {
				ChatViewProvider._openrouterCatalogs.set(endpoint, { at: Date.now(), entries });
				return entries;
			}).finally(() => { if (ChatViewProvider._openrouterCatalogRequests.get(endpoint) === promise) { ChatViewProvider._openrouterCatalogRequests.delete(endpoint); } });
			request = promise;
			ChatViewProvider._openrouterCatalogRequests.set(endpoint, request);
		}
		return request;
	}

	private _history(): StoredChat[] {
		return this._context.workspaceState.get<StoredChat[]>(historyKey) ?? [];
	}

	private async _save(chat: StoredChat): Promise<void> {
		if (!started(chat)) {
			return;
		}
		const stored: StoredChat = { ...chat, entries: storedEntries(chat.entries) };
		const others = this._history().filter(c => c.id !== chat.id);
		const next = [stored, ...others].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, historyLimit);
		try {
			await this._context.workspaceState.update(historyKey, next);
		} catch {
			// The history is a convenience; losing one save loses nothing else.
		}
	}

	/** The title bar's gear opens settings inside the chat view. */
	public showSettings(): void {
		this._postMessage({ type: 'openSettings' });
	}

	/** The title bar's Agents: every agent and workflow of every chat open in this extension host. */
	public showAllAgents(refresh = false): void {
		const chats: AllAgentsChat[] = [];
		for (const view of ChatViewProvider._surfaces.values()) {
			if (view._disposed) { continue; }
			for (const tab of view._tabs) {
				const own = tab.chat.entries.filter((e): e is ToolEntry => e.kind === 'tool' && e.tool === 'agent');
				const agents = [...own, ...view._runs.rows(tab.chat.id)].sort((a, b) => a.startedAt - b.startedAt);
				if (agents.length) {
					chats.push({ tabId: tab.id, chatId: tab.chat.id, title: tab.title ?? vscode.l10n.t("New chat"), surface: view._surfaceLabel(), here: view === this, agents });
				}
			}
		}
		this._postMessage({ type: 'allAgents', chats, refresh });
	}

	/** The title bar's cup; the popup is the view's own, so it pauses no browser tab. */
	public showKeepAwake(): void {
		this._postMessage({ type: 'openSleep' });
	}

	/** `refresh` updates an already open history panel. */
	public showHistory(refresh = false): void {
		const chats: ChatSummary[] = this._history().map(c => ({ id: c.id, title: c.title, agent: c.agent, updatedAt: c.updatedAt, canResumeInTerminal: !!c.ref }));
		this._postMessage({ type: 'history', chats, refresh });
	}

	/**
	 * A chat from the history: brought to the front if a tab has it already,
	 * shown in the tab in front if that one is empty, and otherwise in a new tab
	 * beside it — opening one must not end a conversation that is working.
	 */
	/** A conversation has one owner across every chat surface in this extension host. */
	private _findOpenChat(id: string): { surface: ChatViewProvider; tab: ChatTab } | undefined {
		const local = this._tabs.find(tab => tab.chat.id === id);
		if (local) { return { surface: this, tab: local }; }
		for (const surface of ChatViewProvider._surfaces.values()) {
			if (surface === this || surface._disposed) { continue; }
			const tab = surface._tabs.find(candidate => candidate.chat.id === id);
			if (tab) { return { surface, tab }; }
		}
		return undefined;
	}

	private _openChat(id: string): void {
		const terminal = ChatViewProvider._terminalSessions.get(id);
		if (terminal) {
			terminal.show();
			void vscode.window.showInformationMessage(vscode.l10n.t("This conversation is open in a terminal. Close that terminal before continuing in chat."));
			return;
		}
		const open = this._findOpenChat(id);
		if (open) {
			if (open.surface !== this && !this._panelIdentity) {
				this._postMessage({ type: 'historyChatOpen', id, source: open.surface._surfaceLabel() });
				return;
			}
			open.surface._selectTab(open.tab.id);
			if (open.surface !== this) { void open.surface._focusView().catch(error => this._fail(error)); }
			return;
		}
		const stored = this._history().find(c => c.id === id);
		if (!stored) {
			return;
		}
		let tab = this._active;
		// A tab the user named is not empty, though nothing was sent from it yet:
		// opening a chat into it lost the name.
		// Nor is one running a toolbar skill in the background, which opening a
		// chat into it would stop.
		if (tab.started || tab.busy || tab.chat.named || this._runs.runningIn(tab.chat.id)) {
			const added = this._addTab(stored.agent);
			if (!added) {
				return;
			}
			tab = added;
		}
		tab.open(stored);
		this._switchTo = undefined;
		this._leaveTerminal();
		this._post();
	}

	private _readTabDraft(tab: ChatTab): Promise<string> {
		if (!this._viewReady) { return Promise.resolve(this._savedDrafts.get(tab.chat.id) ?? ''); }
		return new Promise((resolve, reject) => {
			const request = generateUuid();
			const timer = setTimeout(() => { this._draftRequests.delete(request); reject(new Error('Could not read the draft from the source chat.')); }, 10_000);
			this._draftRequests.set(request, { resolve, reject, timer, tab, chatId: tab.chat.id });
			this._postMessage({ type: 'readTabDraft', request, tabId: tab.id, chatId: tab.chat.id });
		});
	}

	private async _resolveHistoryChat(id: string, action: 'move' | 'show'): Promise<void> {
		if (action !== 'move' && action !== 'show') { return; }
		const open = this._findOpenChat(id);
		if (!open) { this._openChat(id); return; }
		if (action === 'show' || open.surface === this) {
			open.surface._selectTab(open.tab.id);
			await open.surface._focusView();
			return;
		}
		const draft = await open.surface._readTabDraft(open.tab);
		if (this._disposed) { return; }
		const current = this._findOpenChat(id);
		if (current?.surface !== open.surface || current.tab !== open.tab) { this._openChat(id); return; }
		if (open.surface._moveTabInto(open.tab, this, draft)) { await this._focusView(); }
	}

	private async _deleteChat(id: string): Promise<void> {
		try {
			await this._context.workspaceState.update(historyKey, this._history().filter(c => c.id !== id));
		} catch {
			// Best effort, as above.
		}
		const open = this._findOpenChat(id);
		if (open) {
			const { tab, surface } = open;
			// Not saved on the way out: that would write the deleted chat back.
			tab.discard();
			surface._removeTab(tab);
		}
		this.showHistory(true);
	}

	/* ------------------------------------------------------------ the working folder */

	private readonly _listings = new Map<string, { readonly at: number; readonly listing: Promise<WorkdirListing> }>();

	/** The window's own local folders, which the folder button lists first. */
	private _workspaceFolders(): WorkdirFolder[] {
		return (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => ({ path: f.uri.fsPath, name: f.name }));
	}

	private _recentFolders(): string[] {
		const stored = this._context.globalState.get<unknown>(recentFoldersKey);
		return Array.isArray(stored) ? stored.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p)).slice(0, recentFolderLimit) : [];
	}

	/** The folder the tab in front works in; undefined is the home directory, with no project. */
	private _workdir(tab = (this._chromeCommand?.getStore()?.tab ?? this._active)): string | undefined {
		const command = this._chromeCommand?.getStore();
		if (command?.tab === tab && (!this._tabs.includes(tab) || tab.chat.id !== command.chatId)) { return undefined; }
		return tab.chat.folder ?? this._workspaceFolders()[0]?.path;
	}

	private readonly _gitAccess = new GitAccess(folder => this._gitWorktreeIdentity(folder));

	private async _assertGitFolder(folder: string): Promise<void> {
		const storage = this._repoStorage();
		const real = await fs.promises.realpath(folder);
		const managed = managedCopy(storage, path.resolve(folder)) ?? managedCopy(storage, real);
		if (managed && !await isOurWorktree(storage, managed.repo, managed.folder)) {
			throw new Error('This managed repository copy is no longer its original Git worktree. Git operation cancelled.');
		}
		for (const tab of this._tabs) {
			if (tab.chat.folder !== folder || !tab.chat.copy) { continue; }
			const repo = parseRepo(tab.chat.copy.repo);
			if (!repo || !await isOurWorktree(storage, repo, folder)) {
				throw new Error('This repository copy is no longer its original Git worktree. Git operation cancelled.');
			}
		}
	}

	private async _runWorkdirGit(git: string, args: readonly string[], folder: string, timeoutMs?: number, environment?: NodeJS.ProcessEnv): Promise<string> {
		await this._assertGitFolder(folder);
		return runGit(git, args, folder, timeoutMs, environment);
	}

	private async _gitWorktreeIdentity(folder: string): Promise<string> {
		await this._assertGitFolder(folder);
		const git = await gitBinary();
		if (git) {
			const directory = await runGit(git, ['rev-parse', '--absolute-git-dir'], folder, 15_000).catch(() => undefined);
			if (directory) { return `git:${await fs.promises.realpath(directory.trim())}`; }
		}
		// Chats also work outside Git repositories; unrelated mutations must not prevent that.
		return `folder:${await fs.promises.realpath(folder)}`;
	}

	private _busyGitFolders(): string[] {
		return [...this._services.views].flatMap(view => view._tabs.filter(t => t.busy || view._repoBusy.has(t) || this._runs.runningIn(t.chat.id) > 0).map(t => t.cwd));
	}

	private async _withGitMutation<T>(folder: string, work: () => Promise<T>): Promise<T> {
		// Before the lock: taking it runs `git rev-parse` in the folder (#208).
		if (this._blocked()) { throw new Error('Git is unavailable in this window.'); }
		const release = await this._gitAccess.mutate(folder, () => this._busyGitFolders());
		try { return await work(); } finally { release(); }
	}

	/** Set when an editor event was let pass while the view was hidden or absent. */
	private _gitStale = false;
	private _gitEventTimer: ReturnType<typeof setTimeout> | undefined;
	/** The read under way for a folder, and whether another was asked for meanwhile. */
	private readonly _gitRefreshes = new Map<string, { again: boolean; fetch?: 'auto' | 'force'; done: Promise<void> }>();
	private static readonly _gitFetches = new GitFetchScheduler();

	/**
	 * An editor event that may change how the footer's files are drawn: every
	 * document opened or closed, a theme, an extension. Each used to start three
	 * `git` processes on the spot, whether or not anyone could see the footer, so
	 * opening a batch of files spawned dozens at once. Now nothing runs while the
	 * view is hidden or absent — the read is owed (`_gitStale`) and paid when it
	 * is shown — and a burst of events is one read.
	 */
	private _gitEventRefresh(): void {
		if (this._disposed) { return; }
		if ((!this._view?.visible || !this._viewReady) && !this._stateSurfaces.watching()) {
			this._gitStale = true;
			return;
		}
		clearTimeout(this._gitEventTimer);
		this._gitEventTimer = setTimeout(() => {
			this._gitEventTimer = undefined;
			void this._refreshWorkdirGit();
		}, gitEventDebounceMs);
	}

	/**
	 * Reads the working folder's Git state for the footer. At most one read per
	 * folder is under way: a call while one runs asks for a single rerun after
	 * it — which is what a caller that has just changed the index needs — and
	 * is answered when that rerun is done.
	 */
	private _refreshWorkdirGit(fetch?: 'auto' | 'force'): Promise<void> {
		// Only for a view that can show it: the answer is not queued (see
		// `_postMessage`), and `ready` asks for a fresh one.
		if (this._disposed || ((!this._view || !this._viewReady) && !this._stateSurfaces.watching())) {
			this._gitStale = true;
			return Promise.resolve();
		}
		const folder = this._workdir();
		if (!folder) { return Promise.resolve(); }
		const running = this._gitRefreshes.get(folder);
		if (running) {
			running.again = true;
			running.fetch = fetch === 'force' || running.fetch === 'force' ? 'force' : fetch ?? running.fetch;
			return running.done;
		}
		this._gitStale = false;
		const entry: { again: boolean; fetch?: 'auto' | 'force'; done: Promise<void> } = { again: false, fetch, done: Promise.resolve() };
		this._gitRefreshes.set(folder, entry);
		entry.done = (async () => {
			try {
				do {
					entry.again = false;
					const requestedFetch = entry.fetch;
					entry.fetch = undefined;
					await this._readWorkdirGit(folder, requestedFetch);
					// A rerun for a folder no longer in front, or for a view that has
					// gone, would only spend processes.
				} while (entry.again && !this._disposed && (this._viewReady || this._stateSurfaces.watching()) && folder === this._workdir());
			} finally {
				this._gitRefreshes.delete(folder);
			}
		})();
		return entry.done;
	}

	/** The last answer per repository and source, so switching tabs does not ask GitHub again for 30 s. */
	private readonly _githubCache = new Map<string, { at: number; status: GithubStatus; signIn?: boolean }>();

	/**
	 * The GitHub tab: the repository of `folder` (read from its remotes, never
	 * from what the view says), then its open pull requests and recent Actions
	 * runs from `gh` (signed in), else VS Code's own GitHub sign-in (silent unless
	 * the user pressed Sign in), else the public API, which only answers for a
	 * public repository. `gh` is run outside the folder with `--repo`, so it
	 * reads none of the repository's own Git configuration (#208).
	 */
	private async _githubStatus(folder: string, signIn: boolean): Promise<void> {
		const answer = (rest: Omit<Extract<HostToView, { type: 'githubStatus' }>, 'type' | 'folder'>) => this._postMessage({ type: 'githubStatus', folder, ...rest });
		if (this._blocked()) { answer({ error: 'GitHub is unavailable in this window.' }); return; }
		let repo: RepoRef | undefined;
		let branch: string | undefined;
		try {
			const git = await gitBinary();
			if (!git) { throw new Error('Git is unavailable.'); }
			const [urls, head] = await Promise.all([
				this._runWorkdirGit(git, ['config', '--get-regexp', '^remote\\..*\\.url$'], folder, 15_000).catch(() => ''),
				this._runWorkdirGit(git, ['symbolic-ref', '--quiet', '--short', 'HEAD'], folder, 15_000).catch(() => ''),
			]);
			branch = head.trim() || undefined;
			const upstreamRemote = branch ? (await this._runWorkdirGit(git, ['config', '--get', `branch.${branch}.remote`], folder, 15_000).catch(() => '')).trim() : '';
			repo = pickGithubRemote(parseRemoteUrls(urls), parseRepo, upstreamRemote || undefined);
		} catch (error) {
			answer({ error: error instanceof Error ? error.message : String(error) });
			return;
		}
		if (!repo) { answer({ error: 'This folder has no GitHub remote.' }); return; }
		const slug = repoSlug(repo);
		const cached = this._githubCache.get(slug);
		if (cached && !signIn && Date.now() - cached.at < 30_000) { answer({ status: { ...cached.status, branch, prs: mark(cached.status.prs), runs: mark(cached.status.runs) }, ...(cached.signIn ? { signIn: true } : {}) }); return; }
		function mark<T extends { branch: string; current?: boolean }>(items: readonly T[]): T[] { return items.map(i => ({ ...i, current: !!branch && i.branch === branch })); }
		const failures: string[] = [];
		const gh = await this._ghBinary();
		if (gh) {
			try {
				const run = (args: string[]) => this._runGh(gh, args);
				const prs = parseGhPullRequests(await run(['pr', 'list', '--repo', slug, '--state', 'open', '--limit', String(githubListLimit), '--json', ghPrFields]), branch);
				let runs: GithubStatus['runs'] = [];
				let runsError: string | undefined;
				try { runs = parseGhRuns(await run(['run', 'list', '--repo', slug, '--limit', String(githubListLimit), '--json', ghRunFields]), branch); }
				catch (error) { runsError = error instanceof Error ? error.message : String(error); }
				return this._githubAnswer(slug, { repo: slug, source: 'gh', branch, prs, runs, ...(runsError ? { runsError } : {}) }, answer);
			} catch (error) {
				failures.push(`gh: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		let token: string | undefined;
		try {
			const session = await vscode.authentication.getSession('github', ['repo'], signIn ? { createIfNone: true } : { silent: true });
			token = session?.accessToken;
		} catch (error) {
			if (signIn) { failures.push(error instanceof Error ? error.message : String(error)); }
		}
		const source: GithubSource = token ? 'vscode' : 'public';
		try {
			const api = async (route: string) => {
				const response = await fetch(`https://api.github.com/repos/${slug}/${route}`, {
					headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ai-browser', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
					signal: AbortSignal.timeout(15_000),
				});
				if (!response.ok) { throw new Error(response.status === 404 ? 'Repository not found, or private.' : response.status === 403 || response.status === 429 ? 'GitHub refused: rate limit or no access.' : `GitHub answered ${response.status}.`); }
				const body = await response.text();
				if (body.length > 8_000_000) { throw new Error('GitHub answered too much.'); }
				return body;
			};
			const prs = parseApiPullRequests(await api(`pulls?state=open&per_page=${githubListLimit}`), branch);
			let runs: GithubStatus['runs'] = [];
			let runsError: string | undefined;
			try { runs = parseApiRuns(await api(`actions/runs?per_page=${githubListLimit}`), branch); }
			catch (error) { runsError = error instanceof Error ? error.message : String(error); }
			this._githubAnswer(slug, { repo: slug, source, branch, prs, runs, ...(runsError ? { runsError } : {}) }, answer, !token);
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
			answer({ error: `${slug}: ${failures.join(' · ')}`, signIn: !token });
		}
	}

	private _githubAnswer(slug: string, status: GithubStatus, answer: (rest: { status: GithubStatus; signIn?: boolean }) => void, signIn?: boolean): void {
		this._githubCache.set(slug, { at: Date.now(), status, ...(signIn ? { signIn } : {}) });
		answer({ status, ...(signIn ? { signIn } : {}) });
	}

	private _ghPath: Promise<string | undefined> | undefined;
	/** `gh` from an absolute `PATH` entry or the usual install folders, by absolute path (#448). */
	private _ghBinary(): Promise<string | undefined> {
		return this._ghPath ??= (async () => {
			const exe = process.platform === 'win32' ? 'gh.exe' : 'gh';
			const dirs = [...(process.env.PATH ?? '').split(path.delimiter).filter(d => path.isAbsolute(d)), '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')];
			for (const dir of dirs) {
				const file = path.join(dir, exe);
				try { await fs.promises.access(file, fs.constants.X_OK); return file; } catch { /* next */ }
			}
			return undefined;
		})();
	}

	private _runGh(gh: string, args: readonly string[]): Promise<string> {
		return new Promise((resolve, reject) => {
			cp.execFile(gh, args, {
				cwd: os.homedir(), timeout: 20_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
				env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_PAGER: '', PAGER: '' },
			}, (error, stdout, stderr) => {
				if (error) { reject(new Error(String(stderr).trim().split('\n').slice(-2).join(' ') || error.message)); return; }
				resolve(String(stdout));
			});
		});
	}

	private async _readWorkdirGit(folder: string, fetch?: 'auto' | 'force'): Promise<void> {
		// Restricted Mode, or a remote window: `git status` runs the repository's
		// own `filter.<driver>.clean` commands from `.git/config`, which
		// `core.fsmonitor=false` does not stop — code from a folder the user has
		// not trusted (#208). Every other footer Git path refuses here too. The
		// view still gets an answer, or its refresh button stays disabled.
		if (this._blocked()) {
			this._postMessage({ type: 'workdirGit', folder, error: 'Git is unavailable in this window.' });
			return;
		}
		try {
			const git = await gitBinary();
			if (!git) { throw new Error('Git is unavailable'); }
			let fetchError: string | undefined;
			if (fetch) {
				try { await this._fetchWorkdirGit(git, folder, fetch === 'force'); }
				catch (error) { fetchError = gitExtensionErrorText(error); }
			}
			const [output, current, refs, urls] = await Promise.all([
				this._runWorkdirGit(git, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], folder, 15_000),
				this._runWorkdirGit(git, ['symbolic-ref', '--quiet', 'HEAD'], folder, 15_000).catch(() => ''),
				this._runWorkdirGit(git, ['for-each-ref', '--sort=refname', `--format=${branchRefFormat}`, 'refs/heads/', 'refs/remotes/'], folder, 15_000),
				// Exit 1 is "no remote at all", which is an answer, not a failure.
				this._runWorkdirGit(git, ['config', '--get-regexp', '^remote\\..*\\.url$'], folder, 15_000).catch(() => ''),
			]);
			const status = parseGitStatus(output);
			const decorated = this._view && !this._chromeCommand?.getStore() ? await themedGitFiles(status, this._view.webview, vscode.Uri.joinPath(this._context.extensionUri, 'media'), vscode.Uri.file(folder)) : status;
			const branches = parseGitBranches(current, refs, urls);
			this._postMessage({ type: 'workdirGit', folder, status: decorated, branches: { ...branches, ...this._pullRequestFor(branches), savedStash: this._branchStashes.get(folder)?.at(-1) }, ...(fetchError ? { fetchError } : {}) });
		} catch (error) {
			this._postMessage({ type: 'workdirGit', folder, error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async _fetchWorkdirGit(git: string, folder: string, force: boolean): Promise<void> {
		if (this._disposed || this._blocked()) { return; }
		if (this._untrusted(folder)) { throw new Error('Trust this repository before fetching remote changes.'); }
		const root = (await this._runWorkdirGit(git, ['rev-parse', '--show-toplevel'], folder, 15_000)).trim();
		const key = await fs.promises.realpath(root);
		await ChatViewProvider._gitFetches.run(key, force, async () => {
			if (this._disposed || this._blocked() || this._untrusted(folder)) { return; }
			const remotes = await this._runWorkdirGit(git, ['remote'], folder, 15_000);
			if (!remotes.trim()) { return; }
			if (force) {
				// An explicit click may ask VS Code to authenticate using its Git integration.
				const repository = await gitRepositoryFor(root, folder);
				for (const remote of remotes.trim().split('\n')) { await repository.fetch({ remote: remote.trim() }); }
			} else {
				// Periodic reads must not open sign-in dialogs. Existing helpers/SSH keys may authenticate.
				await this._runWorkdirGit(git, ['-c', `core.hooksPath=${os.devNull}`, '-c', 'credential.interactive=false', 'fetch', '--all', '--prune', '--no-recurse-submodules', '--quiet'], folder, 20_000, { GIT_ASKPASS: '', SSH_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never' });
			}
		});
	}

	private async _openGitDiff(message: Extract<ViewToHost, { type: 'openGitDiff' }>): Promise<void> {
		const { folder, tabId, staged } = message;
		const tab = this._tabs.find(t => t.id === tabId);
		const current = () => !this._disposed && !this._blocked() && !!tab && tab === (this._chromeCommand?.getStore()?.tab ?? this._active) && folder === this._workdir(tab);
		if (typeof folder !== 'string' || typeof message.path !== 'string' || typeof staged !== 'boolean' || !current()) { return; }
		try {
			const git = await gitBinary();
			if (!git) { throw new Error('Git is unavailable.'); }
			const root = (await this._runWorkdirGit(git, ['rev-parse', '--show-toplevel'], folder)).trim();
			const status = parseGitStatus(await this._runWorkdirGit(git, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], folder));
			const file = (staged ? status.staged : status.unstaged).find(f => f.path === message.path);
			if (!file) { throw new Error('This file is no longer in that group. Refresh the Git changes.'); }
			const extension = vscode.extensions.getExtension<{ getAPI(version: 1): {
				toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
				openRepository(uri: vscode.Uri): Promise<unknown>;
			} }>('vscode.git');
			if (!extension) { throw new Error('Enable the built-in Git extension to view diffs.'); }
			const api = (await extension.activate()).getAPI(1);
			if (!await api.openRepository(vscode.Uri.file(root))) { throw new Error('The Git extension could not open this repository.'); }
			const emptyId = generateUuid();
			const empty = vscode.Uri.from({ scheme: this._attachmentScheme, path: `/git-diff-empty/${path.basename(file.path)}`, query: emptyId });
			const sideUri = (side: ReturnType<typeof gitDiffSides>['before']) => {
				if (!side) { return empty; }
				const uri = vscode.Uri.file(path.join(root, side.path));
				return side.ref === undefined ? uri : api.toGitUri(uri, side.ref);
			};
			const sides = gitDiffSides(file, staged);
			if (!current()) { return; }
			await vscode.commands.executeCommand('vscode.diff', sideUri(sides.before), sideUri(sides.after),
				`${file.path} (${staged ? 'Staged: HEAD ↔ Index' : 'Unstaged: Index ↔ Working Tree'})`, { preview: true });
		} catch (error) { refuse(`Could not open diff: ${error instanceof Error ? error.message : String(error)}`); }
	}

	private async _changeGitIndex(message: Extract<ViewToHost, { type: 'gitIndexAction' }>): Promise<void> {
		const { folder, action } = message;
		const tab = this._tabs.find(t => t.id === message.tabId);
		let error: string | undefined;
		try {
			if (!tab || tab !== (this._chromeCommand?.getStore()?.tab ?? this._active) || typeof folder !== 'string' || this._workdir(tab) !== folder
				|| !['stage', 'unstage'].includes(action) || (message.path !== undefined && typeof message.path !== 'string')) {
				throw new Error('The working folder changed. Open Git changes again.');
			}
			if (this._blocked()) { throw new Error('Git changes are unavailable in this window.'); }
			const git = await gitBinary();
			if (!git) { throw new Error('Git is unavailable.'); }
			await this._withGitMutation(folder, async () => {
				const current = () => {
					if (!this._tabs.includes(tab) || tab !== (this._chromeCommand?.getStore()?.tab ?? this._active) || this._workdir(tab) !== folder) {
						throw new Error('The working folder changed. Open Git changes again.');
					}
				};
				current();
				const status = parseGitStatus(await this._runWorkdirGit(git, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], folder));
				await changeGitIndex(args => { current(); return this._runWorkdirGit(git, args, folder); }, status, action, message.path);
			});
		} catch (err) { error = err instanceof Error ? err.message : String(err); }
		finally {
			try {
				if (!this._disposed && folder === this._workdir()) {
					// A coalesced read may belong to another remote request, whose
					// reply callback cannot update the popup that made this mutation.
					if (this._chromeCommand?.getStore()) { await this._readWorkdirGit(folder); }
					else { await this._refreshWorkdirGit(); }
				}
			} finally { this._postMessage({ type: 'gitIndexResult', folder, error }); }
		}
	}

	private readonly _gitCommits = new Map<string, GitCommitJob>();

	private async _commitWorkdir(folder: string, tabId: string, scope: 'staged' | 'all' = 'staged', push = false): Promise<void> {
		const tab = this._tabs.find(t => t.id === tabId);
		if (typeof folder !== 'string' || !tab || tab !== (this._chromeCommand?.getStore()?.tab ?? this._active) || this._workdir(tab) !== folder || !['staged', 'all'].includes(scope)) { return; }
		const previous = this._gitCommits.get(folder)?.state.phase;
		if (previous === 'generating' || previous === 'committing') { return; }
		const job: GitCommitJob = {
			state: { id: generateUuid(), phase: 'generating', message: 'Preparing changes…' },
			controller: new AbortController(), tab, chatId: tab.chat.id,
		};
		this._gitCommits.set(folder, job);
		this._post();
		let release: (() => void) | undefined;
		let committed = false;
		const guard = () => {
			job.controller.signal.throwIfAborted();
			if (this._disposed || !this._tabs.includes(tab) || tab.chat.id !== job.chatId || this._workdir(tab) !== folder) {
				throw new Error('The conversation or working folder changed. Commit was cancelled.');
			}
			if (this._blocked()) { throw new Error('Commit is unavailable in this window.'); }
			if (this._tabs.some(t => this._workdir(t) === folder && (t.busy || this._repoBusy.has(t) || this._runs.runningIn(t.chat.id) > 0))) {
				throw new Error('Wait for agents working in this repository to finish before committing.');
			}
		};
		try {
			guard();
			release = await this._gitAccess.mutate(folder, () => this._busyGitFolders());
			if (this._registry.detecting) { await this._registry.detect(); }
			guard();
			const { agent, model: selectedModel, effort, prompt } = this._featureSelection('commitMessage', tab);
			const model = selectedModel.id;
			const backend = this._registry.backend(agent);
			if (!backend?.generateCommitMessage) { throw new Error('The selected agent cannot generate commit messages.'); }
			job.agent = agent;
			const git = await gitBinary();
			if (!git) { throw new Error('Git is unavailable.'); }
			const config = this._untrusted(folder) ? ['-c', `core.hooksPath=${os.devNull}`] : [];
			const result = await commitChanges(
				args => this._runWorkdirGit(git, [...config, ...args], folder),
				async context => {
					const message = await backend.generateCommitMessage!(model, effort, context, job.controller.signal, prompt);
					job.proposedMessage = message;
					return message;
				}, guard,
				phase => {
					job.state = { id: job.state.id, phase, message: phase === 'generating' ? `Generating commit message with ${model}…` : 'Committing…' };
					this._post();
				}, scope,
			);
			if (this._gitCommits.get(folder) === job) { this._gitCommits.delete(folder); }
			committed = true;
			if (!this._disposed) { timedInformation(`Committed ${result.hash}: ${result.message.split('\n')[0]}`); }
		} catch (error) {
			const detail = (error instanceof Error ? error.message : String(error)).slice(0, 6000);
			job.state = { id: job.state.id, phase: 'error', message: `Commit failed: ${detail}` };
			if (!this._disposed && this._tabs.includes(tab) && tab.chat.id === job.chatId) { tab.push({ kind: 'error', text: job.state.message! }); }
		} finally {
			release?.();
			if (!this._disposed) {
				this._post();
				if (folder === this._workdir()) { await this._refreshWorkdirGit(); }
			}
		}
		// Commit & Push: the Branches window's own push, after the lock is
		// released — publish when the branch has no upstream yet. Its questions
		// and errors come back as `gitRemoteResult`, which opens that window.
		if (push && committed && !this._disposed && folder === this._workdir()) { await this._pushAfterCommit(folder); }
	}

	private async _pushAfterCommit(folder: string): Promise<void> {
		const git = await gitBinary();
		const upstream = git ? await this._runWorkdirGit(git, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], folder).then(s => s.trim(), () => '') : '';
		await this._gitRemoteAction({ type: 'gitRemoteAction', folder, action: upstream ? 'push' : 'publish' });
	}

	private async _answerCommit(message: Extract<ViewToHost, { type: 'fixGitCommit' | 'dismissGitCommit' }>): Promise<void> {
		const tab = this._tabs.find(t => t.id === message.tabId);
		const job = this._gitCommits.get(message.folder);
		if (!tab || tab !== (this._chromeCommand?.getStore()?.tab ?? this._active) || this._workdir(tab) !== message.folder || !job || job.state.id !== message.id
			|| (job.state.phase !== 'error' && job.state.phase !== 'done')) { return; }
		if (message.type === 'dismissGitCommit') {
			this._gitCommits.delete(message.folder); this._post(); return;
		}
		if (job.state.phase !== 'error') { return; }
		const prompt = `Help fix this Git commit failure in the working repository ${message.folder}. Inspect the actual repository state, diagnose and fix the cause, then retry the commit if possible. Preserve the user's changes and staged selection. Do not reset, discard changes, bypass hooks or push. If fixing it needs a choice, ask first.\n\nReported error:\n${job.state.message}${job.proposedMessage ? `\n\nGenerated commit message:\n${job.proposedMessage}` : ''}`;
		this._gitCommits.delete(message.folder);
		this._post();
		await this._send(prompt, tab.id, []);
	}


 private async _suggestBranchName(message: Extract<ViewToHost, { type: 'gitBranchName' }>): Promise<void> {
  const tab = this._tabs.find(t => t.id === message.tabId);
  if (!tab || tab !== (this._chromeCommand?.getStore()?.tab ?? this._active) || message.folder !== this._workdir(tab) || this._blocked()) { return; }
  const controller = new AbortController();
  this._branchNameRequests.get(tab)?.abort();
  this._branchNameRequests.set(tab, controller);
  const chatId = tab.chat.id;
  try {
   const selected = this._featureSelection('branchName', tab);
   this._featureRequestAgents.set(controller, selected.agent);
   this._branchNameRequestIds.set(controller, message.id);
   const backend = this._registry.backend(selected.agent);
   const model = { ...selected.model, efforts: selected.effort ? [selected.effort] : [] };
   if (!backend?.generateTitle) { throw new Error('The selected agent cannot generate branch names.'); }
   const git = await gitBinary();
   if (!git) { throw new Error('Git is unavailable.'); }
   const folder = message.folder;
   const status = await this._runWorkdirGit(git, ['status', '--porcelain=v1', '--untracked-files=all'], folder);
   const discussion = tab.chat.entries.filter(e => e.kind === 'user' || e.kind === 'assistant').slice(-6).map(e => 'text' in e ? e.text.slice(-1500) : '').join('\n');
   if (!status.trim() && !discussion.trim()) { throw new Error('No changes or discussion to name the branch from.'); }
   const diffs = status.trim() ? await Promise.all([
    this._runWorkdirGit(git, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--stat'], folder),
    this._runWorkdirGit(git, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color', '--stat'], folder),
   ]) : [];
   const context = `Changes:\n${status.slice(0, 3000)}\n${diffs.join('\n').slice(0, 3000)}\nDiscussion:\n${discussion.slice(-6000)}`;
   let name = await backend.generateTitle(model, context, controller.signal, 'branch', selected.prompt);
   if (controller.signal.aborted || !this._tabs.includes(tab) || tab.chat.id !== chatId) { return; }
   if (!name) { throw new Error('Could not generate a branch name. Please try again.'); }
   await this._runWorkdirGit(git, ['check-ref-format', `refs/heads/${name}`], folder);
   const refs = (await this._runWorkdirGit(git, ['for-each-ref', '--format=%(refname)', 'refs/heads/'], folder)).trim().split('\n').filter(Boolean).map(ref => ref.slice('refs/heads/'.length));
   name = availableBranchName(name, refs);
   if (!controller.signal.aborted) { this._postMessage({ type: 'gitBranchNameResult', id: message.id, name }); }
  } catch (error) {
   if (!controller.signal.aborted) { this._postMessage({ type: 'gitBranchNameResult', id: message.id, error: error instanceof Error ? error.message : String(error) }); }
  } finally {
   if (this._branchNameRequests.get(tab) === controller) { this._branchNameRequests.delete(tab); }
  }
 }

	/**
	 * The pull request page for the current branch: published, not gone, not
	 * the remote's default branch, and on a github.com remote. Only an address
	 * `parseRepo` accepts — one carrying credentials, or another host, gives none.
	 */
	private _pullRequestFor(branches: ReturnType<typeof parseGitBranches>): { pullRequest?: string } {
		const upstream = branches.upstream;
		if (!upstream || upstream.gone) { return {}; }
		const remote = branches.remotes?.find(r => r.name === upstream.remote);
		const repo = remote && parseRepo(remote.url);
		if (!repo || pushesDefaultBranch(upstream.branch, remote.defaultBranch)) { return {}; }
		return { pullRequest: pullRequestUrl(repo, upstream.branch, remote.defaultBranch) };
	}

	/**
	 * Publish, push or pull of the current branch, from the Branches window.
	 * The network half goes through VS Code's Git extension — its askpass is
	 * what lets an https remote sign in (see `gitExtension.ts`); the decisions
	 * and the fast-forward are ours.
	 *
	 * - **Never forced.** A pull is `--ff-only`, as on a branch switch, and
	 *   diverged histories are left to the user. A push is checked to have
	 *   landed (`_pushLanded`), since the extension can resolve one that did not.
	 * - **Asked first, in the window**: a push to the remote's default branch,
	 *   to a branch of another name, and while agents work in the folder (what
	 *   is pushed is HEAD as it is now). The host answers `confirm` with a key
	 *   naming the push; the view sends the key back, and a yes counts only
	 *   for the same push.
	 * - **A push does not wait for the agents**: it changes no file. A pull
	 *   does, like a switch. Either holds the Git lock, so our own commit or
	 *   switch cannot interleave.
	 * - **Refused in a folder whose settings are held back**: the extension
	 *   runs the repository's `pre-push` hook, and a repository fetched from
	 *   GitHub that the user has not trusted must not run code (#443).
	 */
	private async _gitRemoteAction(message: Extract<ViewToHost, { type: 'gitRemoteAction' }>): Promise<void> {
		const { folder, action } = message;
		const answer = (result: { error?: string; confirm?: string; confirmKey?: string } = {}) => this._postMessage({ type: 'gitRemoteResult', folder, action, ...result });
		if (typeof folder !== 'string' || folder !== this._workdir() || !['publish', 'push', 'pull'].includes(action)
			|| (message.remote !== undefined && (typeof message.remote !== 'string' || !message.remote || message.remote.startsWith('-') || /[\0\r\n]/.test(message.remote)))) {
			answer({ error: 'Invalid Git action or working folder.' }); return;
		}
		let release: (() => void) | undefined;
		try {
			if (this._blocked()) { throw new Error('Git is unavailable in this window.'); }
			if (this._untrusted(folder)) {
				throw new Error('This repository\'s settings are held back, so its Git hooks must not run. Trust them from the folder button first.');
			}
			const sharing = () => [...this._services.views].flatMap(view => view._tabs.filter(t => view._workdir(t) === folder));
			const working = () => sharing().some(t => t.busy || this._repoBusy.has(t) || this._runs.runningIn(t.chat.id) > 0);
			// A pull rewrites files under the agents; a push only reads HEAD.
			release = await this._gitAccess.mutate(folder, action === 'pull' ? () => this._busyGitFolders() : () => []);
			if (this._blocked()) { throw new Error('Git is unavailable in this window.'); }
			const git = await gitBinary();
			if (!git) { throw new Error('Git is unavailable.'); }
			const [current, refs, urls] = await Promise.all([
				this._runWorkdirGit(git, ['symbolic-ref', '--quiet', 'HEAD'], folder).catch(() => ''),
				this._runWorkdirGit(git, ['for-each-ref', `--format=${branchRefFormat}`, 'refs/heads/', 'refs/remotes/'], folder),
				this._runWorkdirGit(git, ['config', '--get-regexp', '^remote\\..*\\.url$'], folder).catch(() => ''),
			]);
			const state = parseGitBranches(current, refs, urls);
			const branch = state.current;
			if (!branch) { throw new Error('No branch is checked out (detached HEAD).'); }
			const remotes = (state.remotes ?? []).map(r => r.name);
			const upstream = state.upstream && !state.upstream.gone ? state.upstream : undefined;
			const root = (await this._runWorkdirGit(git, ['rev-parse', '--show-toplevel'], folder)).trim();
			if (action === 'publish') {
				if (!remotes.length) { throw new Error('This repository has no remote. Add one (git remote add origin <url>) to publish.'); }
				if (upstream) { throw new Error(`${branch} is already published to ${upstream.remote}/${upstream.branch}. Refresh the branch list.`); }
				const remote = publishRemote(remotes, message.remote);
				if (!remote) { throw new Error(message.remote ? `There is no remote named ${message.remote}.` : 'Choose the remote to publish to.'); }
				const defaultBranch = state.remotes?.find(r => r.name === remote)?.defaultBranch;
				// A yes answers the question shown, about this push: asked again
				// for any other — HEAD moved to another branch, another remote.
				const ask = this._pushQuestion(branch, remote, branch, defaultBranch, working());
				if (ask && message.confirmed !== pushKey(action, branch, remote, branch, ask)) {
					answer({ confirm: ask, confirmKey: pushKey(action, branch, remote, branch, ask) }); return;
				}
				const sha = (await this._runWorkdirGit(git, ['rev-parse', '--verify', `refs/heads/${branch}`], folder)).trim();
				const repository = await gitRepositoryFor(root, folder);
				await repository.push(remote, `refs/heads/${branch}:refs/heads/${branch}`, true);
				// `<branch>@{upstream}`: the `refs/heads/` spelling is refused ("no such branch").
				await this._pushLanded(git, folder, `${branch}@{upstream}`, sha, remote);
				confirm(`Published ${branch} to ${remote}.`);
			} else if (action === 'push') {
				if (!upstream) { throw new Error(`${branch} is not published yet. Refresh the branch list.`); }
				if (upstream.ahead === 0) { throw new Error('There is nothing to push.'); }
				const defaultBranch = state.remotes?.find(r => r.name === upstream.remote)?.defaultBranch;
				const ask = this._pushQuestion(branch, upstream.remote, upstream.branch, defaultBranch, working());
				if (ask && message.confirmed !== pushKey(action, branch, upstream.remote, upstream.branch, ask)) {
					answer({ confirm: ask, confirmKey: pushKey(action, branch, upstream.remote, upstream.branch, ask) }); return;
				}
				const sha = (await this._runWorkdirGit(git, ['rev-parse', '--verify', `refs/heads/${branch}`], folder)).trim();
				const repository = await gitRepositoryFor(root, folder);
				// Spelled out rather than `git push` alone, whose target follows
				// `push.default`; a branch tracking another name is asked about
				// first (`_pushQuestion`), as `simple` would refuse it.
				await repository.push(upstream.remote, `refs/heads/${branch}:refs/heads/${upstream.branch}`, false);
				await this._pushLanded(git, folder, upstream.tracking ?? `refs/remotes/${upstream.remote}/${upstream.branch}`, sha, upstream.remote);
				confirm(`Pushed ${branch} to ${upstream.remote}/${upstream.branch}.`);
			} else {
				if (!upstream) { throw new Error(`${branch} has no upstream to pull from.`); }
				if (working()) { throw new Error('Wait for agents working in this folder to finish.'); }
				const before = (await this._runWorkdirGit(git, ['rev-parse', '--verify', 'HEAD'], folder)).trim();
				const repository = await gitRepositoryFor(root, folder);
				await repository.fetch({ remote: upstream.remote, ref: upstream.branch });
				if (folder !== this._workdir() || working()) { throw new Error('The working folder changed or an agent started. Try again when it is idle.'); }
				// Our own git, with no hooks (as on a branch switch), and only a fast-forward:
				// `pull` would merge or rebase as the user's config says.
				await this._runWorkdirGit(git, ['-c', `core.hooksPath=${os.devNull}`, '-c', 'merge.autoStash=false', 'merge', '--ff-only', '--no-edit', '--no-overwrite-ignore', '@{upstream}'], root, 120_000);
				const after = (await this._runWorkdirGit(git, ['rev-parse', '--verify', 'HEAD'], folder)).trim();
				// Nothing new is not an update — a fetch refspec that does not
				// cover the branch leaves the tracking ref where it was, too.
				confirm(after === before ? `${branch} is already up to date with ${upstream.remote}/${upstream.branch}.` : `Updated ${branch} from ${upstream.remote}/${upstream.branch}.`);
			}
			answer();
		} catch (error) {
			// The extension's `GitError` carries git's stderr whether or not it
			// recognised the failure; without it, only "Failed to execute git".
			const fromGit = error as { gitErrorCode?: string; stderr?: string } | undefined;
			const text = fromGit?.gitErrorCode !== undefined || fromGit?.stderr ? gitExtensionErrorText(error)
				: error instanceof Error ? (/divergent|Not possible to fast-forward/i.test(error.message) ? 'The branch and its upstream have diverged. Merge or rebase them yourself; only fast-forwards are done here.' : error.message) : String(error);
			answer({ error: text });
		} finally {
			release?.();
			if (folder === this._workdir()) { await this._refreshWorkdirGit(); }
		}
	}

	/**
	 * A push resolving is not a push that landed: the Git extension hands a
	 * failure to the push error handlers first, and the GitHub extension's
	 * takes PermissionDenied and a secret-scanning refusal (GH009) — showing
	 * its own dialog and answering as handled, so `push()` resolves with
	 * nothing on the remote. The remote-tracking ref is what git moves on a
	 * push that did.
	 */
	private async _pushLanded(git: string, folder: string, tracking: string, sha: string, remote: string): Promise<void> {
		const landed = (await this._runWorkdirGit(git, ['rev-parse', '--verify', '--quiet', tracking], folder).catch(() => '')).trim();
		if (landed !== sha) {
			throw new Error(`The push did not reach ${remote}. VS Code's GitHub or Git extension may have said why; this push changed nothing on the remote.`);
		}
	}

	/** The question a push asks first, or undefined when it goes ahead. */
	private _pushQuestion(branch: string, remote: string, target: string, defaultBranch: string | undefined, agentsWorking: boolean): string | undefined {
		const reasons: string[] = [];
		if (pushesDefaultBranch(target, defaultBranch)) { reasons.push(`This pushes ${branch} straight to ${remote}/${target}, the default branch.`); }
		// `git switch -c feat origin/develop` tracks `develop`: plain `git push`
		// (`push.default=simple`) refuses this, so it is asked, never assumed.
		else if (target !== branch) { reasons.push(`This pushes ${branch} to ${remote}/${target}, a branch of another name.`); }
		if (agentsWorking) { reasons.push('Agents are working in this folder; only what is committed now is pushed.'); }
		return reasons.length ? reasons.join(' ') : undefined;
	}

	private readonly _branchStashes = new Map<string, NonNullable<SwitchResult['stash']>[]>();

	private async _gitBranchAction(message: Extract<ViewToHost, { type: 'gitBranchAction' }>): Promise<void> {
		const { folder, name, action, remote } = message;
		const answer = (error?: string) => this._postMessage({ type: 'gitBranchResult', folder, action, error });
		if (typeof folder !== 'string' || folder !== this._workdir() || typeof name !== 'string'
			|| !['switch', 'create', 'delete'].includes(action) || !name || name.startsWith('-') || /[\0\r\n]/.test(name)) {
			answer('Invalid branch action or working folder.'); return;
		}
		let release: (() => void) | undefined;
		try {
			// Asked before the lock too: taking it runs `git rev-parse` in the folder (#208).
			if (this._blocked()) { throw new Error('Git branch actions are unavailable in this window.'); }
			release = await this._gitAccess.mutate(folder, () => this._busyGitFolders());
			if (this._blocked()) { throw new Error('Git branch actions are unavailable in this window.'); }
			const sharing = () => [...this._services.views].flatMap(view => view._tabs.filter(t => view._workdir(t) === folder));
			const working = () => sharing().some(t => t.busy || this._repoBusy.has(t) || this._runs.runningIn(t.chat.id) > 0);
			if (working()) { throw new Error('Wait for agents working in this folder to finish.'); }
			const git = await gitBinary();
			if (!git) { throw new Error('Git is unavailable.'); }
			const refs = await this._runWorkdirGit(git, ['for-each-ref', '--format=%(refname)%00%(symref)', 'refs/heads/', 'refs/remotes/'], folder);
			const branches = parseGitBranches('', refs).branches;
			if (action !== 'create' && !branches.some(b => b.name === name && b.remote === (remote === true))) {
				throw new Error('This branch no longer exists. Refresh the branch list.');
			}
			if (action === 'delete' && remote) { throw new Error('Only local branches can be deleted here.'); }
			if (action === 'create') { await this._runWorkdirGit(git, ['check-ref-format', `refs/heads/${name}`], folder); }
			if (folder !== this._workdir() || working()) { throw new Error('The working folder changed or an agent started. Try again when it is idle.'); }
			// Branch switching must not execute hooks from a repository fetched from GitHub.
			const args = ['-c', `core.hooksPath=${os.devNull}`];
			if (action === 'switch') {
				const root = (await this._runWorkdirGit(git, ['rev-parse', '--show-toplevel'], folder)).trim();
				const dirtyEditors = () => vscode.workspace.textDocuments.filter(doc => doc.isDirty && doc.uri.scheme === 'file' && (() => {
					const relative = path.relative(root, doc.uri.fsPath);
					return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
				})());
				if (dirtyEditors().length) {
					if (await vscode.window.showWarningMessage('Save edited files before switching branches?', { modal: true, detail: 'Commit and Stash operate on files saved to disk.' }, 'Save & Continue') !== 'Save & Continue') { answer('Branch switch cancelled.'); return; }
					if ((await Promise.all(dirtyEditors().map(doc => doc.save()))).some(saved => !saved)) { throw new Error('Some files could not be saved. Branch switch cancelled.'); }
				}
				const run = async (command: readonly string[]) => {
					if (this._disposed || this._blocked() || folder !== this._workdir() || working()) { throw new Error('The working folder changed or is no longer idle. Try again.'); }
					if (dirtyEditors().length) { throw new Error('An editor has unsaved changes. Save the file and try again.'); }
					await this._assertGitFolder(folder);
					return this._runWorkdirGit(git, [...args, ...command], root, 120_000);
				};
				const preview = async (content: string) => {
					const id = generateUuid();
					remember(this._attachmentTexts, id, content);
					const uri = vscode.Uri.from({ scheme: this._attachmentScheme, path: '/branch-changes.txt', query: id });
					const doc = await vscode.workspace.openTextDocument(uri);
					await vscode.window.showTextDocument(doc, { preview: true });
				};
				const result = await switchAndUpdate(run, name, remote === true, {
					changes: async () => {
						const picked = await vscode.window.showQuickPick([
							{ label: 'Stash & Switch', value: 'stash' as const, description: 'Include untracked files; keep the stash after switching' },
							{ label: 'Commit All & Switch', value: 'commit' as const, description: 'Commit staged + unstaged changes and untracked files on the current branch' },
							{ label: 'Discard Changes & Switch…', value: 'discard' as const, description: 'Permanently discard changes after confirmation' },
						], { title: `Uncommitted changes — switch to ${name}`, placeHolder: 'Choose how to handle changes, or Escape to cancel', ignoreFocusOut: true });
						return picked?.value;
					},
					commit: async content => {
						await preview(content);
						return vscode.window.showInputBox({ title: 'Commit All & Switch', prompt: 'Review the changes in the editor, then enter a commit message', ignoreFocusOut: true, validateInput: value => value.trim() ? undefined : 'Enter a commit message' });
					},
					discard: async content => {
						await preview(content);
						return await vscode.window.showWarningMessage('Discard all staged, unstaged and untracked changes before switching?', { modal: true, detail: 'Review the files in the editor. Untracked files will be deleted permanently. Ignored files are kept.' }, 'Discard Changes & Switch') === 'Discard Changes & Switch';
					},
					offline: async error => await vscode.window.showWarningMessage('Fetch failed. Switch using the local copy without updating?', { modal: true, detail: error }, 'Switch Without Updating') === 'Switch Without Updating',
					localName: async existing => vscode.window.showInputBox({ title: 'Choose a local branch name', prompt: `${existing} already exists with a different upstream. Enter another name; the existing branch will be kept.`, ignoreFocusOut: true }),
					stashed: async saved => {
						this._branchStashes.set(folder, [...(this._branchStashes.get(folder) ?? []), saved]);
						await this._context.workspaceState.update('aiBrowser.branchStashes', Object.fromEntries(this._branchStashes));
					},
				});
				if (!result) { answer('Branch switch cancelled.'); return; }
				if (result.note) { void vscode.window.showInformationMessage(result.note); }
				if (result.stash) { confirm(`Stash saved for ${result.stash.branch}. Use “Return & Apply Stash” in the branches menu to restore it.`); }
			} else {
				await this._runWorkdirGit(git, [...args, ...branchCommand(action, name, remote)], folder);
			}
			if (action !== 'delete') {
				const current = (await this._runWorkdirGit(git, ['symbolic-ref', '--short', 'HEAD'], folder)).trim();
				for (const tab of sharing()) { tab.updateCopyBranch(current); }
			}
			this._listings.delete(folder);
			this._post();
			answer();
		} catch (error) {
			answer(error instanceof Error ? error.message : String(error));
		} finally {
			// Switching can succeed even if updating the selected branch fails.
			try {
				if (action === 'switch' && release && !this._disposed && !this._blocked()) {
					const git = await gitBinary();
					if (git) {
						const current = await this._runWorkdirGit(git, ['symbolic-ref', '--short', 'HEAD'], folder).then(s => s.trim(), () => '');
						if (current) { for (const tab of this._tabs.filter(t => this._workdir(t) === folder)) { tab.updateCopyBranch(current); } }
					}
				}
			} finally { release?.(); }
			if (folder === this._workdir()) { await this._refreshWorkdirGit(); }
		}
	}

	private async _restoreBranchStash(folder: string): Promise<void> {
		if (folder !== this._workdir()) { return; }
		const entries = this._branchStashes.get(folder);
		if (!entries?.length) { return; }
		const saved = entries.length === 1 ? entries[0] : (await vscode.window.showQuickPick(entries.map(entry => ({ label: entry.branch, description: entry.hash.slice(0, 10), entry })), { title: 'Return & Apply Stash', placeHolder: 'Choose the saved changes to restore' }))?.entry;
		if (!saved) { return; }
		try {
			await this._withGitMutation(folder, async () => {
				const binary = await gitBinary();
				if (!binary) { throw new Error('Git is unavailable.'); }
				const root = (await this._runWorkdirGit(binary, ['rev-parse', '--show-toplevel'], folder)).trim();
				const git = async (args: readonly string[]) => {
					if (this._disposed || this._blocked() || folder !== this._workdir()) { throw new Error('The working folder changed.'); }
					if (vscode.workspace.textDocuments.some(doc => doc.isDirty && doc.uri.scheme === 'file' && (() => {
						const relative = path.relative(root, doc.uri.fsPath);
						return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
					})())) { throw new Error('Save edited files before restoring the stash.'); }
					await this._assertGitFolder(folder);
					return this._runWorkdirGit(binary, ['-c', `core.hooksPath=${os.devNull}`, ...args], root);
				};
				await assertSwitchReady(git);
				if ((await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'])).length) { throw new Error('Commit, stash or discard current changes before restoring the saved stash.'); }
				await git(['rev-parse', '--verify', `${saved.hash}^{commit}`]);
				await git(['switch', '--no-overwrite-ignore', '--no-recurse-submodules', '--no-guess', saved.branch, '--']);
				for (const tab of this._tabs.filter(t => this._workdir(t) === folder)) { tab.updateCopyBranch(saved.branch); }
				await git(['stash', 'apply', '--index', saved.hash]);
				this._branchStashes.set(folder, (this._branchStashes.get(folder) ?? []).filter(entry => entry.hash !== saved.hash));
				await this._context.workspaceState.update('aiBrowser.branchStashes', Object.fromEntries(this._branchStashes));
				confirm('Stash applied on the original branch; the stash entry was kept as a backup.');
			});
		} catch (error) { refuse(`Could not restore stash: ${error instanceof Error ? error.message : String(error)}. The stash was kept.`); }
		finally { await this._refreshWorkdirGit(); }
	}

	private _workdirState(): WorkdirState {
		const tab = this._active;
		const workspace = this._workspaceFolders();
		const current = this._workdir(tab);
		const shown = (p: string): WorkdirFolder => workspace.find(w => w.path === p) ?? { path: p, name: path.basename(p) || p, removable: p !== current && !!storedCopyRepo(this._repoStorage(), p) };
		const copy = tab.chat.copy;
		return {
			commit: current === undefined ? undefined : this._gitCommits.get(current)?.state,
			current: current === undefined ? undefined : copy ? { path: current, name: `${copy.repo} · copy` } : shown(current),
			picked: tab.chat.folder !== undefined,
			noProject: tab.chat.folder !== undefined && isHome(tab.chat.folder),
			workspace,
			recent: this._recentFolders().filter(p => !workspace.some(w => w.path === p)).map(shown),
			locked: tab.started,
			empty: current !== undefined && this._emptyFolder(current),
			copy,
			references: tab.chat.references ?? [],
			recentRepos: this._recentRepos(),
			busy: this._repoBusy.get(tab),
			heldBack: current !== undefined && this._untrusted(current) ? this._configFiles(current) : undefined,
		};
	}

	/**
	 * The folder button: the tab in front works in `folder`, `undefined` being
	 * the window's own. A conversation that has started keeps the folder it ran
	 * in — Claude Code finds a session only from the folder it was started in —
	 * so the folder goes to a new tab beside it. The CLIs load the folder's own
	 * configuration, its hooks included; picking it is the user's say-so, the
	 * same consent opening it as a VS Code window would be, and the chat refuses
	 * in Restricted Mode as before.
	 */
	private async _setWorkdir(folder: string | undefined, remember = true, from: ChatTab = (this._chromeCommand?.getStore()?.tab ?? this._active)): Promise<ChatTab | undefined> {
		const blocked = this._blocked();
		if (blocked) {
			refuse(blocked);
			return;
		}
		if (folder !== undefined) {
			if (folder.length > 4096 || /[\0\n\r]/.test(folder) || !path.isAbsolute(folder)) {
				return;
			}
			folder = path.resolve(folder);
			if (!isDirectory(folder)) {
				refuse(vscode.l10n.t("{0} is not a folder any more.", plainInLabel(folder)));
				await this._forgetRecent(folder);
				return undefined;
			}
			// The window's own first folder is the default: following it, not pinned.
			if (folder === this._workspaceFolders()[0]?.path) {
				folder = undefined;
			}
		}
		if (this._chromeCommand?.getStore() && (!this._tabs.includes(from) || from.chat.id !== this._chromeCommand.getStore()!.chatId)) { throw new Error('The destination conversation was closed.'); }
		// The tab asked for, unless it closed meanwhile (a clone takes minutes).
		let tab = this._tabs.includes(from) ? from : (this._chromeCommand?.getStore()?.tab ?? this._active);
		if (tab.chat.folder === folder && !tab.chat.copy) {
			return tab;
		}
		if (tab.started) {
			const opened = this._addTab(tab.chat.agent, tab);
			if (!opened) {
				return undefined;
			}
			tab = opened;
		}
		if (tab.chat.copy && tab.chat.folder) {
			await this._rememberFolder(tab.chat.folder);
		}
		tab.setFolder(folder);
		if (folder !== undefined && remember) {
			await this._rememberFolder(folder);
		}
		this._post();
		this._focusInput();
		// The "/" palette lists the skills of the project in front.
		const agent = tab.started ? tab.chat.agent : this._selection(tab).agent;
		if (agent && !this._registry.detecting) {
			void this._registry.refreshCommands(agent, this._cwd(), !this._untrusted(this._cwd())).catch(() => undefined);
		}
		return tab;
	}

	/** "Choose folder…": the system's folder dialog — native, so it pauses no browser tab. */
	private async _chooseWorkdir(): Promise<void> {
		const from = this._chromeCommand?.getStore()?.tab ?? this._active;
		const current = this._workdir(from);
		const picked = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			defaultUri: current ? vscode.Uri.file(current) : undefined,
			openLabel: vscode.l10n.t("Work in This Folder"),
			title: vscode.l10n.t("Folder for the AI Browser chat to work in"),
		});
		const uri = picked?.[0];
		if (uri?.scheme === 'file') {
			await this._setWorkdir(uri.fsPath, true, from);
		}
	}

	private async _rememberFolder(folder: string): Promise<void> {
		const next = [folder, ...this._recentFolders().filter(p => p !== folder)].slice(0, recentFolderLimit);
		await this._context.globalState.update(recentFoldersKey, next).then(undefined, () => { /* a convenience */ });
	}

	private async _forgetRecent(folder: string): Promise<void> {
		const list = this._recentFolders();
		if (list.includes(folder)) {
			await this._context.globalState.update(recentFoldersKey, list.filter(p => p !== folder)).then(() => this._post(), () => { /* a convenience */ });
		}
	}

	/** The tab in front's folder, listed for the folder button; nothing without a folder. */
	private async _listWorkdir(): Promise<void> {
		const folder = this._workdir();
		if (folder === undefined || this._blocked()) {
			this._postMessage({ type: 'workdirFiles', folder: '', entries: [], truncated: false });
			return;
		}
		const cached = this._listings.get(folder);
		const now = Date.now();
		let listing = cached && now >= cached.at && now - cached.at < workdirListingMs ? cached.listing : undefined;
		if (!listing) {
			listing = listWorkdir(folder);
			this._listings.set(folder, { at: now, listing });
			// One listing kept per folder, and only a few folders.
			while (this._listings.size > recentFolderLimit) {
				this._listings.delete(this._listings.keys().next().value!);
			}
		}
		const { entries, truncated } = await listing;
		this._postMessage({ type: 'workdirFiles', folder, entries, truncated });
	}

	/**
	 * A file or folder of the working folder, chosen in the folder button's list,
	 * attached to the tab in front's message — as its path, like the "+" menu's
	 * File: both agents read files themselves. Only inside that folder: the path
	 * comes from the view.
	 */
	private async _attachPath(relative: string): Promise<void> {
		const folder = this._workdir();
		if (folder === undefined || this._blocked() || !relative || relative.length > 4096 || /[\0\n\r]/.test(relative)) {
			return;
		}
		const target = path.resolve(folder, relative);
		const inside = path.relative(folder, target);
		if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
			return;
		}
		let directory: boolean;
		try {
			directory = (await fs.promises.stat(target)).isDirectory();
		} catch {
			refuse(vscode.l10n.t("{0} is not there any more.", plainInLabel(relative)));
			return;
		}
		const shown = inside.split(path.sep).join('/');
		const tab = this._active;
		tab.attachments.push(directory
			// A folder chip opens its text: `vscode.open` on a folder would open a window.
			? { chip: { id: generateUuid(), kind: 'file', label: `${path.basename(target)}/`, iconName: `${path.basename(target)}/` }, text: `Attached folder: ${target} (${shown}/ in the project)` }
			: { chip: { id: generateUuid(), kind: 'file', label: path.basename(target), iconName: path.basename(target) }, file: vscode.Uri.file(target), text: `Attached file: ${target} (${shown} in the project)` });
		this._post();
		this._focusInput();
	}

	/** Files or folders selected through VS Code Explorer's context menu. */
	public async attachExplorerResources(resources: readonly vscode.Uri[]): Promise<void> {
		const blocked = this._blocked();
		if (blocked) {
			refuse(blocked);
			return;
		}
		const unique = [...new Map(resources.filter(uri => uri.scheme === 'file').map(uri => [uri.fsPath, uri])).values()];
		if (!unique.length) { return; }
		const tab = this._active;
		const folder = this._workdir(tab);
		let attached = 0;
		for (const uri of unique) {
			let directory: boolean;
			try {
				directory = (await fs.promises.stat(uri.fsPath)).isDirectory();
			} catch {
				refuse(vscode.l10n.t("{0} is not there any more.", plainInLabel(uri.fsPath)));
				continue;
			}
			tab.attachments.push(fileAttachment(uri, folder, directory));
			attached++;
		}
		if (!attached) { return; }
		this._leaveTerminal();
		this._post();
		await this._focusView();
		this._focusInput();
	}

	/**
	 * What the composer offers to attach without being asked: the file in the
	 * text editor in front, and the browser tab the user last had in front as a
	 * shared page. Each is left out while the tab in front already has it
	 * attached, so removing the chip turns it back into a suggestion. Nothing is
	 * offered where the chat refuses to run.
	 */
	private _suggestions(): { readonly chip: AttachmentChip; readonly accept: () => Attachment | undefined | Promise<Attachment | undefined> }[] {
		if (!this._active || this._blocked()) {
			return [];
		}
		const attached = this._active.attachments;
		const out: { chip: AttachmentChip; accept: () => Attachment | undefined | Promise<Attachment | undefined> }[] = [];
		const editor = vscode.window.activeTextEditor;
		const uri = editor?.document.uri;
		// Lines selected in the editor are offered instead of the whole file.
		const selected = editor && editorSelectionKey(editor);
		if (editor && selected) {
			if (!attached.some(a => a.selectionKey === selected)) {
				out.push({
					chip: { id: `suggest:selection:${selected}`, kind: 'selection', label: selectionLabel(editor), iconName: path.basename(editor.document.uri.path) || undefined },
					accept: () => {
						// What is selected now, not what the chip showed.
						const current = vscode.window.activeTextEditor;
						const attachment = current && selectionAttachment(current);
						if (typeof attachment === 'string') {
							refuse(attachment);
							return undefined;
						}
						return attachment;
					},
				});
			}
		} else if (uri?.scheme === 'file' && !attached.some(a => a.file?.fsPath === uri.fsPath)) {
			const folder = this._workdir(this._active);
			out.push({
				chip: { id: `suggest:file:${uri.toString()}`, kind: 'file', label: path.basename(uri.fsPath), iconName: path.basename(uri.fsPath) },
				accept: () => fileAttachment(uri, folder, false),
			});
		}
		// The page only while a browser tab is the editor in front: the active
		// group's active tab, which stays put while focus is in the chat. A
		// browser editor has no `input` in `tabGroups` (the extension host models
		// none for it), the heuristic `browserTabVisible` uses.
		const front = vscode.window.tabGroups.activeTabGroup.activeTab;
		if (isBrowserApiGranted() && front && front.input === undefined) {
			const page = this._browser.focusedTab ?? this._browser.userTab;
			if (page && ![...this._livePages].some(([id, tracked]) => tracked === page && attached.some(a => a.chip.id === id))) {
				const title = plainInPrompt(pageTitle(page.title, page.url));
				out.push({
					chip: { id: `suggest:page:${this._browser.tabIdOf(page)}`, kind: 'sharedPage', label: title || page.url },
					accept: () => this._makeAttachment('sharedPage', page),
				});
			}
		}
		return out;
	}

	/** A snapshot of the non-empty selections in VS Code's active text editor. */
	public async attachEditorSelection(editor: vscode.TextEditor | undefined): Promise<void> {
		const blocked = this._blocked();
		if (blocked) {
			refuse(blocked);
			return;
		}
		if (!editor) { return; }
		const attachment = selectionAttachment(editor);
		if (!attachment) { return; }
		if (typeof attachment === 'string') {
			refuse(attachment);
			return;
		}
		this._active.attachments.push(attachment);
		this._leaveTerminal();
		this._post();
		await this._focusView();
		this._focusInput();
	}

	/* ------------------------------------------------------------ GitHub repositories */

	/** What a tab's GitHub operation is doing, while one runs: one at a time per tab. */
	private readonly _repoBusy = new Map<ChatTab, string>();
	private readonly _emptyAnswers = new Map<string, { readonly at: number; readonly empty: boolean }>();

	/**
	 * Whether `folder` is empty, for the GitHub form's "clone here": asked on
	 * every state post, so answered from a second's cache, and from one entry —
	 * never the whole folder.
	 */
	private _emptyFolder(folder: string): boolean {
		const now = Date.now();
		const cached = this._emptyAnswers.get(folder);
		if (cached && now >= cached.at && now - cached.at < 2_000) {
			return cached.empty;
		}
		let empty = false;
		try {
			const dir = fs.opendirSync(folder);
			try {
				empty = dir.readSync() === null;
			} finally {
				dir.closeSync();
			}
		} catch {
			empty = false;
		}
		this._emptyAnswers.clear();
		this._emptyAnswers.set(folder, { at: now, empty });
		return empty;
	}

	private _recentRepos(): string[] {
		const stored = this._context.globalState.get<unknown>(recentReposKey);
		return Array.isArray(stored) ? stored.filter((r): r is string => typeof r === 'string' && parseRepo(r) !== undefined).slice(0, recentFolderLimit) : [];
	}

	private async _rememberRepo(repo: RepoRef): Promise<void> {
		const slug = repoSlug(repo);
		const next = [slug, ...this._recentRepos().filter(r => r.toLowerCase() !== slug.toLowerCase())].slice(0, recentFolderLimit);
		await this._context.globalState.update(recentReposKey, next).then(undefined, () => { /* a convenience */ });
	}

	private _untrustedFolders(): string[] {
		const stored = this._context.globalState.get<unknown>(untrustedFoldersKey);
		return Array.isArray(stored) ? stored.filter((p): p is string => typeof p === 'string') : [];
	}

	/** A folder fetched from GitHub whose own settings are held back; see `AgentBackend.openSession`. */
	private _untrusted(folder: string): boolean {
		const resolved = path.resolve(folder);
		return this._untrustedFolders().some(p => p === resolved);
	}

	/**
	 * Holds `folder`'s own settings back, and lets go of every Claude session
	 * already working there: whether a session loads them was decided when it
	 * opened, and a clone into the folder a conversation is in (the default for
	 * an empty one) otherwise left that session — and every process it starts
	 * after a model change — loading the repository's hooks.
	 */
	private async _markUntrusted(folder: string): Promise<void> {
		const resolved = path.resolve(folder);
		const next = [resolved, ...this._untrustedFolders().filter(p => p !== resolved)].slice(0, untrustedLimit);
		await this._context.globalState.update(untrustedFoldersKey, next);
		for (const tab of this._tabs) {
			if (path.resolve(tab.cwd) === resolved) {
				tab.restartSession(true);
			}
		}
	}

	/** Which of the project configuration files `folder` has, for the folder button to name; cached like `_emptyFolder`. */
	private _configFiles(folder: string): string[] {
		const now = Date.now();
		const cached = this._configAnswers.get(folder);
		if (cached && now >= cached.at && now - cached.at < 2_000) {
			return cached.files;
		}
		const files = projectConfigFiles.filter(f => {
			try {
				return fs.statSync(path.join(folder, f)).isFile();
			} catch {
				return false;
			}
		});
		this._configAnswers.clear();
		this._configAnswers.set(folder, { at: now, files });
		return files;
	}

	private readonly _configAnswers = new Map<string, { readonly at: number; readonly files: string[] }>();

	/**
	 * The folder button's "Trust this repository's settings": the tab in front's
	 * folder loads its own Claude Code settings from now on, in every tab that
	 * works there — each Claude session started again when it is quiet.
	 */
	private async _trustWorkdir(): Promise<void> {
		const folder = this._workdir();
		if (folder === undefined || this._blocked() || !this._untrusted(folder)) {
			return;
		}
		const resolved = path.resolve(folder);
		await this._context.globalState.update(untrustedFoldersKey, this._untrustedFolders().filter(p => p !== resolved));
		for (const tab of this._tabs) {
			if (path.resolve(tab.cwd) === resolved) {
				tab.restartSession();
			}
		}
		this._post();
	}

	/** Where the repositories' clones and copies live: the extension's own storage, never the project. */
	private _repoStorage(): string {
		return this._context.globalStorageUri.fsPath;
	}

	/**
	 * The folder button's GitHub form: a repository, a branch, and how it is
	 * used (`RepoMode`). The form is answered once what was typed is checked —
	 * and, for a clone, once the folder is picked — and closes then; the clone
	 * itself is reported in the chat, as notices, and in the status bar.
	 */
	private async _openRepo(typedRepo: unknown, typedBranch: unknown, mode: unknown): Promise<void> {
		const answer = (error?: string) => this._postMessage({ type: 'githubAnswer', error });
		const blocked = this._blocked();
		if (blocked) {
			answer(blocked);
			return;
		}
		if (typeof typedRepo !== 'string' || typeof typedBranch !== 'string' || (mode !== 'copy' && mode !== 'clone' && mode !== 'reference')) {
			return;
		}
		const repo = parseRepo(typedRepo);
		if (!repo) {
			answer(vscode.l10n.t("Not a GitHub repository: type owner/name, or paste its address."));
			return;
		}
		const branch = typedBranch.trim() ? validBranch(typedBranch) : undefined;
		if (typedBranch.trim() && !branch) {
			answer(vscode.l10n.t("Not a branch name git takes."));
			return;
		}
		const git = await gitBinary();
		if (!git) {
			answer(vscode.l10n.t("git was not found. Install it — on macOS, the Command Line Tools — and try again."));
			return;
		}
		let tab = (this._chromeCommand?.getStore()?.tab ?? this._active);
		const command = this._chromeCommand?.getStore();
		if (command && (!this._tabs.includes(tab) || tab.chat.id !== command.chatId)) { throw new Error('The destination conversation changed.'); }
		if (this._repoBusy.has(tab)) {
			answer(vscode.l10n.t("This tab is still busy with {0}.", this._repoBusy.get(tab)!));
			return;
		}
		await this._rememberRepo(repo);
		switch (mode as RepoMode) {
			case 'clone': {
				const dest = await this._cloneTarget(repo);
				if (typeof dest !== 'string') {
					answer(dest?.error);
					return;
				}
				answer();
				await this._repoWork(tab, vscode.l10n.t("cloning {0}", repoSlug(repo)), async () => {
					// Marked before anything can start there: the clone's own settings
					// are held back until the user trusts them.
					await this._markUntrusted(dest);
					await cloneInto(git, repo, branch, dest);
					// Into the tab it was asked from, not whichever is in front by now.
					const at = await this._setWorkdir(dest, true, tab);
					at?.push({ kind: 'notice', text: vscode.l10n.t("Cloned {0} into {1}; the agent works there.", repoSlug(repo), dest) });
					this._noteHeldBack(at, dest);
				});
				return;
			}
			case 'copy': {
				// Shown in the tab it will work in from the start: a new one when this
				// conversation has started, since its folder is fixed.
				if (tab.started) {
					const opened = this._addTab(tab.chat.agent);
					if (!opened) {
						answer(vscode.l10n.t("{0} chats are open — close one to open another.", this._tabs.length));
						return;
					}
					tab = opened;
				}
				answer();
				await this._repoWork(tab, vscode.l10n.t("making a copy of {0}", repoSlug(repo)), async () => {
					const workBranch = workBranchName(new Date(), generateUuid());
					const made = await makeCopy(git, this._repoStorage(), repo, branch, workBranch);
					await this._markUntrusted(made.path);
					// Sent from meanwhile, or closed: the copy goes to a tab of its own.
					let target = tab;
					if (!this._tabs.includes(target) || target.started) {
						const opened = this._addTab(target.chat.agent, this._tabs.includes(target) ? target : (this._chromeCommand?.getStore()?.tab ?? this._active));
						if (!opened) {
							throw new Error(vscode.l10n.t("No tab to work in the copy: it is at {0}.", made.path));
						}
						target = opened;
					}
					await this._rememberFolder(made.path);
					target.setFolder(made.path, { repo: repoSlug(repo), base: made.base, branch: workBranch, ownedBranch: workBranch });
					target.push({ kind: 'notice', text: vscode.l10n.t("Working in a separate copy of {0}, on the branch {1} taken from {2}. Your own folders are not touched; the folder button pushes the work and opens a pull request.", repoSlug(repo), workBranch, made.base) });
					this._noteHeldBack(target, made.path);
					this._post();
				});
				return;
			}
			case 'reference': {
				if (tab.busy) {
					answer(vscode.l10n.t("Add a repository to read when the agent has finished: it is given to the agent as it starts."));
					return;
				}
				answer();
				await this._repoWork(tab, vscode.l10n.t("fetching {0}", repoSlug(repo)), async () => {
					const made = await makeReference(git, this._repoStorage(), repo, branch);
					if (!this._tabs.includes(tab)) {
						return;
					}
					// Started working meanwhile: Claude Code is given the folder when
					// the turn has ended (`addReference`), and the user is told.
					if (tab.busy && tab.chat.agent === 'claude') {
						tab.push({ kind: 'notice', text: vscode.l10n.t("{0} is read from the next message on, once this turn has ended.", repoSlug(repo)) });
					}
					tab.addReference({ repo: repoSlug(repo), branch: made.branch, path: made.path });
					tab.attachments.push({
						chip: { id: generateUuid(), kind: 'file', label: vscode.l10n.t("{0} (read only)", repoSlug(repo)) },
						text: `For reference, the GitHub repository ${repoSlug(repo)} (branch ${made.branch}) is checked out at ${made.path}. Read it as you need to; do not change anything there — it is not part of this project.`,
					});
					tab.push({ kind: 'notice', text: vscode.l10n.t("{0} ({1}) is beside the project for the agent to read: {2}", repoSlug(repo), made.branch, made.path) });
					this._post();
				});
				return;
			}
		}
	}

	/**
	 * Where a clone goes: the folder in use when it is empty, else a folder the
	 * user picks — itself when empty, else a new `<name>` inside it.
	 */
	private async _cloneTarget(repo: RepoRef): Promise<string | { error: string } | undefined> {
		const current = this._workdir();
		if (current !== undefined && await isEmptyFolder(current)) {
			return current;
		}
		const picked = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			defaultUri: current ? vscode.Uri.file(path.dirname(current)) : undefined,
			openLabel: vscode.l10n.t("Clone Here"),
			title: vscode.l10n.t("Where to clone {0}: an empty folder, or one to make {1} in", repoSlug(repo), repo.name),
		});
		const uri = picked?.[0];
		if (!uri) {
			return { error: '' };
		}
		if (uri.scheme !== 'file') {
			return { error: vscode.l10n.t("Pick a folder on this machine.") };
		}
		if (await isEmptyFolder(uri.fsPath)) {
			return uri.fsPath;
		}
		const dest = path.join(uri.fsPath, repo.name);
		if (fs.existsSync(dest)) {
			return { error: vscode.l10n.t("{0} is already there — pick an empty folder.", dest) };
		}
		return dest;
	}

	/** Tells the tab that a fetched repository's own settings are held back, when it has any. */
	private _noteHeldBack(tab: ChatTab | undefined, folder: string): void {
		const files = this._configFiles(folder);
		if (tab && files.length) {
			tab.push({ kind: 'notice', text: vscode.l10n.t("This repository has its own Claude Code settings ({0}). They are not loaded — hooks in them are shell commands it would run on your machine. Read them, then trust them from the folder button if you want them.", files.join(', ')) });
		}
	}

	/** A GitHub operation for `tab`: marked busy, shown in the status bar, and its failure said in the tab. */
	private async _repoWork(tab: ChatTab, doing: string, work: () => Promise<void>): Promise<void> {
		this._repoBusy.set(tab, doing);
		this._post();
		try {
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `$(github) ${doing}…` }, work);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			(this._tabs.includes(tab) ? tab : (this._chromeCommand?.getStore()?.tab ?? this._active)).push({ kind: 'error', text: vscode.l10n.t("GitHub: {0} failed — {1}", doing, reason) });
			refuse(vscode.l10n.t("GitHub: {0} failed.", doing));
		} finally {
			this._repoBusy.delete(tab);
			this._post();
		}
	}

	/**
	 * A copy that was removed, in every tab that worked in it: one nothing was
	 * sent from goes back to the window's folder; a started conversation keeps
	 * its folder — it ran there — loses the copy's actions, and is told.
	 */
	private _forgetCopy(folder: string): void {
		for (const tab of this._tabs) {
			if (tab.chat.folder !== folder || !tab.chat.copy) {
				continue;
			}
			const repo = tab.chat.copy.repo;
			if (tab.started) {
				tab.forgetCopy();
				tab.push({ kind: 'notice', text: vscode.l10n.t("The copy of {0} was removed. This conversation worked there and cannot go on; it stays in the history.", repo) });
			} else {
				tab.setFolder(undefined);
			}
		}
		this._post();
	}

	private async _removeRepoFolder(folder: string): Promise<void> {
		if (this._blocked() || !this._recentFolders().includes(folder) || !storedCopyRepo(this._repoStorage(), folder)) { return; }
		const unavailable = () => this._workdir() === folder || this._workspaceFolders().some(w => w.path === folder)
			|| this._tabs.some(t => (this._workdir(t) === folder || t.chat.references?.some(r => r.path === folder))
				&& (t.busy || this._repoBusy.has(t) || this._runs.runningIn(t.chat.id) > 0));
		if (unavailable()) {
			refuse(vscode.l10n.t("Switch to another folder and wait for agents working in the copy to finish before removing it."));
			return;
		}
		const git = await gitBinary();
		if (!git || unavailable()) { return; }
		await this._withGitMutation(folder, () => this._repoWork(this._chromeCommand?.getStore()?.tab ?? this._active, vscode.l10n.t("removing repository copy"), async () => {
			await removeStoredCopy(git, this._repoStorage(), folder);
			this._forgetCopy(folder);
			this._listings.delete(folder);
			await this._forgetRecent(folder);
		}));
	}

	/** The folder button's actions on a separate copy of the tab in front. */
	private async _repoAction(action: unknown): Promise<void> {
		const tab = (this._chromeCommand?.getStore()?.tab ?? this._active);
		const copy = tab.chat.copy;
		const folder = tab.chat.folder;
		const repo = copy && parseRepo(copy.repo);
		if (!copy || !folder || !repo || this._blocked()) {
			return;
		}
		const git = await gitBinary();
		if (!git) {
			refuse(vscode.l10n.t("git was not found."));
			return;
		}
		// Only a copy that is still ours: removed and made again as a plain
		// folder, git would search upwards for a repository — the home
		// directory's, perhaps — and commit there.
		if (action !== 'window' && !await isOurWorktree(this._repoStorage(), repo, folder)) {
			refuse(vscode.l10n.t("This copy of {0} is no longer there.", plainInLabel(copy.repo)));
			this._forgetCopy(folder);
			return;
		}
		// A new chat on a copy works in the same copy, so pushing or removing it
		// waits for every tab in it — and the background skills started there.
		const sharing = [...this._services.views].flatMap(view => view._tabs.filter(t => t.chat.folder === folder));
		const working = sharing.some(t => t.busy || this._repoBusy.has(t) || this._runs.runningIn(t.chat.id) > 0);
		switch (action) {
			case 'changes':
				try {
					await this._openText(`${repo.name} changes`, await copyChanges(git, folder, copy.base));
				} catch (err) {
					refuse(vscode.l10n.t("Could not read the copy's changes: {0}", plainInLabel(err instanceof Error ? err.message : String(err), 120)));
				}
				return;
			case 'window':
				await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceNewWindow: true });
				return;
			case 'push':
				if (working) {
					refuse(vscode.l10n.t("Push when the agent has finished."));
					return;
				}
				await this._withGitMutation(folder, () => this._repoWork(tab, vscode.l10n.t("pushing {0}", copy.branch), async () => {
					const message = capAt(tab.chat.title.replace(/\s+/g, ' ').trim() || 'Changes from the AI Browser chat', 72);
					const pushed = await pushCopy(git, folder, copy.base, message);
					const url = compareUrl(repo, copy.base, pushed);
					tab.push({ kind: 'notice', text: vscode.l10n.t("Pushed {0} to {1}. A pull request into {2}: {3}", pushed, copy.repo, copy.base, url) });
					await vscode.env.openExternal(vscode.Uri.parse(url));
				}));
				return;
			case 'remove':
				if (working) {
					refuse(vscode.l10n.t("Remove the copy when the agents working in it have finished."));
					return;
				}
				await this._withGitMutation(folder, () => this._repoWork(tab, vscode.l10n.t("removing the copy of {0}", copy.repo), async () => {
					await removeCopy(git, this._repoStorage(), repo, folder, copy.ownedBranch ?? copy.branch);
					this._forgetCopy(folder);
				}));
				return;
		}
	}

	/* ------------------------------------------------------------ tabs */

	/** #1 is the side bar; a new panel takes the lowest number no live or saved panel holds. */
	private _freeSurfaceNumber(): number {
		const live = [...this._services.views].filter(view => view !== this && !view._disposed && view._panelIdentity).map(view => view._surfaceNumber);
		return this._services.panels.freeNumber(live);
	}

	private get _panelIdentity(): ChatPanelIdentity | undefined {
		return this._restoredPanel ?? (this._detachedChat ? { id: this._surfaceId, number: this._surfaceNumber } : undefined);
	}

	private get _tabsStorageKey(): string {
		return `${this._legacyTabsStorageKey}.project.${this._projectId}`;
	}

	private get _legacyTabsStorageKey(): string {
		const panel = this._panelIdentity;
		return panel ? `${openTabsKey}.panel.${panel.id}` : openTabsKey;
	}

	/** VS Code restores the editor's placement; we restore only its chat state. */
	private _restorePendingPanels(): void {
		for (const saved of this._services.panels.panels.values()) {
			const pending = new ChatViewProvider(this._context, this._browser, this._browserServer, undefined, undefined, undefined, saved.panel);
			pending._lifetimeOwner = this;
			this._pendingPanels.set(saved.panel.id, pending);
		}
	}

	private _bindPanel(panel: vscode.WebviewPanel, state?: unknown): void {
		const owner = this._lifetimeOwner ?? this;
		this._panel = panel;
		if (this._panelIdentity) { owner._pendingPanels.delete(this._panelIdentity.id); }
		const raw = state && typeof state === 'object' ? (state as { drafts?: unknown }).drafts : undefined;
		if (raw && typeof raw === 'object') {
			for (const tab of this._tabs) {
				const draft = (raw as Record<string, unknown>)[tab.chat.id];
				if (typeof draft === 'string') { this._savedDrafts.set(tab.chat.id, draft); }
			}
		}
		panel.title = this._surfaceLabel();
		owner._windows.add(panel);
		panel.onDidDispose(() => { owner._windows.delete(panel); this.dispose(); });
		this._bindView({ webview: panel.webview, get visible() { return panel.visible; },
			onDidDispose: panel.onDidDispose, onDidChangeVisibility: listener => panel.onDidChangeViewState(() => listener()) });
	}

	private _nativePanelTab(): vscode.Tab | undefined {
		return vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => tab.label === this._surfaceLabel()
			&& tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('aiBrowser.chat.window'));
	}

	/** Reveal a pending editor using public APIs, replacing its unrevived placeholder. */
	private async _materializePanel(): Promise<void> {
		if (this._panel) { return; }
		const old = this._nativePanelTab();
		const panel = vscode.window.createWebviewPanel('aiBrowser.chat.window', this._surfaceLabel(), old?.group.viewColumn ?? vscode.ViewColumn.Active, { retainContextWhenHidden: true });
		this._bindPanel(panel);
		if (old) { await vscode.window.tabGroups.close(old, true); }
	}

	private _closeEmptyPanel(): void {
		if (this._panel) { this._panel.dispose(); return; }
		const old = this._nativePanelTab();
		this.dispose();
		if (old) { void vscode.window.tabGroups.close(old, true); }
	}

	public restoreChatPanel(panel: vscode.WebviewPanel, state: unknown): void {
		const identity = readChatPanelIdentity(state) ?? { id: generateUuid(), number: this._freeSurfaceNumber() };
		const existing = [...this._services.views].find(view => view._panelIdentity?.id === identity.id);
		if (existing?._panel) { if (existing._panel !== panel) { panel.dispose(); } return; }
		const restored = existing ?? this._pendingPanels.get(identity.id)
			?? new ChatViewProvider(this._context, this._browser, this._browserServer, undefined, undefined, undefined, identity);
		restored._lifetimeOwner = this;
		restored._bindPanel(panel, state);
	}

	/** The open tabs as they were when the window closed; at least one, empty if nothing was open. */
	private _restoreTabs(): void {
		const owned = this._context.workspaceState.get<SavedChatTabs>(this._tabsStorageKey);
		const saved = owned ? (!owned.project || owned.project === this._projectId ? owned : undefined)
			: legacyProjectTabs(this._context.workspaceState.get<SavedChatTabs>(this._legacyTabsStorageKey), this._projectId);
		const repos = saved?.repos && typeof saved.repos === 'object' ? saved.repos as Record<string, { copy?: unknown; references?: unknown }> : {};
		const ultracodes = saved?.ultracodes && typeof saved.ultracodes === 'object' ? saved.ultracodes as Record<string, unknown> : {};
		const names = saved?.names && typeof saved.names === 'object' ? saved.names as Record<string, unknown> : {};
		const folders = saved?.folders && typeof saved.folders === 'object' ? saved.folders as Record<string, unknown> : {};
		const strings = (value: unknown) => Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
		const fresh = new Set(strings(saved?.fresh));
		const history = this._history();
		for (const id of strings(saved?.ids)) {
			if (this._findOpenChat(id)) { continue; }
			const stored = history.find(c => c.id === id);
			if (this._tabs.length >= tabLimit()) {
				break;
			}
			if (stored) {
				this._tabs.push(new ChatTab(this._tabHost, reopened(stored)));
			} else if (fresh.has(id)) {
				// A tab nothing was sent from: it has no history to come back from,
				// but it comes back with its chat id, which its draft is kept under.
				const chat = newChat(this._remembered.agent ?? 'claude', id);
				const name = names[id];
				if (typeof name === 'string' && name) {
					chat.title = capAt(name, tabTitleLimit);
					chat.named = true;
				}
				const folder = folders[id];
				if (typeof folder === 'string' && path.isAbsolute(folder)) {
					chat.folder = folder;
					const copy = repos[id]?.copy as StoredChat['copy'] | undefined;
					if (copy && typeof copy.repo === 'string' && typeof copy.base === 'string' && typeof copy.branch === 'string') {
						chat.copy = { repo: copy.repo, base: copy.base, branch: copy.branch, ownedBranch: typeof copy.ownedBranch === 'string' ? copy.ownedBranch : undefined };
					}
				}
				const references = repos[id]?.references;
				if (Array.isArray(references)) {
					chat.references = references.filter((r): r is NonNullable<StoredChat['references']>[number] =>
						!!r && typeof r.repo === 'string' && typeof r.branch === 'string' && typeof r.path === 'string' && path.isAbsolute(r.path));
				}
				this._tabs.push(new ChatTab(this._tabHost, chat));
			}
		}
		for (const tab of this._tabs) {
			const mode = ultracodes[tab.chat.id];
			if (typeof mode === 'boolean') { tab.chat.ultracode = mode; }
		}
		if (!this._tabs.length) {
			this._tabs.push(new ChatTab(this._tabHost, newChat(this._remembered.agent ?? 'claude')));
		}
		this._active = this._tabs.find(t => t.chat.id === saved?.active) ?? this._tabs[0];
	}

	/**
	 * Remembers the open tabs, when they changed. A started chat comes back from
	 * the history; a tab nothing was sent from comes back empty with the same
	 * chat id (`fresh`), so a draft written in it survives a reload.
	 */
	private _saveTabs(): void {
		const identity = this._panelIdentity;
		if (identity) { this._services.panels.remember(identity, Object.fromEntries(this._savedDrafts)); }
		const value = {
			project: this._projectId,
			ids: this._tabs.map(t => t.chat.id),
			ultracodes: Object.fromEntries(this._tabs.map(t => [t.chat.id, t.chat.ultracode])),
			fresh: this._tabs.filter(t => !t.started).map(t => t.chat.id),
			// A tab renamed before anything was sent from it has no history entry to
			// keep its name in.
			names: Object.fromEntries(this._tabs.filter(t => !t.started && t.chat.named).map(t => [t.chat.id, t.chat.title])),
			// And one given a folder: a started chat keeps its folder in the history.
			folders: Object.fromEntries(this._tabs.filter(t => !t.started && t.chat.folder !== undefined).map(t => [t.chat.id, t.chat.folder])),
			// And a separate copy it works in, or repositories it reads, made before anything was sent.
			repos: Object.fromEntries(this._tabs.filter(t => !t.started && (t.chat.copy || t.chat.references?.length))
				.map(t => [t.chat.id, { copy: t.chat.copy, references: t.chat.references }])),
			active: this._active.chat.id,
		};
		const json = JSON.stringify(value);
		if (json === this._tabsSaved) {
			return;
		}
		this._tabsSaved = json;
		this._context.workspaceState.update(this._tabsStorageKey, value).then(undefined, () => { /* a convenience */ });
	}

	/** A new tab beside the one in front, and in front; refused past `tabLimit()`. */
	/** `beside`: the tab it is opened next to and takes its folder from; the one in front unless said. */
	private _addTab(agent: AgentId, beside: ChatTab = this._chromeCommand?.getStore()?.tab ?? this._active): ChatTab | undefined {
		if (this._tabs.length >= tabLimit()) {
			refuse(vscode.l10n.t("{0} chats are open — close one to open another.", this._tabs.length));
			return undefined;
		}
		// In the folder of the tab beside it: a new chat is most often more work
		// on the same project.
		const chat = newChat(agent);
		chat.folder = beside.chat.folder;
		chat.copy = beside.chat.copy;
		chat.references = beside.chat.references;
		const tab = new ChatTab(this._tabHost, chat);
		const at = this._tabs.indexOf(beside);
		this._tabs.splice((at >= 0 ? at : this._tabs.indexOf(this._active)) + 1, 0, tab);
		const command = this._chromeCommand?.getStore();
		if (command) { command.tab = tab; command.chatId = tab.chat.id; } else { this._active = tab; this._switchTo = undefined; this._leaveTerminal(); }
		this._post();
		this._focusInput();
		return tab;
	}

	private _placeTab(id: string, target: string, after: boolean): void {
		const from = this._tabs.find(t => t.id === id);
		const to = this._tabs.find(t => t.id === target);
		if (!from || !to || from === to) { return; }
		this._tabs.splice(this._tabs.indexOf(from), 1);
		this._tabs.splice(this._tabs.indexOf(to) + (after ? 1 : 0), 0, from);
		this._post();
	}

	/** Move the actual tab, including its live session, instead of reopening history. */
	private async _detachTab(id: string, draft: string, location: 'tab' | 'window' = 'tab'): Promise<void> {
		const tab = this._tabs.find(t => t.id === id);
		if (!tab) { return; }
		if (!this._canMoveTab(tab)) { return; }
		let panel: vscode.WebviewPanel | undefined;
		let detached: ChatViewProvider | undefined;
		const chat = tab.chat;
		try {
			const command = 'workbench.action.moveEditorToNewWindow';
			if (location === 'window' && !(await vscode.commands.getCommands(true)).includes(command)) {
				refuse(vscode.l10n.t("This version of VS Code does not support separate chat windows."));
				return;
			}
			if (this._disposed || !this._tabs.includes(tab) || tab.chat !== chat || !this._canMoveTab(tab)) { return; }
			panel = vscode.window.createWebviewPanel('aiBrowser.chat.window', tab.chat.title || 'AI Browser Chat', vscode.ViewColumn.Active, { retainContextWhenHidden: true });
			if (location === 'window') {
				// Move the empty editor first so a failed command leaves the live chat in its source.
				panel.reveal();
				await vscode.commands.executeCommand(command);
				if (this._disposed || !this._tabs.includes(tab) || tab.chat !== chat || !this._canMoveTab(tab)) { panel.dispose(); return; }
			}
			detached = new ChatViewProvider(this._context, this._browser, this._browserServer, undefined, tab.chat,
				{ tab, services: this._services });
			const opened = panel;
			const destination = detached;
			destination._panel = opened;
			const owner = this._lifetimeOwner ?? this;
			destination._lifetimeOwner = owner;
			owner._windows.add(opened);
			opened.onDidDispose(() => {
				owner._windows.delete(opened); destination.dispose();
			});
			destination._bindView({ webview: opened.webview, get visible() { return opened.visible; },
				onDidDispose: opened.onDidDispose, onDidChangeVisibility: listener => opened.onDidChangeViewState(() => listener()) });
			if (!this._moveTabInto(tab, destination, draft)) { detached._tabs = []; opened.dispose(); }
		} catch (error) {
			// A failed setup must not close a tab still owned by the source.
			if (detached && this._tabs.includes(tab)) { detached._tabs = []; }
			panel?.dispose();
			detached?.dispose();
			this._fail(error);
		}
	}

	/** A live terminal (process, screen, pins and website sharing kept) into another surface of this window. */
	private _moveTerminalInto(id: string, destination: ChatViewProvider): boolean {
		if (destination === this || destination._disposed || !destination._view || !this._terminals.find(id)) { return false; }
		if (destination._terminals.atLimit) {
			refuse(vscode.l10n.t("{0} terminals are open — close one to open another.", destination._terminals.size)); return false;
		}
		const terminal = this._terminals.release(id);
		if (!terminal) { return false; }
		destination._terminals.adopt(terminal);
		const closeSource = closesEmptyPanel(this._tabs.length, this._terminals.size, !!this._panelIdentity);
		destination._post();
		destination._scheduleTerminalSave();
		if (closeSource) { this._closeEmptyPanel(); } else { this._post(); this._scheduleTerminalSave(); }
		ChatViewProvider._postAll();
		return true;
	}

	/** A new chat tab or window that holds this terminal (and a fresh conversation beside it). */
	private async _detachTerminal(id: string, location: 'tab' | 'window'): Promise<void> {
		const terminal = this._terminals.find(id);
		if (!terminal) { return; }
		let panel: vscode.WebviewPanel | undefined;
		let detached: ChatViewProvider | undefined;
		try {
			const command = 'workbench.action.moveEditorToNewWindow';
			if (location === 'window' && !(await vscode.commands.getCommands(true)).includes(command)) {
				refuse(vscode.l10n.t("This version of VS Code does not support separate chat windows."));
				return;
			}
			if (this._disposed || !this._terminals.find(id)) { return; }
			panel = vscode.window.createWebviewPanel('aiBrowser.chat.window', terminal.name, vscode.ViewColumn.Active, { retainContextWhenHidden: true });
			if (location === 'window') {
				panel.reveal();
				await vscode.commands.executeCommand(command);
				if (this._disposed || !this._terminals.find(id)) { panel.dispose(); return; }
			}
			const chat = newChat(this._remembered.agent ?? 'claude');
			const folder = this._active.chat.folder;
			if (folder) { chat.folder = folder; }
			detached = new ChatViewProvider(this._context, this._browser, this._browserServer, undefined, chat, { services: this._services });
			const opened = panel;
			const destination = detached;
			destination._panel = opened;
			const owner = this._lifetimeOwner ?? this;
			destination._lifetimeOwner = owner;
			owner._windows.add(opened);
			opened.onDidDispose(() => { owner._windows.delete(opened); destination.dispose(); });
			destination._bindView({ webview: opened.webview, get visible() { return opened.visible; },
				onDidDispose: opened.onDidDispose, onDidChangeVisibility: listener => opened.onDidChangeViewState(() => listener()) });
			const taken = this._terminals.release(id);
			if (!taken) { opened.dispose(); return; }
			destination._terminals.adopt(taken);
			destination._post();
			destination._scheduleTerminalSave();
			if (closesEmptyPanel(this._tabs.length, this._terminals.size, !!this._panelIdentity)) { this._closeEmptyPanel(); }
			else { this._post(); this._scheduleTerminalSave(); }
			ChatViewProvider._postAll();
		} catch (error) {
			panel?.dispose();
			detached?.dispose();
			this._fail(error);
		}
	}

	private _canMoveTab(tab: ChatTab): boolean {
		// A launch still awaiting detection or a queue drain must settle in its source.
		if (this._registry.detecting || (this._draining.has(tab) && this._draining.get(tab) === undefined)
			|| [...this._chatSkillTabs.values()].some(runs => runs.some(run => run.tab === tab && run.sending))) {
			refuse(vscode.l10n.t("Wait for the pending message to start before moving this chat."));
			return false;
		}
		// A Git mutation or recording still belongs to this surface until it ends.
		if (this._repoBusy.has(tab) || [...this._gitCommits.values()].some(job => job.tab === tab && (job.state.phase === 'generating' || job.state.phase === 'committing')) || this._voice?.tab === tab) {
			refuse(vscode.l10n.t("Finish the current Git operation or recording before moving this chat."));
			return false;
		}
		return true;
	}

	private _acceptTabDrop(sourceId: string, id: string, token: string): void {
		const source = ChatViewProvider._surfaces.get(sourceId);
		const drag = source?._tabDrag;
		if (!source || !drag || source._dragToken !== token || drag.id !== id || Date.now() - drag.at > 120_000) { return; }
		const tab = source._tabs.find(t => t.id === id && t.chat.id === drag.chatId);
		if (tab && source._moveTabInto(tab, this, drag.draft)) { source._tabDrag = undefined; }
	}

	private _moveTabInto(tab: ChatTab, destination: ChatViewProvider, draft: string): boolean {
		if (destination === this || destination._disposed || !destination._view || !this._tabs.includes(tab) || !this._canMoveTab(tab)) { return false; }
		const attached = destination._tabs.includes(tab);
		if (!attached && destination._tabs.length >= tabLimit()) {
			refuse(vscode.l10n.t("The destination chat has reached its tab limit.")); return false;
		}
		if (!attached && destination._tabs.some(t => t.chat.id === tab.chat.id)) {
			refuse(vscode.l10n.t("This conversation is already open in the destination chat.")); return false;
		}
		if (destination._services !== this._services) { return false; }
		if (!attached) { destination._tabs.splice(destination._tabs.indexOf(destination._active) + 1, 0, tab); }
		// Transfer only after the destination exists. Do not call close or _removeTab:
		// those stop the session, discard annotations and cancel outstanding work.
		tab.moveTo(destination._tabHost);
		clearTimeout(this._draining.get(tab));
		this._draining.delete(tab);
		for (const [skill, runs] of this._chatSkillTabs) {
			const moved = runs.filter(run => run.tab === tab);
			if (moved.length) { destination._chatSkillTabs.set(skill, [...destination._chatSkillTabs.get(skill) ?? [], ...moved]); }
			const remaining = runs.filter(run => run.tab !== tab);
			if (remaining.length) { this._chatSkillTabs.set(skill, remaining); } else { this._chatSkillTabs.delete(skill); }
		}
		for (const [annotation, link] of this._annotationLinks) {
			if (link.chat === tab) { destination._annotationLinks.set(annotation, link); this._annotationLinks.delete(annotation); }
		}
		for (const attachment of tab.attachments) {
			const page = this._livePages.get(attachment.chip.id);
			if (page) { destination._livePages.set(attachment.chip.id, page); this._livePages.delete(attachment.chip.id); }
		}
		if (destination._livePages.size) { destination._watchLivePages(); }
		const at = this._tabs.indexOf(tab);
		this._tabs.splice(at, 1);
		// A panel that still owns terminals is not empty: closing it would end their shells, which nobody asked for.
		const closeSource = closesEmptyPanel(this._tabs.length, this._terminals.size, !!this._panelIdentity);
		if (!this._tabs.length && !closeSource) { this._tabs.push(new ChatTab(this._tabHost, newChat(this._remembered.agent ?? 'claude'))); }
		if (!closeSource && this._active === tab) { this._active = this._tabs[Math.min(at, this._tabs.length - 1)]; this._switchTo = undefined; }
		this._savedDrafts.delete(tab.chat.id);
		destination._savedDrafts.set(tab.chat.id, draft);
		destination._active = tab;
		destination._switchTo = undefined;
		destination._leaveTerminal();
		// Send the selected chat before its draft, including to an already-ready view.
		destination._postMessage({ type: 'state', state: destination._state() });
		destination._postMessage({ type: 'setTabDraft', chatId: tab.chat.id, text: draft });
		destination._drainQueues();
		destination._post();
		destination._saveTabs();
		// Commit the transfer before disposing the empty source: disposal must never
		// close the moved tab or its shared backend. VS Code closes an empty auxiliary window.
		if (closeSource) { this._closeEmptyPanel(); }
		else { this._post(); this._saveTabs(); }
		return true;
	}

	private _selectTab(id: string): void {
		const tab = this._tabs.find(t => t.id === id);
		if (!tab) { return; }
		// A conversation selected while a terminal shows takes the front back, even
		// the one that was `_active` all along. A remote surface's pin is not the editor's view.
		const fromTerminal = !this._chromeCommand?.getStore() && this._leaveTerminal();
		if (tab === this._active && !fromTerminal) {
			return;
		}
		this._active = tab;
		this._switchTo = undefined;
		this._post();
		this._focusInput();
	}

	/** Closing a tab stops what it runs — its turn and its agents — and keeps the chat in the history. */
	private _closeTab(id: string): void {
		const tab = this._tabs.find(t => t.id === id);
		if (!tab) {
			return;
		}
		tab.close();
		this._removeTab(tab);
	}

	private _removeTab(tab: ChatTab): void {
		this._browser.releaseChatTabs(tab.chat.id);
		this._dropAnnotationsOf(tab);
		// A closed conversation's terminals are not its any more; they stay open, unowned.
		if (ChatViewProvider._pins.dropTab(tab.id).length) { ChatViewProvider._postAll(); }
		for (const [folder, job] of this._gitCommits) {
			if (job.tab === tab) { job.controller.abort(); this._gitCommits.delete(folder); }
		}
		this._branchNameRequests.get(tab)?.abort();
        this._branchNameRequests.delete(tab);
		this._titleRequests.get(tab)?.abort();
		this._titleRequests.delete(tab);
		const at = this._tabs.indexOf(tab);
		if (at < 0) {
			return;
		}
		this._tabs.splice(at, 1);
		if (!this._tabs.length) {
			this._tabs.push(new ChatTab(this._tabHost, newChat(this._remembered.agent ?? 'claude')));
		}
		if (this._active === tab) {
			this._active = this._tabs[Math.min(at, this._tabs.length - 1)];
			this._switchTo = undefined;
		}
		this._post();
	}

	private _rememberAgent(agent: AgentId): void {
		this._remembered = { ...this._remembered, agent,
			ultracode: this._context.globalState.get<RememberedSelection>(selectionKey)?.ultracode ?? this._remembered.ultracode };
		this._context.globalState.update(selectionKey, this._remembered).then(undefined, () => { /* best effort */ });
	}

	/**
	 * The answer to "another agent for a conversation that has started":
	 *
	 * - `newTab` — a new tab with the other agent; this one goes on working.
	 * - `replace` — this one closes, its turn and its agents stopped, and the
	 *   other agent takes its place.
	 * - `continue` — this conversation is written out as Markdown and handed to
	 *   the other agent in a new tab, attached to its first message; this tab
	 *   stays open.
	 * - `cancel` — nothing changes, and the pill shows this tab's agent again.
	 */
	private async _switchAgent(choice: 'newTab' | 'replace' | 'continue' | 'cancel'): Promise<void> {
		const to = this._switchTo;
		this._switchTo = undefined;
		const from = this._active;
		if (!to || choice === 'cancel' || !from.started) {
			this._post();
			return;
		}
		this._rememberAgent(to);
		switch (choice) {
			case 'newTab':
				this._addTab(to);
				return;
			case 'replace': {
				// The same tab, another conversation: its draft goes with it, and so
				// does a name the user gave the tab — and the queue, back into that
				// draft rather than on to the other agent.
				this._giveBackQueue(from);
				const next = newChat(to);
				next.folder = from.chat.folder;
				next.copy = from.chat.copy;
				next.references = from.chat.references;
				if (from.chat.named) {
					next.title = from.chat.title;
					next.named = true;
				}
				from.start(next, true);
				this._focusInput();
				return;
			}
			case 'continue': {
				if (this._tabs.length >= tabLimit()) {
					refuse(vscode.l10n.t("{0} chats are open — close one to open another.", this._tabs.length));
					this._post();
					return;
				}
				const chat = from.chat;
				const now = new Date();
				const markdown = chatTranscript(chat.title, agentNames[chat.agent], chat.entries, now);
				let file: string | undefined;
				try {
					file = await writeChatTranscript(markdown, transcriptFileName(chat.title, now), chat.folder);
				} catch (err) {
					from.push({ kind: 'error', text: vscode.l10n.t("Could not write the conversation out for {0}: {1}", agentNames[to], err instanceof Error ? err.message : String(err)) });
					return;
				}
				const tab = this._addTab(to);
				if (!tab) {
					return;
				}
				const attachment: Attachment = {
					chip: { id: generateUuid(), kind: 'file', label: vscode.l10n.t("Conversation with {0}", agentNames[chat.agent]) },
					file: file ? vscode.Uri.file(file) : undefined,
					text: file
						? `The user is moving a conversation they had with ${agentNames[chat.agent]} over to you. It is in ${file}: read it first, then carry on from where it left off.`
						// No folder to put a file in: the conversation itself, capped.
						: `The user is moving a conversation they had with ${agentNames[chat.agent]} over to you; it follows. Carry on from where it left off.\n\n${markdown.length > transcriptInlineLimit ? `${markdown.slice(-transcriptInlineLimit)}\n\n(Earlier parts left out.)` : markdown}`,
				};
				tab.attachments.push(attachment);
				this._post();
				return;
			}
		}
	}

	/**
	 * "Ask another agent" under a reply: the prompt that reply answers goes, as
	 * the first message of a new tab, to the agent and model picked — asked for,
	 * one at a time; a second opinion more is another press. The conversation
	 * before the prompt goes with it (`secondOpinionText`), the way "Continue
	 * in …" hands one over; the first agent's answer does not. The new tab sits
	 * beside the one it came from and works in its folder.
	 */
	private async _secondOpinion(chatId: string, index: number, agent: AgentId, model: string): Promise<void> {
		if (this._blocked() || !isAgentId(agent) || typeof model !== 'string' || !Number.isInteger(index)) {
			return;
		}
		const from = this._tabs.find(t => t.chat.id === chatId);
		const entries = from?.chat.entries;
		if (!from || entries?.[index]?.kind !== 'assistant') {
			return;
		}
		let at = index;
		while (at >= 0 && entries[at].kind !== 'user') {
			at--;
		}
		const prompt = entries[at];
		if (prompt?.kind !== 'user') {
			refuse(vscode.l10n.t("No question was found above this reply."));
			return;
		}
		const target = this._registry.agents.find(a => a.id === agent && a.available);
		if (!target?.models.some(m => m.id === model)) {
			refuse(vscode.l10n.t("{0} is not available with that model.", agentNames[agent]));
			return;
		}
		if (this._tabs.length >= tabLimit()) {
			refuse(vscode.l10n.t("{0} chats are open — close one to open another.", this._tabs.length));
			return;
		}
		const chat = from.chat;
		const before = entries.slice(0, at);
		let context: OpinionContext;
		if (before.some(e => e.kind === 'user')) {
			const now = new Date();
			const markdown = chatTranscript(chat.title, agentNames[chat.agent], before, now);
			try {
				const file = await writeChatTranscript(markdown, transcriptFileName(chat.title, now), chat.folder);
				// No folder to put a file in: the conversation itself, its newest part.
				context = file ? { file } : { text: markdown.length > transcriptInlineLimit ? `${markdown.slice(-transcriptInlineLimit)}\n\n(Earlier parts left out.)` : markdown };
			} catch (err) {
				refuse(vscode.l10n.t("Could not write the conversation out for {0}: {1}", agentNames[agent], err instanceof Error ? err.message : String(err)));
				return;
			}
		}
		// The write is awaited: the tab may have closed or moved on meanwhile.
		if (!this._tabs.includes(from) || from.chat !== chat) {
			return;
		}
		const tab = this._addTab(agent, from);
		if (!tab) {
			return;
		}
		// What a fresh tab sends with is the remembered agent and its model, as
		// when they are picked with the pills; the new tab has not started, so
		// this is no switch of agent for a conversation.
		this._select({ agent, model });
		tab.rename(`${agentNames[agent]}: ${chat.title}`.slice(0, 80));
		const attachment: Attachment = {
			chip: { id: generateUuid(), kind: 'file', label: vscode.l10n.t("Second opinion on a question to {0}", agentNames[chat.agent]) },
			file: context && 'file' in context ? vscode.Uri.file(context.file) : undefined,
			text: secondOpinionText(agentNames[chat.agent], prompt.attachments, context),
		};
		await this._send(prompt.text, tab.id, [attachment]);
	}

	/** The title-bar command asks for a location; the tab-strip plus opens here directly. */
	public async newChat(location?: 'here' | 'tab' | 'window'): Promise<void> {
		if (location === undefined) {
			this._postMessage({ type: 'chooseNewChatLocation' });
			return;
		}
		const agent = this._remembered.agent ?? this._selection().agent ?? 'claude';
		if (location === 'here') {
			// Reuse a conversation with no sent messages instead of accumulating empty tabs.
			const empty = this._tabs.find(tab => !tab.started);
			if (empty) {
				this._selectTab(empty.id);
				this._postMessage({ type: 'flashTab', id: empty.id });
				this._focusInput();
			} else {
				this._addTab(agent);
			}
			return;
		}
		if ((location !== 'window' && location !== 'tab') || ChatViewProvider._openingWindow) { return; }
		ChatViewProvider._openingWindow = true;
		let panel: vscode.WebviewPanel | undefined;
		try {
			const command = 'workbench.action.moveEditorToNewWindow';
			if (location === 'window' && !(await vscode.commands.getCommands(true)).includes(command)) {
				refuse(vscode.l10n.t("This version of VS Code does not support separate chat windows."));
				return;
			}
			const chat = newChat(agent);
			chat.folder = this._active.chat.folder;
			chat.copy = this._active.chat.copy;
			chat.references = this._active.chat.references;
			const detached = new ChatViewProvider(this._context, this._browser, this._browserServer, undefined, chat);
			try {
				panel = vscode.window.createWebviewPanel('aiBrowser.chat.window', 'AI Browser Chat', vscode.ViewColumn.Active, { retainContextWhenHidden: true });
			} catch (error) { detached.dispose(); throw error; }
			const opened = panel;
			detached._panel = opened;
			const owner = this._lifetimeOwner ?? this;
			detached._lifetimeOwner = owner;
			owner._windows.add(opened);
			opened.onDidDispose(() => { owner._windows.delete(opened); detached.dispose(); });
			detached._bindView({
				webview: opened.webview,
				get visible() { return opened.visible; },
				onDidDispose: opened.onDidDispose,
				onDidChangeVisibility: listener => opened.onDidChangeViewState(() => listener()),
			});
			opened.reveal();
			if (location === 'window') { await vscode.commands.executeCommand(command); }
		} catch (error) {
			panel?.dispose();
			this._fail(error);
		} finally { ChatViewProvider._openingWindow = false; }
	}

	private _agentBinaries(): Partial<Record<AgentId, string>> {
		const stored = this._context.workspaceState.get<Record<string, unknown>>(agentBinariesKey) ?? {};
		const pick = (id: AgentId) => typeof stored[id] === 'string' ? stored[id] as string : undefined;
		return { claude: pick('claude'), codex: pick('codex'), gemini: pick('gemini'), opencode: pick('opencode'), pi: pick('pi'), openrouter: pick('openrouter') };
	}

	/**
	 * A copy picked in the agent settings, or Auto. It takes effect through
	 * detection, which replaces the backend when the copy changes — a turn
	 * running on the old one ends, and each tab's conversation resumes on the
	 * new copy at its next message, by its `ref`, as after a Refresh.
	 */
	private async _setAgentBinary(agent: AgentId, file: string | undefined): Promise<void> {
		if (!isAgentId(agent)) {
			return;
		}
		// Only one of the copies detection found: the view names a path, it does not get to invent one.
		const copy = file === undefined ? undefined : this._registry.agents.find(a => a.id === agent)?.copies?.find(c => c.path === file);
		if (file !== undefined && !copy) {
			return;
		}
		try {
			await this._context.workspaceState.update(agentBinariesKey, { ...this._agentBinaries(), [agent]: copy?.bundled ? bundledPin : file });
		} catch {
			return;
		}
		if (!this._blocked()) {
			// This agent only, after any detection already running (which read the
			// old choice); `redetect` waits for it.
			await this._registry.redetect(agent);
		}
	}

	public refreshAgents(): void {
		if (!this._blocked()) {
			void this._registry.detect();
		}
	}

	/**
	 * A Refresh found another copy of an agent and replaced its backend, which
	 * disposed every session it held. Every tab on that agent lets go of its
	 * session and resumes its conversation on the new backend at its next message.
	 */
	private _onBackendReplaced(agent: AgentId, gone: boolean): void {
		for (const tab of this._tabs) {
			const title = this._titleRequests.get(tab);
			if (title && this._featureRequestAgents.get(title) === agent) { title.abort(); }
			const branch = this._branchNameRequests.get(tab);
			if (branch && this._featureRequestAgents.get(branch) === agent) {
				branch.abort();
				const id = this._branchNameRequestIds.get(branch);
				if (id !== undefined) { this._postMessage({ type: 'gitBranchNameResult', id, error: 'The selected agent was refreshed. Please try again.' }); }
			}
			tab.backendReplaced(agent, gone);
		}
		for (const job of this._gitCommits.values()) { if (job.agent === agent) { job.controller.abort(); } }
		this._runs.backendReplaced(agent, gone);
	}

	/** Where the agents work by default: the window's first local folder, else the home directory. */
	private _windowCwd(): string {
		const folder = vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file');
		return folder?.uri.fsPath ?? os.homedir();
	}

	/**
	 * Where the tab in front works: the folder its conversation picked, else the
	 * window's. Detection and the skills listing run here too, so the "/"
	 * palette lists the skills of the project in front.
	 */
	private _cwd(): string {
		// `_active` is set by `_restoreTabs`, after the registry that asks this is made.
		const folder = ((this._chromeCommand?.getStore()?.tab ?? this._active) as ChatTab | undefined)?.cwd;
		// Not a folder that is gone — a chat from the history, a removed copy:
		// detection, the skills listing and Codex's one app-server start here,
		// and a process spawned in a missing folder fails as "spawn … ENOENT",
		// which reads as the agent not being installed, for every tab.
		return folder !== undefined && isDirectory(folder) ? folder : this._windowCwd();
	}

	/* ------------------------------------------------------------ terminal_* MCP tools */

	/**
	 * The `terminal_*` tools' side of the chat (`terminalTools.ts`).
	 */
	private static _terminalApi(): TerminalAgentApi {
		// The terminals pinned to a conversation, as its agent drives them (`terminalTools.ts`). Every call
		// names the caller's chat, resolves it to its tab and only ever touches a terminal pinned to that tab:
		// a terminal that does not exist and one pinned elsewhere are answered alike, so the tools are no way
		// to learn which exist. Grants are not looked at here: the tool consumed one before it called.
		const notPinned = 'That terminal is not attached to this conversation. Call terminal_list for the ones that are.';
		const pinnedTo = (chatId: string, terminalId: string): TerminalTab => {
			const own = ChatViewProvider._tabOfChat(chatId);
			if (!own) { throw new TerminalRefusal('The conversation this call came from is no longer open in a tab.'); }
			const terminal = ChatViewProvider._pins.has(own.tab.id, terminalId) ? ChatViewProvider._terminalAcross(terminalId)?.terminal : undefined;
			if (!terminal) { throw new TerminalRefusal(notPinned); }
			return terminal;
		};
		// A watch-only pin: reads are allowed, input never — refused before anything reaches the shell.
		const writable = (chatId: string, terminalId: string): TerminalTab => {
			const terminal = pinnedTo(chatId, terminalId);
			if (ChatViewProvider._pins.mode(terminalId) === 'watch') { throw new TerminalRefusal(watchRefusal); }
			return terminal;
		};
		return {
			list: chatId => {
				const own = ChatViewProvider._tabOfChat(chatId);
				return own ? ChatViewProvider._pinnedInfos(own.tab) : [];
			},
			read: async (chatId, terminalId, o) => {
				const t = pinnedTo(chatId, terminalId);
				const read = await t.readScreen(o);
				const ago = t.userTypedMsAgo();
				return ago !== undefined ? { ...read, userTypedMsAgo: ago } : read;
			},
			wait: async (chatId, terminalId, o, signal) => pinnedTo(chatId, terminalId).waitFor({ ...o, signal }),
			send: async (chatId, terminalId, o) => {
				const t = writable(chatId, terminalId);
				// The tool validated it already; what is typed is what the card showed, so it is checked where it takes effect too.
				const problem = typedTextProblem(o.text);
				if (problem) { throw new TerminalRefusal(problem); }
				const result = t.agentInput(o.enter ? `${o.text}\r` : o.text);
				if (!result.ok) { throw new TerminalRefusal(result.message, result.reason === 'user-typing'); }
				return { sent: true, ...(result.userTypedMsAgo !== undefined ? { userTypedMsAgo: result.userTypedMsAgo } : {}) };
			},
			key: async (chatId, terminalId, o) => {
				const t = writable(chatId, terminalId);
				const plan = planKeys(o.keys);
				if (!plan.ok) { throw new TerminalRefusal(plan.error); }
				const result = t.agentInput(plan.bytes);
				if (!result.ok) { throw new TerminalRefusal(result.message, result.reason === 'user-typing'); }
				return { sent: true };
			},
		};
	}

	/* ------------------------------------------------------------ chat_* MCP tools */

	/**
	 * The chat as the `chat_*` MCP tools see it — every surface of this extension
	 * host, since a conversation can be in the side bar or in any chat panel.
	 * See `src/mcp/chatTools.ts` for who may call what. No chat id is ever put in
	 * an answer: it is what entitles a caller to act.
	 */
	public static mcpControl(): ChatControl {
		const lastMessageChars = 600;
		const agentRowLimit = 30;
		const surfaces = () => [...ChatViewProvider._surfaces.values()].filter(s => !s._disposed);
		const find = (tabId: string): { surface: ChatViewProvider; tab: ChatTab } => {
			for (const surface of surfaces()) {
				const tab = surface._tabs.find(t => t.id === tabId);
				if (tab) {
					return { surface, tab };
				}
			}
			throw new Error('The conversation this call came from is no longer open in a tab.');
		};
		const iso = (at: number | undefined) => at === undefined ? undefined : new Date(at).toISOString();
		const sleepOf = (surface: ChatViewProvider) => {
			const s = surface._sleep.state;
			return {
				mode: s.mode,
				active: s.active,
				...(s.mode === 'timer' ? { until: iso(s.until) } : {}),
				...(s.mode === 'agents' ? { scope: s.scope ?? 'window' } : {}),
				...(s.automatic ? { automatic: true, automaticActive: s.automaticActive === true } : {}),
				...(s.error ? { error: s.error } : {}),
			};
		};
		/** The surface's own choice, and whether any surface holds the computer awake. */
		const keepAwakeOf = (surface: ChatViewProvider) => {
			const others = surfaces().filter(s => s !== surface && s._sleep.state.mode !== 'off')
				.map(s => ({ surface: s._surfaceLabel(), ...sleepOf(s) }));
			return { ...sleepOf(surface), ...(others.length ? { alsoHeldBy: others } : {}) };
		};
		const agentRow = (row: ToolEntry) => {
			const info = row.agent;
			const now = Date.now();
			return {
				id: row.id,
				name: row.name,
				status: row.status,
				origin: info?.origin === 'toolbar' ? 'toolbar skill' : 'agent',
				...(info?.type ? { type: info.type } : {}),
				...(info?.model ? { model: info.model } : {}),
				...(info?.background ? { background: true } : {}),
				...(info?.parentId ? { parentId: info.parentId } : {}),
				startedAt: iso(row.startedAt),
				...(row.endedAt ? { endedAt: iso(row.endedAt) } : {}),
				seconds: Math.round(((row.endedAt ?? now) - row.startedAt) / 1000),
				...(info?.tokens !== undefined ? { tokens: info.tokens } : {}),
				...(info?.toolUses !== undefined ? { toolUses: info.toolUses } : {}),
				...(row.status === 'running' && info?.lastTool ? { onTool: info.lastTool } : {}),
				...(info?.waiting ? { waitingForUser: info.waiting.title } : {}),
				// Only the last thing it said, short (asked for): a list of agents
				// is a status, and whole reports pushed a busy chat past what a
				// client takes from one tool (25 000 tokens for Claude Code).
				...(info?.summary ? { lastMessage: lastMessage(info.summary) } : {}),
			};
		};
		const lastMessage = (text: string) => {
			const paragraphs = text.trim().split(/\n\s*\n/);
			return capAt(paragraphs[paragraphs.length - 1].trim(), lastMessageChars);
		};
		const lastReply = (tab: ChatTab) => {
			for (let i = tab.chat.entries.length - 1; i >= 0; i--) {
				const entry = tab.chat.entries[i];
				if (entry.kind === 'assistant' && entry.text.trim()) {
					return lastMessage(entry.text);
				}
			}
			return undefined;
		};
		/** Newest first, so a cut keeps what is happening now. */
		const listed = (rows: ToolEntry[]) => rows.slice(-agentRowLimit).reverse().map(agentRow);
		const rowsOf = (surface: ChatViewProvider, tab: ChatTab): ToolEntry[] => [
			...tab.chat.entries.filter((e): e is ToolEntry => e.kind === 'tool' && e.tool === 'agent'),
			...surface._runs.rows(tab.chat.id),
		].sort((a, b) => a.startedAt - b.startedAt);
		const queueOf = (tab: ChatTab) => ({
			queued: tab.queuedCount,
			...(tab.paused ? { paused: { by: tab.paused.by, since: iso(tab.paused.at) } } : {}),
		});
		const terminal = ChatViewProvider._terminalApi();
		return {
			terminal,
			grants: ChatViewProvider.terminalGrants,
			// The Terminal row of the approval menu on Deny switches every terminal tool off, whatever a CLI's own rules allowed.
			terminalDenied: chatId => (ChatViewProvider._tabOfChat(chatId)?.surface ?? surfaces()[0])?._approvalPolicy().command === 'deny',
			tabOf: chatId => {
				for (const surface of surfaces()) {
					const tab = surface._tabs.find(t => t.chat.id === chatId);
					if (tab) {
						return tab.id;
					}
				}
				return undefined;
			},
			// Every tab by its state alone; the conversation — title, last
			// reply — only for the caller's own.
			state: ownTab => {
				const all = surfaces();
				const own = ownTab ? all.find(s => s._tabs.some(t => t.id === ownTab)) : undefined;
				const sidebar = own ?? all.find(s => !s._panelIdentity) ?? all[0];
				return {
					tabs: all.flatMap(surface => surface._tabs.map(tab => ({
						...(tab.id === ownTab ? { own: true, title: tab.title ?? 'New chat', ...(lastReply(tab) ? { lastMessage: lastReply(tab) } : {}) } : {}),
						surface: surface._surfaceLabel(),
						inFront: surface._active === tab,
						...(tab.started ? { agent: tab.chat.agent } : {}),
						status: tab.status ?? 'new',
						running: tab.running,
						agentsRunning: tab.agentsRunning,
						backgroundSkills: surface._runs.runningIn(tab.chat.id),
						...queueOf(tab),
					}))),
					...(sidebar ? { keepAwake: keepAwakeOf(sidebar) } : {}),
					...(ownTab ? {} : { note: all.length ? 'This caller is not one of the chat\'s own agents: it sees no conversation and cannot act.' : 'The chat has no open tabs in this window.' }),
				};
			},
			agents: ownTab => {
				const { surface, tab } = find(ownTab);
				const rows = rowsOf(surface, tab);
				return { agents: listed(rows), ...(rows.length > agentRowLimit ? { note: `The newest ${agentRowLimit} of ${rows.length}.` } : {}) };
			},
			usage: ownTab => {
				const all = surfaces();
				const own = ownTab ? find(ownTab) : undefined;
				const ordered = own ? [own.surface, ...all.filter(s => s !== own.surface)] : all;
				const registry = ordered[0]?._registry;
				const now = Date.now();
				const agents = (registry?.agents ?? []).filter(a => a.available).map(a => {
					const known = ordered.map(s => currentLimits(s._limits.get(a.id), now)).find(l => l !== undefined);
					return {
						agent: a.id,
						...(known ? {
							limits: known.windows.map(w => ({ label: w.label, usedPercent: w.usedPercent, ...(w.resetsAt ? { resetsAt: iso(w.resetsAt) } : {}) })),
							usingCredits: known.usingCredits,
						} : { limits: [], note: 'Not reported yet: the CLI reports its limits during a turn.' }),
					};
				});
				const stats = own?.tab.started ? own.tab.chat.stats : undefined;
				return {
					agents,
					...(stats?.contextTokens !== undefined ? { context: {
						agent: own!.tab.chat.agent,
						usedTokens: stats.contextTokens,
						...(stats.contextWindow ? { windowTokens: stats.contextWindow, usedPercent: Math.round(stats.contextTokens / stats.contextWindow * 100) } : {}),
						...(stats.contextCompacted ? { compacted: true } : {}),
					} } : {}),
				};
			},
			keepAwake: (ownTab, request) => {
				// The surface holding the caller's tab: a hold on that tab is
				// judged against the tabs of the surface it belongs to.
				const surface = find(ownTab).surface;
				if (request.mode === 'off') {
					// Off is off for the window: a hold another surface carries
					// would otherwise go on under an answer saying it ended.
					for (const each of surfaces()) {
						each._sleep.choose({ mode: 'off' });
					}
					return { keepAwake: keepAwakeOf(surface) };
				}
				let choice: SleepChoice;
				if (request.mode === 'timer') {
					const offered = [...sleepMinutes, ...sleepHours.map(h => h * 60)].sort((a, b) => a - b);
					const minutes = offered.find(m => m >= request.minutes);
					if (minutes === undefined) {
						throw new Error(`At most ${offered[offered.length - 1] / 60} hours can be asked for.`);
					}
					choice = { mode: 'timer', minutes };
				} else {
					choice = request.scope === 'tab' ? { mode: 'agents', scope: 'tab', tabId: ownTab } : { mode: 'agents', scope: 'window' };
				}
				surface._sleep.choose(choice);
				return { keepAwake: keepAwakeOf(surface) };
			},
			pause: ownTab => {
				const { tab } = find(ownTab);
				const changed = tab.pause('an agent');
				const notes = [
					...(changed ? [] : ['The queue was paused already.']),
					...(tab.running ? ['The turn running goes on to its end; nothing queued goes out until chat_resume.'] : []),
				];
				return { ...queueOf(tab), running: tab.running, ...(notes.length ? { note: notes.join(' ') } : {}) };
			},
			resume: ownTab => {
				const { surface, tab } = find(ownTab);
				const changed = tab.resume();
				surface._drainQueues();
				return { ...(changed ? {} : { note: 'The queue was not paused.' }), ...queueOf(tab) };
			},
			stopAgent: async (ownTab, rowId) => {
				const { surface, tab } = find(ownTab);
				const row = rowsOf(surface, tab).find(r => r.id === rowId);
				if (!row) {
					throw new Error(`None of your agents has the id ${JSON.stringify(rowId)}: chat_agents lists them.`);
				}
				if (row.status !== 'running') {
					throw new Error(`That agent is not running (it is ${row.status}).`);
				}
				const stopped = rowId.startsWith(runRowPrefix) ? surface._runs.stopRow(rowId) : await tab.stopAgent(rowId);
				if (!stopped) {
					throw new Error('The agent could not be stopped; the chat says why.');
				}
				return { id: rowId, stopping: true, note: 'Asked to stop; chat_agents shows it as stopped once its CLI reports it.' };
			},
		};
	}

	public dispose(): void {
		if (this._disposed) { return; }
		this._stateSurfaces.dispose();
		if (this._tabs.length) { this._saveTabs(); }
		this._shuttingDown = !this._panelIdentity;
		clearTimeout(this._draftSaveTimer);
		if (this._panelIdentity) {
			const owner = this._lifetimeOwner;
			owner?._pendingPanels.delete(this._panelIdentity.id);
			if (!owner?._shuttingDown) { this._services.panels.forget(this._panelIdentity.id); }
		}
		for (const pending of [...this._pendingPanels.values()]) { pending.dispose(); }
		for (const panel of this._windows) { panel.dispose(); }
		this._videoEncoder?.host.dispose();
		this._disposed = true;
		for (const request of this._draftRequests.values()) { clearTimeout(request.timer); request.reject(new Error('The source chat was closed.')); }
		this._draftRequests.clear();
		ChatViewProvider._surfaces.delete(this._surfaceId);
		for (const surface of ChatViewProvider._surfaces.values()) { surface._post(); }
		for (const request of this._titleRequests.values()) { request.abort(); }
		this._titleRequests.clear();
        for (const request of this._branchNameRequests.values()) { request.abort(); }
        this._branchNameRequests.clear();
		for (const job of this._gitCommits.values()) { job.controller.abort(); }
		this._sleep.dispose();
		this._pendingOpen?.dispose();
		this._livePageWatch?.dispose();
		this._livePages.clear();
		this._voiceCancel();
		if (!this._panelIdentity) { void vscode.commands.executeCommand('setContext', 'aiBrowser.keepAwakeActive', false); }
		// Shared backends own live sessions of tabs moved into other surfaces.
		this._services.views.delete(this);
		if (!this._services.views.size) { this._runs.dispose(); }
		for (const timer of this._usageChecks.values()) {
			clearTimeout(timer);
		}
		this._usageChecks.clear();
		clearTimeout(this._resetTimer?.timer);
		this._resetTimer = undefined;
		for (const timer of this._draining.values()) {
			clearTimeout(timer);
		}
		this._draining.clear();
		clearTimeout(this._gitEventTimer);
		this._gitEventTimer = undefined;
		for (const tab of this._tabs) {
			tab.close();
			ChatViewProvider._pins.dropTab(tab.id);
		}
		// The pins on this surface's terminals go with them; a conversation on another surface hears of it.
		for (const terminal of this._terminals.tabs) { this._terminalGone(terminal.id, terminal.name, true); }
		// A shell does not outlive the window or panel it was opened in; its screen is kept, so the next start brings it back.
		this._saveTerminals();
		clearTimeout(this._terminalSaveTimer);
		this._terminalSaveTimer = undefined;
		this._terminals.dispose();
		this._terminalHostInstance?.dispose();
		this._terminalHostInstance = undefined;
		// After the tabs: closing one posts, and a timer set then would fire on a
		// view that is gone.
		clearTimeout(this._postTimer);
		this._postTimer = undefined;
		this._subscriptions.forEach(s => s.dispose());
		if (!this._services.views.size) { this._registry.dispose(); ChatViewProvider._sharedServices = undefined; }
	}
}

/** Whether `folder` is a directory now; anything that cannot be read is not. */
function isDirectory(folder: string): boolean {
	try {
		return fs.statSync(folder).isDirectory();
	} catch {
		return false;
	}
}

/** A chip's label as a file name: page titles can hold anything. */
function fileSafe(label: string): string {
	// Cut by code point, and no half of a surrogate pair left anywhere: one in a
	// `vscode.Uri` throws "URI malformed", and the chip could not be opened.
	const clean = label.replace(/[\\/:*?"<>|#\x00-\x1f]+/g, '-').replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '').replace(/\s+/g, ' ').trim();
	return Array.from(clean).slice(0, 60).join('') || 'attachment';
}

/** Keeps `value` under `key`, dropping the oldest past `openedAttachmentLimit`. */
function remember<T>(map: Map<string, T>, key: string, value: T): void {
	map.delete(key);
	map.set(key, value);
	while (map.size > openedAttachmentLimit) {
		map.delete(map.keys().next().value!);
	}
}

/** A file or folder as an attachment: its path, and where it sits in the project when it does. */
/** The editor's non-empty selections, in document order. */
function nonEmptySelections(editor: vscode.TextEditor): vscode.Selection[] {
	return editor.selections.filter(selection => !selection.isEmpty)
		.sort((a, b) => a.start.compareTo(b.start));
}

/** A selection's lines, 1-based; a selection ending at a line's start does not take that line. */
function selectionLines(selection: vscode.Selection): { readonly first: number; readonly last: number } {
	const first = selection.start.line + 1;
	const last = selection.end.character === 0 && selection.end.line > selection.start.line ? selection.end.line : selection.end.line + 1;
	return { first, last };
}

/** Which selection this is, or `undefined` with nothing selected. */
function editorSelectionKey(editor: vscode.TextEditor): string | undefined {
	const selections = nonEmptySelections(editor);
	if (!selections.length) { return undefined; }
	const ranges = selections.map(s => `${s.start.line}.${s.start.character}-${s.end.line}.${s.end.character}`).join(',');
	return `${editor.document.uri.toString()}#${ranges}`;
}

/** The chip's words: the file's name, then the lines selected. */
function selectionLabel(editor: vscode.TextEditor): string {
	const name = path.basename(editor.document.uri.path) || vscode.l10n.t("Untitled");
	const selections = nonEmptySelections(editor);
	if (selections.length !== 1) {
		return vscode.l10n.t("{0} · {1} selections", name, selections.length);
	}
	const { first, last } = selectionLines(selections[0]);
	return first === last
		? vscode.l10n.t("{0} · line {1}", name, first)
		: vscode.l10n.t("{0} · lines {1}–{2}", name, first, last);
}

/**
 * A snapshot of the editor's selected text as an attachment, quoted so it stays data in the
 * prompt; `undefined` with nothing selected, a refusal's text when it is over 1 MB.
 */
function selectionAttachment(editor: vscode.TextEditor): Attachment | string | undefined {
	const selections = nonEmptySelections(editor);
	const key = editorSelectionKey(editor);
	if (!selections.length || !key) { return undefined; }
	const source = editor.document.uri.scheme === 'file' ? editor.document.uri.fsPath : editor.document.uri.toString();
	const parts = selections.map(selection => {
		const { first, last } = selectionLines(selection);
		return `Lines ${first}${last === first ? '' : `-${last}`}:\n${JSON.stringify(editor.document.getText(selection))}`;
	});
	const text = `Selected text from ${JSON.stringify(source)}:\n${parts.join('\n\n')}`;
	if (Buffer.byteLength(text, 'utf8') > 1_000_000) {
		return vscode.l10n.t("The selection is too large to attach (maximum 1 MB).");
	}
	return { chip: { id: generateUuid(), kind: 'selection', label: selectionLabel(editor), iconName: path.basename(editor.document.uri.path) || undefined }, text, selectionKey: key };
}

function fileAttachment(uri: vscode.Uri, folder: string | undefined, directory: boolean): Attachment {
	const relative = folder ? path.relative(folder, uri.fsPath) : undefined;
	const inProject = relative !== undefined && relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
	const shown = inProject ? relative.split(path.sep).join('/') : undefined;
	return directory
		? { chip: { id: generateUuid(), kind: 'file', label: `${path.basename(uri.fsPath)}/`, iconName: `${path.basename(uri.fsPath)}/` }, text: `Attached folder: ${uri.fsPath}${shown ? ` (${shown}/ in the project)` : ''}` }
		: { chip: { id: generateUuid(), kind: 'file', label: path.basename(uri.fsPath), iconName: path.basename(uri.fsPath) }, file: uri, text: `Attached file: ${uri.fsPath}${shown ? ` (${shown} in the project)` : ''}` };
}

/** A model label squeezed for a tab caption: `Sonnet 5.5` → `sonnet5.5`, `GPT-6.1-Sol` → `sol6.1`, `anthropic/claude-sonnet-5.5` → `claude-sonnet-5.5` (OpenRouter and OpenCode ids carry a vendor). */
function shortModelName(label: string): string {
	let text = label.trim().toLowerCase().replace(/^.*\//, '').replace(/^gpt-/, '');
	const versionFirst = /^(\d[\d.]*)-(.+)$/.exec(text);
	if (versionFirst) {
		text = versionFirst[2] + versionFirst[1];
	}
	return text.replace(/\s+/g, '');
}

/** The finish sound settings as the view takes them, anything out of range read as its default. */
function soundSettings(): ChatSoundSettings {
	const config = vscode.workspace.getConfiguration('aiBrowser.chat.sound');
	const enabled = config.get<unknown>('enabled');
	const name = config.get<unknown>('name');
	const volume = config.get<unknown>('volume');
	const repeat = config.get<unknown>('repeat');
	return {
		enabled: typeof enabled === 'boolean' ? enabled : true,
		activeChat: config.get<unknown>('activeChat') === true,
		sound: typeof name === 'string' && (chatSounds as readonly string[]).includes(name) ? name as ChatSound : 'chime',
		volume: typeof volume === 'number' && Number.isFinite(volume) ? Math.min(200, Math.max(0, volume)) : 60,
		repeat: typeof repeat === 'number' && Number.isFinite(repeat) ? Math.round(Math.min(5, Math.max(1, repeat))) : 1,
		notify: vscode.workspace.getConfiguration('aiBrowser.chat.notifications').get<unknown>('enabled') !== false,
		notifyAway: vscode.workspace.getConfiguration('aiBrowser.chat.notifications').get<unknown>('onlyWhenAway') !== false,
	};
}

/**
 * A system notification that an agent finished, from the extension host: the
 * workbench has no API for one, so each platform's own tool, with the text
 * passed as data (argv, environment), never spliced into a script (#158).
 * Not a VS Code toast: that would pause a browser tab (#10).
 */
function osNotify(title: string, text: string): void {
	const settings = soundSettings();
	if (!settings.notify || (settings.notifyAway && vscode.window.state.focused)) { return; }
	const clean = (value: unknown, max: number) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
	const t = clean(title, 120) || 'AI Browser';
	const body = clean(text, 300);
	const done = () => { /* a notification is never worth an error */ };
	try {
		if (process.platform === 'darwin') {
			cp.execFile('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', t, body], { timeout: 10_000 }, done);
		} else if (process.platform === 'win32') {
			const script = "Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(6000, $env:AIB_NOTIFY_TITLE, $env:AIB_NOTIFY_TEXT, 'Info'); Start-Sleep -Seconds 7; $n.Dispose()";
			cp.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15_000, windowsHide: true, env: { ...process.env, AIB_NOTIFY_TITLE: t, AIB_NOTIFY_TEXT: body || ' ' } }, done);
		} else {
			cp.execFile('notify-send', ['--app-name=AI Browser', '--', t, body], { timeout: 10_000 }, done);
		}
	} catch { done(); }
}
