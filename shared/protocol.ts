/*---------------------------------------------------------------------------------------------
 *  Message contracts shared by the extension host, the webview and the injected page script.
 *--------------------------------------------------------------------------------------------*/

/**
 * Attributes preferred over structural selectors, used when the setting does not provide any.
 * Mirrored by the default of `tabBrowser.picker.preferAttributes`.
 */
export const defaultPreferredAttributes: readonly string[] =
	['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];

/** Marker property carried by every message exchanged with the injected page script. */
export const agentChannel = '__tabBrowserAgent' as const;

/**
 * Query parameter the webview varies to make the frame load a page again — assigning the same
 * `src` does nothing at all. It is the panel's and not the page's, so the injected script takes
 * it back off every url it reports: it would otherwise end up in the address bar, in every
 * element report and in every answer to an mcp client, growing a `?` onto a file's own path.
 */
export const cacheBustParameter = 'vscodeBrowserReqId';

/** A position in the viewport of the top document, after every frame added its own offset. */
export interface PagePoint {
	readonly x: number;
	readonly y: number;
}

export interface ElementRect {
	readonly top: number;
	readonly left: number;
	readonly width: number;
	readonly height: number;
}

/** One css rule that applies to the picked element, or to one of its ancestors. */
export interface CssRule {
	/** `selectorText` of the rule, or `element.style` for the inline style attribute. */
	readonly selector: string;
	/** `property: value` pairs, joined by `; `. */
	readonly declarations: string;
	/** `@media` / `@supports` / `@layer` the rule sits in, outermost first. */
	readonly conditions?: readonly string[];
	/** Set on inherited rules: the ancestor the declarations come from. */
	readonly from?: string;
}

export interface ResolvedDeclaration {
	readonly property: string;
	readonly value: string;
	/** The value is what a bare element of this tag gets, i.e. nothing on the page sets it. */
	readonly fromUserAgent?: boolean;
}

/** What the page's stylesheets say about the picked element. */
export interface StyleSnapshot {
	/** Rules matching the element itself, in cascade order (weakest first). */
	readonly matched: readonly CssRule[];
	/** Inheritable declarations coming from ancestors, nearest ancestor first. */
	readonly inherited: readonly CssRule[];
	/** Computed values: everything the rules above declare, plus the usual layout properties. */
	readonly resolved: readonly ResolvedDeclaration[];
	/** Custom properties the rules above reference, resolved on the element. */
	readonly variables: readonly ResolvedDeclaration[];
	/** Stylesheets whose rules could not be read: another origin, or never loaded. */
	readonly unreadableStyleSheets: number;
}

export interface PickedElement {
	/** CSS selector for the element, relative to its own document. */
	readonly selector: string;
	readonly xpath: string;
	readonly tagName: string;
	readonly id?: string;
	readonly classes: readonly string[];
	readonly attributes: Readonly<Record<string, string>>;
	readonly text?: string;
	/** CSS selectors of the `<iframe>` chain the element lives in, outermost first. */
	readonly framePath: readonly string[];
	/** Location of the document the element belongs to, on the real server. */
	readonly documentUrl: string;
	/** `tag#id.class` of the element, with every class it carries. */
	readonly descriptor: string;
	/** `descriptor` of each ancestor below `<body>`, the element itself last. */
	readonly htmlPath: readonly string[];
	/** `outerHTML`, with the children elided when the markup is too long. */
	readonly outerHtml: string;
	/** Position and size in the viewport of its own document. */
	readonly rect: ElementRect;
	/** Absent when the page's stylesheets could not be inspected. */
	readonly styles?: StyleSnapshot;
}

/**
 * What a keyboard shortcut of the panel's does. A browser keeps these keys for itself, so a
 * page never sees them — and while the page has the focus it is the only thing that hears them
 * at all, which is why the injected script forwards them rather than the webview listening.
 */
export type ShortcutAction = 'newTab' | 'zoomIn' | 'zoomOut' | 'resetZoom';

/**
 * The standard editing commands, which have to be carried into the page by hand.
 *
 * The editor takes those keys for itself — on macOS `Cut`/`Copy`/`Paste` are native menu roles
 * and everything else, `Undo` and `Select All` included, goes through the keybinding service —
 * and its own webview support answers them by running `execCommand` on the frame *it* created.
 * The page is one frame deeper than that, so it never hears the key and never performs the
 * command; hence a command of ours, which the panel forwards to whichever frame has the focus.
 */
export type EditAction = 'undo' | 'redo' | 'copy' | 'cut' | 'paste' | 'selectAll';

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace';

export interface ConsoleEntry {
	readonly level: ConsoleLevel;
	/** `Date.now()` when the call was made. */
	readonly time: number;
	readonly text: string;
	/** Present for entries synthesised from `error` / `unhandledrejection`. */
	readonly stack?: string;
}

export type PageRequest =
	| { readonly type: 'snapshot'; readonly maxNodes?: number }
	| { readonly type: 'inspect'; readonly selector: string }
	| { readonly type: 'waitFor'; readonly selector: string; readonly timeout?: number }
	| { readonly type: 'console'; readonly level?: ConsoleLevel; readonly limit?: number }
	| { readonly type: 'html'; readonly selector?: string; readonly maxLength?: number }
	| { readonly type: 'text'; readonly selector?: string; readonly maxLength?: number }
	| { readonly type: 'click'; readonly selector: string }
	| { readonly type: 'fill'; readonly selector: string; readonly value: string };

/** What the extension host can ask the page for, on behalf of an mcp client. */
/** Webview (or a parent frame) -> injected page script. */
export type AgentCommand =
	| { readonly kind: 'enablePicker'; readonly preferAttributes?: readonly string[] }
	| { readonly kind: 'disablePicker' }
	| { readonly kind: 'collectConsole'; readonly requestId: number }
	/**
	 * "Is there an agent in the document you are showing?" Asked after every `load` event,
	 * because silence is the only sign of a document the proxy does not serve — and silence is
	 * not something a *time* can be read off, so the answer carries the number of the question.
	 */
	| { readonly kind: 'alive'; readonly probeId: number }
	/**
	 * Whether a right-click the page leaves alone should be answered with the panel's menu.
	 * The page has to know before the event happens: suppressing the editor's own menu is a
	 * `preventDefault` inside the handler, and there is no asking anyone by then.
	 */
	| {
		readonly kind: 'setContextMenu';
		readonly enabled: boolean;
		/** The panel's setting, since a pick the menu asks for builds selectors too. */
		readonly preferAttributes?: readonly string[];
	}
	/**
	 * The panel has a menu standing open above the page, or no longer has. Sent to every frame
	 * and not only to the one that was clicked: the panel cannot see a click inside the page at
	 * all, so whichever frame the next one lands in has to be the one that reports it — and
	 * that is as true of the toolbar's own menus as of the one a right-click opens.
	 *
	 * `targetId` names the element the menu is about, when it is about one; `open: false` then
	 * also has the frame forget that element. By id, because this message can arrive *after*
	 * the right-click that replaced the menu, and "forget whatever you have" would take the
	 * element of the menu that is standing open.
	 */
	| { readonly kind: 'menuOpen'; readonly open: boolean; readonly targetId?: string }
	/** Report the element the context menu was opened on, as a `pick` of its own. */
	| { readonly kind: 'pickContextTarget'; readonly targetId: string }
	/**
	 * "You are not the frame that was clicked": sent by the frame that takes a right-click to
	 * every other one, so that no two frames hold an outlined element.
	 */
	| { readonly kind: 'clearContextTarget' }
	/**
	 * Perform an editing command on whatever has the focus. `text` is the clipboard's content
	 * for a paste, read by the extension host: the page cannot read the clipboard itself, and
	 * a channel that let it ask would let any page read the clipboard whenever it liked.
	 */
	| { readonly kind: 'edit'; readonly action: EditAction; readonly text?: string }
	| { readonly kind: 'request'; readonly requestId: number; readonly request: PageRequest };

/** Injected page script -> parent frame -> webview. */
export type AgentEvent =
	| { readonly kind: 'ready'; readonly documentUrl: string }
	/** The same document, under a new url: `history.pushState` and friends. */
	| { readonly kind: 'navigated'; readonly documentUrl: string }
	| { readonly kind: 'hover'; readonly selector: string; readonly framePath: readonly string[] }
	/** The icon the top document declares, as a url on the real server. */
	| { readonly kind: 'icon'; readonly href: string }
	/** The top document's `title`, for the panel's tab. */
	| { readonly kind: 'title'; readonly title: string }
	| { readonly kind: 'pick'; readonly element: PickedElement }
	/**
	 * A right-click the page did not take for itself. `at` is in the top document's viewport —
	 * every frame relaying it adds where its own `<iframe>` sits — so the webview can put its
	 * menu where the cursor is without knowing anything about the page's frames.
	 */
	| {
		readonly kind: 'contextMenu';
		readonly at: PagePoint;
		/** `tag#id.class` of the element under the cursor, for the menu's header. */
		readonly descriptor: string;
		/** Names the element for as long as the menu is up; see `menuOpen`. */
		readonly targetId: string;
	}
	/** Something the page saw that a menu has to close for: a click, a scroll, Escape. */
	| { readonly kind: 'dismissMenu' }
	| { readonly kind: 'cancel' }
	| {
		readonly kind: 'result';
		readonly requestId: number;
		readonly value?: unknown;
		/** Set when the request could not be carried out; `value` is then absent. */
		readonly error?: string;
	}
	| { readonly kind: 'pageError'; readonly message: string }
	/**
	 * What a copy or a cut selected, for the extension host to put on the clipboard. Only sent
	 * when the page's own `execCommand` was refused — a document with no user activation and no
	 * clipboard permission of its own is not allowed to write there.
	 */
	| { readonly kind: 'copyToClipboard'; readonly text: string }
	/** One of the panel's own shortcuts, pressed while the page had the keyboard. */
	| { readonly kind: 'shortcut'; readonly action: ShortcutAction }
	/**
	 * A pinch on the trackpad or `Cmd`/`Ctrl` + wheel over the page — one gesture reported as
	 * many small deltas, in pixels, negative for "closer". The page reports and the panel
	 * decides: how much of a gesture is worth a step is the panel's business, and the page
	 * would otherwise have to know the zoom steps to answer for them.
	 */
	| { readonly kind: 'zoomGesture'; readonly delta: number }
	/**
	 * The answer to `alive`, from the document that was holding the frame when it was asked.
	 * A kind of its own, because every other kind here belongs to one direction only: shared
	 * with the command, a nested frame's answer reads as a question to answer again, and the
	 * relay switch that would have to forward it never sees it.
	 */
	| { readonly kind: 'aliveAnswer'; readonly probeId: number; readonly ready: boolean }
	| {
		readonly kind: 'console';
		readonly requestId: number;
		readonly entries: readonly ConsoleEntry[];
		readonly documentUrl: string;
		/** Entries dropped because the ring buffer was full. */
		readonly dropped: number;
	};

export type AgentMessage = AgentCommand | AgentEvent;

export function isAgentMessage(value: unknown): value is AgentMessage {
	return typeof value === 'object'
		&& value !== null
		&& agentChannel in value
		&& (value as Record<string, unknown>)[agentChannel] === true
		&& typeof (value as Record<string, unknown>).kind === 'string';
}

export function packAgentMessage(message: AgentMessage): unknown {
	return { [agentChannel]: true, ...message };
}

