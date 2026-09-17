/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BrowserController } from './browserController';
import type { ClientKind } from './mcpProtocol';
import { portOffset, portOrder } from './mcpPort';
import { McpServer } from './mcpServer';
import {
	missingWorkspaceTokens, emptyScan, markWorkspaceAlive, markWorkspaceHandled, registerWithVsCode,
	repairConfigs, stillMissing, tokenKeyPrefix, workspaceFolder, type RepairReport,
} from './mcpSetup';
import { confirm } from './notify';
import { generateUuid } from './uuid';

/**
 * How long a queued repair waits for the one before it before going anyway.
 *
 * Generous on purpose: it is not a deadline for the work, only the point at
 * which "wait your turn" stops being worth more than "run at all". See
 * {@link McpLifecycle._repairs}.
 */
const repairQueueWaitMs = 15_000;

/** A timer that never keeps the extension host alive on its own. */
function settleAfter(ms: number): Promise<void> {
	return new Promise<void>(resolve => {
		const timer = setTimeout(resolve, ms);
		(timer as { unref?: () => void }).unref?.();
	});
}

export type McpState =
	| { kind: 'starting' }
	| { kind: 'running'; server: McpServer }
	| { kind: 'disabled' }
	| { kind: 'failed'; error: string };

/**
 * Owns the MCP server's lifetime.
 *
 * The server's own disposables are kept apart from `context.subscriptions`:
 * turning the setting off has to give the port back without tearing down the
 * extension.
 */
export class McpLifecycle implements vscode.Disposable {

	private _state: McpState = { kind: 'starting' };
	private _parts: vscode.Disposable[] = [];

	/** Serialises restarts; two setting changes in a row must not race for a port. */
	private _chain: Promise<void> = Promise.resolve();

	/**
	 * `Mcp-Session-Id` → which assistant owns it, kept **across** restarts.
	 *
	 * The server used to own this and clear it on dispose, which made every
	 * live conversation anonymous again whenever a setting restarted it — and
	 * an assistant that had been given a tab then went back to following the
	 * user, because the assignment is keyed on the assistant and nothing could
	 * say which one was calling. It belongs to the window, so it lives here.
	 */
	private readonly _sessionKinds = new Map<string, ClientKind>();

	private readonly _onDidChangeState = new vscode.EventEmitter<McpState>();
	public readonly onDidChangeState = this._onDidChangeState.event;

	/**
	 * Keeps this window's "still serving" stamp fresh while it stays open.
	 *
	 * Hourly, and a plain interval rather than a one-shot: a window that stays
	 * open for days would otherwise stamp itself once and then age out of the
	 * prune's grace period while very much alive — the same one-shot mistake
	 * the promo build's update check made. The tick only has to be far finer
	 * than `seenGraceMs`; at an hour against seven days the margin is 168.
	 */
	private readonly _heartbeat: ReturnType<typeof setInterval>;

	/**
	 * The folder the running server's token was minted for.
	 *
	 * **The heartbeat stamps this, not `workspaceFolder()`, and the difference
	 * is a live server losing its config entry.** `workspaceFolder()` is
	 * `workspaceFolders[0]`, which moves: remove or reorder the first folder of
	 * a multi-root window and it names a different folder — while the server
	 * keeps running and keeps accepting the token minted for the old one,
	 * because nothing restarts it (only `aiBrowser.mcp.*` changes call
	 * `apply()`). The stamp would then follow the new folder, the old one would
	 * age past the grace period, and another window would delete the entry of a
	 * server that is still answering. The identity to keep alive is the one the
	 * server is serving.
	 */
	private _servedFolder: vscode.WorkspaceFolder | undefined;

	/**
	 * Which `_apply` a piece of deferred work belongs to.
	 *
	 * `_chain` serialises `_apply` itself, but the repair is deliberately not
	 * awaited, so two runs can have repairs in flight at once and the file lock
	 * decides which lands last — which can be the *older* one. Two quick edits
	 * to `aiBrowser.mcp.port` then leave the superseded port in the config: the
	 * exact stale-port symptom this whole feature exists to remove, and it
	 * would sit there until the next window start. The window is real: the survey
	 * can spend up to `2 * statTimeoutMs` on a single stalled folder — two
	 * sequential `presence` calls — and the two project configs are repaired
	 * before it even runs.
	 */
	private _generation = 0;

	/**
	 * Serialises the repairs themselves, which `_chain` does not.
	 *
	 * `_chain` orders `_apply`, but the repair is deliberately not awaited by it
	 * — activation must not wait on a filesystem survey — so without this two
	 * repairs could be in flight at once and the file lock alone decided which
	 * landed last. The generation check under the lock (`stillWanted`) is the
	 * last word before a write, and it is still not enough on its own: an older
	 * repair can take the lock *before* the generation moves, pass its check,
	 * and still be inside `writeText` — which awaits a directory creation and a
	 * filesystem write — when the newer run arrives. `withLock` gives up after
	 * `attempts * retryMs`, one second, so on slow or network-backed storage the
	 * newer run is starved out entirely and the obsolete endpoint is what
	 * remains on disk.
	 *
	 * Chaining them makes that ordering hold: a repair does not begin until the
	 * previous one has settled, so the newest writes last and never contends
	 * with its own predecessor for the lock.
	 *
	 * **The wait on the predecessor is bounded, and that is not a detail.**
	 * `repairConfigs` reaches `vscode.workspace.fs.readFile`, `createDirectory`
	 * and `writeFile`, none of which carries a timeout — the same property that
	 * forced `statTimeoutMs` onto the survey — and `withLock` bounds only
	 * *acquiring* the lock, never the work under it. An unbounded chain would
	 * therefore turn one stalled network home into a permanent stop on every
	 * later repair in the window: no port fix, for any config, with nothing
	 * logged, until the window is restarted. That is item 47's shape — an
	 * unbounded call behind a serialising gate — and the gate added here would
	 * have been the thing that created it.
	 *
	 * So a queued repair waits {@link repairQueueWaitMs} for its predecessor and
	 * then proceeds regardless. Normal runs finish far inside that budget (three
	 * lock acquisitions of at most a second each, plus a parallel survey capped
	 * by `statTimeoutMs`), so the ordering property holds in every case it was
	 * introduced for; a run that has hung degrades to the old concurrent
	 * behaviour, where the lock and `stillWanted` still protect the write, rather
	 * than to no repairs at all. Nothing awaits this chain, so activation is
	 * unaffected either way.
	 */
	private _repairs: Promise<void> = Promise.resolve();

	/** Set before anything is torn down, so work in flight can stop. */
	private _disposed = false;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly browser: BrowserController,
		private readonly version: string,
	) {
		// **Only `_servedFolder`, and only once there is one.** Stamping
		// `workspaceFolder()` unconditionally wrote a `mcp.seen:` row for every
		// window, including one with `aiBrowser.mcp.enabled: false` — which
		// never reaches `_workspaceToken`, so the row had no `mcp.token:` to
		// belong to. Nothing reads such a row (the scan iterates token keys) and
		// nothing removes it, so it accumulated one permanent entry per folder
		// ever opened with MCP off, in a memento rewritten whole on every
		// update. A window that serves nothing has nothing to keep alive.
		this._heartbeat = setInterval(() => {
			void markWorkspaceAlive(this.context.globalState, this._servedFolder).catch(() => { });
		}, 60 * 60 * 1000);
	}

	public get state(): McpState {
		return this._state;
	}

	private _setState(state: McpState): void {
		this._state = state;
		this._onDidChangeState.fire(state);
	}

	/**
	 * The token is per *workspace*, not per user.
	 *
	 * A config can end up addressing the window that has another project open —
	 * ports move when windows are opened in a different order. With a
	 * workspace-scoped token that mistake is an honest 401 instead of an agent
	 * quietly editing the wrong project.
	 *
	 * It is also the **identity** the startup repair matches on: the token is
	 * the only part of an entry that is stable and provably ours, which is what
	 * lets `repairConfigs` correct a stale port without touching anybody else's
	 * server. Never regenerate it for an existing workspace — every config
	 * naming this window would become unrecognisable at once.
	 */
	private _workspaceToken(folder: vscode.WorkspaceFolder | undefined): string {
		const key = `${tokenKeyPrefix}${folder?.uri.toString() ?? 'no-folder'}`;
		const existing = this.context.globalState.get<string>(key);
		if (existing) {
			return existing;
		}
		const token = `${generateUuid()}${generateUuid()}`.replace(/-/g, '');
		// The one write in this file whose loss is unrecoverable (item 97), and
		// it was the one with no handler at all — item 100's rule broken in the
		// file that states it. It still cannot be awaited, because the caller
		// needs the token synchronously, but a rejection must not escape.
		void Promise.resolve(this.context.globalState.update(key, token)).catch(() => { });
		return token;
	}

	/** Applies the current settings, restarting the server if needed. */
	public apply(): Promise<void> {
		this._chain = this._chain.catch(() => { }).then(() => this._apply());
		return this._chain;
	}

	private async _apply(): Promise<void> {
		for (const part of this._parts) {
			part.dispose();
		}
		this._parts = [];

		// Bumped **before** the enabled check, and `_servedFolder` cleared with
		// it. Turning the MCP server off has to invalidate a repair still in
		// flight from the previous run just as a restart does — returning early
		// left that older repair authoritative, free to write a port for a
		// server that no longer exists. And a window that is not serving must
		// not go on stamping its folder as served, or nothing in that workspace
		// can ever become prunable while the window stays open.
		const generation = ++this._generation;
		this._servedFolder = undefined;

		const configuration = vscode.workspace.getConfiguration('aiBrowser');
		if (!configuration.get<boolean>('mcp.enabled', true)) {
			this._setState({ kind: 'disabled' });
			return;
		}

		this._setState({ kind: 'starting' });

		// Folder and token are resolved together, before the first await.
		// `_workspaceToken` used to read `workspaceFolders[0]` again for itself,
		// so an await in between could hand the server a token minted for one
		// folder while the heartbeat protected another — the identity mismatch
		// `_servedFolder` exists to prevent, reintroduced through the await.
		const folder = workspaceFolder();
		const token = this._workspaceToken(folder);
		const server = new McpServer(
			this.browser, token, folder?.name, this.version, this._sessionKinds);

		try {
			await server.start(this._portOrder(configuration, folder));
		} catch (err) {
			server.dispose();
			this._setState({ kind: 'failed', error: err instanceof Error ? err.message : String(err) });
			return;
		}

		if (this._disposed || generation !== this._generation) {
			// Disposed, or superseded, while `start` was in flight. Pushing into
			// `_parts` now would hand the server to an array nobody disposes
			// again, leaving a loopback HTTP server listening after the window
			// is done with it.
			server.dispose();
			return;
		}

		// Only now: the window is actually serving this folder's token, so only
		// now may the heartbeat claim it. Set before `start` succeeded, a failed
		// or refused start left the stamp being refreshed hourly for a server
		// that never came up.
		this._servedFolder = folder;

		// **Stamped here, not before `start`**, for the reason directly above and
		// for item 107's rule: keep alive only what is actually being served. A
		// stamp taken earlier was written even when the start then failed or was
		// superseded — and because `markWorkspaceAlive` also *lifts* the handled
		// marker, a window whose server never came up would clear that marker,
		// put the folder back into the scan, and hold off its pruning for the
		// whole grace period on the strength of a server that does not exist.
		//
		// Not awaited, and that is deliberate: an await here would sit between
		// the supersede check above and the `_parts.push` below, which is
		// precisely the gap item 103 is about — a dispose landing inside it
		// leaves a listening server in an array nobody disposes again. The
		// rejection is handled, so nothing escapes.
		void markWorkspaceAlive(this.context.globalState, folder).catch(() => { });

		this._parts.push(server);
		const registration = registerWithVsCode(server, this.version);
		if (registration) {
			this._parts.push(registration);
		}

		this._setState({ kind: 'running', server });

		// Repair runs after the port is known and must never be able to hold up
		// activation, so it is not awaited and cannot throw into this path. The
		// missing-workspace scan is part of the same chain for the same reason: it
		// stats a handful of folders, which is cheap but not instant.
		//
		// **The guard is a trailing `catch`, not the second argument of `then`,
		// and that is the whole of it.** `p.then(onFulfilled, onRejected)`
		// routes only *p*'s rejection into `onRejected` — never one thrown by
		// `onFulfilled` itself. This chain used to read
		// `repairConfigs(server).then(report => …, () => { })`, where the repair
		// *was* `p` and the handler covered it; moving the repair inside the
		// callback silently turned that handler into unreachable code and let a failed
		// config write (`writeText` is the one unguarded call, and `withLock`
		// rethrows it) escape as an unhandled rejection in the extension host —
		// on the one path written to be silent.
		//
		// **The scan is handed over as a pair of functions, not as a result**, and
		// the two run in different places on purpose. The survey stats the
		// filesystem, so it runs outside every lock; `confirm` re-reads
		// `globalState` alone and runs *under* the config lock, immediately
		// before the write. Passing a resolved set instead let an older verdict
		// delete an entry that had become live again (item 99); running the
		// survey under the lock exhausted every sibling window's one-second
		// acquisition budget (item 104). What `confirm` can catch is another
		// window stamping the folder alive — a folder restored on disk and not
		// yet opened by anybody leaves no signal either way.
		// The scan's own failure degrades to "prune nothing", never to "repair
		// nothing": a stat that threw must not cost the window its port fix.
		// Queued behind any repair still running, for the reason on `_repairs`.
		const queued = this._repairs.catch(() => { });
		this._repairs = Promise.race([queued, settleAfter(repairQueueWaitMs)]).then(() => repairConfigs(
			server,
			{
				// Slow half, run outside every lock.
				scan: () => missingWorkspaceTokens(this.context.globalState, token)
					.catch(() => emptyScan()),
				// Fast half, run under the lock immediately before the write.
				confirm: surveyed => stillMissing(this.context.globalState, surveyed),
			},
			// The folder this run's token was minted for, resolved before the
			// first await and handed on rather than re-derived.
			folder,
			// Asked under the lock, with the bytes ready and before the write.
			// The guard below runs only after `repairConfigs` resolves, which
			// cannot stop an older run that took the lock late from writing a
			// port the newer run had already replaced.
			() => !this._disposed && generation === this._generation)
			.then(async report => {
				if (this._disposed || generation !== this._generation) {
					// A newer `_apply`, or a teardown, happened while this ran.
					// Its repair is the one that should be believed, and the
					// completion markers belong to whichever scan actually decided them.
					return;
				}
				// Only after a complete run: a repair that lost a lock, or could
				// not read a config that exists, may not have reached the entry
				// this token identifies, and laying the marker first would take
				// it out of the scan while the entry is still there.
				if (report.complete) {
					for (const folder of report.pruned) {
						await markWorkspaceHandled(
							this.context.globalState, folder, report.prunedAt);
					}
				}
				this._reportRepair(report);
			})
			.catch(() => { }));
	}

	/**
	 * One complete sentence per outcome, never clauses joined at run time.
	 *
	 * The status bar shows one message at a time, so a second `confirm` would
	 * simply replace the first — and a sentence assembled from translated
	 * fragments cannot be reordered or repunctuated by a translator, which is
	 * what building it from `'; '` and lowercase clauses amounted to.
	 */
	private _reportRepair(report: RepairReport): void {
		const files = report.files.join(', ');
		const names = report.removed.join(', ');
		// `vscode.l10n` has no plural form, so the two cases are two strings.
		// One of them is the common one — a single project usually goes at a
		// time — and "Removed 1 Codex entries" is the sort of thing that reads
		// as a placeholder nobody finished.
		const one = report.removed.length === 1;

		if (report.files.length && report.removed.length) {
			confirm(one
				? vscode.l10n.t(
					"Updated the MCP port in {0} and removed the Codex entry of a project that no longer exists ({1}).",
					files, names)
				: vscode.l10n.t(
					"Updated the MCP port in {0} and removed {1} Codex entries for projects that no longer exist ({2}).",
					files, String(report.removed.length), names));
		} else if (report.files.length) {
			confirm(vscode.l10n.t("Updated the MCP port in {0}.", files));
		} else if (report.removed.length) {
			confirm(one
				? vscode.l10n.t(
					"Removed the Codex entry of a project that no longer exists ({0}).", names)
				: vscode.l10n.t(
					"Removed {0} Codex entries for projects that no longer exist ({1}).",
					String(report.removed.length), names));
		}
	}

	/**
	 * Which ports to try, in order.
	 *
	 * The first one is derived from the folder URI so that a window lands on the
	 * same port after every restart — the whole reason configs used to go stale.
	 * An **explicitly configured** `aiBrowser.mcp.port` is exempt: someone who
	 * names a port means that port, and hashing them somewhere else would be a
	 * surprise, so their walk starts where they said.
	 */
	private _portOrder(
		configuration: vscode.WorkspaceConfiguration,
		folder: vscode.WorkspaceFolder | undefined,
	): number[] {
		const base = configuration.get<number>('mcp.port', 43110);
		const setting = configuration.inspect<number>('mcp.port');
		const explicit = setting?.globalValue !== undefined
			|| setting?.workspaceValue !== undefined
			|| setting?.workspaceFolderValue !== undefined;

		const offset = explicit || !folder ? 0 : portOffset(folder.uri.toString());
		return portOrder(base, offset);
	}

	/**
	 * Runs `use` with a live server, explaining the situation when there is none.
	 *
	 * Commands are registered unconditionally so that clicking one says why it
	 * cannot work, which beats "command not found".
	 */
	public async withServer(use: (server: McpServer) => Promise<void>): Promise<void> {
		await this._chain.catch(() => { });

		switch (this._state.kind) {
			case 'running':
				await use(this._state.server);
				return;
			case 'disabled':
				vscode.window.showWarningMessage(vscode.l10n.t(
					"The MCP server is off. Enable `aiBrowser.mcp.enabled` to connect an assistant."));
				return;
			case 'failed':
				vscode.window.showErrorMessage(vscode.l10n.t(
					"The MCP server did not start: {0}", this._state.error));
				return;
			case 'starting':
				vscode.window.showInformationMessage(vscode.l10n.t(
					"The MCP server is still starting. Try again in a moment."));
				return;
		}
	}

	public dispose(): void {
		// Before anything is torn down, so work already in flight sees it.
		this._disposed = true;
		clearInterval(this._heartbeat);
		for (const part of this._parts) {
			part.dispose();
		}
		this._parts = [];
		this._onDidChangeState.dispose();
	}
}
