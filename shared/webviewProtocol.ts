/*---------------------------------------------------------------------------------------------
 *  Messages exchanged between the extension host and the Tab Browser Ultimate webview.
 *--------------------------------------------------------------------------------------------*/

import { ConsoleEntry, EditAction, PageRequest, PickedElement, ShortcutAction } from './protocol';

/**
 * Entries of the toolbar's own menu, which is about the panel rather than about the page: the
 * shortcuts a browser keeps for itself, and the editing commands, which are in the menu because
 * that is the only place this extension can put them — see `edit` below.
 */
export type BrowserMenuCommand = ShortcutAction | EditAction;

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

/**
 * Entries of the menu a right-click in the page opens: the element ones, plus the editor's
 * developer tools. Every one of them is also a copy menu entry, bar `inspect`, which is the one
 * thing the panel cannot do to an element itself.
 */
export type ContextMenuCommand = CopyCommand | 'inspect';

/**
 * The entries that ask the page for its console output; every other one picks an element. Said
 * once, because a new entry that is missing from a list like this reads as its opposite — a
 * console entry left out of it starts the picker instead of collecting anything.
 */
export function isConsoleCommand(command: CopyCommand): boolean {
	return command.startsWith('console');
}

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
	| { readonly type: 'openDevTools' }
	/** A second panel, which only the extension host can open. */
	| { readonly type: 'newTab' }
	/** What a copy in the page selected, when the page was not allowed to write it itself. */
	| { readonly type: 'writeClipboard'; readonly text: string }
	/**
	 * Run an editing command for the panel — chosen from its menu. It comes back as `edit`
	 * below, with the clipboard's content when there is pasting to do, since only the extension
	 * host may read the clipboard.
	 */
	| { readonly type: 'runEdit'; readonly action: EditAction };

/** Every message below reaches the webview wrapped with the panel's token. */
export type ExtensionToWebviewMessage =
	| { readonly type: 'focus' }
	| { readonly type: 'didChangeFocusLockIndicatorEnabled'; readonly focusLockEnabled: boolean }
	/** Watched rather than read once, since the page has to be told before it is right-clicked. */
	| { readonly type: 'didChangeContextMenuEnabled'; readonly contextMenuEnabled: boolean }
	| {
		readonly type: 'didResolveUrl';
		readonly requestId: number;
		readonly loadUrl: string;
		readonly displayUrl: string;
		readonly instrumented: boolean;
		readonly error?: string;
	}
	| {
		/**
		 * The proxy has started serving another origin — a redirect that left the site the
		 * panel was opened on, say — so the webview may now hear an agent from it.
		 */
		readonly type: 'didChangeAgentOrigins';
		readonly origins: readonly string[];
	}
	/**
	 * A file the page was served from changed on disk. The panel reloads rather than reaching
	 * into the page, since a page off the disk has no dev server to do anything cleverer.
	 */
	| { readonly type: 'reloadPage' }
	/** The pages the panel has been on, for the address bar to complete against. */
	| { readonly type: 'didChangeRecentUrls'; readonly urls: readonly string[] }
	/** One of the zoom commands, which are keybindings as well as menu entries. */
	| { readonly type: 'zoom'; readonly direction: 'in' | 'out' | 'reset' }
	/**
	 * A standard editing command the editor's keybinding for it cannot carry into the page.
	 * `text` is what to paste, read from the clipboard by the extension host.
	 */
	| { readonly type: 'edit'; readonly action: EditAction; readonly text?: string }
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
	/** Whether a right-click in the page opens the panel's own menu. */
	readonly contextMenuEnabled: boolean;
	readonly preferAttributes: readonly string[];
	/**
	 * Origins the local proxy serves, and so the only ones a document carrying the injected
	 * agent can speak from. The framed page can post anything into the webview — the shapes are
	 * in the script the proxy injects into it, so nothing about them is secret — but it cannot
	 * lie about the `origin` the browser stamps on the message. Without this, a page the proxy
	 * does not serve can answer the panel's questions, be taken for instrumented, and have its
	 * own idea of the picked element written into the workspace and handed to an assistant.
	 */
	readonly agentOrigins: readonly string[];
	/** Pages this project's panel has been on, newest first; the address bar completes them. */
	readonly recentUrls: readonly string[];
}

export interface TabBrowserState {
	readonly url: string;
	/** Copy menu entry the split button runs when its main half is clicked. */
	readonly lastCopyCommand?: CopyCommand;
	/**
	 * How far the page is zoomed, as a factor. Kept per panel and across restarts, the way a
	 * browser keeps it per site: a page read at 150% is read at 150% again tomorrow.
	 */
	readonly zoom?: number;
}
