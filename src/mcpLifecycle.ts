/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BrowserController } from './browserController';
import { portOffset, portOrder } from './mcpPort';
import { McpServer } from './mcpServer';
import { registerWithVsCode, repairConfigs, workspaceFolder } from './mcpSetup';
import { confirm } from './notify';
import { generateUuid } from './uuid';

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

	private readonly _onDidChangeState = new vscode.EventEmitter<McpState>();
	public readonly onDidChangeState = this._onDidChangeState.event;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly browser: BrowserController,
		private readonly version: string,
	) { }

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
	private _workspaceToken(): string {
		const folder = workspaceFolder();
		const key = `mcp.token:${folder?.uri.toString() ?? 'no-folder'}`;
		const existing = this.context.globalState.get<string>(key);
		if (existing) {
			return existing;
		}
		const token = `${generateUuid()}${generateUuid()}`.replace(/-/g, '');
		this.context.globalState.update(key, token);
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

		const configuration = vscode.workspace.getConfiguration('aiBrowser');
		if (!configuration.get<boolean>('mcp.enabled', true)) {
			this._setState({ kind: 'disabled' });
			return;
		}

		this._setState({ kind: 'starting' });

		const folder = workspaceFolder();
		const server = new McpServer(this.browser, this._workspaceToken(), folder?.name, this.version);

		try {
			await server.start(this._portOrder(configuration, folder));
		} catch (err) {
			server.dispose();
			this._setState({ kind: 'failed', error: err instanceof Error ? err.message : String(err) });
			return;
		}

		this._parts.push(server);
		const registration = registerWithVsCode(server, this.version);
		if (registration) {
			this._parts.push(registration);
		}

		this._setState({ kind: 'running', server });

		// Repair runs after the port is known and must never be able to hold up
		// activation, so it is not awaited and cannot throw into this path.
		void repairConfigs(server).then(report => {
			if (report.files.length) {
				confirm(vscode.l10n.t(
					"Updated the MCP port in {0}.", report.files.join(', ')));
			}
		}, () => { });
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
		for (const part of this._parts) {
			part.dispose();
		}
		this._parts = [];
		this._onDidChangeState.dispose();
	}
}
