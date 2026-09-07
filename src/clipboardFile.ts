/*---------------------------------------------------------------------------------------------
 *  Puts a report on the clipboard as a file next to its text, so pasting it into a chat
 *  attaches a document while a plain text field still gets the text.
 *
 *  Nothing in the editor api can write a file to the clipboard, so this goes through the
 *  platform's own clipboard tool. Where that is not available the report stays plain text.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getConfiguration } from './browserProxy';

/** Reports older than this are removed the next time one is written. */
const keepReportsFor = 24 * 60 * 60 * 1000;

/**
 * Writes one pasteboard item carrying both the file and its text, which is what makes an app
 * able to choose between attaching the document and pasting the text.
 */
const macScript = `function run(argv) {
	ObjC.import('AppKit');
	const pasteboard = $.NSPasteboard.generalPasteboard;
	pasteboard.clearContents;
	const item = $.NSPasteboardItem.alloc.init;
	item.setStringForType($.NSURL.fileURLWithPath(argv[0]).absoluteString, 'public.file-url');
	item.setStringForType($.NSString.stringWithContentsOfFileEncodingError(argv[0], 4, $()), 'public.utf8-plain-text');
	pasteboard.writeObjects($([item]));
}`;

export type ClipboardKind = 'file' | 'text';

/**
 * Copies `text`, as a file called `baseName` when the setting and the platform allow it.
 * Returns what actually landed on the clipboard.
 */
export async function copyReport(text: string, baseName: string): Promise<ClipboardKind> {
	if (canWriteFile()) {
		const file = await writeReportFile(text, baseName);
		if (file && await putFileOnClipboard(file)) {
			return 'file';
		}
	}

	await vscode.env.clipboard.writeText(text);
	return 'text';
}

/** `input#email.ant-input` -> `input-email-ant-input`, so the attachment has a readable name. */
export function slugify(value: string): string {
	const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	return slug ? slug.slice(0, 40).replace(/-+$/, '') : 'element';
}

function canWriteFile(): boolean {
	if (!getConfiguration().get<boolean>('copyAsFile', true)) {
		return false;
	}
	// A remote workspace runs this code on the remote machine, where the clipboard is not the
	// one the user pastes into.
	if (vscode.env.remoteName || vscode.env.uiKind !== vscode.UIKind.Desktop) {
		return false;
	}
	return typeof process === 'object'
		&& (process.platform === 'darwin' || process.platform === 'win32');
}

async function writeReportFile(text: string, baseName: string): Promise<string | undefined> {
	try {
		const directory = path.join(os.tmpdir(), 'tab-browser-ultimate');
		await fs.mkdir(directory, { recursive: true });
		await pruneOldReports(directory);

		const file = path.join(directory, baseName);
		await fs.writeFile(file, text, 'utf8');
		return file;
	} catch {
		return undefined;
	}
}

async function pruneOldReports(directory: string): Promise<void> {
	try {
		const cutoff = Date.now() - keepReportsFor;
		for (const entry of await fs.readdir(directory)) {
			const file = path.join(directory, entry);
			const stat = await fs.stat(file);
			if (stat.mtimeMs < cutoff) {
				await fs.rm(file, { force: true });
			}
		}
	} catch {
		// Housekeeping only.
	}
}

function putFileOnClipboard(file: string): Promise<boolean> {
	const [command, args] = process.platform === 'darwin'
		? ['osascript', ['-l', 'JavaScript', '-e', macScript, file]]
		: ['powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard', '-Path', file]];

	return new Promise(resolve => {
		execFile(command as string, args as string[], { timeout: 5000 }, error => resolve(!error));
	});
}
