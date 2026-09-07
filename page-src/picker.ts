/*---------------------------------------------------------------------------------------------
 *  Highlights the element under the cursor and reports the one that gets clicked.
 *--------------------------------------------------------------------------------------------*/

import { defaultPreferredAttributes, PickedElement } from '../shared/protocol';
import { cssPath, describeElement } from './selectors';

/** Marks nodes belonging to the extension rather than to the page. */
const overlayAttribute = 'data-tab-browser';

/** The hovered element's path is shown wrapped, within these bounds. */
const labelMaxWidth = 360;
const labelMaxLines = 3;

/** Interactions that must not reach the page while picking. */
const blockedEvents = [
	'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'auxclick',
	'contextmenu', 'submit', 'touchstart', 'touchend', 'dragstart',
] as const;

export interface PickerHost {
	onHover(selector: string): void;
	onPick(element: PickedElement): void;
	/** Escape inside the page; the picker has already turned itself off. */
	onCancel(): void;
	documentUrl(): string;
}

export class ElementPicker {

	private _active = false;
	private _preferredAttributes: readonly string[] = defaultPreferredAttributes;
	private _hovered: Element | undefined;
	private _lastPointer: { x: number; y: number } | undefined;
	private _overlayRoot: HTMLDivElement | undefined;
	private _outline: HTMLDivElement | undefined;
	private _label: HTMLDivElement | undefined;
	private _cursorStyle: HTMLStyleElement | undefined;
	private _pendingFrame = 0;
	private _reportedSelector: string | undefined;

	private readonly _onMouseMove = (event: MouseEvent) => {
		this._lastPointer = { x: event.clientX, y: event.clientY };
		this._scheduleUpdate();
	};

	private readonly _onMouseOut = (event: MouseEvent) => {
		if (!event.relatedTarget) {
			this._hovered = undefined;
			// Forget the last reported selector: re-entering the same element must report it
			// again, since another frame may have overwritten the hint in the meantime.
			this._reportedSelector = undefined;
			this._hideOverlay();
		}
	};

	private readonly _onViewportChange = () => {
		if (this._lastPointer) {
			this._scheduleUpdate();
		}
	};

	private readonly _onClick = (event: MouseEvent) => {
		event.preventDefault();
		event.stopImmediatePropagation();

		const element = this._hovered ?? document.elementFromPoint(event.clientX, event.clientY);
		if (!element || element === document.documentElement) {
			return;
		}
		this._host.onPick(describeElement(element, this._preferredAttributes, this._host.documentUrl()));
	};

	private readonly _onKeyDown = (event: KeyboardEvent) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopImmediatePropagation();
			this.disable();
			this._host.onCancel();
		}
	};

	private readonly _blockEvent = (event: Event) => {
		if (this._isOwnOverlay(event.target)) {
			return;
		}
		event.preventDefault();
		event.stopImmediatePropagation();
	};

	constructor(private readonly _host: PickerHost) { }

	public get active(): boolean {
		return this._active;
	}

	public get preferredAttributes(): readonly string[] {
		return this._preferredAttributes;
	}

	public enable(attributes?: readonly string[]): void {
		if (attributes?.length) {
			this._preferredAttributes = attributes;
		}
		if (this._active) {
			return;
		}
		this._active = true;
		this._reportedSelector = undefined;

		window.addEventListener('mousemove', this._onMouseMove, true);
		window.addEventListener('mouseout', this._onMouseOut, true);
		window.addEventListener('click', this._onClick, true);
		window.addEventListener('keydown', this._onKeyDown, true);
		window.addEventListener('scroll', this._onViewportChange, true);
		window.addEventListener('resize', this._onViewportChange, true);
		for (const type of blockedEvents) {
			window.addEventListener(type, this._blockEvent, true);
		}

		this._cursorStyle = document.createElement('style');
		this._cursorStyle.setAttribute(overlayAttribute, 'cursor');
		this._cursorStyle.textContent = '*, *::before, *::after { cursor: crosshair !important; }';
		(document.head ?? document.documentElement).appendChild(this._cursorStyle);
	}

	public disable(): void {
		if (!this._active) {
			return;
		}
		this._active = false;
		this._hovered = undefined;
		this._lastPointer = undefined;
		this._reportedSelector = undefined;

		window.removeEventListener('mousemove', this._onMouseMove, true);
		window.removeEventListener('mouseout', this._onMouseOut, true);
		window.removeEventListener('click', this._onClick, true);
		window.removeEventListener('keydown', this._onKeyDown, true);
		window.removeEventListener('scroll', this._onViewportChange, true);
		window.removeEventListener('resize', this._onViewportChange, true);
		for (const type of blockedEvents) {
			window.removeEventListener(type, this._blockEvent, true);
		}

		if (this._pendingFrame) {
			cancelAnimationFrame(this._pendingFrame);
			this._pendingFrame = 0;
		}

		this._cursorStyle?.remove();
		this._cursorStyle = undefined;
		this._overlayRoot?.remove();
		this._overlayRoot = this._outline = this._label = undefined;
	}

	private _scheduleUpdate(): void {
		if (this._pendingFrame) {
			return;
		}
		this._pendingFrame = requestAnimationFrame(() => {
			this._pendingFrame = 0;
			this._updateHighlight();
		});
	}

	private _updateHighlight(): void {
		if (!this._active || !this._lastPointer) {
			return;
		}

		const element = document.elementFromPoint(this._lastPointer.x, this._lastPointer.y);
		if (!element || element === document.documentElement) {
			this._hovered = undefined;
			this._reportedSelector = undefined;
			this._hideOverlay();
			return;
		}

		this._hovered = element;
		const selector = cssPath(element, this._preferredAttributes);
		this._showOverlay(element, selector);

		if (selector !== this._reportedSelector) {
			this._reportedSelector = selector;
			this._host.onHover(selector);
		}
	}

	// -- overlay -------------------------------------------------------------------------------

	private _isOwnOverlay(target: EventTarget | null): boolean {
		return !!this._overlayRoot && target instanceof Node && this._overlayRoot.contains(target);
	}

	private _ensureOverlay(): void {
		if (this._overlayRoot?.isConnected) {
			return;
		}

		this._overlayRoot = document.createElement('div');
		this._overlayRoot.setAttribute(overlayAttribute, 'picker');
		// The children are positioned inside this box rather than against the viewport, so that
		// `overflow: hidden` can clip them: an overlay must never give the page a scrollbar.
		this._overlayRoot.style.cssText = 'all: initial; position: fixed; inset: 0; overflow: hidden;'
			+ 'pointer-events: none; z-index: 2147483647;';

		this._outline = document.createElement('div');
		this._outline.style.cssText = 'position: absolute; pointer-events: none; box-sizing: border-box;'
			+ 'border: 2px solid #4daafc; background: rgba(77, 170, 252, 0.14); border-radius: 2px;';

		this._label = document.createElement('div');
		this._label.style.cssText = 'position: absolute; pointer-events: none; box-sizing: border-box;'
			+ `max-width: min(${labelMaxWidth}px, 90vw);`
			+ 'padding: 3px 6px; border-radius: 3px; background: #1f1f1f; color: #ffffff;'
			+ 'font: 8.8px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;'
			// A selector has no spaces to break at, so it has to be allowed to break anywhere.
			+ 'white-space: normal; overflow-wrap: anywhere;'
			+ `display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: ${labelMaxLines};`
			+ 'overflow: hidden; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);';

		this._overlayRoot.appendChild(this._outline);
		this._overlayRoot.appendChild(this._label);
		document.documentElement.appendChild(this._overlayRoot);
	}

	private _hideOverlay(): void {
		if (this._overlayRoot) {
			this._overlayRoot.style.display = 'none';
		}
	}

	private _showOverlay(element: Element, selector: string): void {
		this._ensureOverlay();
		if (!this._overlayRoot || !this._outline || !this._label) {
			return;
		}

		this._overlayRoot.style.display = '';
		const rect = element.getBoundingClientRect();
		this._outline.style.left = `${rect.left}px`;
		this._outline.style.top = `${rect.top}px`;
		this._outline.style.width = `${rect.width}px`;
		this._outline.style.height = `${rect.height}px`;

		this._label.textContent = `${selector}  ·  ${Math.round(rect.width)}×${Math.round(rect.height)}`;

		// Measured rather than assumed: the label wraps, so its height depends on the selector.
		const labelWidth = this._label.offsetWidth;
		const labelHeight = this._label.offsetHeight;
		const above = rect.top - labelHeight - 4;

		this._label.style.left = `${Math.max(2, Math.min(rect.left, window.innerWidth - labelWidth - 4))}px`;
		this._label.style.top = `${above >= 2
			? above
			: Math.max(2, Math.min(rect.bottom + 4, window.innerHeight - labelHeight - 2))}px`;
	}
}
