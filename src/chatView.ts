/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { chatTitle, toolOutputLimit, type AgentEvent } from './agentProtocol';
import { AgentRegistry, agentNames, type AgentBackend, type AgentSession, type TurnImage } from './agents';
import type { BrowserController } from './browserController';
import type {
	AgentId, AgentUsage, AttachmentChip, AttachmentKind, ChatEntry, ChatStats, ChatSummary,
	ChatViewState, HostToView, Selection, ToolEntry, UsageWindow, ViewToHost,
} from './chatProtocol';
import { pickElementContext } from './elementPicker';
import { refuse } from './notify';
import { plainInLabel, plainInPrompt } from './notifyText';
import { isBrowserApiGranted, workspaceIsRemoteFromHost } from './proposedApi';
import { pageTitle } from './translateText';
import { generateUuid } from './uuid';

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
const historyLimit = 50;
const entryLimit = 400;
const storedTextLimit = 20_000;
const storedToolLimit = 4_000;
const postDelayMs = 40;

interface StoredChat {
	id: string;
	title: string;
	/** Whose conversation this is. Fixed by the first message; see `_started`. */
	agent: AgentId;
	owned?: boolean;
	ref?: string;
	createdAt: number;
	updatedAt: number;
	entries: ChatEntry[];
	stats: ChatStats;
}

interface RememberedSelection {
	agent?: AgentId;
	models: Partial<Record<AgentId, string>>;
	/** Keyed by `<agent>:<model>`, so each model keeps its own position. */
	efforts: Record<string, string>;
}

interface Attachment {
	readonly chip: AttachmentChip;
	readonly text?: string;
	readonly image?: TurnImage;
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private _view: vscode.WebviewView | undefined;
	private _viewReady = false;
	private _queued: HostToView[] = [];
	private readonly _registry: AgentRegistry;
	private _chat: StoredChat;
	private _session: AgentSession | undefined;
	private _sessionEvents: vscode.Disposable | undefined;
	private _attachments: Attachment[] = [];
	/** Set between two messages of one turn, so the next text starts a new block. */
	private _textBreak = false;
	/**
	 * The prompts whose turns have not ended, oldest first, each with the chat's
	 * token totals at the moment its turn began. A turn's tokens are the
	 * difference at its end, which is right for both agents: Claude Code adds
	 * each turn's usage to the totals, Codex replaces them with the thread's
	 * running total.
	 *
	 * **A queue, because Claude Code answers a message sent mid-turn with a turn
	 * of its own.** With one baseline the first `result` was written onto the
	 * *latest* prompt — the queued one — and the second turn showed nothing.
	 * A queued prompt's turn begins when the one before it ends, so that is
	 * when its baseline and start time are taken. A Codex message sent mid-turn
	 * steers the running turn instead and is not queued.
	 */
	private _pending: { entry: UserEntry; base?: TokenBase; startedAt?: number }[] = [];
	/** Added to a cumulative token report; see the `tokens` case. Per session. */
	private _tokenOffset: TokenBase = { input: 0, output: 0, cached: 0 };
	private _remembered: RememberedSelection;
	private readonly _limits = new Map<AgentId, readonly UsageWindow[]>();
	private _postTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly _subscriptions: vscode.Disposable[] = [];

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _browser: BrowserController,
	) {
		this._registry = new AgentRegistry(() => this._cwd());
		this._subscriptions.push(this._registry, this._registry.onDidChange(() => this._post()));
		this._remembered = _context.globalState.get<RememberedSelection>(selectionKey) ?? { models: {}, efforts: {} };
		this._chat = this._newChat(this._remembered.agent ?? 'claude');

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
				this._endTurnHere();
				void this._save();
				this._dropSession();
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
		}, postDelayMs);
	}

	private _state(): ChatViewState {
		return {
			blocked: this._blocked(),
			detecting: this._registry.detecting,
			agents: this._registry.agents,
			selection: this._selection(),
			chatId: this._chat.id,
			entries: this._chat.entries,
			running: this._session?.running ?? false,
			attachments: this._attachments.map(a => a.chip),
			hasBrowserTab: this._browser.hasOpenTabs,
			browserApi: isBrowserApiGranted(),
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
				await this._send(message.text);
				return;
			case 'stop':
				this._session?.stop();
				return;
			case 'attach':
				await this._attach(message.kind);
				return;
			case 'removeAttachment':
				this._attachments = this._attachments.filter(a => a.chip.id !== message.id);
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
		}
	}

	private _fail(err: unknown): void {
		this._push({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
	}

	/* ------------------------------------------------------------ selection */

	/**
	 * The agent, model and effort in force, made valid against what was
	 * detected: an agent that is no longer available, a model it no longer
	 * lists or an effort the model does not take falls back rather than being
	 * sent to a CLI that would refuse it.
	 */
	private _selection(): Selection {
		const agents = this._registry.agents;
		const available = agents.filter(a => a.available);
		const agent = this._started()
			? agents.find(a => a.id === this._chat.agent)
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
		const next: RememberedSelection = {
			agent: selection.agent ?? this._remembered.agent,
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

		// A conversation belongs to one agent, so switching agents mid-chat
		// starts a new one; the old one stays in the history.
		if (selection.agent && selection.agent !== before.agent && this._started()) {
			this.newChat(selection.agent);
			this._push({ kind: 'notice', text: vscode.l10n.t("Started a new chat with {0}. The previous one is in the history.", agentNames[selection.agent]) });
			return;
		}
		this._post();
	}

	/* ------------------------------------------------------------ turns */

	private async _send(text: string): Promise<void> {
		if (this._blocked()) {
			return;
		}
		// Sent while the agents were still being looked for: wait for the answer
		// rather than refuse. Refusing lost the message — the webview clears its
		// draft on send — and told the user to install an agent that was there.
		if (this._registry.detecting) {
			await this._registry.detect();
		}
		const { agent, model, effort } = this._selection();
		const backend = agent && this._registry.backend(agent);
		if (!agent || !model || !backend) {
			const problems = this._registry.agents.map(a => a.problem).filter(Boolean);
			this._push({ kind: 'error', text: problems.length ? problems.join('\n') : vscode.l10n.t("No agent is available. Install Claude Code or Codex, then press Refresh.") });
			// Kept in the chat rather than lost, so it can be copied and sent again.
			if (text.trim()) {
				this._push({ kind: 'notice', text: vscode.l10n.t("Not sent: {0}", text) });
			}
			return;
		}
		const attachments = this._attachments;
		if (!text.trim() && !attachments.length) {
			return;
		}
		this._attachments = [];

		if (!this._started()) {
			this._chat.agent = agent;
			this._chat.owned = true;
			this._chat.title = chatTitle(text || attachments[0]?.chip.label || '');
			this._chat.createdAt = Date.now();
		}
		this._textBreak = false;
		const entry: UserEntry = { kind: 'user', text, attachments: attachments.map(a => a.chip.label), at: Date.now() };
		const running = this._session?.running ?? false;
		if (!running) {
			this._pending = [{ entry, base: this._tokenBase(), startedAt: entry.at }];
		} else if (agent === 'claude') {
			this._pending.push({ entry });
		}
		this._push(entry);

		const prompt = [text, ...attachments.map(a => a.text).filter((t): t is string => !!t)].filter(Boolean).join('\n\n');
		const images = attachments.map(a => a.image).filter((i): i is TurnImage => !!i);

		const chat = this._chat;
		const session = this._ensureSession(backend);
		chat.stats.turns++;
		try {
			await session.send({ text: prompt, images }, model, effort);
		} catch (err) {
			// Only into the chat it was sent from: by now the user may have moved
			// to another one, which this failure is nothing to do with.
			if (this._session === session && this._chat === chat) {
				this._push({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
			}
		}
		this._post();
		// Not a chat the user has deleted in the meantime: the send can take
		// seconds on a cold app-server, and saving here wrote the deleted chat —
		// its prompt included — back into the history.
		if (chat === this._chat || this._history().some(c => c.id === chat.id)) {
			await this._save(chat);
		}
	}

	private _tokenBase(): TokenBase {
		const st = this._chat.stats;
		return { input: st.inputTokens, output: st.outputTokens, cached: st.cachedTokens };
	}

	private _ensureSession(backend: AgentBackend): AgentSession {
		if (this._session) {
			return this._session;
		}
		const session = backend.openSession(this._cwd(), this._chat.ref, this._chat.stats.costUsd);
		this._tokenOffset = { input: 0, output: 0, cached: 0 };
		const chatId = this._chat.id;
		this._session = session;
		this._sessionEvents = session.onEvent(event => {
			if (this._session === session && this._chat.id === chatId) {
				this._onAgentEvent(event);
			}
		});
		return session;
	}

	private _onAgentEvent(event: AgentEvent): void {
		const chat = this._chat;
		const last = chat.entries[chat.entries.length - 1];
		switch (event.type) {
			case 'textBreak':
				this._textBreak = true;
				return;
			case 'text':
				this._endThinking();
				if (last?.kind === 'assistant' && !this._textBreak) {
					last.text += event.text;
				} else {
					chat.entries.push({ kind: 'assistant', text: event.text });
				}
				this._textBreak = false;
				break;
			case 'thinking':
				if (last?.kind === 'thinking' && last.endedAt === undefined) {
					last.text += event.text;
				} else {
					chat.entries.push({ kind: 'thinking', text: event.text, startedAt: Date.now() });
				}
				break;
			case 'tool':
				this._endThinking();
				this._textBreak = true;
				chat.entries.push({ kind: 'tool', id: event.id, tool: event.tool.kind, name: event.tool.name, detail: event.tool.detail, input: event.tool.input, added: event.tool.added, removed: event.tool.removed, status: 'running', startedAt: Date.now() });
				break;
			case 'toolUpdate': {
				const entry = this._tool(event.id);
				if (!entry) {
					return;
				}
				const u = event.update;
				if (u.output !== undefined) {
					entry.output = clipText(u.append ? (entry.output ?? '') + u.output : u.output);
				}
				if (u.input !== undefined) {
					entry.input = u.input;
				}
				if (u.added !== undefined) {
					entry.added = u.added;
				}
				if (u.removed !== undefined) {
					entry.removed = u.removed;
				}
				if (u.exitCode !== undefined) {
					entry.exitCode = u.exitCode;
				}
				if (u.status) {
					entry.status = u.status;
					entry.endedAt = Date.now();
				}
				break;
			}
			case 'notice':
				chat.entries.push({ kind: 'notice', text: event.text });
				break;
			case 'session':
				chat.ref = event.id;
				void this._save();
				break;
			case 'tokens':
				if (event.cumulative) {
					// Codex's figure is the thread's running total, and it survives a
					// restart: measured, a thread resumed in a new app-server reported
					// 39 496 after a second turn, the first having ended at 19 740. A
					// total that ever comes back *lower* than what is already counted
					// is a counter that started again, so it is added on top rather
					// than allowed to take the chat's totals backwards.
					const off = this._tokenOffset;
					if (event.input + off.input < chat.stats.inputTokens) {
						this._tokenOffset = { input: chat.stats.inputTokens, output: chat.stats.outputTokens, cached: chat.stats.cachedTokens };
					}
					chat.stats.inputTokens = this._tokenOffset.input + event.input;
					chat.stats.outputTokens = this._tokenOffset.output + event.output;
					chat.stats.cachedTokens = this._tokenOffset.cached + event.cached;
				} else {
					chat.stats.inputTokens += event.input;
					chat.stats.outputTokens += event.output;
					chat.stats.cachedTokens += event.cached;
				}
				if (event.costUsd !== undefined) {
					chat.stats.costUsd = (chat.stats.costUsd ?? 0) + event.costUsd;
				}
				break;
			case 'limits':
				this._limits.set(chat.agent, event.windows);
				break;
			case 'turnEnd': {
				this._endThinking();
				this._textBreak = false;
				const now = Date.now();
				// A tool still marked running when its turn is over will never be
				// told otherwise; leaving it blinking would say work is going on.
				for (const entry of chat.entries) {
					if (entry.kind === 'tool' && entry.status === 'running') {
						entry.status = event.error ? 'failed' : 'done';
						entry.endedAt = now;
					}
				}
				// The oldest prompt still waiting is the one this turn answered.
				const done = this._pending.shift();
				if (done && done.entry.at !== undefined) {
					done.entry.workedMs = now - (done.startedAt ?? done.entry.at);
					const base = done.base;
					const st = chat.stats;
					// Shown only when the agent reported anything: a turn that
					// failed before reaching the model has no tokens to show.
					if (base && (st.inputTokens > base.input || st.outputTokens > base.output)) {
						done.entry.tokensIn = st.inputTokens - base.input;
						done.entry.tokensOut = st.outputTokens - base.output;
						done.entry.tokensCached = Math.max(0, st.cachedTokens - base.cached);
					}
				}
				// The next queued prompt's turn starts now — or, when the session
				// has stopped, none of them will get one.
				if (this._session?.running && this._pending.length) {
					this._pending[0].base = this._tokenBase();
					this._pending[0].startedAt = now;
				} else {
					this._pending = [];
				}
				if (event.error) {
					chat.entries.push(event.error === 'Stopped.'
						? { kind: 'notice', text: vscode.l10n.t("Stopped.") }
						: { kind: 'error', text: event.error });
				}
				chat.updatedAt = now;
				void this._save();
				break;
			}
		}
		this._post();
	}

	/** The tool entry a result belongs to, looked up from the end: results follow their calls. */
	private _tool(id: string): ToolEntry | undefined {
		for (let i = this._chat.entries.length - 1; i >= 0; i--) {
			const entry = this._chat.entries[i];
			if (entry.kind === 'tool' && entry.id === id) {
				return entry;
			}
		}
		return undefined;
	}

	private _endThinking(): void {
		for (let i = this._chat.entries.length - 1; i >= 0; i--) {
			const entry = this._chat.entries[i];
			if (entry.kind === 'thinking' && entry.endedAt === undefined) {
				entry.endedAt = Date.now();
			}
			if (entry.kind === 'user') {
				return;
			}
		}
	}

	private _push(entry: ChatEntry): void {
		this._chat.entries.push(entry);
		this._chat.updatedAt = Date.now();
		this._post();
	}

	/* ------------------------------------------------------------ attachments */

	private async _attach(kind: AttachmentKind): Promise<void> {
		const attachment = await this._makeAttachment(kind);
		if (attachment) {
			this._attachments.push(attachment);
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
		const stats = this._started() ? { ...this._chat.stats } : undefined;
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

	private async _save(chat = this._chat): Promise<void> {
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

	private _openChat(id: string): void {
		const stored = this._history().find(c => c.id === id);
		if (!stored || stored.id === this._chat.id) {
			return;
		}
		this._endTurnHere();
		void this._save();
		this._dropSession();
		this._attachments = [];
		this._chat = { ...stored, entries: stored.entries.map(settled), stats: { ...stored.stats } };
		this._post();
	}

	private async _deleteChat(id: string): Promise<void> {
		try {
			await this._context.workspaceState.update(historyKey, this._history().filter(c => c.id !== id));
		} catch {
			// Best effort, as above.
		}
		if (id === this._chat.id) {
			this._pending = [];
			this._dropSession();
			this._chat = this._newChat(this._chat.agent);
			this._post();
		}
		this.showHistory(true);
	}

	public newChat(agent?: AgentId): void {
		this._endTurnHere();
		void this._save();
		this._dropSession();
		this._attachments = [];
		this._chat = this._newChat(agent ?? this._selection().agent ?? 'claude');
		this._post();
		this._postMessage({ type: 'focusInput' });
	}

	public refreshAgents(): void {
		if (!this._blocked()) {
			void this._registry.detect();
		}
	}

	/**
	 * Whether the user has said anything yet. Not `entries.length`: a notice
	 * ("Started a new chat with Codex") is an entry too, and counting it made the
	 * fresh chat belong to the agent the user had just switched away from.
	 */
	private _started(): boolean {
		return started(this._chat);
	}

	private _newChat(agent: AgentId): StoredChat {
		const now = Date.now();
		return {
			id: generateUuid(), title: 'New chat', agent, createdAt: now, updatedAt: now, entries: [],
			stats: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, turns: 0 },
		};
	}

	private _dropSession(): void {
		this._sessionEvents?.dispose();
		this._sessionEvents = undefined;
		this._session?.dispose();
		this._session = undefined;
		this._pending = [];
	}

	/**
	 * A Refresh found another copy of an agent and replaced its backend, which
	 * disposed every session it held — this chat's included. The chat lets go of
	 * it, so the next message opens a session on the new backend and resumes the
	 * same conversation by its `ref`. A turn that was running is ended here,
	 * since the session that would have ended it is gone.
	 */
	private _onBackendReplaced(agent: AgentId, gone: boolean): void {
		if (!this._session || this._chat.agent !== agent) {
			return;
		}
		this._endTurnHere();
		this._sessionEvents?.dispose();
		this._sessionEvents = undefined;
		this._session = undefined;
		this._pending = [];
		this._push({
			kind: 'notice',
			text: gone
				? vscode.l10n.t("{0} is no longer installed. Install it again, then press Refresh to continue this conversation.", agentNames[agent])
				: vscode.l10n.t("{0} was replaced by another installed copy; the conversation continues with it.", agentNames[agent]),
		});
	}

	/**
	 * Ends the running turn in the chat itself, for every path that lets go of a
	 * session mid-turn: New Chat, another chat from the history, an agent
	 * switch, deleting it, a replaced backend, the window closing. The session
	 * that would have reported the end is being disposed and says nothing, so
	 * without this the chat was saved with its tool rows "Running…" and its
	 * thinking still shimmering — and showed them so for good when reopened.
	 * The turn's state is read from the chat (`_pending`), not from the
	 * session, whose `running` a dispose may already have cleared.
	 */
	private _endTurnHere(): void {
		if (this._session?.running || this._pending.length) {
			this._onAgentEvent({ type: 'turnEnd', error: 'Stopped.' });
		}
		this._pending = [];
	}

	/** Where the agents work: the first local folder, else the home directory. */
	private _cwd(): string {
		const folder = vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file');
		return folder?.uri.fsPath ?? os.homedir();
	}

	public dispose(): void {
		this._endTurnHere();
		void this._save();
		clearTimeout(this._postTimer);
		this._dropSession();
		this._subscriptions.forEach(s => s.dispose());
	}
}

function clipText(text: string): string {
	return text.length > toolOutputLimit ? `${text.slice(-toolOutputLimit)}` : text;
}

type UserEntry = Extract<ChatEntry, { kind: 'user' }>;

interface TokenBase {
	readonly input: number;
	readonly output: number;
	readonly cached: number;
}

/**
 * Whether the user has started this conversation — which fixes its agent.
 *
 * Not `entries.length`: a notice ("Started a new chat with Codex") is an entry
 * too, and counting it made the fresh chat belong to the agent the user had just
 * switched away from. And not "has a user entry" alone either: the history keeps
 * only the newest entries, so a long turn could push every prompt out, and a
 * chat reopened that way read as unstarted — taking the globally remembered
 * agent and handing it the other agent's session id. `owned` and `ref` survive
 * any truncation.
 */
function started(chat: StoredChat): boolean {
	return chat.owned === true || chat.ref !== undefined || chat.entries.some(e => e.kind === 'user');
}

/**
 * The entries as stored in the history: the newest `entryLimit`, long texts and
 * tool bodies cut, and **the latest prompt kept even when the window would
 * drop it**, so a reopened chat never opens on rows that answer nothing.
 */
function storedEntries(entries: readonly ChatEntry[]): ChatEntry[] {
	let kept = entries.slice(-entryLimit);
	if (!kept.some(e => e.kind === 'user')) {
		const prompt = [...entries].reverse().find(e => e.kind === 'user');
		if (prompt) {
			kept = [prompt, ...kept.slice(1)];
		}
	}
	return kept.map(entry => {
		if ((entry.kind === 'assistant' || entry.kind === 'user' || entry.kind === 'thinking') && entry.text.length > storedTextLimit) {
			return { ...entry, text: `${entry.text.slice(0, storedTextLimit)}\n\n[…]` };
		}
		if (entry.kind === 'tool') {
			// The history is rewritten whole on every save; a full 20 000-character
			// body per tool row made each save tens of megabytes.
			return { ...entry, input: cut(entry.input), output: cut(entry.output) };
		}
		return entry;
	});
}

function cut(text: string | undefined): string | undefined {
	return text !== undefined && text.length > storedToolLimit ? `${text.slice(0, storedToolLimit)}\n…` : text;
}

/**
 * An entry as a chat reopened from the history should show it: nothing in a
 * stored chat is still running. Chats saved mid-turn by an earlier build kept
 * their rows "Running…" and their thinking open for good.
 */
function settled(entry: ChatEntry): ChatEntry {
	if (entry.kind === 'tool' && entry.status === 'running') {
		return { ...entry, status: 'failed', endedAt: entry.endedAt ?? entry.startedAt };
	}
	if (entry.kind === 'thinking' && entry.endedAt === undefined) {
		return { ...entry, endedAt: entry.startedAt };
	}
	return entry;
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
