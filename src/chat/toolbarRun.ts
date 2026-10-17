/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { confirm } from '../core/notify';
import type { AgentBackend, AgentSession } from './agents';
import type { ApprovalRequest } from './agentProtocol';
import type { AgentId, ApprovalMode, ToolbarRun, ToolbarSkill, ToolEntry } from './chatProtocol';
import { approvalKey } from './chatTab';
import { capAt } from '../core/notifyText';
import { extractResult, stepGate, withNextDecision, withResultMarkers, type FilledStep } from './toolbarText';

/** What a run needs from the view that started it. */
export interface ToolbarRunHost {
	/** The approval menu's mode for a category key; see `approvalKey`. */
	approvalMode(key: string): ApprovalMode;
	noteServer(server: string): void;
	/** Something a button shows changed. */
	changed(): void;
}

interface Running {
	skillId: string;
	/** The agent whose backend holds the session: a Refresh replacing it ends the run. */
	agent: AgentId;
	run: ToolbarRun;
	session?: AgentSession;
	/**
	 * The questions the run is stopped on, oldest first; the button shows the
	 * first. A list, not one slot: a turn that runs tools side by side — parallel
	 * sub-agents, each with a command — asks several at once, and a second
	 * question that replaced the first left that one unanswerable while the CLI
	 * still waited on it, the button reading "running" for good.
	 */
	asked: ApprovalRequest[];
	clear?: ReturnType<typeof setTimeout>;
	/** The chat it was pressed in, whose agents list shows it. */
	chatId: string;
	/** Its row in that list. */
	row: ToolEntry;
	/** The reply so far, every step's: the row's report once the run ends, however it ends. */
	reply: string;
	/** The step being run, from 0, and its reply alone: what its check and a clipboard result are read from. */
	step: number;
	stepReply: string;
	/**
	 * Turns Claude Code started on its own — announced by `autoTurn` — still
	 * to end: an agent a step started in the background finished, and the CLI
	 * answers that. Their end is not the end of a step, or the next prompt went
	 * out, and its check was judged, on the wrong reply.
	 */
	ownTurns: number;
	/** The tool calls already counted: Codex can report one start twice. */
	seen: Set<string>;
}

/** The ids of the runs' rows in the agents list; an agent's own row has the CLI's tool id. */
export const runRowPrefix = 'toolbar-run-';
/** How many ended runs a chat's agents list keeps; one chat's runs do not push out another's. */
const endedRowsKept = 20;
/** And all chats together, for a window that runs skills all day. */
const endedRowsKeptInAll = 200;
/** A run's own tool calls kept on its row, as for an agent's. */
const callsKept = 100;
/**
 * The longest report and prompt a row keeps: up to 20 ended rows a chat go out
 * with every state post, so a long reply is cut — the clipboard has it whole.
 */
const rowTextLimit = 20_000;

/** How long a finished run keeps its done or failed look on the button. */
const shownForMs = 2500;
/** How long a failed run keeps its look, so its reason can be read on hover. */
const failedShownForMs = 8000;

/** Which of a skill's runs its button shows: one waiting on the user, else one running, else the last to end. */
function rank(run: ToolbarRun): number {
	return run.status === 'waiting' ? 3 : run.status === 'running' ? 2 : 1;
}

/**
 * Toolbar skills whose result goes to the clipboard or nowhere: each run is a
 * conversation of its own, never shown in a tab — a session opened on the
 * agent's backend, sent the prompt, and let go when its turn ends.
 *
 * Its questions are answered by the approval menu like a tab's; one the menu
 * leaves to the user stops the run and turns its button to "waiting", and the
 * answer comes from the button's own popover, since there is no conversation
 * to show a card in. A skill may run more than once at a time — the button
 * asks first (`again`) — and its button shows the run that most needs the
 * user: one waiting, else one running, else the last to end.
 */
export class ToolbarRuns implements vscode.Disposable {
	private readonly _runs = new Map<number, Running>();
	/** Rows of runs that ended, newest last: the list keeps them so their reports can be read. */
	private _ended: { chatId: string; row: ToolEntry }[] = [];
	private _next = 0;
	private _disposed = false;

	constructor(private readonly _host: ToolbarRunHost) { }

	public get state(): Record<string, ToolbarRun> {
		const out: Record<string, ToolbarRun> = {};
		for (const r of this._runs.values()) {
			const shown = out[r.skillId];
			if (!shown || rank(r.run) > rank(shown) || (rank(r.run) === rank(shown) && (r.run.endedAt ?? 0) >= (shown.endedAt ?? 0))) {
				out[r.skillId] = r.run;
			}
		}
		for (const id of Object.keys(out)) {
			const count = this._running(id).length;
			if (count > 1) {
				out[id] = { ...out[id], count };
			}
		}
		return out;
	}

	private _running(skillId: string): Running[] {
		return [...this._runs.values()].filter(r => r.skillId === skillId && (r.run.status === 'running' || r.run.status === 'waiting'));
	}

	public isRunning(id: string): boolean {
		return this._running(id).length > 0;
	}

	/**
	 * The runs pressed in a chat, as rows of its agents list — asked for: a run
	 * is an agent working in the background, and nothing else showed what it was
	 * doing. Running ones and the last that ended, oldest first.
	 */
	public rows(chatId: string): ToolEntry[] {
		const live = [...this._runs.values()].filter(r => r.chatId === chatId && r.session).map(r => r.row);
		return [...this._ended.filter(e => e.chatId === chatId).map(e => e.row), ...live].sort((a, b) => a.startedAt - b.startedAt);
	}

	/** How many runs pressed in a chat are still going, for its tab's agent count. */
	public runningIn(chatId: string): number {
		return [...this._runs.values()].filter(r => r.chatId === chatId && r.session).length;
	}

	/** Every run pressed in a chat, which its tab has let go of (`TabHost.released`). */
	public stopChat(chatId: string): void {
		for (const [key, entry] of this._runs) {
			if (entry.chatId === chatId && entry.session) {
				this._end(key, entry, { status: 'failed', message: vscode.l10n.t("Stopped."), endedAt: Date.now() }, failedShownForMs, true);
			}
		}
	}

	/** Stops one run, from the agents list; false when it is not one of these or already over. */
	public stopRow(rowId: string): boolean {
		for (const [key, entry] of this._runs) {
			if (entry.row.id === rowId && entry.session) {
				this._end(key, entry, { status: 'failed', message: vscode.l10n.t("Stopped."), endedAt: Date.now() }, failedShownForMs, true);
				return true;
			}
		}
		return false;
	}

	/**
	 * `steps` are the skill's prompts, filled in and written for the agent: the
	 * first is sent now and each next one, in the same session, once the turn
	 * before it has ended and its check — if it has one — passed. The row shows
	 * the user's own text; the instructions added around it (the check's
	 * markers, the clipboard's) are ours.
	 */
	public start(skill: ToolbarSkill, steps: readonly FilledStep[], chatId: string, backend: AgentBackend, model: string, effort: string | undefined, cwd: string, root: string | undefined): void {
		if (this._disposed) {
			return;
		}
		// A finished run of the same skill stops showing: the new one is what the button is about.
		for (const [key, r] of this._runs) {
			if (r.skillId === skill.id && !this._running(skill.id).includes(r)) {
				if (r.clear) {
					clearTimeout(r.clear);
				}
				this._runs.delete(key);
			}
		}
		if (!steps.length) {
			return;
		}
		const key = ++this._next;
		const session = backend.openSession(cwd, undefined, 0, root);
		const many = steps.length > 1;
		const shown = many
			? steps.map((step, i) => `${i + 1}. ${step.check ? `(if: ${step.check}) ` : ''}${step.text}`).join('\n\n')
			: steps[0].text;
		const row: ToolEntry = {
			kind: 'tool', id: `${runRowPrefix}${key}`, tool: 'agent', name: skill.name, detail: many ? `/${skill.name} · 1/${steps.length}` : `/${skill.name}`,
			input: capAt(shown, rowTextLimit), status: 'running', startedAt: Date.now(),
			agent: { type: skill.result === 'clipboard' ? 'toolbar skill · to the clipboard' : 'toolbar skill · silent', model, background: true, origin: 'toolbar', skill: skill.id, toolUses: 0, tokens: 0, calls: [] },
		};
		const entry: Running = {
			skillId: skill.id, agent: backend.id, run: many ? { status: 'running', step: 1, steps: steps.length } : { status: 'running' },
			session, asked: [], chatId, row, reply: '', seen: new Set(), step: 0, stepReply: '', ownTurns: 0,
		};
		this._runs.set(key, entry);
		const current = () => this._runs.get(key) === entry && entry.session === session;
		session.onEvent(event => {
			if (!current()) {
				return;
			}
			switch (event.type) {
				case 'text':
					entry.reply += event.text;
					entry.stepReply += event.text;
					return;
				case 'textBreak':
					entry.reply += entry.reply && !entry.reply.endsWith('\n\n') ? '\n\n' : '';
					entry.stepReply += entry.stepReply ? '\n\n' : '';
					return;
				case 'tool': {
					// Its own calls, as an agent's card lists them; the reply is set on
					// the row only at the end, or the list rebuilt on every chunk (#365).
					const info = row.agent!;
					if (entry.seen.has(event.id)) {
						return;
					}
					entry.seen.add(event.id);
					if (info.calls.length < callsKept) {
						info.calls.push({ name: event.tool.name, detail: event.tool.detail });
					}
					info.toolUses = (info.toolUses ?? 0) + 1;
					info.lastTool = event.tool.name;
					this._host.changed();
					return;
				}
				case 'tokens':
					row.agent!.tokens = event.cumulative ? event.input + event.output : (row.agent!.tokens ?? 0) + event.input + event.output;
					this._host.changed();
					return;
				case 'approval': {
					const request = event.request;
					// A question with choices has no conversation to be shown in
					// and is skipped: the agent is told to go on with its best
					// judgement and say what it chose.
					if (request.questions) {
						session.answer(request.id, false);
						return;
					}
					if (request.what === 'mcp' && request.server) {
						this._host.noteServer(request.server);
					}
					const mode = this._host.approvalMode(approvalKey(request));
					if (mode !== 'ask') {
						session.answer(request.id, mode === 'auto');
						return;
					}
					entry.asked.push(request);
					this._showAsked(entry);
					return;
				}
				case 'approvalDone':
					if (entry.asked.some(q => q.id === event.id)) {
						entry.asked = entry.asked.filter(q => q.id !== event.id);
						this._showAsked(entry);
					}
					return;
				case 'autoTurn':
					entry.ownTurns++;
					return;
				case 'turnEnd': {
					if (entry.ownTurns > 0 && !event.error) {
						entry.ownTurns--;
						return;
					}
					entry.ownTurns = 0;
					const next = steps[entry.step + 1];
					if (!next) {
						void this._finish(skill, key, entry, event.error, entry.stepReply);
						return;
					}
					const gate = stepGate(next.check, event.error, entry.stepReply);
					if (!gate.go) {
						// The skill stops here, as asked: not a failure of the run unless
						// the step itself failed.
						const why = vscode.l10n.t("Stopped after prompt {0} of {1}: {2}.", entry.step + 1, steps.length, gate.why);
						this._end(key, entry, event.error
							? { status: 'failed', message: `${event.error} ${why}`, endedAt: Date.now() }
							: { status: 'done', message: why, endedAt: Date.now() }, event.error ? failedShownForMs : shownForMs);
						if (!event.error) {
							confirm(vscode.l10n.t("{0}: {1}", skill.label ?? skill.name, why));
						}
						return;
					}
					entry.step++;
					send();
					return;
				}
			}
		});
		// The prompt of the step being run, with what the agent is asked to add:
		// the check of the step after it, or, on the last, the clipboard markers.
		const send = () => {
			const at = entry.step;
			let text = steps[at].text;
			const check = steps[at + 1]?.check;
			if (check) {
				text = withNextDecision(text, check);
			} else if (at === steps.length - 1 && skill.result === 'clipboard') {
				text = withResultMarkers(text);
			}
			entry.stepReply = '';
			if (many) {
				entry.run = { ...entry.run, step: at + 1, steps: steps.length };
				row.detail = `/${skill.name} · ${at + 1}/${steps.length}`;
				if (at > 0) {
					entry.reply += entry.reply ? '\n\n---\n\n' : '';
				}
			}
			this._host.changed();
			session.send({ text, images: [] }, model, effort).catch(err => {
				if (current()) {
					void this._finish(skill, key, entry, err instanceof Error ? err.message : String(err), entry.stepReply);
				}
			});
		};
		send();
	}

	/**
	 * The answer to the question the user was shown, named by its id. With two
	 * runs of the skill waiting, the button shows the newer one's question, and
	 * answering "the skill's" — the first found — approved a command nobody had
	 * seen. A question that is no longer open is not answered at all.
	 */
	public answer(skillId: string, approvalId: string, allow: boolean): void {
		const entry = this._running(skillId).find(r => r.session && r.asked.some(q => q.id === approvalId));
		if (!entry?.session) {
			return;
		}
		entry.session.answer(approvalId, allow);
		entry.asked = entry.asked.filter(q => q.id !== approvalId);
		this._showAsked(entry);
	}

	/**
	 * The approval menu changed: a question whose category is no longer on Ask
	 * is answered now, as a tab's waiting cards are (`approvalModesChanged`).
	 */
	public approvalModesChanged(): void {
		for (const entry of this._runs.values()) {
			const session = entry.session;
			if (!session || !entry.asked.length) {
				continue;
			}
			const left: ApprovalRequest[] = [];
			for (const q of entry.asked) {
				const mode = this._host.approvalMode(approvalKey(q));
				if (mode === 'ask') {
					left.push(q);
				} else {
					session.answer(q.id, mode === 'auto');
				}
			}
			if (left.length !== entry.asked.length) {
				entry.asked = left;
				this._showAsked(entry);
			}
		}
	}

	/** The run's look: waiting on its oldest open question, else running. */
	private _showAsked(entry: Running): void {
		const q = entry.asked[0];
		const approval = q ? { id: q.id, title: q.title, detail: q.detail } : undefined;
		const step = entry.run.steps ? { step: entry.run.step, steps: entry.run.steps } : {};
		entry.run = approval ? { status: 'waiting', approval, ...step } : { status: 'running', ...step };
		// The agents list says so too, and answers it there as the button does.
		entry.row.agent!.waiting = approval;
		this._host.changed();
	}

	/**
	 * The view closed: nothing can show a run or answer its question any more,
	 * so every run still going ends, as the tabs' conversations do — a CLI is
	 * not left working unseen on the user's quota (#356). The view is kept
	 * while hidden (`retainContextWhenHidden`), so this is a real close.
	 */
	public viewClosed(): void {
		for (const [key, entry] of this._runs) {
			if (entry.run.status === 'running' || entry.run.status === 'waiting') {
				this._end(key, entry, { status: 'failed', message: vscode.l10n.t("The chat view was closed."), endedAt: Date.now() }, failedShownForMs);
			}
		}
	}

	/** Every run of the skill still going. */
	public stop(skillId: string): void {
		for (const [key, entry] of this._runs) {
			if (entry.skillId === skillId && (entry.run.status === 'running' || entry.run.status === 'waiting')) {
				this._end(key, entry, { status: 'failed', message: vscode.l10n.t("Stopped."), endedAt: Date.now() }, failedShownForMs, true);
			}
		}
	}

	private async _finish(skill: ToolbarSkill, key: number, entry: Running, error: string | undefined, reply: string): Promise<void> {
		if (this._runs.get(key) !== entry || !entry.session) {
			return;
		}
		const name = skill.label ?? skill.name;
		if (error) {
			this._end(key, entry, { status: 'failed', message: error, endedAt: Date.now() }, failedShownForMs);
			return;
		}
		if (skill.result !== 'clipboard') {
			this._end(key, entry, { status: 'done', message: vscode.l10n.t("Done."), endedAt: Date.now() }, shownForMs);
			confirm(vscode.l10n.t("{0} is done.", name));
			return;
		}
		// No markers: the model ignored the instruction. Its last code block is
		// the next best thing, then the whole reply; the button says which.
		const found = extractResult(reply);
		const copied = found?.text ?? reply.trim();
		if (!copied) {
			this._end(key, entry, { status: 'failed', message: vscode.l10n.t("The reply was empty; nothing was copied."), endedAt: Date.now() }, failedShownForMs);
			return;
		}
		try {
			await vscode.env.clipboard.writeText(copied);
		} catch (err) {
			if (this._runs.get(key) === entry && entry.session) {
				this._end(key, entry, { status: 'failed', message: err instanceof Error ? err.message : String(err), endedAt: Date.now() }, failedShownForMs);
			}
			return;
		}
		// Stopped, forgotten or disposed while the clipboard was written: that
		// ending stands, rather than being overwritten with "Copied".
		if (this._runs.get(key) !== entry || !entry.session) {
			return;
		}
		const message = found?.source === 'markers'
			? vscode.l10n.t("Copied to the clipboard.")
			: found?.source === 'fence'
				? vscode.l10n.t("The reply had no result markers; its last code block was copied.")
				: vscode.l10n.t("The reply had no result markers; the whole reply was copied.");
		this._end(key, entry, { status: 'done', message, endedAt: Date.now() }, shownForMs);
		confirm(vscode.l10n.t("{0}: {1}", name, message));
	}

	/** The session is let go here, every way a run ends: a Claude process ends with it. */
	private _end(key: number, entry: Running, run: ToolbarRun, shownFor: number, stopped = false): void {
		const session = entry.session;
		entry.session = undefined;
		entry.asked = [];
		entry.run = run;
		session?.dispose();
		if (this._disposed) {
			return;
		}
		const row = entry.row;
		this._closeRow(entry, run.status === 'done' ? 'done' : stopped ? 'stopped' : 'failed', run.endedAt);
		if (run.status !== 'done' && run.message && !stopped) {
			row.output = row.output ? `${run.message}\n\n${row.output}` : run.message;
		} else if (run.status === 'done' && run.message) {
			row.output = row.output ? `${row.output}\n\n*${run.message}*` : run.message;
		}
		this._keepEnded(entry.chatId, row);
		this._host.changed();
		entry.clear = setTimeout(() => {
			if (this._runs.get(key) === entry) {
				this._runs.delete(key);
				this._host.changed();
			}
		}, shownFor);
	}

	/**
	 * A Refresh replaced the agent's backend, which disposes every session it
	 * held — and a disposed session reports no end of its turn (Claude's is
	 * suppressed once disposed, Codex's emitter is gone), so without this the
	 * run read "running" for the life of the view, and a question it was
	 * stopped on offered an Allow that reached nothing. The registry announces
	 * the replacement before disposing, so the session is let go here first.
	 */
	public backendReplaced(agent: AgentId, gone: boolean): void {
		for (const [key, entry] of this._runs) {
			if (entry.agent === agent && entry.session && (entry.run.status === 'running' || entry.run.status === 'waiting')) {
				const message = gone
					? vscode.l10n.t("The agent is no longer installed; the run ended.")
					: vscode.l10n.t("The agent was replaced by another installed copy; the run ended. Run it again.");
				this._end(key, entry, { status: 'failed', message, endedAt: Date.now() }, failedShownForMs);
			}
		}
	}

	/** The row stays in its chat's list once the button has forgotten the run: its end, and the reply as its report. */
	private _closeRow(entry: Running, status: ToolEntry['status'], endedAt = Date.now()): void {
		const row = entry.row;
		row.output = capAt(entry.reply.trim(), rowTextLimit) || undefined;
		row.status = status;
		row.endedAt = endedAt;
		row.agent!.lastTool = undefined;
		row.agent!.waiting = undefined;
	}

	private _keepEnded(chatId: string, row: ToolEntry): void {
		this._ended.push({ chatId, row });
		const mine = this._ended.filter(e => e.chatId === chatId);
		if (mine.length > endedRowsKept) {
			const drop = new Set(mine.slice(0, mine.length - endedRowsKept));
			this._ended = this._ended.filter(e => !drop.has(e));
		}
		this._ended = this._ended.slice(-endedRowsKeptInAll);
	}

	/** A skill deleted while it runs: stopped, and nothing left to show. */
	public forget(skillId: string): void {
		for (const [key, entry] of this._runs) {
			if (entry.skillId !== skillId) {
				continue;
			}
			if (entry.session) {
				// A deleted skill's run still ran: its row says it was stopped.
				this._closeRow(entry, 'stopped');
				this._keepEnded(entry.chatId, entry.row);
			}
			if (entry.clear) {
				clearTimeout(entry.clear);
			}
			entry.session?.dispose();
			this._runs.delete(key);
		}
	}

	public dispose(): void {
		this._disposed = true;
		for (const entry of this._runs.values()) {
			if (entry.clear) {
				clearTimeout(entry.clear);
			}
			entry.session?.dispose();
			entry.session = undefined;
		}
		this._runs.clear();
	}
}
