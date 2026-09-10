/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

interface CDPResponse {
	readonly id: number;
	readonly result?: any;
	readonly error?: { code: number; message: string };
}

interface CDPEvent {
	readonly method: string;
	readonly params: any;
	readonly sessionId?: string;
}

/**
 * Request/response correlation on top of `BrowserCDPSession`, which is a raw
 * message channel: `sendMessage` is fire-and-forget and every reply, for every
 * in-flight command, arrives on the single `onDidReceiveMessage` event.
 *
 * The channel is *browser-level*, the same shape as attaching to Chrome's
 * browser websocket — commands for a page only reach it once you have attached
 * to that target and pass its `sessionId`. {@link attachToPage} does that.
 */
export class CDPClient implements vscode.Disposable {

	private _nextId = 1;
	private readonly _pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	private readonly _listeners = new Set<(event: CDPEvent) => void>();
	private readonly _disposables: vscode.Disposable[] = [];
	private _closed = false;

	constructor(private readonly session: vscode.BrowserCDPSession) {
		this._disposables.push(session.onDidReceiveMessage(raw => this._receive(raw)));
		this._disposables.push(session.onDidClose(() => {
			this._closed = true;
			for (const { reject } of this._pending.values()) {
				reject(new Error('CDP session closed'));
			}
			this._pending.clear();
		}));
	}

	private _receive(raw: unknown): void {
		const message = raw as CDPResponse & CDPEvent;
		if (typeof message?.id === 'number') {
			const pending = this._pending.get(message.id);
			if (pending) {
				this._pending.delete(message.id);
				if (message.error) {
					pending.reject(new Error(`${message.error.message} (CDP ${message.error.code})`));
				} else {
					pending.resolve(message.result ?? {});
				}
			}
			return;
		}

		if (typeof message?.method === 'string') {
			for (const listener of [...this._listeners]) {
				listener(message);
			}
		}
	}

	/** Whether the channel has gone. Every {@link send} on a closed client rejects. */
	public get isClosed(): boolean {
		return this._closed;
	}

	public send(method: string, params?: object, sessionId?: string): Promise<any> {
		if (this._closed) {
			return Promise.reject(new Error('CDP session closed'));
		}

		const id = this._nextId++;
		return new Promise<any>((resolve, reject) => {
			this._pending.set(id, { resolve, reject });
			this.session.sendMessage({ id, method, params, sessionId }).then(undefined, err => {
				this._pending.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			});
		});
	}

	/** Subscribes to every event matching `method` until disposed. */
	public on(method: string, handler: (params: any) => void): vscode.Disposable {
		const listener = (event: CDPEvent) => {
			if (event.method === method) {
				handler(event.params);
			}
		};
		this._listeners.add(listener);
		return new vscode.Disposable(() => this._listeners.delete(listener));
	}

	/** Resolves with the first event matching `method`, or rejects on cancellation. */
	public once(method: string, token: vscode.CancellationToken): Promise<any> {
		return new Promise<any>((resolve, reject) => {
			const listener = (event: CDPEvent) => {
				if (event.method === method) {
					this._listeners.delete(listener);
					sub.dispose();
					resolve(event.params);
				}
			};
			const sub = token.onCancellationRequested(() => {
				this._listeners.delete(listener);
				sub.dispose();
				reject(new vscode.CancellationError());
			});
			this._listeners.add(listener);
		});
	}

	/**
	 * Attaches to the tab's page target and returns its session id.
	 *
	 * The session group is already scoped to a single browser tab, so there is
	 * normally exactly one page target; if several show up we take the first,
	 * which is the top-level page rather than an iframe or worker.
	 */
	public async attachToPage(): Promise<string> {
		const { targetInfos } = await this.send('Target.getTargets');
		const page = (targetInfos as any[]).find(t => t.type === 'page');
		if (!page) {
			throw new Error('The browser tab exposes no page target');
		}

		const { sessionId } = await this.send('Target.attachToTarget', {
			targetId: page.targetId,
			flatten: true,
		});
		return sessionId;
	}

	public dispose(): void {
		this._closed = true;
		for (const d of this._disposables) {
			d.dispose();
		}
		this._listeners.clear();
		this.session.close().then(undefined, () => { /* already gone */ });
	}
}
