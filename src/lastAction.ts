/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Every action the toolbar button can repeat: the three copies, and the same
 * three for each assistant. The value is compared verbatim in `when` clauses,
 * so these strings are part of the manifest's contract.
 */
export type ElementActionId =
	| 'element' | 'cssPath' | 'xpath'
	| 'claude:element' | 'claude:cssPath' | 'claude:xpath'
	| 'codex:element' | 'codex:cssPath' | 'codex:xpath';

const allActions: readonly string[] = [
	'element', 'cssPath', 'xpath',
	'claude:element', 'claude:cssPath', 'claude:xpath',
	'codex:element', 'codex:cssPath', 'codex:xpath',
];

const contextKey = 'aiBrowser.lastElementAction';
const mementoKey = 'aiBrowser.lastElementAction';
const fallback: ElementActionId = 'element';

function isElementActionId(value: unknown): value is ElementActionId {
	return typeof value === 'string' && allActions.includes(value);
}

/**
 * Remembers which element command was used last, so the toolbar can offer it as
 * a one-click repeat next to the dropdown.
 *
 * This reproduces a split button the long way round. VS Code has the real
 * thing — `isSplitButton: { togglePrimaryAction: true }` on a submenu menu
 * item, rendered by `DropdownWithDefaultActionViewItem`, which even persists
 * the last action itself — but `menusExtensionPoint.ts` builds extension menu
 * items from `{submenu, icon, title, group, order, when}` only and never sets
 * that flag, so it is unavailable from a manifest.
 *
 * Instead: three primary buttons contributed to `editor/title`, each with a
 * `when` clause on the {@link contextKey} context key, so exactly one is
 * visible at a time. The value is mirrored into a memento, because a context
 * key does not survive a restart.
 */
export class LastElementAction {

	constructor(private readonly memento: vscode.Memento) { }

	public get value(): ElementActionId {
		const stored = this.memento.get<string>(mementoKey);
		return isElementActionId(stored) ? stored : fallback;
	}

	/**
	 * Publishes the remembered value into the context key.
	 *
	 * Must run on activation: `when` clauses are evaluated before the extension
	 * is activated, so until this happens no primary button matches and the
	 * toolbar shows only the dropdown. That is why the manifest carries
	 * `onStartupFinished`.
	 */
	public async initialize(): Promise<void> {
		await vscode.commands.executeCommand('setContext', contextKey, this.value);
	}

	public async record(id: ElementActionId): Promise<void> {
		await this.memento.update(mementoKey, id);
		await vscode.commands.executeCommand('setContext', contextKey, id);
	}
}
