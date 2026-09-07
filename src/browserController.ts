/*---------------------------------------------------------------------------------------------
 *  What the browser panel can be asked to do, in terms that have nothing to do with mcp.
 *
 *  The mcp server talks to this, not to the panel: it keeps the transport free of webview
 *  details, and gives one place where "there is no panel open" and "the page cannot be
 *  inspected" are turned into answers a caller can act on.
 *--------------------------------------------------------------------------------------------*/

import { PageRequest } from '../shared/protocol';
import { TabBrowserManager } from './tabBrowserManager';

export interface BrowserState {
	readonly open: boolean;
	readonly url?: string;
	/** False when the page is loaded directly, in which case it cannot be read or driven. */
	readonly inspectable?: boolean;
}

export class BrowserController {

	constructor(private readonly _manager: TabBrowserManager) { }

	public state(): BrowserState {
		const view = this._manager.activeView;
		return view
			? { open: true, url: view.url, inspectable: view.inspectable }
			: { open: false };
	}

	/**
	 * Opens the url in the panel, reusing the one that is already open, and answers once the
	 * page is there — a caller's next tool call would otherwise land mid-load.
	 */
	public async navigate(url: string): Promise<BrowserState> {
		this._manager.show(url);

		const view = this._manager.activeView;
		try {
			await view?.whenReady();
		} catch {
			// Loaded, but not through the proxy — `state` says as much.
		}
		return this.state();
	}

	public ask(request: PageRequest, timeout?: number): Promise<unknown> {
		return this._view().runPageRequest(request, timeout);
	}

	/** The element the user picked with the copy menu, if any. */
	public lastPick(): unknown {
		const pick = this._view().lastPick;
		if (!pick) {
			throw new Error('Nothing has been picked in the browser panel yet. '
				+ 'Ask for an element by selector, or pick one from the panel\'s copy menu first.');
		}
		return pick;
	}

	public console(level?: string, limit?: number): Promise<unknown> {
		return this.ask({ type: 'console', level: level as never, limit });
	}

	private _view() {
		const view = this._manager.activeView;
		if (!view) {
			throw new Error('No browser panel is open. Open one with the browser_navigate tool.');
		}
		return view;
	}
}
