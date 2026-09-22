/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
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

/**
 * How often a held lock's mtime is refreshed.
 *
 * **Staleness has to mean "the holder is gone", not "the work is slow".** The
 * age check read the mtime written at acquisition and nothing ever moved it, so
 * a holder whose write stalled — a network home, the case `repairQueueWaitMs`
 * exists for — lost its lock at 30s to a waiter that then ran its own
 * read-modify-write beside it. A third of `staleMs` leaves two missed ticks of
 * margin before a live holder could read as abandoned.
 */
const heartbeatMs = staleMs / 3;

export function lockPath(name: string): string {
	return path.join(os.tmpdir(), `ai-browser-${name}.lock`);
}

async function readOwner(file: string): Promise<string | undefined> {
	try {
		return await fs.readFile(file, 'utf8');
	} catch {
		return undefined;
	}
}

/**
 * Is the lock at this path left behind by a holder that is gone?
 *
 * Two independent signs, either of which is enough. The **age** — a live
 * holder refreshes the mtime every {@link heartbeatMs}, so a lock older than
 * {@link staleMs} has nobody behind it. And the **owner's process** — the file
 * names the pid that wrote it, and a pid that no longer exists is proof on its
 * own, which spares the next window the whole 30s after a crash. The pid rule
 * can only ever say "gone": `EPERM` means the process exists under another
 * user, and a file that has not been written yet (or a reused pid) names
 * nothing provable, so the age rule is all that applies.
 */
function abandoned(mtimeMs: number, content: string | undefined): boolean {
	if (Date.now() - mtimeMs > staleMs) {
		return true;
	}
	const pid = Number(content?.split(':')[0]);
	if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return false;
	} catch (err: any) {
		return err?.code === 'ESRCH';
	}
}

/**
 * Removes the file at `file` if — judged on the file itself — it is abandoned.
 * Answers whether it did.
 *
 * **Deciding on one read and removing by path afterwards is the race.** Two
 * waiters see the same abandoned lock; A removes it and takes a fresh one; B,
 * acting on its earlier read, removes *A's* lock — and both run their
 * read-modify-write of `~/.codex/config.toml` together (items 16 and 106). The
 * first fix moved that into a critical section guarded by `<lock>.break`, and
 * then removed a stale *breaker* the old way, which is the same race one level
 * down (breaks-silently #167).
 *
 * So nothing is removed by path. The file is `rename`d aside first — atomic, so
 * of two racers exactly one moves any given file — and the verdict is taken on
 * **the file that was moved**: its mtime and its contents belong to that inode,
 * so no earlier read takes part. If what was moved turns out to be live (the
 * path was retaken between a racer's first look and its rename), it is linked
 * straight back; `link` refuses to overwrite, so a holder that appeared in that
 * instant is never displaced. That leaves one window — between the rename and
 * the link-back of a *live* file — which the breaker keeps from being reached
 * by more than one remover at a time. Narrowed, not closed: closing it needs a
 * compare-and-delete that POSIX does not have.
 */
async function takeAsideIfAbandoned(file: string): Promise<boolean> {
	const aside = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.aside`;
	try {
		await fs.rename(file, aside);
	} catch {
		// Somebody else moved or released it first.
		return false;
	}
	let gone = false;
	try {
		gone = abandoned((await fs.stat(aside)).mtimeMs, await readOwner(aside));
	} catch {
		// Cannot judge what we hold; treat it as live and put it back.
	}
	if (!gone) {
		await fs.link(aside, file).catch(() => { });
	}
	await fs.rm(aside, { force: true }).catch(() => { });
	return gone;
}

/**
 * Removes an abandoned lock under `<lock>.break`. Answers whether the caller
 * may retry at once (the lock is gone) or should wait (somebody else holds the
 * breaker, or the lock turned out to be live).
 *
 * The breaker only keeps removers from running side by side; the safety comes
 * from {@link takeAsideIfAbandoned}, which is also how an abandoned breaker is
 * cleared — so no path in this module removes a file on an earlier judgement.
 */
async function removeAbandoned(file: string): Promise<boolean> {
	const breaker = `${file}.break`;
	try {
		const handle = await fs.open(breaker, 'wx');
		try {
			await handle.writeFile(`${process.pid}:break`, 'utf8');
		} finally {
			await handle.close();
		}
	} catch (err: any) {
		if (err?.code === 'EEXIST') {
			// A remover is at work, or one died holding it. Either way wait a
			// beat: retrying at once spent every attempt in a tight loop while
			// the other remover was still busy, and `withLock` gave up.
			await takeAsideIfAbandoned(breaker);
		}
		return false;
	}
	try {
		return await takeAsideIfAbandoned(file);
	} finally {
		await fs.rm(breaker, { force: true }).catch(() => { });
	}
}

/** Takes the lock; answers the owner token written into it, or `undefined`. */
async function acquire(file: string): Promise<string | undefined> {
	const owner = `${process.pid}:${crypto.randomBytes(8).toString('hex')}`;
	for (let i = 0; i < attempts; i++) {
		try {
			const handle = await fs.open(file, 'wx');
			try {
				await handle.writeFile(owner, 'utf8');
			} finally {
				await handle.close();
			}
			return owner;
		} catch (err: any) {
			if (err?.code !== 'EEXIST') {
				// An unwritable temp directory is not worth failing over: the
				// caller simply does not get to run.
				return undefined;
			}
			try {
				const stat = await fs.stat(file);
				if (abandoned(stat.mtimeMs, await readOwner(file)) && await removeAbandoned(file)) {
					continue;
				}
			} catch {
				// Vanished between the two calls — the holder just released it.
				continue;
			}
			await new Promise(resolve => setTimeout(resolve, retryMs));
		}
	}
	return undefined;
}

/**
 * Runs `work` while holding the lock.
 *
 * Returns `false` when the lock could not be taken, so the caller can say it
 * skipped rather than pretend it succeeded.
 *
 * The lock is kept fresh while `work` runs, and released only if it is still
 * ours — a lock taken over as abandoned belongs to somebody else by then, and
 * removing it would let a third window in beside them.
 */
export async function withLock(file: string, work: () => Promise<void>): Promise<boolean> {
	const owner = await acquire(file);
	if (owner === undefined) {
		return false;
	}
	const heartbeat = setInterval(() => {
		const now = new Date();
		fs.utimes(file, now, now).catch(() => { });
	}, heartbeatMs);
	// A lock must never be what keeps the extension host's event loop alive.
	heartbeat.unref?.();
	try {
		await work();
	} finally {
		clearInterval(heartbeat);
		if (await readOwner(file) === owner) {
			await fs.rm(file, { force: true }).catch(() => { });
		}
	}
	return true;
}
