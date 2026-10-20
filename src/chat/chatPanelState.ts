/** Stable identity persisted by VS Code alongside a chat editor's drafts. */
export interface ChatPanelIdentity {
	readonly id: string;
	readonly number: number;
}

export function readChatPanelIdentity(state: unknown): ChatPanelIdentity | undefined {
	if (!state || typeof state !== 'object') { return undefined; }
	const panel = (state as { panel?: unknown }).panel;
	if (!panel || typeof panel !== 'object') { return undefined; }
	const { id, number } = panel as Record<string, unknown>;
	if (typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)
		|| typeof number !== 'number' || !Number.isSafeInteger(number) || number < 2 || number > 1_000_000) { return undefined; }
	return { id, number };
}
