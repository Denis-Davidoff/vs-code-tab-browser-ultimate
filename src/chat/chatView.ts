/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentRegistry, agentNames } from './agents';
import { bundledPin } from './agentBinary';
import { ChatTab, newChat, reopened, started, storedEntries, storedTextLimit, type Attachment, type StoredChat, type TabHost } from './chatTab';
import { chatTranscript, transcriptFileName } from './transcript';
import { writeChatTranscript } from '../elements/assistants';
import type { BrowserController } from '../browser/browserController';
import type {
	AgentId, AgentUsage, AttachmentKind, ChatSummary,
	ChatNews, ChatTabSummary, ChatViewState, HostToView, Selection, UsageWindow, ViewToHost,
} from './chatProtocol';
import { pickElementContext } from '../elements/elementPicker';
import { parseNews } from './news';
import { refuse } from '../core/notify';
import { plainInLabel, plainInPrompt } from '../core/notifyText';
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
 * `when: !aiBrowser.chatUnsupported`, and the three chat commands are hidden
 * from the palette by the same key — on those hosts `aiBrowser.chat.focus` does
 * not exist and every one of them would fail. Claude Code and Codex gate their
 * secondary side bar views on the same version.
 */
export const chatUnsupportedContextKey = 'aiBrowser.chatUnsupported';

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
/** The chats open as tabs, by chat id, and the one in front; restored with the window. */
const openTabsKey = 'aiBrowser.chat.openTabs';
/**
 * At most this many tabs. Each Claude Code tab is a `claude` process of its own
 * (a Codex tab is only a thread of the one app-server), and tabs working at
 * once spend the plan's limits at once.
 */
export const tabLimit = 5;
const historyLimit = 50;
/** A conversation handed over in the message itself, with no folder to write it to: its newest part. */
const transcriptInlineLimit = 60_000;
const postDelayMs = 40;

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
	private readonly _tabHost: TabHost = {
		cwd: () => this._cwd(),
		changed: () => this._post(),
		limits: (agent, windows) => { this._limits.set(agent, windows); },
		save: chat => this._save(chat),
		inHistory: id => this._history().some(c => c.id === id),
	};
	private _remembered: RememberedSelection;
	private readonly _limits = new Map<AgentId, readonly UsageWindow[]>();
	private _postTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly _subscriptions: vscode.Disposable[] = [];

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _browser: BrowserController,
	) {
		this._registry = new AgentRegistry(() => this._cwd(), id => this._agentBinaries()[id]);
		this._subscriptions.push(this._registry, this._registry.onDidChange(() => this._post()));
		this._remembered = _context.globalState.get<RememberedSelection>(selectionKey) ?? { models: {}, efforts: {} };
		this._restoreTabs();
		void this._readNews();

		this._subscriptions.push(this._registry.onDidReplace(e => this._onBackendReplaced(e.agent, e.gone)));
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
		return {
			blocked: this._blocked(),
			detecting: this._registry.detecting,
			agents: this._registry.agents,
			selection: this._selection(),
			chatId: this._active.chat.id,
			entries: this._active.chat.entries,
			running: this._active.running,
			attachments: this._active.attachments.map(a => a.chip),
			tabs: this._tabs.map((tab): ChatTabSummary => ({
				id: tab.id,
				chatId: tab.chat.id,
				title: tab.started ? tab.chat.title : vscode.l10n.t("New chat"),
				agent: tab.started ? tab.chat.agent : undefined,
				running: tab.running,
				agents: tab.agentsRunning,
				busy: tab.busy,
			})),
			activeTab: this._active.id,
			tabLimit,
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
		// The view is hidden below 1.106 by a context key, but a key is set at
		// activation and the view can resolve first; this keeps any CLI from
		// starting there regardless of which lands first.
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

	/* ------------------------------------------------------------ messages */

	private async _receive(message: ViewToHost): Promise<void> {
		switch (message.type) {
			case 'ready': {
				this._viewReady = true;
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
				await this._send(message.text, message.tabId);
				return;
			case 'stop':
				this._active.stop();
				return;
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

	private async _send(text: string, tabId?: string): Promise<void> {
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
		// the text back matters most.
		void this._rememberInput(text);
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
		const attachments = tab.attachments;
		if (!text.trim() && !attachments.length) {
			return;
		}
		tab.attachments = [];
		this._switchTo = undefined;
		await tab.send(text, attachments, agent, model, effort, backend);
		this._saveTabs();
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

	private async _makeAttachment(kind: AttachmentKind): Promise<Attachment | undefined> {
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
			return { chip: { id, kind, label: path.basename(file.fsPath) }, text: `Attached file: ${file.fsPath}${shown !== file.fsPath ? ` (${shown} in the workspace)` : ''}` };
		}

		// Two refusals, because the fixes are unrelated (Recipe, step 3): without
		// the grant no tab can be seen at all, open or not.
		if (!isBrowserApiGranted()) {
			refuse(vscode.l10n.t("Browser API not enabled — click \"Enable Browser API\" in the status bar."));
			return undefined;
		}
		const tab = this._browser.userTab;
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
		if (tab.started || tab.busy) {
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
		const saved = this._context.workspaceState.get<{ ids?: unknown; fresh?: unknown; active?: unknown }>(openTabsKey);
		const strings = (value: unknown) => Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
		const fresh = new Set(strings(saved?.fresh));
		const history = this._history();
		for (const id of strings(saved?.ids)) {
			const stored = history.find(c => c.id === id);
			if (this._tabs.length >= tabLimit) {
				break;
			}
			if (stored) {
				this._tabs.push(new ChatTab(this._tabHost, reopened(stored)));
			} else if (fresh.has(id)) {
				// A tab nothing was sent from: it has no history to come back from,
				// but it comes back with its chat id, which its draft is kept under.
				this._tabs.push(new ChatTab(this._tabHost, newChat(this._remembered.agent ?? 'claude', id)));
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
			active: this._active.chat.id,
		};
		const json = JSON.stringify(value);
		if (json === this._tabsSaved) {
			return;
		}
		this._tabsSaved = json;
		this._context.workspaceState.update(openTabsKey, value).then(undefined, () => { /* a convenience */ });
	}

	/** A new tab beside the one in front, and in front; refused past `tabLimit`. */
	private _addTab(agent: AgentId): ChatTab | undefined {
		if (this._tabs.length >= tabLimit) {
			refuse(vscode.l10n.t("{0} chats are open — close one to open another.", tabLimit));
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
			case 'replace':
				// The same tab, another conversation: its draft goes with it.
				from.start(newChat(to));
				this._postMessage({ type: 'focusInput' });
				return;
			case 'continue': {
				if (this._tabs.length >= tabLimit) {
					refuse(vscode.l10n.t("{0} chats are open — close one to open another.", tabLimit));
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
