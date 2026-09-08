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
	onOpen(at: PagePoint, descriptor: string): void;
	/** The page moved out from under the menu: it has to close. */
	onDismiss(): void;
}

export class PageContextMenu {

	private _enabled = false;
	/** The element the open menu belongs to; the panel comes back for it by no other name. */
	private _target: Element | undefined;
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
		this._target = event.target;
		this._host.highlight(event.target);
		this._watch(true);
		this._host.onOpen({ x: event.clientX, y: event.clientY }, describeNode(event.target));
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
		}
	}

	/** Hands over the element the menu was opened on; there is no second answer to give. */
	public take(): Element | undefined {
		const target = this._target;
		this.clear();
		return target;
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
