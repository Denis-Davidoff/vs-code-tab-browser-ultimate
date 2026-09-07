/*---------------------------------------------------------------------------------------------
 *  Keeps the single browser view: `show` reuses the open panel instead of stacking new ones.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BrowserProxy } from './browserProxy';
import { ShowOptions, TabBrowserView } from './tabBrowserView';

export class TabBrowserManager {

	private _activeView?: TabBrowserView;

	private readonly _onDidChange = new vscode.EventEmitter<void>();
	/** Fired when the panel opens, closes, or reports another page. */
	public readonly onDidChange = this._onDidChange.event;

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _proxy: BrowserProxy,
	) { }

	public dispose(): void {
		this._activeView?.dispose();
		this._activeView = undefined;
		this._onDidChange.dispose();
	}

	public get activeView(): TabBrowserView | undefined {
		return this._activeView;
	}

	public show(inputUri: string | vscode.Uri, options?: ShowOptions): void {
		const url = typeof inputUri === 'string' ? inputUri : inputUri.toString(true);
		if (this._activeView) {
			this._activeView.show(url, options);
		} else {
			const view = TabBrowserView.create(this._extensionUri, this._proxy, url, options);
			this._registerWebviewListeners(view);
			this._activeView = view;
		}
		this._onDidChange.fire();
	}

	public restore(panel: vscode.WebviewPanel, state: any): void {
		const url = state?.url ?? '';
		const view = TabBrowserView.restore(this._extensionUri, this._proxy, url, panel);
		this._registerWebviewListeners(view);
		this._activeView ??= view;
		this._onDidChange.fire();
	}

	private _registerWebviewListeners(view: TabBrowserView): void {
		view.onDispose(() => {
			if (this._activeView === view) {
				this._activeView = undefined;
			}
			this._onDidChange.fire();
		});
		view.onDidChangeState(() => this._onDidChange.fire());
	}
}
