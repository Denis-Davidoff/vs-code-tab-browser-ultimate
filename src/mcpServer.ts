/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as net from 'net';
import * as vscode from 'vscode';
import { BrowserController } from './browserController';
import { generateUuid } from './uuid';
import {
	authorizeRequest, classifyClient, dispatch, initializeClientName, invalidRequest,
	invalidRequestReason, isNotification, normalisePath, number, parseError, schema, string,
	stringOrUndefined, numberOrUndefined,
	type Caller, type ClientKind, type DispatchContext, type Tool,
} from './mcpProtocol';

/**
 * Streamable HTTP transport for the MCP server, written by hand.
 *
 * The MCP SDK is not used on purpose: this needs a handful of methods over one
 * POST, and the SDK would be more surface area than the feature.
 */

const maxRequestBytes = 1024 * 1024;

/** How long after its last call an assistant still counts as active. Read on demand. */
const clientIdleMs = 10 * 60 * 1000;

/** Which assistants are currently calling the server. */
export interface ClientSet {
	readonly claude: boolean;
	readonly codex: boolean;
}

export class McpServer implements vscode.Disposable {

	private _server: http.Server | undefined;
	private _port: number | undefined;

	/**
	 * Live sockets, so {@link dispose} can tear them down.
	 *
	 * Without this a keep-alive connection holds the port open and turning the
	 * setting off leaves nothing listening but the port still taken.
	 */
	private readonly _sockets = new Set<net.Socket>();

	private readonly _tools: readonly Tool[];

	/**
	 * When an authorized client last talked to us.
	 *
	 * Streamable HTTP is request/response — there is no connection to observe —
	 * so "an assistant is connected" can only mean "one has made a call
	 * recently". The window below is what makes the state decay after the
	 * assistant quits, instead of staying on until the window closes.
	 */
	private _lastActivity = 0;
	/** Last call from each recognised assistant. */
	private readonly _lastByKind = new Map<ClientKind, number>();

	/**
	 * `Mcp-Session-Id` → which assistant owns it.
	 *
	 * Only `initialize` carries `clientInfo`, so without this every later
	 * `tools/call` would be anonymous and the per-assistant dots would decay
	 * while the assistant was still working. We mint a session id at initialize,
	 * return it in the response header, and MCP clients echo it back.
	 */
	private readonly _sessionKinds: Map<string, ClientKind>;


	constructor(
		private readonly browser: BrowserController,
		private readonly _token: string,
		private readonly _folderName: string | undefined,
		private readonly _version: string,
		/**
		 * Handed in, and outliving this instance, because a tab assignment is
		 * keyed on the *assistant* — and the only thing that knows which
		 * assistant a session id belongs to is this map.
		 *
		 * It used to be created here and cleared in `dispose`, so switching
		 * `aiBrowser.mcp.port` (or anything else that restarts the server) made
		 * every live conversation anonymous again: `initialize` had happened
		 * against the old instance, the new one classified it as `other`, and
		 * an assistant that had been given a tab silently went back to
		 * following whichever tab the user was looking at — the exact failure
		 * the assignment exists to prevent. The window owns it now.
		 */
		sessionKinds: Map<string, ClientKind>,
	) {
		this._sessionKinds = sessionKinds;
		this._tools = this._buildTools();
	}

	public get token(): string {
		return this._token;
	}

	public get port(): number | undefined {
		return this._port;
	}

	public get url(): string | undefined {
		return this._port ? `http://127.0.0.1:${this._port}/mcp` : undefined;
	}

	/**
	 * The endpoint with the token baked into the path.
	 *
	 * Codex can only *name* a bearer token in its config
	 * (`bearer_token_env_var = "FOO"`), and the extension does not control the
	 * environment Codex is launched in — so for Codex the token has to travel in
	 * the URL.
	 */
	public get urlWithToken(): string | undefined {
		return this._port ? `${this.url}/${this._token}` : undefined;
	}

	public get toolCount(): number {
		return this._tools.length;
	}

	public get hasClient(): boolean {
		return Date.now() - this._lastActivity < clientIdleMs;
	}

	/** Which assistants have called recently. */
	public get clients(): ClientSet {
		const fresh = (kind: ClientKind) => Date.now() - (this._lastByKind.get(kind) ?? 0) < clientIdleMs;
		return { claude: fresh('claude'), codex: fresh('codex') };
	}

	private _noteActivity(kind: ClientKind | undefined): void {
		this._lastActivity = Date.now();
		if (kind && kind !== 'other') {
			this._lastByKind.set(kind, Date.now());
		}
	}

	/**
	 * Binds to the first free port in `ports`, in the order given.
	 *
	 * Several windows each run their own server, so a window whose preferred
	 * port is taken has to move along. Only `EADDRINUSE` is treated as "try the
	 * next one" — any other bind error is real and is reported.
	 *
	 * The order is decided by {@link portOrder} rather than here, because the
	 * *first* entry is the interesting one: deriving it from the folder URI is
	 * what makes a window land on the same port after a restart, so a config
	 * written last week still addresses this window. See `mcpPort.ts`.
	 */
	public async start(ports: readonly number[]): Promise<void> {
		for (const port of ports) {
			try {
				this._server = await this._listen(port);
				this._port = port;
				return;
			} catch (err: any) {
				if (err?.code !== 'EADDRINUSE') {
					throw err;
				}
			}
		}
		throw new Error(`No free port among ${ports.length} tried from ${ports[0]}.`);
	}

	private _listen(port: number): Promise<http.Server> {
		return new Promise((resolve, reject) => {
			const server = http.createServer((req, res) => {
				// Nothing may escape: a client that never gets a response waits
				// forever, and an unhandled rejection here takes down the host.
				this._handle(req, res).catch(() => {
					this._respond(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } });
				});
			});

			server.on('connection', socket => {
				this._sockets.add(socket);
				socket.on('close', () => this._sockets.delete(socket));
			});

			const onError = (err: unknown) => {
				server.removeListener('listening', onListening);
				reject(err);
			};
			const onListening = () => {
				server.removeListener('error', onError);
				// From here on a socket error must not become an uncaught
				// exception in the extension host.
				server.on('error', () => { });
				resolve(server);
			};

			server.once('error', onError);
			server.once('listening', onListening);
			// Loopback only. This is the first of the three things that make the
			// server safe, and none of them works without the others.
			server.listen(port, '127.0.0.1');
		});
	}

	private _respond(res: http.ServerResponse, status: number, body: unknown): void {
		const text = body === undefined ? '' : JSON.stringify(body);
		res.writeHead(status, {
			'content-type': 'application/json',
			'content-length': Buffer.byteLength(text),
			'cache-control': 'no-store',
		});
		res.end(text);
	}

	private async _handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const path = normalisePath(req.url);
		const decision = authorizeRequest({
			method: req.method,
			path,
			origin: req.headers.origin,
			authorization: req.headers.authorization,
		}, this._token);

		switch (decision.kind) {
			case 'methodNotAllowed':
				// No SSE stream: the server never pushes.
				res.writeHead(405, { allow: 'POST', 'content-length': '0' });
				res.end();
				return;
			case 'forbidden':
				this._respond(res, 403, { error: decision.reason });
				return;
			case 'unauthorized':
				this._respond(res, 401, { error: 'Unauthorized' });
				return;
			case 'notFound':
				this._respond(res, 404, { error: 'Not found' });
				return;
			case 'ok':
				break;
		}

		let raw: string;
		try {
			raw = await this._readBody(req);
		} catch (err) {
			this._respond(res, 413, { error: err instanceof Error ? err.message : 'Request too large' });
			return;
		}

		let body: unknown;
		try {
			body = JSON.parse(raw);
		} catch {
			this._respond(res, 400, parseError());
			return;
		}

		const reason = invalidRequestReason(body);
		if (reason) {
			this._respond(res, 400, invalidRequest(reason));
			return;
		}

		const request = body as { id?: unknown; method?: unknown; params?: any };

		// Attribute the call: `initialize` names the client, everything after it
		// is identified by the session id we handed out.
		const clientName = initializeClientName(request);
		let sessionId = stringOrUndefined(req.headers['mcp-session-id'] as string | undefined);
		let kind = sessionId ? this._sessionKinds.get(sessionId) : undefined;

		if (clientName !== undefined) {
			kind = classifyClient(clientName);
			sessionId = generateUuid();
			this._sessionKinds.set(sessionId, kind);
			res.setHeader('mcp-session-id', sessionId);
		}

		this._noteActivity(kind);

		// Who is calling, handed to the call itself rather than parked on the
		// controller. The share is per assistant, so this decides *which tab* a
		// tool acts on — and the field it replaces could be cleared by a second,
		// overlapping call while the first was still running, which is tolerable
		// for a label and not for a tab.
		//
		// `?? 'other'` and not `kind &&`: only `initialize` names a client, so a
		// client that does not echo the session id back is anonymous on every
		// call after it. Skipping those left the marker on a shared tab reading
		// 🔗 — "nobody has picked this up" — while that very client drove the
		// page, which is the one thing the marker exists to tell apart. An
		// unrecognised assistant is `other` everywhere else here too.
		const caller: Caller = { kind: kind ?? 'other', sessionId };
		const response = await dispatch(request, this._context(), caller);

		if (response === undefined) {
			// A notification. Answering one breaks the handshake, so 202 with no body.
			res.writeHead(202, { 'content-length': '0' });
			res.end();
			return;
		}

		this._respond(res, 200, response);
	}

	private _readBody(req: http.IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			let size = 0;
			req.on('data', (chunk: Buffer) => {
				size += chunk.length;
				if (size > maxRequestBytes) {
					reject(new Error('Request body exceeds 1 MB'));
					req.destroy();
					return;
				}
				chunks.push(chunk);
			});
			req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
			req.on('error', reject);
		});
	}

	private _context(): DispatchContext {
		return { serverVersion: this._version, workspaceName: this._folderName, tools: this._tools };
	}

	private _buildTools(): readonly Tool[] {
		const browser = this.browser;
		return [
			{
				name: 'browser_state', title: 'Browser state',
				description: 'Reports whether a page is open in the integrated browser, which tab the tools are acting on, '
					+ 'and how that tab was chosen. Call this first.',
				inputSchema: schema({}),
				run: (_args, caller) => browser.state(caller),
			},
			{
				name: 'browser_tabs', title: 'List tabs',
				description: 'The browser tabs you may act on. If the user has given you a tab, that is the only one '
					+ 'listed and browser_select_tab is refused — the rest of the window is not yours to read. '
					+ 'Otherwise every open tab is listed, and you may pass an id to browser_select_tab to work on '
					+ 'one of them.',
				inputSchema: schema({}),
				run: (_args, caller) => browser.tabs(caller),
			},
			{
				name: 'browser_select_tab', title: 'Select a tab',
				description: 'Points every later tool at one browser tab. Refused while the user has shared a tab '
					+ 'with you, because the tools act on that one only. The selection survives the user switching '
					+ 'editors or looking at another page, so use it whenever more than one tab is open. '
					+ 'Ids come from browser_tabs and are only valid while this window is open.',
				inputSchema: schema({
					id: string('Tab id from browser_tabs, or "auto" to follow whichever tab is in front of the user'),
				}, ['id']),
				run: (args, caller) => browser.selectTab(stringOrUndefined(args.id) ?? '', caller),
			},
			{
				name: 'browser_navigate', title: 'Navigate',
				description: 'Opens an http or https URL in the integrated browser. '
					+ 'This reuses the browser tab already in use, so repeated navigation does not '
					+ 'leave a trail of editor tabs behind; pass newTab to keep the current page open.',
				inputSchema: schema({
					url: string('Absolute http(s) URL to open'),
					newTab: {
						type: 'boolean',
						description: 'Open a second browser tab instead of reusing the current one. '
							+ 'Refused while the user has shared a tab with you.',
					},
				}, ['url']),
				run: (args, caller) => browser.navigate(stringOrUndefined(args.url) ?? '', args.newTab === true, caller),
			},
			{
				name: 'browser_snapshot', title: 'Snapshot',
				description: 'Lists the interactive elements on the page with selectors you can pass to browser_click or browser_fill.',
				inputSchema: schema({}),
				run: (_args, caller) => browser.snapshot(caller),
			},
			{
				name: 'browser_inspect_element', title: 'Inspect an element',
				description: 'Turns on the element picker and waits for the user to click an element, then returns its full context. '
					+ 'This blocks on a person, so only call it right after asking the user to pick something.',
				inputSchema: schema({ timeoutMs: number('How long to wait for the click, default 30000') }),
				run: (args, caller) => browser.inspectElement(numberOrUndefined(args.timeoutMs) ?? 30_000, caller),
			},
			{
				name: 'browser_selected_element', title: 'Last selected element',
				description: 'Returns the element the user most recently picked, without prompting again.',
				inputSchema: schema({}),
				run: (_args, caller) => browser.selectedElement(caller),
			},
			{
				name: 'browser_html', title: 'Read HTML',
				description: 'Outer HTML of the whole document, or of the first element matching a CSS selector.',
				inputSchema: schema({ selector: string('Optional CSS selector') }),
				run: (args, caller) => browser.html(stringOrUndefined(args.selector), caller),
			},
			{
				name: 'browser_text', title: 'Read text',
				description: 'Visible text of the page body, or of the first element matching a CSS selector.',
				inputSchema: schema({ selector: string('Optional CSS selector') }),
				run: (args, caller) => browser.text(stringOrUndefined(args.selector), caller),
			},
			{
				name: 'browser_console', title: 'Console output',
				description: 'Console messages and uncaught errors captured from the page.',
				inputSchema: schema({ clear: { type: 'boolean', description: 'Clear the buffer after reading' } }),
				run: (args, caller) => browser.consoleOutput(args.clear === true, caller),
			},
			{
				name: 'browser_screenshot', title: 'Screenshot',
				description: 'PNG of the page, base64-encoded. Captures the visible area unless fullPage is true.',
				inputSchema: schema({
					fullPage: { type: 'boolean', description: 'Capture the whole scrollable page' },
				}),
				run: async (args, caller) => {
					// The caller, or this reads as a command the *user* pressed
					// and captures the tab they are focused on — an assistant
					// with a tab of its own would get a picture of a page it was
					// never given, and a paused one would get a picture at all.
					const { png, clipped } = await browser.capture(args.fullPage === true, undefined, caller);
					return {
						mimeType: 'image/png',
						clipped: clipped || undefined,
						base64: png.toString('base64'),
					};
				},
			},
			{
				name: 'browser_click', title: 'Click',
				description: 'Clicks the first element matching a CSS selector.',
				inputSchema: schema({ selector: string('CSS selector of the element to click') }, ['selector']),
				run: (args, caller) => browser.click(stringOrUndefined(args.selector) ?? '', caller),
			},
			{
				name: 'browser_fill', title: 'Fill a field',
				description: 'Sets the value of an input, textarea or contenteditable and fires input/change so frameworks notice.',
				inputSchema: schema({
					selector: string('CSS selector of the field'),
					value: string('Value to set'),
				}, ['selector', 'value']),
				run: (args, caller) => browser.fill(stringOrUndefined(args.selector) ?? '', stringOrUndefined(args.value) ?? '', caller),
			},
			{
				name: 'browser_wait_for', title: 'Wait for',
				description: 'Waits until a selector matches, or a piece of text appears on the page.',
				inputSchema: schema({
					selector: string('CSS selector to wait for'),
					text: string('Text to wait for'),
					timeoutMs: number('How long to wait, default 10000'),
				}),
				// The tool itself waits up to 10s, so its own budget must exceed that.
				run: (args, caller) => browser.waitFor(
					stringOrUndefined(args.selector),
					stringOrUndefined(args.text),
					numberOrUndefined(args.timeoutMs) ?? 10_000,
					caller),
			},
		];
	}

	public dispose(): void {
		for (const socket of this._sockets) {
			socket.destroy();
		}
		this._sockets.clear();
		this._server?.close();
		this._server = undefined;
		this._port = undefined;
	}
}

export { isNotification };
