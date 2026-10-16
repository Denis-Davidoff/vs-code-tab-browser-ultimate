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

export interface ToolEntry {
	readonly kind: 'tool';
	readonly id: string;
	readonly tool: ToolKind;
	readonly name: string;
	detail?: string;
	/** The command, the diff, the arguments. */
	input?: string;
	output?: string;
	status: 'running' | 'done' | 'failed';
	exitCode?: number;
	added?: number;
	removed?: number;
	readonly startedAt: number;
	endedAt?: number;
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
	| { readonly kind: 'notice'; readonly text: string }
	| { readonly kind: 'error'; readonly text: string };

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
}

export type HostToView =
	| { readonly type: 'state'; readonly state: ChatViewState }
	/** `refresh`: update an open panel in place; never open or close it. */
	| { readonly type: 'history'; readonly chats: readonly ChatSummary[]; readonly refresh?: boolean }
	| { readonly type: 'usage'; readonly usage: readonly AgentUsage[]; readonly stats?: ChatStats; readonly loading: boolean }
	| { readonly type: 'focusInput' };

export type ViewToHost =
	| { readonly type: 'ready' }
	| { readonly type: 'select'; readonly selection: Selection }
	| { readonly type: 'send'; readonly text: string }
	| { readonly type: 'stop' }
	| { readonly type: 'attach'; readonly kind: AttachmentKind }
	| { readonly type: 'removeAttachment'; readonly id: string }
	| { readonly type: 'usage' }
	| { readonly type: 'openChat'; readonly id: string }
	| { readonly type: 'deleteChat'; readonly id: string }
	| { readonly type: 'newChat' }
	/** Through the host: `navigator.clipboard` in a webview depends on the host granting it. */
	| { readonly type: 'copy'; readonly text: string }
	/** The composer's browser button: a new browser tab, nothing else. */
	| { readonly type: 'openBrowser' }
	| { readonly type: 'setNewsHidden'; readonly hidden: boolean }
	| { readonly type: 'refreshAgents' };
