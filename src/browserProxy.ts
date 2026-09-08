/*---------------------------------------------------------------------------------------------
 *  A tiny reverse proxy used to make the previewed page inspectable.
 *
 *  Tab Browser Ultimate renders the target page inside an `<iframe>`. That document is a
 *  different origin than the webview, so its DOM can never be touched from the webview
 *  itself. To let the toolbar inspect the page we serve the page through this proxy, which
 *  injects the page agent script into every HTML response. The injected script talks back to the
 *  webview with `postMessage`, which *is* allowed cross-origin.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as stream from 'stream';
import * as zlib from 'zlib';
import * as vscode from 'vscode';
import { rewriteSetCookie } from '../shared/cookies';
import {
	contentTypeOf,
	isHtmlPath,
	isUnder,
	newServedFolder,
	realUrlOf,
	ServedFiles,
	ServedFolder,
	servedPathOf,
	servedUrlOf,
} from './fileSession';
import { Disposable } from './dispose';

/** Path on the proxy that serves the injected page agent script. */
const agentScriptPath = '/__tab-browser__/agent.js';

/** Response headers that would stop us from framing or instrumenting the page. */
const strippedResponseHeaders = [
	'content-security-policy',
	'content-security-policy-report-only',
	'x-frame-options',
	'cross-origin-opener-policy',
	'cross-origin-embedder-policy',
	'cross-origin-resource-policy',
	'permissions-policy',
	'report-to',
	'reporting-endpoints',
	'x-webkit-csp',
	'x-content-security-policy',
];

interface ProxySession {
	/**
	 * Origin of the real server, e.g. `http://localhost:5173` — and for a session serving the
	 * disk, the `file:` url of the folder it serves. It is what the session is keyed by, so one
	 * folder gets one session however many of its pages are opened.
	 */
	readonly origin: string;
	/**
	 * Set on a session that answers out of a folder instead of forwarding to a server. Such a
	 * session shares the injection, the port and the error page with the others, and none of
	 * the forwarding: there is nothing upstream of it.
	 */
	readonly file?: {
		readonly folder: ServedFolder;
		/** What it has served, so that saving one of those files reloads the panel. */
		readonly files: ServedFiles;
	};
	/**
	 * Prefix every cookie of this session carries while it is in the browser. Cookie jars are
	 * not separated by port, so two proxied sites on the same loopback host would otherwise
	 * read and overwrite each other's cookies — `HttpOnly` ones included, which a page cannot
	 * even see, but the browser would still send to the wrong server.
	 */
	readonly cookiePrefix: string;
	readonly server: http.Server;
	readonly localPort: number;
	/**
	 * Origin the webview should use. Normally `http://127.0.0.1:<localPort>`, but on remote
	 * setups `asExternalUri` turns it into a forwarded tunnel address.
	 */
	publicOrigin: string;
	/** Live sockets, so that `dispose` does not wait for keep-alive connections. */
	readonly sockets: Set<net.Socket>;
}

export class ProxyError extends Error { }

export class BrowserProxy extends Disposable {

	private readonly _sessions = new Map<string, ProxySession>();
	/**
	 * Sessions still starting, by origin. Two navigations to one origin can arrive before
	 * either has a port — the panel's own load and an mcp client's, say — and each would then
	 * start a server of its own, with only the last one reachable and the rest left listening
	 * past `dispose`.
	 */
	private readonly _starting = new Map<string, Promise<ProxySession>>();
	private _agentScript?: Promise<Buffer>;
	private _disposed = false;

	private readonly _onDidChangeOrigins = this._register(new vscode.EventEmitter<void>());
	/** A session has appeared, so the set of origins that can hold our agent has grown. */
	public readonly onDidChangeOrigins = this._onDidChangeOrigins.event;

	private readonly _onDidChangeServedFile = this._register(new vscode.EventEmitter<string>());
	/**
	 * A file one of the file sessions has served was changed on disk; the value is the folder
	 * that session serves. The panel reloads for it, which is all the hot reload a page off the
	 * disk can have — there is no dev server in front of it to do anything cleverer.
	 */
	public readonly onDidChangeServedFile = this._onDidChangeServedFile.event;

	constructor(
		private readonly _extensionUri: vscode.Uri,
	) {
		super();
	}

	public override dispose(): void {
		this._disposed = true;
		for (const session of this._sessions.values()) {
			this._closeSession(session);
		}
		this._sessions.clear();
		super.dispose();
	}

	/**
	 * Returns the url the webview should load in order to get an instrumented version of
	 * `rawUrl`, starting a proxy for the target origin if needed.
	 */
	public async getProxiedUrl(rawUrl: string): Promise<string> {
		const target = parseHttpUrl(rawUrl);
		if (!target) {
			throw new ProxyError(vscode.l10n.t("Only http and https urls can be inspected."));
		}

		const session = await this._getSession(originOf(target));
		return joinOrigin(session.publicOrigin, target.pathname + target.search + target.hash);
	}

	/**
	 * Returns the url the webview should load in order to see `fileUri`, which is served from
	 * the folder it belongs to: the workspace folder that holds it, or its own folder when it
	 * belongs to no project. Nothing outside that folder is reachable, so a page can pull in
	 * the project's stylesheets and scripts and nothing else.
	 */
	public async getServedFileUrl(fileUri: vscode.Uri): Promise<string> {
		if (fileUri.scheme !== 'file') {
			throw new ProxyError(vscode.l10n.t("Only local files can be opened from disk."));
		}

		const filePath = fileUri.fsPath;
		// `file:///` names no file, and a session for it would be rooted at the whole disk.
		if (!path.basename(filePath)) {
			throw new ProxyError(vscode.l10n.t("{0} names no file to open.", filePath));
		}

		const root = this._rootFor(fileUri);
		const session = await this._getSession(vscode.Uri.file(root).toString(), root);
		const served = servedUrlOf(session.file!.folder, session.publicOrigin, filePath);

		// The query and the fragment are the page's: a local page reads its own `?lang=ru`, and
		// `#section` is where it is meant to open.
		return served
			+ (fileUri.query ? `?${fileUri.query}` : '')
			+ (fileUri.fragment ? `#${fileUri.fragment}` : '');
	}

	/** The folder a file is served from: its project, or the folder it sits in. */
	private _rootFor(fileUri: vscode.Uri): string {
		const folder = vscode.workspace.getWorkspaceFolder?.(fileUri);
		return folder?.uri.scheme === 'file' ? folder.uri.fsPath : path.dirname(fileUri.fsPath);
	}

	/**
	 * The origins a page carrying the injected agent can be served from — every session's, since
	 * only a session serves that script. The webview needs them to tell an agent's message from
	 * a message the framed page wrote itself: a page cannot forge the `origin` of a
	 * `postMessage`, and anything a session injects into a page that page can read.
	 *
	 * Read out of `publicOrigin` rather than kept beside it, because on a remote workspace that
	 * is whatever `asExternalUri` handed back, which may carry a path.
	 */
	public origins(): string[] {
		const origins = new Set<string>();
		for (const session of this._sessions.values()) {
			const url = parseHttpUrl(session.publicOrigin);
			if (url) {
				origins.add(originOf(url));
			}
		}
		return [...origins];
	}

	/** True if `rawUrl` is already served by one of our proxies. */
	public isProxiedUrl(rawUrl: string): boolean {
		return !!this._findSessionForUrl(rawUrl);
	}

	/** Maps a proxied url back to the url of the real server, for display purposes. */
	public toRealUrl(rawUrl: string): string {
		const session = this._findSessionForUrl(rawUrl);
		if (!session) {
			return rawUrl;
		}
		const url = parseHttpUrl(rawUrl)!;
		if (session.file) {
			// The path carries a segment that belongs to the session and not to the page, so
			// the file itself is the only honest answer here.
			return realUrlOf(session.file.folder, url.pathname + url.search + url.hash) ?? rawUrl;
		}
		return joinOrigin(session.origin, url.pathname + url.search + url.hash);
	}

	private _findSessionForUrl(rawUrl: string): ProxySession | undefined {
		const url = parseHttpUrl(rawUrl);
		if (!url) {
			return undefined;
		}
		const origin = originOf(url);
		for (const session of this._sessions.values()) {
			if (session.publicOrigin === origin) {
				return session;
			}
		}
		return undefined;
	}

	private _getSession(origin: string, fileRoot?: string): Promise<ProxySession> {
		const existing = this._sessions.get(origin);
		if (existing) {
			return Promise.resolve(existing);
		}

		// Claimed before the first `await`, so a second caller waits for this server instead of
		// starting another one.
		const starting = this._starting.get(origin)
			?? this._startSession(origin, fileRoot).finally(() => this._starting.delete(origin));
		this._starting.set(origin, starting);
		return starting;
	}

	private async _startSession(origin: string, fileRoot?: string): Promise<ProxySession> {
		const sockets = new Set<net.Socket>();
		const server = http.createServer();
		server.on('connection', socket => {
			sockets.add(socket);
			socket.on('close', () => sockets.delete(socket));
		});

		const localPort = await new Promise<number>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => {
				const address = server.address();
				if (address && typeof address === 'object') {
					resolve(address.port);
				} else {
					reject(new ProxyError(vscode.l10n.t("Could not start the local proxy server.")));
				}
			});
		});

		// The folder with its own symlinks resolved, since that is what a served file's real
		// path has to sit under: `/tmp` is a link to `/private/tmp` on macOS, and comparing a
		// resolved path against an unresolved root refuses every file in it.
		const realRoot = fileRoot
			? await fsp.realpath(fileRoot).catch(() => fileRoot)
			: undefined;
		const file = fileRoot
			? { folder: newServedFolder(fileRoot, realRoot), files: new ServedFiles() }
			: undefined;
		const session: ProxySession = {
			origin,
			file,
			cookiePrefix: `__tb${localPort}_`,
			server,
			localPort,
			publicOrigin: `http://127.0.0.1:${localPort}`,
			sockets,
		};
		file?.files.onDidChange(page => this._onDidChangeServedFile.fire(page));

		// On remote workspaces the webview cannot reach the extension host's loopback
		// interface directly, so ask vscode to forward the port for us.
		try {
			const external = await vscode.env.asExternalUri(vscode.Uri.parse(session.publicOrigin));
			session.publicOrigin = trimTrailingSlash(external.toString(true));
		} catch {
			// Keep the loopback address.
		}

		server.on('request', (req, res) => {
			this._handleRequest(session, req, res).catch(error => {
				writeErrorResponse(res, session, error);
			});
		});
		server.on('upgrade', (req, socket, head) => {
			this._handleUpgrade(session, req, socket as net.Socket, head);
		});
		server.on('error', () => { /* Reported per request instead. */ });

		if (this._disposed) {
			// Disposed while this was listening; nothing will ever close it otherwise.
			this._closeSession(session);
			throw new ProxyError(vscode.l10n.t("The browser panel was closed."));
		}

		this._sessions.set(origin, session);
		this._onDidChangeOrigins.fire();
		return session;
	}

	private _closeSession(session: ProxySession): void {
		session.file?.files.dispose();
		for (const socket of session.sockets) {
			socket.destroy();
		}
		session.sockets.clear();
		session.server.close();
	}

	private async _handleRequest(session: ProxySession, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		if (req.url && req.url.split('?')[0] === agentScriptPath) {
			const script = await this._getAgentScript();
			res.writeHead(200, {
				'content-type': 'text/javascript; charset=utf-8',
				'cache-control': 'no-store',
				'content-length': script.byteLength,
			});
			res.end(script);
			return;
		}

		if (session.file) {
			await this._serveFile(session, req, res);
			return;
		}

		const target = targetOf(session, req.url);
		const proxyRes = await this._forward(session, req, target);

		const headers = { ...proxyRes.headers };
		for (const header of strippedResponseHeaders) {
			delete headers[header];
		}

		if (typeof headers.location === 'string') {
			headers.location = await this._rewriteLocation(session, headers.location, target);
		}
		if (headers['set-cookie']) {
			headers['set-cookie'] = asArray(headers['set-cookie'])
				.map(cookie => rewriteSetCookie(cookie, session.cookiePrefix));
		}

		const status = proxyRes.statusCode ?? 502;
		if (req.method === 'HEAD' || status === 204 || status === 205 || status === 304
			|| !isHtmlResponse(proxyRes)) {
			res.writeHead(status, proxyRes.statusMessage, headers);
			// The headers are out, so there is no error page left to send: just tear the
			// exchange down. Without this an upstream reset is an unhandled `error` event.
			proxyRes.on('error', () => res.destroy());
			res.on('close', () => proxyRes.destroy());
			proxyRes.pipe(res);
			return;
		}

		const body = await decodeBody(proxyRes);
		const html = this._injectAgentScript(session, decodeHtml(body, String(headers['content-type'] ?? '')));
		headers['content-type'] = 'text/html; charset=utf-8';
		const buffer = Buffer.from(html, 'utf8');

		delete headers['content-encoding'];
		delete headers['content-length'];
		delete headers['transfer-encoding'];
		headers['content-length'] = String(buffer.byteLength);
		// The page is rewritten on the fly, so never let anything cache it.
		headers['cache-control'] = 'no-store';
		delete headers.etag;
		delete headers['last-modified'];

		res.writeHead(status, proxyRes.statusMessage, headers);
		res.end(buffer);
	}

	/**
	 * Answers out of the session's folder. Html is instrumented exactly as a server's would be;
	 * everything else is streamed. Nothing is cached, since the point of serving a file rather
	 * than framing it is that saving it shows up.
	 */
	private async _serveFile(
		session: ProxySession,
		req: http.IncomingMessage,
		res: http.ServerResponse,
	): Promise<void> {
		const file = session.file!;
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			writeFileStatus(res, 405, vscode.l10n.t("A file can only be read."));
			return;
		}

		// Which page asked for this. Only a document this session served can be on this origin,
		// and a page on another origin cannot claim to be — so a request that carries such a
		// `Referer` is one of our own pages asking, which is what makes the root-absolute
		// references a build writes (`/assets/app.js`) resolvable at all.
		const referer = typeof req.headers.referer === 'string'
			? parseHttpUrl(req.headers.referer)
			: undefined;
		// A page addressed as a folder was served the index inside it, and that is the page its
		// assets belong to: read as the folder, the reload would name something the panel is
		// not showing and a save would go unnoticed.
		const refererPath = referer?.pathname.endsWith('/')
			? `${referer.pathname}index.html`
			: referer?.pathname;
		const fromPage = referer && this._isOwnOrigin(session, originOf(referer))
			? servedPathOf(file.folder, refererPath)
			: undefined;
		const referrer = fromPage && 'path' in fromPage ? fromPage.path : undefined;

		const served = servedPathOf(file.folder, req.url, !!referrer);
		if ('status' in served) {
			writeFileStatus(res, served.status, served.status === 403
				? vscode.l10n.t("That path is outside {0}.", file.folder.root)
				: vscode.l10n.t("Not found."));
			return;
		}

		// Vouched for by the page that asked, and now put on a url that says so itself. Serving
		// it under the bare path instead would answer this one request and break every request
		// that file makes in turn: `import './dep.js'` is resolved against the module's own
		// url, and a url with no segment of ours in it is one nothing can vouch for — the
		// referrer of *that* request would be the bare path again.
		if (served.fromReferer) {
			const raw = req.url?.startsWith('/') ? req.url : `/${req.url ?? ''}`;
			res.writeHead(301, {
				location: `/${file.folder.secret}${raw}`,
				'cache-control': 'no-store',
			});
			res.end();
			return;
		}

		let target = served.path;
		let stat = await fsp.stat(target).catch(() => undefined);
		if (stat?.isDirectory()) {
			const requested = (req.url ?? '/').split('#')[0];
			const [withoutQuery, query] = splitQuery(requested);
			// A static server redirects first, and the redirect is the point: without the
			// trailing slash the page's own `href="style.css"` resolves against the folder
			// *above* this one, and every relative reference on it 404s.
			if (!withoutQuery.endsWith('/')) {
				res.writeHead(301, {
					location: `${withoutQuery}/${query}`,
					'cache-control': 'no-store',
				});
				res.end();
				return;
			}
			// What a static server does with a folder, and what a `file:` url cannot do at all.
			target = path.join(target, 'index.html');
			stat = await fsp.stat(target).catch(() => undefined);
		}
		if (!stat?.isFile()) {
			writeFileStatus(res, 404, vscode.l10n.t("{0} is not a file.", target));
			return;
		}

		// The check above is about the request; this one is about the file it names. A link
		// inside the folder that points out of it would otherwise be a read of whatever it
		// points at, which is the one way a path that never leaves the folder still can.
		const real = await fsp.realpath(target).catch(() => undefined);
		if (!real || !isUnder(file.folder.realRoot, real)) {
			writeFileStatus(res, 403, vscode.l10n.t(
				"{0} leads outside {1}.", target, file.folder.root));
			return;
		}
		// Read, watched and reported under the path it was asked for, not under the resolved
		// one: the panel's address bar, the reports and the reload all speak in the former, and
		// a folder reached through a link — `/tmp` on macOS — resolves to a different name.

		// Watched from here rather than from the navigation: a page's stylesheets and scripts
		// are exactly the files it asked for, and nothing else in the project is.
		file.files.remember(target, referrer);

		if (isHtmlPath(target)) {
			const html = this._injectAgentScript(session, decodeHtml(await fsp.readFile(target), ''));
			const buffer = Buffer.from(html, 'utf8');
			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store',
				'content-length': buffer.byteLength,
			});
			res.end(req.method === 'HEAD' ? undefined : buffer);
			return;
		}

		res.writeHead(200, {
			'content-type': contentTypeOf(target),
			'cache-control': 'no-store',
			'content-length': stat.size,
		});
		if (req.method === 'HEAD') {
			res.end();
			return;
		}

		const stream = fs.createReadStream(target);
		stream.on('error', () => res.destroy());
		res.on('close', () => stream.destroy());
		stream.pipe(res);
	}

	private _forward(session: ProxySession, req: http.IncomingMessage, target: URL): Promise<http.IncomingMessage> {
		const headers = this._rewriteRequestHeaders(session, req.headers, target);
		const transport = target.protocol === 'https:' ? https : http;

		return new Promise((resolve, reject) => {
			const proxyReq = transport.request({
				protocol: target.protocol,
				hostname: hostnameOf(target),
				port: target.port || (target.protocol === 'https:' ? 443 : 80),
				path: target.pathname + target.search,
				method: req.method,
				headers,
				rejectUnauthorized: !getConfiguration().get<boolean>('proxy.ignoreCertificateErrors', true),
				setHost: false,
			}, resolve);

			proxyReq.on('error', reject);
			req.on('aborted', () => proxyReq.destroy());
			req.pipe(proxyReq);
		});
	}

	private _rewriteRequestHeaders(
		session: ProxySession,
		original: http.IncomingHttpHeaders,
		target: URL,
	): http.OutgoingHttpHeaders {
		const headers: http.OutgoingHttpHeaders = { ...original };

		// Dev servers such as Vite reject requests whose `Host` is not one of their known
		// hosts, so always present ourselves as the real server.
		headers.host = target.host;
		// We rewrite html, so we must be able to read it.
		headers['accept-encoding'] = 'identity';
		// Conditional requests would give us a 304 with no body to instrument.
		delete headers['if-none-match'];
		delete headers['if-modified-since'];

		// Only this session's cookies may reach this session's server.
		const cookies = typeof original.cookie === 'string'
			? ownCookies(original.cookie, session.cookiePrefix)
			: undefined;
		if (cookies) {
			headers.cookie = cookies;
		} else {
			delete headers.cookie;
		}

		// Make the upstream server see same-origin requests.
		const referer = original.referer;
		if (typeof referer === 'string') {
			headers.referer = this._toRealOrigin(session, referer);
		}

		const origin = original.origin;
		if (typeof origin === 'string') {
			if (this._isOwnOrigin(session, origin)) {
				// The page and this subresource live on the same origin as far as the upstream
				// server is concerned, and a browser talking to it directly would send no
				// `Origin` at all. Forwarding a rewritten one makes the request look
				// cross-origin: VS Code's Live Preview, for one, answers 401 to anything that
				// carries an `Origin` header. Chromium does send it for same-origin module
				// scripts, so this would break every `<script type="module">` on such a server.
				delete headers.origin;
			} else {
				headers.origin = this._toRealOrigin(session, origin);
			}
		}

		return headers;
	}

	/** True if `value`'s origin is this proxy, i.e. the request came from a page we serve. */
	private _isOwnOrigin(session: ProxySession, value: string): boolean {
		return value === session.publicOrigin
			|| value === `http://127.0.0.1:${session.localPort}`;
	}

	private _toRealOrigin(session: ProxySession, value: string): string {
		return value
			.replace(session.publicOrigin, session.origin)
			.replace(`http://127.0.0.1:${session.localPort}`, session.origin);
	}

	private async _rewriteLocation(session: ProxySession, location: string, base: URL): Promise<string> {
		let resolved: URL;
		try {
			// Relative against the request, not the origin: `Location: login` answered for
			// `/account/start` means `/account/login`.
			resolved = new URL(location, base);
		} catch {
			return location;
		}

		const path = resolved.pathname + resolved.search + resolved.hash;
		if (originOf(resolved) === session.origin) {
			// Stay on the proxy by keeping the redirect relative.
			return path;
		}

		if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
			return location;
		}

		// Redirected to another origin: proxy that one too so the page stays inspectable.
		const other = await this._getSession(originOf(resolved));
		return joinOrigin(other.publicOrigin, path);
	}

	private _injectAgentScript(session: ProxySession, html: string): string {
		// What the page's own urls are relative to, and what this session answers them under.
		// For a file session the two differ by more than the origin: everything it serves sits
		// under a path segment that belongs to the session and not to the page.
		const realBase = session.file
			? trimTrailingSlash(vscode.Uri.file(session.file.folder.root).toString(true))
			: session.origin;
		const publicBase = session.file
			? `${session.publicOrigin}/${session.file.folder.secret}`
			: session.publicOrigin;

		// Absolute references to the real origin would escape the proxy.
		let result = html.split(realBase).join(publicBase);

		// Meta CSP would block the injected script just like the header would.
		result = result.replace(
			/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy(-report-only)?["']?[^>]*>/gi,
			'');

		const config = JSON.stringify({
			realOrigin: realBase,
			cookiePrefix: session.cookiePrefix,
			// Told to the page rather than worked out by it: only this session knows which
			// part of the path is its own.
			basePath: session.file ? `/${session.file.folder.secret}` : undefined,
		});
		const bootstrap = `<script data-tab-browser="bootstrap">window.__tabBrowserConfig=${escapeScriptContent(config)};</script>`
			+ `<script data-tab-browser="script" src="${agentScriptPath}"></script>`;

		const headMatch = /<head\b[^>]*>/i.exec(result);
		if (headMatch) {
			const at = headMatch.index + headMatch[0].length;
			return result.slice(0, at) + bootstrap + result.slice(at);
		}

		const htmlMatch = /<html\b[^>]*>/i.exec(result);
		if (htmlMatch) {
			const at = htmlMatch.index + htmlMatch[0].length;
			return result.slice(0, at) + bootstrap + result.slice(at);
		}

		return bootstrap + result;
	}

	private _handleUpgrade(session: ProxySession, req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
		if (session.file) {
			// There is nothing upstream of a folder to upgrade to.
			socket.destroy();
			return;
		}
		const target = targetOf(session, req.url);
		const headers = this._rewriteRequestHeaders(session, req.headers, target);
		delete headers['accept-encoding'];
		const transport = target.protocol === 'https:' ? https : http;

		const proxyReq = transport.request({
			protocol: target.protocol,
			hostname: hostnameOf(target),
			port: target.port || (target.protocol === 'https:' ? 443 : 80),
			path: target.pathname + target.search,
			method: req.method,
			headers,
			rejectUnauthorized: !getConfiguration().get<boolean>('proxy.ignoreCertificateErrors', true),
			setHost: false,
		});

		proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
			const statusLine = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}`;
			const rawHeaders: string[] = [];
			for (const [key, value] of Object.entries(proxyRes.headers)) {
				for (const item of asArray(value ?? '')) {
					rawHeaders.push(`${key}: ${item}`);
				}
			}
			socket.write(`${statusLine}\r\n${rawHeaders.join('\r\n')}\r\n\r\n`);

			if (proxyHead?.length) {
				proxySocket.unshift(proxyHead);
			}
			proxySocket.on('error', () => socket.destroy());
			socket.on('error', () => proxySocket.destroy());
			proxySocket.pipe(socket).pipe(proxySocket);
		});

		proxyReq.on('response', proxyRes => {
			// Upstream refused to upgrade. Relay the plain response and close.
			socket.write(`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n\r\n`);
			proxyRes.pipe(socket);
		});

		proxyReq.on('error', () => socket.destroy());
		socket.on('error', () => proxyReq.destroy());

		if (head?.length) {
			proxyReq.write(head);
		}
		proxyReq.end();
	}

	private _getAgentScript(): Promise<Buffer> {
		this._agentScript ??= (async () => {
			const uri = vscode.Uri.joinPath(this._extensionUri, 'media', 'agent.js');
			return Buffer.from(await vscode.workspace.fs.readFile(uri));
		})();
		return this._agentScript;
	}
}

export function getConfiguration(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration('tabBrowser');
}

export function parseHttpUrl(rawUrl: string): URL | undefined {
	try {
		const url = new URL(rawUrl);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
	} catch {
		return undefined;
	}
}

const localHostnames = new Set([
	'localhost',
	'127.0.0.1',
	'0.0.0.0',
	'[::1]',
	'[::]',
	'::1',
]);

export function isLocalUrl(url: URL): boolean {
	const hostname = url.hostname.toLowerCase();
	return localHostnames.has(hostname)
		|| hostname.endsWith('.localhost')
		|| hostname.startsWith('192.168.')
		|| hostname.startsWith('10.');
}

function originOf(url: URL): string {
	return `${url.protocol}//${url.host}`;
}

/**
 * The host to connect to. `URL` keeps an ipv6 literal in the brackets that separate it from the
 * port — `[::1]` — and `http.request` would look that up as a name, so a dev server on `[::1]`
 * answered `ENOTFOUND`. The `Host` header keeps the brackets, which is where they belong.
 */
export function hostnameOf(url: URL): string {
	return url.hostname.startsWith('[') && url.hostname.endsWith(']')
		? url.hostname.slice(1, -1)
		: url.hostname;
}

/**
 * Where a request received by a session goes: its own server, always.
 *
 * `req.url` is a request target, and one starting with `//` is a path like any other — but
 * resolved against the origin it reads as a host, so `//example.com/x` would be forwarded to
 * example.com, carrying this session's cookies (`HttpOnly` ones included) and its `Host`. The
 * path is therefore put on the session's origin rather than resolved against it.
 */
function targetOf(session: ProxySession, rawUrl: string | undefined): URL {
	const raw = rawUrl ?? '/';
	const target = new URL(session.origin);
	// A proxy may also be addressed in absolute form; only the path of it is ours to serve.
	const path = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
		? pathAndQueryOf(raw, session.origin)
		: raw.startsWith('/') ? raw : `/${raw}`;

	const query = path.indexOf('?');
	target.pathname = query === -1 ? path : path.slice(0, query);
	target.search = query === -1 ? '' : path.slice(query);
	return target;
}

/** `/docs?x=1` -> `['/docs', '?x=1']`, so a redirect can keep the query it was given. */
function splitQuery(requestTarget: string): [string, string] {
	const at = requestTarget.indexOf('?');
	return at === -1 ? [requestTarget, ''] : [requestTarget.slice(0, at), requestTarget.slice(at)];
}

function pathAndQueryOf(raw: string, base: string): string {
	try {
		const url = new URL(raw, base);
		return url.pathname + url.search;
	} catch {
		return '/';
	}
}

function joinOrigin(origin: string, pathAndQuery: string): string {
	return trimTrailingSlash(origin) + (pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`);
}

function trimTrailingSlash(value: string): string {
	return value.endsWith('/') ? value.slice(0, -1) : value;
}

function asArray<T>(value: T | T[]): T[] {
	return Array.isArray(value) ? value : [value];
}

function isHtmlResponse(res: http.IncomingMessage): boolean {
	return /\btext\/html\b/i.test(String(res.headers['content-type'] ?? ''));
}

/** Decode before rewriting; the response is then explicitly served as UTF-8. */
function decodeHtml(body: Buffer, contentType: string): string {
	const declared = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1];
	const head = body.subarray(0, 1024).toString('latin1');
	let meta: string | undefined;
	for (const tag of head.replace(/<!--[\s\S]*?(?:-->|$)/g, '').match(/<meta\b[^>]*>/gi) ?? []) {
		const attributes = new Map<string, string>();
		for (const match of tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
			attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4]);
		}
		meta = attributes.get('charset');
		if (!meta && attributes.get('http-equiv')?.toLowerCase() === 'content-type') {
			meta = /charset\s*=\s*([^\s;]+)/i.exec(attributes.get('content') ?? '')?.[1];
		}
		if (meta) { break; }
	}
	const bom = body[0] === 0xff && body[1] === 0xfe ? 'utf-16le'
		: body[0] === 0xfe && body[1] === 0xff ? 'utf-16be'
		: body.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 'utf-8' : undefined;
	try {
		return new TextDecoder(bom ?? declared ?? meta ?? 'utf-8').decode(body);
	} catch {
		return body.toString('utf8');
	}
}

async function decodeBody(res: http.IncomingMessage): Promise<Buffer> {
	const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase().trim();
	const decoder = encoding === 'gzip' || encoding === 'x-gzip'
		? zlib.createGunzip()
		: encoding === 'deflate'
			? zlib.createInflate()
			: encoding === 'br'
				? zlib.createBrotliDecompress()
				: undefined;

	if (!decoder) {
		return readAll(res);
	}

	// `pipe` does not pass an aborted response on to the decoder, which would then never end
	// and leave the read below waiting for a body that is not coming. `pipeline` destroys the
	// decoder with the error instead, so the request fails as one.
	stream.pipeline(res, decoder, () => { /* Reported to whoever is reading `decoder`. */ });
	return readAll(decoder);
}

async function readAll(source: stream.Readable): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of source) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

/** The cookies of this session, under the names the upstream server gave them. */
export function ownCookies(header: string, prefix: string): string | undefined {
	const mine: string[] = [];
	for (const part of header.split(';')) {
		const cookie = part.trim();
		if (cookie.startsWith(prefix)) {
			mine.push(cookie.slice(prefix.length));
		}
	}
	return mine.length ? mine.join('; ') : undefined;
}

/** Keeps an inline `<script>` from being terminated early by its own contents. */
function escapeScriptContent(json: string): string {
	return json.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
}

function writeErrorResponse(res: http.ServerResponse, session: ProxySession, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	if (res.headersSent) {
		res.end();
		return;
	}
	res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
	res.end(/* html */ `<!DOCTYPE html>
		<html><body style="font-family: sans-serif; padding: 2rem; color: #333">
			<h2>${escapeHtml(session.file
		? vscode.l10n.t("Could not read {0}", session.file.folder.root)
		: vscode.l10n.t("Could not reach {0}", session.origin))}</h2>
			<pre style="white-space: pre-wrap">${escapeHtml(message)}</pre>
		</body></html>`);
}

/** A refusal from a file session, in a page rather than a bare status. */
function writeFileStatus(res: http.ServerResponse, status: number, message: string): void {
	if (res.headersSent) {
		res.end();
		return;
	}
	res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
	res.end(/* html */ `<!DOCTYPE html>
		<html><body style="font-family: sans-serif; padding: 2rem; color: #333">
			<pre style="white-space: pre-wrap">${escapeHtml(message)}</pre>
		</body></html>`);
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
