export const chatTabDragType = 'application/x-ai-browser-chat-tab';

/** Only opaque identities travel through the OS drag clipboard, never draft text. */
export function parseChatTabTransfer(text: string): { source: string; id: string; token: string } | undefined {
	if (text.length > 1024) { return undefined; }
	try {
		const value = JSON.parse(text);
		if (!value || typeof value !== 'object') { return undefined; }
		if (['source', 'id', 'token'].some(key => typeof value[key] !== 'string' || !value[key] || value[key].length > 128)) { return undefined; }
		return { source: value.source, id: value.id, token: value.token };
	} catch { return undefined; }
}
