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
 * A skill of the chat's own, on the toolbar above the message box: a prompt
 * with parameters, run on a click or as `/name` / `$name`. Kept in
 * `globalState`, so every project has the same toolbar.
 */
/** A toolbar button's own colours, each set apart (asked for). */
export interface ToolbarColors {
	readonly text?: string;
	readonly border?: string;
	readonly icon?: string;
}

export interface ToolbarSkill {
	readonly id: string;
	/** As typed after `/` or `$`: lower case, no spaces, like a CLI's own skills. */
	readonly name: string;
	/** What is sent; `{{param}}` is replaced by the value given. */
	readonly prompt: string;
	/**
	 * Prompts sent after it, in order, each once the turn before it has ended —
	 * as messages queued with ⌘Enter are — and, where it has a check, only when
	 * the agent judged it true.
	 * Absent or empty: one prompt. The same parameters fill them.
	 */
	readonly followUps?: readonly ToolbarStep[];
	/**
	 * In the chat, as a message; to the clipboard, the marked result only;
	 * silently, the button saying it is done; or in a VS Code notification, the
	 * marked result as its text.
	 */
	readonly result: ToolbarResult;
	/** A VS Code notification when a run ends — done, failed, or stopped by its check; absent, none. */
	readonly notify?: ToolbarNotify;
	/** Which agents offer it: every one, or one. */
	readonly agents: 'all' | AgentId;
	/** A codicon name, without `codicon-`. */
	readonly icon: string;
	/** Shown beside the icon; absent shows the icon alone. */
	readonly label?: string;
	/** The button's hover text; the name when absent. */
	readonly tooltip?: string;
	/** Colours of the label, the border and the icon, each one of `toolbarColors` or `#rrggbb`; the theme's own where absent. */
	readonly colors?: ToolbarColors;
	readonly params: readonly ToolbarParam[];
}

export type ToolbarResult = 'chat' | 'clipboard' | 'silent' | 'toast';

/**
 * How a run's end is told: `auto`, a sentence of ours ("… is done", "… failed: …");
 * `text`, the user's own, where `{{skill}}`, `{{status}}`, `{{message}}`,
 * `{{result}}` and the skill's parameters are filled in (`notificationText`).
 */
export type ToolbarNotify = { readonly mode: 'auto' } | { readonly mode: 'text'; readonly text: string };

/**
 * A prompt of a toolbar skill after the first. Without a `check` it runs once
 * the step before it is over, whatever that step did. With one, the agent is
 * asked at the end of the step before to judge the check and answer with a
 * marker line (`nextDecision`); the prompt runs only on a yes, and the skill
 * stops there otherwise.
 */
export interface ToolbarStep {
	readonly prompt: string;
	readonly check?: string;
}

/** A value asked for when the skill runs, and written into the prompt as `{{name}}`. Every one is required. */
export interface ToolbarParam {
	readonly name: string;
	readonly type: 'text' | 'number' | 'choice';
	/** The longest value taken, in characters; text only. */
	readonly maxLength?: number;
	/** The value the field starts with. */
	readonly preset?: string;
	/** The values a `choice` offers. */
	readonly options?: readonly string[];
}

/** A toolbar skill running in the background (clipboard or silent), as its button shows it. */
export interface ToolbarRun {
	readonly status: 'running' | 'waiting' | 'done' | 'failed';
	/** Why it failed, or what the done state should say ("Copied", "No result markers…"). */
	readonly message?: string;
	/** The question it is stopped on, while `waiting`. */
	readonly approval?: { readonly id: string; readonly title: string; readonly detail?: string };
	/** When it ended, epoch ms: the button flashes for a moment after. */
	readonly endedAt?: number;
	/** How many runs of the skill are going, when more than one. */
	readonly count?: number;
	/** A skill whose result goes into the chat: running while the tab's turn it started runs. Stop stops that tab. */
	readonly inChat?: boolean;
	/** A skill of several prompts: the one being run, from 1, and how many there are. */
	readonly step?: number;
	readonly steps?: number;
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
	/** Tokens the conversation's context holds now — the latest request's, not a sum. */
	contextTokens?: number;
	/** The model's context window, as the CLI reports it. */
	contextWindow?: number;
	/** Compacted since `contextTokens` was reported: that figure is the size before. */
	contextCompacted?: boolean;
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
	/** A toolbar skill run in the background, not an agent the chat's agent started. */
	origin?: 'toolbar';
	/** Such a run's skill id, which its question is answered under (`toolbarApprove`). */
	skill?: string;
	/** The question such a run is stopped on, until it is answered. */
	waiting?: { readonly id: string; readonly title: string; readonly detail?: string };
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
export type ApprovalKind = 'web' | 'browser' | 'command' | 'edit' | 'outside' | 'mcp' | 'other' | 'question';

/**
 * A question with choices the agent asks the user in the middle of a turn —
 * Claude Code's `AskUserQuestion`, Codex's `request_user_input`. The turn waits
 * for the answer. Never covered by the approval menu: nothing but the user can
 * choose.
 */
export interface AgentQuestion {
	/** What the answer is sent back under: the question's index for Claude Code, its own id for Codex. */
	readonly id: string;
	/** A short label for the question, when the agent gave one. */
	readonly header?: string;
	readonly question: string;
	readonly options: readonly { readonly label: string; readonly description?: string }[];
	/** Several options may be chosen together. */
	readonly multiSelect: boolean;
	/** An answer of the user's own words is taken besides the options. */
	readonly other: boolean;
	/** The answer is a secret (Codex's `isSecret`): typed masked, and not kept in the chat. */
	readonly secret?: boolean;
}

/** Answers by question id: the labels chosen, or the user's own words. */
export type QuestionAnswers = Readonly<Record<string, readonly string[]>>;

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
	/** `what: 'question'`: the questions asked. `allowed` is answered, `denied` skipped. */
	readonly questions?: readonly AgentQuestion[];
	/** What the user answered; a secret answer is not kept. */
	answers?: QuestionAnswers;
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
	/** The chat's own skills, in toolbar order, and the background runs of them by skill id. */
	readonly toolbar: readonly ToolbarSkill[];
	readonly toolbarRuns: Readonly<Record<string, ToolbarRun>>;
	/** The toolbar skills run in the background from this chat, as rows of its agents list. */
	readonly skillAgents: readonly ToolEntry[];
	/** `aiBrowser.chat.collapseToolCalls`: tool calls start folded. */
	readonly collapseTools: boolean;
	/**
	 * How full the tab in front's context is, once its agent has said — and
	 * whether the agent can compact it (Claude Code lists `/compact`; Codex has
	 * `thread/compact/start`).
	 */
	readonly context?: { readonly used: number; readonly window?: number; readonly compacted?: boolean; readonly canCompact: boolean };
}

export interface PendingSend {
	readonly id: string;
	readonly text: string;
	readonly kind: 'steer' | 'queue';
	/** Labels of the attachments that go with it. */
	readonly attachments: readonly string[];
	/** A later prompt of a toolbar skill: its name, and which prompt of how many. */
	readonly skill?: { readonly name: string; readonly step: number; readonly steps: number; readonly check?: string; readonly background?: boolean };
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
	/** Toolbar skills run in the background from it, still going: they stop when the tab lets go of the chat. */
	readonly skillRuns: number;
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
	| { readonly type: 'agentStopFailed'; readonly id: string }
	/** A toolbar skill saved, by its id: the editor closes. */
	| { readonly type: 'toolbarSaved'; readonly id: string }
	/** A toolbar skill refused, with the reason: the editor stays open and shows it. */
	| { readonly type: 'toolbarError'; readonly message: string };

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
	/** The context pie: compact the tab's conversation with the agent's own command. */
	| { readonly type: 'compact'; readonly tabId: string }
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
	/** An approval card answered; for a question, `allow` with the answers, or no `allow` to skip it. */
	| { readonly type: 'approve'; readonly id: string; readonly allow: boolean; readonly answers?: QuestionAnswers }
	/** `key`: a category key (see `ApprovalPolicy`), or `all` for every category at once. */
	| { readonly type: 'setApprovalMode'; readonly key: string; readonly mode: ApprovalMode }
	/** A chip in the composer clicked: its file, its image or its text, in an editor tab. */
	| { readonly type: 'openAttachment'; readonly id: string }
	/** A tool call's input or output, opened as a read-only text in an editor tab. */
	| { readonly type: 'openText'; readonly name: string; readonly text: string }
	/** A diff card clicked: its before and after in VS Code's diff editor. `name` is the file it changes. */
	| { readonly type: 'openDiff'; readonly name: string; readonly diff: string }
	/** The copy of an agent's CLI this project uses; no `path` is Auto, the newest. */
	| { readonly type: 'setAgentBinary'; readonly agent: AgentId; readonly path?: string }
	/** VS Code's own setting for an agent's executable. */
	| { readonly type: 'openAgentSetting'; readonly agent: AgentId }
	/** Through the host: `navigator.clipboard` in a webview depends on the host granting it. */
	| { readonly type: 'copy'; readonly text: string }
	/** The composer's browser button: a new browser tab, nothing else. */
	| { readonly type: 'openBrowser' }
	/** The approval menu's Compact switch: `aiBrowser.chat.collapseToolCalls`, tool calls start folded. */
	| { readonly type: 'setCollapseTools'; readonly collapse: boolean }
	/** A file a tool row names (Read, an edit), clicked: opened in an editor tab, whatever kind of file. */
	| { readonly type: 'openFile'; readonly path: string }
	/** A link in a reply clicked: the built-in browser, or the system one with ⌘/Ctrl held. */
	| { readonly type: 'openLink'; readonly url: string; readonly external: boolean }
	| { readonly type: 'setNewsHidden'; readonly hidden: boolean }
	| { readonly type: 'refreshAgents' }
	/** The "/" palette opened: list the agent's skills again, in case one was added. */
	| { readonly type: 'listCommands'; readonly agent: AgentId }
	/** A toolbar skill added (no such id yet) or edited. */
	| { readonly type: 'saveToolbarSkill'; readonly skill: ToolbarSkill }
	| { readonly type: 'deleteToolbarSkill'; readonly id: string }
	/** Moved one place left (-1) or right (1). */
	| { readonly type: 'moveToolbarSkill'; readonly id: string; readonly by: -1 | 1 }
	/** Run with these parameter values, for the tab it was pressed in. */
	/** `again`: run it although a run of it is going — the user said so when asked. */
	/** `queue`: held in the tab's queue and run once its turn has ended ("Run after this turn"). */
	| { readonly type: 'runToolbarSkill'; readonly id: string; readonly values: Readonly<Record<string, string>>; readonly tabId?: string; readonly again?: boolean; readonly queue?: boolean }
	/**
	 * The answer to the question a background run is waiting on: `approvalId` is
	 * the question shown, so the answer reaches that run and no other of the skill.
	 */
	| { readonly type: 'toolbarApprove'; readonly id: string; readonly approvalId: string; readonly allow: boolean }
	| { readonly type: 'stopToolbarSkill'; readonly id: string };
