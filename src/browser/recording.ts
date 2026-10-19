import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CDPClient } from '../core/cdp';
import { generateUuid } from '../core/uuid';
import { privateTempDirectory } from '../core/safeFiles';
import type { BrowserController } from './browserController';
import { callerKey, type CallerIdentity } from './shareRegistry';

export interface RecordingResult {
	id: string;
	state: 'starting' | 'recording' | 'paused' | 'stopping' | 'completed' | 'failed';
	tabId: string;
	url: string;
	durationSeconds: number;
	frames: number;
	bytes: number;
	mimeType?: string;
	file?: string;
	attachedToChat?: boolean;
	delivery: 'chat' | 'clipboard';
	clipboardCopied?: boolean;
	error?: string;
}

/** A destination captured at start, never whichever chat happens to be active at stop. */
export type RecordingDestination = (result: RecordingResult, file: vscode.Uri) => boolean;

interface Run {
	result: RecordingResult;
	caller?: CallerIdentity;
	tab: vscode.BrowserTab;
	panel: vscode.WebviewPanel;
	channel?: vscode.BrowserCDPSession;
	client?: CDPClient;
	session?: string;
	fd?: number;
	file?: string;
	attach?: RecordingDestination;
	parts: vscode.Disposable[];
	pending: Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>;
	next: number;
	activeSince?: number;
	elapsed: number;
	busyFrame: boolean;
	stop?: Promise<RecordingResult>;
}

function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out.`)), 15_000);
		promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
	});
}

/** One recording per window. CDP supplies pixels; a retained webview encodes them locally. */
export class BrowserRecording implements vscode.Disposable {
	private _active?: Run;
	private readonly _results = new Map<string, { owner: string; result: RecordingResult }>();
	private _disposed = false;
	private _controls: Promise<unknown> = Promise.resolve();
	private readonly _panels = new Set<vscode.WebviewPanel>();
	public destination: ((chatId?: string) => RecordingDestination | undefined) | undefined;

	constructor(private readonly _context: vscode.ExtensionContext, private readonly _browser: BrowserController) { this._publish(); }

	public async start(caller?: CallerIdentity, delivery: 'chat' | 'clipboard' = 'clipboard', signal?: AbortSignal): Promise<RecordingResult> {
		if (signal?.aborted) { throw new Error('Recording startup was cancelled.'); }
		if (this._disposed) { throw new Error('Recording is unavailable.'); }
		if (this._active) { throw new Error('A recording is already in progress. Stop it first.'); }
		const tab = this._browser.recordingTab(caller);
		const attach = delivery === 'chat' ? this.destination?.(caller?.chatId) : undefined;
		if (delivery === 'chat' && !attach) { throw new Error('Open an AI Browser Chat before recording to the chat.'); }
		const panel = vscode.window.createWebviewPanel('aiBrowser.recording', vscode.l10n.t('Browser recording'),
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
			{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'media')] });
		this._panels.add(panel);
		// Keep only one finished preview; the saved file and chat attachment outlive it.
		for (const previous of this._panels) { if (previous !== panel) { previous.dispose(); } }
		const result: RecordingResult = { id: generateUuid(), state: 'starting', delivery, tabId: this._browser.tabIdOf(tab), url: tab.url, durationSeconds: 0, frames: 0, bytes: 0 };
		const run: Run = { result, caller: caller ? { ...caller } : undefined, tab, panel, parts: [], pending: new Map(), next: 0, elapsed: 0, busyFrame: false, attach };
		this._active = run;
		let rejectStartup!: (error: Error) => void;
		const cancelled = new Promise<never>((_, reject) => { rejectStartup = reject; });
		void cancelled.catch(() => undefined);
		const starting = <T>(promise: Promise<T>) => Promise.race([promise, cancelled]);
		const onAbort = () => {
			if (this._active !== run || result.state !== 'starting') { return; }
			const error = new Error('Recording startup was cancelled.');
			rejectStartup(error);
			this._fail(run, error, false);
			panel.dispose();
		};
		signal?.addEventListener('abort', onAbort, { once: true });
		this._publish();
		this._results.set(result.id, { owner: caller ? callerKey(caller) : 'user', result });
		// Results are metadata only. Completed files remain available for Save As and attachments.
		if (this._results.size > 20) { this._results.delete(this._results.keys().next().value!); }
		let ready!: () => void;
		const loaded = new Promise<void>(resolve => { ready = resolve; });
		const panelMessages = panel.webview.onDidReceiveMessage(message => {
			try {
				if (message?.type === 'ready') { ready(); }
				else if (message?.type === 'reply' && typeof message.seq === 'number') {
					const pending = run.pending.get(message.seq);
					run.pending.delete(message.seq);
					if (message.error) { pending?.reject(new Error(String(message.error))); }
					else { pending?.resolve(message); }
				} else if (message?.type === 'chunk') {
					if (run.fd === undefined || typeof message.data !== 'string' || message.data.length > 24 * 1024 * 1024) { throw new Error('Invalid video chunk.'); }
					const data = Buffer.from(message.data, 'base64');
					if (run.result.bytes + data.length > 256 * 1024 * 1024) { throw new Error('Recording exceeded the 256 MB limit.'); }
					fs.writeFileSync(run.fd, data);
					run.result.bytes += data.length;
					void panel.webview.postMessage({ type: 'chunkAck', seq: message.seq });
				} else if (message?.type === 'error') { throw new Error(String(message.error)); }
				else if (message?.type === 'save') { void this.save(result.id).catch(error => vscode.window.showErrorMessage(String(error))); }
			} catch (error) { this._fail(run, error); }
		});
		panel.onDidDispose(() => {
			panelMessages.dispose(); this._panels.delete(panel);
			if (this._active === run && result.state !== 'completed') { this._fail(run, new Error('The recording encoder was closed before the video finished.')); }
		});
		const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'recording.js'));
		const nonce = generateUuid();
		panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; img-src data:; media-src blob:; style-src 'nonce-${nonce}'"><style nonce="${nonce}">body{font:13px sans-serif;color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px}canvas,video{max-width:100%;height:auto}button{padding:6px 12px}canvas{display:block}</style></head><body><p id="status">Starting browser recording…</p><canvas width="1280" height="720"></canvas><video controls hidden></video><button id="save" hidden>Save video as…</button><script nonce="${nonce}" src="${script}"></script></body></html>`;
		try {
			await bounded(starting(loaded), 'Loading the video encoder');
			this._assertActive(run);
			const init = await starting(this._request(run, 'init'));
			result.mimeType = init.mime;
			const dir = await starting(privateTempDirectory('recordings'));
			this._assertActive(run);
			run.file = path.join(dir, `${result.id}.${init.mime.startsWith('video/mp4') ? 'mp4' : 'webm'}`);
			run.fd = fs.openSync(run.file, 'wx', 0o600);
			const channel = await starting(bounded(Promise.resolve(tab.startCDPSession()).then(channel => {
				if (this._active !== run) { void channel.close(); throw new Error('Recording was cancelled.'); }
				run.channel = channel;
				return channel;
			}), 'Opening the browser session'));
			this._assertActive(run);
			run.client = new CDPClient(channel);
			run.parts.push(channel.onDidClose(() => {
				if (this._active === run && result.state !== 'stopping') { void this.stop().catch(error => this._fail(run, error)); }
			}));
			run.session = await starting(bounded(run.client.attachToPage(), 'Attaching to the browser page'));
			await starting(this._send(run, 'Page.enable'));
			if (!this._browser.canRecordTab(tab, caller)) { throw new Error('The browser tab assignment changed while recording was starting.'); }
			let first!: () => void;
			const firstFrame = new Promise<void>(resolve => { first = resolve; });
			run.parts.push(run.client.on('Page.screencastFrame', (params, session) => {
				if (session !== run.session) { return; }
				void this._frame(run, params).then(accepted => { if (accepted) { first(); } }, error => this._fail(run, error));
			}));
			run.parts.push(vscode.window.onDidCloseBrowserTab(closed => {
				if (closed === tab) { void this.stop().catch(error => this._fail(run, error)); }
			}));
			if (caller) { run.parts.push(this._browser.onDidChangeShare(() => {
				try { if (!this._browser.canRecordTab(tab, caller)) { void this.stop().catch(error => this._fail(run, error)); } }
				catch { void this.stop().catch(error => this._fail(run, error)); }
			})); }
			await starting(this._screencast(run));
			await bounded(starting(firstFrame), 'Receiving the first video frame');
			this._assertActive(run);
			result.state = 'recording';
			run.activeSince = Date.now();
			this._publish();
			const timer = setInterval(() => {
				if (this._seconds(run) >= 600) { void this.stop().catch(error => this._fail(run, error)); }
			}, 1000);
			run.parts.push(new vscode.Disposable(() => clearInterval(timer)));
			return this._snapshot(run);
		} catch (error) {
			this._fail(run, error);
			throw error;
		} finally {
			// The recording outlives a successfully completed start call.
			signal?.removeEventListener('abort', onAbort);
		}
	}

	public status(id: string, caller: CallerIdentity): RecordingResult {
		const entry = this._results.get(id);
		if (!entry || entry.owner !== callerKey(caller)) { throw new Error('Recording not found for this MCP session.'); }
		return this._active?.result.id === id ? this._snapshot(this._active) : { ...entry.result };
	}

	public control(action: 'pause' | 'resume' | 'stop', id?: string, caller?: CallerIdentity): Promise<RecordingResult> {
		const task = this._controls.then(async () => {
			if (caller && !id) { throw new Error('A recording id is required.'); }
			if (caller && id) { this.status(id, caller); }
			const run = this._active;
			if (!run || (id && run.result.id !== id)) {
				if (action === 'stop' && id && caller) { return this.status(id, caller); }
				throw new Error('No matching recording is running.');
			}
			if (action === 'stop') { return this.stop(); }
			if (run.result.state !== 'recording' && run.result.state !== 'paused') { throw new Error('Recording is still starting or finishing.'); }
			try {
				if (action === 'pause' && run.result.state === 'recording') {
					this._clockPause(run);
					run.result.state = 'paused';
					await this._send(run, 'Page.stopScreencast');
					await this._request(run, 'pause');
				} else if (action === 'resume' && run.result.state === 'paused') {
					if (!this._browser.canRecordTab(run.tab, run.caller)) { throw new Error('The recorded tab is no longer available to this assistant.'); }
					await this._request(run, 'resume');
					run.result.state = 'recording';
					run.activeSince = Date.now();
					await this._screencast(run);
				}
				this._assertActive(run);
				this._publish();
				return this._snapshot(run);
			} catch (error) { this._fail(run, error); throw error; }
		});
		this._controls = task.catch(() => undefined);
		return task;
	}

	public stop(): Promise<RecordingResult> {
		const run = this._active;
		if (!run) { return Promise.reject(new Error('No recording is running.')); }
		if (run.stop) { return run.stop; }
		if (run.result.state === 'starting') { return Promise.reject(new Error('Recording is still starting.')); }
		run.stop = this._finish(run);
		return run.stop;
	}

	private async _finish(run: Run): Promise<RecordingResult> {
		this._clockPause(run);
		run.result.state = 'stopping';
		this._publish();
		try {
			if (!this._sourceGone(run)) {
				try { await this._send(run, 'Page.stopScreencast'); }
				catch (error) { if (!this._sourceGone(run)) { throw error; } }
			}
			const encoded = await this._request(run, 'stop');
			this._assertActive(run);
			if (!run.result.bytes || !run.file) { throw new Error('The recording contains no video data.'); }
			if (run.fd !== undefined) { fs.closeSync(run.fd); run.fd = undefined; }
			run.result.file = run.file;
			run.result.state = 'completed';
			run.result.durationSeconds = typeof encoded.duration === 'number' && encoded.duration > 0 ? encoded.duration : this._seconds(run);
			try { run.result.attachedToChat = run.attach?.({ ...run.result }, vscode.Uri.file(run.file)) ?? false; }
			catch { run.result.attachedToChat = false; }
			if (!run.result.attachedToChat) {
				try { await vscode.env.clipboard.writeText(run.file); run.result.clipboardCopied = true; }
				catch { run.result.clipboardCopied = false; }
			}
			this._release(run);
			const delivery = run.result.attachedToChat ? vscode.l10n.t('Attached to the chat draft.')
				: run.result.clipboardCopied ? vscode.l10n.t('File path copied to clipboard.') : vscode.l10n.t('Could not copy the file path.');
			void vscode.window.showInformationMessage(vscode.l10n.t('Video recorded: {0} · {1}s · {2} MB. {3}',
				path.basename(run.file), run.result.durationSeconds.toFixed(1), (run.result.bytes / 1024 / 1024).toFixed(1), delivery),
				vscode.l10n.t('Open video'), vscode.l10n.t('Save as…')).then(action => {
					if (action === vscode.l10n.t('Save as…')) { return this.save(run.result.id); }
					if (action === vscode.l10n.t('Open video')) { return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(run.file!)); }
					return undefined;
				}).then(undefined, error => { void vscode.window.showErrorMessage(String(error)); });
			return { ...run.result };
		} catch (error) { this._fail(run, error); throw error; }
	}

	public async save(id: string): Promise<void> {
		const result = this._results.get(id)?.result;
		if (result?.state !== 'completed' || !result.file) { throw new Error('No completed video is available.'); }
		const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(result.file), filters: { Video: [path.extname(result.file).slice(1)] } });
		if (uri && uri.toString() !== vscode.Uri.file(result.file).toString()) {
			await vscode.workspace.fs.copy(vscode.Uri.file(result.file), uri, { overwrite: true });
		}
	}

	private async _frame(run: Run, params: any): Promise<boolean> {
		const ack = () => this._ackFrame(run, params.sessionId);
		if (this._active !== run || !['starting', 'recording'].includes(run.result.state) || run.busyFrame) {
			await ack(); return false;
		}
		run.busyFrame = true;
		try {
			const reply = await this._request(run, 'frame', { data: params.data });
			if (typeof reply.mime === 'string') { run.result.mimeType = reply.mime; }
			run.result.frames++;
			await ack();
			return true;
		} finally { run.busyFrame = false; }
	}

	private _sourceGone(run: Run): boolean {
		return !!run.client?.isClosed || !(vscode.window.browserTabs ?? []).includes(run.tab);
	}
	private async _ackFrame(run: Run, sessionId: number): Promise<void> {
		const noLongerCapturing = () => this._active !== run || !['starting', 'recording'].includes(run.result.state) || this._sourceGone(run);
		if (noLongerCapturing()) { return; }
		try { await this._send(run, 'Page.screencastFrameAck', { sessionId }); }
		catch (error) {
			// Closing the source or stopping capture may race the previous frame's reply.
			// Its acknowledgement is no longer needed; already encoded video can finish.
			if (!noLongerCapturing()) { throw error; }
		}
	}

	private _screencast(run: Run): Promise<any> {
		return this._send(run, 'Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });
	}
	private _send(run: Run, method: string, params?: object): Promise<any> {
		return bounded(run.client!.send(method, params, run.session), method);
	}
	private async _request(run: Run, type: string, params: object = {}): Promise<any> {
		const seq = ++run.next;
		const response = new Promise<any>((resolve, reject) => run.pending.set(seq, { resolve, reject }));
		// Disposal can reject before postMessage has yielded its delivery result.
		void response.catch(() => undefined);
		try {
			if (!await run.panel.webview.postMessage({ type, seq, ...params })) { throw new Error('The video encoder is unavailable.'); }
			return await bounded(response, `Video encoder: ${type}`);
		} finally { run.pending.delete(seq); }
	}
	private _assertActive(run: Run): void {
		if (this._active !== run) { throw new Error(run.result.error ?? 'Recording has ended.'); }
	}
	private _seconds(run: Run): number { return (run.elapsed + (run.activeSince === undefined ? 0 : Date.now() - run.activeSince)) / 1000; }
	private _clockPause(run: Run): void {
		if (run.activeSince !== undefined) { run.elapsed += Date.now() - run.activeSince; run.activeSince = undefined; }
	}
	private _snapshot(run: Run): RecordingResult { return { ...run.result, durationSeconds: this._seconds(run) }; }
	private _publish(): void {
		const run = this._active;
		void vscode.commands.executeCommand('setContext', 'aiBrowser.recordingState', run?.result.state ?? 'idle');
		void vscode.commands.executeCommand('setContext', 'aiBrowser.recordingActive', !!run);
	}
	private _fail(run: Run, error: unknown, notify = true): void {
		if (this._active !== run) { return; }
		this._clockPause(run);
		run.result.state = 'failed';
		run.result.error = error instanceof Error ? error.message : String(error);
		run.result.durationSeconds = this._seconds(run);
		try { void run.panel.webview.postMessage({ type: 'abort', error: run.result.error }); }
		catch { /* The close event arrives after the webview has already been disposed. */ }
		this._release(run);
		if (run.file) { try { fs.unlinkSync(run.file); } catch { /* no partial file to publish */ } }
		if (notify) { void vscode.window.showErrorMessage(vscode.l10n.t('Browser recording failed: {0}', run.result.error)); }
	}
	private _release(run: Run): void {
		if (run.fd !== undefined) { try { fs.closeSync(run.fd); } catch { /* already closed */ } run.fd = undefined; }
		for (const pending of run.pending.values()) { pending.reject(new Error('Recording has ended.')); }
		run.pending.clear();
		for (const part of run.parts) { part.dispose(); }
		if (run.client) { run.client.dispose(); }
		else if (run.channel) { void run.channel.close(); }
		if (this._active === run) { this._active = undefined; }
		this._publish();
	}
	public dispose(): void {
		this._disposed = true;
		if (this._active) { const run = this._active; this._fail(run, new Error('The extension stopped.')); run.panel.dispose(); }
		for (const panel of this._panels) { panel.dispose(); }
	}
}
