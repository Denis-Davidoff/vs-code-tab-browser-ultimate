import * as vscode from 'vscode';
import { remoteRefusal as commandRefusal, readConnectionPermissions, type RemoteSurface } from './core/commands';

/** Ignore workspace settings: a repository cannot change a connected client's grants. */
export function connectionPermissions() {
	return readConnectionPermissions(vscode.workspace.getConfiguration('aiBrowser.chat').inspect('connectionPermissions')?.globalValue);
}

export function remoteRefusal(surface: RemoteSurface, type: string): string | undefined {
	return commandRefusal(surface, type, connectionPermissions());
}
