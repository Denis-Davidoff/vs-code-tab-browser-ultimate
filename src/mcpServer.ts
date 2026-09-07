/*---------------------------------------------------------------------------------------------
 *  An mcp server that hands the browser panel to an assistant.
 *
 *  Streamable HTTP, spoken directly: the protocol needed here is a handful of JSON-RPC methods
 *  over one POST endpoint, and a dependency that ships its own http stack would be more code in
 *  the bundle than this file. Requests are answered as plain json; no session, no server push.
 *
 *  It listens on the loopback interface only, requires a bearer token, and refuses anything that
 *  carries an `Origin` header — a page in a browser can post to a local port without being able
 *  to read the answer, and that is enough to drive a panel blind. The token never leaves the
 *  extension host: the page is never told it.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'node:http';
import * as net from 'node:net';
import * as vscode from 'vscode';
import { BrowserController } from './browserController';
import { Disposable } from './dispose';

/** The version of the protocol this speaks; a client asking for another is answered in its own. */
const protocolVersion = '2025-06-18';

const maxRequestBytes = 1024 * 1024;

interface JsonRpcRequest {
	readonly jsonrpc?: string;
	readonly id?: string | number | null;
	readonly method?: string;
	readonly params?: Record<string, unknown>;
}

interface Tool {
	readonly name: string;
	readonly title: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
	readonly run: (args: Record<string, unknown>) => Promise<unknown>;
}

export class McpServer extends Disposable {

	private _server: http.Server | undefined;
	private _port = 0;
	private readonly _sockets = new Set<net.Socket>();
	private readonly _tools: readonly Tool[];

	constructor(
		browser: BrowserController,
		private readonly _token: string,
		/** The workspace this server belongs to, so a client can tell the windows apart. */
		private readonly _workspace = '',
	) {
		super();
		this._tools = buildTools(browser);
	}

	public get url(): string | undefined {
		return this._port ? `http://127.0.0.1:${this._port}/mcp` : undefined;
	}

	public get token(): string {
		return this._token;
	}

	/** Starts on `preferredPort`, or on the first free port after it. */
	public async start(preferredPort: number): Promise<void> {
		if (this._server) {
			return;
		}

		const server = http.createServer((req, res) => this._handle(req, res));
		// `listen` removes its own one-shot handler on success; without this a later socket
		// error would be an uncaught exception in the extension host.
		server.on('error', () => { });
		server.on('connection', socket => {
			this._sockets.add(socket);
			socket.on('close', () => this._sockets.delete(socket));
		});
		this._server = server;

		for (let port = preferredPort, attempt = 0; attempt < 20; port++, attempt++) {
			try {
				await listen(server, port);
				this._port = port;
				return;
			} catch (error) {
				// Another window of the same extension usually holds the preferred port.
				if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
					throw error;
				}
			}
		}

		throw new Error(vscode.l10n.t("Could not find a free port for the mcp server."));
	}

	public override dispose(): void {
		for (const socket of this._sockets) {
			socket.destroy();
		}
		this._sockets.clear();
		this._server?.close();
		this._server = undefined;
		this._port = 0;
		super.dispose();
	}

	// -- transport -----------------------------------------------------------------------------

	private async _handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		// A page cannot read a cross-origin answer, but it can still cause the request.
		if (req.headers.origin) {
			respond(res, 403, { error: 'Requests from a browser origin are not accepted.' });
			return;
		}

		const authorization = req.headers.authorization;
		if (authorization !== `Bearer ${this._token}`) {
			respond(res, 401, { error: 'A bearer token is required.' });
			return;
		}

		if (req.method !== 'POST') {
			// This server never pushes, so there is nothing to open a stream for.
			res.writeHead(405, { allow: 'POST' }).end();
			return;
		}

		let message: JsonRpcRequest;
		try {
			message = JSON.parse(await readBody(req)) as JsonRpcRequest;
		} catch (error) {
			respond(res, 400, jsonRpcError(null, -32700, String(error)));
			return;
		}

		// Notifications carry no id and want no answer.
		if (message.id === undefined || message.id === null) {
			res.writeHead(202).end();
			return;
		}

		respond(res, 200, await this._dispatch(message));
	}

	private async _dispatch(message: JsonRpcRequest): Promise<unknown> {
		const id = message.id ?? null;

		switch (message.method) {
			case 'initialize': {
				const asked = message.params?.protocolVersion;
				return jsonRpcResult(id, {
					protocolVersion: typeof asked === 'string' ? asked : protocolVersion,
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: 'tab-browser-ultimate', version: extensionVersion() },
					instructions: 'Tools for the browser panel open inside the user\'s editor'
						+ (this._workspace ? ` (workspace: ${this._workspace})` : '') + '. '
						+ 'The user can see this page: describe what you do with it.',
				});
			}

			case 'ping':
				return jsonRpcResult(id, {});

			case 'tools/list':
				return jsonRpcResult(id, {
					tools: this._tools.map(({ name, title, description, inputSchema }) =>
						({ name, title, description, inputSchema })),
				});

			case 'tools/call':
				return this._callTool(id, message.params ?? {});

			default:
				return jsonRpcError(id, -32601, `Unknown method: ${message.method}`);
		}
	}

	private async _callTool(
		id: string | number | null,
		params: Record<string, unknown>,
	): Promise<unknown> {
		const tool = this._tools.find(candidate => candidate.name === params.name);
		if (!tool) {
			return jsonRpcError(id, -32602, `Unknown tool: ${String(params.name)}`);
		}

		try {
			const value = await tool.run((params.arguments ?? {}) as Record<string, unknown>);
			return jsonRpcResult(id, { content: [{ type: 'text', text: asText(value) }] });
		} catch (error) {
			// A failing tool is a result the model can act on, not a protocol error.
			return jsonRpcResult(id, {
				isError: true,
				content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
			});
		}
	}
}

// -- tools -------------------------------------------------------------------------------------

function buildTools(browser: BrowserController): Tool[] {
	const string = (description: string) => ({ type: 'string', description });
	const schema = (properties: Record<string, unknown>, required: string[] = []) =>
		({ type: 'object', properties, required, additionalProperties: false });

	return [
		{
			name: 'browser_state',
			title: 'Browser state',
			description: 'What the browser panel in the editor currently shows.',
			inputSchema: schema({}),
			run: async () => browser.state(),
		},
		{
			name: 'browser_navigate',
			title: 'Open a page',
			description: 'Opens a url in the browser panel, reusing the panel that is already open.',
			inputSchema: schema({ url: string('The url to open, e.g. http://localhost:3000/login') }, ['url']),
			run: args => browser.navigate(String(args.url ?? '')),
		},
		{
			name: 'browser_snapshot',
			title: 'Read the page',
			description: 'A compact list of what the page shows and what can be acted on: the role, '
				+ 'the name and the css selector of every visible interactive element. Start here '
				+ 'rather than with the html, and use the selectors it returns for the other tools.',
			inputSchema: schema({ maxNodes: { type: 'number', description: 'Default 200.' } }),
			run: args => browser.ask({ type: 'snapshot', maxNodes: numberOrUndefined(args.maxNodes) }),
		},
		{
			name: 'browser_inspect_element',
			title: 'Inspect an element',
			description: 'Everything about one element: its markup, its box, the css rules that '
				+ 'apply to it and the values they resolve to.',
			inputSchema: schema({ selector: string('A css selector; the first match is used.') }, ['selector']),
			run: args => browser.ask({ type: 'inspect', selector: String(args.selector ?? '') }),
		},
		{
			name: 'browser_selected_element',
			title: 'The element the user picked',
			description: 'The element the user last picked with the panel\'s copy menu. Use it when '
				+ 'they say "this element" without naming it.',
			inputSchema: schema({}),
			run: async () => browser.lastPick(),
		},
		{
			name: 'browser_html',
			title: 'Read html',
			description: 'The rendered html of the page, or of one element.',
			inputSchema: schema({
				selector: string('A css selector; the whole document when omitted.'),
				maxLength: { type: 'number', description: 'Characters to return. Default 20000.' },
			}),
			run: args => browser.ask({
				type: 'html',
				selector: stringOrUndefined(args.selector),
				maxLength: numberOrUndefined(args.maxLength),
			}),
		},
		{
			name: 'browser_text',
			title: 'Read text',
			description: 'The visible text of the page, or of one element.',
			inputSchema: schema({
				selector: string('A css selector; the whole page when omitted.'),
				maxLength: { type: 'number', description: 'Characters to return. Default 20000.' },
			}),
			run: args => browser.ask({
				type: 'text',
				selector: stringOrUndefined(args.selector),
				maxLength: numberOrUndefined(args.maxLength),
			}),
		},
		{
			name: 'browser_console',
			title: 'Read the console',
			description: 'What the page has logged since it was loaded, uncaught errors included.',
			inputSchema: schema({
				level: string('Only entries of this level: log, info, warn, error, debug or trace.'),
				limit: { type: 'number', description: 'Most recent entries to return. Default 100.' },
			}),
			run: args => browser.console(stringOrUndefined(args.level), numberOrUndefined(args.limit)),
		},
		{
			name: 'browser_click',
			title: 'Click an element',
			description: 'Clicks the first element matching the selector, scrolling it into view.',
			inputSchema: schema({ selector: string('A css selector, e.g. from browser_snapshot.') }, ['selector']),
			run: args => browser.ask({ type: 'click', selector: String(args.selector ?? '') }),
		},
		{
			name: 'browser_fill',
			title: 'Fill a field',
			description: 'Puts a value into an input or textarea, raising the events a framework '
				+ 'expects from someone typing.',
			inputSchema: schema({
				selector: string('A css selector for the field.'),
				value: string('The text to put in it.'),
			}, ['selector', 'value']),
			run: args => browser.ask({
				type: 'fill',
				selector: String(args.selector ?? ''),
				value: String(args.value ?? ''),
			}),
		},
		{
			name: 'browser_wait_for',
			title: 'Wait for an element',
			description: 'Waits until something matches the selector, for pages that render late.',
			inputSchema: schema({
				selector: string('A css selector to wait for.'),
				timeout: { type: 'number', description: 'Milliseconds to wait. Default 10000.' },
			}, ['selector']),
			run: args => browser.ask({
				type: 'waitFor',
				selector: String(args.selector ?? ''),
				timeout: numberOrUndefined(args.timeout),
			}, 35000),
		},
	];
}

// -- plumbing ----------------------------------------------------------------------------------

function listen(server: http.Server, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			server.removeListener('listening', onListening);
			reject(error);
		};
		const onListening = () => {
			server.removeListener('error', onError);
			resolve();
		};
		server.once('error', onError);
		server.once('listening', onListening);
		server.listen(port, '127.0.0.1');
	});
}

async function readBody(req: http.IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > maxRequestBytes) {
			throw new Error('Request too large.');
		}
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString('utf8');
}

function respond(res: http.ServerResponse, status: number, body: unknown): void {
	const payload = Buffer.from(JSON.stringify(body), 'utf8');
	res.writeHead(status, {
		'content-type': 'application/json',
		'content-length': payload.byteLength,
		'cache-control': 'no-store',
	});
	res.end(payload);
}

function jsonRpcResult(id: string | number | null, result: unknown): unknown {
	return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id: string | number | null, code: number, message: string): unknown {
	return { jsonrpc: '2.0', id, error: { code, message } };
}

function asText(value: unknown): string {
	return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === 'string' && value ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
	return typeof value === 'number' && isFinite(value) ? value : undefined;
}

function extensionVersion(): string {
	return vscode.extensions.getExtension('local.tab-browser-ultimate')?.packageJSON?.version ?? '0.0.0';
}
