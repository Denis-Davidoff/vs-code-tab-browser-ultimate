import { randomBytes } from 'crypto';

/**
 * What the chat's own CLIs send as `X-AI-Browser-Chat`: a random value minted
 * in this extension host for one conversation, never the chat id itself.
 *
 * The header decides which chat a call belongs to (a recording's destination)
 * and whether a caller may act on the chat (`chat_*` tools). The chat id is in
 * `workspaceState` and outlives the window, so any program could read it and
 * write the header. This value is held in memory only and dies with the host;
 * it does reach the `--mcp-config` file of a running Claude Code, readable by
 * the same user's processes while that process runs. What it keeps out is a
 * caller that has a token and no shell — and a stale value from an earlier
 * window. It is not a boundary against the user's own code with a shell,
 * which can stop a CLI with `kill` anyway; see `src/mcp/chatTools.ts`.
 */
const byChat = new Map<string, string>();
const byCapability = new Map<string, string>();

/** The value a conversation's CLIs send; the same for the life of the host. */
export function chatCapability(chatId: string): string {
	let value = byChat.get(chatId);
	if (!value) {
		value = randomBytes(18).toString('base64url');
		byChat.set(chatId, value);
		byCapability.set(value, chatId);
	}
	return value;
}

/** The conversation a header value was minted for; nothing for a value this host never minted. */
export function chatOfCapability(value: string): string | undefined {
	return byCapability.get(value);
}
