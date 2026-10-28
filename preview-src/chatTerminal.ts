/*
 * What the chat's menus, chips and marks say about terminals and agents.
 *
 * A terminal can be PINNED to a conversation (the agent of that conversation
 * then reads and types in it through the `terminal_*` tools), and "Ask agent"
 * from a terminal pins it to a new or an open conversation. The host owns the
 * pins and posts them as chips and summaries; everything the view DECIDES about
 * them — which rows a menu has and why one is disabled, which marks a terminal
 * tab carries, what a chip says, the composer's placeholder — is here, as plain
 * data, so `chat.ts` only draws it and `npm test` can check it.
 *
 * Pure: types only from the protocol, nothing from the DOM, and no relative value
 * import (a module `npm test` loads may not have one). Nothing here assumes a
 * terminal is editor-only: it works on whatever terminals a state carries, and a
 * state with none (the Chrome side panel, a website with terminals off) gets no
 * rows, no marks and the plain placeholder.
 */

import type { AgentId, AttachmentChip, ChatAgent, ChatTabSummary, TerminalTabSummary } from '../src/chat/chatProtocol';

/** A name chosen by the user, kept to a length a menu row and a tooltip can hold. */
export function shortName(name: string, max = 40): string {
	const text = name.replace(/\s+/g, ' ').trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Whether a folder is somebody's home directory, by its shape. The host decides
 * what a conversation's folder is (`isHome` there is by real path); the view only
 * has the path a terminal started in, and uses this to SAY that an agent started
 * there has no project — a guess that is wrong only by saying too little.
 */
export function looksLikeHomeDirectory(path: string): boolean {
	return /^\/(?:Users|home)\/[^/]+\/?$/.test(path) || path === '/root' || /^[A-Za-z]:[\\/]Users[\\/][^\\/]+[\\/]?$/.test(path);
}

/* ------------------------------------------------------------------ Ask agent */

export interface AskNewRow {
	readonly kind: 'new';
	readonly agent: AgentId;
	readonly icon: string;
	readonly label: string;
	readonly description: string;
	readonly disabled: boolean;
}

export interface AskTabRow {
	readonly kind: 'tab';
	readonly tabId: string;
	readonly icon: string;
	readonly label: string;
	readonly description: string;
	/** The conversation that was in front before the terminal was entered. */
	readonly checked: boolean;
}

/** No agent can be started: one disabled row saying so, where the "new chat" rows would be. */
export interface AskNoAgentRow {
	readonly kind: 'none';
	readonly icon: string;
	readonly label: string;
	readonly description: string;
	readonly disabled: true;
}

export type AskRow = AskNewRow | AskTabRow | AskNoAgentRow;

export interface AskInput {
	readonly terminal: Pick<TerminalTabSummary, 'name' | 'cwd' | 'pinnedBy'>;
	readonly agents: readonly Pick<ChatAgent, 'id' | 'name' | 'available'>[];
	/** The agent picked in the chat's pill: its row comes first. */
	readonly defaultAgent?: AgentId;
	readonly tabs: readonly Pick<ChatTabSummary, 'id' | 'title' | 'agent' | 'status' | 'busy'>[];
	readonly frontTab: string;
	readonly tabLimit: number;
	/** Text is selected in the terminal: it goes along as context. */
	readonly hasSelection: boolean;
}

export function agentIcon(agent: AgentId): string {
	return agent === 'claude' ? 'sparkle' : agent === 'gemini' ? 'star-full' : agent === 'openrouter' ? 'cloud' : agent === 'opencode' ? 'code' : agent === 'pi' ? 'circuit-board' : 'hubot';
}

function tabStatusText(tab: Pick<ChatTabSummary, 'status' | 'busy'>): string {
	if (tab.status === 'waiting') { return 'waiting for you'; }
	if (tab.status === 'working' || tab.busy) { return 'working'; }
	if (tab.status === 'failed') { return 'ended with an error'; }
	return 'idle';
}

function tabStatusIcon(tab: Pick<ChatTabSummary, 'status' | 'busy'>): string {
	if (tab.status === 'waiting') { return 'bell'; }
	if (tab.status === 'working' || tab.busy) { return 'sync'; }
	if (tab.status === 'failed') { return 'error'; }
	return tab.status === 'unread' || tab.status === 'read' ? 'check' : 'comment';
}

function chatsOpen(count: number): string {
	return `${count} chat${count === 1 ? ' is' : 's are'} open — close one first`;
}

/**
 * The rows of the "Ask agent" menu: a new chat with each agent that can start
 * (the picked one first), then the conversations already open. A new chat is
 * disabled at the limit — said before anything happens, since the user would
 * otherwise be taken out of the terminal for nothing. The description says where
 * the agent will work (the terminal's folder) and, for the home directory, that
 * it has no project there.
 */
export function askAgentRows(input: AskInput): AskRow[] {
	const available = input.agents.filter(a => a.available);
	const ordered = [...available.filter(a => a.id === input.defaultAgent), ...available.filter(a => a.id !== input.defaultAgent)];
	const atLimit = input.tabs.length >= input.tabLimit;
	const where = looksLikeHomeDirectory(input.terminal.cwd)
		? `in ${input.terminal.cwd} — the home folder, so no project rules apply`
		: `in ${input.terminal.cwd}`;
	const rows: AskRow[] = ordered.map(agent => ({
		kind: 'new' as const,
		agent: agent.id,
		icon: agentIcon(agent.id),
		label: `New chat — ${agent.name}`,
		description: atLimit ? chatsOpen(input.tabs.length) : `${where}${input.hasSelection ? ' · with the selected text' : ''}`,
		disabled: atLimit,
	}));
	if (!rows.length) {
		rows.push({ kind: 'none', icon: 'comment', label: 'New chat', description: 'No agent is installed and signed in', disabled: true });
	}
	for (const tab of input.tabs) {
		const agent = tab.agent ? input.agents.find(a => a.id === tab.agent)?.name ?? tab.agent : 'New chat';
		const owner = input.terminal.pinnedBy;
		const note = owner?.tabId === tab.id ? ' · already pinned'
			: owner ? ` · takes it over from «${shortName(owner.title)}»` : '';
		rows.push({
			kind: 'tab',
			tabId: tab.id,
			icon: tabStatusIcon(tab),
			label: shortName(tab.title) || 'Chat',
			description: `${agent} · ${tabStatusText(tab)}${note}${input.hasSelection ? ' · with the selected text' : ''}`,
			checked: tab.id === input.frontTab,
		});
	}
	return rows;
}

/* ------------------------------------------------------------------ the "+" menu */

export interface PinRow {
	readonly id: string;
	readonly icon: string;
	readonly label: string;
	readonly description: string;
	/** Pinned to the conversation the menu was opened from. */
	readonly pinned: boolean;
}

/** One row per open terminal: pinned or not for this conversation, and who else uses it (pinning moves it). */
export function pinRows(terminals: readonly TerminalTabSummary[], tabId: string): PinRow[] {
	return terminals.map(t => {
		const pinned = t.pinnedBy?.tabId === tabId;
		const other = t.pinnedBy && !pinned ? ` · used by «${shortName(t.pinnedBy.title)}» — pinning moves it here` : '';
		return {
			id: t.id,
			icon: 'terminal',
			label: shortName(t.name),
			description: `${t.status === 'running' ? `running · ${t.cwd}` : 'ended'}${other}`,
			pinned,
		};
	});
}

/** The "+" menu's "Terminal…" row, in a few words: what is pinned to this conversation, or what the row is for. */
export function pinSummary(terminals: readonly TerminalTabSummary[], tabId: string): string {
	const n = terminals.filter(t => t.pinnedBy?.tabId === tabId).length;
	return n ? `${n} pinned to this chat` : 'Let the agent read and type in a terminal';
}

/* ------------------------------------------------------------------ marks */

export interface TerminalMark {
	readonly kind: 'unread' | 'typing' | 'pinned' | 'paused';
	readonly title: string;
}

/** The agent's own name beside the conversation's, for a tooltip: "Claude Code · Fix tests". */
export function ownerText(t: Pick<TerminalTabSummary, 'pinnedBy'>, agentName?: string): string | undefined {
	if (!t.pinnedBy) { return undefined; }
	const title = shortName(t.pinnedBy.title) || 'a chat';
	return agentName ? `${agentName} · ${title}` : title;
}

/**
 * The marks on a terminal's tab, in order: output while it was not in front, the
 * agent typing a moment ago, and who uses it (a chat icon; a pause icon while the
 * user has stopped the agent's input). Exited is the strip's own mark.
 */
export function terminalMarks(t: TerminalTabSummary, agentName?: string): TerminalMark[] {
	const marks: TerminalMark[] = [];
	const owner = ownerText(t, agentName);
	const paused = !!t.pinnedBy && t.agentControl === 'paused';
	if (t.unread) { marks.push({ kind: 'unread', title: 'New output since you last looked' }); }
	if (t.agentActive && owner && !paused) { marks.push({ kind: 'typing', title: `${owner} is typing here` }); }
	if (owner) {
		marks.push(paused
			? { kind: 'paused', title: `Used by ${owner} — its input is paused` }
			: { kind: 'pinned', title: `Used by ${owner}` });
	}
	return marks;
}

/** The "Pause agent input" / "Resume agent input" row of a terminal's menus; none while no conversation uses it. */
export function agentControlRow(t: Pick<TerminalTabSummary, 'pinnedBy' | 'agentControl'>): { readonly label: string; readonly description: string; readonly icon: string; readonly allowed: boolean } | undefined {
	if (!t.pinnedBy) { return undefined; }
	return t.agentControl === 'paused'
		? { label: 'Resume agent input', description: 'The agent may type here again', icon: 'debug-continue', allowed: true }
		: { label: 'Pause agent input', description: 'The agent can still read, but not type here', icon: 'debug-pause', allowed: false };
}

/* ------------------------------------------------------------------ conversation tabs */

type TabTerminals = NonNullable<ChatTabSummary['terminals']>;

export interface TerminalBadge {
	readonly count: number;
	readonly title: string;
}

/** The terminal icon and count on a conversation's tab; none when nothing is pinned to it. */
export function conversationBadge(tab: Pick<ChatTabSummary, 'terminals'>): TerminalBadge | undefined {
	const list: TabTerminals = tab.terminals ?? [];
	if (!list.length) { return undefined; }
	const names = list.slice(0, 3).map(t => shortName(t.name, 24)).join(', ') + (list.length > 3 ? ` and ${list.length - 3} more` : '');
	return {
		count: list.length,
		title: list.length === 1
			? `${names} is pinned — the agent can read and type there`
			: `${list.length} terminals pinned: ${names}`,
	};
}

export interface TabTerminalRow {
	readonly kind: 'go' | 'unpin';
	readonly id: string;
	readonly label: string;
	readonly icon: string;
}

/** The conversation tab's context menu rows for its pinned terminals: go there, or unpin. */
export function conversationRows(tab: Pick<ChatTabSummary, 'terminals'>): TabTerminalRow[] {
	return (tab.terminals ?? []).slice(0, 8).flatMap(t => {
		const name = `«${shortName(t.name, 28)}»${t.status === 'exited' ? ' (ended)' : ''}`;
		return [
			{ kind: 'go' as const, id: t.id, label: `Go to ${name}`, icon: 'terminal' },
			{ kind: 'unpin' as const, id: t.id, label: `Unpin ${name}`, icon: 'pinned-dirty' },
		];
	});
}

/** What the tab's label shows of its terminals; the label is refilled only when this changes (#365). */
export function conversationShown(tab: Pick<ChatTabSummary, 'terminals'>): string {
	return JSON.stringify((tab.terminals ?? []).map(t => [t.id, t.name, t.status]));
}

/* ------------------------------------------------------------------ the composer */

/** The composer's placeholder: asks about the pinned terminal while one is pinned to the conversation in front. */
export function composerPlaceholder(base: string, tab: Pick<ChatTabSummary, 'terminals'> | undefined): string {
	const list: TabTerminals = tab?.terminals ?? [];
	if (!list.length) { return base; }
	const first = `«${shortName(list[0].name, 28)}»`;
	if (list.length === 1) { return `Ask about ${first}…`; }
	if (list.length === 2) { return `Ask about ${first} and «${shortName(list[1].name, 28)}»…`; }
	return `Ask about ${first} and ${list.length - 1} more terminals…`;
}

/* ------------------------------------------------------------------ the pinned chip */

export type PinnedChip = AttachmentChip & { readonly kind: 'terminal'; readonly terminalId: string };

export function isPinChip(chip: AttachmentChip): chip is PinnedChip {
	return chip.kind === 'terminal' && chip.pinned === true && typeof chip.terminalId === 'string';
}

export const unpinTitle = 'Unpin — the agent can no longer use this terminal';

export function pinChipOpenTitle(chip: Pick<AttachmentChip, 'label' | 'terminalStatus'>): string {
	return chip.terminalStatus === 'closed' ? `${chip.label} was closed` : `Go to ${chip.label}`;
}

/** The status the chip's dot shows: a closed terminal, an ended shell, or a running one. */
export function pinChipStatus(chip: Pick<AttachmentChip, 'terminalStatus'>): 'running' | 'exited' | 'closed' {
	return chip.terminalStatus ?? 'running';
}

/** What a chip's drawn form depends on, for the "rebuild only when it changes" signature of the attachments row. */
export function chipShown(chip: AttachmentChip): unknown[] {
	return [chip.id, chip.kind, chip.label, chip.reference, chip.thumbnail?.length, chip.pinned, chip.terminalId, chip.terminalStatus, chip.terminalWatch];
}
