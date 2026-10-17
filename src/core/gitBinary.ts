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
 * anywhere else, the first `git` on `PATH`. Always an absolute path, and only
 * from absolute `PATH` entries. Answered once per window.
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
	// Off macOS, the first `git` on an absolute `PATH` entry, and nothing else.
	// A bare name is looked up at run time, and an empty or `.` entry — or, on
	// Windows, the working directory itself, searched first — then runs a `git`
	// committed in the repository the chat is working in.
	if (process.platform !== 'darwin') {
		return onPath(process.platform === 'win32' ? 'git.exe' : 'git');
	}
	const found = await onPath('git', dir => path.resolve(dir) === '/usr/bin');
	if (found) {
		return found;
	}
	const tools = await new Promise<boolean>(resolve => {
		execFile('xcode-select', ['-p'], { timeout: 5_000 }, error => resolve(!error));
	});
	return tools ? '/usr/bin/git' : undefined;
}

/** The first `name` in an absolute `PATH` entry, by its absolute path; `skip` passes over an entry. */
async function onPath(name: string, skip: (dir: string) => boolean = () => false): Promise<string | undefined> {
	for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
		if (!dir || !path.isAbsolute(dir) || skip(dir)) {
			continue;
		}
		const candidate = path.join(dir, name);
		try {
			const stat = await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
			if (stat.type & vscode.FileType.File) {
				return candidate;
			}
		} catch {
			// Not here.
		}
	}
	return undefined;
}
