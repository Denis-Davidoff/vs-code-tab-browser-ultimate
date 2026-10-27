/**
 * Revisioned patches of a chat state for the remote surfaces (Chrome, the
 * website), instead of the whole state on every change. A patch names the
 * top-level fields that changed (`set`), the ones that went (`unset`), and the
 * conversation's entries as a tail from the first entry that differs — a reply
 * streaming rewrites only the last one. `apply(prev, diff(prev, next))` is
 * `next`, which `sync.test.ts` checks on random states. Leaf module: no
 * imports, plain JSON values only.
 */
export interface StatePatch {
	/** The revision this patch applies to; a receiver at another revision asks for the whole state. */
	readonly base: number;
	readonly rev: number;
	readonly set?: Readonly<Record<string, unknown>>;
	readonly unset?: readonly string[];
	/** `entries` from index `from` on, and its new length (shorter means entries were dropped). */
	readonly entries?: { readonly from: number; readonly upsert: readonly unknown[]; readonly length: number };
}

type Json = Readonly<Record<string, unknown>>;

/** Compares two JSON values by content. */
export function sameJson(a: unknown, b: unknown): boolean {
	if (a === b) { return true; }
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) { return false; }
	if (Array.isArray(a) !== Array.isArray(b)) { return false; }
	if (Array.isArray(a)) {
		const other = b as unknown[];
		return a.length === other.length && a.every((item, index) => sameJson(item, other[index]));
	}
	const ak = Object.keys(a).filter(k => (a as Json)[k] !== undefined);
	const bk = Object.keys(b).filter(k => (b as Json)[k] !== undefined);
	return ak.length === bk.length && ak.every(k => Object.prototype.hasOwnProperty.call(b, k) && sameJson((a as Json)[k], (b as Json)[k]));
}

/** What changed from `prev` to `next`; `undefined` when nothing did. */
export function diffState(prev: Json, next: Json, base: number, rev: number): StatePatch | undefined {
	const set: Record<string, unknown> = {};
	const unset: string[] = [];
	let entries: StatePatch['entries'];
	for (const key of Object.keys(next)) {
		const value = next[key];
		if (value === undefined) { continue; }
		if (key === 'entries' && Array.isArray(value) && Array.isArray(prev.entries)) {
			const before = prev.entries as unknown[];
			let from = 0;
			while (from < before.length && from < value.length && sameJson(before[from], value[from])) { from++; }
			if (from < value.length || value.length !== before.length) {
				entries = { from, upsert: value.slice(from), length: value.length };
			}
			continue;
		}
		if (!sameJson(prev[key], value)) { set[key] = value; }
	}
	for (const key of Object.keys(prev)) {
		if (prev[key] !== undefined && next[key] === undefined) { unset.push(key); }
	}
	if (!Object.keys(set).length && !unset.length && !entries) { return undefined; }
	return { base, rev, ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}), ...(entries ? { entries } : {}) };
}

/** `prev` with the patch applied; `undefined` when the patch is not for this revision or does not fit. */
export function applyPatch<T extends Json>(prev: T, revision: number, patch: StatePatch): T | undefined {
	if (patch.base !== revision) { return undefined; }
	const result: Record<string, unknown> = { ...prev };
	for (const key of patch.unset ?? []) { delete result[key]; }
	for (const [key, value] of Object.entries(patch.set ?? {})) { result[key] = value; }
	if (patch.entries) {
		const before = Array.isArray(prev.entries) ? prev.entries as unknown[] : undefined;
		const { from, upsert, length } = patch.entries;
		if (!before || from > before.length || from + upsert.length !== length) { return undefined; }
		result.entries = [...before.slice(0, from), ...upsert];
	}
	return result as T;
}

/** Reads a patch from the wire; anything malformed is `undefined`, and the receiver asks for the whole state. */
export function readPatch(value: unknown): StatePatch | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { return undefined; }
	const p = value as Record<string, unknown>;
	const whole = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
	if (!whole(p.base) || !whole(p.rev) || (p.rev as number) <= (p.base as number)) { return undefined; }
	if (p.set !== undefined && (!p.set || typeof p.set !== 'object' || Array.isArray(p.set))) { return undefined; }
	if (p.unset !== undefined && (!Array.isArray(p.unset) || p.unset.some(k => typeof k !== 'string'))) { return undefined; }
	if (p.entries !== undefined) {
		const e = p.entries as Record<string, unknown>;
		if (!e || typeof e !== 'object' || !whole(e.from) || !whole(e.length) || !Array.isArray(e.upsert)) { return undefined; }
	}
	return p as unknown as StatePatch;
}
