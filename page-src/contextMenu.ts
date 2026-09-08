/*---------------------------------------------------------------------------------------------
 *  The page's half of the panel's context menu: which right-click the panel gets to answer,
 *  and the element that click was aimed at.
 *
 *  Nothing here paints a menu — the webview draws it, in the editor's own colours, out of the
 *  page's reach. What this owns is the one decision that has to be made on the spot, before
 *  anyone can be asked: whether the page wanted the click for itself.
 *--------------------------------------------------------------------------------------------*/

import { PagePoint } from '../shared/protocol';
import { describeNode } from './elementContext';

/** Events that close a menu the page can no longer be standing behind. */
const dismissEvents = ['mousedown', 'wheel', 'scroll', 'keydown'] as const;

export interface ContextMenuHost {
	/** A right-click the page left alone, at a point in this document's viewport. */
	onOpen(at: PagePoint, descriptor: string, targetId: string): void;
	/** The page moved out from under the menu: it has to close. */
	onDismiss(): void;
}

export class PageContextMenu {

	private _enabled = false;
	/** The element the open menu belongs to, under the name the panel knows it by. */
	private _target: { readonly id: string; readonly element: Element } | undefined;
	private _watching = false;

	private readonly _onContextMenu = (event: MouseEvent) => {
		// A page that has a menu of its own says so by taking the event, and this listener sits
		// on `window` — last of all of them — so that is readable right here. Answering anyway
		// would replace the site's own menu with ours, which is not ours to do.
		if (!this._enabled || event.defaultPrevented || !(event.target instanceof Element)) {
			return;
		}
		// `<html>` is the page's margin rather than anything to report on; leave that click to
		// the editor, whose menu is then the only one that opens.
		if (event.target === document.documentElement) {
			return;
		}

		// Ours to answer, so the editor's own menu must not open on top of it.
		event.preventDefault();
		// Named, because the panel is the one that knows whether the menu for it is still up,
		// and its word about that can arrive after the next right-click has replaced it.
		const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
		this._target = { id, element: event.target };
		// Nothing is drawn over the element and nothing in the page is touched: the menu now
		// offers copy, cut and paste, and those act on the selection and the field the user
		// had — an outline of ours in the page is one more thing that can disturb them.
		// Watching starts when the panel says a menu is up, and for no other reason: the panel
		// may decide not to open one at all — it is picking, say — and a frame left watching
		// for a menu that never opened reports clicks nothing is listening for.
		this._host.onOpen({ x: event.clientX, y: event.clientY }, describeNode(event.target), id);
	};

	private readonly _onDismiss = (event: Event) => {
		if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Escape') {
			return;
		}
		this.clear();
		this._host.onDismiss();
	};

	constructor(private readonly _host: ContextMenuHost) { }

	public get enabled(): boolean {
		return this._enabled;
	}

	public setEnabled(enabled: boolean): void {
		if (enabled === this._enabled) {
			return;
		}
		this._enabled = enabled;
		if (enabled) {
			window.addEventListener('contextmenu', this._onContextMenu);
		} else {
			window.removeEventListener('contextmenu', this._onContextMenu);
			this.clear();
			// The watch is not touched: it belongs to whatever the panel has standing open,
			// and the toolbar's own menus are open whatever this setting says about
			// right-clicks.
		}
	}

	/** Hands over the element that menu was opened on; there is no second answer to give. */
	public take(targetId: string): Element | undefined {
		const target = this._target?.id === targetId ? this._target.element : undefined;
		if (target) {
			this.clear();
		}
		return target;
	}

	/**
	 * The panel has something standing open above the page, or no longer has — the menu a
	 * right-click opened, or one of the toolbar's own, which the page cannot see either.
	 * Whichever frame the closing click lands in is the one that has to notice it, so every
	 * frame watches for as long as anything is up.
	 */
	public setOpen(open: boolean): void {
		this._watch(open);
	}

	/**
	 * Forget the element a menu was about: the one named, or whatever this frame is holding
	 * when nothing is named. Named, because this can arrive after the right-click that
	 * replaced that menu — and then the element being asked about is the new one.
	 */
	public clear(targetId?: string): void {
		if (!targetId || this._target?.id === targetId) {
			this._target = undefined;
		}
	}

	private _watch(watching: boolean): void {
		if (watching === this._watching) {
			return;
		}
		this._watching = watching;
		for (const type of dismissEvents) {
			if (watching) {
				// Captured, since a page is free to swallow any of these on the way down, and
				// passive, since none of them is being taken away from it.
				window.addEventListener(type, this._onDismiss, { capture: true, passive: true });
			} else {
				window.removeEventListener(type, this._onDismiss, true);
			}
		}
	}
}
