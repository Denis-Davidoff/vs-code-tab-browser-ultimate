/*
 * Terminal tabs in the chat's own tab strip.
 *
 * A terminal is not a conversation: it is never in `ChatViewState.tabs`, and the
 * strip is the only place the two kinds meet. So the strip is given each
 * terminal as a `ChatTabSummary`-shaped object — enough for the keyed tab
 * rendering, the switch animation, the rename field and the inline close
 * question to be reused as they are — carrying the terminal itself beside it.
 * Pure and under `npm test`; types only from the protocol.
 */

import type { ChatAgent, ChatTabSummary, ChatViewState, TerminalSupport, TerminalTabSummary } from '../src/chat/chatProtocol';

export interface StripTab extends ChatTabSummary {
	/** Set on a terminal's tab; absent on a conversation's. */
	readonly terminal?: TerminalTabSummary;
}

export function terminalStripTab(t: TerminalTabSummary): StripTab {
	return {
		id: t.id,
		// A terminal has no chat and no draft; the strip never reads this for one.
		chatId: '',
		title: t.name,
		agent: t.agent,
		running: t.status === 'running',
		agents: 0,
		skillRuns: 0,
		// A running shell is "working" for the one question the strip asks of a tab: closing it ends the shell.
		busy: t.status === 'running',
		queued: 0,
		terminal: t,
	};
}

/** The terminals of a state, as strip tabs, in strip order; none where the surface has no terminals. */
export function terminalStripTabs(state: Pick<ChatViewState, 'terminals'>): StripTab[] {
	return (state.terminals ?? []).map(terminalStripTab);
}

/** Every tab of the strip: the conversations first, then the terminals. */
export function stripTabs(state: Pick<ChatViewState, 'tabs' | 'terminals'>): StripTab[] {
	return [...state.tabs, ...terminalStripTabs(state)];
}

type FrontState = Pick<ChatViewState, 'terminalFront' | 'terminals' | 'chromeConnectionRequest'>;

/**
 * Whether the conversation must be on screen whatever tab the host calls the
 * front: something in it waits for the user's answer, and the terminal's column
 * covers it. A pending Chrome pairing request (Allow / Deny, the only place to
 * answer it) lives in the conversation's column, which is hidden while a
 * terminal is in front, and nothing else would tell the user it is waiting. The
 * terminal is not closed or forgotten: it comes back when the request is
 * answered or withdrawn. Informational lines of that column (the terminal's own
 * "could not be started") stay visible above the terminal by CSS instead, and
 * `blocked` is not a reason: a terminal may be perfectly usable while the chat
 * is not, and it must not be hidden for as long as that lasts.
 */
export function conversationNeeded(state: FrontState): boolean {
	return !!state.chromeConnectionRequest;
}

/** The terminal in front as the view draws it: the host's `terminalFront`, unless the conversation is needed or the list does not hold it. */
export function visibleTerminalFront(state: FrontState): string | undefined {
	const front = state.terminalFront;
	return front && !conversationNeeded(state) && state.terminals?.some(t => t.id === front) ? front : undefined;
}

/** The tab in front, whichever kind. A `terminalFront` the list does not hold is no terminal. */
export function frontStripId(state: FrontState & Pick<ChatViewState, 'activeTab'>): string {
	return visibleTerminalFront(state) ?? state.activeTab;
}

/**
 * A `focusInput` the host sent while the view still drew a terminal in front
 * (the host may post it before the state that clears the front): the composer is
 * focused at the next state if no terminal is in front then, and never taken
 * from a terminal that stays in front.
 */
export function shouldFocusComposer(pending: boolean, state: FrontState): boolean {
	return pending && visibleTerminalFront(state) === undefined;
}

/** A tab shown under a name the user has just typed, before the host's state says so: a terminal's name is its `terminal.name`, not `title`. */
export function withPendingTitle(tab: StripTab, title: string): StripTab {
	return tab.terminal ? { ...tab, title, terminal: { ...tab.terminal, name: title } } : { ...tab, title };
}

/** What a terminal tab shows; the label is refilled only when this changes. */
export function terminalTabShown(t: TerminalTabSummary): string {
	return JSON.stringify([t.name, t.status, t.exitCode, t.agent, t.cwd, t.unread, t.pinnedBy, t.agentControl, t.agentActive, t.remote, t.remoteViewers, t.remoteControl]);
}

export function terminalStatusText(t: TerminalTabSummary): string {
	if (t.status === 'running') { return 'Running'; }
	return t.exitCode === undefined ? 'The process ended' : `The process ended with code ${t.exitCode}`;
}

/** `ownerName`: the agent of the conversation that has this terminal pinned (its title comes with `pinnedBy`). */
export function terminalTabTitle(t: TerminalTabSummary, agentName?: string, ownerName?: string): string {
	const owner = t.pinnedBy ? `\nUsed by ${ownerName ? `${ownerName} · ` : ''}${t.pinnedBy.title}${t.agentControl === 'paused' ? ' (its input is paused)' : ''}` : '';
	return `${t.name}${agentName ? ` — ${agentName}` : ''}\n${terminalStatusText(t)}\n${t.cwd}${owner}`;
}

export function terminalCloseText(t: TerminalTabSummary): string {
	return `"${t.name}" is still running. Closing it ends the ${t.agent ? 'agent' : 'shell'} and anything running in it.`;
}

export type TerminalAddition =
	| { readonly kind: 'hidden' }
	| { readonly kind: 'off'; readonly reason: string }
	| { readonly kind: 'on'; readonly agents: readonly ChatAgent[] };

/**
 * Whether "New terminal" is offered. No support at all (a remote surface, or an
 * editor that did not say) is nothing to show; unavailable says why; and at the
 * limit the reason is the limit. `agents` are the agents whose own CLI may be
 * started in a terminal, in the order the host listed them.
 */
export function terminalAddition(
	support: TerminalSupport | undefined,
	count: number,
	agents: readonly ChatAgent[] = [],
): TerminalAddition {
	if (!support) { return { kind: 'hidden' }; }
	if (!support.available) { return { kind: 'off', reason: support.reason }; }
	if (count >= support.limit) {
		return { kind: 'off', reason: `${count} terminal${count === 1 ? ' is' : 's are'} open — close one first.` };
	}
	return { kind: 'on', agents: support.agents.flatMap(id => agents.filter(a => a.id === id)) };
}

export interface ScreenRow {
	readonly text: string;
	/** Continues the row above: one logical line the width broke. */
	readonly wrapped: boolean;
}

/**
 * The last `count` lines of a screen, for "send last output to the chat":
 * wrapped rows joined back into their line, blank lines at the end dropped, and
 * cut to the last `maxChars` characters so one runaway line cannot make a
 * message the agent will not take.
 */
export function lastOutput(rows: readonly ScreenRow[], count = 60, maxChars = 100_000): string {
	const lines: string[] = [];
	for (const row of rows) {
		if (row.wrapped && lines.length) {
			lines[lines.length - 1] += row.text;
		} else {
			lines.push(row.text);
		}
	}
	while (lines.length && !lines[lines.length - 1].trim()) { lines.pop(); }
	const text = lines.slice(-count).map(line => line.replace(/\s+$/, '')).join('\n');
	return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}
