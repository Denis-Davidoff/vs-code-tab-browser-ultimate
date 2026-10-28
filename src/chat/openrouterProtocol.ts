/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URL } from 'node:url';
import type { ChatEntry, ChatModel } from './chatProtocol';

/**
 * OpenRouter's HTTP API, read as a leaf: no `vscode`, no relative value import,
 * so `npm test` loads it directly. OpenRouter is an OpenAI-compatible
 * `/chat/completions` endpoint with server-sent events and tool calling; the
 * agent that talks to it is `openrouterAgent.ts`. Everything that reads or
 * builds bytes lives here and is tested on recorded samples.
 *
 * **Not measured against the live service** (no key was available where this
 * was written): the shapes follow the OpenAI chat-completions format and
 * OpenRouter's documented differences — `reasoning` deltas, `usage.cost`, a
 * mid-stream `error` object, `: OPENROUTER PROCESSING` comment lines. The
 * agent was run against a local fake server instead; see CLAUDE.md.
 */

export const openrouterDefaultEndpoint = 'https://openrouter.ai/api/v1';
/** SecretStorage key of the API key. Never a setting, an argument, a log line or a state post. */
export const openrouterKeySecret = 'aiBrowser.openrouter.apiKey';
/** `globalState` key of the models the user configured. */
export const openrouterModelsKey = 'aiBrowser.openrouter.models';
export const openrouterMaxModels = 100;
/** Model calls in one turn: a model that keeps calling tools is stopped here, with a notice. */
export const openrouterMaxRounds = 25;
/** What one tool result may put into the conversation, in code points. */
export const openrouterToolResultLimit = 20_000;
export const openrouterMaxTools = 128;
/** Retries of a request the service answered 429 or 5xx, before any of its stream was read. */
export const openrouterMaxRetries = 3;
/** The history a resumed conversation is rebuilt from: its newest part, in code points. */
export const openrouterHistoryLimit = 400_000;

export type OpenRouterReasoning = 'low' | 'medium' | 'high';
export const openrouterEfforts: readonly OpenRouterReasoning[] = ['low', 'medium', 'high'];

export interface OpenRouterModel {
	readonly id: string;
	readonly name?: string;
	readonly maxTokens?: number;
	readonly temperature?: number;
	readonly reasoning?: OpenRouterReasoning;
	/** Whether the model is given the tools. Absent means yes. */
	readonly tools?: boolean;
	/** Whether the model takes images. Absent means no: an `image_url` is sent only when declared. */
	readonly images?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Cuts by code point, never leaving half of a surrogate pair (a strict JSON reader refuses a lone half). */
export function capCodePoints(text: string, limit: number): string {
	if (text.length <= limit) {
		return text;
	}
	const points = Array.from(text);
	return points.length <= limit ? text : points.slice(0, limit).join('');
}

function plain(text: string, limit: number): string {
	return capCodePoints(text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim(), limit);
}

/* ----------------------------------------------------------- configuration */

/**
 * The models the user configured, checked on every read. Anything that is not
 * a well-formed entry is dropped, never repaired: the list comes from
 * `globalState` and may have been written by hand. At most 100, the first of a
 * repeated id kept.
 */
export function readOpenRouterModels(raw: unknown): OpenRouterModel[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const out: OpenRouterModel[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (out.length >= openrouterMaxModels) {
			break;
		}
		if (!isRecord(item) || typeof item.id !== 'string') {
			continue;
		}
		const id = item.id.trim();
		if (!id || id.length > 200 || /[\u0000-\u001f\u007f\s]/.test(id) || seen.has(id)) {
			continue;
		}
		seen.add(id);
		const name = typeof item.name === 'string' && plain(item.name, 100) ? plain(item.name, 100) : undefined;
		const maxTokens = typeof item.maxTokens === 'number' && Number.isInteger(item.maxTokens) && item.maxTokens >= 1 && item.maxTokens <= 2_000_000 ? item.maxTokens : undefined;
		const temperature = typeof item.temperature === 'number' && Number.isFinite(item.temperature) && item.temperature >= 0 && item.temperature <= 2 ? item.temperature : undefined;
		const reasoning = (openrouterEfforts as readonly unknown[]).includes(item.reasoning) ? item.reasoning as OpenRouterReasoning : undefined;
		out.push({
			id,
			...(name ? { name } : {}), ...(maxTokens !== undefined ? { maxTokens } : {}), ...(temperature !== undefined ? { temperature } : {}),
			...(reasoning ? { reasoning } : {}),
			...(typeof item.tools === 'boolean' ? { tools: item.tools } : {}), ...(typeof item.images === 'boolean' ? { images: item.images } : {}),
		});
	}
	return out;
}

/** The model picker's entries. A model that declares `reasoning` offers low, medium and high, defaulting to what it declared. */
export function openrouterChatModels(models: readonly OpenRouterModel[]): ChatModel[] {
	return models.map((model, index) => {
		const notes = [model.tools === false ? 'no tools' : undefined, model.images ? 'images' : undefined].filter(Boolean);
		return {
			id: model.id,
			label: model.name ?? model.id,
			description: [model.name ? model.id : undefined, notes.length ? notes.join(', ') : undefined].filter(Boolean).join(' · ') || undefined,
			efforts: model.reasoning ? [...openrouterEfforts] : [],
			defaultEffort: model.reasoning,
			isDefault: index === 0,
		};
	});
}

/**
 * The endpoint setting: https, or http on a loopback address (a local
 * gateway or a test server), with no credentials, query or fragment in it.
 * The key is sent to this address, so anything else is refused outright.
 */
export function openrouterEndpoint(value: string | undefined): { readonly url: string } | { readonly error: string } {
	const text = (value ?? '').trim();
	if (!text) {
		return { url: openrouterDefaultEndpoint };
	}
	let parsed: URL;
	try {
		parsed = new URL(text);
	} catch {
		return { error: 'aiBrowser.chat.openrouterEndpoint is not a web address.' };
	}
	const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
	const loopback = host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
	if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
		return { error: 'aiBrowser.chat.openrouterEndpoint must be an https address, or http on this computer (localhost).' };
	}
	if (parsed.username || parsed.password || parsed.search || parsed.hash) {
		return { error: 'aiBrowser.chat.openrouterEndpoint must not carry credentials, a query or a fragment.' };
	}
	return { url: `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}` };
}

/* --------------------------------------------------------------------- SSE */

/**
 * Server-sent events, as OpenRouter sends them: `data: {json}` lines, a blank
 * line ending each event, `: comment` lines it uses as keep-alives
 * (`: OPENROUTER PROCESSING`), and a final `data: [DONE]`. Chunks arrive cut
 * anywhere — mid line, mid character excluded since the caller decodes as a
 * stream — so the parser keeps the unfinished tail.
 */
export class SseParser {
	private _buffer = '';
	private _data: string[] = [];

	/** The payloads of the events this chunk completed. */
	public push(chunk: string): string[] {
		this._buffer += chunk;
		const out: string[] = [];
		for (;;) {
			const match = /\r\n|\n|\r/.exec(this._buffer);
			if (!match || (match[0] === '\r' && match.index + 1 === this._buffer.length)) {
				// A lone CR at the very end may be the first half of CRLF: wait.
				break;
			}
			const line = this._buffer.slice(0, match.index);
			this._buffer = this._buffer.slice(match.index + match[0].length);
			this._line(line, out);
		}
		return out;
	}

	/** At the end of the stream: an event the server did not close with a blank line. */
	public flush(): string[] {
		const out: string[] = [];
		if (this._buffer) {
			this._line(this._buffer, out);
			this._buffer = '';
		}
		this._line('', out);
		return out;
	}

	private _line(line: string, out: string[]): void {
		if (line === '') {
			if (this._data.length) {
				out.push(this._data.join('\n'));
				this._data = [];
			}
			return;
		}
		if (line.startsWith(':')) {
			return;
		}
		const colon = line.indexOf(':');
		const field = colon === -1 ? line : line.slice(0, colon);
		if (field !== 'data') {
			return;
		}
		const value = colon === -1 ? '' : line.slice(colon + 1);
		this._data.push(value.startsWith(' ') ? value.slice(1) : value);
	}
}

/* ------------------------------------------------------------ the stream */

export interface OpenRouterUsage {
	readonly input: number;
	readonly output: number;
	readonly cached: number;
	readonly costUsd?: number;
}

export interface AssembledToolCall {
	readonly id: string;
	readonly name: string;
	/** The arguments text as the model wrote it; parse with `parseToolArguments`. */
	readonly arguments: string;
}

/** What one chunk added that the chat shows now. */
export interface ChunkDelta {
	readonly text: string;
	readonly thinking: string;
}

/** `usage` of a chunk, or of the answer: OpenAI's names plus OpenRouter's `cost`. */
export function readUsage(usage: unknown): OpenRouterUsage | undefined {
	if (!isRecord(usage)) {
		return undefined;
	}
	const input = num(usage.prompt_tokens);
	const output = num(usage.completion_tokens);
	const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
	const cost = typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : undefined;
	if (!input && !output && cost === undefined) {
		return undefined;
	}
	return { input, output, cached: num(details?.cached_tokens), ...(cost !== undefined ? { costUsd: cost } : {}) };
}

/** An error the service reports inside the stream, or as the whole body. */
export class OpenRouterApiError extends Error {
	public readonly status: number | undefined;
	constructor(message: string, status: number | undefined) {
		super(message);
		this.status = status;
	}
}

/**
 * One completion, assembled from its chunks: the text and the reasoning as
 * they come, tool calls put together from the pieces each chunk carries (the
 * name once, the arguments in fragments, all by `index`), the finish reason,
 * and the usage the last chunk reports.
 */
export class CompletionReader {
	public text = '';
	public finishReason: string | undefined;
	public usage: OpenRouterUsage | undefined;
	public done = false;
	private readonly _calls = new Map<number, { id: string; name: string; arguments: string }>();

	/** Applies one event's payload. Throws `OpenRouterApiError` for an error object in the stream. */
	public apply(payload: string): ChunkDelta {
		const empty: ChunkDelta = { text: '', thinking: '' };
		const trimmed = payload.trim();
		if (trimmed === '[DONE]') {
			this.done = true;
			return empty;
		}
		let chunk: unknown;
		try {
			chunk = JSON.parse(trimmed);
		} catch {
			return empty;
		}
		if (!isRecord(chunk)) {
			return empty;
		}
		if (isRecord(chunk.error)) {
			const code = typeof chunk.error.code === 'number' ? chunk.error.code : undefined;
			throw new OpenRouterApiError(openrouterErrorText(code, trimmed), code);
		}
		const usage = readUsage(chunk.usage);
		if (usage) {
			this.usage = usage;
		}
		let text = '';
		let thinking = '';
		for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
			if (!isRecord(choice)) {
				continue;
			}
			if (typeof choice.finish_reason === 'string') {
				this.finishReason = choice.finish_reason;
			}
			const delta = isRecord(choice.delta) ? choice.delta : {};
			if (typeof delta.content === 'string') {
				text += delta.content;
			}
			if (typeof delta.reasoning === 'string') {
				thinking += delta.reasoning;
			} else if (Array.isArray(delta.reasoning_details)) {
				// Only when `reasoning` is absent: OpenRouter sends both, with the same words.
				for (const detail of delta.reasoning_details) {
					if (isRecord(detail) && typeof (detail.text ?? detail.summary) === 'string') {
						thinking += (detail.text ?? detail.summary) as string;
					}
				}
			}
			for (const piece of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
				this._piece(piece);
			}
		}
		this.text += text;
		return { text, thinking };
	}

	private _piece(piece: unknown): void {
		if (!isRecord(piece)) {
			return;
		}
		const index = typeof piece.index === 'number' && Number.isInteger(piece.index) && piece.index >= 0 && piece.index < 1000 ? piece.index : this._calls.size;
		let call = this._calls.get(index);
		if (!call) {
			call = { id: '', name: '', arguments: '' };
			this._calls.set(index, call);
		}
		if (typeof piece.id === 'string' && piece.id && !call.id) {
			call.id = piece.id;
		}
		const fn = isRecord(piece.function) ? piece.function : {};
		// The name arrives whole, once; a provider that repeats it in every chunk must not double it.
		if (typeof fn.name === 'string' && fn.name && !call.name) {
			call.name = fn.name;
		}
		if (typeof fn.arguments === 'string') {
			call.arguments += fn.arguments;
		}
	}

	/** The tool calls, in the order the model made them; a call with no name is not one. */
	public toolCalls(): AssembledToolCall[] {
		return [...this._calls.entries()].sort((a, b) => a[0] - b[0])
			.filter(([, call]) => call.name)
			.map(([index, call]) => ({ id: call.id || `call_${index}`, name: call.name, arguments: call.arguments }));
	}
}

/** The arguments the model wrote, or `undefined` when they are not a JSON object. An empty text is no arguments. */
export function parseToolArguments(text: string): Record<string, unknown> | undefined {
	if (!text.trim()) {
		return {};
	}
	try {
		const value: unknown = JSON.parse(text);
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/* ------------------------------------------------------------------ errors */

/** The message inside an error body, as one short plain line. */
export function errorMessage(body: string): string {
	let message = '';
	try {
		const parsed: unknown = JSON.parse(body);
		if (isRecord(parsed) && isRecord(parsed.error)) {
			const meta = isRecord(parsed.error.metadata) ? parsed.error.metadata : undefined;
			message = [parsed.error.message, typeof meta?.raw === 'string' ? meta.raw : undefined].filter((v): v is string => typeof v === 'string' && !!v).join(' — ');
		} else if (isRecord(parsed) && typeof parsed.message === 'string') {
			message = parsed.message;
		}
	} catch {
		message = body;
	}
	return plain(redactSecrets(message), 300);
}

/** A service may echo a credential in an error body; what looks like one never reaches the chat. */
export function redactSecrets(text: string, key?: string): string {
	let out = key && key.length >= 4 ? text.split(key).join('[key]') : text;
	out = out.replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]{6,}/gi, 'Bearer [key]').replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[key]');
	return out;
}

/**
 * An HTTP status, or an error code carried in the stream, as the chat says it:
 * what went wrong and the next step. The text never holds the key (it is not
 * in the body either) and quotes the service's own words, cut and made plain.
 */
export function openrouterErrorText(status: number | undefined, body: string): string {
	const said = errorMessage(body);
	const suffix = said ? ` OpenRouter said: ${said}` : '';
	switch (status) {
		case 401:
			return `OpenRouter says the API key is invalid (HTTP 401, unauthorized). Store a valid key in VS Code's secret storage under ${openrouterKeySecret} and press Refresh Agents.${suffix}`;
		case 402:
			return `OpenRouter says the account has not enough credits for this request (HTTP 402). Add credits at https://openrouter.ai/credits, or pick a model that costs less or is free.${suffix}`;
		case 403:
			return `OpenRouter refused the request (HTTP 403): the input may have been flagged by moderation, or the key may not be allowed to use this model.${suffix}`;
		case 404:
			return `OpenRouter does not know this model, or no provider can serve it with these settings (HTTP 404). Check the model id, or turn off tools for it if it has none.${suffix}`;
		case 408:
			return `OpenRouter timed out waiting for the model (HTTP 408). Send the message again.${suffix}`;
		case 429:
			return `OpenRouter says this key or model is rate limited (HTTP 429). Wait a little and send the message again, or pick another model.${suffix}`;
		case 400:
			return `OpenRouter rejected the request as invalid (HTTP 400).${suffix || ' Check the model id and its settings.'}`;
		default:
			if (status !== undefined && status >= 500) {
				return `OpenRouter or the model's provider failed (HTTP ${status}). Send the message again, or pick another model.${suffix}`;
			}
			return `OpenRouter: the request failed${status !== undefined ? ` (HTTP ${status})` : ''}.${suffix}`;
	}
}

/** 429 and 5xx are worth another try; everything else says something that will not change. */
export function isRetryableStatus(status: number): boolean {
	return status === 429 || (status >= 500 && status <= 599);
}

/** Seconds to wait before retry `attempt` (0-based): 1, 2, 4, honouring `Retry-After` up to 30 s. */
export function retryDelayMs(attempt: number, retryAfter?: string | null): number {
	const asked = retryAfter && /^\d{1,5}(?:\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : undefined;
	const backoff = 1000 * 2 ** Math.min(Math.max(attempt, 0), 5);
	return Math.min(30_000, Math.max(asked ?? 0, backoff));
}

/* ------------------------------------------------------------------- tools */

export interface OpenAiTool {
	readonly type: 'function';
	readonly function: { readonly name: string; readonly description: string; readonly parameters: Record<string, unknown> };
}

/** A function name the API accepts: letters, digits, `_` and `-`, at most 64, and not one already taken. */
export function sanitiseToolName(name: string, taken: ReadonlySet<string>): string {
	const base = (name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 56) || 'tool');
	let candidate = base;
	for (let n = 2; taken.has(candidate); n++) {
		candidate = `${base}_${n}`;
	}
	return candidate;
}

/**
 * The server's `tools/list` as function tools. `names` maps the name the model
 * is given back to the server's own, which is what `tools/call` takes — and the
 * only names the agent will ever call: anything else the model invents is
 * refused. At most 128 tools.
 */
export function mcpToolsToOpenAi(result: unknown): { readonly tools: OpenAiTool[]; readonly names: ReadonlyMap<string, string> } {
	const tools: OpenAiTool[] = [];
	const names = new Map<string, string>();
	const list = isRecord(result) && Array.isArray(result.tools) ? result.tools : [];
	for (const tool of list) {
		if (tools.length >= openrouterMaxTools) {
			break;
		}
		if (!isRecord(tool) || typeof tool.name !== 'string' || !tool.name) {
			continue;
		}
		const given = sanitiseToolName(tool.name, new Set(names.keys()));
		names.set(given, tool.name);
		const schema = isRecord(tool.inputSchema) && tool.inputSchema.type === 'object' ? tool.inputSchema : { type: 'object', properties: {} };
		tools.push({
			type: 'function',
			function: { name: given, description: capCodePoints(typeof tool.description === 'string' ? tool.description : typeof tool.title === 'string' ? tool.title : '', 1500), parameters: schema },
		});
	}
	return { tools, names };
}

export interface McpToolResult {
	readonly text: string;
	readonly isError: boolean;
	readonly images: readonly { readonly mediaType: string; readonly base64: string }[];
}

/**
 * A `tools/call` result as the conversation carries it: its text blocks
 * joined and cut to `limit` code points with the cut said in words, its image
 * blocks set aside (a tool message holds text only), an error flagged.
 */
export function mcpResultToText(result: unknown, limit = openrouterToolResultLimit): McpToolResult {
	const blocks = isRecord(result) && Array.isArray(result.content) ? result.content : [];
	const parts: string[] = [];
	const images: { mediaType: string; base64: string }[] = [];
	for (const block of blocks) {
		if (!isRecord(block)) {
			continue;
		}
		if (block.type === 'text' && typeof block.text === 'string') {
			parts.push(block.text);
		} else if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string' && /^image\/(?:png|jpeg|gif|webp)$/.test(block.mimeType)) {
			images.push({ mediaType: block.mimeType, base64: block.data });
		}
	}
	let text = parts.join('\n');
	const all = Array.from(text).length;
	if (all > limit) {
		text = `${capCodePoints(text, limit)}\n… ${all - limit} more characters cut.`;
	}
	return { text, isError: isRecord(result) && result.isError === true, images };
}

/* ---------------------------------------------------------------- messages */

export type OpenAiContentPart = { readonly type: 'text'; readonly text: string } | { readonly type: 'image_url'; readonly image_url: { readonly url: string } };

export type OpenAiMessage =
	| { readonly role: 'system'; readonly content: string }
	| { readonly role: 'user'; readonly content: string | readonly OpenAiContentPart[] }
	| { readonly role: 'assistant'; readonly content: string | null; readonly tool_calls?: readonly { readonly id: string; readonly type: 'function'; readonly function: { readonly name: string; readonly arguments: string } }[] }
	| { readonly role: 'tool'; readonly tool_call_id: string; readonly content: string };

/**
 * A user turn's content. Images go as `image_url` data URLs only for a model
 * that declared `images`; for any other they are named in the text, so the
 * model is not sent what it cannot read.
 */
export function userContent(text: string, images: readonly { readonly mediaType: string; readonly base64: string }[], imagesAllowed: boolean): string | readonly OpenAiContentPart[] {
	if (!images.length) {
		return text;
	}
	if (!imagesAllowed) {
		return `${text}\n\n[${images.length} image${images.length === 1 ? '' : 's'} attached, not shown: this model is not configured to take images.]`.trim();
	}
	return [
		{ type: 'text', text: text || 'See the attached image.' },
		...images.map((image): OpenAiContentPart => ({ type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.base64}` } })),
	];
}

/** The messages as one model may receive them: for a model not configured for images, every `image_url` part of the history becomes a text note. */
export function messagesForModel(messages: readonly OpenAiMessage[], imagesAllowed: boolean): OpenAiMessage[] {
	if (imagesAllowed) {
		return [...messages];
	}
	return messages.map(m => {
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content) || !content.some(part => (part as OpenAiContentPart).type === 'image_url')) {
			return m;
		}
		const parts = content as OpenAiContentPart[];
		const count = parts.filter(part => part.type === 'image_url').length;
		const text = parts.filter((part): part is Extract<OpenAiContentPart, { type: 'text' }> => part.type === 'text').map(part => part.text).join('\n');
		return { ...m, content: `${text}\n\n[${count} image${count === 1 ? '' : 's'} attached earlier, not shown: this model is not configured to take images.]`.trim() } as OpenAiMessage;
	});
}

/**
 * A resumed conversation, rebuilt from the saved chat: its prompts and the
 * agent's replies, in order. Tool calls are not replayed — the stored rows hold
 * a cut copy of their output, and an assistant tool call with no matching
 * result is refused by the API — so a resumed chat remembers what was said, not
 * what the tools returned. The newest part that fits `limit` code points is
 * kept, starting at a prompt.
 */
export function entriesToMessages(entries: readonly ChatEntry[], limit = openrouterHistoryLimit): OpenAiMessage[] {
	const messages: { role: 'user' | 'assistant'; content: string }[] = [];
	for (const entry of entries) {
		if (entry.kind === 'user' && entry.text.trim()) {
			messages.push({ role: 'user', content: entry.text });
		} else if (entry.kind === 'assistant' && entry.text.trim()) {
			const last = messages[messages.length - 1];
			if (last?.role === 'assistant') {
				last.content += `\n\n${entry.text}`;
			} else {
				messages.push({ role: 'assistant', content: entry.text });
			}
		}
	}
	let total = 0;
	let from = messages.length;
	while (from > 0 && total + messages[from - 1].content.length <= limit) {
		total += messages[from - 1].content.length;
		from--;
	}
	const kept = messages.slice(from);
	while (kept.length && kept[0].role !== 'user') {
		kept.shift();
	}
	return kept;
}

export interface CompletionRequestOptions {
	readonly model: OpenRouterModel;
	readonly messages: readonly OpenAiMessage[];
	readonly tools: readonly OpenAiTool[];
	/** The effort the user picked, or undefined for the model's own. */
	readonly effort?: string;
}

/** The `/chat/completions` body: streamed, usage included, tools only for a model not configured without them. */
export function completionBody(options: CompletionRequestOptions): Record<string, unknown> {
	const { model } = options;
	const effort = (openrouterEfforts as readonly string[]).includes(options.effort ?? '') ? options.effort : model.reasoning;
	return {
		model: model.id,
		messages: options.messages,
		stream: true,
		usage: { include: true },
		...(options.tools.length && model.tools !== false ? { tools: options.tools, tool_choice: 'auto' } : {}),
		...(model.maxTokens !== undefined ? { max_tokens: model.maxTokens } : {}),
		...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
		...(model.reasoning && effort ? { reasoning: { effort } } : {}),
	};
}

/* ------------------------------------------------------ settings and catalog */

/** An id as OpenRouter writes one: `vendor/model`, optionally `~vendor/…` or a `:variant` (`:free`, `:online`). */
const modelIdPattern = /^[A-Za-z0-9~][A-Za-z0-9._:/~+@-]{0,199}$/;

/** What the settings page may send: numbers and flags absent or null mean "not set". */
export type OpenRouterModelResult = { readonly model: OpenRouterModel } | { readonly error: string };

function optionalNumber(value: unknown, label: string, min: number, max: number, integer: boolean): { readonly value?: number } | { readonly error: string } {
	if (value === undefined || value === null || value === '') {
		return {};
	}
	if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
		return { error: `${label} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}.` };
	}
	return { value };
}

/**
 * One model as the settings page sent it, checked field by field with a reason
 * for the first problem. What is not valid is refused, never repaired: a
 * clamped temperature or a trimmed-away id would save something the user did
 * not type. Strings are cut by code point and stripped of control characters.
 */
export function validateOpenRouterModel(input: unknown): OpenRouterModelResult {
	if (!isRecord(input)) {
		return { error: 'A model must be an object.' };
	}
	const id = typeof input.id === 'string' ? input.id.trim() : '';
	if (!id) {
		return { error: 'A model needs an id, such as anthropic/claude-sonnet-4.' };
	}
	if (!modelIdPattern.test(id)) {
		return { error: `"${plain(id, 60)}" is not a model id: use letters, digits and . _ : / ~ + @ - with no spaces, up to 200 characters.` };
	}
	const name = typeof input.name === 'string' ? plain(input.name, 100) : '';
	if (input.name !== undefined && input.name !== null && typeof input.name !== 'string') {
		return { error: `The name of ${id} must be text.` };
	}
	const maxTokens = optionalNumber(input.maxTokens, `Max tokens of ${id}`, 1, 2_000_000, true);
	if ('error' in maxTokens) { return maxTokens; }
	const temperature = optionalNumber(input.temperature, `Temperature of ${id}`, 0, 2, false);
	if ('error' in temperature) { return temperature; }
	let reasoning: OpenRouterReasoning | undefined;
	if (input.reasoning !== undefined && input.reasoning !== null && input.reasoning !== '') {
		if (!(openrouterEfforts as readonly unknown[]).includes(input.reasoning)) {
			return { error: `Reasoning of ${id} must be low, medium or high.` };
		}
		reasoning = input.reasoning as OpenRouterReasoning;
	}
	for (const flag of ['tools', 'images'] as const) {
		if (input[flag] !== undefined && input[flag] !== null && typeof input[flag] !== 'boolean') {
			return { error: `${flag === 'tools' ? 'Supports tools' : 'Supports images'} of ${id} must be on or off.` };
		}
	}
	return {
		model: {
			id,
			...(name ? { name } : {}),
			...(maxTokens.value !== undefined ? { maxTokens: maxTokens.value } : {}),
			...(temperature.value !== undefined ? { temperature: temperature.value } : {}),
			...(reasoning ? { reasoning } : {}),
			...(typeof input.tools === 'boolean' ? { tools: input.tools } : {}),
			...(typeof input.images === 'boolean' ? { images: input.images } : {}),
		},
	};
}

/** The whole list the page sent: every entry valid, no id twice (case-insensitively, as the service reads them), at most 100. */
export function validateOpenRouterModels(input: unknown): { readonly models: OpenRouterModel[] } | { readonly error: string } {
	if (!Array.isArray(input)) {
		return { error: 'The model list must be a list.' };
	}
	if (input.length > openrouterMaxModels) {
		return { error: `At most ${openrouterMaxModels} models can be configured.` };
	}
	const models: OpenRouterModel[] = [];
	const seen = new Set<string>();
	for (const item of input) {
		const result = validateOpenRouterModel(item);
		if ('error' in result) {
			return result;
		}
		const key = result.model.id.toLowerCase();
		if (seen.has(key)) {
			return { error: `${result.model.id} is in the list twice.` };
		}
		seen.add(key);
		models.push(result.model);
	}
	return { models };
}

/**
 * An API key as typed or pasted: one token of printable ASCII, no spaces. The
 * text of a refusal never contains the key, only its length class, since this
 * is the one function that sees a secret the view has just sent.
 */
export function validateOpenRouterKey(input: unknown): { readonly key: string } | { readonly error: string } {
	if (typeof input !== 'string') {
		return { error: 'The API key must be text.' };
	}
	const key = input.trim();
	if (!key) {
		return { error: 'Type or paste an API key.' };
	}
	if (key.length < 10 || key.length > 512) {
		return { error: 'That does not look like an API key (it is too short or too long).' };
	}
	if (!/^[\x21-\x7e]+$/.test(key)) {
		return { error: 'An API key is one piece of text with no spaces or line breaks.' };
	}
	return { key };
}

/** One model of OpenRouter's catalogue, as the settings page lists it. Prices are US dollars per million tokens. */
export interface OpenRouterCatalogEntry {
	readonly id: string;
	readonly name: string;
	readonly contextLength?: number;
	readonly promptPrice?: number;
	readonly completionPrice?: number;
	readonly maxCompletion?: number;
	readonly tools: boolean;
	readonly images: boolean;
	readonly reasoning: boolean;
}

export const openrouterCatalogMaxEntries = 2_000;
/** The catalogue response is read up to this many bytes; the real one is a few megabytes. */
export const openrouterCatalogMaxBytes = 12 * 1024 * 1024;
export const openrouterCatalogTimeoutMs = 15_000;
export const openrouterCatalogTtlMs = 10 * 60_000;
export const openrouterCatalogPageSize = 30;

function priceOf(value: unknown): number | undefined {
	// OpenRouter writes prices as strings of dollars per token ("0.000003"); "-1" marks a variable price.
	const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
	return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e4) / 1e4 : undefined;
}

function positiveInt(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Reads `GET /models`. Entries that are not well-formed are skipped; the names are plain text, never markup. */
export function readOpenRouterCatalog(body: unknown): OpenRouterCatalogEntry[] {
	const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
	const out: OpenRouterCatalogEntry[] = [];
	for (const item of data) {
		if (out.length >= openrouterCatalogMaxEntries) {
			break;
		}
		if (!isRecord(item) || typeof item.id !== 'string' || !modelIdPattern.test(item.id)) {
			continue;
		}
		const pricing = isRecord(item.pricing) ? item.pricing : {};
		const architecture = isRecord(item.architecture) ? item.architecture : {};
		const params = Array.isArray(item.supported_parameters) ? item.supported_parameters : [];
		const inputs = Array.isArray(architecture.input_modalities) ? architecture.input_modalities : [];
		const top = isRecord(item.top_provider) ? item.top_provider : {};
		const name = typeof item.name === 'string' ? plain(item.name, 100) : '';
		const contextLength = positiveInt(item.context_length);
		const promptPrice = priceOf(pricing.prompt);
		const completionPrice = priceOf(pricing.completion);
		const maxCompletion = positiveInt(top.max_completion_tokens);
		out.push({
			id: item.id, name: name || item.id,
			...(contextLength ? { contextLength } : {}),
			...(promptPrice !== undefined ? { promptPrice } : {}), ...(completionPrice !== undefined ? { completionPrice } : {}),
			...(maxCompletion ? { maxCompletion } : {}),
			tools: params.includes('tools'), images: inputs.includes('image'), reasoning: params.includes('reasoning') || params.includes('include_reasoning'),
		});
	}
	return out;
}

/**
 * Filters the catalogue: every word of the query must occur in the id or name
 * (case-insensitively); an id starting with the query, then one holding it as
 * typed, come first. No query lists the start of the catalogue. At most
 * `limit` entries are returned with the total that matched.
 */
export function searchOpenRouterCatalog(entries: readonly OpenRouterCatalogEntry[], query: string, limit = openrouterCatalogPageSize): { readonly entries: OpenRouterCatalogEntry[]; readonly total: number } {
	const text = query.trim().toLowerCase().slice(0, 100);
	const words = text.split(/\s+/).filter(Boolean);
	const scored: { entry: OpenRouterCatalogEntry; score: number; index: number }[] = [];
	entries.forEach((entry, index) => {
		const id = entry.id.toLowerCase();
		const hay = `${id} ${entry.name.toLowerCase()}`;
		if (!words.every(word => hay.includes(word))) {
			return;
		}
		scored.push({ entry, index, score: !text ? 0 : id.startsWith(text) ? 0 : id.includes(text) ? 1 : 2 });
	});
	scored.sort((a, b) => a.score - b.score || a.index - b.index);
	return { entries: scored.slice(0, Math.max(0, limit)).map(s => s.entry), total: scored.length };
}

export type CatalogFetch = (url: string, init: { readonly signal: AbortSignal; readonly headers: Record<string, string> }) => Promise<Response>;

/**
 * `GET <endpoint>/models`, bounded: 15 s for the whole request, the body read
 * as a stream and refused past 12 MB, at most 2 000 entries kept. The key is
 * not sent — the catalogue is public, and a key sent where it is not needed
 * is a key a mistyped endpoint receives for nothing. `outer` ends it early.
 */
export async function fetchOpenRouterCatalog(fetchLike: CatalogFetch, endpoint: string, outer?: AbortSignal): Promise<OpenRouterCatalogEntry[]> {
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(new Error('timeout')), openrouterCatalogTimeoutMs);
	const onOuter = () => timeout.abort(outer?.reason);
	outer?.addEventListener('abort', onOuter, { once: true });
	try {
		const response = await fetchLike(`${endpoint}/models`, { signal: timeout.signal, headers: { Accept: 'application/json' } });
		if (!response.ok) {
			throw new Error(`OpenRouter answered ${response.status} to the model list request.`);
		}
		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error('OpenRouter sent no model list.');
		}
		const chunks: Uint8Array[] = [];
		let size = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			size += value.byteLength;
			if (size > openrouterCatalogMaxBytes) {
				await reader.cancel().catch(() => undefined);
				throw new Error('The model list from OpenRouter is larger than expected and was refused.');
			}
			chunks.push(value);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		} catch {
			throw new Error('OpenRouter sent a model list that is not JSON.');
		}
		const entries = readOpenRouterCatalog(parsed);
		if (!entries.length) {
			throw new Error('OpenRouter sent a model list with no models in it.');
		}
		return entries;
	} catch (error) {
		if (timeout.signal.aborted && !outer?.aborted) {
			throw new Error('OpenRouter did not answer the model list request within 15 seconds.');
		}
		throw error instanceof Error ? error : new Error(String(error));
	} finally {
		clearTimeout(timer);
		outer?.removeEventListener('abort', onOuter);
	}
}
