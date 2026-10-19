/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { binarySource, chooseAgentBinary, describeBinary } from './agentBinary';
import type { AgentEvent } from './agentProtocol';
import type { AgentId, AgentUsage, ChatAgent, ChatCommand, ChatModel, QuestionAnswers } from './chatProtocol';
import { ClaudeBackend } from './claudeAgent';
import { CodexBackend } from './codexAgent';

/**
 * The agents the chat view can talk to, behind one interface.
 *
 * Each backend drives its CLI the way that CLI's own VS Code extension does —
 * see `agentProtocol.ts` for the two protocols. The chat view never learns
 * which one it is talking to: it sends a {@link TurnInput} and renders
 * {@link AgentEvent}s.
 */

export interface TurnImage {
	readonly mediaType: string;
	readonly base64: string;
}

export interface TurnInput {
	readonly text: string;
	readonly images: readonly TurnImage[];
}

/** One conversation. Holds at most one live CLI process or thread. */
export interface AgentSession extends vscode.Disposable {
	readonly onEvent: vscode.Event<AgentEvent>;
	/** What resumes this conversation later: a Claude session id, a Codex thread id. */
	readonly ref: string | undefined;
	readonly running: boolean;
	/**
	 * Sends a message. While a turn is running it is added to that turn — Codex
	 * steers it, Claude Code queues it — rather than refused.
	 */
	send(input: TurnInput, model: string, effort: string | undefined): Promise<void>;
	stop(): void;
	/**
	 * Stops one agent this conversation started — by its row id, and the
	 * agent's own thread where it has one — leaving the turn and the other
	 * agents running. Rejects when the CLI refuses.
	 */
	stopAgent?(rowId: string, threadId: string | undefined): Promise<void>;
	/**
	 * Answers an `approval` event this session reported. An id it no longer has
	 * is ignored. A question (`what: 'question'`) is answered with `answers`, or
	 * skipped with `allow` false.
	 */
	answer(id: string, allow: boolean, answers?: QuestionAnswers): void;
}

/**
 * The extension's own MCP server, as the chat hands it to each CLI it starts —
 * so the agents in the chat have the browser tools whether or not Connect was
 * ever pressed. Read at every start: the port can move with a setting change.
 */
export interface BrowserServer {
	readonly url: string;
	readonly token: string;
	readonly chatId?: string;
}

export interface AgentBackend extends vscode.Disposable {
	readonly id: AgentId;
	/** A text-only commit message on the model and effort chosen for this feature. */
	generateCommitMessage?(model: string, effort: string | undefined, context: string, signal: AbortSignal): Promise<string>;
	/** Optional one-shot title on a small model; never uses a conversation session. */
	generateTitle?(model: ChatModel, context: string, signal: AbortSignal, purpose?: 'branch'): Promise<string | undefined>;
	models(): Promise<ChatModel[]>;
	/** The skills and commands it offers, read again from the CLI; kept as `knownCommands`. */
	commands(): Promise<ChatCommand[]>;
	/** The last list `commands()` (or, for Claude Code, `models()`) read; undefined before one. */
	readonly knownCommands: readonly ChatCommand[] | undefined;
	/**
	 * The plan's limits, read whole. `liveOnly`: only from a process already
	 * running, never one started for it — the chat's own checks after a turn.
	 * Every read that succeeds is also reported to the registry's
	 * `onDidReadUsage`, as is the one detection makes along the way.
	 */
	usage(liveOnly?: boolean): Promise<AgentUsage>;
	/** `priorCostUsd` is what the conversation has cost so far; see `ClaudeSession._processCost`. */
	/**
	 * `root`: the project folder, undefined when no local folder is open — it
	 * decides what a question about a file is (see `outsideProject`), and `cwd`
	 * is then the home directory, which must not count as the project.
	 * `readDirs`: folders beside the project the agent may read — GitHub
	 * repositories added for reference. Claude Code is given them with
	 * `--add-dir`, which spares a question per read; an edit there is still
	 * "outside the project" to the approval menu. Codex reads anywhere already.
	 * `ownSettings` false: the folder came from GitHub and was not trusted yet
	 * — Claude Code loads only the user's settings and MCP servers, never the
	 * project's, whose hooks are shell commands. Codex loads a project's own
	 * configuration only for a project it trusts already.
	 */
	openSession(cwd: string, resume?: string, priorCostUsd?: number, root?: string, readDirs?: readonly string[], ownSettings?: boolean, chatId?: string): AgentSession;
}

export const agentNames: Record<AgentId, string> = {
	claude: 'Claude Code',
	codex: 'Codex',
};

const agentIds: readonly AgentId[] = ['claude', 'codex'];

/**
 * Finds the agents installed on this machine and lists their models.
 *
 * Detection is a real call into each CLI, not a check that a file exists: a
 * binary that is present but signed out, or too old to speak the protocol, is
 * reported as unavailable with the reason, so the dropdown never offers an
 * agent whose first message would fail.
 */
export class AgentRegistry implements vscode.Disposable {
	private readonly _backends = new Map<AgentId, { binary: string; backend: AgentBackend }>();
	private _agents: ChatAgent[] = agentIds.map(id => ({ id, name: agentNames[id], available: false, models: [] }));
	private _detecting: Promise<void> | undefined;
	/** What is running is a full detection, not one agent's `redetect`. */
	private _detectingAll = false;
	private _disposed = false;

	private readonly _onDidChange = new vscode.EventEmitter<void>();
	public readonly onDidChange = this._onDidChange.event;

	private readonly _onDidReplace = new vscode.EventEmitter<{ readonly agent: AgentId; readonly gone: boolean }>();
	/**
	 * A backend is about to be disposed because a Refresh found a different
	 * binary (`gone: false`) or none at all (`gone: true`). Every session it holds
	 * goes with it, so a chat holding one has to drop it and open a new one —
	 * otherwise Claude's next message is ignored in silence and Codex's fails
	 * with "Closed.".
	 *
	 * **Fired before the dispose, not after.** Disposing a Claude session ends
	 * its process and zeroes its turn count without an event, so a listener run
	 * afterwards read `running` as false and never ended the turn: its tool rows
	 * stayed "Running…" and were saved that way.
	 */
	public readonly onDidReplace = this._onDidReplace.event;

	private readonly _onDidReadUsage = new vscode.EventEmitter<AgentUsage>();
	/** A plan's limits read whole, by any backend — detection's read included. */
	public readonly onDidReadUsage = this._onDidReadUsage.event;

	/** `pinned`: the copy of an agent's CLI the project picked by hand, if it did. */
	constructor(
		private readonly _cwd: () => string,
		private readonly _pinned: (id: AgentId) => string | undefined = () => undefined,
		private readonly _browserServer: () => BrowserServer | undefined = () => undefined,
		/** Whether the folder `cwd` names may load its own settings; see `openSession`. */
		private readonly _ownSettings: () => boolean = () => true,
	) { }

	public get agents(): readonly ChatAgent[] {
		return this._agents;
	}

	/** Each available agent's skills and commands, for the "/" palette. */
	public get commands(): Partial<Record<AgentId, readonly ChatCommand[]>> {
		const out: Partial<Record<AgentId, readonly ChatCommand[]>> = {};
		for (const [id, { backend }] of this._backends) {
			if (backend.knownCommands && this._agents.some(a => a.id === id && a.available)) {
				out[id] = backend.knownCommands;
			}
		}
		return out;
	}

	/** When each agent's skills were last listed, and for which working directory. */
	private readonly _commandsAsked = new Map<AgentId, { at: number; cwd: string }>();

	/**
	 * Lists an agent's skills again — the palette opened, and one may have been
	 * added since. At most every 10 s per agent: for Claude Code each listing is
	 * a short-lived CLI process. A failure keeps the list there was. The working
	 * directory is the tab in front's, which can be another project than the
	 * last listing's — its own skills then — so a new folder is always due.
	 */
	public async refreshCommands(id: AgentId): Promise<void> {
		const entry = this._backends.get(id);
		const asked = this._commandsAsked.get(id);
		const last = asked?.at ?? 0;
		const cwd = this._cwd();
		// Not for an agent detection found unusable: listing would start its CLI
		// (Codex's app-server, a Claude probe) for a list the getter drops. A
		// stamp in the future — a clock moved back — is due, not fresh (#224).
		const now = Date.now();
		if (!entry || this._disposed || (now >= last && now - last < 10_000 && asked?.cwd === cwd)
			|| !this._agents.some(a => a.id === id && a.available)) {
			return;
		}
		this._commandsAsked.set(id, { at: Date.now(), cwd });
		const before = JSON.stringify(entry.backend.knownCommands);
		try {
			await entry.backend.commands();
		} catch {
			return;
		}
		// The same backend still, or the list belongs to a copy no longer in use.
		if (!this._disposed && this._backends.get(id) === entry && JSON.stringify(entry.backend.knownCommands) !== before) {
			this._onDidChange.fire();
		}
	}

	public get detecting(): boolean {
		return this._detecting !== undefined;
	}

	public backend(id: AgentId): AgentBackend | undefined {
		return this._backends.get(id)?.backend;
	}

	/** Runs detection, or joins the one already running. */
	public detect(): Promise<void> {
		if (this._disposed) {
			return Promise.resolve();
		}
		// Joining one agent's re-detection would leave the other unchecked.
		if (this._detecting && !this._detectingAll) {
			return this._detecting.then(() => this.detect());
		}
		if (!this._detecting) {
			this._detectingAll = true;
			this._detecting = this._detect().finally(() => {
				this._detecting = undefined;
				this._detectingAll = false;
				this._onDidChange.fire();
			});
			this._onDidChange.fire();
		}
		return this._detecting;
	}

	/**
	 * Detects one agent again, after the copy it uses was picked: the other
	 * agent is left alone — re-detecting it could replace its backend and end a
	 * reply nobody touched — and the copy in use is not held on to, since the
	 * pick asked for a change.
	 */
	public async redetect(id: AgentId): Promise<void> {
		while (this._detecting) {
			await this._detecting;
		}
		if (this._disposed) {
			return;
		}
		this._detectingAll = false;
		this._detecting = (async () => {
			const agent = await this._detectOne(id, false);
			this._agents = this._agents.map(a => a.id === id ? agent : a);
		})().finally(() => {
			this._detecting = undefined;
			this._onDidChange.fire();
		});
		this._onDidChange.fire();
		await this._detecting;
	}

	private async _detect(): Promise<void> {
		this._agents = await Promise.all(agentIds.map(id => this._detectOne(id, true)));
	}

	/** `keepCurrent`: a Refresh keeps the copy in use unless another is proven newer; a pick does not. */
	private async _detectOne(id: AgentId, keepCurrent: boolean): Promise<ChatAgent> {
		const name = agentNames[id];
		// Read once: a pick landing while this runs must not label the copy chosen
		// under the old one.
		const pinned = this._pinned(id);
		const found = await chooseAgentBinary(id, keepCurrent ? this._backends.get(id)?.binary : undefined, pinned);
		const binary = found.chosen;
		const about = {
			copies: found.copies.map(c => ({ path: c.path, version: c.version, source: binarySource(c), bundled: c.source === 'extension' || undefined })),
			binary: binary?.path,
			choice: found.setting ? 'setting' as const : pinned && !found.pinMissing ? 'pinned' as const : 'auto' as const,
			pinMissing: found.pinMissing,
			pinned: found.pinMissing ? pinned : undefined,
		};
		if (!binary) {
			this._drop(id, true);
			const configured = vscode.workspace.getConfiguration('aiBrowser.chat').get<string>(`${id}Path`, '').trim();
			return {
				id, name, available: false, models: [], ...about,
				problem: configured
					? vscode.l10n.t("aiBrowser.chat.{0}Path is set to {1}, which is not an executable file.", id, configured)
					: vscode.l10n.t("{0} was not found. Install its CLI or its VS Code extension, or set aiBrowser.chat.{1}Path.", name, id),
			};
		}

		if (this._disposed) {
			return { id, name, available: false, models: [] };
		}
		let entry = this._backends.get(id);
		if (entry?.binary !== binary.path) {
			this._drop(id, false);
			const seen = (usage: AgentUsage) => { if (!this._disposed) { this._onDidReadUsage.fire(usage); } };
			const backend = id === 'claude'
				? new ClaudeBackend(binary.path, this._cwd, this._browserServer, this._ownSettings, seen)
				: new CodexBackend(binary.path, this._cwd, this._browserServer, seen);
			entry = { binary: binary.path, backend };
			this._backends.set(id, entry);
		}

		const detail = describeBinary(binary) + (about.choice === 'pinned' ? ' (picked for this project)' : '');
		const before = entry.backend.knownCommands;
		try {
			const models = await entry.backend.models();
			if (this._disposed) {
				return { id, name, available: false, models: [] };
			}
			if (!models.length) {
				return { id, name, available: false, models, detail, ...about, problem: vscode.l10n.t("{0} listed no models.", name) };
			}
			// Claude Code's come with the models (models() just replaced the list);
			// Codex's are one more call, made on every detection so a Refresh
			// finds a skill added since. The throttle starts from a real listing.
			if (entry.backend.knownCommands === before) {
				await entry.backend.commands().catch(() => undefined);
			}
			this._commandsAsked.set(id, { at: Date.now(), cwd: this._cwd() });
			return { id, name, available: true, models, detail, ...about };
		} catch (err) {
			return { id, name, available: false, models: [], detail, ...about, problem: err instanceof Error ? err.message : String(err) };
		}
	}

	private _drop(id: AgentId, gone: boolean): void {
		const entry = this._backends.get(id);
		if (!entry) {
			return;
		}
		this._backends.delete(id);
		this._onDidReplace.fire({ agent: id, gone });
		entry.backend.dispose();
	}

	public dispose(): void {
		this._disposed = true;
		for (const { backend } of this._backends.values()) {
			backend.dispose();
		}
		this._backends.clear();
		this._onDidChange.dispose();
		this._onDidReplace.dispose();
		this._onDidReadUsage.dispose();
	}
}
