/**
 * The `chat_*` MCP tools: the AI Browser chat as an agent sees it, and a few
 * controls for the chat's own agents — keep the computer awake, hold or
 * release their tab's queue, stop one of their own background agents.
 *
 * The data lives in `ChatViewProvider`, which is created after the MCP server,
 * so the server holds a {@link ChatControlPort} and the provider fills it in —
 * the same shape as `BrowserRecording.destination`.
 *
 * **Kept narrow on purpose**, each limit closing a way to reach what the user
 * did not hand over:
 * - Any caller with the token gets `chat_state` without content — statuses and
 *   counts, no titles, no messages — and `chat_usage`.
 * - Everything else needs the `X-AI-Browser-Chat` value the chat hands its own
 *   CLIs (`chatCapability.ts`: minted in memory per conversation, never the chat
 *   id), naming a conversation open in a tab. An assistant in a terminal has
 *   the token and no business with the user's conversations.
 * - **A chat agent sees and acts on its own tab only**: no tab id is taken or
 *   given. An agent stopping or pausing the conversation beside it is not
 *   something a card showing an opaque id could let the user judge.
 * - The acting tools are a category of their own in the approval menu, "Chat
 *   control" (`chatControlTools` in `agentProtocol.ts`), Ask unless set.
 *
 * The header value is not a boundary against the user's own code with a
 * shell: it is in a running Claude Code's `--mcp-config` file, and such code
 * can end a CLI with `kill` anyway.
 */

import type { ArtifactKind } from '../chat/visualizationProtocol';
import { schema, number, string, textArgument, numberArgument, type Caller, type Tool } from './mcpProtocol';
import type { TerminalAgentApi } from './terminalTools';
import type { TerminalGrants } from './terminalGrants';

/** The four that act; `chatControlTools` in `agentProtocol.ts` is the same list, written twice. */
export const chatToolNames = ['chat_keep_awake', 'chat_pause', 'chat_resume', 'chat_stop_agent'] as const;

/** A keep-awake choice as the tool takes it; `ChatControl.keepAwake` maps it onto `SleepChoice`. */
export type KeepAwakeRequest =
	| { readonly mode: 'off' }
	| { readonly mode: 'timer'; readonly minutes: number }
	| { readonly mode: 'agents'; readonly scope: 'tab' | 'window' };

/** What the chat answers, for the caller's own tab where one is named. Every method throws an `Error` a model can act on. */
export interface ChatControl {
	presentRich(ownTab: string, kind: string, args: Record<string, unknown>): Promise<unknown>;
	presentArtifact(ownTab: string, file: string, kind: ArtifactKind, title?: string): Promise<unknown>;
	presentImage(ownTab: string, file: string, title?: string): Promise<unknown>;
	presentHtml(ownTab: string, file: string, title?: string): Promise<unknown>;
	/** The open tab whose conversation `chatId` names, by our tab id. */
	tabOf(chatId: string): string | undefined;
	state(ownTab: string | undefined): unknown;
	agents(ownTab: string): unknown;
	usage(ownTab: string | undefined): unknown;
	keepAwake(ownTab: string, request: KeepAwakeRequest): unknown;
	pause(ownTab: string): unknown;
	resume(ownTab: string): unknown;
	stopAgent(ownTab: string, rowId: string): Promise<unknown>;
	/**
	 * The `terminal_*` tools' side (`terminalTools.ts`): the terminals pinned to a
	 * conversation, which only the chat can resolve across every surface.
	 */
	readonly terminal: TerminalAgentApi;
	/** The approvals of typing into a terminal, minted by the chat and consumed by the tools. One store for every surface. */
	readonly grants: TerminalGrants;
	/** Whether the approval menu's Terminal row is on Deny: every terminal tool then refuses, whatever a CLI's own rules allowed. */
	terminalDenied(chatId: string): boolean;
}

/** Filled in by the chat once it exists. */
export class ChatControlPort {
	public target: ChatControl | undefined;
}

function control(port: ChatControlPort): ChatControl {
	if (!port.target) {
		throw new Error('The AI Browser chat is not available in this window.');
	}
	return port.target;
}

/** The caller's own tab, when it is one of the chat's agents with its conversation open. */
function ownTab(port: ChatControlPort, caller: Caller): string | undefined {
	return caller.chatId ? port.target?.tabOf(caller.chatId) : undefined;
}

/** Refuses an assistant that is not one of the chat's own; answers its tab. */
function requireOwnTab(port: ChatControlPort, caller: Caller, what: string): string {
	const tab = caller.chatId ? control(port).tabOf(caller.chatId) : undefined;
	if (!tab) {
		throw new Error(caller.chatId
			? `Cannot ${what}: the conversation this call came from is no longer open in a tab.`
			: `Only the agents of the AI Browser chat can ${what}, for their own tab. Other assistants may read chat_state and chat_usage.`);
	}
	return tab;
}

export function chatTools(port: ChatControlPort): Tool[] {
	return [
		{
			name: 'chat_present_html', title: 'Display an HTML visualization',
			description: 'Display or update a completed self-contained HTML visualization in your own AI Browser conversation. Write the file directly in the conversation visualization directory supplied with the prompt, then call this tool with its absolute path. Reuse the path to update the existing card. At most 1 MB. Inline CSS/JavaScript, SVG, canvas and MathML work; external resources, network requests and host commands are blocked. Local preview only, no cloud publication. Do not repeat a visualize marker after a successful call.',
			inputSchema: schema({ path: string('Absolute path to the completed HTML file'), title: string('Short display title') }, ['path']),
			run: async (args, caller) => {
				const tab = requireOwnTab(port, caller, 'display HTML');
				const title = args.title === undefined ? undefined : textArgument(args.title, 'title');
				if (title && title.length > 160) { throw new Error('Use a title of at most 160 characters.'); }
				const file = textArgument(args.path, 'path');
				if (!file) { throw new Error('path is required.'); }
				return control(port).presentHtml(tab, file, title);
			},
		},
		{
			name: 'chat_present_image', title: 'Display an image',
			description: 'Display or update a PNG, JPEG, GIF or WebP image in your own AI Browser conversation. Copy the completed image directly into the conversation visualization directory supplied with the prompt, then pass its absolute path. At most 4 MB. Reuse the same path to update the card. The image is saved with the conversation and displayed across VS Code, Chrome and Exchange. No additional image reference is needed after success.',
			inputSchema: schema({ path: string('Absolute path to the completed image in the conversation visualization directory'), title: string('Short display title') }, ['path']),
			run: async (args, caller) => {
				const tab = requireOwnTab(port, caller, 'display an image');
				const title = args.title === undefined ? undefined : textArgument(args.title, 'title');
				if (title && title.length > 160) { throw new Error('Use a title of at most 160 characters.'); }
				const file = textArgument(args.path, 'path');
				if (!file) { throw new Error('path is required.'); }
				return control(port).presentImage(tab, file, title);
			},
		},
		...(['file', 'table', 'audio', 'video', 'sources'] as const).map((kind): Tool => ({
			name: `chat_present_${kind}`, title: `Display ${kind === 'sources' ? 'sources' : `a ${kind}`}`,
			description: ({
				file: 'Display a downloadable file (PDF, document, archive, spreadsheet or other format), up to 4 MB.',
				table: 'Display a searchable, sortable, paginated table from a UTF-8 JSON file with columns (1–100 strings) and rows (up to 10000 arrays of matching length). Cells may be strings, finite numbers, booleans or null. At most 1 MB.',
				sources: 'Display source cards from a UTF-8 JSON array of up to 100 objects: {title, url, description?}. URLs must be HTTP or HTTPS without credentials. At most 1 MB. Sources are supplied by you; the display does not verify or fetch them.',
				audio: 'Display a native audio player for MP3, WAV, OGG, M4A or WebM audio, up to 4 MB. Playback depends on client codec support.',
				video: 'Display a native video player for MP4 or WebM video, up to 4 MB. Playback depends on client codec support.',
			})[kind] + ' Copy the completed file directly into the conversation visualization directory supplied with the prompt. Takes an absolute path. Available only in your own conversation. Reusing the path updates the card. Saved with the conversation and displayed in VS Code, Chrome and Exchange. Do not emit an extra marker after success.',
			inputSchema: schema({ path: string('Absolute path to the completed file in the conversation visualization directory'), title: string('Short display title') }, ['path']),
			run: async (args, caller) => {
				const tab = requireOwnTab(port, caller, `display ${kind}`);
				const title = args.title === undefined ? undefined : textArgument(args.title, 'title');
				if (title && title.length > 160) { throw new Error('Use a title of at most 160 characters.'); }
				const file = textArgument(args.path, 'path');
				if (!file) { throw new Error('path is required.'); }
				return control(port).presentArtifact(tab, file, kind, title);
			},
		})),
		...richTools(port),
		{
			name: 'chat_state', title: 'AI Browser chat: tabs',
			description: 'The AI Browser chat\'s open tabs: status (working, waiting for the user\'s answer, unread, failed, read), '
				+ 'how many agents and background toolbar skills run, how many messages are queued and whether the queue is paused, '
				+ 'and whether the computer is kept awake. For the chat\'s own agents, their own tab (own: true) also has its title '
				+ 'and its last reply. Other tabs\' conversations are not shown.',
			inputSchema: schema({}),
			run: async (_args, caller) => control(port).state(ownTab(port, caller)),
		},
		{
			name: 'chat_agents', title: 'AI Browser chat: your agents',
			description: 'The agents started in your own chat tab — sub-agents, background agents, toolbar skills run in the '
				+ 'background — newest first, with status, type, model, how long they have run, tokens, tool uses, the tool they '
				+ 'are on, and the last thing each said, short. The ids are for chat_stop_agent. The chat\'s own agents only.',
			inputSchema: schema({}),
			run: async (_args, caller) => control(port).agents(requireOwnTab(port, caller, 'list agents')),
		},
		{
			name: 'chat_usage', title: 'AI Browser chat: plan limits',
			description: 'What is known of each agent\'s plan limits — the share used of each window, when it resets, whether the '
				+ 'agent is spending credits — and, for the chat\'s own agents, how full their conversation\'s context window is. '
				+ 'Figures are the last the CLIs reported; nothing is asked of the provider for this call.',
			inputSchema: schema({}),
			run: async (_args, caller) => control(port).usage(ownTab(port, caller)),
		},
		{
			name: 'chat_keep_awake', title: 'Keep the computer awake',
			description: 'Keeps the computer from sleeping (the display may still sleep): for a number of minutes, rounded up to '
				+ 'the nearest choice the chat offers (5 minutes to 72 hours); or until the agents finish — scope "tab" waits on '
				+ 'your own tab, "window" on every tab; or "off". The chat\'s own agents only; the user is asked unless their '
				+ 'approval menu allows Chat control.',
			inputSchema: schema({
				mode: { type: 'string', enum: ['timer', 'agents', 'off'], description: 'timer, until the agents finish, or off' },
				minutes: number('For timer: how long, in minutes'),
				scope: { type: 'string', enum: ['tab', 'window'], description: 'For agents: your own tab or every tab; default tab' },
			}, ['mode']),
			run: async (args, caller) => {
				const own = requireOwnTab(port, caller, 'keep the computer awake');
				const mode = textArgument(args.mode, 'mode');
				if (mode === 'off') {
					return control(port).keepAwake(own, { mode: 'off' });
				}
				if (mode === 'timer') {
					const minutes = numberArgument(args.minutes, 'minutes');
					if (minutes === undefined || !(minutes > 0)) {
						throw new Error('`minutes` is required for a timer, and must be more than 0.');
					}
					return control(port).keepAwake(own, { mode: 'timer', minutes });
				}
				if (mode === 'agents') {
					const scope = textArgument(args.scope, 'scope') ?? 'tab';
					if (scope !== 'tab' && scope !== 'window') {
						throw new Error('`scope` must be "tab" or "window".');
					}
					return control(port).keepAwake(own, { mode: 'agents', scope });
				}
				throw new Error('`mode` must be "timer", "agents" or "off".');
			},
		},
		{
			name: 'chat_pause', title: 'Pause your chat tab\'s queue',
			description: 'Holds your own tab\'s queue: the turn running goes on to its end, and nothing queued — messages, a toolbar '
				+ 'skill\'s next prompts, a skill queued for after the turn — goes out until chat_resume or the user resumes it. '
				+ 'Nothing is stopped or lost. The chat\'s own agents only; asked unless allowed.',
			inputSchema: schema({}),
			run: async (_args, caller) => control(port).pause(requireOwnTab(port, caller, 'pause a chat')),
		},
		{
			name: 'chat_resume', title: 'Resume your chat tab\'s queue',
			description: 'Releases your own tab\'s queue held by chat_pause: what is queued goes out, one message at a time, once '
				+ 'the tab is idle. The chat\'s own agents only; asked unless allowed.',
			inputSchema: schema({}),
			run: async (_args, caller) => control(port).resume(requireOwnTab(port, caller, 'resume a chat')),
		},
		{
			name: 'chat_stop_agent', title: 'Stop one of your agents',
			description: 'Stops one running agent of your own chat tab — a sub-agent, a background agent or a toolbar skill run '
				+ 'in the background — leaving the turn and the other agents running. The id is from chat_agents. '
				+ 'The chat\'s own agents only; asked unless allowed.',
			inputSchema: schema({ id: string('The agent\'s id, from chat_agents') }, ['id']),
			run: async (args, caller) => {
				const own = requireOwnTab(port, caller, 'stop an agent');
				const id = textArgument(args.id, 'id')?.trim();
				if (!id) {
					throw new Error('`id` is required: an agent id from chat_agents.');
				}
				return control(port).stopAgent(own, id);
			},
		},
	];
}


function richTools(port: ChatControlPort): Tool[] {
	const id = string('Stable card id; reuse it to update the same card');
	const title = string('Short display title');
	const relation = { type: 'object', properties: { messageId: string('Message id in this conversation'), toolId: string('Tool-call id in this conversation') }, additionalProperties: false };
	const descriptors = [
		{ name: 'chat_notify', kind: 'notification', description: 'Display or update a notification. Levels: info, warning, error. Include a reason, related message/tool and safe link/copy/reveal actions when useful.', properties: {
			id, text: string('Notification text'), level: { type: 'string', enum: ['info', 'warning', 'error'] }, reason: string('Reason or explanation'), related: relation,
			actions: { type: 'array', maxItems: 8, items: { type: 'object', properties: { label: string('Action label'), kind: { type: 'string', enum: ['link', 'copy', 'reveal'] }, url: string('HTTP(S) URL for link'), text: string('Text for copy'), target: relation }, required: ['label', 'kind'] } },
		}, required: ['text'] },
		{ name: 'chat_progress', kind: 'progress', description: 'Display or update one progress card by id, with stage, percent (null for indeterminate), elapsed time and status. cancel:{} lets the user stop the entire current turn; cancel:{agentId} stops a named agent in this conversation. Do not claim a single operation can be cancelled when cancellation stops its whole turn.', properties: {
			id, title, stage: string('Current stage'), percent: { type: ['number', 'null'], minimum: 0, maximum: 100 }, status: { type: 'string', enum: ['running', 'done', 'failed', 'cancelled'] }, related: relation,
			cancel: { type: 'object', properties: { agentId: string('Optional agent row id; absent means stop the entire current turn') }, additionalProperties: false },
		}, required: ['id', 'title'] },
		{ name: 'chat_update_plan', kind: 'plan', description: 'Display or update a plan by id. Each step has an id, text and pending/inProgress/done/cancelled status. At most one current step; reuse ids throughout the task.', properties: {
			id, title, related: relation, steps: { type: 'array', maxItems: 100, items: { type: 'object', properties: { id, text: string('Step description'), status: { type: 'string', enum: ['pending', 'inProgress', 'done', 'cancelled'] } }, required: ['text', 'status'], additionalProperties: false } },
		}, required: ['id', 'steps'] },
		{ name: 'chat_present_json', kind: 'json', description: 'Display a collapsible JSON tree with search and copy controls. Preserve actual JSON types; do not stringify the value. Reusing id updates the card.', properties: { id, title, value: { description: 'Any JSON value' } }, required: ['value'] },
		{ name: 'chat_present_result', kind: 'result', description: 'Display a result consisting of multiple ordered text, json, image, file and link blocks. JSON blocks use value; For image/file blocks use path to a completed file directly in the conversation visualization directory (up to 4 MB each). Small inline base64 is also accepted, but the entire encoded MCP request must fit 1 MB; base64 file blocks also need name. Links use HTTP(S) URLs. Binary data is archived with the conversation. Reuse id to update.', properties: {
			id, title, blocks: { type: 'array', maxItems: 128, items: { type: 'object', properties: { type: { type: 'string', enum: ['text', 'json', 'image', 'file', 'link'] }, text: string('Text block'), value: {}, mimeType: string('Image MIME type'), path: string('Absolute file path directly inside this conversation visualization directory; preferred for image/file blocks up to 4 MB'), base64: string('Small base64 binary content; total encoded MCP request must fit 1 MB, use path for larger data'), name: string('Download filename'), url: string('HTTP(S) URL'), title }, required: ['type'] } },
		}, required: ['blocks'] },
		{ name: 'chat_cite', kind: 'citations', description: 'Display a new answer with citations (supply text), or attach citations to an existing assistant message (messageId; absent selects the last assistant message). Cite an exact unique quote or start/end UTF-16 offsets in the raw message text. Targets: HTTP(S) URL, absolute file path with optional line, or a message/tool id in this conversation. The new answer is displayed already; do not repeat its text.', properties: {
			messageId: string('Existing assistant message id'), text: string('New answer text, optionally Markdown'), citations: { type: 'array', maxItems: 64, items: { type: 'object', properties: { id, label: string('Citation label'), quote: string('Exact unique fragment of the answer'), start: number('Start UTF-16 offset'), end: number('Exclusive end UTF-16 offset'), target: { type: 'object', properties: { type: { type: 'string', enum: ['url', 'file', 'message'] }, url: string('HTTP(S) source URL'), path: string('Absolute source file path'), line: number('Positive source line'), messageId: string('Cited message id'), toolId: string('Cited tool-call id') }, required: ['type'] } }, required: ['target'] } },
		}, required: ['citations'] },
	];
	return descriptors.map(({ name, kind, description, properties, required }): Tool => ({
		name, title: name.replace(/^chat_/, '').replace(/_/g, ' '), description: description + ' Only available in your own AI Browser conversation. Displayed in VS Code, Chrome and Exchange.',
		inputSchema: schema(properties, required),
		run: async (args, caller) => control(port).presentRich(requireOwnTab(port, caller, 'display rich chat content'), kind, args),
	}));
}
