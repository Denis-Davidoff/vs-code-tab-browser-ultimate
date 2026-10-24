import { readChatPanelIdentity, type ChatPanelIdentity } from './chatPanelState';

export interface SavedChatPanel { panel: ChatPanelIdentity; drafts: Record<string, string> }
interface Storage {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): PromiseLike<void>;
}
const key = 'aiBrowser.chat.panelCatalog';

/** Reserve hidden editors before VS Code lazily invokes their serializers. */
export class ChatPanelCatalog {
	readonly panels = new Map<string, SavedChatPanel>();
	private _highWater = 1;
	private _saved = '';
	constructor(private readonly _storage: Storage, private readonly _key = key, legacyPanel?: (panel: ChatPanelIdentity) => boolean) {
		const owned = _storage.get<{ highWater?: number; panels?: unknown[] }>(this._key);
		const saved = owned ?? (legacyPanel ? _storage.get<{ highWater?: number; panels?: unknown[] }>(key) : undefined);
		if (Number.isSafeInteger(saved?.highWater) && saved!.highWater! > 0) { this._highWater = saved!.highWater!; }
		for (const entry of Array.isArray(saved?.panels) ? saved.panels : []) {
			const panel = readChatPanelIdentity(entry);
			if (!panel || this.panels.has(panel.id)) { continue; }
			if (!owned && legacyPanel && !legacyPanel(panel)) { continue; }
			const raw = (entry as SavedChatPanel).drafts;
			const drafts = Object.fromEntries(Object.entries(raw && typeof raw === 'object' ? raw : {}).filter(([, value]) => typeof value === 'string'));
			this.panels.set(panel.id, { panel, drafts });
			this._highWater = Math.max(this._highWater, panel.number);
		}
	}
	get highWater(): number { return this._highWater; }
	/** The lowest panel number nobody holds: #1 is the side bar's, and a closed panel's number is reused. */
	freeNumber(taken: Iterable<number>): number {
		const used = new Set(taken);
		for (const saved of this.panels.values()) { used.add(saved.panel.number); }
		let number = 2;
		while (used.has(number)) { number++; }
		return number;
	}
	remember(panel: ChatPanelIdentity, drafts: Record<string, string>): void {
		this._highWater = Math.max(this._highWater, panel.number);
		this.panels.set(panel.id, { panel, drafts: { ...drafts } });
		this._persist();
	}
	forget(id: string): void { this.panels.delete(id); this._persist(); }
	private _persist(): void {
		const value = { highWater: this._highWater, panels: [...this.panels.values()] };
		const json = JSON.stringify(value);
		if (json === this._saved) { return; }
		this._saved = json;
		void this._storage.update(this._key, value).then(undefined, () => { this._saved = ''; });
	}
}
