/*
 * The webview that encodes browser recordings.
 *
 * The extension host has no video encoder; a webview has `MediaRecorder`.
 * Until 2026-11-14 the chat view did this job, and the chat moved to
 * HoverDeck, so this small view in the panel area does it instead. It is
 * created with `retainContextWhenHidden`, so a recording goes on while the
 * view is collapsed or another panel view is in front.
 *
 * The protocol is the chat's, unchanged (`preview-src/recorder.ts` beside
 * `preview-src/recording.ts`): the host posts `{ type: 'recording', id,
 * message }` with `open`, frames, `chunkAck` and `close`; the view answers in
 * the same envelope with `ready`, chunks and `error`.
 */

import * as vscode from 'vscode';
import { generateUuid } from '../core/uuid';
import type { RecordingEncoder } from './recording';

export const recorderViewId = 'aiBrowser.recorder';

export class RecorderViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private _view: vscode.WebviewView | undefined;
	private _ready = false;
	private _encoder: { id: string; messages: vscode.EventEmitter<any>; host: RecordingEncoder } | undefined;
	private readonly _parts: vscode.Disposable[] = [];

	constructor(private readonly _extensionUri: vscode.Uri) { }

	public resolveWebviewView(view: vscode.WebviewView): void {
		this._view = view;
		this._ready = false;
		const media = vscode.Uri.joinPath(this._extensionUri, 'media');
		view.webview.options = { enableScripts: true, localResourceRoots: [media] };
		view.webview.html = this._html(view.webview, media);
		this._parts.push(view.webview.onDidReceiveMessage(message => {
			if (message?.type === 'ready') {
				this._ready = true;
				// A recording asked for before the view existed opens now.
				const pending = this._encoder;
				if (pending) { void view.webview.postMessage({ type: 'recording', id: pending.id, message: { type: 'open' } }); }
			} else if (message?.type === 'recording') {
				const current = this._encoder;
				if (current && current.id === message.id) { current.messages.fire(message.message); }
			}
		}));
		this._parts.push(view.onDidDispose(() => {
			this._view = undefined;
			this._ready = false;
			// Nothing can encode any more: the recording fails rather than waits.
			this._encoder?.messages.fire({ type: 'error', error: 'The video recorder view was closed.' });
		}));
	}

	public createEncoder(id: string): RecordingEncoder {
		this._encoder?.host.dispose();
		const messages = new vscode.EventEmitter<any>();
		const closed = new vscode.EventEmitter<void>();
		let disposed = false;
		const host: RecordingEncoder = {
			webview: {
				onDidReceiveMessage: messages.event,
				postMessage: message => {
					if (disposed || !this._view || !this._ready) { return Promise.resolve(false); }
					return this._view.webview.postMessage({ type: 'recording', id, message });
				},
			},
			onDidDispose: closed.event,
			dispose: () => {
				if (disposed) { return; }
				disposed = true;
				if (this._encoder?.id === id) { this._encoder = undefined; }
				if (this._view && this._ready) { void this._view.webview.postMessage({ type: 'recording', id, message: { type: 'close' } }); }
				closed.fire(); messages.dispose(); closed.dispose();
			},
		};
		this._encoder = { id, messages, host };
		// Deferred until the recording has subscribed to `ready` and `error`.
		void Promise.resolve().then(async () => {
			if (disposed) { return; }
			if (this._view && this._ready) {
				await this._view.webview.postMessage({ type: 'recording', id, message: { type: 'open' } });
				return;
			}
			// The view has never been shown: show it once so it resolves, then
			// give the focus back to the editor (the page being recorded).
			await vscode.commands.executeCommand(`${recorderViewId}.focus`);
			await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
		}).catch(error => messages.fire({ type: 'error', error: String(error) }));
		return host;
	}

	public dispose(): void {
		this._encoder?.host.dispose();
		for (const part of this._parts.splice(0)) { part.dispose(); }
	}

	private _html(webview: vscode.Webview, media: vscode.Uri): string {
		const nonce = generateUuid();
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'recorder.js')).toString();
		return /* html */ `<!DOCTYPE html>
			<html>
			<head>
				<meta http-equiv="Content-type" content="text/html;charset=UTF-8">
				<meta http-equiv="Content-Security-Policy" content="
					default-src 'none';
					img-src data:;
					media-src blob:;
					style-src 'nonce-${nonce}';
					script-src 'nonce-${nonce}';
					">
				<meta name="viewport" content="width=device-width, initial-scale=1">
				<style nonce="${nonce}">
					body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-descriptionForeground); padding: 8px 12px; }
				</style>
			</head>
			<body>
				<p id="status">${vscode.l10n.t('Encodes AI Browser video recordings. Leave this view open while a recording runs.')}</p>
				<script nonce="${nonce}" src="${script}"></script>
			</body>
			</html>`;
	}
}
