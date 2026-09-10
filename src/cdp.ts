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
	/**
	 * How to abandon each outstanding {@link once} waiter.
	 *
	 * Kept apart from `_listeners`, which only knows how to *deliver* an event.
	 * Dropping a listener does not settle the promise built around it, so
	 * without this a waiter survives the client that owns it.
	 */
	private readonly _waiters = new Set<(error: Error) => void>();
	private readonly _disposables: vscode.Disposable[] = [];
	private _closed = false;

	constructor(private readonly session: vscode.BrowserCDPSession) {
		this._disposables.push(session.onDidReceiveMessage(raw => this._receive(raw)));
		this._disposables.push(session.onDidClose(() => this._failPending('CDP session closed')));
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
		if (this._closed) {
			return Promise.reject(new Error('CDP session closed'));
		}

		return new Promise<any>((resolve, reject) => {
			const done = () => {
				this._listeners.delete(listener);
				this._waiters.delete(fail);
				sub.dispose();
			};
			const listener = (event: CDPEvent) => {
				if (event.method === method) {
					done();
					resolve(event.params);
				}
			};
			// Registered so that closing or disposing the client abandons this
			// wait. Without it the promise outlives its client: `_listeners` is
			// cleared, the event can never arrive, and the caller waits for
			// ever — or, where there is a timeout, waits out the whole of it
			// for an answer that cannot come.
			const fail = (error: Error) => {
				done();
				reject(error);
			};
			const sub = token.onCancellationRequested(() => {
				done();
				reject(new vscode.CancellationError());
			});
			this._listeners.add(listener);
			this._waiters.add(fail);
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

	/**
	 * Settles everything still in flight, so nothing can wait forever.
	 *
	 * Shared by session close and {@link dispose}, and the second caller is the
	 * one that was missing: disposing tore down the `onDidClose` subscription
	 * *before* it could fire, so a command still awaiting a reply was left
	 * pending for good. A long `browser_wait_for` interrupted by another tool
	 * call switching tabs — which disposes this client — hung until the
	 * assistant gave up, with no error anywhere.
	 *
	 * It covers both kinds of outstanding work: replies to commands
	 * (`_pending`) and waits for an event (`_waiters`). Clearing `_listeners`
	 * alone silences a waiter without ever settling it, which is the same bug
	 * wearing a different hat.
	 */
	private _failPending(reason: string): void {
		this._closed = true;

		// Copied out first: rejecting runs continuations that may call back in.
		const pending = [...this._pending.values()];
		const waiters = [...this._waiters];
		this._pending.clear();
		this._waiters.clear();

		for (const { reject } of pending) {
			reject(new Error(reason));
		}
		for (const fail of waiters) {
			fail(new Error(reason));
		}
	}

	public dispose(): void {
		this._failPending('CDP client disposed');
		for (const d of this._disposables) {
			d.dispose();
		}
		this._listeners.clear();
		this.session.close().then(undefined, () => { /* already gone */ });
	}
}
