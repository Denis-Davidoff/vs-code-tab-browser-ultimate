/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { attachmentContext, attachmentReference } from './attachmentReferences';
import { realpathSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { chatTitle, toolOutputLimit, validAnswers, type AgentEvent } from './agentProtocol';
import { agentNames, type AgentBackend, type AgentSession, type TurnImage } from './agents';
import type { AgentId, RepoCopy, RepoReference, ApprovalEntry, ApprovalMode, AttachmentChip, PendingSend, ChatEntry, ChatStats, ChatTabStatus, ToolEntry, UsageWindow } from './chatProtocol';
import { generateUuid } from '../core/uuid';
import { stepGate, withNextDecision } from './toolbarText';
import type { TurnWeight } from './usageAlert';

/**
 * One conversation of the chat: a tab. The view holds several (`tabLimit()`),
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
/** How long a tab must stay quiet before Claude Code is restarted under it; past Claude Code's own following turn. */
const restartQuietMs = 2_500;

export interface StoredChat {
	id: string;
	title: string;
	/** Whose conversation this is. Fixed by the first message; see `started`. */
	agent: AgentId;
	owned?: boolean;
	/** Named by the user: the first message does not replace the title. */
	named?: boolean;
	ref?: string;
	/**
	 * The folder the conversation works in, picked with the composer's folder
	 * button; absent, the window's own (`TabHost.cwd`). Fixed once the
	 * conversation has started: Claude Code keeps a session under the folder it
	 * ran in, and `--resume` from another one does not find it.
	 */
	folder?: string;
	/**
	 * Set when `folder` is a separate copy of a GitHub repository, made by the
	 * folder button: a worktree in the extension's storage on a branch of ours,
	 * `branch`, taken from `base`. The local project is not touched.
	 */
	copy?: RepoCopy;
	/** GitHub repositories cloned beside the project for the agent to read; see `AgentBackend.openSession`. */
	references?: RepoReference[];
	createdAt: number;
	updatedAt: number;
	entries: ChatEntry[];
	stats: ChatStats;
}

export interface Attachment {
	readonly chip: AttachmentChip;
	readonly text?: string;
	readonly image?: TurnImage;
	/** The file it stands for, where there is one: what clicking the chip opens. */
	readonly file?: vscode.Uri;
	/**
	 * A voice message's transcript, plain. It is the user's own words, so it goes into the
	 * message itself — shown in the chat, kept in the history, sent as instruction — and not
	 * under the attachments' "treat as data" header; `text` is what the agent is given.
	 */
	readonly spoken?: string;
}

/** What a tab needs from the view that holds it. */
export interface TabHost {
	/** Where the agents work when the conversation picked no folder of its own. */
	cwd(): string;
	/** The project folder then, undefined when no local folder is open; see `AgentBackend.openSession`. */
	projectRoot(): string | undefined;
	/** Whether the agents may load `folder`'s own settings: false for one fetched from GitHub and not trusted yet. */
	ownSettings(folder: string): boolean;
	/** Something the view shows changed. */
	changed(): void;
	/**
	 * A turn's own plan-limit report — the limits it names, and whether the
	 * agent spends credits now when it says so — for the usage popup and the
	 * limit line above the chat.
	 */
	limits(agent: AgentId, windows: readonly UsageWindow[], usingCredits: boolean | undefined): void;
	/** A turn ended, this heavy; the view decides whether to ask for the plan's limits. */
	turnEnded(agent: AgentId, weight: TurnWeight): void;
	save(chat: StoredChat): Promise<void>;
	inHistory(chatId: string): boolean;
	/** The approval menu's mode for a category key; see `approvalKey`. */
	approvalMode(key: string): ApprovalMode;
	/** An MCP server an agent asked about, so the approval menu can list it. */
	noteServer(server: string): void;
	/**
	 * The tab let go of the conversation `chatId` — closed, cleared, another
	 * chat or agent in its place, deleted, the view gone. The toolbar skills
	 * running in the background from it stop with it, as its agents do.
	 */
	released(chatId: string): void;
}

/**
 * A prompt of a toolbar skill of several, sent into the chat: which skill run
 * (`chain`, one per press), which prompt of how many, and the check it must
 * pass before it is sent. The prompt before it asks the agent to judge that
 * check — decided when that prompt is sent, from what is queued then, so a
 * step taken out of the queue moves the question to the one now next.
 */
/**
 * A toolbar skill that runs in the background (clipboard or silent), held in
 * a tab's queue by "Run after this turn": started, not sent, when its turn
 * comes, with the agent and model the tab has then.
 */
export interface QueuedRun {
	readonly skillId: string;
	readonly name: string;
	readonly values: Readonly<Record<string, string>>;
}

export interface SkillStep {
	readonly chain: string;
	readonly name: string;
	readonly step: number;
	readonly steps: number;
	readonly check?: string;
}

/** The approval menu's key for a question: its category, or `mcp:<server>` for one server. */
export function approvalKey(entry: { readonly what: string; readonly server?: string }): string {
	return entry.what === 'mcp' ? `mcp:${entry.server ?? ''}` : entry.what;
}

/** `id`: a tab restored with the window keeps the chat id it had, which its draft is kept under. */
export function newChat(agent: AgentId, id = generateUuid()): StoredChat {
	const now = Date.now();
	return {
		id, title: 'New chat', agent, createdAt: now, updatedAt: now, entries: [],
		stats: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, turns: 0 },
	};
}

/**
 * Whether `folder` is the home directory, by its real path: a link to it is it
 * too. Asked on every state post, so answered once per folder — a folder does
 * not become the home directory while the window runs.
 */
export function isHome(folder: string): boolean {
	let answer = homeAnswers.get(folder);
	if (answer === undefined) {
		const real = (p: string) => {
			try {
				return realpathSync(p);
			} catch {
				return path.resolve(p);
			}
		};
		answer = real(folder) === real(os.homedir());
		if (homeAnswers.size > 100) {
			homeAnswers.clear();
		}
		homeAnswers.set(folder, answer);
	}
	return answer;
}

const homeAnswers = new Map<string, boolean>();

/** Errors and failed agents in a conversation: the work that ended badly. */
function failures(chat: StoredChat): number {
	return chat.entries.filter(e => e.kind === 'error' || (e.kind === 'tool' && e.tool === 'agent' && e.status === 'failed')).length;
}

/** A conversation whose last word is an error, as one reopened from the history may be. */
function endedInError(chat: StoredChat): boolean {
	return chat.entries[chat.entries.length - 1]?.kind === 'error';
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
	private _pending: { entry?: UserEntry; base?: TokenBase; startedAt?: number; step?: SkillStep; asked?: string }[] = [];
	/**
	 * Queued skill prompts whose check has passed, by queue id. A prompt with
	 * a check goes out only from here: if the step before it never had a turn
	 * that judged it — its send failed, it was taken out of the queue — the
	 * check was not made, and the skill stops (`dequeue`).
	 */
	private readonly _cleared = new Set<string>();
	/**
	 * Claude: prompts sent during a turn, not in the conversation yet. Claude
	 * Code takes such a message in at the next tool boundary, or answers it with
	 * a turn of its own once this one ends; until one of those shows, the chat
	 * shows it as waiting, and puts it where it was taken in — before the output
	 * that follows a tool's result, or at the start of its own turn.
	 */
	private _waiting: { readonly id: string; readonly entry: UserEntry }[] = [];
	/** A tool's result came after the oldest waiting prompt was sent: the next output is its taking in. */
	private _boundary = false;
	private _flushTimer: ReturnType<typeof setTimeout> | undefined;
	/** Held to be sent when the turn ends, oldest first (⌘/Ctrl+Enter). The provider sends them. */
	private _queued: { readonly id: string; readonly text: string; readonly attachments: Attachment[]; readonly step?: SkillStep; readonly background?: QueuedRun }[] = [];
	/** When the last turn ended, to tell a message's own turn from an agent's. */
	private _lastTurnEnd = 0;
	/** Added to a cumulative token report; see the `tokens` case. Per session. */
	private _tokenOffset: TokenBase = { input: 0, output: 0, cached: 0 };
	/*
	 * The tab's mark (`status`). Worked out here, on every change, because the
	 * moment that matters — the work ending — is a change between two of them:
	 * busy at the last one, idle now. The view decides only whether anybody was
	 * looking (`seen`).
	 */
	private _wasBusy = false;
	/** The work ended and nobody has looked at the tab since. */
	private _unseen = false;
	/** The last work ended in an error; until the next message. */
	private _failed = false;
	/**
	 * What Claude Code is started with changed while it worked — a repository
	 * to read added, its folder's settings trusted: the session is let go once
	 * the work ends, and the next message resumes it with the new arguments.
	 */
	private _restartForDirs = false;
	private _restartTimer: ReturnType<typeof setTimeout> | undefined;
	/** `failures` when the last message was sent, so only what went wrong after it counts. */
	private _failuresBefore = 0;

	constructor(private readonly _host: TabHost, chat: StoredChat) {
		this._chat = chat;
		this._failed = endedInError(chat);
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

	/** What the tab is called: the chat's title once it has one — from its first message, or the user. */
	public get title(): string | undefined {
		return this.started || this._chat.named ? this._chat.title : undefined;
	}

	/** The user named the tab. Saved with the chat once it has started; see `openTabsKey` before that. */
	public rename(title: string): void {
		this._chat.title = title;
		this._chat.named = true;
		if (this.started) {
			void this._save();
		}
		this._post();
	}

	/** A late background title must never replace a manually named or different conversation. */
	public applyGeneratedTitle(chatId: string, title: string): void {
		if (this._closed || this._discarded || this._chat.id !== chatId || this._chat.named || !this.started) { return; }
		this._chat.title = title;
		void this._save();
		this._post();
	}

	/** A turn is running, or an agent is: closing the tab would stop something. */
	/** The messages not in the conversation yet, for the view; see `PendingSend`. */
	public get pendingSends(): PendingSend[] {
		return [
			...this._waiting.map(w => ({ id: w.id, text: w.entry.text, kind: 'steer' as const, attachments: w.entry.attachments })),
			...this._queued.map(q => ({
				id: q.id, text: q.text, kind: 'queue' as const, attachments: q.attachments.map(a => `${attachmentReference(a.chip)} ${a.chip.label}`),
				skill: q.step ? { name: q.step.name, step: q.step.step, steps: q.step.steps, check: q.step.check }
					: q.background ? { name: q.background.name, step: 1, steps: 1, background: true } : undefined,
			})),
		];
	}

	/** Held for after the running turn; `send` it when the tab is idle again — the provider does. */
	public enqueue(text: string, attachments: Attachment[], step?: SkillStep, background?: QueuedRun): void {
		this._queued.push({ id: generateUuid(), text, attachments, step, background });
		this._post();
	}

	/** A toolbar skill run still has prompts here to send. */
	public hasSteps(chain: string): boolean {
		return this._queued.some(q => q.step?.chain === chain);
	}

	/** Its prompts not sent yet are dropped: the skill was stopped, or stops here. */
	public dropSteps(chain: string): number {
		const before = this._queued.length;
		this._queued = this._queued.filter(q => q.step?.chain !== chain);
		if (this._queued.length !== before) {
			this._post();
		}
		return before - this._queued.length;
	}

	/** Every queued message, taken out — Stop gives them back to the composer rather than sending them. */
	/**
	 * The queue, given back to the box. A toolbar skill's prompts are dropped
	 * rather than given back: they are the skill's, not something the user
	 * typed, and the skill stops with whatever made the tab let go.
	 */
	public takeQueued(): { readonly text: string; readonly attachments: Attachment[] }[] {
		const all = this._queued;
		this._queued = [];
		if (all.length) {
			this._post();
		}
		return all.filter(q => !q.step && !q.background);
	}

	/** The waiting prompts go into the conversation where it stands, the next text a block of its own. */
	private _flushWaiting(): void {
		if (this._flushTimer) {
			clearTimeout(this._flushTimer);
			this._flushTimer = undefined;
		}
		if (!this._waiting.length) {
			return;
		}
		// The thought before it is over: what follows is the answer that includes it.
		this._endThinking();
		for (const w of this._waiting) {
			this._chat.entries.push(w.entry);
		}
		this._waiting = [];
		this._boundary = false;
		this._textBreak = true;
		this._post();
	}

	/** The next queued message, taken out of the queue to be sent. */
	public dequeue(): { readonly text: string; readonly attachments: Attachment[]; readonly step?: SkillStep; readonly background?: QueuedRun } | undefined {
		if (this._stepEnded) {
			const ended = this._stepEnded;
			this._stepEnded = undefined;
			this._gateNextStep(ended.done, ended.error);
		}
		let next = this._queued.shift();
		// A checked skill prompt whose check nobody passed: the skill stops
		// here, and the queue goes on with what is behind its prompts.
		while (next?.step?.check && !this._cleared.has(next.id)) {
			const step = next.step;
			this._queued = this._queued.filter(q => q.step?.chain !== step.chain);
			this._chat.entries.push({ kind: 'notice', text: vscode.l10n.t("/{0} stopped before prompt {1} of {2}: the check before it was not made.", step.name, step.step, step.steps) });
			next = this._queued.shift();
		}
		if (next) {
			this._cleared.delete(next.id);
		}
		this._post();
		return next;
	}

	/** A skill prompt could not be sent: the rest of its skill is dropped, with a line saying so. */
	public stepNotSent(step: SkillStep, why: string): void {
		this.dropSteps(step.chain);
		this._chat.entries.push({ kind: 'notice', text: vscode.l10n.t("/{0} stopped: prompt {1} of {2} was not sent ({3}).", step.name, step.step, step.steps, why) });
		this._post();
	}

	public unqueue(id: string): boolean {
		const before = this._queued.length;
		this._queued = this._queued.filter(q => q.id !== id);
		if (this._queued.length !== before) {
			this._post();
			return true;
		}
		return false;
	}

	/** How many messages are queued: closing the tab drops them, so the close asks. */
	public get queuedCount(): number {
		return this._queued.length;
	}

	/** Messages are queued, and the turn they wait for has ended: the provider may send the next. */
	public get readyForQueued(): boolean {
		return this._queued.length > 0 && !this.busy && !this._waiting.length && !this.waiting;
	}

	public get busy(): boolean {
		return this.running || this._pending.length > 0 || this.agentsRunning > 0;
	}

	/** An approval waits for the user: the agent is stopped on them. */
	public get waiting(): boolean {
		return this._chat.entries.some(e => e.kind === 'approval' && e.status === 'pending');
	}

	/** The mark on the tab; nothing for a conversation nothing was sent from. */
	public get status(): ChatTabStatus | undefined {
		if (this.waiting) {
			return 'waiting';
		}
		if (this.busy) {
			return 'working';
		}
		if (!this.started) {
			return undefined;
		}
		return this._failed ? 'failed' : this._unseen ? 'unread' : 'read';
	}

	/** The user has the tab in front of them: what it finished is read. An error stays marked. */
	public seen(): void {
		this._unseen = false;
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
		this._unseen = false;
		this._failed = endedInError(chat);
		this._restartForDirs = false;
		this._post();
	}

	/**
	 * Ends what runs, saves, and lets the session go — the tab closing, or the
	 * view. `'view'`: the view went away and the tab stays in the provider's list,
	 * to be shown again when the view is resolved again. It is not marked
	 * `_closed` then: that flag is reset only by `start()`, so a tab the view let
	 * go of came back for good as closed — a generated title was dropped
	 * (`applyGeneratedTitle`) and a first send that failed was never saved. A
	 * chat deleted meanwhile is still covered: deleting it discards the tab.
	 */
	public close(reason: 'tab' | 'view' = 'tab'): void {
		// A prompt still waiting was sent to the CLI: it goes into the chat
		// before the turn is ended and the chat saved, or the history lacked a
		// message the resumed session has (the save used to come first).
		this._flushWaiting();
		this._endTurnHere();
		void this._save();
		this._dropSession();
		this._host.released(this._chat.id);
		if (reason === 'tab') {
			this._closed = true;
		}
		// Ended by the user closing it, or the view: nothing finished to read.
		this._unseen = false;
		this._wasBusy = false;
	}

	/** Lets the session go without saving: the chat was deleted. */
	public discard(): void {
		this._discarded = true;
		this._pending = [];
		this._dropSession();
		this._host.released(this._chat.id);
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

	/**
	 * The user answered an approval card. Only a pending one, and only while its
	 * session is alive. A question is answered with `answers`, checked against
	 * what it asked; none that fit is a skip. A secret answer goes to the agent
	 * and is not kept in the chat.
	 */
	public answer(id: string, allow: boolean, answers?: unknown): void {
		const entry = this._approval(id);
		if (!entry || entry.status !== 'pending') {
			return;
		}
		if (entry.questions) {
			const given = allow ? validAnswers(entry.questions, answers) : {};
			const answered = Object.keys(given).length > 0;
			entry.status = answered ? 'allowed' : 'denied';
			if (answered) {
				const kept: Record<string, readonly string[]> = {};
				for (const q of entry.questions) {
					if (given[q.id]) {
						kept[q.id] = q.secret ? ['••••'] : given[q.id];
					}
				}
				entry.answers = kept;
			}
			this._session?.answer(id, answered, answered ? given : undefined);
		} else {
			entry.status = allow ? 'allowed' : 'denied';
			this._session?.answer(id, allow);
		}
		this._post();
		void this._save();
	}

	/**
	 * A category's mode changed in the approval menu: what it covers and is
	 * still waiting is answered now, rather than leaving the user to click what
	 * they just said should not need a click.
	 */
	public approvalModesChanged(): void {
		let answered = false;
		for (const entry of this._chat.entries) {
			if (entry.kind !== 'approval' || entry.status !== 'pending' || entry.questions) {
				continue;
			}
			const mode = this._host.approvalMode(approvalKey(entry));
			if (mode !== 'ask') {
				entry.status = mode === 'auto' ? 'allowed' : 'denied';
				entry.auto = true;
				this._session?.answer(entry.id, mode === 'auto');
				answered = true;
			}
		}
		if (answered) {
			this._post();
			// Saved now: left for the next save, a chat reopened before one came
			// showed these as "No longer needed".
			void this._save();
		}
	}

	private _approval(id: string): ApprovalEntry | undefined {
		for (let i = this._chat.entries.length - 1; i >= 0; i--) {
			const entry = this._chat.entries[i];
			if (entry.kind === 'approval' && entry.id === id) {
				return entry;
			}
		}
		return undefined;
	}

	/** Questions nobody can answer any more — the session is going — are closed in the chat. */
	private _cancelApprovals(): void {
		for (const entry of this._chat.entries) {
			if (entry.kind === 'approval' && entry.status === 'pending') {
				entry.status = 'cancelled';
			}
		}
	}

	public backendReplaced(agent: AgentId, gone: boolean): void {
		this._onBackendReplaced(agent, gone);
	}

	public async send(
		text: string, attachments: readonly Attachment[],
		agent: AgentId, model: string, effort: string | undefined, backend: AgentBackend, step?: SkillStep,
	): Promise<void> {
		// A voice message is part of what the user says: what the chat shows and keeps is the
		// transcript; what the agent reads is it said to be one; the rest stay attachments.
		const voices = attachments.filter(a => a.spoken !== undefined);
		const shown = [text, ...voices.map(a => a.spoken!)].filter(t => t.trim()).join('\n\n');
		const said = [text, ...voices.map(a => a.text ?? a.spoken!)].filter(t => t.trim()).join('\n\n');
		const context = attachments.filter(a => a.spoken === undefined);
		if (!this._started()) {
			this._chat.agent = agent;
			this._chat.owned = true;
			if (!this._chat.named) {
				this._chat.title = chatTitle(shown || attachments[0]?.chip.label || '');
			}
			this._chat.createdAt = Date.now();
		}
		this._textBreak = false;
		this._failed = false;
		this._unseen = false;
		this._failuresBefore = failures(this._chat);
		const entry: UserEntry = { kind: 'user', text: shown, attachments: attachments.map(a => `${attachmentReference(a.chip)} ${a.chip.label}`), at: Date.now() };
		// A skill prompt followed by one with a check asks the agent to judge it;
		// the chat shows the prompt as written, the instruction is ours. The
		// next prompt is the one queued now, whatever was taken out since.
		const asked = step ? this._queued.find(q => q.step?.chain === step.chain)?.step?.check : undefined;
		const running = this._session?.running ?? false;
		if (!running) {
			this._pending = [{ entry, base: this._tokenBase(), startedAt: entry.at, step, asked }];
			this._flushWaiting();
		}
		if (running && agent === 'claude') {
			// Taken into the running turn, or answered by a turn of its own right
			// after it — Claude Code decides, and says which only by doing it (see
			// `ClaudeSession.send`). Shown as waiting until then, and put into the
			// conversation where it was taken in; pushed now, it sat in the middle
			// of the reply still streaming, which went on below it.
			if (!this._waiting.length) {
				this._boundary = false;
			}
			this._waiting.push({ id: generateUuid(), entry });
			this._post();
		} else {
			if (running) {
				// Codex steers it into the running turn at once; a thought in progress
				// ends here and the turn's next one is a block of its own.
				this._endThinking();
				this._textBreak = true;
			}
			this._push(entry);
		}

		const sent = asked ? withNextDecision(said, asked) : said;
		const prompt = [sent, attachmentContext(context)].filter(Boolean).join('\n\n');
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
				// A skill prompt that did not go out had no turn to judge the next
				// one's check, and no turn to follow: the skill stops here.
				if (step) {
					this.stepNotSent(step, err instanceof Error ? err.message : String(err));
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
		const busy = this.busy;
		if (this._wasBusy && !busy) {
			this._unseen = true;
			this._failed ||= failures(this._chat) > this._failuresBefore;
		}
		this._wasBusy = busy;
		if (this._restartForDirs && !busy) {
			// Never from inside the event that ended the turn, and not until it is
			// quiet; the next message resumes the session with its new arguments.
			this._scheduleRestart();
		}
		this._host.changed();
	}

	private _save(chat = this._chat): Promise<void> {
		return this._discarded ? Promise.resolve() : this._host.save(chat);
	}

	/** Where the agents work: the conversation's own folder, else the window's. */
	public get cwd(): string {
		return this._chat.folder ?? this._host.cwd();
	}

	/**
	 * The project the approval menu's "inside" means; see `AgentBackend.openSession`.
	 * The home directory picked as the folder is no project, as with no folder at
	 * all: as one, Codex's `workspace-write` opened all of it, `~/.ssh` included,
	 * and the menu counted every file there as inside (#382, #390, #447).
	 */
	public get projectRoot(): string | undefined {
		const folder = this._chat.folder;
		if (folder === undefined) {
			return this._host.projectRoot();
		}
		return isHome(folder) ? undefined : folder;
	}

	/**
	 * Another working folder for a conversation that has not started; the
	 * provider opens a new tab for one that has (see `StoredChat.folder`).
	 * `undefined` is the window's own.
	 */
	public setFolder(folder: string | undefined, copy?: RepoCopy): void {
		if (this.started) {
			return;
		}
		this._chat.folder = folder;
		this._chat.copy = copy;
		this._post();
	}

	/**
	 * A repository to read beside the project. Claude Code is given it at its
	 * start (`--add-dir`), so a session already running is let go and resumed
	 * by its `ref` at the next message; the caller refuses while the tab works.
	 */
	public addReference(reference: RepoReference): void {
		const list = (this._chat.references ?? []).filter(r => r.path !== reference.path);
		this._chat.references = [...list, reference];
		this.restartSession();
		if (this.started) {
			void this._save();
		}
		this._post();
	}

	private _cwd(): string {
		return this.cwd;
	}

	/**
	 * Claude Code must start again to load what changed (`_restartForDirs`):
	 * once the work ends and the tab stays quiet. `now`: an idle session goes
	 * at once rather than after the quiet wait — for a folder whose own
	 * settings have just been held back, where the process running there must
	 * not be the one that reads them.
	 */
	public restartSession(now = false): void {
		if (!this._session || this._chat.agent !== 'claude') {
			return;
		}
		if (now && !this.busy && !this._waiting.length) {
			this._restartForDirs = false;
			this._dropSession();
			return;
		}
		this._restartForDirs = true;
		this._scheduleRestart();
	}

	/**
	 * Quiet: no turn, nothing pending or waiting to be taken in — and, after a
	 * wait, still so. Claude Code answers a message sent late in a turn, or a
	 * background agent's end, with a turn of its own a moment after the last
	 * one ended (`autoTurn`); `busy` does not cover that gap, and a session let
	 * go in it took the prompt as answered and ended the CLI before it replied.
	 */
	private _scheduleRestart(): void {
		if (this._restartTimer || !this._restartForDirs || this.busy || this._waiting.length) {
			return;
		}
		this._restartTimer = setTimeout(() => {
			this._restartTimer = undefined;
			// Not `_closed`: a tab the view let go of when it was closed is
			// reused when the view comes back, and before `close('view')` it was
			// left marked closed — so a reference added or a folder trusted after
			// that never reached Claude Code. A tab really closed holds no
			// session, which the check below already covers.
			if (!this._restartForDirs) {
				return;
			}
			if (this.busy || this._waiting.length) {
				// Busy again: `_post` schedules it once the work ends.
				return;
			}
			this._restartForDirs = false;
			if (this._session) {
				this._dropSession();
			}
		}, restartQuietMs);
	}

	/** Push the selected branch while retaining ownership of the original cleanup branch. */
	public updateCopyBranch(branch: string): void {
		if (!this._chat.copy || this._chat.copy.branch === branch) { return; }
		this._chat.copy = { ...this._chat.copy, ownedBranch: this._chat.copy.ownedBranch ?? this._chat.copy.branch, branch };
		if (this.started) { void this._save(); }
		this._post();
	}

	/** The copy this conversation worked in was removed: its actions go, its folder stays. */
	public forgetCopy(): void {
		this._chat.copy = undefined;
		if (this.started) {
			void this._save();
		}
		this._post();
	}

	private _tokenBase(): TokenBase {
		const st = this._chat.stats;
		return { input: st.inputTokens, output: st.outputTokens, cached: st.cachedTokens };
	}

	/**
	 * How heavy the turn that just ended was: input not read from the cache
	 * plus output, against its baseline, and its length. No baseline (a turn
	 * the CLI started on its own before any was taken) counts no tokens.
	 */
	private _turnWeight(base: TokenBase | undefined, startedAt: number | undefined, now: number): TurnWeight {
		const st = this._chat.stats;
		const tokens = base
			? Math.max(0, st.inputTokens - base.input - Math.max(0, st.cachedTokens - base.cached)) + Math.max(0, st.outputTokens - base.output)
			: 0;
		return { tokens, ms: startedAt !== undefined ? Math.max(0, now - startedAt) : 0 };
	}

	private _ensureSession(backend: AgentBackend): AgentSession {
		if (this._session) {
			return this._session;
		}
		const session = backend.openSession(this._cwd(), this._chat.ref, this._chat.stats.costUsd, this.projectRoot, this._chat.references?.map(r => r.path), this._host.ownSettings(this._cwd()), this._chat.id);
		// A session opened now starts with what the restart was for; one still
		// pending would let it go after its first turn, for nothing.
		this._restartForDirs = false;
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
		if (this._waiting.length) {
			// A tool's result is the boundary where Claude Code takes a waiting
			// message in; the output after it is the answer that includes it.
			if (event.type === 'toolUpdate' && (event.update.output !== undefined || event.update.status) && !event.update.agent) {
				this._boundary = true;
			} else if (this._boundary && (event.type === 'text' || event.type === 'thinking' || event.type === 'tool')) {
				this._flushWaiting();
			}
		}
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
					// Background agents can start another turn after the main reply.
					if (this._session && (this._session.running || event.tool.agent?.background)) {
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
			case 'autoTurn': {
				// The CLI is answering on its own: a message sent during the turn
				// that just ended, or an agent it started has finished. Its text is
				// a block of its own under whatever came last. It takes a place in
				// the queue: a prompt sent while it runs waits behind it, and without
				// the place this turn's end was written onto that prompt (#345).
				// A message is what it answers only right after a turn's end —
				// measured, `requesting` follows the `result` within milliseconds;
				// later, it is an agent's, and a message still waiting was taken
				// into the earlier turn.
				this._textBreak = true;
				const now = Date.now();
				const taken = now - this._lastTurnEnd < 2000 ? this._waiting.shift() : undefined;
				if (taken) {
					chat.entries.push(taken.entry);
				} else {
					this._flushWaiting();
				}
				if (!this._pending.length) {
					this._pending.push({ entry: taken?.entry, base: this._tokenBase(), startedAt: now });
				}
				break;
			}
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
			case 'approval': {
				const request = event.request;
				// A question with choices: only the user can choose, so the
				// approval menu has no say and the card always waits.
				if (request.questions) {
					chat.entries.push({
						kind: 'approval', id: request.id, what: 'question', title: request.title,
						questions: request.questions, status: 'pending',
					});
					break;
				}
				if (request.what === 'mcp' && request.server) {
					this._host.noteServer(request.server);
				}
				const mode = this._host.approvalMode(approvalKey(request));
				// Allowed by the menu: no card, the tool's own row says what ran.
				if (mode === 'auto') {
					this._session?.answer(request.id, true);
					return;
				}
				// Refused by the menu: a short line, so a refusal the agent then
				// works around is not a mystery.
				const denied = mode === 'deny';
				if (denied) {
					this._session?.answer(request.id, false);
				}
				chat.entries.push({
					kind: 'approval', id: request.id, what: request.what, server: request.server,
					title: request.title, detail: request.detail,
					status: denied ? 'denied' : 'pending', auto: denied || undefined,
				});
				break;
			}
			case 'approvalDone': {
				const entry = this._approval(event.id);
				if (entry?.status !== 'pending') {
					return;
				}
				entry.status = 'cancelled';
				break;
			}
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
				this._host.limits(chat.agent, event.windows, event.usingCredits);
				break;
			case 'context':
				if (event.used !== undefined) {
					chat.stats.contextTokens = event.used;
					delete chat.stats.contextCompacted;
				} else if (event.compacted) {
					chat.stats.contextCompacted = true;
				}
				if (event.window !== undefined) {
					chat.stats.contextWindow = event.window;
				}
				break;
			case 'turnEnd': {
				this._endThinking();
				this._textBreak = false;
				const now = Date.now();
				this._lastTurnEnd = now;
				// A prompt still waiting is answered by a turn of its own, which
				// `requesting` announces within milliseconds; if none comes it was
				// taken in after all, and goes into the conversation here.
				if (this._waiting.length && !this._flushTimer) {
					this._flushTimer = setTimeout(() => {
						this._flushTimer = undefined;
						if (!this._pending.length) {
							this._flushWaiting();
						}
					}, 2000);
				}
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
				this._host.turnEnded(chat.agent, this._turnWeight(done?.base, done?.startedAt ?? done?.entry?.at, now));
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
				// After the turn's own error, so the line saying a skill stopped reads
				// as what followed from it.
				if (done?.step) { this._stepEnded = { done, error: event.error }; }
				chat.updatedAt = now;
				void this._save();
				break;
			}
		}
		this._endOrphanedAgents();
		this._post();
	}

	/**
	 * An agent an agent started ends when its parent is stopped or fails. Its own
	 * report may never come — Claude Code's interrupt and `stop_task` are not
	 * measured to report the agents inside — and the turn's end passes over it,
	 * being background; left running, the tab reads as working and "until agents
	 * finish" keeps the computer awake for good. A parent that finished is not
	 * followed: its children report their own end, and may outlive it on Codex.
	 */
	private _endOrphanedAgents(): void {
		const now = Date.now();
		let changed = true;
		while (changed) {
			changed = false;
			for (const entry of this._chat.entries) {
				const parentId = entry.kind === 'tool' && entry.status === 'running' ? entry.agent?.parentId : undefined;
				const parent = parentId ? this._tool(parentId) : undefined;
				if (entry.kind === 'tool' && (parent?.status === 'stopped' || parent?.status === 'failed')) {
					entry.status = parent.status;
					entry.endedAt = now;
					changed = true;
				}
			}
		}
	}

	/**
	 * A toolbar skill's prompt has had its turn: the next one waiting in the
	 * queue goes out only if its check passed — read from this turn's reply —
	 * and otherwise the skill's remaining prompts are dropped, with a line
	 * saying why. Without a check the next one always goes. A Stop never gets
	 * here with prompts left: it gives the queue back, which drops them.
	 */
	private _stepEnded?: { done: { entry?: UserEntry; step?: SkillStep; asked?: string }; error?: string };

	private _gateNextStep(done: { entry?: UserEntry; step?: SkillStep; asked?: string } | undefined, error: string | undefined): void {
		const step = done?.step;
		const next = step && this._queued.find(q => q.step?.chain === step.chain);
		if (!step || !next?.step?.check) {
			return;
		}
		// The check this turn was asked to judge must be the one now next: a
		// prompt taken out of the queue meanwhile leaves the answer to another.
		const entries = this._chat.entries;
		const from = done.entry ? entries.indexOf(done.entry) : -1;
		const reply = entries.slice(from + 1).filter(e => e.kind === 'assistant').map(e => e.text).join('\n\n');
		const gate = done.asked === next.step.check
			? stepGate(next.step.check, error, reply)
			: { go: false as const, why: 'the check before it was not asked' };
		if (gate.go) {
			this._cleared.add(next.id);
			return;
		}
		this.dropSteps(step.chain);
		entries.push({ kind: 'notice', text: vscode.l10n.t("/{0} stopped after prompt {1} of {2}: {3}.", step.name, step.step, step.steps, gate.why) });
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

	/**
	 * Every thinking block still open is over. Not only those after the last
	 * prompt, as it used to be: a message sent during a turn puts a prompt after
	 * the turn's thinking (Codex steers at once, a waiting Claude prompt goes in
	 * when it is taken), and the scan stopped at that prompt — the thinking above
	 * it shimmered "Thinking" for good, after the turn ended or was stopped.
	 */
	private _endThinking(): void {
		const now = Date.now();
		for (const entry of this._chat.entries) {
			if (entry.kind === 'thinking' && entry.endedAt === undefined) {
				entry.endedAt = now;
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
		this._stepEnded = undefined;
		this._cancelApprovals();
		// Not answered, and not lost: shown where the conversation stands.
		this._flushWaiting();
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
		// Cut off by something other than the user: marked like an error.
		this._failed ||= this.busy;
		this._flushWaiting();
		this._endTurnHere();
		this._cancelApprovals();
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
		void this._save();
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
	if (entry.kind === 'approval' && entry.status === 'pending') {
		return { ...entry, status: 'cancelled' };
	}
	return entry;
}

/** `{ a: 1, b: undefined }` → `{ a: 1 }`, so a partial report does not erase what an earlier one said. */
function definedOnly<T extends object>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
