/**
 * The chat tabs grouped by project (leaf, under test): the thin project bar above
 * the narrow strip, the project headings of the wide drawer and of the tab list.
 * A project is the tab's `project` (its working folder, or the repository of a
 * separate copy); tabs that carry none — an older host — share one group.
 * Projects keep the order in which their first tab appears in the strip, and the
 * tabs keep their strip order inside their project. Terminals are not grouped:
 * they follow the conversations, as in the strip.
 */
import type { ChatTabSummary } from '../src/chat/chatProtocol';

export interface ProjectTab extends Pick<ChatTabSummary, 'id' | 'project' | 'status'> {
	readonly terminal?: unknown;
}

export interface ProjectGroup<T extends ProjectTab = ProjectTab> {
	readonly id: string;
	readonly name: string;
	readonly tabs: readonly T[];
	/** Tabs whose agents are at work (`status: 'working'`). */
	readonly thinking: number;
	/** Tabs whose work ended out of sight and has not been looked at. */
	readonly unread: number;
	/** Tabs stopped on an approval or a question. */
	readonly waiting: number;
	readonly failed: number;
}

export interface GroupedStrip<T extends ProjectTab = ProjectTab> {
	readonly groups: readonly ProjectGroup<T>[];
	readonly terminals: readonly T[];
	/** Conversations grouped by project, then the terminals: the order the strip shows them in. */
	readonly ordered: readonly T[];
}

/** The group of tabs that carry no project. */
export const noProject = '';

export function groupStrip<T extends ProjectTab>(strip: readonly T[]): GroupedStrip<T> {
	const byId = new Map<string, { id: string; name: string; tabs: T[] }>();
	const terminals: T[] = [];
	for (const tab of strip) {
		if (tab.terminal) { terminals.push(tab); continue; }
		const id = tab.project?.id ?? noProject;
		let group = byId.get(id);
		if (!group) {
			group = { id, name: tab.project?.name ?? 'Chats', tabs: [] };
			byId.set(id, group);
		}
		group.tabs.push(tab);
	}
	// Two folders of one name read as one: the later ones get a number.
	const seen = new Map<string, number>();
	const groups = [...byId.values()].map(g => {
		const n = (seen.get(g.name) ?? 0) + 1;
		seen.set(g.name, n);
		return {
			id: g.id,
			name: n > 1 ? `${g.name} (${n})` : g.name,
			tabs: g.tabs,
			thinking: g.tabs.filter(t => t.status === 'working').length,
			unread: g.tabs.filter(t => t.status === 'unread').length,
			waiting: g.tabs.filter(t => t.status === 'waiting').length,
			failed: g.tabs.filter(t => t.status === 'failed').length,
		};
	});
	return { groups, terminals, ordered: [...groups.flatMap(g => g.tabs), ...terminals] };
}

/** The project a conversation tab belongs to, for the filter. */
export function projectOf(tab: ProjectTab): string {
	return tab.project?.id ?? noProject;
}

/**
 * The tab to bring forward when a project is chosen in the bar while the tab in
 * front belongs to another: one waiting on the user first, then one with unread
 * work, then one failed, then the last one remembered for that project, then its first.
 */
export function tabForProject<T extends ProjectTab>(group: ProjectGroup<T>, remembered?: string): T | undefined {
	return group.tabs.find(t => t.status === 'waiting')
		?? group.tabs.find(t => t.status === 'unread')
		?? group.tabs.find(t => t.status === 'failed')
		?? group.tabs.find(t => t.id === remembered)
		?? group.tabs[0];
}

/** Totals for the "All" chip. */
export function allTotals(groups: readonly ProjectGroup[]): { tabs: number; thinking: number; unread: number; waiting: number; failed: number } {
	return groups.reduce((sum, g) => ({
		tabs: sum.tabs + g.tabs.length, thinking: sum.thinking + g.thinking, unread: sum.unread + g.unread,
		waiting: sum.waiting + g.waiting, failed: sum.failed + g.failed,
	}), { tabs: 0, thinking: 0, unread: 0, waiting: 0, failed: 0 });
}

/**
 * A colour for each project's folder icon: a slot of a palette of `slots`
 * well-separated colours. It looks random — the first choice comes from a hash
 * of the project's id — but no two open projects share a slot: a taken one moves
 * to the next free slot. `remembered` is what earlier calls gave (kept per
 * device), so a project keeps its colour while others open and close; it wins
 * over the hash whenever its slot is still free. With more projects than slots
 * the extra ones repeat colours, still spread as evenly as the slots allow.
 * Returns the slot of every id, the open projects first and then the remembered
 * ones of closed projects (bounded to `keep`), so the caller can store it back as
 * it is: that key order is what ranks a project that stayed open over one that
 * comes back. Keys keep their order through JSON as long as none is an array
 * index (`''`, `home` and the 12-hex ids are not: 12 digits exceed 2^32).
 */
export function projectColors(ids: readonly string[], remembered: Readonly<Record<string, number>>, slots: number, keep = 64): Record<string, number> {
	const open = [...new Set(ids)];
	const taken = new Map<number, number>();
	const out: Record<string, number> = {};
	const valid = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < slots;
	const take = (id: string, slot: number) => { out[id] = slot; taken.set(slot, (taken.get(slot) ?? 0) + 1); };
	// First the remembered colours, in the order they were remembered, as long as they do not
	// clash. That order puts the projects open at the last call first (see below), so a project
	// that stayed open keeps its colour when one that was closed comes back with the same slot.
	const openSet = new Set(open);
	for (const id of Object.keys(remembered)) {
		const r = remembered[id];
		if (openSet.has(id) && !(id in out) && valid(r) && !taken.has(r)) { take(id, r); }
	}
	for (const id of open) {
		if (id in out) { continue; }
		const start = colorHash(id) % slots;
		let best = start;
		for (let i = 0; i < slots; i++) {
			const s = (start + i) % slots;
			if ((taken.get(s) ?? 0) < (taken.get(best) ?? 0)) { best = s; }
			if (!taken.has(s)) { best = s; break; }
		}
		take(id, best);
	}
	// The closed projects' colours are kept, so they come back the same.
	let kept = open.length;
	for (const [id, slot] of Object.entries(remembered)) {
		if (kept >= keep) { break; }
		if (!(id in out) && valid(slot)) { out[id] = slot; kept++; }
	}
	return out;
}

/** FNV-1a over the id's UTF-16 units: a stable, well-spread start for a colour. */
function colorHash(id: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193); }
	return h >>> 0;
}
