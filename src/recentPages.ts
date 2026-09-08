/*---------------------------------------------------------------------------------------------
 *  The pages this project's panel has been on.
 *
 *  In `workspaceState`, because a dev url belongs to the project and not to the user — and one
 *  list rather than one per reader, since the sidebar's "Recent" section and the address bar's
 *  completion are two views of the same history.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const recentUrlsKey = 'recentUrls';
/**
 * More than either reader shows: the sidebar lists a handful, and the address bar *filters*
 * this list rather than reading it in order, so a page that was open last week is worth
 * keeping for as long as typing three letters can still find it.
 */
const maxRemembered = 50;

export class RecentPages {

	private readonly _onDidChange = new vscode.EventEmitter<void>();
	public readonly onDidChange = this._onDidChange.event;

	constructor(private readonly _state: vscode.Memento) { }

	public dispose(): void {
		this._onDidChange.dispose();
	}

	public all(): string[] {
		return this._state.get<string[]>(recentUrlsKey, [])
			.filter(url => typeof url === 'string' && !!url);
	}

	/** Keeps a page the panel is on, so it can be reopened after the panel is closed. */
	public remember(url: string | undefined): void {
		// A file the panel was pointed at is a page of this project as much as a url is;
		// anything else — the empty url of a new tab — is not a page at all.
		if (!url || !/^(https?|file):/i.test(url)) {
			return;
		}

		// The panel reports its state several times per page — loaded, instrumented, ready.
		const recent = this.all();
		if (recent[0] === url) {
			return;
		}

		this._state.update(
			recentUrlsKey,
			[url, ...recent.filter(seen => seen !== url)].slice(0, maxRemembered));
		this._onDidChange.fire();
	}
}
