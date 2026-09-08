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
	/** Stylesheets that could not be read, i.e. loaded from another origin. */
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
	| { readonly kind: 'cancel' }
	| {
		readonly kind: 'result';
		readonly requestId: number;
		readonly value?: unknown;
		/** Set when the request could not be carried out; `value` is then absent. */
		readonly error?: string;
	}
	| { readonly kind: 'pageError'; readonly message: string }
	/** The answer to `alive`, from the document that was holding the frame when it was asked. */
	| { readonly kind: 'alive'; readonly probeId: number; readonly ready: boolean }
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

