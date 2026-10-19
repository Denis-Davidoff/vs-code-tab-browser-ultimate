import { titleModel } from './autoTitle';
import { localFileLink } from './fileLinks';
import { SleepControl } from '../power/sleepControl';
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { attachmentReference } from './attachmentReferences';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentRegistry, agentNames, type BrowserServer } from './agents';
import { sweepBrowserConfigs } from './claudeAgent';
import { bundledPin } from './agentBinary';
import { ChatTab, isHome, newChat, reopened, started, storedEntries, storedTextLimit, type Attachment, type SkillStep, type StoredChat, type TabHost } from './chatTab';
import { chatTranscript, transcriptFileName } from './transcript';
import { diffSides } from './diffSides';
import { listWorkdir, type WorkdirListing } from './workdir';
import { compareUrl, parseRepo, repoSlug, validBranch, workBranchName, type RepoRef } from './githubRepo';
import { cloneInto, copyChanges, isEmptyFolder, isOurWorktree, makeCopy, makeReference, pushCopy, removeCopy, storedCopyRepo, removeStoredCopy } from './repoWork';
import { gitBinary } from '../core/gitBinary';
import { cleanUpReportsIn, writeChatTranscript } from '../elements/assistants';
import { savePng } from '../browser/clipboardImage';
import type { BrowserController } from '../browser/browserController';
import type {
	AgentId, AgentUsage, ApprovalMode, AttachmentKind, ChatSummary,
	ChatNews, ChatTabSummary, ChatViewState, HostToView, RepoMode, Selection, ToolbarRun, ToolbarSkill, UsageAlert, UsageWindow, ViewToHost, WorkdirFolder, WorkdirState,
} from './chatProtocol';
import { pickElementContext, pickForChat } from '../elements/elementPicker';
import { parseNews } from './news';
import { confirm, refuse } from '../core/notify';
import { capAt, plainInLabel, plainInNotification, plainInPrompt } from '../core/notifyText';
import { hostIsRemote, isBrowserApiGranted, workspaceIsRemoteFromHost } from '../setup/proposedApi';
import { pageTitle } from '../translate/translateText';
import { generateUuid } from '../core/uuid';
import { runRowPrefix, ToolbarRuns, type SkillEnd } from './toolbarRun';
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
export const approvalCategories = ['web', 'browser', 'command', 'edit', 'outside', 'other'] as const;
const approvalModes: readonly ApprovalMode[] = ['auto', 'ask', 'deny'];
/** Servers listed in the menu at most: one row each, and each is an agent's own config. */
const approvalServerLimit = 30;
/** The chats open as tabs, by chat id, and the one in front; restored with the window. */
const openTabsKey = 'aiBrowser.chat.openTabs';
/**
 * At most this many tabs, `aiBrowser.chat.tabLimit`: 10 unless set, 30 at most.
 * Each Claude Code tab is a `claude` process of its own (a Codex tab is only a
 * thread of the one app-server), and tabs working at once spend the plan's
 * limits at once — which is why there is a ceiling at all.
 */
export const defaultTabLimit = 10;
export const maxTabLimit = 30;
const tabLimitSetting = 'aiBrowser.chat.tabLimit';
const collapseToolsSetting = 'aiBrowser.chat.collapseToolCalls';
/** The most of a tool's input or output opened in a tab; past it the text is cut with a line saying so. */
const openTextLimit = 2_000_000;

/** The setting as a whole number in range; anything else is the default (#184's rule). */
export function tabLimit(): number {
	const value = vscode.workspace.getConfiguration().get<unknown>(tabLimitSetting);
	return typeof value === 'number' && Number.isInteger(value) && value >= 1
		? Math.min(value, maxTabLimit)
		: defaultTabLimit;
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
const projectConfigFiles = ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json'];
/** A folder's listing is reused for this long: the button is opened again and again while a message is written. */
const workdirListingMs = 15_000;
/**
 * The scheme a composer chip's text opens under: a read-only document, which
 * an untitled one is not — closing it would ask to save what was only shown.
 */
const attachmentScheme = 'ai-browser-attachment';
/** Texts and images of chips opened recently, by chip id; a chip's content never changes. */
const openedAttachmentLimit = 30;
/** A conversation handed over in the message itself, with no folder to write it to: its newest part. */
const transcriptInlineLimit = 60_000;
const postDelayMs = 40;
/** A tab name, as typed into the tab: kept to what a tab, a history row and a heading can show. */
const tabTitleLimit = 80;

interface RememberedSelection {
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

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private readonly _sleep: SleepControl;
	private _view: vscode.WebviewView | undefined;
	private _viewReady = false;
	private _queued: HostToView[] = [];
	private readonly _registry: AgentRegistry;
	/** The open conversations, in the order of their tabs; `_active` is the one shown. */
	private _tabs: ChatTab[] = [];
	private _active!: ChatTab;
	/** The agent picked for a conversation that has started with another: asked about in the view. */
	private _switchTo: AgentId | undefined;
	private _tabsSaved = '';
	/** NEWS.md from the installed extension, read once; see `news.ts`. */
	private _news: ChatNews | undefined;
	private readonly _attachmentTexts = new Map<string, string>();
	private readonly _attachmentImages = new Map<string, vscode.Uri>();
	private readonly _tabHost: TabHost = {
		cwd: () => this._windowCwd(),
		projectRoot: () => vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file')?.uri.fsPath,
		ownSettings: folder => !this._untrusted(folder),
		changed: () => { this._post(); this._drainQueues(); },
		limits: (agent, windows, usingCredits) => this._noteLimits(agent, windows, usingCredits, false),
		turnEnded: (agent, weight) => this._turnEnded(agent, weight),
		save: chat => this._save(chat),
		inHistory: id => this._history().some(c => c.id === id),
		approvalMode: key => this._approvalPolicy()[key] ?? 'ask',
		noteServer: server => this._noteServer(server),
		released: chatId => this._runs.stopChat(chatId),
	};
	private _remembered: RememberedSelection;
	private readonly _runs = new ToolbarRuns({
		approvalMode: key => this._approvalPolicy()[key] ?? 'ask',
		noteServer: server => this._noteServer(server),
		changed: () => this._post(),
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

	/**
	 * `browserServer`: the extension's MCP server while it runs, handed to every
	 * CLI the chat starts so the agents have the browser tools without Connect.
	 */
	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _browser: BrowserController,
		browserServer: () => BrowserServer | undefined = () => undefined,
	) {
		this._registry = new AgentRegistry(() => this._cwd(), id => this._agentBinaries()[id], browserServer, () => !this._untrusted(this._cwd()));
		void sweepBrowserConfigs().catch(() => { /* swept with the temp directory */ });
		this._subscriptions.push(this._registry, this._registry.onDidChange(() => this._post()));
		this._remembered = _context.globalState.get<RememberedSelection>(selectionKey) ?? { models: {}, efforts: {} };
		this._restoreTabs();
		this._sleep = new SleepControl(
			// A tab that has closed works no more, so a hold scoped to it ends.
			tabId => (tabId === undefined ? this._tabs : this._tabs.filter(t => t.id === tabId))
				.some(t => t.busy || t.waiting || t.queuedCount > 0 || this._runs.runningIn(t.chat.id) > 0),
			() => { this._publishSleep(); this._post(); },
			hostIsRemote() ? "Sleep prevention requires a local VS Code window." : undefined,
		);
		void this._readNews();
		// "Continue in …" writes into the conversation's folder; the activation
		// sweep reaches only the workspace's.
		void cleanUpReportsIn([...this._recentFolders(), ...this._tabs.flatMap(t => t.chat.folder !== undefined ? [t.chat.folder] : [])]);

		this._subscriptions.push(this._registry.onDidReplace(e => this._onBackendReplaced(e.agent, e.gone)));
		// Every read of a plan whole — detection's, the U popup's, the checks
		// after a turn — replaces what was known of it.
		this._subscriptions.push(this._registry.onDidReadUsage(u => this._noteLimits(u.agent, u.windows, u.usingCredits, true)));
		// A lower limit closes nothing: the tabs open stay, and "+" comes back
		// once enough of them are closed.
		this._subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(tabLimitSetting) || e.affectsConfiguration(collapseToolsSetting)) {
				this._post();
			}
		}));
		this._subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(attachmentScheme, {
			// An editor restored after a reload asks for a chip this window never
			// held, and gets a sentence rather than an empty page.
			provideTextDocumentContent: uri => this._attachmentTexts.get(uri.query)
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
		// Only to keep the "+" menu's page entries in step with the open tabs.
		// Read behind the grant and inside a `try`: a proposed member exists
		// whether or not it is granted, and the read is what throws (#11).
		if (isBrowserApiGranted()) {
			try {
				this._subscriptions.push(
					vscode.window.onDidOpenBrowserTab(() => this._post()),
					vscode.window.onDidCloseBrowserTab(() => this._post()),
					vscode.window.onDidChangeActiveBrowserTab(() => this._post()),
				);
			} catch {
				// The menu then only learns of tabs on the next state change.
			}
		}
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

	public resolveWebviewView(view: vscode.WebviewView): void {
		this._view = view;
		this._viewReady = false;
		const media = vscode.Uri.joinPath(this._context.extensionUri, 'media');
		view.webview.options = { enableScripts: true, localResourceRoots: [media] };
		view.webview.html = this._html(view.webview, media);
		view.webview.onDidReceiveMessage((message: ViewToHost) => {
			this._receive(message).catch(err => this._fail(err));
		}, undefined, this._subscriptions);
		// Shown again: the tab in front is read now, not at its next change.
		view.onDidChangeVisibility(() => this._post(), undefined, this._subscriptions);
		view.onDidDispose(() => {
			if (this._view === view) {
				this._view = undefined;
				this._viewReady = false;
				// Nothing can show what a conversation does once its view is gone,
				// so its CLI is not left working unseen on the user's quota. The
				// chat is saved and resumes from the history; Codex's app-server
				// then goes idle and shuts down on its own.
				for (const tab of this._tabs) {
					tab.close();
				}
				// The toolbar's background runs too: their button and its question
				// went with the view. The skills sent into the chat ended with their
				// tabs' turns, the user's doing — not told.
				this._runs.viewClosed();
				this._chatSkillTabs.clear();
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
					font-src data:;
					img-src data:;
					style-src ${webview.cspSource};
					script-src 'nonce-${nonce}';
					">
				<meta name="viewport" content="width=device-width, initial-scale=1">
				<link rel="stylesheet" href="${uri('codicon.css')}">
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
	private _postMessage(message: HostToView): void {
		if (!this._view || !this._viewReady) {
			if (message.type !== 'state') {
				this._queued.push(message);
			}
			return;
		}
		void this._view.webview.postMessage(message);
	}

	/** Coalesces state posts: a streaming reply changes the state many times a frame. */
	private _sleepShown?: boolean;
	/** The title bar shows an empty or a filled cup, by context key. */
	private _publishSleep(): void {
		const on = this._sleep.state.mode !== 'off';
		if (on !== this._sleepShown) {
			this._sleepShown = on;
			void vscode.commands.executeCommand('setContext', 'aiBrowser.keepAwakeActive', on);
		}
	}

	private _post(): void {
		if (this._postTimer) {
			return;
		}
		this._postTimer = setTimeout(() => {
			this._postTimer = undefined;
			this._postMessage({ type: 'state', state: this._state() });
			this._saveTabs();
		}, postDelayMs);
	}

	private _state(): ChatViewState {
		// Whatever the tab in front finished is read once the view shows it. A
		// view in another side bar container, or collapsed, is not looked at.
		if (this._view?.visible) {
			this._active.seen();
		}
		const limit = tabLimit();
		const selection = this._selection();
		return {
			sleep: this._sleep.state,
			blocked: this._blocked(),
			detecting: this._registry.detecting,
			agents: this._registry.agents,
			selection,
			...this._usageState(selection.agent),
			chatId: this._active.chat.id,
			entries: this._active.chat.entries,
			running: this._active.running,
			attachments: this._active.attachments.map(a => ({ ...a.chip, reference: attachmentReference(a.chip) })),
			pendingSends: this._active.pendingSends,
			tabs: this._tabs.map((tab): ChatTabSummary => ({
				id: tab.id,
				chatId: tab.chat.id,
				title: tab.title ?? vscode.l10n.t("New chat"),
				agent: tab.started ? tab.chat.agent : undefined,
				running: tab.running,
				agents: tab.agentsRunning,
				skillRuns: this._runs.runningIn(tab.chat.id),
				busy: tab.busy,
				queued: tab.queuedCount,
				status: tab.status,
			})),
			activeTab: this._active.id,
			tabLimit: limit,
			approvals: { policy: this._approvalPolicy(), servers: this._approvalServers() },
			switchTo: this._switchTo,
			commands: this._registry.commands,
			toolbar: this._toolbar(),
			toolbarRuns: this._toolbarRunsState(),
			skillAgents: this._runs.rows(this._active.chat.id),
			// On unless switched off: Compact is the default, and a value that is not a boolean is read as it.
			collapseTools: vscode.workspace.getConfiguration().get<unknown>(collapseToolsSetting) !== false,
			context: this._contextState(),
			workdir: this._workdirState(),
			hasBrowserTab: this._browser.hasOpenTabs,
			browserApi: isBrowserApiGranted(),
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
		const canCompact = agent === 'codex' || !!this._registry.commands.claude?.some(c => c.name === 'compact');
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
				// A queue held while there was no view goes out now that there is one.
				this._drainQueues();
				this._postMessage({ type: 'state', state: this._state() });
				const queued = this._queued;
				this._queued = [];
				queued.forEach(m => this._postMessage(m));
				this._postMessage({ type: 'inputHistory', items: this._inputHistory() });
				if (!this._blocked() && !this._registry.detecting && !this._registry.agents.some(a => a.available || a.problem)) {
					await this._registry.detect();
				}
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
				if (!this._blocked() && (message.agent === 'claude' || message.agent === 'codex') && !this._registry.detecting) {
					await this._registry.refreshCommands(message.agent);
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
			case 'stop': {
				const tab = this._active;
				// Stop is for everything this tab was going to do: the queue does
				// not go out after it. What was queued comes back to the box,
				// attachments with it, to send or drop.
				this._giveBackQueue(tab);
				tab.stop();
				// A skill sent into this tab was stopped by the user, not ended: no notification.
				for (const run of [...this._chatSkillTabs.values()].flat()) {
					if (run.tab === tab) {
						run.stopped = true;
					}
				}
				this._post();
				return;
			}
			case 'openDiff':
				await this._openDiff(message.name, message.diff);
				return;
			case 'openText':
				await this._openText(message.name, message.text);
				return;
			case 'openAttachment':
				await this._openAttachment(message.id);
				return;
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
				for (const tab of this._tabs) {
					tab.approvalModesChanged();
				}
				this._runs.approvalModesChanged();
				this._post();
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
				this.newChat();
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
			case 'setAgentBinary':
				await this._setAgentBinary(message.agent, message.path);
				return;
			case 'openAgentSetting':
				await vscode.commands.executeCommand('workbench.action.openSettings', `aiBrowser.chat.${message.agent}Path`);
				return;
			case 'attach':
				await this._attach(message.kind);
				return;
			case 'removeAttachment':
				this._active.attachments = this._active.attachments.filter(a => a.chip.id !== message.id);
				this._post();
				return;
			case 'usage':
				await this._usage();
				return;
			case 'dismissUsageAlert':
				this._dismissUsageAlert(message.alert);
				return;
			case 'openChat':
				this._openChat(message.id);
				return;
			case 'deleteChat':
				await this._deleteChat(message.id);
				return;
			case 'newChat':
				this.newChat();
				return;
			case 'copy':
				await vscode.env.clipboard.writeText(message.text);
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
				this._post();
				return;
			case 'openBrowser':
				// The toolbar's own "Open New Browser Tab": an empty tab of the
				// built-in browser, or the panel when the user chose it — the
				// command already decides that (see "The dropdown on the browser tab").
				await vscode.commands.executeCommand('aiBrowser.newTab');
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
			case 'setCollapseTools':
				await this._setCollapseTools(message.collapse === true);
				return;
		}
	}

	/**
	 * The approval menu's Compact switch writes `aiBrowser.chat.collapseToolCalls`
	 * — one setting, so the switch and Settings never disagree; the change comes
	 * back through `onDidChangeConfiguration` and the post it makes. Written where
	 * it is in force: a workspace value would shadow a user-level write, and the
	 * switch would then do nothing. A settings.json VS Code cannot parse refuses
	 * the write, which is said in the status bar.
	 */
	private async _setCollapseTools(collapse: boolean): Promise<void> {
		const config = vscode.workspace.getConfiguration();
		const info = config.inspect<unknown>(collapseToolsSetting);
		const target = info?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
		try {
			await config.update(collapseToolsSetting, collapse, target);
		} catch (error) {
			refuse(vscode.l10n.t('Could not change Fold Tool Calls: {0}', plainInLabel(error instanceof Error ? error.message : String(error))));
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
	private async _runToolbarSkill(id: string, values: Readonly<Record<string, string>>, tabId?: string, again = false, queue = false): Promise<void> {
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
		const commands = this._registry.commands[agent] ?? [];
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
		this._runs.start(skill, steps, stringValues, tab.chat.id, backend, model, effort, tab.cwd, tab.projectRoot, !this._untrusted(tab.cwd));
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
	private _selection(tab = this._active): Selection {
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
		return { agent: agent.id, model: model.id, effort };
	}

	private _select(selection: Selection): void {
		const before = this._selection();
		// A conversation belongs to one agent: another agent picked for one that
		// has started is a question — a new tab beside it, in its place, or
		// carrying it on — asked in the view, and the remembered agent waits for
		// the answer.
		const switching = !!selection.agent && selection.agent !== before.agent && this._active.started;
		const next: RememberedSelection = {
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
		// Sent while the agents were still being looked for: wait for the answer
		// rather than refuse. Refusing lost the message — the webview clears its
		// draft on send — and told the user to install an agent that was there.
		if (this._registry.detecting) {
			await this._registry.detect();
			// Detection can take seconds, and meanwhile the tab may have closed,
			// been replaced, or been given another chat from the history. Sent
			// anyway, the message went into a conversation it was not written for,
			// or started a CLI for a tab nothing showed or could stop (#339).
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
		const { agent, model, effort } = this._selection(tab);
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
		const attachments = given ?? tab.attachments;
		if (!text.trim() && !attachments.length) {
			return;
		}
		if (!given) {
			tab.attachments = [];
		}
		// Only the tab in front's card: a queued message going out in another
		// tab must not close the question the user is reading here.
		if (tab === this._active) {
			this._switchTo = undefined;
		}
		const needsTitle = !tab.started && !tab.chat.named;
		const titleContext = [text.slice(0, 1000), ...attachments.slice(0, 5).map(a => a.chip.label.slice(0, 80))].join('\n').slice(0, 1200);
		const sent = tab.send(text, attachments, agent, model, effort, backend, step);
		if (needsTitle) { this._generateTabTitle(tab, agent, titleContext); }
		await sent;
		this._saveTabs();
	}

	private readonly _titleRequests = new Map<ChatTab, AbortController>();

	private _generateTabTitle(tab: ChatTab, agent: AgentId, context: string): void {
		const backend = this._registry.backend(agent);
		const model = titleModel(this._registry.agents.find(a => a.id === agent)?.models ?? []);
		if (!backend?.generateTitle || !model) { return; }
		this._titleRequests.get(tab)?.abort();
		const chatId = tab.chat.id;
		const controller = new AbortController();
		this._titleRequests.set(tab, controller);
		void backend.generateTitle(model, context, controller.signal).then(title => {
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
		// Nothing to wait for: no turn, nothing queued or waiting before it.
		if (!tab.running && !tab.busy && !tab.pendingSends.length) {
			void this._send(text, tab.id).catch(err => this._fail(err));
			return;
		}
		const attachments = tab.attachments;
		if (!text.trim() && !attachments.length) {
			return;
		}
		void this._rememberInput(text);
		tab.attachments = [];
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
					? this._runToolbarSkill(next.background.skillId, next.background.values, tab.id, true)
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
		tab.start(next);
		this._switchTo = undefined;
		this._post();
		this._postMessage({ type: 'focusInput' });
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
		tab.attachments.push(...queued.flatMap(q => q.attachments));
		this._postMessage({ type: 'restoreDraft', chatId: tab.chat.id, text: queued.map(q => q.text).filter(Boolean).join('\n\n') });
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

	/* ------------------------------------------------------------ attachments */

	private async _attach(kind: AttachmentKind): Promise<void> {
		const tab = this._active;
		const attachment = await this._makeAttachment(kind);
		if (attachment) {
			tab.attachments.push(attachment);
			this._post();
			this._postMessage({ type: 'focusInput' });
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
		this._post();
		await vscode.commands.executeCommand(`${chatViewId}.focus`);
		this._postMessage({ type: 'focusInput' });
	}

	/** What `addFromBrowser` attaches; may throw — a capture can fail — which the caller reports. */
	private async _fromBrowser(what: 'element' | 'cssPath' | 'cssLocation' | 'xpath' | 'screenshot' | 'page', page: vscode.BrowserTab | undefined): Promise<Attachment | undefined> {
		if (what === 'cssPath' || what === 'cssLocation' || what === 'xpath') {
			if (!isBrowserApiGranted() || !page) {
				return this._makeAttachment('element', page);
			} else if (!onScreen(page, this._browser.focusedTab)) {
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
	private async _makeAttachment(kind: AttachmentKind, page?: vscode.BrowserTab): Promise<Attachment | undefined> {
		const id = generateUuid();
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
			return { chip: { id, kind, label: path.basename(file.fsPath) }, file, text: `Attached file: ${file.fsPath}${shown !== file.fsPath ? ` (${shown} in the workspace)` : ''}` };
		}

		// Two refusals, because the fixes are unrelated (Recipe, step 3): without
		// the grant no tab can be seen at all, open or not.
		if (!isBrowserApiGranted()) {
			refuse(vscode.l10n.t("Browser API not enabled — click \"Enable Browser API\" in the status bar."));
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
			case 'page': {
				const title = plainInPrompt(pageTitle(tab.title, tab.url));
				return {
					chip: { id, kind, label: title || tab.url },
					text: `The page the user is looking at: ${tab.url}${title ? ` — "${title}"` : ''}`,
				};
			}
			case 'screenshot': {
				if (!onScreen(tab, this._browser.focusedTab)) {
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
				if (!onScreen(tab, this._browser.focusedTab)) {
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
	private async _openAttachment(id: string): Promise<void> {
		const attachment = this._active.attachments.find(a => a.chip.id === id);
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
				const uri = vscode.Uri.from({ scheme: attachmentScheme, path: `/${fileSafe(attachment.chip.label)}.txt`, query: id });
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
		const uri = vscode.Uri.from({ scheme: attachmentScheme, path: `/${fileSafe(name)}.txt`, query: id });
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
			return vscode.Uri.from({ scheme: attachmentScheme, path: `/${base} (${label}).txt`, query: id });
		};
		const left = side('before', before);
		const right = side('after', after);
		try {
			await vscode.commands.executeCommand('vscode.diff', left, right, vscode.l10n.t("{0} (changes)", plainInLabel(name)), { preview: true, viewColumn: vscode.ViewColumn.Active });
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
		if (agent !== 'claude' && agent !== 'codex') {
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
		const stats = this._active.started ? { ...this._active.chat.stats } : undefined;
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

	/** `refresh`: the list changed under an open panel; it updates it and never opens or closes it. */
	/** The title bar's cup; the popup is the view's own, so it pauses no browser tab. */
	public showKeepAwake(): void {
		this._postMessage({ type: 'openSleep' });
	}

	public showHistory(refresh = false): void {
		const chats: ChatSummary[] = this._history().map(c => ({ id: c.id, title: c.title, agent: c.agent, updatedAt: c.updatedAt }));
		this._postMessage({ type: 'history', chats, refresh });
	}

	/**
	 * A chat from the history: brought to the front if a tab has it already,
	 * shown in the tab in front if that one is empty, and otherwise in a new tab
	 * beside it — opening one must not end a conversation that is working.
	 */
	private _openChat(id: string): void {
		const open = this._tabs.find(t => t.chat.id === id);
		if (open) {
			this._selectTab(open.id);
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
		this._post();
	}

	private async _deleteChat(id: string): Promise<void> {
		try {
			await this._context.workspaceState.update(historyKey, this._history().filter(c => c.id !== id));
		} catch {
			// Best effort, as above.
		}
		const tab = this._tabs.find(t => t.chat.id === id);
		if (tab) {
			// Not saved on the way out: that would write the deleted chat back.
			tab.discard();
			this._removeTab(tab);
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
	private _workdir(tab = this._active): string | undefined {
		return tab.chat.folder ?? this._workspaceFolders()[0]?.path;
	}

	private _workdirState(): WorkdirState {
		const tab = this._active;
		const workspace = this._workspaceFolders();
		const current = this._workdir(tab);
		const shown = (p: string): WorkdirFolder => workspace.find(w => w.path === p) ?? { path: p, name: path.basename(p) || p, removable: p !== current && !!storedCopyRepo(this._repoStorage(), p) };
		const copy = tab.chat.copy;
		return {
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
	private async _setWorkdir(folder: string | undefined, remember = true, from: ChatTab = this._active): Promise<ChatTab | undefined> {
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
		// The tab asked for, unless it closed meanwhile (a clone takes minutes).
		let tab = this._tabs.includes(from) ? from : this._active;
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
		this._postMessage({ type: 'focusInput' });
		// The "/" palette lists the skills of the project in front.
		const agent = tab.started ? tab.chat.agent : this._selection(tab).agent;
		if (agent && !this._registry.detecting) {
			void this._registry.refreshCommands(agent).catch(() => undefined);
		}
		return tab;
	}

	/** "Choose folder…": the system's folder dialog — native, so it pauses no browser tab. */
	private async _chooseWorkdir(): Promise<void> {
		const current = this._workdir();
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
			await this._setWorkdir(uri.fsPath);
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
			? { chip: { id: generateUuid(), kind: 'file', label: `${path.basename(target)}/` }, text: `Attached folder: ${target} (${shown}/ in the project)` }
			: { chip: { id: generateUuid(), kind: 'file', label: path.basename(target) }, file: vscode.Uri.file(target), text: `Attached file: ${target} (${shown} in the project)` });
		this._post();
		this._postMessage({ type: 'focusInput' });
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
		let tab = this._active;
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
						const opened = this._addTab(target.chat.agent, this._tabs.includes(target) ? target : this._active);
						if (!opened) {
							throw new Error(vscode.l10n.t("No tab to work in the copy: it is at {0}.", made.path));
						}
						target = opened;
					}
					await this._rememberFolder(made.path);
					target.setFolder(made.path, { repo: repoSlug(repo), base: made.base, branch: workBranch });
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
			(this._tabs.includes(tab) ? tab : this._active).push({ kind: 'error', text: vscode.l10n.t("GitHub: {0} failed — {1}", doing, reason) });
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
		await this._repoWork(this._active, vscode.l10n.t("removing repository copy"), async () => {
			await removeStoredCopy(git, this._repoStorage(), folder);
			this._forgetCopy(folder);
			this._listings.delete(folder);
			await this._forgetRecent(folder);
		});
	}

	/** The folder button's actions on a separate copy of the tab in front. */
	private async _repoAction(action: unknown): Promise<void> {
		const tab = this._active;
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
		const sharing = this._tabs.filter(t => t.chat.folder === folder);
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
				await this._repoWork(tab, vscode.l10n.t("pushing {0}", copy.branch), async () => {
					const message = capAt(tab.chat.title.replace(/\s+/g, ' ').trim() || 'Changes from the AI Browser chat', 72);
					await pushCopy(git, folder, copy.base, copy.branch, message);
					const url = compareUrl(repo, copy.base, copy.branch);
					tab.push({ kind: 'notice', text: vscode.l10n.t("Pushed {0} to {1}. A pull request into {2}: {3}", copy.branch, copy.repo, copy.base, url) });
					await vscode.env.openExternal(vscode.Uri.parse(url));
				});
				return;
			case 'remove':
				if (working) {
					refuse(vscode.l10n.t("Remove the copy when the agents working in it have finished."));
					return;
				}
				await this._repoWork(tab, vscode.l10n.t("removing the copy of {0}", copy.repo), async () => {
					await removeCopy(git, this._repoStorage(), repo, folder, copy.branch);
					this._forgetCopy(folder);
				});
				return;
		}
	}

	/* ------------------------------------------------------------ tabs */

	/** The open tabs as they were when the window closed; at least one, empty if nothing was open. */
	private _restoreTabs(): void {
		const saved = this._context.workspaceState.get<{ ids?: unknown; fresh?: unknown; active?: unknown; names?: unknown; folders?: unknown; repos?: unknown }>(openTabsKey);
		const repos = saved?.repos && typeof saved.repos === 'object' ? saved.repos as Record<string, { copy?: unknown; references?: unknown }> : {};
		const names = saved?.names && typeof saved.names === 'object' ? saved.names as Record<string, unknown> : {};
		const folders = saved?.folders && typeof saved.folders === 'object' ? saved.folders as Record<string, unknown> : {};
		const strings = (value: unknown) => Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
		const fresh = new Set(strings(saved?.fresh));
		const history = this._history();
		for (const id of strings(saved?.ids)) {
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
						chat.copy = { repo: copy.repo, base: copy.base, branch: copy.branch };
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
		const value = {
			ids: this._tabs.map(t => t.chat.id),
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
		this._context.workspaceState.update(openTabsKey, value).then(undefined, () => { /* a convenience */ });
	}

	/** A new tab beside the one in front, and in front; refused past `tabLimit()`. */
	/** `beside`: the tab it is opened next to and takes its folder from; the one in front unless said. */
	private _addTab(agent: AgentId, beside: ChatTab = this._active): ChatTab | undefined {
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
		this._active = tab;
		this._switchTo = undefined;
		this._post();
		this._postMessage({ type: 'focusInput' });
		return tab;
	}

	private _selectTab(id: string): void {
		const tab = this._tabs.find(t => t.id === id);
		if (!tab || tab === this._active) {
			return;
		}
		this._active = tab;
		this._switchTo = undefined;
		this._post();
		this._postMessage({ type: 'focusInput' });
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
		this._remembered = { ...this._remembered, agent };
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
				from.start(next);
				this._postMessage({ type: 'focusInput' });
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

	/** The title bar's New Chat, and the tab strip's "+": a new tab. */
	public newChat(): void {
		this._addTab(this._remembered.agent ?? this._selection().agent ?? 'claude');
	}

	private _agentBinaries(): Partial<Record<AgentId, string>> {
		const stored = this._context.workspaceState.get<Record<string, unknown>>(agentBinariesKey) ?? {};
		const pick = (id: AgentId) => typeof stored[id] === 'string' ? stored[id] as string : undefined;
		return { claude: pick('claude'), codex: pick('codex') };
	}

	/**
	 * A copy picked in the agent settings, or Auto. It takes effect through
	 * detection, which replaces the backend when the copy changes — a turn
	 * running on the old one ends, and each tab's conversation resumes on the
	 * new copy at its next message, by its `ref`, as after a Refresh.
	 */
	private async _setAgentBinary(agent: AgentId, file: string | undefined): Promise<void> {
		if (agent !== 'claude' && agent !== 'codex') {
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
			if (tab.chat.agent === agent) { this._titleRequests.get(tab)?.abort(); }
			tab.backendReplaced(agent, gone);
		}
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
		const folder = (this._active as ChatTab | undefined)?.cwd;
		// Not a folder that is gone — a chat from the history, a removed copy:
		// detection, the skills listing and Codex's one app-server start here,
		// and a process spawned in a missing folder fails as "spawn … ENOENT",
		// which reads as the agent not being installed, for every tab.
		return folder !== undefined && isDirectory(folder) ? folder : this._windowCwd();
	}

	public dispose(): void {
		this._disposed = true;
		for (const request of this._titleRequests.values()) { request.abort(); }
		this._titleRequests.clear();
		this._sleep.dispose();
		void vscode.commands.executeCommand('setContext', 'aiBrowser.keepAwakeActive', false);
		this._runs.dispose();
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
		for (const tab of this._tabs) {
			tab.close();
		}
		// After the tabs: closing one posts, and a timer set then would fire on a
		// view that is gone.
		clearTimeout(this._postTimer);
		this._postTimer = undefined;
		this._subscriptions.forEach(s => s.dispose());
	}
}

/**
 * Whether `tab` is in front of the user: the focused browser tab, or — focus
 * being in the chat view whenever its own "+" is pressed — a browser editor
 * visible in some editor group. `window.tabGroups` models no browser input, so
 * a browser editor is a visible tab with `input: undefined`: the heuristic
 * `LoginWatcher.tabInFront` and `updateCheck.ts` use, erring towards "visible".
 * `userTab` alone could name a page a file has since covered, and a screenshot
 * or a pick would then act on a page the user cannot see.
 */
function onScreen(tab: vscode.BrowserTab, focused: vscode.BrowserTab | undefined): boolean {
	if (focused === tab) {
		return true;
	}
	try {
		return vscode.window.tabGroups.all.some(group => group.activeTab !== undefined && group.activeTab.input === undefined);
	} catch {
		return true;
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
