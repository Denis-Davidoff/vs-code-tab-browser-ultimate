/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Which port a window tries first.
 *
 * Ports used to be handed out in the order windows open — the first window took
 * 43110, the next 43111 — which meant a window's port changed every time the
 * windows were opened in a different order. The port is written into an
 * assistant's config once, at connect time, so it went stale on the next
 * restart and the assistant got a 401 from a *neighbour's* window.
 *
 * Deriving the starting point from the folder URI makes a window's port the
 * same on every restart, so a config written today still addresses the right
 * window tomorrow. It is a preference, not a reservation: collisions are still
 * possible (two folders can hash to the same offset, and an unrelated process
 * can hold the port), so the walk below still has to fall through.
 *
 * This is the cheap half of the fix. It reduces how often an entry goes stale;
 * `mcpRepair.ts` is what corrects the ones that do.
 *
 * Leaf module: no imports at all, so `npm test` can load it directly.
 */

/** How many ports the walk may cover. */
export const portSpan = 20;

/**
 * FNV-1a over the folder URI.
 *
 * Any stable hash would do — what matters is that it is computed from the URI
 * rather than from the order of anything, and that it does not change between
 * releases. Written out rather than taken from `crypto` so this module stays
 * import-free and testable.
 */
export function portOffset(folderUri: string, span: number = portSpan): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < folderUri.length; i++) {
		hash ^= folderUri.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash % span;
}

/**
 * The ports to try, in order.
 *
 * The walk wraps around inside the span rather than running off the end, so
 * every window still tries the same 20 ports and a window whose preferred port
 * is the last one does not get a walk of length one.
 *
 * `offset` of 0 reproduces the original behaviour exactly, which is what an
 * explicitly configured `aiBrowser.mcp.port` gets: someone who names a port
 * means that port, and silently hashing them somewhere else would be a
 * surprise.
 */
export function portOrder(base: number, offset: number, span: number = portSpan): number[] {
	const ports: number[] = [];
	for (let i = 0; i < span; i++) {
		ports.push(base + ((offset + i) % span));
	}
	return ports;
}
