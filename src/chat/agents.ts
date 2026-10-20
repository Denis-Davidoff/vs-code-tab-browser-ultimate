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
import { GeminiBackend } from './geminiAgent';

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
	 * steers it, Claude Code queues it — rather than refused. Resolves whether
	 * the message reached the agent: `false` when the session gave it up on the
	 * way — disposed, or stopped before any turn began — without throwing.
	 */
	send(input: TurnInput, model: string, effort: string | undefined): Promise<boolean>;
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
	generateCommitMessage?(model: string, effort: string | undefined, context: string, signal: AbortSignal, systemPrompt?: string): Promise<string>;
	/** Optional one-shot title on a small model; never uses a conversation session. */
	generateTitle?(model: ChatModel, context: string, signal: AbortSignal, purpose?: 'branch', systemPrompt?: string): Promise<string | undefined>;
	models(): Promise<ChatModel[]>;
	/** The skills and commands it offers, read again from the CLI; kept as `knownCommands`. */
	commands(cwd?: string, ownSettings?: boolean): Promise<ChatCommand[]>;
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
	gemini: 'Gemini CLI',
};

const agentIds: readonly AgentId[] = ['claude', 'codex', 'gemini'];

/** A value the view sent, checked to name one of the agents. */
export function isAgentId(value: unknown): value is AgentId {
	return typeof value === 'string' && (agentIds as readonly string[]).includes(value);
}

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
	public get commands(): Partial<Record<AgentId, readonly ChatCommand[]>> { return this.commandsFor(this._cwd()); }

	/** Project command lists belong to a requesting folder, not a shared backend. */
	public commandsFor(cwd: string): Partial<Record<AgentId, readonly ChatCommand[]>> {
		const out: Partial<Record<AgentId, readonly ChatCommand[]>> = {};
		for (const agent of this._agents) {
			const commands = this._commandLists.get(`${agent.id}\0${cwd}`);
			if (agent.available && commands) { out[agent.id] = commands; }
		}
		return out;
	}

	private readonly _commandLists = new Map<string, readonly ChatCommand[]>();
	private readonly _commandsAsked = new Map<string, number>();

	public async refreshCommands(id: AgentId, cwd = this._cwd(), ownSettings = this._ownSettings()): Promise<void> {
		const entry = this._backends.get(id);
		const key = `${id}\0${cwd}`;
		const last = this._commandsAsked.get(key);
		const now = Date.now();
		if (!entry || this._disposed || (last !== undefined && now >= last && now - last < 10_000)
			|| !this._agents.some(agent => agent.id === id && agent.available)) { return; }
		this._commandsAsked.set(key, now);
		try {
			const commands = await entry.backend.commands(cwd, ownSettings);
			if (this._disposed || this._backends.get(id) !== entry) { return; }
			const before = this._commandLists.get(key);
			this._commandLists.set(key, commands);
			if (JSON.stringify(before) !== JSON.stringify(commands)) { this._onDidChange.fire(); }
		} catch { this._commandsAsked.delete(key); }
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
					: id === 'gemini'
						// Its companion extension carries no CLI, so it is no way to install one.
						? vscode.l10n.t("Gemini CLI was not found. Install it (`npm install -g @google/gemini-cli` or `brew install gemini-cli`), or set aiBrowser.chat.geminiPath.")
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
				: id === 'codex'
					? new CodexBackend(binary.path, this._cwd, this._browserServer, seen)
					: new GeminiBackend(binary.path, this._cwd, this._browserServer);
			entry = { binary: binary.path, backend };
			this._backends.set(id, entry);
		}

		const detail = describeBinary(binary) + (about.choice === 'pinned' ? ' (picked for this project)' : '');
		const before = entry.backend.knownCommands;
		const commandsCwd = this._cwd();
		const ownSettings = this._ownSettings();
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
			const commands = entry.backend.knownCommands === before
				? await entry.backend.commands(commandsCwd, ownSettings).catch(() => undefined)
				: entry.backend.knownCommands;
			if (commands) {
				this._commandLists.set(`${id}\0${commandsCwd}`, [...commands]);
				this._commandsAsked.set(`${id}\0${commandsCwd}`, Date.now());
			}
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
		for (const key of this._commandLists.keys()) { if (key.startsWith(`${id}\0`)) { this._commandLists.delete(key); this._commandsAsked.delete(key); } }
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
