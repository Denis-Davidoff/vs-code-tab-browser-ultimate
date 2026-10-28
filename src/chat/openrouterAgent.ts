/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { chatCapability } from '../core/chatCapability';
import { openrouterApproval, type AgentEvent } from './agentProtocol';
import type { AgentBackend, AgentSession, BrowserServer, TurnInput } from './agents';
import type { AgentUsage, ChatCommand, ChatEntry, ChatModel, QuestionAnswers } from './chatProtocol';
import {
	CompletionReader, OpenRouterApiError, SseParser, completionBody, entriesToMessages, errorMessage, isRetryableStatus, mcpResultToText,
	mcpToolsToOpenAi, openrouterChatModels, redactSecrets, openrouterEndpoint, openrouterErrorText, openrouterKeySecret, openrouterMaxRetries, openrouterMaxRounds,
	parseToolArguments, readOpenRouterModels, retryDelayMs, messagesForModel, userContent,
	type OpenAiMessage, type OpenAiTool, type OpenRouterModel, type OpenRouterUsage,
} from './openrouterProtocol';

/**
 * OpenRouter, driven in this process: an HTTP API with no CLI behind it, so the
 * conversation loop is ours. A turn streams `/chat/completions` (server-sent
 * events), and when the model calls a tool it is run against this window's own
 * MCP server — the browser, the editor and the chat tools — and the result is
 * sent back, for at most `openrouterMaxRounds` model calls. See CLAUDE.md,
 * "OpenRouter".
 *
 * **What this agent cannot do**: it has no shell, no file reading and no file
 * editing of its own, and nothing here adds them. It is browser, editor and
 * chat tooling only; a task that needs the files or a command belongs to
 * Claude Code, Codex or Gemini.
 *
 * **Every tool call is a question to the chat first.** The session emits the
 * same `approval` event the CLIs' requests become, classified by
 * `ourToolClass`, and waits for `answer()`; Auto, Ask and Deny, the one-shot
 * terminal grants and the Chat control category are the chat's, unchanged.
 *
 * **The key** is read from SecretStorage through an injected accessor for each
 * request and kept in no field: not in an argument, a log line, an event or the
 * webview. It is sent only to the configured endpoint, which is https or a
 * loopback address.
 */

/** What the host gives the backend: the secrets, the settings and the saved chats. */
export interface OpenRouterConfig {
	/** The API key from SecretStorage (`openrouterKeySecret`); never kept. */
	apiKey(): Promise<string | undefined>;
	/** The raw `globalState` value of the configured models; validated here. */
	models(): unknown;
	/** The raw `aiBrowser.chat.openrouterEndpoint` setting. */
	endpoint(): string | undefined;
	/** The saved entries of the conversation whose `ref` this is, to rebuild it from. */
	entries(ref: string): readonly ChatEntry[] | undefined;
}

type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect?: 'manual' }) => Promise<Response>;

const noModelsText = vscode.l10n.t("No OpenRouter models are configured. Add models in Chat Settings, OpenRouter, then press Refresh Agents.");
/** No bytes from the service for this long ends the request. */
const idleMs = 90_000;
/** A model on this computer may spend minutes loading before its first byte. */
const localIdleMs = 600_000;
const mcpTimeoutMs = 30_000;
/** One reply is read up to this many bytes; a runaway stream cannot fill the host's memory. */
const maxStreamBytes = 16 * 1024 * 1024;

export class OpenRouterBackend implements AgentBackend {
	public readonly id = 'openrouter' as const;
	public readonly knownCommands: readonly ChatCommand[] = [];
	private readonly _sessions = new Set<OpenRouterSession>();
	private _disposed = false;

	constructor(
		private readonly _config: OpenRouterConfig,
		private readonly _browserServer: () => BrowserServer | undefined = () => undefined,
		private readonly _fetch: FetchLike = (input, init) => fetch(input, init),
	) { }

	public get running(): boolean { return [...this._sessions].some(session => session.running); }

	/** The configured models. Read from the stores on every call, so Refresh Agents finds a change. */
	public async models(): Promise<ChatModel[]> {
		if (this._disposed) {
			throw new Error('Closed.');
		}
		const configured = readOpenRouterModels(this._config.models());
		// The endpoint setting matters only to models that use it: a misspelt one must not hide models on this computer.
		const endpoint = openrouterEndpoint(this._config.endpoint());
		if ('error' in endpoint && configured.every(model => !model.endpoint)) {
			throw new Error(endpoint.error);
		}
		const models = openrouterChatModels(configured);
		if (!models.length) {
			throw new Error(noModelsText);
		}
		return models;
	}

	/** There are no slash commands or skills to list: OpenRouter is a model API. */
	public async commands(): Promise<ChatCommand[]> {
		return [];
	}

	/** OpenRouter's plan limits are the account's credits; nothing is read of them here. Tokens and cost are counted per turn. */
	public async usage(): Promise<AgentUsage> {
		return {
			agent: 'openrouter', windows: [],
			notes: [vscode.l10n.t("OpenRouter is billed by credits on your account, which this chat does not read. The tokens and, when OpenRouter returns it, the cost of each turn are counted here.")],
		};
	}

	public openSession(_cwd: string, resume?: string, _priorCostUsd?: number, _root?: string, _readDirs?: readonly string[], _ownSettings = true, chatId?: string): AgentSession {
		const browserServer = () => { const server = this._browserServer(); return server ? { ...server, chatId } : undefined; };
		const session = new OpenRouterSession(this._config, browserServer, this._fetch, resume, () => this._sessions.delete(session));
		this._sessions.add(session);
		return session;
	}

	public dispose(): void {
		this._disposed = true;
		for (const session of [...this._sessions]) {
			session.dispose();
		}
	}
}

interface Queued {
	readonly input: TurnInput;
	readonly model: string;
	readonly effort: string | undefined;
	readonly resolve: (sent: boolean) => void;
	readonly reject: (err: Error) => void;
}

/** A tool call the model made, resolved against the server's tool names. */
interface ToolRun {
	readonly call: { readonly id: string; readonly name: string; readonly arguments: string };
}

class StoppedError extends Error { }

class OpenRouterSession implements AgentSession {
	private _ref: string | undefined;
	private _announced = false;
	private _messages: OpenAiMessage[] = [];
	private _rebuilt = false;
	private _running = false;
	private _disposed = false;
	private _abort: AbortController | undefined;
	private _stopRequested = false;
	private _nextRow = 0;
	private _mcp: { sessionId: string | undefined; tools: readonly OpenAiTool[]; names: ReadonlyMap<string, string> } | undefined;
	private readonly _queue: Queued[] = [];
	private readonly _asked = new Map<string, (allow: boolean, withdrawn?: boolean) => void>();
	private readonly _onEvent = new vscode.EventEmitter<AgentEvent>();
	public readonly onEvent = this._onEvent.event;

	constructor(
		private readonly _config: OpenRouterConfig,
		private readonly _browserServer: () => BrowserServer | undefined,
		private readonly _fetch: FetchLike,
		resume: string | undefined,
		private readonly _onDispose: () => void,
	) {
		this._ref = resume;
	}

	public get ref(): string | undefined { return this._ref; }
	public get running(): boolean { return this._running; }

	public send(input: TurnInput, model: string, effort: string | undefined): Promise<boolean> {
		if (this._disposed) {
			return Promise.resolve(false);
		}
		if (this._running) {
			// A running turn is not steered: the message waits and goes as a turn of its own, as Gemini's does.
			return new Promise((resolve, reject) => this._queue.push({ input, model, effort, resolve, reject }));
		}
		return this._start(input, model, effort);
	}

	private async _start(input: TurnInput, model: string, effort: string | undefined): Promise<boolean> {
		this._running = true;
		this._stopRequested = false;
		let config: OpenRouterModel | undefined;
		try {
			config = readOpenRouterModels(this._config.models()).find(m => m.id === model);
			if (!config) {
				throw new Error(vscode.l10n.t("The model {0} is not among the configured OpenRouter models. Pick another, or add it and press Refresh Agents.", model));
			}
			if (!config.endpoint) {
				const endpoint = openrouterEndpoint(this._config.endpoint());
				if ('error' in endpoint) {
					throw new Error(endpoint.error);
				}
			}
		} catch (err) {
			this._running = false;
			this._dropQueue(err instanceof Error ? err.message : String(err));
			throw err;
		}
		if (this._disposed || this._stopRequested) {
			this._running = false;
			this._finish([{ type: 'turnEnd', error: 'Stopped.' }]);
			return false;
		}
		if (!this._announced) {
			this._announced = true;
			this._ref ??= `or-${randomUUID()}`;
			this.emit({ type: 'session', id: this._ref });
		}
		this._rebuildOnce();
		this._messages.push({ role: 'user', content: userContent(input.text, input.images, config.images === true) });
		this._abort = new AbortController();
		void this._turn(config, effort, this._abort.signal).then(events => this._finish(events), err => this._finish([{ type: 'turnEnd', error: err instanceof Error ? err.message : String(err) }]));
		return true;
	}

	/** A resumed conversation has no server session: its messages are rebuilt, once, from the saved chat. */
	private _rebuildOnce(): void {
		if (this._rebuilt) {
			return;
		}
		this._rebuilt = true;
		if (!this._ref || this._messages.length) {
			return;
		}
		const entries = this._config.entries(this._ref);
		const messages = entries ? entriesToMessages(entries) : [];
		// The saved chat may already hold the prompt being sent now, last and unanswered: it is the input, not history.
		while (messages.length && messages[messages.length - 1].role === 'user') {
			messages.pop();
		}
		this._messages = messages;
	}

	/** One turn: model calls and the tools they ask for, up to the round limit. Returns the events that end it. */
	private async _turn(model: OpenRouterModel, effort: string | undefined, signal: AbortSignal): Promise<AgentEvent[]> {
		const total = { input: 0, output: 0, cached: 0, cost: 0, hasCost: false };
		const add = (usage: OpenRouterUsage | undefined) => {
			if (!usage) { return; }
			total.input += usage.input; total.output += usage.output; total.cached += usage.cached;
			if (usage.costUsd !== undefined) { total.cost += usage.costUsd; total.hasCost = true; }
		};
		const ending = (error?: string): AgentEvent[] => [
			...(total.input || total.output ? [{ type: 'tokens', input: total.input, output: total.output, cached: total.cached, ...(total.hasCost ? { costUsd: total.cost } : {}), cumulative: false } as AgentEvent] : []),
			{ type: 'turnEnd', ...(error ? { error } : {}) },
		];
		let tools: readonly OpenAiTool[] = [];
		if (model.tools !== false) {
			try {
				tools = (await this._mcpTools(signal)).tools;
			} catch (err) {
				if (signal.aborted) { return ending('Stopped.'); }
				this.emit({ type: 'notice', text: vscode.l10n.t("The browser tools are not available in this turn ({0}). Check that the AI Browser MCP server is enabled.", err instanceof Error ? err.message : String(err)) });
			}
		}
		for (let round = 0; round < openrouterMaxRounds; round++) {
			let reader: CompletionReader;
			try {
				reader = await this._complete(model, effort, tools, signal, add);
			} catch (err) {
				if (err instanceof StoppedError || signal.aborted) { return ending('Stopped.'); }
				return ending(err instanceof Error ? err.message : String(err));
			}
			const calls = signal.aborted ? [] : reader.toolCalls();
			this._messages.push({
				role: 'assistant', content: reader.text || null,
				...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: call.arguments } })) } : {}),
			});
			if (signal.aborted) { return ending('Stopped.'); }
			if (!calls.length) {
				if (reader.finishReason === 'length') {
					this.emit({ type: 'notice', text: vscode.l10n.t("The model stopped because it reached its output limit. Ask it to continue, or raise maxTokens for this model.") });
				} else if (!reader.text && reader.finishReason !== 'stop') {
					this.emit({ type: 'notice', text: vscode.l10n.t("OpenRouter ended the turn without a reply. Send the message again or pick another model.") });
				}
				return ending();
			}
			let images: { mediaType: string; base64: string }[] = [];
			for (const call of calls) {
				const done = await this._runTool({ call }, model, signal);
				this._messages.push({ role: 'tool', tool_call_id: call.id, content: done.text });
				images = images.concat(done.images);
				if (signal.aborted) {
					// Every call of the assistant message needs its answer, or the API refuses the conversation.
					for (const rest of calls.slice(calls.indexOf(call) + 1)) {
						this._messages.push({ role: 'tool', tool_call_id: rest.id, content: 'Stopped by the user.' });
					}
					return ending('Stopped.');
				}
			}
			if (images.length) {
				// A tool message carries text only: a screenshot goes in a user message after the results, for a model that reads images.
				this._messages.push({ role: 'user', content: userContent('Images returned by the tools above:', images.slice(0, 4), model.images === true) });
			}
		}
		this.emit({ type: 'notice', text: vscode.l10n.t("The model made {0} requests in a row and was stopped. Send a message to let it continue.", openrouterMaxRounds) });
		return ending();
	}

	/** One `/chat/completions` request, streamed. Retries only a 429 or 5xx answered before any of the stream was read. */
	private async _complete(model: OpenRouterModel, effort: string | undefined, tools: readonly OpenAiTool[], signal: AbortSignal, usage: (u: OpenRouterUsage | undefined) => void): Promise<CompletionReader> {
		// A model on this computer goes to its own server and never carries the OpenRouter key.
		const local = model.endpoint !== undefined;
		const endpoint = local ? { url: model.endpoint as string } : openrouterEndpoint(this._config.endpoint());
		if ('error' in endpoint) {
			throw new Error(endpoint.error);
		}
		const body = JSON.stringify(completionBody({ model, messages: messagesForModel(this._messages, model.images === true), tools, effort }));
		for (let attempt = 0; ; attempt++) {
			const key = local ? undefined : await this._config.apiKey();
			if (signal.aborted) {
				throw new StoppedError();
			}
			const idle = new AbortController();
			const link = () => idle.abort();
			signal.addEventListener('abort', link, { once: true });
			let timer: NodeJS.Timeout | undefined;
			const touch = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(new Error('idle')), local ? localIdleMs : idleMs); };
			try {
				touch();
				let response: Response;
				try {
					response = await this._fetch(`${endpoint.url}/chat/completions`, {
						method: 'POST', signal: idle.signal, body, redirect: 'manual',
						headers: { ...(key ? { 'Authorization': `Bearer ${key}` } : {}), 'Content-Type': 'application/json', 'Accept': 'text/event-stream', 'X-Title': 'AI Browser' },
					});
				} catch (err) {
					if (signal.aborted) { throw new StoppedError(); }
					throw new Error(local
						? vscode.l10n.t("The local server at {0} could not be reached ({1}). Is Ollama or LM Studio running, with its server started?", endpoint.url, idle.signal.aborted ? 'no answer' : networkReason(err))
						: vscode.l10n.t("OpenRouter could not be reached ({0}). Check the connection, or the endpoint setting.", idle.signal.aborted ? 'no answer' : networkReason(err)));
				}
				if (response.status >= 300 && response.status < 400) {
					// A redirect is never followed: the key must reach only the configured address.
					throw new Error(local
						? vscode.l10n.t("The local server answered with a redirect, which is not followed. Check the model's Local server address.")
						: vscode.l10n.t("OpenRouter answered with a redirect, which is not followed. Check aiBrowser.chat.openrouterEndpoint."));
				}
				if (!response.ok) {
					const text = await response.text().then(t => t.slice(0, 4000)).catch(() => '');
					if (isRetryableStatus(response.status) && attempt < openrouterMaxRetries) {
						clearTimeout(timer);
						await delay(retryDelayMs(attempt, response.headers.get('retry-after')), signal);
						continue;
					}
					throw new OpenRouterApiError(redactSecrets(openrouterErrorText(response.status, text), key), response.status);
				}
				if (!response.body) {
					throw new Error('OpenRouter sent an empty answer.');
				}
				const reader = new CompletionReader();
				const sse = new SseParser();
				const decoder = new TextDecoder();
				const stream = response.body.getReader();
				let received = 0;
				const apply = (payloads: string[]) => {
					for (const payload of payloads) {
						const delta = reader.apply(payload);
						if (delta.thinking) { this.emit({ type: 'thinking', text: delta.thinking }); }
						if (delta.text) { this.emit({ type: 'text', text: delta.text }); }
					}
				};
				try {
					for (;;) {
						let read: { done: boolean; value?: Uint8Array };
						try {
							read = await stream.read();
						} catch (err) {
							if (signal.aborted) { throw new StoppedError(); }
							throw new Error(vscode.l10n.t("The OpenRouter stream broke off ({0}). Send the message again.", idle.signal.aborted ? 'no data for a long time' : networkReason(err, key)));
						}
						if (read.done) { break; }
						touch();
						received += read.value?.byteLength ?? 0;
						if (received > maxStreamBytes) { throw new Error(vscode.l10n.t("The OpenRouter reply was larger than expected and was cut off.")); }
						apply(sse.push(decoder.decode(read.value, { stream: true })));
						if (reader.done) { break; }
					}
					apply(sse.push(decoder.decode()));
					apply(sse.flush());
				} finally {
					stream.cancel().catch(() => undefined);
				}
				if (signal.aborted) { throw new StoppedError(); }
				if (!reader.done && !reader.finishReason) {
					throw new Error(vscode.l10n.t("The OpenRouter stream ended before the reply was complete. Send the message again."));
				}
				usage(reader.usage);
				return reader;
			} finally {
				clearTimeout(timer);
				signal.removeEventListener('abort', link);
			}
		}
	}

	/** Runs one tool call through the chat's approval pipeline, then the server. Always answers: a stop or a refusal is an answer. */
	private async _runTool(run: ToolRun, model: OpenRouterModel, signal: AbortSignal): Promise<{ text: string; images: { mediaType: string; base64: string }[] }> {
		const { call } = run;
		const serverName = this._mcp?.names.get(call.name);
		const row = `or-${++this._nextRow}`;
		const args = parseToolArguments(call.arguments);
		if (!serverName) {
			return { text: `Unknown tool: ${call.name}. Use only the tools you were given.`, images: [] };
		}
		const shown = `ai-browser · ${serverName}`;
		this.emit({ type: 'tool', id: row, tool: { kind: 'mcp', name: shown, ...(args ? { input: JSON.stringify(args, null, 2) } : {}) } });
		if (!args) {
			this.emit({ type: 'toolUpdate', id: row, update: { status: 'failed', output: 'The arguments were not a JSON object.' } });
			return { text: 'The arguments were not a valid JSON object. Call the tool again with valid JSON arguments.', images: [] };
		}
		const allowed = await this._ask(openrouterApproval(`${row}:ask`, serverName, args, call.arguments), signal);
		if (!allowed) {
			const stopped = signal.aborted;
			this.emit({ type: 'toolUpdate', id: row, update: { status: stopped ? 'stopped' : 'failed', output: stopped ? 'Stopped.' : 'Denied.' } });
			return { text: stopped ? 'Stopped by the user.' : 'The user denied this tool call. Do not retry it; continue without it or ask the user.', images: [] };
		}
		try {
			const result = mcpResultToText(await this._mcpCall('tools/call', { name: serverName, arguments: args }, signal, null), undefined);
			const images = model.images === true ? [...result.images] : [];
			const note = result.images.length ? `\n[${result.images.length} image${result.images.length === 1 ? '' : 's'} returned${images.length ? ', attached below' : ', not shown: this model is not configured to take images'}.]` : '';
			this.emit({ type: 'toolUpdate', id: row, update: { status: result.isError ? 'failed' : 'done', output: result.text + note } });
			return { text: (result.text + note) || '(no output)', images };
		} catch (err) {
			if (signal.aborted) {
				this.emit({ type: 'toolUpdate', id: row, update: { status: 'stopped', output: 'Stopped.' } });
				return { text: 'Stopped by the user.', images: [] };
			}
			const message = err instanceof Error ? err.message : String(err);
			this.emit({ type: 'toolUpdate', id: row, update: { status: 'failed', output: message } });
			return { text: `The tool failed: ${message}`, images: [] };
		}
	}

	/** Emits the card and waits for the chat's answer; a stop, a dispose or a closed session answers no. */
	private _ask(request: ReturnType<typeof openrouterApproval>, signal: AbortSignal): Promise<boolean> {
		if (signal.aborted || this._disposed) {
			return Promise.resolve(false);
		}
		return new Promise<boolean>(resolve => {
			const id = request.id;
			const onAbort = () => finish(false, true);
			// `withdrawn`: nobody answered, so the card is closed as no longer needed; a user's no is left as the chat recorded it.
			const finish = (allow: boolean, withdrawn = false) => {
				if (!this._asked.delete(id)) { return; }
				signal.removeEventListener('abort', onAbort);
				if (withdrawn) { this.emit({ type: 'approvalDone', id }); }
				resolve(allow);
			};
			this._asked.set(id, finish);
			signal.addEventListener('abort', onAbort, { once: true });
			this.emit({ type: 'approval', request });
		});
	}

	public answer(id: string, allow: boolean, _answers?: QuestionAnswers): void {
		this._asked.get(id)?.(allow);
	}

	/* ---- the MCP client: this window's own server ------------------------------------ */

	private async _mcpTools(signal: AbortSignal): Promise<{ tools: readonly OpenAiTool[]; names: ReadonlyMap<string, string> }> {
		if (this._mcp) {
			return this._mcp;
		}
		const server = this._browserServer();
		if (!server) {
			throw new Error('the MCP server is not running');
		}
		const init = await this._mcpCall('initialize', {
			protocolVersion: '2025-03-26', capabilities: {},
			clientInfo: { name: 'ai-browser-openrouter', version: extensionVersion() },
		}, signal, mcpTimeoutMs);
		void init;
		await this._mcpNotify('notifications/initialized', signal).catch(() => undefined);
		const listed = mcpToolsToOpenAi(await this._mcpCall('tools/list', {}, signal, mcpTimeoutMs));
		this._mcp = { sessionId: this._sessionId, tools: listed.tools, names: listed.names };
		return this._mcp;
	}

	private _sessionId: string | undefined;
	private _rpcId = 0;

	private async _post(body: unknown, signal: AbortSignal, timeoutMs: number | null): Promise<Response> {
		const server = this._browserServer();
		if (!server) {
			throw new Error('the MCP server is not running');
		}
		const headers: Record<string, string> = {
			'Authorization': `Bearer ${server.token}`, 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream',
		};
		if (server.chatId) { headers['X-AI-Browser-Chat'] = chatCapability(server.chatId); }
		if (this._sessionId) { headers['Mcp-Session-Id'] = this._sessionId; }
		const own = new AbortController();
		const link = () => own.abort();
		signal.addEventListener('abort', link, { once: true });
		const timer = timeoutMs === null ? undefined : setTimeout(() => own.abort(new Error('timeout')), timeoutMs);
		try {
			return await this._fetch(server.url, { method: 'POST', headers, body: JSON.stringify(body), signal: own.signal, redirect: 'manual' });
		} finally {
			clearTimeout(timer);
			signal.removeEventListener('abort', link);
		}
	}

	private async _mcpNotify(method: string, signal: AbortSignal): Promise<void> {
		await this._post({ jsonrpc: '2.0', method }, signal, mcpTimeoutMs);
	}

	/** One JSON-RPC request. A session id the server no longer knows (404) starts the handshake again, once. */
	private async _mcpCall(method: string, params: unknown, signal: AbortSignal, timeoutMs: number | null, retried = false): Promise<unknown> {
		const response = await this._post({ jsonrpc: '2.0', id: ++this._rpcId, method, params }, signal, timeoutMs);
		if (response.status === 404 && this._sessionId && !retried && method !== 'initialize') {
			this._sessionId = undefined;
			this._mcp = undefined;
			await this._mcpTools(signal);
			return this._mcpCall(method, params, signal, timeoutMs, true);
		}
		if (response.status === 401) {
			throw new Error('the MCP server refused the token — press Refresh Agents, or reload the window');
		}
		if (!response.ok) {
			throw new Error(`the MCP server answered HTTP ${response.status}`);
		}
		const fresh = response.headers.get('mcp-session-id');
		if (fresh) { this._sessionId = fresh; }
		const message: unknown = await response.json().catch(() => undefined);
		const record = message as { result?: unknown; error?: { message?: unknown } } | undefined;
		if (record?.error) {
			throw new Error(typeof record.error.message === 'string' ? record.error.message : 'the MCP server reported an error');
		}
		return record?.result;
	}

	/* ---- the turn's ends -------------------------------------------------------------- */

	private _finish(events: readonly AgentEvent[]): void {
		this._running = false;
		this._abort = undefined;
		const stopped = this._stopRequested;
		this._stopRequested = false;
		for (const event of events) {
			this.emit(event.type === 'turnEnd' && stopped ? { type: 'turnEnd', error: 'Stopped.' } : event);
		}
		const next = this._disposed ? undefined : this._queue.shift();
		if (!next) {
			return;
		}
		this.emit({ type: 'autoTurn' });
		this._start(next.input, next.model, next.effort).then(next.resolve, err => {
			next.resolve(false);
			this.emit({ type: 'turnEnd', error: err instanceof Error ? err.message : String(err) });
		});
	}

	public stop(): void {
		if (!this._running) {
			return;
		}
		this._stopRequested = true;
		this._abort?.abort();
		for (const finish of [...this._asked.values()]) { finish(false, true); }
	}

	private _dropQueue(reason?: string): void {
		for (const queued of this._queue.splice(0)) {
			if (reason) { queued.reject(new Error(reason)); } else { queued.resolve(false); }
		}
	}

	public emit(event: AgentEvent): void {
		if (!this._disposed) {
			this._onEvent.fire(event);
		}
	}

	public dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._abort?.abort();
		for (const finish of [...this._asked.values()]) { finish(false, true); }
		this._dropQueue();
		this._onEvent.dispose();
		this._onDispose();
	}
}

function networkReason(err: unknown, key?: string): string {
	const cause = (err as { cause?: { code?: unknown; message?: unknown } } | undefined)?.cause;
	const text = typeof cause?.code === 'string' ? cause.code : err instanceof Error ? err.message : String(err);
	return redactSecrets(text, key).replace(/[\u0000-\u001f]+/g, ' ').slice(0, 120);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) { reject(new StoppedError()); return; }
		const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
		const onAbort = () => { clearTimeout(timer); reject(new StoppedError()); };
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

function extensionVersion(): string {
	return vscode.extensions.getExtension('DenysDavydov.tab-browser-ultimate')?.packageJSON?.version ?? '0.0.0';
}

export { openrouterKeySecret, errorMessage };
