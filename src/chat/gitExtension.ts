/**
 * VS Code's own Git extension (`vscode.git`), for the operations that reach a
 * remote: publishing a branch, pushing it, fetching before a pull.
 *
 * **Why through the extension and not our own `git`.** A push needs
 * credentials, and the extension runs git with its `GIT_ASKPASS`, so an https
 * remote answers through VS Code's GitHub sign-in or an input box, while our
 * own runs (`GIT_TERMINAL_PROMPT=0`) can only fail where no credential helper
 * or ssh agent answers. Its progress goes to the Source Control view and the
 * status bar, never a notification (which would pause a browser tab), and an
 * API call shows no error toast of its own: the error is thrown to us.
 *
 * Only the members used here are declared — the shape of `git.d.ts` in
 * microsoft/vscode `extensions/git/src/api/git.d.ts`, API version 1.
 */

import { realpathSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface GitApiRepository {
	readonly rootUri: vscode.Uri;
	/** `git push [-u] [remote] [refspec]`; the refspec goes to git as it is. */
	push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
	fetch(options?: { remote?: string; ref?: string }): Promise<void>;
}

interface GitApi {
	readonly state: 'uninitialized' | 'initialized';
	readonly onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
	getRepository(uri: vscode.Uri): GitApiRepository | null;
	openRepository?(root: vscode.Uri): Promise<GitApiRepository | null>;
}

interface GitExtension {
	readonly enabled: boolean;
	getAPI(version: 1): GitApi;
}

/** How long the extension may take to finish scanning the workspace before we give up. */
const initializeWaitMs = 10_000;

/**
 * The extension's repository whose root is `root` (a `git rev-parse
 * --show-toplevel`), found from `folder`, the working folder as it was opened.
 * Compared by real path: `rev-parse` resolves a symbolic link (`/tmp` is
 * `/private/tmp` on macOS) while the extension keeps the path it was given,
 * so a plain comparison never matched a folder opened through one. A folder the extension has not opened — a working folder
 * picked outside the workspace — is opened, which adds it to the Source
 * Control view: that is the extension's model, and pushing without it is not
 * possible through its API.
 */
export async function gitRepositoryFor(root: string, folder: string = root): Promise<GitApiRepository> {
	const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
	if (!extension) {
		throw new Error('VS Code\'s Git extension is not available in this editor.');
	}
	const exports = extension.isActive ? extension.exports : await extension.activate();
	if (!exports?.enabled) {
		throw new Error('VS Code\'s Git extension is disabled. Turn on the git.enabled setting to publish and push from here.');
	}
	const api = exports.getAPI(1);
	if (api.state !== 'initialized') {
		await new Promise<void>(resolve => {
			const timer = setTimeout(() => { listener.dispose(); resolve(); }, initializeWaitMs);
			const listener = api.onDidChangeState(state => {
				if (state === 'initialized') { clearTimeout(timer); listener.dispose(); resolve(); }
			});
		});
	}
	const real = (p: string) => {
		try {
			return realpathSync.native(p);
		} catch {
			return path.resolve(p);
		}
	};
	const target = real(root);
	const same = (repo: GitApiRepository | null): repo is GitApiRepository =>
		!!repo && real(repo.rootUri.fsPath) === target;
	// `getRepository` answers for the repository *containing* the path, which
	// for a nested repository the extension has not opened is its parent.
	for (const at of new Set([folder, root])) {
		const known = api.getRepository(vscode.Uri.file(at));
		if (same(known)) {
			return known;
		}
	}
	const opened = await api.openRepository?.(vscode.Uri.file(folder));
	if (same(opened ?? null)) {
		return opened!;
	}
	throw new Error('VS Code\'s Git extension has not opened this repository. Open it in the Source Control view and try again.');
}

/**
 * A sentence from what the extension threw. Its `GitError` carries a
 * `gitErrorCode` and git's own `stderr`; the codes worth a next step are
 * named, anything else is git's text.
 */
export function gitExtensionErrorText(error: unknown): string {
	const e = error as { gitErrorCode?: string; stderr?: string; message?: string } | undefined;
	const detail = (e?.stderr || e?.message || String(error)).trim().split('\n').filter(Boolean).slice(-4).join('\n');
	switch (e?.gitErrorCode) {
		case 'PushRejected':
			// The extension marks every "failed to push some refs" so: a pre-push
			// hook, a protected branch and a size limit too. Only a fetch-first
			// refusal is cured by pulling, and git's own words say which.
			return /\(fetch first\)|non-fast-forward/.test(e.stderr ?? '')
				? `The remote has commits this branch does not. Pull first, then push again.\n${detail}`
				: `The push was refused.\n${detail}`;
		case 'AuthenticationFailed':
		case 'PermissionDenied':
			return `The remote refused the credentials. Sign in to the remote and try again.\n${detail}`;
		case 'RemoteConnectionError':
		case 'CantAccessRemote':
			return `Could not reach the remote. Check the connection and try again.\n${detail}`;
		case 'NoRemoteRepositorySpecified':
			return 'This repository has no remote to publish to.';
		default:
			return detail || 'Git failed.';
	}
}
