/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as vscode from 'vscode';
import { LineSplitter, parseLine } from './agentProtocol';

/**
 * A CLI that speaks one JSON object per line over stdin and stdout.
 *
 * The one piece both agents share. What it guarantees, and why each matters:
 *
 * - **No shell.** `spawn` with an argument array; nothing is parsed by a shell.
 * - **`stdin` has an `error` listener.** A write to a process that has just
 *   exited raises `EPIPE` on the stream, and an unhandled stream error is
 *   thrown into the extension host (breaks-silently #24).
 * - **`CLAUDECODE` is removed from the environment.** It is set inside a Claude
 *   Code session, and VS Code started from such a terminal inherits it — the
 *   CLI then refuses to start, taking itself for a nested session.
 * - **The last lines of stderr are kept**, because when a CLI exits early that
 *   is the only place the reason is written.
 * - **`kill` is idempotent and `dispose` kills**, so disposing the session or
 *   backend that owns a process leaves nothing behind.
 */
const killGraceMs = 3000;

export class JsonLineProcess implements vscode.Disposable {
	/** Processes we have told to stop and that have not exited yet. */
	private static readonly _stopping = new Map<JsonLineProcess, Promise<void>>();

	/**
	 * Settles once every process being stopped has exited, or after `limitMs`.
	 * A CLI resumed elsewhere (the terminal hand-over) must not start while the
	 * chat's own process for that session is still writing to it.
	 */
	public static stopped(limitMs = killGraceMs + 1000): Promise<void> {
		const pending = [...JsonLineProcess._stopping.values()];
		if (!pending.length) { return Promise.resolve(); }
		return Promise.race([
			Promise.all(pending).then(() => undefined),
			new Promise<void>(resolve => setTimeout(resolve, limitMs)),
		]);
	}

	private readonly _child: ChildProcessWithoutNullStreams;
	private readonly _lines = new LineSplitter();
	private _stderr = '';
	private _exited = false;
	/** A kill of ours is not a failure, whatever exit code the platform reports for it. */
	private _killed = false;

	private readonly _onMessage = new vscode.EventEmitter<Record<string, unknown>>();
	public readonly onMessage = this._onMessage.event;

	private readonly _onExit = new vscode.EventEmitter<string | undefined>();
	/** Fires once, with the reason when the process did not exit cleanly. */
	public readonly onExit = this._onExit.event;

	/** `extraEnv`: added to the inherited environment, after `CLAUDECODE` is taken out. */
	constructor(binary: string, args: readonly string[], cwd: string, extraEnv: Readonly<Record<string, string>> = {}) {
		const env = { ...process.env, ...extraEnv };
		delete env.CLAUDECODE;
		delete env.CLAUDE_CODE_ENTRYPOINT;

		this._child = spawn(binary, [...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
		this._child.stdout.setEncoding('utf8');
		this._child.stderr.setEncoding('utf8');
		this._child.stdin.on('error', () => { /* EPIPE after an exit; reported through `onExit` */ });

		this._child.stdout.on('data', (chunk: string) => {
			for (const line of this._lines.push(chunk)) {
				const message = parseLine(line);
				if (message) {
					this._onMessage.fire(message);
				}
			}
		});
		this._child.stderr.on('data', (chunk: string) => {
			this._stderr = (this._stderr + chunk).slice(-4000);
		});
		this._child.on('error', err => this._finish(err.message));
		this._child.on('exit', (code, signal) => {
			this._finish(code === 0 || this._killed ? undefined : this._reason(code, signal));
		});
	}

	public get exited(): boolean {
		return this._exited;
	}

	public send(message: unknown): void {
		if (!this._exited) {
			this._child.stdin.write(JSON.stringify(message) + '\n');
		}
	}

	/** Closes stdin: a CLI serving one object per line ends there on its own. */
	public endInput(): void {
		if (!this._exited) {
			this._child.stdin.end();
		}
	}

	/**
	 * SIGTERM, then SIGKILL if the process is still there after a grace period:
	 * a CLI busy in a tool call, or one that traps the signal, would otherwise
	 * outlive the conversation that started it.
	 */
	public kill(): void {
		if (!this._exited) {
			this._killed = true;
			if (!JsonLineProcess._stopping.has(this)) {
				JsonLineProcess._stopping.set(this, new Promise<void>(resolve => this._child.once('exit', () => resolve())));
			}
			this._child.kill();
			const timer = setTimeout(() => {
				if (!this._exited) {
					this._child.kill('SIGKILL');
				}
			}, killGraceMs);
			timer.unref?.();
		}
	}

	public dispose(): void {
		this.kill();
		this._onMessage.dispose();
	}

	private _reason(code: number | null, signal: NodeJS.Signals | null): string {
		const tail = this._stderr.trim().split('\n').slice(-3).join('\n').trim();
		const how = signal ? `was stopped (${signal})` : `exited with code ${code}`;
		return tail ? `The process ${how}: ${tail}` : `The process ${how}.`;
	}

	private _finish(reason: string | undefined): void {
		if (this._exited) {
			return;
		}
		this._exited = true;
		JsonLineProcess._stopping.delete(this);
		this._onExit.fire(reason);
		this._onExit.dispose();
	}
}

/** A promise that rejects after `ms`, for answers a CLI may never send. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)}s.`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}
