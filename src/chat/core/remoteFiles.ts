import type { ViewToHost } from '../chatProtocol';
import type { ControlMap, RemoteSurface } from './commands';

export const remoteFileLevels = ['off', 'read', 'attach', 'write'] as const;
export type RemoteFileLevel = typeof remoteFileLevels[number];
export type RemoteFileSettings = Readonly<Record<RemoteSurface, RemoteFileLevel>>;

export function readRemoteFileLevel(value: unknown): RemoteFileLevel {
	return remoteFileLevels.includes(value as RemoteFileLevel) ? value as RemoteFileLevel : 'write';
}

/** Files controls only; agent tool approvals and sandbox access are separate. */
export function remoteFileRefusal(surface: RemoteSurface, level: RemoteFileLevel, message: ViewToHost): string | undefined {
	let required: RemoteFileLevel;
	if (message.type === 'listWorkdir') { required = 'read'; }
	else if (message.type === 'attachPath') { required = 'attach'; }
	else if (message.type === 'files') {
		required = ['list', 'complete'].includes(message.action) ? 'read' : message.action === 'attach' ? 'attach' : 'write';
	} else { return undefined; }
	if (remoteFileLevels.indexOf(level) >= remoteFileLevels.indexOf(required)) { return undefined; }
	return `File access from ${surface === 'chrome' ? 'Chrome' : 'the website'} is set to ${level}. Change it in VS Code: Chat settings → Permissions.`;
}

export function remoteFileControls(surface: RemoteSurface, level: RemoteFileLevel = 'write'): ControlMap {
	const controls: Record<string, { s: 'off'; reason: string }> = {};
	const messages: ViewToHost[] = [{ type: 'listWorkdir' }, { type: 'attachPath', path: 'item' }];
	for (const action of ['list', 'complete', 'attach', 'copy', 'cut', 'paste', 'newFolder', 'upload'] as const) {
		messages.push({ type: 'files', action, folder: '', dir: '', request: 0 });
	}
	for (const message of messages) {
		const reason = remoteFileRefusal(surface, level, message);
		if (reason) { controls[message.type === 'files' ? `files.${message.action}` : message.type] = { s: 'off', reason }; }
	}
	if (level === 'off') { controls.files = { s: 'off', reason: controls['files.list'].reason }; }
	return controls;
}
