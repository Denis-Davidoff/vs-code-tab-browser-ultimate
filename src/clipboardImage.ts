/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile, spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Putting an image on the clipboard.
 *
 * `vscode.env.clipboard` is **text only** — there is no image clipboard in the
 * extension API — so this shells out to the platform's own tool. Every path
 * writes the PNG to a file first, because that is what those tools take, and
 * because the file is the fallback when the clipboard cannot be reached.
 */

export type ImageDelivery =
	| { readonly kind: 'clipboard'; readonly file: vscode.Uri }
	| { readonly kind: 'file'; readonly file: vscode.Uri; readonly reason: string };

const keepFor = 24 * 60 * 60 * 1000;

function directory(): string {
	return path.join(os.tmpdir(), 'ai-browser', 'screenshots');
}

async function prune(): Promise<void> {
	const dir = directory();
	try {
		const now = Date.now();
		for (const name of await fs.readdir(dir)) {
			const file = path.join(dir, name);
			try {
				const stat = await fs.stat(file);
				if (now - stat.mtimeMs > keepFor) {
					await fs.unlink(file);
				}
			} catch {
				// Raced with something else.
			}
		}
	} catch {
		// Not created yet.
	}
}

/**
 * Runs a command that expects the image on stdin, such as `wl-copy`.
 *
 * **`stdin` needs its own error handler.** A screenshot is a large buffer, so
 * the write is not atomic; if the child exits before it has all been read, the
 * pipe write fails with `EPIPE`. An error on a stream with no listener is
 * thrown, and here that means an unhandled exception in the extension host
 * rather than the file-on-disk fallback the caller is ready for. The child's
 * own `error` event does not cover it — that one is about spawning.
 */
function runWithStdin(command: string, args: string[], data: Buffer): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
		child.on('error', reject);
		child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
		child.stdin.on('error', (err: Error) => reject(
			new Error(`${command} did not take the image (${err.message})`)));
		child.stdin.end(data);
	});
}

function run(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		// execFile, not exec: the file path never reaches a shell.
		execFile(command, args, { timeout: 10_000 }, error => {
			error ? reject(error) : resolve();
		});
	});
}

/**
 * The platform command that loads a PNG file into the clipboard as an image.
 *
 * macOS needs the `«class PNGf»` coercion — `set the clipboard to (read …)`
 * without it puts raw bytes on as data, which nothing will paste as a picture.
 * Verified: after this runs, `clipboard info` lists `«class PNGf»` and macOS
 * offers TIFF/JPEG/GIF conversions of it for free.
 */
function clipboardCommand(file: string): { command: string; args: string[] } | undefined {
	switch (process.platform) {
		case 'darwin':
			return {
				command: 'osascript',
				args: ['-e', `set the clipboard to (read (POSIX file "${file}") as «class PNGf»)`],
			};
		case 'win32':
			return {
				command: 'powershell',
				args: [
					'-NoProfile', '-NonInteractive', '-STA', '-Command',
					`Add-Type -AssemblyName System.Windows.Forms,System.Drawing; `
					+ `$image = [System.Drawing.Image]::FromFile('${file}'); `
					+ `[System.Windows.Forms.Clipboard]::SetImage($image); $image.Dispose()`,
				],
			};
		default:
			// xclip is the usual one; wl-copy is tried next by the caller.
			return { command: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/png', '-i', file] };
	}
}

/**
 * Writes `png` to a file and tries to put it on the clipboard as an image.
 *
 * Always returns the file too: on any failure the caller still has something to
 * show, which matters because a screenshot that vanished is worse than one that
 * merely did not reach the clipboard.
 */
export async function copyImage(png: Buffer, baseName: string): Promise<ImageDelivery> {
	const dir = directory();
	await fs.mkdir(dir, { recursive: true });
	await prune();

	const target = path.join(dir, baseName);
	await fs.writeFile(target, png);
	const uri = vscode.Uri.file(target);

	// In a remote workspace the extension host — and therefore any command it
	// runs — lives on the other machine, whose clipboard is not the user's.
	if (vscode.env.remoteName || vscode.env.uiKind !== vscode.UIKind.Desktop) {
		return {
			kind: 'file', file: uri,
			reason: vscode.l10n.t("the clipboard belongs to a different machine in a remote or web window"),
		};
	}

	const platform = clipboardCommand(target);
	if (!platform) {
		return { kind: 'file', file: uri, reason: vscode.l10n.t("this platform has no image clipboard tool") };
	}

	try {
		await run(platform.command, platform.args);
		return { kind: 'clipboard', file: uri };
	} catch (err) {
		if (process.platform !== 'darwin' && process.platform !== 'win32') {
			// Wayland sessions have wl-copy rather than xclip, and it reads the
			// image from stdin instead of taking a path.
			try {
				await runWithStdin('wl-copy', ['--type', 'image/png'], png);
				return { kind: 'clipboard', file: uri };
			} catch {
				// fall through to the file
			}
		}
		return {
			kind: 'file', file: uri,
			reason: err instanceof Error ? err.message : String(err),
		};
	}
}

/** `screenshot-<host>[-full]-<HHMMSS>.png`, so several in a row do not collide. */
export function screenshotFileName(
	url: string | undefined,
	fullPage = false,
	now: Date = new Date(),
): string {
	let host = 'page';
	try {
		host = new URL(url ?? '').hostname || 'page';
	} catch {
		// keep the fallback
	}
	const slug = host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'page';
	const pad = (n: number) => String(n).padStart(2, '0');
	const scope = fullPage ? '-full' : '';
	return `screenshot-${slug}${scope}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
}
