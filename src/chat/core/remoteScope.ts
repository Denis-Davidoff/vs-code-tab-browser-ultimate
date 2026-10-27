import type { RemoteSurface } from './commands';

/**
 * The one door for a command from a remote surface (the Chrome side panel, the
 * Exchange website): which chat surface of the window it names, which of its
 * tabs holds the conversation, whether the chat may run at all, and whether
 * this surface may ask for this message. Both entry points in chatView.ts
 * (`commandChromeSource`, `commandExchangeSource`) start here, so the order of
 * the checks — and their refusals — is one thing, not two. Leaf module: the
 * table's verdict is passed in.
 */
/** Why a conversation a surface names is not there; the Chrome panel then offers another. */
export const remoteGone: Readonly<Record<RemoteSurface, string>> = {
	chrome: 'This conversation was closed in the editor. Pick another one.',
	exchange: 'This conversation is no longer open in the editor.',
};

/**
 * `tabOf` answers the tab holding the conversation on a live surface (undefined
 * when the surface is gone or no tab holds it); `blocked` why the chat may not
 * run there. Callbacks rather than a shape, since the surface's members are private.
 */
export function remoteScope<View, Tab>(
	surface: RemoteSurface, view: View | undefined, tabOf: (view: View) => Tab | undefined,
	blocked: (view: View) => string | undefined, refusal: string | undefined,
): { view: View; tab: Tab } {
	// The surface addresses the conversation it shows, which need not be the tab in front.
	const tab = view ? tabOf(view) : undefined;
	if (!view || !tab) { throw new Error(remoteGone[surface]); }
	const reason = blocked(view);
	if (reason) { throw new Error(reason); }
	if (refusal) { throw new Error(refusal); }
	return { view, tab };
}
