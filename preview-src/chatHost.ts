import type { ChatViewState, ViewToHost } from '../src/chat/chatProtocol';

export interface ChatDraftState {
	panel?: ChatViewState['panel'];
	draft?: string;
	drafts?: Record<string, string>;
	chatDrawerCollapsed?: boolean;
	chatDrawerSide?: 'left' | 'right';
}

/** Host transport and draft persistence kept outside the chat renderer. */
export interface ChatHost {
	postMessage(message: ViewToHost): void;
	getState(): ChatDraftState | undefined;
	setState(state: ChatDraftState): void;
}

declare function acquireVsCodeApi(): ChatHost;
declare global { interface Window { aiBrowserChatHost?: ChatHost } }
export function createVsCodeChatHost(): ChatHost { return window.aiBrowserChatHost ?? acquireVsCodeApi(); }
