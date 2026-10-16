/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentRegistry, agentNames, type BrowserServer } from './agents';
import { sweepBrowserConfigs } from './claudeAgent';
import { bundledPin } from './agentBinary';
import { ChatTab, newChat, reopened, started, storedEntries, storedTextLimit, type Attachment, type StoredChat, type TabHost } from './chatTab';
import { chatTranscript, transcriptFileName } from './transcript';
import { writeChatTranscript } from '../elements/assistants';
import { savePng } from '../browser/clipboardImage';
import type { BrowserController } from '../browser/browserController';
import type {
	AgentId, AgentUsage, ApprovalMode, AttachmentKind, ChatSummary,
	ChatNews, ChatTabSummary, ChatViewState, HostToView, Selection, UsageWindow, ViewToHost,
} from './chatProtocol';
import { pickElementContext, pickForChat } from '../elements/elementPicker';
import { parseNews } from './news';
import { confirm, refuse } from '../core/notify';
import { capAt, plainInLabel, plainInPrompt } from '../core/notifyText';
import { isBrowserApiGranted, workspaceIsRemoteFromHost } from '../setup/proposedApi';
import { pageTitle } from '../translate/translateText';
import { generateUuid } from '../core/uuid';

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
const newsHiddenKey = 'aiBrowser.chat.newsHiddenAt';
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

/** The setting as a whole number in range; anything else is the default (#184's rule). */
export function tabLimit(): number {
	const value = vscode.workspace.getConfiguration().get<unknown>(tabLimitSetting);
	return typeof value === 'number' && Number.isInteger(value) && value >= 1
		? Math.min(value, maxTabLimit)
		: defaultTabLimit;
}
const historyLimit = 50;
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

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
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
		cwd: () => this._cwd(),
		projectRoot: () => vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file')?.uri.fsPath,
		changed: () => { this._post(); this._drainQueues(); },
		limits: (agent, windows) => { this._limits.set(agent, windows); },
		save: chat => this._save(chat),
		inHistory: id => this._history().some(c => c.id === id),
		approvalMode: key => this._approvalPolicy()[key] ?? 'ask',
		noteServer: server => this._noteServer(server),
	};
	private _remembered: RememberedSelection;
	private readonly _limits = new Map<AgentId, readonly UsageWindow[]>();
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
		this._registry = new AgentRegistry(() => this._cwd(), id => this._agentBinaries()[id], browserServer);
		void sweepBrowserConfigs().catch(() => { /* swept with the temp directory */ });
		this._subscriptions.push(this._registry, this._registry.onDidChange(() => this._post()));
		this._remembered = _context.globalState.get<RememberedSelection>(selectionKey) ?? { models: {}, efforts: {} };
		this._restoreTabs();
		void this._readNews();

		this._subscriptions.push(this._registry.onDidReplace(e => this._onBackendReplaced(e.agent, e.gone)));
		// A lower limit closes nothing: the tabs open stay, and "+" comes back
		// once enough of them are closed.
		this._subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(tabLimitSetting)) {
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
		return {
			blocked: this._blocked(),
			detecting: this._registry.detecting,
			agents: this._registry.agents,
			selection: this._selection(),
			chatId: this._active.chat.id,
			entries: this._active.chat.entries,
			running: this._active.running,
			attachments: this._active.attachments.map(a => a.chip),
			pendingSends: this._active.pendingSends,
			tabs: this._tabs.map((tab): ChatTabSummary => ({
				id: tab.id,
				chatId: tab.chat.id,
				title: tab.title ?? vscode.l10n.t("New chat"),
				agent: tab.started ? tab.chat.agent : undefined,
				running: tab.running,
				agents: tab.agentsRunning,
				busy: tab.busy,
				queued: tab.queuedCount,
				status: tab.status,
			})),
			activeTab: this._active.id,
			tabLimit: limit,
			approvals: { policy: this._approvalPolicy(), servers: this._approvalServers() },
			switchTo: this._switchTo,
			hasBrowserTab: this._browser.hasOpenTabs,
			browserApi: isBrowserApiGranted(),
			news: this._news,
			newsHidden: this._newsHidden(),
		};
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
				this._post();
				return;
			}
			case 'openAttachment':
				await this._openAttachment(message.id);
				return;
			case 'approve':
				// The card is in whichever tab holds it; an id is unique to its question.
				for (const tab of this._tabs) {
					tab.answer(message.id, message.allow);
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
				this._post();
				return;
			}
			case 'stopAgent':
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
					this._tabs.find(t => t.id === message.id)?.rename(title);
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
		}
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
	private async _send(text: string, tabId?: string, given?: Attachment[]): Promise<void> {
		const queued = given !== undefined;
		if (this._blocked()) {
			return;
		}
		// The tab it was typed in, whatever is in front by now: the state post
		// that shows another tab is up to 40 ms behind the click that chose it.
		const tab = tabId ? this._tabs.find(t => t.id === tabId) : this._active;
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
		await tab.send(text, attachments, agent, model, effort, backend);
		this._saveTabs();
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
				this._send(next.text, tab.id, next.attachments)
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
		if (!tab.chat.entries.length && !tab.busy) {
			return;
		}
		this._giveBackQueue(tab);
		const next = newChat(tab.chat.agent);
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
			const folder = vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file')?.uri.fsPath ?? os.homedir();
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

	/* ------------------------------------------------------------ usage */

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
			return answer.error && live?.length ? { ...answer, windows: live, error: undefined } : answer;
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
		if (tab.started || tab.busy || tab.chat.named) {
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

	/* ------------------------------------------------------------ tabs */

	/** The open tabs as they were when the window closed; at least one, empty if nothing was open. */
	private _restoreTabs(): void {
		const saved = this._context.workspaceState.get<{ ids?: unknown; fresh?: unknown; active?: unknown; names?: unknown }>(openTabsKey);
		const names = saved?.names && typeof saved.names === 'object' ? saved.names as Record<string, unknown> : {};
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
	private _addTab(agent: AgentId): ChatTab | undefined {
		if (this._tabs.length >= tabLimit()) {
			refuse(vscode.l10n.t("{0} chats are open — close one to open another.", this._tabs.length));
			return undefined;
		}
		const tab = new ChatTab(this._tabHost, newChat(agent));
		this._tabs.splice(this._tabs.indexOf(this._active) + 1, 0, tab);
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
					file = await writeChatTranscript(markdown, transcriptFileName(chat.title, now));
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
			tab.backendReplaced(agent, gone);
		}
	}

	/** Where the agents work: the first local folder, else the home directory. */
	private _cwd(): string {
		const folder = vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file');
		return folder?.uri.fsPath ?? os.homedir();
	}

	public dispose(): void {
		this._disposed = true;
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
