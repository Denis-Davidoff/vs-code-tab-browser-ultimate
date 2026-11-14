/*
 * The recorder view's script: hosts `createRecordingEncoder` for the
 * extension's browser recordings. See `src/browser/recorderView.ts`.
 */

import { createRecordingEncoder } from './recording';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
let current: { id: string; encoder: ReturnType<typeof createRecordingEncoder> } | undefined;
const status = document.getElementById('status');
const idleText = status?.textContent ?? '';

window.addEventListener('message', event => {
	const message = event.data;
	if (message?.type !== 'recording' || typeof message.id !== 'string') { return; }
	if (message.message?.type === 'open') {
		current?.encoder.dispose();
		const id = message.id;
		const encoder = createRecordingEncoder(reply => vscode.postMessage({ type: 'recording', id, message: reply }));
		current = { id, encoder };
		if (status) { status.textContent = 'Recording…'; }
		vscode.postMessage({ type: 'recording', id, message: { type: 'ready' } });
	} else {
		const active = current;
		if (!active || active.id !== message.id) { return; }
		if (message.message?.type === 'close') {
			active.encoder.dispose();
			current = undefined;
			if (status) { status.textContent = idleText; }
		} else {
			active.encoder.receive(message.message);
		}
	}
});

vscode.postMessage({ type: 'ready' });
