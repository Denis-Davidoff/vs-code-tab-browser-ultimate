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

import { schema, number, string, textArgument, numberArgument, type Caller, type Tool } from './mcpProtocol';

/** The four that act; `chatControlTools` in `agentProtocol.ts` is the same list, written twice. */
export const chatToolNames = ['chat_keep_awake', 'chat_pause', 'chat_resume', 'chat_stop_agent'] as const;

/** A keep-awake choice as the tool takes it; `ChatControl.keepAwake` maps it onto `SleepChoice`. */
export type KeepAwakeRequest =
	| { readonly mode: 'off' }
	| { readonly mode: 'timer'; readonly minutes: number }
	| { readonly mode: 'agents'; readonly scope: 'tab' | 'window' };

/** What the chat answers, for the caller's own tab where one is named. Every method throws an `Error` a model can act on. */
export interface ChatControl {
	/** The open tab whose conversation `chatId` names, by our tab id. */
	tabOf(chatId: string): string | undefined;
	state(ownTab: string | undefined): unknown;
	agents(ownTab: string): unknown;
	usage(ownTab: string | undefined): unknown;
	keepAwake(ownTab: string, request: KeepAwakeRequest): unknown;
	pause(ownTab: string): unknown;
	resume(ownTab: string): unknown;
	stopAgent(ownTab: string, rowId: string): Promise<unknown>;
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
