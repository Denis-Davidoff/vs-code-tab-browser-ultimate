/*---------------------------------------------------------------------------------------------
 *  Messages exchanged between the extension host and the Tab Browser Ultimate webview.
 *--------------------------------------------------------------------------------------------*/

import { ConsoleEntry, PickedElement } from './protocol';

/** Entries of the toolbar's copy menu. */
export type CopyCommand =
	| 'element'
	| 'elementXPath'
	| 'elementPath'
	| 'elementClaude'
	| 'elementXPathClaude'
	| 'elementPathClaude'
	| 'console';

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
	}
	/** Icon of the loaded page, for the panel's tab. */
	| { readonly type: 'setIcon'; readonly href: string }
	| { readonly type: 'showError'; readonly message: string }
	| { readonly type: 'openDevTools' };

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
		readonly type: 'didCopy';
		/** Short text for the hint bar, not necessarily what landed on the clipboard. */
		readonly text: string;
		readonly keepPickerActive: boolean;
	};

export interface TabBrowserSettings {
	readonly url: string;
	readonly focusLockEnabled: boolean;
	readonly preferAttributes: readonly string[];
}

export interface TabBrowserState {
	readonly url: string;
	/** Copy menu entry the split button runs when its main half is clicked. */
	readonly lastCopyCommand?: CopyCommand;
}
