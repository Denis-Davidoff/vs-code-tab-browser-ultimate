/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { describeBinary, findAgentBinary } from './agentBinary';
import type { AgentEvent } from './agentProtocol';
import type { AgentId, AgentUsage, ChatAgent, ChatModel } from './chatProtocol';
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
}

export interface AgentBackend extends vscode.Disposable {
	readonly id: AgentId;
	models(): Promise<ChatModel[]>;
	usage(): Promise<AgentUsage>;
	/** `priorCostUsd` is what the conversation has cost so far; see `ClaudeSession._processCost`. */
	openSession(cwd: string, resume?: string, priorCostUsd?: number): AgentSession;
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

	constructor(private readonly _cwd: () => string) { }

	public get agents(): readonly ChatAgent[] {
		return this._agents;
	}

	public get detecting(): boolean {
		return this._detecting !== undefined;
	}

	public backend(id: AgentId): AgentBackend | undefined {
		return this._backends.get(id)?.backend;
	}

	/** Runs detection, or joins the one already running. */
	public detect(): Promise<void> {
		this._detecting ??= this._detect().finally(() => {
			this._detecting = undefined;
			this._onDidChange.fire();
		});
		this._onDidChange.fire();
		return this._detecting;
	}

	private async _detect(): Promise<void> {
		this._agents = await Promise.all(agentIds.map(id => this._detectOne(id)));
	}

	private async _detectOne(id: AgentId): Promise<ChatAgent> {
		const name = agentNames[id];
		const binary = await findAgentBinary(id, this._backends.get(id)?.binary);
		if (!binary) {
			this._drop(id, true);
			const configured = vscode.workspace.getConfiguration('aiBrowser.chat').get<string>(`${id}Path`, '').trim();
			return {
				id, name, available: false, models: [],
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
			const backend = id === 'claude' ? new ClaudeBackend(binary.path, this._cwd) : new CodexBackend(binary.path, this._cwd);
			entry = { binary: binary.path, backend };
			this._backends.set(id, entry);
		}

		const detail = describeBinary(binary);
		try {
			const models = await entry.backend.models();
			if (this._disposed) {
				return { id, name, available: false, models: [] };
			}
			if (!models.length) {
				return { id, name, available: false, models, detail, problem: vscode.l10n.t("{0} listed no models.", name) };
			}
			return { id, name, available: true, models, detail };
		} catch (err) {
			return { id, name, available: false, models: [], detail, problem: err instanceof Error ? err.message : String(err) };
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
	}
}
