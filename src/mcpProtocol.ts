/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * JSON-RPC dispatch for the MCP server, with no transport and no vscode import
 * so it stays loadable by `npm test`. The MCP SDK is deliberately not used: what
 * is needed is a handful of methods over one POST, and the SDK would be more
 * surface than the whole feature.
 */

export const defaultProtocolVersion = '2025-06-18';

export const errorCodes = {
	parse: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	internal: -32603,
} as const;

export interface JsonRpcRequest {
	jsonrpc?: unknown;
	id?: unknown;
	method?: unknown;
	params?: any;
}

export interface ToolSchema {
	readonly type: 'object';
	readonly properties: Record<string, unknown>;
	readonly required?: string[];
	readonly additionalProperties: false;
}

export interface Tool {
	readonly name: string;
	readonly title: string;
	readonly description: string;
	readonly inputSchema: ToolSchema;
	/** Extra time this tool needs beyond the default request timeout, in ms. */
	readonly slowMs?: number;
	run(args: Record<string, unknown>): Promise<unknown>;
}

export function schema(
	properties: Record<string, unknown>,
	required: string[] = [],
): ToolSchema {
	return { type: 'object', properties, required, additionalProperties: false };
}

export function string(description: string): Record<string, unknown> {
	return { type: 'string', description };
}

export function number(description: string): Record<string, unknown> {
	return { type: 'number', description };
}

/** Model arguments are untrusted: anything may arrive under any key. */
export function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function numberOrUndefined(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export interface DispatchContext {
	readonly serverVersion: string;
	readonly workspaceName: string | undefined;
	readonly tools: readonly Tool[];
}

export interface JsonRpcResponse {
	readonly jsonrpc: '2.0';
	readonly id: unknown;
	readonly result?: unknown;
	readonly error?: { code: number; message: string };
}

function result(id: unknown, value: unknown): JsonRpcResponse {
	return { jsonrpc: '2.0', id, result: value };
}

function failure(id: unknown, code: number, message: string): JsonRpcResponse {
	return { jsonrpc: '2.0', id, error: { code, message } };
}

/** A request without an id is a notification: acknowledge, never answer. */
export function isNotification(request: JsonRpcRequest): boolean {
	return request.id === undefined || request.id === null;
}

function instructions(workspaceName: string | undefined): string {
	const where = workspaceName ? ` for the workspace \`${workspaceName}\`` : '';
	return [
		`Controls the integrated browser in VS Code${where}.`,
		'Call `browser_state` first: it reports whether a page is open and what it is.',
		'`browser_inspect_element` waits for the user to click an element, so only call it when you have asked them to.',
	].join(' ');
}

/**
 * A tool's own failure is a *result*, not a protocol error.
 *
 * `{ isError: true }` is something the model reads and can react to; a -32603
 * never reaches it, so a mistake it could have fixed becomes a dead end.
 */
function toolFailure(message: string): unknown {
	return { isError: true, content: [{ type: 'text', text: message }] };
}

function asText(value: unknown): string {
	return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/**
 * Handles one parsed request. Returns `undefined` for notifications, whose
 * caller should answer 202 with an empty body — without that,
 * `notifications/initialized` breaks the handshake.
 */
export async function dispatch(
	request: JsonRpcRequest,
	ctx: DispatchContext,
): Promise<JsonRpcResponse | undefined> {

	if (isNotification(request)) {
		return undefined;
	}

	const id = request.id;
	const method = request.method;

	switch (method) {
		case 'initialize': {
			// Echo the client's protocol version when it names one: an unexpected
			// version in the reply makes strict clients bail out of the handshake.
			const asked = stringOrUndefined(request.params?.protocolVersion);
			return result(id, {
				protocolVersion: asked ?? defaultProtocolVersion,
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: 'ai-browser', version: ctx.serverVersion },
				instructions: instructions(ctx.workspaceName),
			});
		}

		case 'ping':
			return result(id, {});

		case 'tools/list':
			return result(id, {
				tools: ctx.tools.map(({ name, title, description, inputSchema }) =>
					({ name, title, description, inputSchema })),
			});

		case 'tools/call': {
			const name = stringOrUndefined(request.params?.name);
			const tool = ctx.tools.find(t => t.name === name);
			if (!tool) {
				return result(id, toolFailure(`Unknown tool: ${name ?? '(none)'}`));
			}

			const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
			try {
				const value = await tool.run(args);
				return result(id, { content: [{ type: 'text', text: asText(value) }] });
			} catch (err) {
				return result(id, toolFailure(err instanceof Error ? err.message : String(err)));
			}
		}

		default:
			return failure(id, errorCodes.methodNotFound, `Unknown method: ${String(method)}`);
	}
}

/**
 * Validates a parsed body before dispatch.
 *
 * Batches and bare arrays are refused rather than half-supported: a client that
 * gets a partial batch back behaves far worse than one told plainly no.
 */
export function invalidRequestReason(body: unknown): string | undefined {
	if (Array.isArray(body)) {
		return 'Batch requests are not supported';
	}
	if (typeof body !== 'object' || body === null) {
		return 'Request must be a JSON-RPC object';
	}
	if (typeof (body as JsonRpcRequest).method !== 'string') {
		return 'Request is missing a method';
	}
	return undefined;
}

export function parseError(id: unknown = null): JsonRpcResponse {
	return failure(id, errorCodes.parse, 'Invalid JSON');
}

export function invalidRequest(reason: string, id: unknown = null): JsonRpcResponse {
	return failure(id, errorCodes.invalidRequest, reason);
}

/* ------------------------------------------------------------------ transport */

export interface RequestFacts {
	readonly method: string | undefined;
	/** Path with the query and any trailing slashes already removed. */
	readonly path: string;
	readonly origin: string | undefined;
	readonly authorization: string | undefined;
}

export type Decision =
	| { readonly kind: 'ok' }
	| { readonly kind: 'methodNotAllowed' }
	| { readonly kind: 'forbidden'; readonly reason: string }
	| { readonly kind: 'unauthorized' }
	| { readonly kind: 'notFound' };

export function normalisePath(url: string | undefined): string {
	return (url ?? '').split('?')[0].replace(/\/+$/, '');
}

/**
 * Decides what to do with an incoming request, before any body is read.
 *
 * Kept here, away from `http`, because these four rules are the whole security
 * model and they only hold together as a set:
 *
 *  1. loopback binding (enforced at `listen`, not visible here);
 *  2. no `Origin` — a page cannot *read* a cross-origin response, but issuing
 *     the request is already enough to drive the browser, so anything with an
 *     Origin is refused before its credentials are even considered;
 *  3. a per-workspace token, accepted either as `Authorization: Bearer …` or as
 *     the last path segment (the only form Codex can carry);
 *  4. nothing but POST on the one endpoint — there is no SSE stream, so a GET
 *     is a client misunderstanding worth reporting as 405.
 */
export function authorizeRequest(facts: RequestFacts, token: string): Decision {
	if (facts.method !== 'POST') {
		return { kind: 'methodNotAllowed' };
	}

	if (facts.origin !== undefined) {
		return { kind: 'forbidden', reason: 'Cross-origin requests are not allowed' };
	}

	const tokenInPath = `/mcp/${token}`;
	const authorized = facts.authorization === `Bearer ${token}` || facts.path === tokenInPath;
	if (!authorized) {
		return { kind: 'unauthorized' };
	}

	if (facts.path !== '/mcp' && facts.path !== tokenInPath) {
		return { kind: 'notFound' };
	}

	return { kind: 'ok' };
}

/* -------------------------------------------------------------- client kinds */

/** Which assistant is on the other end, as far as we can tell. */
export type ClientKind = 'claude' | 'codex' | 'other';

/**
 * Classifies a client from the `clientInfo.name` it sends with `initialize`.
 *
 * That name is the only self-identification in the protocol, and it is a
 * best-effort match: an unrecognised client is `other` and simply does not
 * light up a dot.
 */
export function classifyClient(clientName: string | undefined): ClientKind {
	const name = (clientName ?? '').toLowerCase();
	if (name.includes('claude')) {
		return 'claude';
	}
	if (name.includes('codex') || name.includes('chatgpt') || name.includes('openai')) {
		return 'codex';
	}
	return 'other';
}

/** `clientInfo.name` from an `initialize` request, if this is one. */
export function initializeClientName(request: JsonRpcRequest): string | undefined {
	return request.method === 'initialize'
		? stringOrUndefined(request.params?.clientInfo?.name)
		: undefined;
}
