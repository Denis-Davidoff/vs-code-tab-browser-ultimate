import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseHelperLine, type HelperLine } from './voiceText';

/** The helper's name in the extension, built by scripts/build-voice-helper.mjs. */
export const voiceHelperPath = (extensionPath: string) => path.join(extensionPath, 'bin', 'ai-browser-voice');

/**
 * Why voice messages cannot be recorded here, or undefined when they can. macOS 26 (Darwin 25)
 * or later only: the helper is built on SpeechAnalyzer, new there.
 */
export function voiceUnavailable(extensionPath: string, remote: boolean): string | undefined {
	if (process.platform !== 'darwin') {
		return 'Voice messages need macOS: they are recorded and transcribed on the device with its own speech models.';
	}
	if (Number(os.release().split('.')[0]) < 25) {
		return 'Voice messages need macOS 26 or later, for its on-device transcription.';
	}
	if (remote) {
		return 'Voice messages are not available in a remote window.';
	}
	const helper = voiceHelperPath(extensionPath);
	try {
		fs.accessSync(helper, fs.constants.X_OK);
	} catch {
		// A VSIX is a zip, and an install is not sure to keep the executable bit.
		try {
			fs.chmodSync(helper, 0o755);
			fs.accessSync(helper, fs.constants.X_OK);
		} catch {
			return 'The voice helper is missing from this build of the extension.';
		}
	}
	return undefined;
}

/**
 * One voice message: the helper recording into `file` until told `stop` or `cancel`. Events arrive
 * in order; after a `text`, an `error` or `cancel()` nothing more does, and the file is removed —
 * the transcript is what is kept, never the audio.
 */
export class VoiceRecording {
	private readonly _process: ChildProcess;
	private _ended = false;
	private _stopping = false;

	constructor(helper: string, private readonly _file: string, maxSeconds: number, locale: string, private readonly _event: (line: HelperLine) => void) {
		this._process = spawn(helper, ['capture', _file, String(maxSeconds), ...(locale ? [locale] : [])], { stdio: ['pipe', 'pipe', 'pipe'] });
		// A stdin with no error listener throws on EPIPE when the helper has exited (#24).
		this._process.stdin?.on('error', () => { /* the exit reports it */ });
		let buffer = '';
		let stderr = '';
		this._process.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
			buffer += chunk;
			let end: number;
			while ((end = buffer.indexOf('\n')) >= 0) {
				const line = parseHelperLine(buffer.slice(0, end));
				buffer = buffer.slice(end + 1);
				if (line && !this._ended) {
					if (line.e === 'text' || line.e === 'error') {
						this._finish();
					}
					this._event(line);
				}
			}
		});
		this._process.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-400); });
		this._process.on('error', err => this._fail(err.message));
		// `close`, not `exit`: it comes after stdout has ended, so a last `text` line cannot lose the race to it.
		this._process.on('close', (code, signal) => {
			if (!this._ended) {
				this._fail(this._stopping || code !== 0 || signal ? (stderr.trim() || `The voice helper stopped (${signal ?? code}).`) : 'The voice helper stopped.');
			}
		});
	}

	public get ended(): boolean { return this._ended; }

	/** End the recording and transcribe it; the transcript arrives as a `text` event. */
	public stop(): void {
		if (!this._ended && !this._stopping) {
			this._stopping = true;
			this._process.stdin?.end('stop\n');
		}
	}

	/** End it and throw it away; no event follows. */
	public cancel(): void {
		if (this._ended) {
			return;
		}
		this._finish();
		this._process.stdin?.end('cancel\n');
		// A helper stuck on the microphone is not left holding it.
		setTimeout(() => { if (this._process.exitCode === null) { this._process.kill(); } }, 2000).unref();
	}

	private _fail(message: string): void {
		if (!this._ended) {
			this._finish();
			this._event({ e: 'error', code: 'helper', message: message.slice(0, 300) });
		}
	}

	private _finish(): void {
		this._ended = true;
		fs.promises.rm(this._file, { force: true }).catch(() => { /* in a private temp directory, swept with it */ });
	}
}
