/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The messages between the chat view's webview and the extension host.
 *
 * Types only, and no imports: `preview-src/chat.ts` reads this file with
 * `import type`, so it is part of the webview's type-check while esbuild erases
 * it from the bundle. Anything with a value here would end up in both runtimes.
 */

export type AgentId = 'claude' | 'codex';

export interface ChatModel {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	/** Effort levels in the order the agent lists them, lowest first. Empty when the model has none. */
	readonly efforts: readonly string[];
	readonly defaultEffort?: string;
	readonly isDefault: boolean;
}

export interface ChatAgent {
	readonly id: AgentId;
	readonly name: string;
	readonly available: boolean;
	/** Why it is not available, or why its models could not be listed. */
	readonly problem?: string;
	/** Which executable is in use: its version, where it came from, its path. */
	readonly detail?: string;
	readonly models: readonly ChatModel[];
	/** Every copy of its CLI found on this machine, newest first; for the agent settings. */
	readonly copies?: readonly AgentCopy[];
	/** The path of the copy in use. */
	readonly binary?: string;
	/** How it was picked: the newest found, by hand for this project, or by the `aiBrowser.chat.<agent>Path` setting. */
	readonly choice?: 'auto' | 'pinned' | 'setting';
	/** The copy this project picked is no longer found, so the newest is used. */
	readonly pinMissing?: boolean;
	/** What the project picked, when it is missing: a path, or `bundled`. */
	readonly pinned?: string;
}

/**
 * A skill or command an agent offers in the "/" palette, read from the CLI
 * itself: Claude Code's `initialize` answer, Codex's `skills/list`.
 */
export interface ChatCommand {
	/** The name as typed, without its sigil: `one-more-review`, `pdf:pdf`. */
	readonly name: string;
	/** What goes into the message box: `/name` for Claude Code, `$name` for Codex. */
	readonly insert: string;
	/** A display name the skill gives itself, when it differs from `name`. */
	readonly title?: string;
	readonly description?: string;
	/** Claude Code's `argumentHint`: `<file>`, `[pr]`. */
	readonly hint?: string;
	readonly group: CommandGroup;
	/** The plugin it comes from, for the `plugin` group. */
	readonly plugin?: string;
	/** Codex: the skill's `SKILL.md`, which goes with the turn as a `skill` input item. */
	readonly path?: string;
}

/**
 * Where a command comes from, which is how the palette groups them:
 * the project's own, the user's, a plugin's, synced from claude.ai, shipped
 * with the CLI as a skill (`system`, Codex), or one of the CLI's built-in
 * commands (`builtin`, Claude Code).
 */
export type CommandGroup = 'project' | 'user' | 'plugin' | 'synced' | 'system' | 'builtin';

export interface AgentCopy {
	readonly path: string;
	readonly version?: string;
	/** Where it came from, in a few words: "from PATH", "bundled with …". */
	readonly source: string;
	/** The copy inside the assistant's VS Code extension, picked as such rather than by path. */
	readonly bundled?: boolean;
}

export interface UsageWindow {
	readonly label: string;
	readonly usedPercent: number;
	/** Epoch milliseconds. */
	readonly resetsAt?: number;
}

export interface AgentUsage {
	readonly agent: AgentId;
	readonly plan?: string;
	readonly windows: readonly UsageWindow[];
	readonly notes: readonly string[];
	readonly error?: string;
}

export interface ChatStats {
	inputTokens: number;
	outputTokens: number;
	cachedTokens: number;
	/** Claude reports a price; Codex does not. */
	costUsd?: number;
	turns: number;
}

export type ToolKind = 'command' | 'read' | 'edit' | 'search' | 'web' | 'agent' | 'mcp' | 'other';

/**
 * What is known about an agent the chat's agent started — a Claude Code
 * `Agent` / `Task` call, or a Codex `spawnAgent`. Filled in as the CLI reports
 * it: some of it at the call, the rest from its progress and its end.
 */
export interface AgentInfo {
	/** `general-purpose`, `Explore`, … for Claude; the collab tool for Codex. */
	type?: string;
	model?: string;
	/** Runs on after the turn that started it has ended. */
	background?: boolean;
	tokens?: number;
	toolUses?: number;
	durationMs?: number;
	lastTool?: string;
	/** Its final report, short. */
	summary?: string;
	/** Codex: the thread the agent runs in, which later status reports name. */
	threadId?: string;
	/** Its own tool calls, oldest first, capped. */
	calls: { name: string; detail?: string }[];
}

export interface ToolEntry {
	readonly kind: 'tool';
	readonly id: string;
	readonly tool: ToolKind;
	readonly name: string;
	detail?: string;
	/** The command, the diff, the arguments. */
	input?: string;
	output?: string;
	status: 'running' | 'done' | 'failed' | 'stopped';
	exitCode?: number;
	added?: number;
	removed?: number;
	readonly startedAt: number;
	endedAt?: number;
	/** Present on agent rows (`tool: 'agent'`). */
	agent?: AgentInfo;
}

export type ChatEntry =
	| {
		readonly kind: 'user'; readonly text: string; readonly attachments: readonly string[]; readonly at?: number;
		/** Set when the turn ends: how long it took and what it cost in tokens. */
		workedMs?: number; tokensIn?: number; tokensOut?: number; tokensCached?: number;
	}
	| { readonly kind: 'assistant'; text: string }
	| { readonly kind: 'thinking'; text: string; readonly startedAt: number; endedAt?: number }
	| ToolEntry
	| ApprovalEntry
	| { readonly kind: 'notice'; readonly text: string }
	| { readonly kind: 'error'; readonly text: string };

/**
 * What an approval is for — the categories of the composer's approval menu:
 * the internet (`web`), this extension's browser tools, terminal commands,
 * edits inside the project, files outside it, another MCP server's tools
 * (`mcp`, one category per server), and anything else.
 */
export type ApprovalKind = 'web' | 'browser' | 'command' | 'edit' | 'outside' | 'mcp' | 'other';

/** What a category does with a question: run it without asking, ask, or refuse it without asking. */
export type ApprovalMode = 'auto' | 'ask' | 'deny';

/**
 * The approval menu's choices, by category key: an `ApprovalKind` other than
 * `mcp`, or `mcp:<server>` for one server. A key that is absent asks.
 */
export type ApprovalPolicy = Readonly<Record<string, ApprovalMode>>;

/**
 * An agent asking before it uses a tool, answered in the chat. `pending` until
 * the user answers, the CLI withdraws it (a Stop, the turn ending), or the
 * conversation lets go of its session (`cancelled`).
 */
export interface ApprovalEntry {
	readonly kind: 'approval';
	readonly id: string;
	readonly what: ApprovalKind;
	/** The MCP server, for `what: 'mcp'`. */
	readonly server?: string;
	readonly title: string;
	readonly detail?: string;
	status: 'pending' | 'allowed' | 'denied' | 'cancelled';
	/** Answered by the approval menu's choice rather than by a click. */
	auto?: boolean;
}

export interface ChatSummary {
	readonly id: string;
	readonly title: string;
	readonly agent: AgentId;
	readonly updatedAt: number;
}

export type AttachmentKind = 'screenshot' | 'element' | 'page' | 'file';

/** What the composer shows for an attachment; the content stays in the host. */
export interface AttachmentChip {
	readonly id: string;
	readonly kind: AttachmentKind;
	readonly label: string;
	/** A small data URI for screenshots. */
	readonly thumbnail?: string;
}

export interface Selection {
	readonly agent?: AgentId;
	readonly model?: string;
	readonly effort?: string;
}

/** NEWS.md, as the empty chat shows it: the introduction and the newest entries. */
export interface ChatNews {
	readonly intro: string;
	readonly entries: readonly { readonly title: string; readonly items: readonly string[] }[];
}

export interface ChatViewState {
	/** Set when the chat cannot run in this window at all. */
	readonly blocked?: string;
	readonly detecting: boolean;
	readonly agents: readonly ChatAgent[];
	readonly selection: Selection;
	readonly chatId: string;
	readonly entries: readonly ChatEntry[];
	readonly running: boolean;
	readonly attachments: readonly AttachmentChip[];
	readonly hasBrowserTab: boolean;
	/** The `browser` proposal is granted; without it no tab can be attached, open or not. */
	readonly browserApi: boolean;
	/** Absent until NEWS.md has been read, or when it could not be. */
	readonly news?: ChatNews;
	/** The user hid "What's new", and no entry has been added since. */
	readonly newsHidden: boolean;
	/** The open conversations, in tab order; `chatId`, `entries` and the rest are the active one's. */
	readonly tabs: readonly ChatTabSummary[];
	readonly activeTab: string;
	/** `aiBrowser.chat.tabLimit`; more tabs than this can be open when it was lowered. */
	readonly tabLimit: number;
	/**
	 * The tab in front's messages not in the conversation yet, in order: sent
	 * during a turn and not yet taken in by Claude Code (`steer`), or held to be
	 * sent when the turn ends (`queue`).
	 */
	readonly pendingSends: readonly PendingSend[];
	/** The approval menu: each category's mode, and the MCP servers an agent has asked about. Per workspace. */
	readonly approvals: { readonly policy: ApprovalPolicy; readonly servers: readonly string[] };
	/** Another agent was picked for a conversation that has started: the view asks what to do. */
	readonly switchTo?: AgentId;
	/** Each agent's skills and commands, for the "/" palette; absent until listed once. */
	readonly commands: Partial<Record<AgentId, readonly ChatCommand[]>>;
}

export interface PendingSend {
	readonly id: string;
	readonly text: string;
	readonly kind: 'steer' | 'queue';
	/** Labels of the attachments that go with it. */
	readonly attachments: readonly string[];
}

export interface ChatTabSummary {
	readonly id: string;
	readonly chatId: string;
	readonly title: string;
	/** Absent while the conversation has not started, and so belongs to no agent yet. */
	readonly agent?: AgentId;
	readonly running: boolean;
	/** Agents of this conversation still working. */
	readonly agents: number;
	/** A turn or an agent is running: closing the tab stops it. */
	readonly busy: boolean;
	/** Messages queued in the tab, which closing it drops. */
	readonly queued: number;
	/** The mark on the tab; absent while nothing has been sent from it. See `ChatTab.status`. */
	readonly status?: ChatTabStatus;
}

/**
 * `waiting` while an approval in the tab waits for an answer — the work is
 * stopped on the user, so it outranks `working`; `working` while a turn or an
 * agent runs; `unread` once that ended with the
 * tab out of sight; `failed` when it ended in an error — kept until the next
 * message, since an error does not stop being one by being looked at; `read`
 * otherwise.
 */
export type ChatTabStatus = 'waiting' | 'working' | 'unread' | 'failed' | 'read';

export type HostToView =
	| { readonly type: 'state'; readonly state: ChatViewState }
	/** `refresh`: update an open panel in place; never open or close it. */
	| { readonly type: 'history'; readonly chats: readonly ChatSummary[]; readonly refresh?: boolean }
	| { readonly type: 'usage'; readonly usage: readonly AgentUsage[]; readonly stats?: ChatStats; readonly loading: boolean }
	| { readonly type: 'focusInput' }
	/** Queued messages given back by Stop: added to what is in the message box, not sent. */
	| { readonly type: 'restoreDraft'; readonly chatId: string; readonly text: string }
	/** Messages sent from this workspace, oldest first, for the composer's ↑ / ↓. */
	| { readonly type: 'inputHistory'; readonly items: readonly string[] }
	/** A Stop for one agent was refused; its button comes back. */
	| { readonly type: 'agentStopFailed'; readonly id: string };

export type ViewToHost =
	| { readonly type: 'ready' }
	| { readonly type: 'select'; readonly selection: Selection }
	/** `tabId`: the tab it was typed in, which may no longer be the one in front when it arrives. */
	/**
	 * `queue`: hold it until the running turn ends, then send it as a turn of its
	 * own (⌘/Ctrl+Enter). Otherwise, during a turn, it is added to that turn.
	 */
	| { readonly type: 'send'; readonly text: string; readonly tabId?: string; readonly mode?: 'queue' }
	/** A queued message taken back before it was sent. */
	| { readonly type: 'unqueue'; readonly id: string }
	/** The "/" menu: the tab in front starts over; its conversation stays in the history. */
	| { readonly type: 'clearChat' }
	/** The "/" menu: the tab in front's conversation as Markdown, on the clipboard or into a file the user saves. */
	| { readonly type: 'exportChat'; readonly to: 'clipboard' | 'file' }
	| { readonly type: 'stop' }
	| { readonly type: 'attach'; readonly kind: AttachmentKind }
	| { readonly type: 'removeAttachment'; readonly id: string }
	| { readonly type: 'usage' }
	| { readonly type: 'openChat'; readonly id: string }
	| { readonly type: 'deleteChat'; readonly id: string }
	| { readonly type: 'newChat' }
	| { readonly type: 'newTab' }
	| { readonly type: 'selectTab'; readonly id: string }
	| { readonly type: 'closeTab'; readonly id: string }
	/** A tab renamed by double-click; the chat keeps the name, and the first message no longer sets one. */
	| { readonly type: 'renameTab'; readonly id: string; readonly title: string }
	/** The answer to `switchTo`. */
	| { readonly type: 'switchAgent'; readonly choice: 'newTab' | 'replace' | 'continue' | 'cancel' }
	/** One agent of the conversation in front, by its row id. */
	| { readonly type: 'stopAgent'; readonly id: string }
	| { readonly type: 'approve'; readonly id: string; readonly allow: boolean }
	/** `key`: a category key (see `ApprovalPolicy`), or `all` for every category at once. */
	| { readonly type: 'setApprovalMode'; readonly key: string; readonly mode: ApprovalMode }
	/** A chip in the composer clicked: its file, its image or its text, in an editor tab. */
	| { readonly type: 'openAttachment'; readonly id: string }
	/** The copy of an agent's CLI this project uses; no `path` is Auto, the newest. */
	| { readonly type: 'setAgentBinary'; readonly agent: AgentId; readonly path?: string }
	/** VS Code's own setting for an agent's executable. */
	| { readonly type: 'openAgentSetting'; readonly agent: AgentId }
	/** Through the host: `navigator.clipboard` in a webview depends on the host granting it. */
	| { readonly type: 'copy'; readonly text: string }
	/** The composer's browser button: a new browser tab, nothing else. */
	| { readonly type: 'openBrowser' }
	| { readonly type: 'setNewsHidden'; readonly hidden: boolean }
	| { readonly type: 'refreshAgents' }
	/** The "/" palette opened: list the agent's skills again, in case one was added. */
	| { readonly type: 'listCommands'; readonly agent: AgentId };
