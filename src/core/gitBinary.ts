/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * A `git` that can be run without side effects, or `undefined`.
 *
 * **A bare `git` is not safe to run on macOS.** Without the Command Line Tools,
 * `/usr/bin/git` is a shim that opens the "install developer tools" dialog —
 * on every Connect Codex, for a check that then reads as "untracked" anyway.
 * VS Code's own Git extension guards the same shim with `xcode-select -p`.
 *
 * So, in order: the path the Git extension already resolved, when it is
 * active (it has done this dance, honouring `git.path`); on macOS, a git
 * outside `/usr/bin` on `PATH` (Homebrew and the like need no tools), then
 * `/usr/bin/git` only once `xcode-select -p` confirms the tools are there;
 * anywhere else, `git` from `PATH`. Answered once per window.
 */
let gitBinaryAnswer: Promise<string | undefined> | undefined;

export function gitBinary(): Promise<string | undefined> {
	return gitBinaryAnswer ??= findGit();
}

async function findGit(): Promise<string | undefined> {
	const fromExtension = vscode.extensions.getExtension<{ getAPI(v: 1): { git: { path: string } } }>('vscode.git');
	if (fromExtension?.isActive) {
		try {
			const resolved = fromExtension.exports.getAPI(1).git.path;
			if (resolved) {
				return resolved;
			}
		} catch {
			// The extension is up but its API is not; fall through.
		}
	}
	if (process.platform === 'win32') {
		// An absolute path: given a bare name, Windows looks in the working
		// directory first, and the chat runs git inside repository content —
		// a `git.exe` committed at a repository's root would be run.
		for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
			if (!dir || !path.isAbsolute(dir)) {
				continue;
			}
			const candidate = path.join(dir, 'git.exe');
			try {
				await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
				return candidate;
			} catch {
				// Not here.
			}
		}
		return undefined;
	}
	if (process.platform !== 'darwin') {
		return 'git';
	}
	for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
		if (!dir || path.resolve(dir) === '/usr/bin') {
			continue;
		}
		const candidate = path.join(dir, 'git');
		try {
			await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
			return candidate;
		} catch {
			// Not here.
		}
	}
	const tools = await new Promise<boolean>(resolve => {
		execFile('xcode-select', ['-p'], { timeout: 5_000 }, error => resolve(!error));
	});
	return tools ? '/usr/bin/git' : undefined;
}
