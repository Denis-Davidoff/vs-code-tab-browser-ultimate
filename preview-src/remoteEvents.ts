import type { HostToView } from '../src/chat/chatProtocol';

/** Complete pending operations even when their conversation is no longer selected. */
export function isBackgroundCompletion(message: HostToView | undefined): boolean {
	return message?.type === 'githubStatus' && (message.createError !== undefined || message.created !== undefined);
}
