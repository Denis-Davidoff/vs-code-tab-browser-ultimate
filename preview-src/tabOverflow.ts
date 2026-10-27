/**
 * Which tabs of the narrow strip fit in its row, and which go into the overflow dropdown
 * (leaf, under test). The tab in front is always shown; the others are taken in strip order
 * while they fit at their own width; the rest overflow. The overflow button is reserved only
 * when something overflows.
 */
export interface TabFitInput {
	/** Each tab's width in strip order; the front tab's at its front width. */
	readonly widths: readonly number[];
	/** Index of the tab in front, or -1. */
	readonly front: number;
	/**
	 * Index of a tab kept shown beside the front one (the one last chosen from the dropdown), or -1 / absent.
	 * It is dropped when there is no room for it next to the front tab, never at the front tab's expense.
	 */
	readonly pinned?: number;
	/** Room in the row for tabs, the overflow button and the gaps (add buttons already taken off). */
	readonly available: number;
	/** Space between two items of the row. */
	readonly gap: number;
	/** Width of the overflow button. */
	readonly overflowWidth: number;
}

export interface TabFit {
	/** Indices shown, in strip order. */
	readonly visible: readonly number[];
	/** Indices in the dropdown, in strip order. */
	readonly hidden: readonly number[];
}

export function fitTabs(input: TabFitInput): TabFit {
	const { widths, front, gap } = input;
	const all = widths.map((_, i) => i);
	const total = widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, widths.length - 1);
	if (total <= input.available + 0.5) {
		return { visible: all, hidden: [] };
	}
	let budget = input.available - input.overflowWidth - gap;
	const shown = new Set<number>();
	if (front >= 0 && front < widths.length) {
		shown.add(front);
		budget -= widths[front];
	}
	const pinned = input.pinned ?? -1;
	if (pinned >= 0 && pinned < widths.length && !shown.has(pinned) && widths[pinned] + gap <= budget + 0.5) {
		shown.add(pinned);
		budget -= widths[pinned] + gap;
	}
	for (const i of all) {
		if (shown.has(i)) { continue; }
		const need = widths[i] + gap;
		if (need > budget + 0.5) { break; }
		shown.add(i);
		budget -= need;
	}
	return { visible: all.filter(i => shown.has(i)), hidden: all.filter(i => !shown.has(i)) };
}
