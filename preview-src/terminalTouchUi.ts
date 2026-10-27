/*
 * Touch on the terminal screen: select by long press, pinch to change the font
 * size, scroll back to the bottom, scroll a full-screen program with a drag.
 *
 * The geometry (`cellAt`, `wordRange`, `selectionSpan`, `pinchFontSize`,
 * `dragRows`) is in `terminalTouch.ts` under `npm test`; this is the DOM half,
 * checked in headless Chrome with touch emulation. Only `pointerType: 'touch'`
 * is handled, so a mouse behaves exactly as before.
 *
 *  - Scrolling the scrollback by one finger is xterm's own (its Gesture
 *    handler); the host has `touch-action: none` so the page does not pan or
 *    zoom instead. What xterm does not do is scroll a full-screen program (the
 *    alternate buffer has no scrollback): there a vertical drag is sent as arrow
 *    keys, one per row of the finger's travel — only with mouse reporting off,
 *    where xterm would send the program wheel events itself.
 *  - A long press (450 ms, under 10 px of travel) selects the word under the
 *    finger; going on dragging extends it. While it does, xterm's touch
 *    handlers are not given the move, or the screen would scroll under it.
 *  - Two fingers pinch the font size (8 to 28). The page itself never zooms:
 *    `touch-action: none` is on the terminal only.
 *  - A tap focuses the terminal (the key bar's proxy, on a touch device), unless
 *    it ended a gesture.
 */

import type { Terminal } from '@xterm/xterm';
import { namedKeySequence, noMods } from './terminalMobileKeys';
import { cellAt, dragRows, pinchFontSize, selectionSpan, wordRange, type Cell } from './terminalTouch';

export interface TouchTarget {
	readonly id: string;
	readonly term: Terminal;
	readonly host: HTMLElement;
}

export interface TouchUiOptions {
	readonly stage: HTMLElement;
	readonly touch: () => boolean;
	/** Bytes to the shell (the view's `sendInput`). */
	readonly keys: (id: string, data: string) => void;
	readonly copy: (text: string) => void;
	readonly paste: (id: string) => void;
	/** Absent: the bubble has no "Send to chat". */
	readonly sendToChat?: (id: string) => void;
	/** A new font size from a pinch; `final` when the fingers lifted (store it). */
	readonly fontSize: (size: number, final: boolean) => void;
	/** A tap that was not part of a gesture. */
	readonly onTap: (id: string) => void;
}

export interface TouchUi {
	attach(target: TouchTarget): () => void;
	setFront(id: string | undefined): void;
	/** Shows the selection's bubble (the key bar's "select all"). */
	showBubble(id: string): void;
}

export const longPressMs = 450;
export const moveSlopPx = 10;
export const tapMs = 300;
/** At most this many arrow keys for one move of a finger. */
const maxDragKeys = 24;

function button(label: string, aria: string, onClick: () => void): HTMLButtonElement {
	const b = document.createElement('button');
	b.type = 'button';
	b.className = 'terminal-bubble-button';
	b.textContent = label;
	b.setAttribute('aria-label', aria);
	b.addEventListener('pointerdown', event => { event.preventDefault(); });
	b.addEventListener('mousedown', event => { event.preventDefault(); });
	b.addEventListener('click', onClick);
	return b;
}

export function createTouchUi(options: TouchUiOptions): TouchUi {
	const { stage } = options;
	let front: string | undefined;
	const targets = new Map<string, TouchTarget>();

	/* ------------------------------------------------------------ the scroll-to-bottom chip */

	const chip = document.createElement('button');
	chip.type = 'button';
	chip.className = 'terminal-bottom-chip';
	chip.hidden = true;
	chip.setAttribute('aria-label', 'Scroll to the bottom');
	const chipIcon = document.createElement('span');
	chipIcon.className = 'codicon codicon-arrow-down';
	chipIcon.setAttribute('aria-hidden', 'true');
	chip.append(chipIcon);
	chip.addEventListener('pointerdown', event => { event.preventDefault(); });
	chip.addEventListener('click', () => {
		const target = front ? targets.get(front) : undefined;
		target?.term.scrollToBottom();
		updateChip();
	});
	stage.append(chip);

	function updateChip(): void {
		const target = front ? targets.get(front) : undefined;
		const buffer = target?.term.buffer.active;
		const scrolledUp = !!buffer && buffer.type === 'normal' && buffer.viewportY < buffer.baseY;
		const hidden = !(options.touch() && scrolledUp);
		if (chip.hidden !== hidden) { chip.hidden = hidden; }
	}

	/* ------------------------------------------------------------ the selection bubble */

	const bubble = document.createElement('div');
	bubble.className = 'terminal-bubble';
	bubble.hidden = true;
	bubble.setAttribute('role', 'toolbar');
	bubble.setAttribute('aria-label', 'Selection');
	const frontTarget = (): TouchTarget | undefined => (front ? targets.get(front) : undefined);
	const copyButton = button('Copy', 'Copy the selection', () => {
		const t = frontTarget();
		if (!t) { return; }
		const text = t.term.getSelection();
		if (text) { options.copy(text); }
		t.term.clearSelection();
	});
	const lineButton = button('Line', 'Select the whole line', () => {
		const t = frontTarget();
		const position = t?.term.getSelectionPosition();
		if (t && position) { t.term.selectLines(position.start.y, position.start.y); showBubble(t); }
	});
	const pasteButton = button('Paste', 'Paste', () => {
		const t = frontTarget();
		if (t) { t.term.clearSelection(); options.paste(t.id); }
	});
	const chatButton = options.sendToChat ? button('Chat', 'Send the selection to the chat', () => {
		const t = frontTarget();
		if (t) { options.sendToChat!(t.id); t.term.clearSelection(); }
	}) : undefined;
	bubble.append(copyButton, lineButton, pasteButton, ...(chatButton ? [chatButton] : []));
	stage.append(bubble);

	function hideBubble(): void {
		if (!bubble.hidden) { bubble.hidden = true; }
	}

	function showBubble(t: TouchTarget): void {
		const position = t.term.getSelectionPosition();
		const screen = t.host.querySelector<HTMLElement>('.xterm-screen');
		if (!position || !screen || !t.term.hasSelection()) { hideBubble(); return; }
		const stageRect = stage.getBoundingClientRect();
		const rect = screen.getBoundingClientRect();
		const cellW = rect.width / t.term.cols;
		const cellH = rect.height / t.term.rows;
		const row = position.start.y - t.term.buffer.active.viewportY;
		bubble.hidden = false;
		// Above the selection's first row; below it when there is no room above.
		const above = rect.top - stageRect.top + row * cellH - bubble.offsetHeight - 8;
		const top = above >= 4 ? above : rect.top - stageRect.top + (row + 1) * cellH + 8;
		const left = Math.max(4, Math.min(stageRect.width - bubble.offsetWidth - 4, rect.left - stageRect.left + position.start.x * cellW));
		bubble.style.setProperty('--bubble-x', `${Math.round(left)}px`);
		bubble.style.setProperty('--bubble-y', `${Math.round(top)}px`);
	}

	/* ------------------------------------------------------------ gestures on one terminal */

	function attach(t: TouchTarget): () => void {
		targets.set(t.id, t);
		const { term, host } = t;
		const pointers = new Map<number, { x: number; y: number }>();
		let longTimer: ReturnType<typeof setTimeout> | undefined;
		let downAt = 0;
		let origin = { x: 0, y: 0 };
		let travelled = false;
		let selecting = false;
		let gesture = false; // a pinch or a selection happened: the lift is not a tap
		let wordStart: Cell | undefined;
		let wordEnd: Cell | undefined;
		let lastY = 0;
		let carry = 0;
		let pinch: { readonly d0: number; readonly base: number; size: number } | undefined;

		const screenRect = (): DOMRect | undefined => host.querySelector<HTMLElement>('.xterm-screen')?.getBoundingClientRect();

		function cell(x: number, y: number): Cell {
			const rect = screenRect();
			return rect ? cellAt(rect, term.cols, term.rows, x, y) : { col: 0, row: 0 };
		}

		function stopTimer(): void {
			if (longTimer !== undefined) { clearTimeout(longTimer); longTimer = undefined; }
		}

		function beginSelection(): void {
			longTimer = undefined;
			if (pointers.size !== 1 || travelled || pinch) { return; }
			const here = cell(origin.x, origin.y);
			const buffer = term.buffer.active;
			const line = buffer.getLine(buffer.viewportY + here.row)?.translateToString(true) ?? '';
			const word = wordRange(line, here.col);
			selecting = true;
			gesture = true;
			if (word) {
				wordStart = { col: word[0], row: here.row };
				wordEnd = { col: word[0] + word[1] - 1, row: here.row };
				term.select(word[0], buffer.viewportY + here.row, word[1]);
			} else {
				wordStart = wordEnd = here;
				term.select(here.col, buffer.viewportY + here.row, 1);
			}
			try { navigator.vibrate?.(10); } catch { /* not every browser has it */ }
		}

		function extendSelection(x: number, y: number): void {
			if (!wordStart || !wordEnd) { return; }
			const head = cell(x, y);
			const before = head.row < wordStart.row || (head.row === wordStart.row && head.col < wordStart.col);
			const span = selectionSpan(before ? wordEnd : wordStart, head, term.cols, term.buffer.active.viewportY);
			term.select(span.col, span.row, span.length);
		}

		function distance(): number {
			const [a, b] = [...pointers.values()];
			return Math.hypot(a.x - b.x, a.y - b.y);
		}

		const onDown = (event: PointerEvent): void => {
			if (event.pointerType !== 'touch') { return; }
			pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
			if (pointers.size === 1) {
				downAt = event.timeStamp;
				origin = { x: event.clientX, y: event.clientY };
				lastY = event.clientY;
				carry = 0;
				travelled = false;
				selecting = false;
				gesture = false;
				hideBubble();
				stopTimer();
				longTimer = setTimeout(beginSelection, longPressMs);
			} else if (pointers.size === 2) {
				stopTimer();
				selecting = false;
				gesture = true;
				pinch = { d0: distance(), base: term.options.fontSize ?? 14, size: term.options.fontSize ?? 14 };
			}
		};

		const onMove = (event: PointerEvent): void => {
			if (event.pointerType !== 'touch' || !pointers.has(event.pointerId)) { return; }
			pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
			if (pinch && pointers.size === 2) {
				const size = pinchFontSize(pinch.base, pinch.d0, distance());
				if (size !== pinch.size) { pinch.size = size; options.fontSize(size, false); }
				return;
			}
			if (pointers.size !== 1) { return; }
			if (!travelled && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > moveSlopPx) {
				travelled = true;
				if (!selecting) { stopTimer(); }
			}
			if (selecting) { extendSelection(event.clientX, event.clientY); return; }
			if (!travelled) { return; }
			// A full-screen program: the finger's travel as arrow keys, where xterm sends nothing.
			const buffer = term.buffer.active;
			if (buffer.type === 'alternate' && term.modes.mouseTrackingMode === 'none') {
				const cellHeight = (screenRect()?.height ?? 0) / term.rows;
				const moved = dragRows(event.clientY - lastY, cellHeight, carry);
				carry = moved.carry;
				if (moved.rows !== 0) {
					const key = namedKeySequence(moved.rows > 0 ? 'ArrowUp' : 'ArrowDown', noMods, { applicationCursorKeys: term.modes.applicationCursorKeysMode });
					options.keys(t.id, key.repeat(Math.min(maxDragKeys, Math.abs(moved.rows))));
				}
			}
			lastY = event.clientY;
		};

		const onEnd = (event: PointerEvent): void => {
			if (event.pointerType !== 'touch' || !pointers.has(event.pointerId)) { return; }
			pointers.delete(event.pointerId);
			stopTimer();
			if (pinch) {
				if (pointers.size < 2) { options.fontSize(pinch.size, true); pinch = undefined; }
			}
			if (pointers.size > 0) { return; }
			const wasSelecting = selecting;
			selecting = false;
			if (event.type === 'pointercancel') { gesture = false; return; }
			if (wasSelecting) { showBubble(t); return; }
			if (!gesture && !travelled && event.timeStamp - downAt < tapMs) {
				if (term.hasSelection()) { term.clearSelection(); }
				options.onTap(t.id);
			}
			gesture = false;
		};

		// xterm's own touch scrolling is not given a move that belongs to a selection or a pinch.
		const onTouchMove = (event: TouchEvent): void => {
			if (selecting || pinch) { event.stopPropagation(); }
		};
		// A long press on Android raises a context menu; ours is the bubble.
		let lastWasTouch = false;
		const onPointerType = (event: PointerEvent): void => { lastWasTouch = event.pointerType === 'touch'; };
		const onContext = (event: Event): void => { if (lastWasTouch) { event.preventDefault(); } };

		host.addEventListener('pointerdown', onPointerType, true);
		host.addEventListener('pointerdown', onDown);
		host.addEventListener('pointermove', onMove);
		host.addEventListener('pointerup', onEnd);
		host.addEventListener('pointercancel', onEnd);
		host.addEventListener('touchmove', onTouchMove, true);
		host.addEventListener('contextmenu', onContext);

		const subscriptions = [
			term.onScroll(() => { if (front === t.id) { updateChip(); } }),
			term.onWriteParsed(() => { if (front === t.id) { updateChip(); } }),
			term.onSelectionChange(() => {
				if (front !== t.id) { return; }
				if (!term.hasSelection()) { hideBubble(); } else if (options.touch() && !selecting && pointers.size === 0) { showBubble(t); }
			}),
		];

		return () => {
			stopTimer();
			host.removeEventListener('pointerdown', onPointerType, true);
			host.removeEventListener('pointerdown', onDown);
			host.removeEventListener('pointermove', onMove);
			host.removeEventListener('pointerup', onEnd);
			host.removeEventListener('pointercancel', onEnd);
			host.removeEventListener('touchmove', onTouchMove, true);
			host.removeEventListener('contextmenu', onContext);
			for (const s of subscriptions) { s.dispose(); }
			targets.delete(t.id);
		};
	}

	return {
		attach,
		setFront(id) {
			front = id;
			hideBubble();
			updateChip();
		},
		showBubble(id) {
			const t = targets.get(id);
			if (t) { showBubble(t); }
		},
	};
}
