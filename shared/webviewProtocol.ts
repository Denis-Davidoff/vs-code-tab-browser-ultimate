/*---------------------------------------------------------------------------------------------
 *  Messages exchanged between the extension host and the Tab Browser Ultimate webview.
 *--------------------------------------------------------------------------------------------*/

import { ConsoleEntry, PageRequest, PickedElement } from './protocol';

/** Entries of the toolbar's copy menu. */
export type CopyCommand =
	| 'element'
	| 'elementXPath'
	| 'elementPath'
	| 'elementClaude'
	| 'elementXPathClaude'
	| 'elementPathClaude'
	| 'elementCodex'
	| 'elementXPathCodex'
	| 'elementPathCodex'
	| 'console'
	| 'consoleClaude'
	| 'consoleCodex';

export type WebviewToExtensionMessage =
	| { readonly type: 'openExternal'; readonly url: string }
	| {
		readonly type: 'resolveUrl';
		readonly requestId: number;
		readonly url: string;
		/** True when the caller needs the injected page script, i.e. the proxy. */
		readonly instrument: boolean;
	}
	| {
		readonly type: 'copyElement';
		readonly element: PickedElement;
		/** The menu entry the pick was started from; it decides what lands on the clipboard. */
		readonly command: CopyCommand;
	}
	| {
		readonly type: 'copyConsole';
		readonly entries: readonly ConsoleEntry[];
		readonly documentUrl: string;
		readonly dropped: number;
		/** The menu entry that asked for it; it decides where the log ends up. */
		readonly command: CopyCommand;
	}
	| {
		readonly type: 'didRunPageRequest';
		readonly requestId: number;
		readonly value?: unknown;
		readonly error?: string;
	}
	/** Icon of the loaded page, for the panel's tab. */
	| { readonly type: 'setIcon'; readonly href: string }
	/** Title of the loaded page, for the panel's tab. */
	| { readonly type: 'setTitle'; readonly title: string }
	| {
		/** Sent whenever any of it changes, so the host can answer for the panel. */
		readonly type: 'didChangeState';
		readonly url: string;
		/** The page is served through the proxy, i.e. it carries the injected script. */
		readonly instrumented: boolean;
		/** The injected script has reported in and can answer requests. */
		readonly ready: boolean;
	}
	| { readonly type: 'showError'; readonly message: string }
	| { readonly type: 'openDevTools' };

/** Every message below reaches the webview wrapped with the panel's token. */
export type ExtensionToWebviewMessage =
	| { readonly type: 'focus' }
	| { readonly type: 'didChangeFocusLockIndicatorEnabled'; readonly focusLockEnabled: boolean }
	| {
		readonly type: 'didResolveUrl';
		readonly requestId: number;
		readonly loadUrl: string;
		readonly displayUrl: string;
		readonly instrumented: boolean;
		readonly error?: string;
	}
	| { readonly type: 'runCopyCommand'; readonly command: CopyCommand }
	| {
		/** Asked for by an mcp client; the page answers with `didRunPageRequest`. */
		readonly type: 'runPageRequest';
		readonly requestId: number;
		readonly request: PageRequest;
	}
	| {
		readonly type: 'didCopy';
		/** Short text for the hint bar, not necessarily what landed on the clipboard. */
		readonly text: string;
		readonly keepPickerActive: boolean;
	};

export interface TabBrowserSettings {
	/**
	 * Secret of this panel, handed to the webview in its own dom. Every message from the
	 * extension host carries it, and the webview drops the ones that do not: the framed page
	 * can post into the webview too, and must not be able to pass for the host.
	 */
	readonly token: string;
	readonly url: string;
	readonly focusLockEnabled: boolean;
	readonly preferAttributes: readonly string[];
}

export interface TabBrowserState {
	readonly url: string;
	/** Copy menu entry the split button runs when its main half is clicked. */
	readonly lastCopyCommand?: CopyCommand;
}
