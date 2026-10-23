import type { ChatViewState } from './chatProtocol';

/** A state consumer independent of VS Code's webview lifecycle. */
export interface ChatStateSurface {
	update(state: ChatViewState): void;
	close(): void;
	/**
	 * The conversation this surface shows, whatever is in front in the editor;
	 * absent means the tab in front. Chrome pins one so switching tabs in the
	 * editor does not move it.
	 */
	readonly chatId?: string;
	/** False while an external view is no longer polling the editor. */
	readonly active?: boolean;
	/** Given a way to ask for a fresh state, e.g. after the surface changed its pin. */
	bind?(refresh: () => void): void;
}

/** Builds the state of one conversation of the panel; absent is the tab in front. */
export type ChatStateFor = (chatId?: string) => ChatViewState;

export class ChatStateSurfaces {
	private readonly _surfaces = new Set<ChatStateSurface>();
	attach(surface: ChatStateSurface, stateFor: ChatStateFor, changed?: () => void): { dispose(): void } {
		surface.bind?.(() => {
			if (!this._surfaces.has(surface)) { return; }
			try { surface.update(stateFor(surface.chatId)); } catch { /* published again below */ }
			changed?.();
		});
		surface.update(stateFor(surface.chatId));
		this._surfaces.add(surface);
		changed?.();
		return { dispose: () => {
			if (this._surfaces.delete(surface)) {
				surface.close();
				changed?.();
			}
		} };
	}
	publish(stateFor: ChatStateFor): void {
		for (const surface of this._surfaces) {
			try { surface.update(stateFor(surface.chatId)); }
			catch {
				this._surfaces.delete(surface);
				try { surface.close(); } catch { /* A failed external view must not break the editor. */ }
			}
		}
	}
	/** Conversations some surface is showing — what the editor marks as mirrored. */
	chatIds(fallback: string): Set<string> {
		return new Set([...this._surfaces].filter(surface => surface.active !== false).map(surface => surface.chatId ?? fallback));
	}
	dispose(): void {
		const surfaces = [...this._surfaces];
		this._surfaces.clear();
		for (const surface of surfaces) { try { surface.close(); } catch { /* Continue closing the other views. */ } }
	}
}
