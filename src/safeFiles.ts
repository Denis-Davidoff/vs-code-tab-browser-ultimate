/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Writing files that other users of the machine, and a crash, must not be able
 * to touch. Node modules only, so `npm test` can load it.
 */

import * as crypto from 'crypto';
import { constants as fsConstants } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/**
 * A directory under the temp directory that only this user can enter.
 *
 * **`os.tmpdir()` is shared on Linux**, and screenshots and reports used to be
 * written to the predictable `/tmp/ai-browser/…` with a plain `writeFile`. Any
 * local user could create that tree first and plant a symlink under the
 * expected name — the write then followed it and overwrote whatever file the
 * victim could write — and under the usual `umask 022` every capture of a
 * logged-in page was created `0644`, readable by everybody on the machine.
 * (macOS and Windows hand each user a private temp directory, so this was a
 * Linux problem; the rules below are harmless there.)
 *
 * So the root is per user and created `0700`, and an existing one is accepted
 * only when it is a real directory — not a symlink — owned by this user with no
 * group or other access. Anything inside it is then out of other users' reach
 * by construction. A root that fails the check is not repaired, since it may
 * belong to somebody else: a `mkdtemp` directory is used instead — atomic,
 * random and `0700` — made once per process, see {@link substitute}.
 */
export async function privateTempDirectory(...segments: string[]): Promise<string> {
	const dir = path.join(await privateRoot(true) as string, ...segments);
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	return dir;
}

/**
 * The same directory if it already exists and is private, without creating
 * anything — for the sweep at activation, which has nothing to do when there
 * is nothing there and must not leave directories behind by looking.
 */
export async function existingPrivateTempDirectory(...segments: string[]): Promise<string | undefined> {
	const root = await privateRoot(false);
	return root === undefined ? undefined : path.join(root, ...segments);
}

/**
 * The substitute root, once per process.
 *
 * Minting a fresh `mkdtemp` on every call put each screenshot and report in
 * a directory of its own, so the sweep — which looks in the directory it is
 * given — only ever saw an empty one and nothing was ever retired. One per
 * session keeps retention working inside it; the ones earlier sessions left are
 * in the OS temp directory and go with it.
 */
let substitute: string | undefined;

async function privateRoot(create: boolean): Promise<string | undefined> {
	if (substitute !== undefined) {
		return substitute;
	}
	const uid = process.getuid?.();
	const root = path.join(os.tmpdir(), `ai-browser-${uid ?? 'user'}`);
	if (create) {
		try {
			await fs.mkdir(root, { mode: 0o700 });
		} catch (err: any) {
			if (err?.code !== 'EEXIST') {
				throw err;
			}
		}
	}
	if (await isPrivate(root, uid)) {
		return root;
	}
	if (!create) {
		return undefined;
	}
	substitute = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-browser-'));
	return substitute;
}

/** For tests: forget the substitute root, as a new process would. */
export function resetPrivateTempDirectory(): void {
	substitute = undefined;
}

async function isPrivate(dir: string, uid: number | undefined): Promise<boolean> {
	if (process.platform === 'win32') {
		// No POSIX modes or owners to read, and the temp directory is per user.
		return true;
	}
	try {
		const stat = await fs.lstat(dir);
		return stat.isDirectory()
			&& (uid === undefined || stat.uid === uid)
			&& (stat.mode & 0o077) === 0;
	} catch {
		return false;
	}
}

/**
 * Creates `name` in `dir`, never over anything already there; answers the path
 * actually written.
 *
 * **Two reports or screenshots in one second used to share a path**, because
 * the names carry `HHMMSS` and nothing finer, and the second `writeFile`
 * replaced the first — so an assistant already handed the first file could
 * later read the context of a different element. The readable name is kept and
 * a collision gets `-2`, `-3`, … before the extension instead.
 *
 * `wx` is `O_CREAT | O_EXCL`, which also refuses to follow a symlink sitting at
 * the name; the file is created `0600`, since it holds page content.
 */
export async function writeExclusive(dir: string, name: string, data: string | Uint8Array): Promise<string> {
	const ext = path.extname(name);
	const base = name.slice(0, name.length - ext.length);
	for (let i = 1; i <= 100; i++) {
		const file = path.join(dir, i === 1 ? name : `${base}-${i}${ext}`);
		let handle: fs.FileHandle;
		try {
			handle = await fs.open(file, 'wx', 0o600);
		} catch (err: any) {
			if (err?.code === 'EEXIST') {
				continue;
			}
			throw err;
		}
		try {
			await handle.writeFile(data);
		} finally {
			await handle.close();
		}
		return file;
	}
	throw new Error(`Could not find a free file name for ${name} in ${dir}`);
}

/**
 * Follows a chain of symlinks to the path that is finally written, whether or
 * not that last path exists yet.
 *
 * `realpath` is not enough: it fails on a *dangling* link — one pointing at a
 * config that has not been created yet, which is exactly how a dotfiles repo
 * is linked in before first use — and falling back to the link's own path made
 * the `rename` replace the link with a regular file, silently detaching it.
 * A plain write would have created the target and kept the link, so that is
 * what this does. Relative targets are resolved against the link's directory;
 * a loop answers `ELOOP` the way the OS would.
 */
async function resolveLinks(target: string): Promise<string> {
	let current = path.resolve(target);
	for (let hops = 0; hops < 40; hops++) {
		let link: string;
		try {
			if (!(await fs.lstat(current)).isSymbolicLink()) {
				return current;
			}
			link = await fs.readlink(current);
		} catch (err: any) {
			if (err?.code === 'ENOENT') {
				return current;
			}
			throw err;
		}
		current = path.resolve(path.dirname(current), link);
	}
	throw Object.assign(new Error(`Too many levels of symbolic links: ${target}`), { code: 'ELOOP' });
}

/**
 * Replaces a file's contents so that a reader sees the old file or the new
 * one, never half of either.
 *
 * **A plain overwrite truncates first**, so a crash, a full disk or a power
 * cut in the middle of rewriting `~/.codex/config.toml` or `.mcp.json` left a
 * cut-off file — TOML or JSON that does not parse, taking every MCP server the
 * user has with it. The config lock only orders windows against each other; it
 * says nothing about the write itself. `workspace.fs.writeFile` asks the disk
 * provider for no atomicity, so this goes to Node directly: write a sibling,
 * flush it, `rename` it over the target — atomic within one filesystem, which a
 * sibling guarantees.
 *
 * Two details keep it from changing more than the contents:
 *
 * - **A symlink is written through, not replaced.** Dotfiles setups link
 *   `~/.codex/config.toml` into a repository; a `rename` onto the link would
 *   swap it for a regular file and silently detach the user's config from
 *   where they keep it. So the target is resolved first and the sibling lives
 *   next to the real file.
 * - **An existing file keeps its mode**; a new one gets `newFileMode`. The
 *   callers default that to `0600`, because these files carry a bearer token
 *   and loopback is reachable by every local user.
 */
export async function writeFileAtomic(target: string, data: string | Uint8Array, newFileMode = 0o600): Promise<void> {
	const real = await resolveLinks(target);
	let mode = newFileMode;
	let exists = false;
	try {
		mode = (await fs.stat(real)).mode & 0o7777;
		exists = true;
	} catch {
		// New file.
	}
	if (exists) {
		// **`rename` does not ask the target's permission, only the
		// directory's.** A config made read-only on purpose (`chmod 444`, or
		// root-owned after a `sudo codex …`) used to refuse the plain write
		// with `EACCES`, and the unattended repair skipped it; replacing it
		// through the writable directory would rewrite it at every window
		// start, with the preserved mode hiding that anything changed. So the
		// target's own write permission is asked first, and the answer is the
		// one a plain write would have given.
		await fs.access(real, fsConstants.W_OK);
	}

	const temp = path.join(path.dirname(real),
		`.${path.basename(real)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
	const handle = await fs.open(temp, 'wx', mode);
	try {
		try {
			await handle.writeFile(data);
			await handle.sync();
		} finally {
			await handle.close();
		}
		// The create mode is filtered by the umask; an existing file's mode is
		// what the user chose, so it is restored exactly.
		await fs.chmod(temp, mode);
		await fs.rename(temp, real);
	} catch (err) {
		await fs.rm(temp, { force: true }).catch(() => { });
		throw err;
	}
	if (process.platform !== 'win32') {
		// Persist the rename itself. Best effort: not every filesystem lets a
		// directory be opened for this.
		try {
			const dir = await fs.open(path.dirname(real), 'r');
			try {
				await dir.sync();
			} finally {
				await dir.close();
			}
		} catch {
			// The data is flushed; only the directory entry is not forced out.
		}
	}
}
