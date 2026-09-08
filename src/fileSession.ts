/*---------------------------------------------------------------------------------------------
 *  Serving a page off the disk, so that a local html file can be read like any other page.
 *
 *  An `<iframe>` cannot load a `file:` url at all, and nothing could be injected into it if it
 *  could — which is what the picker, the console capture and the mcp tools are. So a file is
 *  handed to the browser by a session of the proxy's, over http, from a folder it may not
 *  leave: the two halves of that are this module (what a request is allowed to reach) and
 *  `BrowserProxy._serveFile` (the answer itself).
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { cacheBustParameter } from '../shared/protocol';
import { generateUuid } from './uuid';

/** Extensions served as html, i.e. instrumented and offered by the file browser. */
export const htmlExtensions: readonly string[] = ['.html', '.htm', '.xhtml'];

export interface ServedFolder {
	/** Absolute path of the only folder this session serves. */
	readonly root: string;
	/**
	 * The same folder with every symlink on the way to it resolved, which is what a file's own
	 * resolved path has to sit under. The two differ more often than it looks — `/tmp` is a
	 * link to `/private/tmp` on macOS — so the check cannot use `root`.
	 */
	readonly realRoot: string;
	/**
	 * First segment of every url this session answers. A port on the loopback interface is
	 * reachable by anything running on this machine — and by any page in any browser that
	 * guesses it — so without a segment nothing can guess, the session would be a read of the
	 * folder to whoever asks first. It is not a secret from the page itself, which can read its
	 * own location; what it protects is the folder from everybody else.
	 */
	readonly secret: string;
}

export type ServedPath =
	| {
		readonly path: string;
		/**
		 * The request carried no segment of the session's and was vouched for by its `Referer`
		 * instead. Such a request is redirected onto one that does carry the segment rather
		 * than answered as it is: what the file in turn references is resolved against *its*
		 * url, and an url with no segment of ours in it produces requests nothing can vouch
		 * for — `import './dep.js'` from a module served under a bare `/assets/main.js`.
		 */
		readonly fromReferer?: true;
	}
	/** Nothing under the folder answers this request, and the status says as much as is safe. */
	| { readonly status: 403 | 404 };

export function newServedFolder(root: string, realRoot = root): ServedFolder {
	return {
		root: path.resolve(root),
		realRoot: path.resolve(realRoot),
		secret: generateUuid().replace(/-/g, ''),
	};
}

/**
 * Where a request lands on disk, or a refusal. Pure, because it is the whole of the rule.
 *
 * `fromOwnPage` is for a request that carries no segment of the session's: a page built for a
 * static server references `/assets/app.js`, and there is nothing in such a path to say which
 * session it belongs to. Only the caller can answer that — from the `Referer`, which a page on
 * another origin cannot forge — and then the path is resolved against the folder, exactly as
 * the server that page was built for would.
 */
export function servedPathOf(
	folder: ServedFolder,
	requestTarget: string | undefined,
	fromOwnPage = false,
): ServedPath {
	const target = (requestTarget ?? '/').split('#')[0].split('?')[0];

	// Split before decoding: an escaped separator (`%2f`, `%5c`) must not become one, or a
	// single segment could carry a path of its own past the checks below.
	const segments: string[] = [];
	for (const raw of target.split('/')) {
		if (!raw) {
			continue;
		}
		let segment: string;
		try {
			segment = decodeURIComponent(raw);
		} catch {
			return { status: 404 };
		}
		if (segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')
			|| segment.includes('\0')) {
			return { status: 403 };
		}
		segments.push(segment);
	}

	const carriesSecret = segments[0] === folder.secret;
	const relative = carriesSecret
		? segments.slice(1)
		: fromOwnPage ? segments : undefined;
	if (!relative) {
		return { status: 404 };
	}

	const resolved = path.resolve(folder.root, ...relative);
	// Belt and braces: the segments above cannot climb out, and this says so of the result.
	if (!isUnder(folder.root, resolved)) {
		return { status: 403 };
	}
	return carriesSecret ? { path: resolved } : { path: resolved, fromReferer: true };
}

/** The url the webview loads for a file this session serves. */
export function servedUrlOf(folder: ServedFolder, publicOrigin: string, filePath: string): string {
	const relative = path.relative(folder.root, path.resolve(filePath));
	const encoded = relative
		? relative.split(path.sep).map(segment => encodeURIComponent(segment)).join('/')
		: '';
	return `${trimTrailingSlash(publicOrigin)}/${folder.secret}${encoded ? `/${encoded}` : ''}`;
}

/** The `file:` url of a path the session served, for the address bar and every report. */
export function realUrlOf(folder: ServedFolder, requestTarget: string | undefined): string | undefined {
	const served = servedPathOf(folder, requestTarget);
	if (!('path' in served)) {
		return undefined;
	}

	// The query and the fragment belong to the page; the parameter the panel varies to make the
	// frame load it again does not.
	let tail = '';
	try {
		const parsed = new URL(requestTarget ?? '', 'http://tab-browser.invalid');
		parsed.searchParams.delete(cacheBustParameter);
		tail = parsed.search + parsed.hash;
	} catch {
		// Then the path is all there is, which is what a file url needs anyway.
	}
	return vscode.Uri.file(served.path).toString(true) + tail;
}

export function isUnder(root: string, candidate: string): boolean {
	const base = trimTrailingSeparator(path.resolve(root));
	const target = path.resolve(candidate);
	return target === base || target.startsWith(base + path.sep);
}

export function isHtmlPath(filePath: string): boolean {
	return htmlExtensions.includes(path.extname(filePath).toLowerCase());
}

/**
 * Watches what a session has actually served, so that saving the page — or a stylesheet it
 * pulls in — reloads the panel. Only the files that were served, since a project is full of
 * files this page has nothing to do with, and only their folders are watched: one watcher per
 * folder rather than per file, and none of them recursive.
 */
export class ServedFiles {

	/** Every file served, against the pages it is part of. */
	private readonly _pages = new Map<string, Set<string>>();
	private readonly _watchers = new Map<string, vscode.Disposable>();
	private readonly _onDidChange = new vscode.EventEmitter<string>();
	/**
	 * A page that has to be loaded again: one of the files it is made of changed on disk. The
	 * page and not the folder, because a session serves every page of one folder — and a
	 * stylesheet of the page opened an hour ago is not part of the one on screen now.
	 */
	public readonly onDidChange = this._onDidChange.event;
	private _disposed = false;

	public dispose(): void {
		this._disposed = true;
		for (const watcher of this._watchers.values()) {
			watcher.dispose();
		}
		this._watchers.clear();
		this._pages.clear();
		this._onDidChange.dispose();
	}

	/**
	 * `referrer` is the file that asked for this one, read off the request's `Referer`.
	 *
	 * What is recorded is the *pages* the file is part of, and those are the pages its referrer
	 * is part of: a stylesheet that `@import`s another one is not a page, so a change to the
	 * imported file has to name the page that pulls the chain in — the panel reloads pages, and
	 * knows nothing of what they are made of. A file nobody asked for is a page in its own
	 * right (the navigation the panel just made), and an html file always is one as well, since
	 * a page that links to another is the referrer of that navigation, not what it renders.
	 */
	public remember(filePath: string, referrer?: string): void {
		if (this._disposed) {
			return;
		}

		const pages = new Set<string>(referrer
			// A referrer nothing is recorded for stands for itself — a file that was never
			// served, which is a request no page of ours made.
			? this._pages.get(referrer) ?? [referrer]
			: [filePath]);
		if (isHtmlPath(filePath)) {
			pages.add(filePath);
		}

		let known = this._pages.get(filePath);
		if (!known) {
			known = new Set<string>();
			this._pages.set(filePath, known);
			this._watch(path.dirname(filePath));
		}
		for (const page of pages) {
			known.add(page);
		}
	}

	private _watch(folder: string): void {
		if (this._watchers.has(folder)) {
			return;
		}
		try {
			// `*` and not `**/*`: a recursive watcher over a project the panel happens to have
			// opened one file from is a lot of work for the two or three folders a page uses.
			const watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(vscode.Uri.file(folder), '*'));
			const changed = (uri: vscode.Uri) => {
				for (const page of this._pages.get(uri.fsPath) ?? []) {
					this._onDidChange.fire(page);
				}
			};
			watcher.onDidChange(changed);
			watcher.onDidCreate(changed);
			watcher.onDidDelete(changed);
			this._watchers.set(folder, watcher);
		} catch {
			// No watcher then, and saving the file is a manual reload.
		}
	}
}

/** Content types for what a page loads. Anything else is served as bytes. */
const contentTypes: Readonly<Record<string, string>> = {
	'.html': 'text/html; charset=utf-8',
	'.htm': 'text/html; charset=utf-8',
	'.xhtml': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.cjs': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.txt': 'text/plain; charset=utf-8',
	'.md': 'text/markdown; charset=utf-8',
	'.csv': 'text/csv; charset=utf-8',
	'.xml': 'text/xml; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.ico': 'image/x-icon',
	'.bmp': 'image/bmp',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.eot': 'application/vnd.ms-fontobject',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.ogv': 'video/ogg',
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
	'.ogg': 'audio/ogg',
	'.wasm': 'application/wasm',
	'.pdf': 'application/pdf',
	'.zip': 'application/zip',
};

export function contentTypeOf(filePath: string): string {
	return contentTypes[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function trimTrailingSlash(value: string): string {
	return value.endsWith('/') ? value.slice(0, -1) : value;
}

function trimTrailingSeparator(value: string): string {
	return value.length > 1 && value.endsWith(path.sep) ? value.slice(0, -1) : value;
}
