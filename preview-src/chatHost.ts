import type { ChatViewState, HostToView, ViewToHost } from '../src/chat/chatProtocol';
import type { RemoteLeaseControl } from './remoteTerminal';

export interface ChatDraftState {
	panel?: ChatViewState['panel'];
	draft?: string;
	drafts?: Record<string, string>;
	chatDrawerCollapsed?: boolean;
	chatDrawerSide?: 'left' | 'right';
	composerTab?: 'chat' | 'skills' | 'activity' | 'history' | 'github' | 'files' | 'agents' | 'access';
	overviewHeight?: number;
}

/** Host transport and draft persistence kept outside the chat renderer. */
export interface ChatHost {
	/** Trusted transport delivery. Untrusted frames never share this channel. */
	onMessage(listener: (message: HostToView) => void): void;
	postMessage(message: ViewToHost): void;
	getState(): ChatDraftState | undefined;
	setState(state: ChatDraftState): void;
	/** The website only: who may type into a remote terminal, and the Watch / Take control toggle. */
	readonly terminalLease?: RemoteLeaseControl;
}

declare function acquireVsCodeApi(): Omit<ChatHost, 'onMessage'>;
declare global { interface Window { aiBrowserChatHost?: ChatHost } }
export function createVsCodeChatHost(): ChatHost {
	if (window.aiBrowserChatHost) { return window.aiBrowserChatHost; }
	const api = acquireVsCodeApi();
	return {
		postMessage: message => api.postMessage(message),
		getState: () => api.getState(),
		setState: state => api.setState(state),
		onMessage: listener => {
			window.addEventListener('message', event => {
				if (trustedWebviewMessage(event, window) && event.data && typeof event.data === 'object') {
					listener(event.data as HostToView);
				}
			});
		},
	};
}

/** VS Code hides the real parent by assigning window.parent = window before our script runs. */
export function trustedWebviewMessage(event: Pick<MessageEvent, 'source' | 'origin'>, view: Window): boolean {
	if (!event.source || event.source === view || event.origin === 'null' || event.origin !== view.origin) { return false; }
	try {
		// Validate the actual embedding relationship from the sender's frame list,
		// rather than the replaceable parent property in the receiving document.
		const source = event.source as Window;
		for (let index = 0; index < Math.min(source.length, 100); index++) {
			if (source[index] === view) { return true; }
		}
	} catch { /* A sender whose relationship cannot be checked is untrusted. */ }
	return false;
}
