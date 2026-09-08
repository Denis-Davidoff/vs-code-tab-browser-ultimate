/*---------------------------------------------------------------------------------------------
 *  Keeps the browser panels: `show` reuses the one in front instead of stacking new ones, and
 *  "New tab" is the one thing that opens another.
 *
 *  Panels are kept most-recently-active first, so `activeView` — which is what every command,
 *  the sidebar and every mcp tool act on — is "the browser panel" in the only sense a person
 *  with two of them open would mean: the one they were last looking at.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BrowserProxy } from './browserProxy';
import { RecentPages } from './recentPages';
import { ShowOptions, TabBrowserView } from './tabBrowserView';

/** How many browser panels can be open at once; see `newTab`. */
const maxPanels = 16;

export class TabBrowserManager {

	private readonly _views: TabBrowserView[] = [];

	private readonly _onDidChange = new vscode.EventEmitter<void>();
	/** Fired when a panel opens, closes, takes the focus, or reports another page. */
	public readonly onDidChange = this._onDidChange.event;

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _proxy: BrowserProxy,
		private readonly _recent: RecentPages,
		private readonly _iconDirectory: vscode.Uri,
	) { }

	public dispose(): void {
		for (const view of [...this._views]) {
			view.dispose();
		}
		this._views.length = 0;
		this._onDidChange.dispose();
	}

	public get activeView(): TabBrowserView | undefined {
		return this._views[0];
	}

	public show(inputUri: string | vscode.Uri, options?: ShowOptions): void {
		const url = typeof inputUri === 'string' ? inputUri : inputUri.toString(true);
		const view = this.activeView;
		if (view) {
			view.show(url, options);
			this._onDidChange.fire();
		} else {
			this.newTab(url, options);
		}
	}

	/** Another panel, as a browser opens another tab; it takes the focus and the commands. */
	public newTab(url = '', options?: ShowOptions): TabBrowserView | undefined {
		// A tab can be asked for by the page: `Cmd`+`T` has to work while the page has the
		// keyboard, so the injected script forwards it — and the shapes it sends are in the
		// script itself, which makes them something a page can send on its own. Every panel
		// holds a live webview (`retainContextWhenHidden`), so the count is capped rather than
		// trusted. Nobody opens sixteen browser tabs in an editor by hand.
		if (this._views.length >= maxPanels) {
			vscode.window.showWarningMessage(vscode.l10n.t(
				"There are already {0} browser panels open.", maxPanels));
			return undefined;
		}

		const view = TabBrowserView.create(this._extensionUri, this._proxy, this._recent, this._iconDirectory, url, options);
		this._add(view);
		this._onDidChange.fire();
		return view;
	}

	public restore(panel: vscode.WebviewPanel, state: any): void {
		const url = state?.url ?? '';
		this._add(TabBrowserView.restore(this._extensionUri, this._proxy, this._recent, this._iconDirectory, url, panel));
		this._onDidChange.fire();
	}

	private _add(view: TabBrowserView): void {
		// In front: a panel that has just been created or restored is the one being looked at,
		// and the editor only reports a view state change once something else takes over.
		this._views.unshift(view);

		view.onDispose(() => {
			const at = this._views.indexOf(view);
			if (at !== -1) {
				this._views.splice(at, 1);
			}
			this._onDidChange.fire();
		});
		view.onDidChangeState(() => {
			// Remembered from the page a panel *reports*, not from `onDidChange`: that fires
			// for the focus moving between panels as well, and coming back to a panel opened
			// an hour ago would stamp its page as the newest thing visited.
			this._recent.remember(view.url);
			this._onDidChange.fire();
		});
		view.onDidBecomeActive(() => {
			const at = this._views.indexOf(view);
			if (at > 0) {
				this._views.splice(at, 1);
				this._views.unshift(view);
			}
			this._onDidChange.fire();
		});
		// Beside the panel that asked, which is where a new tab belongs.
		view.onDidRequestNewTab(() => this.newTab());
	}
}
