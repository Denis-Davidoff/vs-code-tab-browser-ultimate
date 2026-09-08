import * as fs from 'node:fs/promises';
import { watch } from 'node:fs';
import * as path from 'node:path';

export const l10n = { t: (msg, ...args) => msg.replace(/\{(\d+)\}/g, (_, i) => args[i]) };

/**
 * Enough of `Uri` for the proxy, which needs the `file:` half of it for real: a file session is
 * keyed by the url of the folder it serves, and reports every page under it by url as well.
 */
class Uri {
	constructor(scheme, uriPath, rest = '') {
		this.scheme = scheme;
		this.path = uriPath;
		this._rest = rest;
	}

	static parse(value) {
		const match = /^([a-z][a-z0-9+.-]*):(\/\/[^/?#]*)?([^?#]*)(.*)$/i.exec(value);
		if (!match) { return new Uri('', value); }
		const [, scheme, , uriPath, rest] = match;
		const uri = new Uri(scheme.toLowerCase(), decodeSafely(uriPath), rest);
		uri._raw = value;
		return uri;
	}

	static file(p) {
		let uriPath = p.replace(/\\/g, '/');
		// A drive letter is part of the path, lower-cased, and the path always starts at root.
		if (/^[a-zA-Z]:/.test(uriPath)) { uriPath = uriPath[0].toLowerCase() + uriPath.slice(1); }
		if (!uriPath.startsWith('/')) { uriPath = `/${uriPath}`; }
		return new Uri('file', uriPath);
	}

	static joinPath(base, ...parts) { return Uri.file(path.join(base.fsPath, ...parts)); }

	/** `skipEncoding` leaves everything but what would end the path, as the editor's does. */
	toString(skipEncoding) {
		if (this._raw && this.scheme !== 'file') { return this._raw; }
		const encoded = skipEncoding
			? this.path.replace(/[?#]/g, character => encodeURIComponent(character))
			: encodeURI(this.path).replace(/[?#:]/g, character => encodeURIComponent(character))
				.replace(/^%2F/, '/').replace(/\/%3A/g, ':');
		return this.scheme === 'file'
			? `file://${skipEncoding ? encoded : encoded.replace(/^\/([a-z]):/, '/$1%3A')}${this._rest}`
			: (this._raw ?? `${this.scheme}:${this.path}`);
	}

	/** The two halves that belong to the page rather than to the file. */
	get query() {
		const match = /\?([^#]*)/.exec(this._rest ?? '');
		return match ? decodeSafely(match[1]) : '';
	}

	get fragment() {
		const match = /#(.*)$/.exec(this._rest ?? '');
		return match ? decodeSafely(match[1]) : '';
	}

	get fsPath() {
		// Posix, which is what the tests run on; a windows drive letter keeps its slashes here.
		return this.path;
	}
}

function decodeSafely(value) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

export { Uri };

export class RelativePattern {
	constructor(base, pattern) {
		this.base = base;
		this.pattern = pattern;
	}
}

export const env = { asExternalUri: async uri => uri };

/** Whatever the proxy logs when the setting is on; the mock's configuration keeps it off. */
export const window = {
	createOutputChannel: () => ({ appendLine() { }, dispose() { } }),
};

/** The proxy publishes one event, for the origins it has started serving. */
export class EventEmitter {
	constructor() {
		this._listeners = new Set();
		this.event = listener => {
			this._listeners.add(listener);
			return { dispose: () => this._listeners.delete(listener) };
		};
	}
	fire(value) { for (const listener of [...this._listeners]) { listener(value); } }
	dispose() { this._listeners.clear(); }
}

export const workspace = {
	fs: { readFile: async uri => new Uint8Array(await fs.readFile(uri.fsPath)) },
	getConfiguration: () => ({ get: (key, fallback) => fallback }),
	getWorkspaceFolder: () => undefined,
	/**
	 * A real watcher, because what the hot reload has to get right is *which* files a page is
	 * reloaded for — and a stub that never fires cannot say whether it got that right.
	 */
	createFileSystemWatcher: (pattern) => {
		const listeners = { change: new Set(), create: new Set(), delete: new Set() };
		const watcher = watch(pattern.base.fsPath, (event, name) => {
			if (!name) { return; }
			const uri = Uri.file(path.join(pattern.base.fsPath, name));
			for (const listener of listeners[event === 'rename' ? 'create' : 'change']) {
				listener(uri);
			}
		});
		watcher.on('error', () => { });
		const on = kind => listener => {
			listeners[kind].add(listener);
			return { dispose: () => listeners[kind].delete(listener) };
		};
		return {
			onDidChange: on('change'),
			onDidCreate: on('create'),
			onDidDelete: on('delete'),
			dispose: () => watcher.close(),
		};
	},
};
