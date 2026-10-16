/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { chatTitle, toolOutputLimit, type AgentEvent } from './agentProtocol';
import { agentNames, type AgentBackend, type AgentSession, type TurnImage } from './agents';
import type { AgentId, AttachmentChip, ChatEntry, ChatStats, ToolEntry, UsageWindow } from './chatProtocol';
import { generateUuid } from '../core/uuid';

/**
 * One conversation of the chat: a tab. The view holds several (`tabLimit`),
 * one of them shown; each has its own chat, its own CLI session and its own
 * turn bookkeeping, and a tab that is not shown goes on working — its reply
 * streams and its agents finish while another tab is read. Everything that
 * was "the chat" before tabs is here unchanged, the provider holding only what
 * all tabs share: the view, the agents, the selection, the history.
 */

/** An agent's own tool calls kept on its row; a long-running one makes hundreds. */
const agentCallLimit = 100;
const entryLimit = 400;
export const storedTextLimit = 20_000;
const storedToolLimit = 4_000;

export interface StoredChat {
	id: string;
	title: string;
	/** Whose conversation this is. Fixed by the first message; see `started`. */
	agent: AgentId;
	owned?: boolean;
	ref?: string;
	createdAt: number;
	updatedAt: number;
	entries: ChatEntry[];
	stats: ChatStats;
}

export interface Attachment {
	readonly chip: AttachmentChip;
	readonly text?: string;
	readonly image?: TurnImage;
}

/** What a tab needs from the view that holds it. */
export interface TabHost {
	/** Where the agents work. */
	cwd(): string;
	/** Something the view shows changed. */
	changed(): void;
	/** A turn's own plan-limit report, kept for the usage popup. */
	limits(agent: AgentId, windows: readonly UsageWindow[]): void;
	save(chat: StoredChat): Promise<void>;
	inHistory(chatId: string): boolean;
}

/** `id`: a tab restored with the window keeps the chat id it had, which its draft is kept under. */
export function newChat(agent: AgentId, id = generateUuid()): StoredChat {
	const now = Date.now();
	return {
		id, title: 'New chat', agent, createdAt: now, updatedAt: now, entries: [],
		stats: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, turns: 0 },
	};
}

/** A chat from the history as a tab shows it: nothing in a stored chat is still running. */
export function reopened(stored: StoredChat): StoredChat {
	return { ...stored, entries: stored.entries.map(settled), stats: { ...stored.stats } };
}

export class ChatTab {
	public readonly id = generateUuid();
	private _chat: StoredChat;
	private _session: AgentSession | undefined;
	private _sessionEvents: vscode.Disposable | undefined;
	/** Held until the message they go with is sent. */
	public attachments: Attachment[] = [];
	/** Set while `_endTurnHere` ends a turn the chat is letting go of. */
	private _abandoning = false;
	/** Set between two messages of one turn, so the next text starts a new block. */
	private _textBreak = false;
	/** The chat was deleted: nothing writes it back. */
	private _discarded = false;
	/**
	 * The tab was closed, or moved on to another chat. A send still on its way
	 * — seconds, on a cold Codex app-server — then saves its chat only if the
	 * history still has it: the user may have deleted it from the history in
	 * between, and saving wrote it back, prompt included (#348 again).
	 */
	private _closed = false;
	/*
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
	/** Turns waiting to end, oldest first; a turn the CLI started on its own has no `entry`. */
	private _pending: { entry?: UserEntry; base?: TokenBase; startedAt?: number }[] = [];
	/** Added to a cumulative token report; see the `tokens` case. Per session. */
	private _tokenOffset: TokenBase = { input: 0, output: 0, cached: 0 };

	constructor(private readonly _host: TabHost, chat: StoredChat) {
		this._chat = chat;
	}

	public get chat(): StoredChat {
		return this._chat;
	}

	public get running(): boolean {
		return this._session?.running ?? false;
	}

	/** Agents of this conversation still working. */
	public get agentsRunning(): number {
		return this._chat.entries.filter(e => e.kind === 'tool' && e.tool === 'agent' && e.status === 'running').length;
	}

	public get started(): boolean {
		return started(this._chat);
	}

	/** A turn is running, or an agent is: closing the tab would stop something. */
	public get busy(): boolean {
		return this.running || this._pending.length > 0 || this.agentsRunning > 0;
	}

	public stop(): void {
		this._session?.stop();
	}

	public push(entry: ChatEntry): void {
		this._push(entry);
	}

	/** Shows a chat from the history in this tab, letting go of the one it had. */
	public open(stored: StoredChat): void {
		this.start(reopened(stored));
	}

	/**
	 * Lets go of this tab's conversation and shows `chat` in its place, the tab
	 * itself staying — a chat opened from the history into an empty tab, or the
	 * other agent taking this one's place. The webview carries the draft across,
	 * which it can only do while the tab is the same one.
	 */
	public start(chat: StoredChat): void {
		this.close();
		this._closed = false;
		this._discarded = false;
		this._chat = chat;
		this._post();
	}

	/** Ends what runs, saves, and lets the session go — the tab closing, or the view. */
	public close(): void {
		this._endTurnHere();
		void this._save();
		this._dropSession();
		this._closed = true;
	}

	/** Lets the session go without saving: the chat was deleted. */
	public discard(): void {
		this._discarded = true;
		this._pending = [];
		this._dropSession();
	}

	/**
	 * Stops one agent of this conversation, leaving the turn and the others
	 * running. Only while the session that started it is alive: an agent shown
	 * from the history ended with the process that ran it.
	 */
	/** Answers whether the stop was taken; a refused one is said in the chat, and the button comes back. */
	public async stopAgent(rowId: string): Promise<boolean> {
		const row = this._tool(rowId);
		if (!row || row.tool !== 'agent' || row.status !== 'running') {
			return false;
		}
		if (!this._session?.stopAgent) {
			this._push({ kind: 'notice', text: vscode.l10n.t("This agent cannot be stopped on its own here.") });
			return false;
		}
		try {
			await this._session.stopAgent(rowId, row.agent?.threadId);
			return true;
		} catch (err) {
			this._push({ kind: 'notice', text: vscode.l10n.t("The agent could not be stopped: {0}", err instanceof Error ? err.message : String(err)) });
			return false;
		}
	}

	public backendReplaced(agent: AgentId, gone: boolean): void {
		this._onBackendReplaced(agent, gone);
	}

	public async send(
		text: string, attachments: readonly Attachment[],
		agent: AgentId, model: string, effort: string | undefined, backend: AgentBackend,
	): Promise<void> {
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
				// No turn began, so none will end and take this prompt's place in
				// the queue: left there, the tab read as working — a confirmation
				// to close it, a switch card warning of a reply to stop, and a
				// "Stopped." written into the chat on the way out.
				if (!session.running) {
					this._pending = this._pending.filter(p => p.entry !== entry);
				}
			}
		}
		this._post();
		// Not a chat the user has deleted in the meantime: the send can take
		// seconds on a cold app-server, and saving here wrote the deleted chat —
		// its prompt included — back into the history.
		if (!this._discarded && ((chat === this._chat && !this._closed) || this._host.inHistory(chat.id))) {
			await this._save(chat);
		}
	}

	private _post(): void {
		this._host.changed();
	}

	private _save(chat = this._chat): Promise<void> {
		return this._discarded ? Promise.resolve() : this._host.save(chat);
	}

	private _cwd(): string {
		return this._host.cwd();
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
			case 'tool': {
				// Codex reports an agent's start again when it is given more work;
				// that is the same agent, running again, not a second row.
				const known = event.tool.kind === 'agent' ? this._tool(event.id) : undefined;
				if (known) {
					// Only while a turn runs, or nothing would ever settle it again.
					if (this._session?.running) {
						known.status = 'running';
						known.endedAt = undefined;
					}
					break;
				}
				this._endThinking();
				this._textBreak = true;
				chat.entries.push({
					kind: 'tool', id: event.id, tool: event.tool.kind, name: event.tool.name, detail: event.tool.detail, input: event.tool.input,
					added: event.tool.added, removed: event.tool.removed, status: 'running', startedAt: Date.now(),
					agent: event.tool.kind === 'agent' ? { ...event.tool.agent, calls: [] } : undefined,
				});
				break;
			}
			case 'agentCall': {
				const parent = this._tool(event.parentId);
				if (!parent) {
					return;
				}
				parent.agent ??= { calls: [] };
				if (parent.agent.calls.length < agentCallLimit) {
					parent.agent.calls.push({ name: event.name, detail: event.detail });
				}
				break;
			}
			case 'agentStates':
				for (const state of event.states) {
					for (const entry of chat.entries) {
						if (entry.kind === 'tool' && entry.agent?.threadId === state.threadId) {
							if (state.message) {
								entry.agent.summary = state.message;
								entry.output = state.message;
							}
							if (state.status !== 'running' && entry.status === 'running') {
								entry.status = state.status;
								entry.endedAt = Date.now();
							}
						}
					}
				}
				break;
			case 'autoTurn':
				// The CLI is answering on its own — an agent it started has
				// finished. No prompt waits on this turn; its text is a block of
				// its own under whatever came last. It still takes a place in the
				// queue: a prompt sent while it runs waits behind it, and without the
				// place this turn's end was written onto that prompt (#345 again).
				this._textBreak = true;
				if (!this._pending.length) {
					this._pending.push({ base: this._tokenBase(), startedAt: Date.now() });
				}
				break;
			case 'toolUpdate': {
				const entry = this._tool(event.id);
				if (!entry) {
					return;
				}
				const u = event.update;
				// A task report about a call that is not an agent — a background
				// shell, a long Bash call — is not this row's to take.
				if (u.agent && entry.tool !== 'agent') {
					return;
				}
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
				if (u.agent) {
					entry.agent = { calls: [], ...entry.agent, ...definedOnly(u.agent) };
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
				this._host.limits(chat.agent, event.windows);
				break;
			case 'turnEnd': {
				this._endThinking();
				this._textBreak = false;
				const now = Date.now();
				// A tool still marked running when its turn is over will never be
				// told otherwise; leaving it blinking would say work is going on.
				for (const entry of chat.entries) {
					// A background agent outlives the turn that started it, and
					// ends by its own report — unless the chat is letting go of the
					// session, which ends the agent with it.
					if (entry.kind === 'tool' && entry.status === 'running' && (!entry.agent?.background || this._abandoning)) {
						entry.status = event.error === 'Stopped.' ? 'stopped' : event.error ? 'failed' : 'done';
						entry.endedAt = now;
					}
				}
				// The oldest prompt still waiting is the one this turn answered.
				const done = this._pending.shift();
				if (done?.entry && done.entry.at !== undefined) {
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

	/**
	 * Whether the user has said anything yet. Not `entries.length`: a notice
	 * ("Started a new chat with Codex") is an entry too, and counting it made the
	 * fresh chat belong to the agent the user had just switched away from.
	 */
	private _started(): boolean {
		return started(this._chat);
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
	 * session mid-turn: the tab closing, the other agent taking its place, a
	 * replaced backend, the view closing. The session
	 * that would have reported the end is being disposed and says nothing, so
	 * without this the chat was saved with its tool rows "Running…" and its
	 * thinking still shimmering — and showed them so for good when reopened.
	 * The turn's state is read from the chat (`_pending`), not from the
	 * session, whose `running` a dispose may already have cleared.
	 */
	private _endTurnHere(): void {
		if (this._session?.running || this._pending.length) {
			this._abandoning = true;
			try {
				this._onAgentEvent({ type: 'turnEnd', error: 'Stopped.' });
			} finally {
				this._abandoning = false;
			}
		} else {
			// No turn, only agents still working in the background: they end with
			// the session, and no turn was stopped to say "Stopped." about.
			const now = Date.now();
			let ended = false;
			for (const e of this._chat.entries) {
				if (e.kind === 'tool' && e.status === 'running' && e.agent?.background) {
					e.status = 'stopped';
					e.endedAt = now;
					ended = true;
				}
			}
			if (ended) {
				void this._save();
				this._post();
			}
		}
		this._pending = [];
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
export function started(chat: StoredChat): boolean {
	return chat.owned === true || chat.ref !== undefined || chat.entries.some(e => e.kind === 'user');
}

/**
 * The entries as stored in the history: the newest `entryLimit`, long texts and
 * tool bodies cut, and **the latest prompt kept even when the window would
 * drop it**, so a reopened chat never opens on rows that answer nothing.
 */
export function storedEntries(entries: readonly ChatEntry[]): ChatEntry[] {
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
			return {
				...entry, input: cut(entry.input), output: cut(entry.output),
				// An agent's report is its output again, and was stored whole beside the cut copy.
				agent: entry.agent && { ...entry.agent, summary: cut(entry.agent.summary) },
			};
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
export function settled(entry: ChatEntry): ChatEntry {
	if (entry.kind === 'tool' && entry.status === 'running') {
		return { ...entry, status: entry.agent ? 'stopped' : 'failed', endedAt: entry.endedAt ?? entry.startedAt };
	}
	if (entry.kind === 'thinking' && entry.endedAt === undefined) {
		return { ...entry, endedAt: entry.startedAt };
	}
	return entry;
}

/** `{ a: 1, b: undefined }` → `{ a: 1 }`, so a partial report does not erase what an earlier one said. */
function definedOnly<T extends object>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
