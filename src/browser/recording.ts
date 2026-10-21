import { trackTemporaryFile, temporaryProject } from '../core/temporaryFiles';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CDPClient } from '../core/cdp';
import { generateUuid } from '../core/uuid';
import { confirm } from '../core/notify';
import { projectTempDirectory } from '../core/safeFiles';
import type { BrowserController } from './browserController';
import { tabs as tabSource } from './tabSource';
import { callerKey, type CallerIdentity } from './shareRegistry';
import { formatRecordingSeconds, minRecordingBytes, readRecordingQuality, readRecordingSeconds, recordingByteLimit, recordingProfiles, recordingQualityKey, recordingSecondsKey, type RecordingQuality } from './recordingQuality';

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
	/** Set when the recording was stopped by one of its limits rather than by a stop. */
	limitReached?: 'duration' | 'size';
	/** The time limit this recording was started with, in active seconds. */
	maxSeconds?: number;
	error?: string;
}

/**
 * The time limit (active, unpaused seconds) is set in Chat Settings
 * (`recordingSecondsKey`, 10 s to 1 h, 5 min by default) and the size limit
 * follows from it and the preset (`recordingByteLimit`); both are taken at
 * start, as the quality is. Reaching either stops the recording and keeps it.
 */
/**
 * The last seconds of the time limit, in which the user is warned: the Stop
 * button on the browser tab blinks red (`aiBrowser.recordingEnding`, swapped
 * every second between two Stop commands, since a toolbar icon is static) and
 * the status bar counts down. Never a toast: it would pause the page being
 * recorded (breaks-silently #10).
 */
export const recordingWarningSeconds = 30;
/** The size limit a recording gets at the least, kept for callers and tests. */
export const maxRecordingBytes = minRecordingBytes;
/**
 * How far below the size limit a stop is asked for, at least: the
 * encoder still flushes up to a second of video after the stop, and that has to
 * fit, or the end of the recording is what gets dropped.
 */
const sizeStopMargin = 16 * 1024 * 1024;

/**
 * Errors a recording has already reported to the user itself — a failure
 * notification, or a start cancelled quietly because its tab went away — so a
 * command wrapper must not report them a second time.
 */
const reportedErrors = new WeakSet<object>();
export function recordingErrorReported(error: unknown): boolean {
	return typeof error === 'object' && error !== null && reportedErrors.has(error);
}
function markReported(error: unknown): void {
	if (typeof error === 'object' && error !== null) { reportedErrors.add(error); }
}

/** A destination captured at start, never whichever chat happens to be active at stop. */
export type RecordingDestination = (result: RecordingResult, file: vscode.Uri) => boolean;

export interface RecordingEncoder {
	readonly webview: Pick<vscode.Webview, 'postMessage' | 'onDidReceiveMessage'>;
	readonly onDidDispose: vscode.Event<void>;
	dispose(): void;
}

interface Run {
	result: RecordingResult;
	caller?: CallerIdentity;
	tab: vscode.BrowserTab;
	panel: RecordingEncoder;
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
	/** The largest chunk written, which sizes the margin before the size limit. */
	largestChunk: number;
	/** The limits taken at start: active seconds, and the bytes that go with them. */
	maxSeconds: number;
	maxBytes: number;
	/** In the last {@link recordingWarningSeconds}: which of the two Stop icons is up, and the countdown line. */
	blink?: boolean;
	countdown?: vscode.Disposable;
	/**
	 * Set once a chunk would have taken the file past the size limit. Every
	 * chunk from then on is acknowledged and dropped: appending a later chunk
	 * after a missing one would corrupt the container, while a file that simply
	 * ends early still plays.
	 */
	cutAtSeconds?: number;
	profile: { width: number; height: number; bitrate: number };
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
	private readonly _changed = new vscode.EventEmitter<RecordingResult | undefined>();
	public readonly onDidChange = this._changed.event;
	public get current(): RecordingResult | undefined { return this._active ? this._snapshot(this._active) : undefined; }
	public createEncoder: ((id: string) => RecordingEncoder) | undefined;
	public destination: ((chatId?: string) => RecordingDestination | undefined) | undefined;
	public project: ((chatId: string) => string | undefined) | undefined;

	constructor(private readonly _context: vscode.ExtensionContext, private readonly _browser: BrowserController) { this._publish(); }

	public async start(caller?: CallerIdentity, delivery: 'chat' | 'clipboard' = 'clipboard', signal?: AbortSignal, quality?: RecordingQuality): Promise<RecordingResult> {
		if (signal?.aborted) { throw new Error('Recording startup was cancelled.'); }
		if (this._disposed) { throw new Error('Recording is unavailable.'); }
		if (this._active) { throw new Error('A recording is already in progress. Stop it first.'); }
		const tab = this._browser.recordingTab(caller);
		const attach = delivery === 'chat' ? this.destination?.(caller?.chatId) : undefined;
		if (delivery === 'chat' && !attach) { throw new Error('Open an AI Browser Chat before recording to the chat.'); }
		const result: RecordingResult = { id: generateUuid(), state: 'starting', delivery, tabId: this._browser.tabIdOf(tab), url: tab.url, durationSeconds: 0, frames: 0, bytes: 0 };
		if (!this.createEncoder) { throw new Error('The background video encoder is unavailable.'); }
		const panel = this.createEncoder(result.id);
		const project = caller?.chatId ? this.project?.(caller.chatId) : temporaryProject();
		const profile = recordingProfiles[readRecordingQuality(quality ?? this._context.globalState?.get(recordingQualityKey))];
		const maxSeconds = readRecordingSeconds(this._context.globalState?.get(recordingSecondsKey));
		const maxBytes = recordingByteLimit(maxSeconds, profile.bitrate);
		result.maxSeconds = maxSeconds;
		const run: Run = { result, caller: caller ? { ...caller } : undefined, tab, panel, profile, parts: [], pending: new Map(), next: 0, elapsed: 0, busyFrame: false, largestChunk: 0, attach, maxSeconds, maxBytes };
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
					if (run.cutAtSeconds === undefined && run.result.bytes + data.length > run.maxBytes) {
						// The size limit ends the recording the way the time limit does: what
						// is written is kept. This chunk and every later one are dropped.
						run.cutAtSeconds = this._seconds(run);
					}
					if (run.cutAtSeconds === undefined) {
						fs.writeFileSync(run.fd, data);
						run.result.bytes += data.length;
						run.largestChunk = Math.max(run.largestChunk, data.length);
					}
					// Acknowledged even when dropped: the encoder waits for each
					// acknowledgement and fails the recording when one never comes.
					void panel.webview.postMessage({ type: 'chunkAck', seq: message.seq });
					if (run.cutAtSeconds !== undefined || run.result.bytes >= run.maxBytes - Math.max(sizeStopMargin, 4 * run.largestChunk)) {
						this._limit(run, 'size');
					}
				} else if (message?.type === 'error') { throw new Error(String(message.error)); }
				else if (message?.type === 'save') { void this.save(result.id).catch(error => vscode.window.showErrorMessage(String(error))); }
			} catch (error) { this._fail(run, error); }
		});
		panel.onDidDispose(() => {
			panelMessages.dispose();
			if (this._active === run && result.state !== 'completed') { this._fail(run, new Error('The background recording service stopped before the video finished.')); }
		});

		try {
			await bounded(starting(loaded), 'Loading the video encoder');
			this._assertActive(run);
			const init = await starting(this._request(run, 'init', { bitrate: profile.bitrate }));
			result.mimeType = init.mime;
			const dir = await starting(projectTempDirectory(project, 'captures'));
			this._assertActive(run);
			run.file = path.join(dir, `${result.id}.${init.mime.startsWith('video/mp4') ? 'mp4' : 'webm'}`);
			run.fd = fs.openSync(run.file, 'wx', 0o600);
			await trackTemporaryFile(run.file, project);
			this._assertActive(run);
			const channel = await starting(bounded(Promise.resolve(tab.startCDPSession()).then(channel => {
				if (this._active !== run) { void channel.close(); throw new Error('Recording was cancelled.'); }
				run.channel = channel;
				return channel;
			}), 'Opening the browser session'));
			this._assertActive(run);
			run.client = new CDPClient(channel);
			// The page going away while the recording is still starting is a
			// cancel, not a failure: there is no video yet, and an error toast
			// saying "Recording is still starting." would describe nothing the
			// user did wrong. Once recording, the same events stop and keep it.
			const sourceLost = (why: string) => {
				if (this._active !== run || result.state === 'stopping') { return; }
				if (result.state === 'starting') {
					const error = new Error(why);
					markReported(error);
					rejectStartup(error);
					this._fail(run, error, false);
					return;
				}
				void this.stop().catch(error => this._fail(run, error));
			};
			run.parts.push(channel.onDidClose(() => sourceLost('The browser session closed while the recording was starting.')));
			run.session = await starting(bounded(run.client.attachToPage(), 'Attaching to the browser page'));
			await starting(this._send(run, 'Page.enable'));
			if (!this._browser.canRecordTab(tab, caller)) { throw new Error('The browser tab assignment changed while recording was starting.'); }
			let first!: () => void;
			const firstFrame = new Promise<void>(resolve => { first = resolve; });
			run.parts.push(run.client.on('Page.screencastFrame', (params, session) => {
				if (session !== run.session) { return; }
				void this._frame(run, params).then(accepted => { if (accepted) { first(); } }, error => this._fail(run, error));
			}));
			run.parts.push(tabSource.onDidClose(closed => {
				if (closed === tab) { sourceLost('The browser tab was closed while the recording was starting.'); }
			}));
			if (caller) { run.parts.push(this._browser.onDidChangeShare(() => {
				let allowed = false;
				try { allowed = this._browser.canRecordTab(tab, caller); } catch { /* read as revoked */ }
				if (!allowed) { sourceLost('The browser tab assignment changed while the recording was starting.'); }
			})); }
			await starting(this._screencast(run));
			await bounded(starting(firstFrame), 'Receiving the first video frame');
			this._assertActive(run);
			result.state = 'recording';
			run.activeSince = Date.now();
			this._publish();
			const timer = setInterval(() => {
				this._changed.fire(this.current);
				if (this._seconds(run) >= run.maxSeconds) { this._limit(run, 'duration'); }
				else { this._warn(run); }
			}, 1000);
			run.parts.push(new vscode.Disposable(() => clearInterval(timer)));
			return this._snapshot(run);
		} catch (error) {
			// A run that has already ended reported itself — a failure toast, or a
			// quiet cancel — so whatever this await threw is not news to the user.
			// A tab closed before the listeners above were in place surfaces here as
			// whatever step it broke; that is the same quiet cancel.
			if (this._active === run) { this._fail(run, error, !this._tabGone(tab)); }
			markReported(error);
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
			// The encoder's own duration covers chunks the size limit dropped; the
			// file ends about where the first dropped chunk began.
			if (run.cutAtSeconds !== undefined) {
				run.result.durationSeconds = Math.min(run.result.durationSeconds, run.cutAtSeconds);
				run.result.limitReached ??= 'size';
			}
			try { run.result.attachedToChat = run.attach?.({ ...run.result }, vscode.Uri.file(run.file)) ?? false; }
			catch { run.result.attachedToChat = false; }
			if (!run.result.attachedToChat) {
				try { await vscode.env.clipboard.writeText(run.file); run.result.clipboardCopied = true; }
				catch { run.result.clipboardCopied = false; }
			}
			this._release(run);
			const limit = run.result.limitReached === 'size' ? vscode.l10n.t(' Stopped at the {0} MB limit; the video so far is kept.', Math.round(run.maxBytes / 1024 / 1024))
				: run.result.limitReached === 'duration' ? vscode.l10n.t(' Stopped at the {0} limit; the video so far is kept.', formatRecordingSeconds(run.maxSeconds)) : '';
			const summary = vscode.l10n.t('Video recorded: {0} · {1}s · {2} MB.',
				path.basename(run.file), run.result.durationSeconds.toFixed(1), (run.result.bytes / 1024 / 1024).toFixed(1)) + limit;
			if (run.result.attachedToChat || run.result.clipboardCopied) {
				// A confirmation, so the status bar: a toast here lands on the very page
				// that was just recorded and pauses it (breaks-silently #10). The video
				// is reachable from what was delivered — the chat chip opens it, and
				// the path is on the clipboard.
				confirm(summary + ' ' + (run.result.attachedToChat ? vscode.l10n.t('Attached to the chat draft.') : vscode.l10n.t('File path copied to clipboard.')));
			} else {
				// The one fallback: nothing could deliver the video, so these buttons
				// are the only way to it. A notification for what did not happen is
				// what the rule allows.
				const file = run.file;
				void vscode.window.showWarningMessage(summary + ' ' + vscode.l10n.t('Could not copy the file path.'),
					vscode.l10n.t('Open video'), vscode.l10n.t('Save as…')).then(action => {
						if (action === vscode.l10n.t('Save as…')) { return this.save(run.result.id); }
						if (action === vscode.l10n.t('Open video')) { return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file)); }
						return undefined;
					}).then(undefined, error => { void vscode.window.showErrorMessage(String(error)); });
			}
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
			const reply = await this._request(run, 'frame', { data: params.data, mimeType: 'image/png' });
			if (typeof reply.mime === 'string') { run.result.mimeType = reply.mime; }
			run.result.frames++;
			await ack();
			return true;
		} finally { run.busyFrame = false; }
	}

	/**
	 * Stops a recording that reached one of its limits and keeps the video, the
	 * same way for both: a limit is the end of the recording, not a failure.
	 * Idempotent — chunks keep arriving while the stop runs.
	 */
	private _limit(run: Run, reason: 'duration' | 'size'): void {
		if (this._active !== run || run.stop || (run.result.state !== 'recording' && run.result.state !== 'paused')) { return; }
		run.result.limitReached = reason;
		void this.stop().catch(error => this._fail(run, error));
	}

	private _tabGone(tab: vscode.BrowserTab): boolean {
		try { return !tabSource.all.includes(tab); } catch { return false; }
	}

	private _sourceGone(run: Run): boolean {
		return !!run.client?.isClosed || !tabSource.all.includes(run.tab);
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
		return this._send(run, 'Page.startScreencast', { format: 'png', maxWidth: run.profile.width, maxHeight: run.profile.height, everyNthFrame: 1 });
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
		this._changed.fire(this.current);
	}
	private _fail(run: Run, error: unknown, notify = true): void {
		// Marked before the early return: a run that already failed has reported
		// its failure, and an error that follows from it (`_finish` meeting a
		// disposed encoder) must not be reported a second time by the command.
		markReported(error);
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
	/**
	 * The countdown of a recording's last seconds, run on the second's tick.
	 * Paused, the clock stands still and so does the warning: the Stop button is
	 * shown plain and the countdown line goes, until the recording resumes.
	 */
	private _warn(run: Run): void {
		const left = Math.ceil(run.maxSeconds - this._seconds(run));
		if (this._active !== run || run.stop || run.result.state !== 'recording' || left > recordingWarningSeconds || left <= 0) {
			this._quiet(run);
			return;
		}
		run.blink = !run.blink;
		void vscode.commands.executeCommand('setContext', 'aiBrowser.recordingEnding', run.blink);
		run.countdown?.dispose();
		run.countdown = vscode.window.setStatusBarMessage?.(vscode.l10n.t('$(record) Recording stops in {0} s — the {1} limit set in Chat Settings', left, formatRecordingSeconds(run.maxSeconds)), 1500);
	}

	private _quiet(run: Run): void {
		run.countdown?.dispose();
		run.countdown = undefined;
		if (run.blink !== undefined) {
			run.blink = undefined;
			void vscode.commands.executeCommand('setContext', 'aiBrowser.recordingEnding', false);
		}
	}

	private _release(run: Run): void {
		this._quiet(run);
		if (run.fd !== undefined) { try { fs.closeSync(run.fd); } catch { /* already closed */ } run.fd = undefined; }
		for (const pending of run.pending.values()) { pending.reject(new Error('Recording has ended.')); }
		run.pending.clear();
		for (const part of run.parts) { part.dispose(); }
		if (run.client) { run.client.dispose(); }
		else if (run.channel) { void run.channel.close(); }
		if (this._active === run) { this._active = undefined; }
		this._publish();
		run.panel.dispose();
	}
	public dispose(): void {
		this._disposed = true;
		if (this._active) { const run = this._active; this._fail(run, new Error('The extension stopped.')); run.panel.dispose(); }
		this._changed.dispose();
	}
}
