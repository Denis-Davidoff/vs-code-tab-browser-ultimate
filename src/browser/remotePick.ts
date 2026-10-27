/**
 * Picks started for a remote (Exchange) viewer, answered by the viewer's click.
 *
 * A website click reaches the page as CDP input on the host's own session, and
 * the tab it targets is usually a hidden tab of the editor — the user is looking
 * at the website, not at the page. A pick that waits for input on that page is
 * then a wait for a click that lands, if at all, on whatever VS Code shows. So a
 * remote click on a tab with a pick waiting is handed to that pick by its
 * coordinates (CSS pixels in the page's viewport) instead of being dispatched.
 *
 * Leaf module: no vscode, no CDP. A handler answers whether it took the click.
 */
export type RemotePickHandler = (x: number, y: number) => Promise<boolean>;

const handlers = new Map<object, Set<RemotePickHandler>>();

/** Registers a handler for `tab`; dispose to remove it. */
export function onRemotePick(tab: object, handler: RemotePickHandler): { dispose(): void } {
	let set = handlers.get(tab);
	if (!set) { set = new Set(); handlers.set(tab, set); }
	set.add(handler);
	return {
		dispose() {
			const current = handlers.get(tab);
			current?.delete(handler);
			if (current && !current.size) { handlers.delete(tab); }
		},
	};
}

/** Offers a remote click to the picks waiting on `tab`; true when one took it. */
export async function takeRemotePick(tab: object, x: number, y: number): Promise<boolean> {
	for (const handler of [...handlers.get(tab) ?? []]) {
		try { if (await handler(x, y)) { return true; } } catch { /* the next one may take it */ }
	}
	return false;
}
