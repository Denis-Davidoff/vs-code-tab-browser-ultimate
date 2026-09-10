/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/**
 * A cross-process lock, for the one file several windows write at once.
 *
 * `~/.codex/config.toml` is global: every window repairs its own entry in it on
 * startup, and a machine that restores a session opens all of them at the same
 * moment. Two read-modify-writes of the same file interleave into a lost
 * update at best, and a half-written TOML file takes every MCP server the user
 * has down with it.
 *
 * `open(…, 'wx')` is the primitive — it fails if the path exists, atomically,
 * which is exactly a mutex. Everything else here is about the two ways a plain
 * lock file goes wrong:
 *
 *   - **A crashed window leaves the lock behind forever.** Hence the age check:
 *     a lock older than {@link staleMs} is assumed abandoned and removed. The
 *     window is generous compared with the work it guards, which is one small
 *     file rewrite.
 *   - **Waiting forever is worse than not repairing.** This runs on the
 *     activation path, so it gives up after {@link attempts} and reports that
 *     it did. A skipped repair is corrected on the next start; a hung
 *     activation is not.
 */

const staleMs = 30_000;
const attempts = 20;
const retryMs = 50;

export function lockPath(name: string): string {
	return path.join(os.tmpdir(), `ai-browser-${name}.lock`);
}

async function acquire(file: string): Promise<boolean> {
	for (let i = 0; i < attempts; i++) {
		try {
			const handle = await fs.open(file, 'wx');
			await handle.close();
			return true;
		} catch (err: any) {
			if (err?.code !== 'EEXIST') {
				// An unwritable temp directory is not worth failing over: the
				// caller simply does not get to run.
				return false;
			}
			try {
				const stat = await fs.stat(file);
				if (Date.now() - stat.mtimeMs > staleMs) {
					await fs.rm(file, { force: true });
					continue;
				}
			} catch {
				// Vanished between the two calls — the holder just released it.
				continue;
			}
			await new Promise(resolve => setTimeout(resolve, retryMs));
		}
	}
	return false;
}

/**
 * Runs `work` while holding the lock.
 *
 * Returns `false` when the lock could not be taken, so the caller can say it
 * skipped rather than pretend it succeeded.
 */
export async function withLock(file: string, work: () => Promise<void>): Promise<boolean> {
	if (!await acquire(file)) {
		return false;
	}
	try {
		await work();
	} finally {
		await fs.rm(file, { force: true }).catch(() => { });
	}
	return true;
}
