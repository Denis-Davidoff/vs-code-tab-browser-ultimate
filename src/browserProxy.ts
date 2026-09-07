/*---------------------------------------------------------------------------------------------
 *  A tiny reverse proxy used to make the previewed page inspectable.
 *
 *  Tab Browser Ultimate renders the target page inside an `<iframe>`. That document is a
 *  different origin than the webview, so its DOM can never be touched from the webview
 *  itself. To let the toolbar inspect the page we serve the page through this proxy, which
 *  injects the page agent script into every HTML response. The injected script talks back to the
 *  webview with `postMessage`, which *is* allowed cross-origin.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as stream from 'stream';
import * as zlib from 'zlib';
import * as vscode from 'vscode';
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
	/** Origin of the real server, e.g. `http://localhost:5173`. */
	readonly origin: string;
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
	private _agentScript?: Promise<Buffer>;

	constructor(
		private readonly _extensionUri: vscode.Uri,
	) {
		super();
	}

	public override dispose(): void {
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

	private async _getSession(origin: string): Promise<ProxySession> {
		const existing = this._sessions.get(origin);
		if (existing) {
			return existing;
		}

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

		const session: ProxySession = {
			origin,
			cookiePrefix: `__tb${localPort}_`,
			server,
			localPort,
			publicOrigin: `http://127.0.0.1:${localPort}`,
			sockets,
		};

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

		this._sessions.set(origin, session);
		return session;
	}

	private _closeSession(session: ProxySession): void {
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

		const target = new URL(req.url ?? '/', session.origin);
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
		if (!isHtmlResponse(proxyRes)) {
			res.writeHead(status, proxyRes.statusMessage, headers);
			// The headers are out, so there is no error page left to send: just tear the
			// exchange down. Without this an upstream reset is an unhandled `error` event.
			proxyRes.on('error', () => res.destroy());
			res.on('close', () => proxyRes.destroy());
			proxyRes.pipe(res);
			return;
		}

		const body = await decodeBody(proxyRes);
		const html = this._injectAgentScript(session, body.toString('utf8'));
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

	private _forward(session: ProxySession, req: http.IncomingMessage, target: URL): Promise<http.IncomingMessage> {
		const headers = this._rewriteRequestHeaders(session, req.headers, target);
		const transport = target.protocol === 'https:' ? https : http;

		return new Promise((resolve, reject) => {
			const proxyReq = transport.request({
				protocol: target.protocol,
				hostname: target.hostname,
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
		// Absolute references to the real origin would escape the proxy.
		let result = html.split(session.origin).join(session.publicOrigin);

		// Meta CSP would block the injected script just like the header would.
		result = result.replace(
			/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy(-report-only)?["']?[^>]*>/gi,
			'');

		const config = JSON.stringify({
			realOrigin: session.origin,
			cookiePrefix: session.cookiePrefix,
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
		const target = new URL(req.url ?? '/', session.origin);
		const headers = this._rewriteRequestHeaders(session, req.headers, target);
		delete headers['accept-encoding'];
		const transport = target.protocol === 'https:' ? https : http;

		const proxyReq = transport.request({
			protocol: target.protocol,
			hostname: target.hostname,
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

async function decodeBody(res: http.IncomingMessage): Promise<Buffer> {
	const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase().trim();
	const decoder = encoding === 'gzip' || encoding === 'x-gzip'
		? zlib.createGunzip()
		: encoding === 'deflate'
			? zlib.createInflate()
			: encoding === 'br'
				? zlib.createBrotliDecompress()
				: undefined;

	const source: stream.Readable = decoder ? res.pipe(decoder) : res;
	const chunks: Buffer[] = [];
	for await (const chunk of source) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

/** `Set-Cookie` from an https origin must still work over the proxy's plain http. */
function rewriteSetCookie(cookie: string, prefix: string): string {
	return prefixCookie(cookie, prefix)
		.split(';')
		.filter(part => {
			const name = part.trim().toLowerCase();
			return !name.startsWith('domain=')
				&& name !== 'secure'
				&& name !== 'partitioned';
		})
		.map(part => (/^\s*samesite\s*=\s*none\s*$/i.test(part) ? ' SameSite=Lax' : part))
		.join(';');
}

/** `sid=1; Path=/` -> `__tb54321_sid=1; Path=/`. Shared with the page, which hides it again. */
export function prefixCookie(cookie: string, prefix: string): string {
	const separator = cookie.indexOf('=');
	if (separator === -1) {
		return cookie;
	}
	const name = cookie.slice(0, separator).trim();
	if (!name || name.startsWith(prefix)) {
		return cookie;
	}
	return `${prefix}${name}=${cookie.slice(separator + 1)}`;
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
			<h2>${escapeHtml(vscode.l10n.t("Could not reach {0}", session.origin))}</h2>
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
