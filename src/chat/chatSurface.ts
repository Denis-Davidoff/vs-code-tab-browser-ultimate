import type { ChatViewState, HostToView } from './chatProtocol';

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
	/**
	 * Which remote surface this is. The editor marks a tab "open in Google Chrome"
	 * from Chrome's bridges only: the Exchange website's connection stays active
	 * while its relay socket is up, viewers or not, and once marked the tab as
	 * shared in Chrome after Chrome had been closed.
	 */
	readonly kind?: 'chrome' | 'exchange';
	/** How many people watch it, where the surface knows (the website). */
	readonly viewerCount?: number;
	/** Given a way to ask for a fresh state, e.g. after the surface changed its pin. */
	bind?(refresh: () => void): void;
	/**
	 * A snapshot message the editor sends on its own, such as `workdirGit` after a
	 * commit or a branch switch. Without it a remote view saw Git state only as
	 * the reply to a request of its own, and never a change made in the editor.
	 */
	event?(message: HostToView): void;
}

/** Builds the state of one conversation of the panel; absent is the tab in front. */
export type ChatStateFor = (chatId?: string) => ChatViewState;

export class ChatStateSurfaces {
	private readonly _surfaces = new Set<ChatStateSurface>();
	/** The last `workdirGit` per folder: part of every remote state, so nobody waits for the next change. */
	private readonly _snapshots = new Map<string, HostToView>();
	private _with(state: ChatViewState): ChatViewState {
		return this._snapshots.size ? { ...state, snapshotEvents: [...this._snapshots.values()] } : state;
	}
	attach(surface: ChatStateSurface, stateFor: ChatStateFor, changed?: () => void): { dispose(): void } {
		surface.bind?.(() => {
			if (!this._surfaces.has(surface)) { return; }
			try { surface.update(this._with(stateFor(surface.chatId))); } catch { /* published again below */ }
			changed?.();
		});
		surface.update(this._with(stateFor(surface.chatId)));
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
			try { surface.update(this._with(stateFor(surface.chatId))); }
			catch {
				this._surfaces.delete(surface);
				try { surface.close(); } catch { /* A failed external view must not break the editor. */ }
			}
		}
	}
	/** Hands a snapshot message to every surface that takes them. */
	broadcast(message: HostToView): void {
		if (message.type === 'workdirGit') {
			this._snapshots.delete(message.folder);
			this._snapshots.set(message.folder, message);
			while (this._snapshots.size > 16) { this._snapshots.delete(this._snapshots.keys().next().value!); }
		}
		for (const surface of this._surfaces) {
			if (surface.active === false || !surface.event) { continue; }
			try { surface.event(message); } catch { /* A failed external view must not break the editor. */ }
		}
	}
	/** Whether some live surface takes snapshot messages: then the editor's Git state is being watched. */
	watching(): boolean {
		return [...this._surfaces].some(surface => surface.active !== false && !!surface.event);
	}
	/** Conversations some surface is showing — what the editor marks as mirrored. */
	chatIds(fallback: string, kind?: 'chrome' | 'exchange'): Set<string> {
		return new Set([...this._surfaces].filter(surface => surface.active !== false && (!kind || surface.kind === kind)).map(surface => surface.chatId ?? fallback));
	}
	/** Who watches one conversation from outside the editor, for its Access tab. */
	watchers(chatId: string, fallback: string): { chrome: boolean; website?: number } {
		let chrome = false;
		let website: number | undefined;
		for (const surface of this._surfaces) {
			if (surface.active === false || (surface.chatId ?? fallback) !== chatId) { continue; }
			if (surface.kind === 'chrome') { chrome = true; }
			if (surface.kind === 'exchange') { website = (website ?? 0) + (surface.viewerCount ?? 0); }
		}
		return { chrome, ...(website !== undefined ? { website } : {}) };
	}
	dispose(): void {
		const surfaces = [...this._surfaces];
		this._surfaces.clear();
		for (const surface of surfaces) { try { surface.close(); } catch { /* Continue closing the other views. */ } }
	}
}
