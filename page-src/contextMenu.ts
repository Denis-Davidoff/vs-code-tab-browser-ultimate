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
	/** Outlines the element the menu was opened on; the picker owns that overlay. */
	highlight(element: Element): void;
	clearHighlight(): void;
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
		this._host.highlight(event.target);
		// The panel has every frame watch while a menu is up; this frame starts now, since the
		// click that closes the menu again is most often in the frame it was opened from.
		this._watch(true);
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
			// A frame can be watching for a menu opened in another one; with right-clicks
			// switched off there is no menu of ours left for it to close.
			this._watch(false);
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
	 * A menu is up somewhere, or is gone. Whichever frame the closing click lands in is the one
	 * that has to notice it, so every frame watches — and only the frame that is holding the
	 * element that menu was about forgets anything.
	 */
	public setOpen(open: boolean, targetId: string): void {
		this._watch(open && this._enabled);
		if (!open && this._target?.id === targetId) {
			this.clear();
		}
	}

	/** The menu is gone: nothing is remembered and nothing is outlined for it any more. */
	public clear(): void {
		if (!this._target) {
			return;
		}
		this._target = undefined;
		this._watch(false);
		this._host.clearHighlight();
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
