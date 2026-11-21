/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CallerIdentity } from '../browser/shareRegistry';

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
	invalidParams: -32602,
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

/**
 * Who is calling, carried to the tool rather than parked in a field.
 *
 * An alias rather than a second declaration: `shareRegistry.ts` owns this shape
 * because it owns the resolution rules that read it, and two identical
 * interfaces would have drifted silently — structural typing hides a field
 * added to one and ignored by the other. Type-only, so this leaf still imports
 * nothing at runtime.
 *
 * The share is per assistant now, so "which tab does this call act on" cannot
 * be answered without knowing whose call it is — and the previous shape, an
 * in-flight `_caller` on the controller, was only ever good enough for a label:
 * two overlapping `tools/call`s and the second one's `endCall` cleared the field
 * under the first. A tab is not a label.
 *
 * `sessionId` is the finer grain — one conversation rather than one assistant —
 * and it is present whenever the client echoes the `Mcp-Session-Id` header it
 * was given at `initialize`.
 */
export type Caller = CallerIdentity;

export interface Tool {
	readonly name: string;
	readonly title: string;
	readonly description: string;
	readonly inputSchema: ToolSchema;
	/**
	 * Whether `tools/list` shows this tool to the caller. Absent means to
	 * everyone. Only a listing: a hidden tool that is called anyway still
	 * decides for itself, so this saves the context of callers that could
	 * never use it (the `terminal_*` tools, for an assistant that is not one
	 * of the chat's own) and never stands in for the tool's own refusal.
	 */
	visibleTo?(caller: Caller): boolean;
	/**
	 * MCP behaviour hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
	 * `openWorldHint`), filled in from `toolMeta.ts` by the server. Advice to a
	 * client, never a permission: the approval menu and the terminal grants
	 * decide what runs.
	 */
	readonly annotations?: ToolAnnotations;
	/** Icons for the tool's group (`toolMeta.ts`), sent from protocol 2025-11-25. */
	readonly icons?: readonly ToolIcon[];
	/**
	 * The shape of the result, sent from protocol 2025-06-18. A tool that has one
	 * answers a plain object, which goes out as `structuredContent` beside the
	 * text block. Loose on purpose — no `required`, no closed objects — because
	 * a client that validates a result against it refuses the whole call on a
	 * field the schema did not foresee.
	 */
	readonly outputSchema?: Record<string, unknown>;
	/**
	 * Waits on something that can take a while (the user's click, a page load,
	 * a sign-in). With a `progressToken` in the request the server reports it
	 * every few seconds, so a client that resets its timeout on progress keeps
	 * the call alive.
	 */
	readonly longRunning?: boolean;
	/**
	 * `signal` fires when the client gives up on the call — a
	 * `notifications/cancelled` naming it, or the connection closing first.
	 * Only tools that wait on something outside the server need it.
	 * `progress` reports how far it got, when the client asked for progress.
	 */
	run(args: Record<string, unknown>, caller: Caller, signal?: AbortSignal, progress?: Progress): Promise<unknown>;
}

export interface ToolAnnotations {
	readonly readOnlyHint?: boolean;
	readonly destructiveHint?: boolean;
	readonly idempotentHint?: boolean;
	readonly openWorldHint?: boolean;
}

export interface ToolIcon {
	readonly src: string;
	readonly mimeType: string;
	readonly sizes?: readonly string[];
}

/** A `notifications/progress` for the call in flight: `progress` grows, `total` when known. */
export type Progress = (progress: number, total?: number, message?: string) => void;

/**
 * An MCP prompt: a template the client offers its user (Claude Code lists them
 * as slash commands), filled in by `get` with the arguments the user gave.
 */
export interface Prompt {
	readonly name: string;
	readonly title: string;
	readonly description: string;
	readonly arguments: readonly { readonly name: string; readonly description: string; readonly required?: boolean }[];
	/** The text of the one user message the prompt becomes. Throws to refuse. */
	get(args: Record<string, string>, caller: Caller): Promise<string> | string;
}

/** The protocol versions that introduced the fields this server sends. */
export const protocolFeatures = {
	/** `annotations` on a tool, with `title` inside them. */
	annotations: '2025-03-26',
	/** `title` and `outputSchema` on a tool, `structuredContent` in a result. */
	structured: '2025-06-18',
	/** `icons` on a tool. */
	icons: '2025-11-25',
} as const;

/**
 * Whether a client that negotiated `version` may be sent a field introduced in
 * `since`. MCP versions are dates written `YYYY-MM-DD`, so they compare as
 * strings. Anything else (absent, or a client's own spelling) is read as the
 * server's default, which is what such a client was answered with at
 * `initialize` — a field it cannot parse is worse than one it does not get.
 */
export function supports(version: string | undefined, since: string): boolean {
	const known = version !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(version) ? version : defaultProtocolVersion;
	return known >= since;
}

/** A tool as `tools/list` shows it to a client that negotiated `version`. */
export function listedTool(tool: Tool, version: string | undefined): Record<string, unknown> {
	const entry: Record<string, unknown> = { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
	const structured = supports(version, protocolFeatures.structured);
	if (structured) {
		entry.title = tool.title;
		if (tool.outputSchema) {
			entry.outputSchema = tool.outputSchema;
		}
	}
	if (supports(version, protocolFeatures.annotations)) {
		// 2025-03-26 has no top-level `title`; its place is inside the annotations.
		const annotations = { ...(structured ? {} : { title: tool.title }), ...tool.annotations };
		if (Object.keys(annotations).length > 0) {
			entry.annotations = annotations;
		}
	}
	if (tool.icons && supports(version, protocolFeatures.icons)) {
		entry.icons = tool.icons;
	}
	return entry;
}

function plainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** An MCP content block — `text` or `image`, the two this server produces. */
export type ContentBlock =
	| { type: 'text'; text: string }
	| { type: 'image'; data: string; mimeType: string };

const contentMarker = Symbol('toolContent');

/**
 * A tool result handed to the client as these blocks, rather than serialised
 * into one text block.
 *
 * An image has to travel this way. Serialised, its base64 is *text*: the client
 * counts it as tokens (Claude Code refuses anything past 25 000, which one
 * full-page PNG passed a hundred times over) and, when it does fit, the model
 * reads a string of base64 instead of seeing a picture.
 */
export function toolContent(blocks: ContentBlock[]): { readonly [contentMarker]: ContentBlock[] } {
	return { [contentMarker]: blocks };
}

function contentOf(value: unknown): ContentBlock[] | undefined {
	return typeof value === 'object' && value !== null && contentMarker in value
		? (value as { [contentMarker]: ContentBlock[] })[contentMarker]
		: undefined;
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

/**
 * A text argument that changes what a tool *does*, so a wrong type is refused
 * rather than read as absent.
 *
 * {@link stringOrUndefined} answers `undefined` for anything that is not a
 * non-empty string, which is right for an optional filter and wrong here:
 * `browser_fill` with `"value": 5` reached the page as `''`, cleared the field
 * and answered "filled input", and `browser_wait_for` with `"text": 404` dropped
 * its condition. A finite number is what the model meant as text, so it is
 * converted; absence stays absence; anything else is an error the model reads.
 * Breaks-silently #210.
 */
export function textArgument(value: unknown, name: string): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number' && Number.isFinite(value)) {
		return String(value);
	}
	throw new Error(`\`${name}\` must be a string, not ${Array.isArray(value) ? 'an array' : typeof value}.`);
}

/**
 * A number argument where absence means "do the default thing".
 *
 * `numberOrUndefined` reads a wrong-typed value as absent, which is right for a
 * timeout and wrong wherever the default *acts*: `browser_scroll` given
 * `"by": "-500"` scrolled down by its default instead of up (#210). A string
 * that is plainly a number is converted, as `textArgument` converts the other
 * way; anything else is refused.
 */
export function numberArgument(value: unknown, name: string): number | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
		return Number(value);
	}
	throw new Error(`\`${name}\` must be a number, not ${JSON.stringify(value) ?? typeof value}.`);
}

export function numberOrUndefined(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export interface DispatchContext {
	readonly serverVersion: string;
	readonly workspaceName: string | undefined;
	readonly tools: readonly Tool[];
	/** The version this session negotiated at `initialize`; decides which tool fields are sent. */
	readonly protocolVersion?: string;
	/** The prompts `prompts/list` offers this caller. */
	readonly prompts?: readonly Prompt[];
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
		'Call `browser_state` first: it reports whether a page is open, which tab the tools act on, and how it was chosen.',
		'With more than one tab open, `browser_tabs` lists them with ids and `browser_select_tab` fixes the tools on one;'
		+ ' without a selection they follow whichever tab the user has in front of them.',
		'The user can also **share** one tab, and that outranks everything: the tools then act on that tab only, they'
		+ ' cannot be moved off it, and if it is closed they pause until another is shared. `browser_state` says so.',
		'`browser_inspect_element` waits for the user to click an element, so only call it when you have asked them to.',
		'Content inside an iframe is not part of the page\'s own text: `browser_frames` lists the frames, and the reading'
		+ ' and clicking tools take a `frameId` to work inside one.',
		'The `editor_*` tools are the code editor beside the browser: `editor_context` says what the user has open and'
		+ ' selected, `editor_reveal` shows them a place, and `editor_definition`, `editor_references` and `editor_symbols`'
		+ ' navigate by symbol through the language servers.',
		'Before an action with consequences the user has not asked for in so many words — submitting a form, buying,'
		+ ' sending a message, deleting — say what you are about to do and let them confirm.',
		'After you change a page (click, fill, navigate), read it again before relying on what it shows: the page may'
		+ ' have moved on, and a selector from before the change may now name something else.',
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
	caller: Caller = { kind: 'other' },
	signal?: AbortSignal,
	progress?: Progress,
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
				capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
				serverInfo: { name: 'ai-browser', version: ctx.serverVersion },
				instructions: instructions(ctx.workspaceName),
			});
		}

		case 'ping':
			return result(id, {});

		case 'tools/list':
			return result(id, {
				tools: ctx.tools.filter(tool => tool.visibleTo?.(caller) !== false)
					.map(tool => listedTool(tool, ctx.protocolVersion)),
			});

		case 'prompts/list':
			return result(id, {
				prompts: (ctx.prompts ?? []).map(prompt => ({
					name: prompt.name,
					...(supports(ctx.protocolVersion, protocolFeatures.structured) ? { title: prompt.title } : {}),
					description: prompt.description,
					arguments: prompt.arguments,
				})),
			});

		case 'prompts/get': {
			const name = stringOrUndefined(request.params?.name);
			const prompt = (ctx.prompts ?? []).find(p => p.name === name);
			if (!prompt) {
				return failure(id, errorCodes.invalidParams, `Unknown prompt: ${name ?? '(none)'}`);
			}
			const given: Record<string, string> = {};
			const raw = request.params?.arguments;
			if (raw && typeof raw === 'object') {
				for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
					if (typeof value === 'string') {
						given[key] = value;
					}
				}
			}
			const missing = prompt.arguments.find(a => a.required && !given[a.name]?.trim());
			if (missing) {
				return failure(id, errorCodes.invalidParams, `Missing argument: ${missing.name}`);
			}
			try {
				const text = await prompt.get(given, caller);
				return result(id, { description: prompt.description, messages: [{ role: 'user', content: { type: 'text', text } }] });
			} catch (err) {
				return failure(id, errorCodes.invalidParams, err instanceof Error ? err.message : String(err));
			}
		}

		case 'tools/call': {
			const name = stringOrUndefined(request.params?.name);
			const tool = ctx.tools.find(t => t.name === name);
			if (!tool) {
				return result(id, toolFailure(`Unknown tool: ${name ?? '(none)'}`));
			}

			const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
			try {
				const value = await tool.run(args, caller, signal, progress);
				const content = contentOf(value) ?? [{ type: 'text', text: asText(value) }];
				const shown = content;
				// `structuredContent` only from a tool that declared its shape, and only
				// to a client that can read it; the text block stays for every client.
				const structured = tool.outputSchema && plainObject(value) && supports(ctx.protocolVersion, protocolFeatures.structured);
				return result(id, structured ? { content: shown, structuredContent: value } : { content: shown });
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
export type ClientKind = 'claude' | 'codex' | 'gemini' | 'opencode' | 'pi' | 'openrouter' | 'other';

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
	// `gemini-cli-mcp-client` (gemini-cli 0.64, measured).
	if (name.includes('gemini')) {
		return 'gemini';
	}
	// The chat's own OpenRouter agent introduces itself as `ai-browser-openrouter`.
	if (name.includes('openrouter')) {
		return 'openrouter';
	}
	// OpenCode sends `opencode` (2.1.1) and Pi `pi` (1.4.0), both measured. Pi's
	// is matched whole: a two-letter substring would claim half the clients there are.
	if (name.includes('opencode')) {
		return 'opencode';
	}
	if (name === 'pi') {
		return 'pi';
	}
	return 'other';
}

/** `clientInfo.name` from an `initialize` request, if this is one. */
export function initializeClientName(request: JsonRpcRequest): string | undefined {
	return request.method === 'initialize'
		? stringOrUndefined(request.params?.clientInfo?.name)
		: undefined;
}
