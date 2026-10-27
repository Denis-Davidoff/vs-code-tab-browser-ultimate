/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { cutText, insideFolder, lineSnippet, symbolColumn } from './editorText';

/**
 * The editor as the MCP server's agents see it: `editor_context` (what the user
 * has in front of them), `editor_reveal` (show the user a place), and the
 * language features — `editor_definition`, `editor_references`,
 * `editor_symbols` — through the same providers VS Code's own "Go to
 * Definition" uses, so an agent navigates by symbol rather than by grep.
 *
 * **Only files inside the window's workspace folders**, symlinks resolved. An
 * agent's arguments can come from a page it read, and showing `~/.ssh/id_rsa`
 * in an editor during a screen share is a leak even though nothing is written.
 * A definition the language server finds outside the workspace (a library's
 * `.d.ts`, the TypeScript lib) is reported by path and line — its text is
 * public — but cannot be revealed.
 */

/** How long a language feature may take: the first call can wait for a language server to start. */
const providerTimeoutMs = 20_000;
/**
 * An empty answer from a language that has not answered yet is asked again
 * after these pauses: the TypeScript server took about 15 s to answer its first
 * request in a fresh window (measured, VS Code 1.14x), and an empty list then
 * read as "there is no definition". Once a language has answered, an empty
 * answer is taken as it is.
 */
const warmUpRetryMs = [2_000, 3_000, 5_000, 7_000, 8_000];
const maxLocations = 100;
const maxSymbols = 100;
const maxSelection = 20_000;
const maxTabs = 50;
const maxDiagnostics = 50;

interface Resolved {
	readonly uri: vscode.Uri;
	readonly folder: vscode.WorkspaceFolder;
}

export class EditorTools implements vscode.Disposable {
	private readonly _subscriptions: vscode.Disposable[] = [];
	/** The last text editor the user had in front of them — the browser tab or the chat takes focus without being one. */
	private _last: vscode.TextEditor | undefined;
	/** Languages whose server has answered with something at least once. */
	private readonly _warm = new Set<string>();

	constructor() {
		this._last = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
		this._subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
			if (editor) {
				this._last = editor;
			}
		}));
	}

	/* ------------------------------------------------------------- context */

	/**
	 * What the user is looking at: the active text editor — or, while a
	 * browser tab or the chat has focus, the one they had last — with its
	 * cursor, selection and problems, plus the other open files. A file
	 * outside the workspace is named as such and nothing of it is read.
	 */
	public async context(): Promise<unknown> {
		const editor = vscode.window.activeTextEditor ?? this._last;
		const active = editor && !editor.document.isClosed ? await this._describe(editor, editor !== vscode.window.activeTextEditor) : undefined;
		const tabs: unknown[] = [];
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (tabs.length >= maxTabs) {
					break;
				}
				const input = tab.input;
				if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputTextDiff) {
					const uri = input instanceof vscode.TabInputText ? input.uri : input.modified;
					tabs.push({ path: this._display(uri), active: tab.isActive || undefined, unsaved: tab.isDirty || undefined, diff: input instanceof vscode.TabInputTextDiff || undefined });
				} else if (input === undefined && tab.label) {
					// The browser editor, which `tabGroups` does not model — named by its label.
					tabs.push({ label: tab.label, kind: 'other' });
				}
			}
		}
		return {
			workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(f => f.name),
			activeEditor: active ?? null,
			note: active ? undefined : 'No text editor is open. The user may be looking at a browser tab — browser_state says which.',
			openFiles: tabs,
		};
	}

	private async _describe(editor: vscode.TextEditor, previous: boolean): Promise<unknown> {
		const doc = editor.document;
		// The editor's own line and selection are read from memory, not through
		// `_resolve`, so the real-path boundary is checked here as well: a file
		// opened through a symlink inside the workspace may live outside it.
		const inside = doc.isUntitled || await this._readableInside(doc.uri);
		const display = this._display(doc.uri);
		const sel = editor.selection;
		const base = {
			path: display,
			language: doc.languageId,
			lines: doc.lineCount,
			unsaved: doc.isDirty || undefined,
			focused: previous ? false : undefined,
			note: previous ? 'Not focused now: the user moved to another part of the window (a browser tab, a chat) since.' : undefined,
			cursor: { line: sel.active.line + 1, column: sel.active.character + 1 },
		};
		if (!inside) {
			return { ...base, outsideWorkspace: true };
		}
		const selection = sel.isEmpty ? undefined : (() => {
			const cut = cutText(doc.getText(sel), maxSelection);
			return {
				start: { line: sel.start.line + 1, column: sel.start.character + 1 },
				end: { line: sel.end.line + 1, column: sel.end.character + 1 },
				text: cut.text,
				truncated: cut.truncated,
			};
		})();
		const problems = vscode.languages.getDiagnostics(doc.uri)
			.filter(d => d.severity <= vscode.DiagnosticSeverity.Warning)
			.slice(0, maxDiagnostics)
			.map(d => ({
				severity: d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning',
				line: d.range.start.line + 1,
				message: lineSnippet(d.message, 400),
				source: d.source,
			}));
		return {
			...base,
			currentLine: lineSnippet(doc.lineAt(sel.active.line).text, 400),
			selection,
			problems: problems.length ? problems : undefined,
		};
	}

	/* -------------------------------------------------------------- reveal */

	/**
	 * Opens a workspace file at a line, the range selected, **without taking
	 * focus** and as a preview, so the next reveal reuses the tab. Never over
	 * a browser tab the user is looking at: when the active group shows one,
	 * the file opens in another group, or beside it.
	 */
	public async reveal(file: string, line: number | undefined, endLine: number | undefined): Promise<unknown> {
		const { uri } = await this._resolve(file);
		const doc = await vscode.workspace.openTextDocument(uri);
		const startLine = Math.min(Math.max(1, line ?? 1), doc.lineCount) - 1;
		const lastLine = Math.min(Math.max(startLine + 1, endLine ?? startLine + 1), doc.lineCount) - 1;
		const range = new vscode.Range(startLine, 0, lastLine, doc.lineAt(lastLine).text.length);
		const editor = await vscode.window.showTextDocument(doc, {
			viewColumn: this._columnBesideBrowser(),
			preserveFocus: true,
			preview: true,
			selection: new vscode.Selection(range.start, range.start),
		});
		editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		editor.selection = new vscode.Selection(range.start, range.end);
		return { opened: this._display(uri), lines: `${startLine + 1}–${lastLine + 1}`, note: 'Shown to the user without taking focus.' };
	}

	/** The column to open in: the active one, unless it is showing a browser tab — then another text group, or beside. */
	private _columnBesideBrowser(): vscode.ViewColumn {
		const active = vscode.window.tabGroups.activeTabGroup;
		const showsBrowser = active.activeTab !== undefined && active.activeTab.input === undefined;
		if (!showsBrowser) {
			return active.viewColumn;
		}
		const other = vscode.window.tabGroups.all.find(g => g !== active && !(g.activeTab && g.activeTab.input === undefined));
		return other?.viewColumn ?? vscode.ViewColumn.Beside;
	}

	/* ---------------------------------------------------- language features */

	/** Where the symbol on that line is defined, by the language server. */
	public async definition(file: string, line: number, symbol: string, occurrence: number | undefined): Promise<unknown> {
		const at = await this._position(file, line, symbol, occurrence);
		const found = await this._warmedUp(at.language, () => this._provider<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', at.uri, at.position));
		const locations = await this._locations(found ?? []);
		return { symbol, from: `${this._display(at.uri)}:${line}`, definitions: locations, note: locations.length ? undefined : this._none('definition') };
	}

	/** Every reference to the symbol on that line, by the language server. */
	public async references(file: string, line: number, symbol: string, occurrence: number | undefined, includeDeclaration: boolean): Promise<unknown> {
		const at = await this._position(file, line, symbol, occurrence);
		const found = await this._warmedUp(at.language, () => this._provider<vscode.Location[]>('vscode.executeReferenceProvider', at.uri, at.position, { includeDeclaration }));
		const all = found ?? [];
		const locations = await this._locations(all);
		return {
			symbol, from: `${this._display(at.uri)}:${line}`, total: all.length,
			references: locations,
			truncated: all.length > maxLocations || undefined,
			note: all.length ? undefined : this._none('reference'),
		};
	}

	/** Symbols across the workspace whose name matches `query`, by the language servers. */
	public async symbols(query: string): Promise<unknown> {
		const found = await this._warmedUp('*', () => this._provider<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', query)) ?? [];
		const inside = found.filter(s => this._insideWorkspace(s.location.uri));
		return {
			query,
			total: inside.length,
			symbols: inside.slice(0, maxSymbols).map(s => ({
				name: s.name,
				kind: vscode.SymbolKind[s.kind]?.toLowerCase(),
				container: s.containerName || undefined,
				path: this._display(s.location.uri),
				line: s.location.range.start.line + 1,
			})),
			truncated: inside.length > maxSymbols || undefined,
			note: inside.length ? undefined : 'No symbol matched. Language servers answer only for languages with an extension installed and, for some, only once a file of that language has been opened.',
		};
	}

	private _none(what: string): string {
		return `No ${what} found. The language server may still be starting (try again in a few seconds), there may be none for this language, `
			+ 'or the symbol text and line do not point at an identifier.';
	}

	/** Asks again while a language that has never answered answers nothing; see `warmUpRetryMs`. */
	private async _warmedUp<T extends readonly unknown[]>(language: string, ask: () => Promise<T | undefined>): Promise<T | undefined> {
		let found = await ask();
		for (const pause of this._warm.has(language) ? [] : warmUpRetryMs) {
			if (found?.length) {
				break;
			}
			await new Promise(resolve => setTimeout(resolve, pause));
			found = await ask();
		}
		if (found?.length) {
			this._warm.add(language);
		}
		return found;
	}

	private async _position(file: string, line: number, symbol: string, occurrence: number | undefined): Promise<{ uri: vscode.Uri; position: vscode.Position; language: string }> {
		const { uri } = await this._resolve(file);
		const doc = await vscode.workspace.openTextDocument(uri);
		if (line > doc.lineCount) {
			throw new Error(`${this._display(uri)} has ${doc.lineCount} lines; line ${line} does not exist.`);
		}
		const text = doc.lineAt(line - 1).text;
		const column = symbolColumn(text, symbol, occurrence);
		if (column < 0) {
			throw new Error(`"${lineSnippet(symbol, 80)}" is not on line ${line} of ${this._display(uri)}, which reads: ${lineSnippet(text)}`);
		}
		return { uri, position: new vscode.Position(line - 1, column), language: doc.languageId };
	}

	private async _provider<T>(command: string, ...args: unknown[]): Promise<T | undefined> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				vscode.commands.executeCommand<T>(command, ...args),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error(`The language server did not answer within ${providerTimeoutMs / 1000}s — it may still be starting. Try again.`)), providerTimeoutMs);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	/** Locations as a model reads them: a path, a 1-based line and column, and the line itself. */
	private async _locations(found: readonly (vscode.Location | vscode.LocationLink)[]): Promise<unknown[]> {
		const out: unknown[] = [];
		const docs = new Map<string, vscode.TextDocument | undefined>();
		for (const item of found.slice(0, maxLocations)) {
			const uri = 'targetUri' in item ? item.targetUri : item.uri;
			const range = 'targetUri' in item ? (item.targetSelectionRange ?? item.targetRange) : item.range;
			const key = uri.toString();
			if (!docs.has(key)) {
				docs.set(key, await Promise.resolve(vscode.workspace.openTextDocument(uri)).catch(() => undefined));
			}
			const doc = docs.get(key);
			const lineNo = range.start.line;
			out.push({
				path: this._display(uri),
				line: lineNo + 1,
				column: range.start.character + 1,
				outsideWorkspace: this._insideWorkspace(uri) ? undefined : true,
				text: doc && lineNo < doc.lineCount ? lineSnippet(doc.lineAt(lineNo).text) : undefined,
			});
		}
		return out;
	}

	/* ---------------------------------------------------------------- paths */

	/**
	 * A path an agent gave — relative to a workspace folder, or absolute — as a
	 * workspace file. The folder's own URI is joined, so a remote window keeps
	 * its scheme; a local file is compared on real paths, so a symlink inside
	 * the folder that leads out of it is outside.
	 */
	private async _resolve(file: string): Promise<Resolved> {
		const folders = vscode.workspace.workspaceFolders ?? [];
		if (!folders.length) {
			throw new Error('No folder is open in this VS Code window, so there are no workspace files to open.');
		}
		const trimmed = file.trim();
		const candidates: Resolved[] = [];
		for (const folder of folders) {
			const root = folder.uri.fsPath;
			if (path.isAbsolute(trimmed)) {
				if (insideFolder(root, trimmed)) {
					candidates.push({ folder, uri: vscode.Uri.joinPath(folder.uri, path.relative(root, trimmed).split(path.sep).join('/')) });
				}
			} else {
				// `<folder name>/…` in a multi-root window, as `_display` writes it.
				const named = folders.length > 1 && trimmed.startsWith(`${folder.name}/`) ? trimmed.slice(folder.name.length + 1) : trimmed;
				if (insideFolder(root, path.resolve(root, named))) {
					candidates.push({ folder, uri: vscode.Uri.joinPath(folder.uri, named) });
				}
			}
		}
		for (const candidate of candidates) {
			let stat: vscode.FileStat;
			try {
				stat = await vscode.workspace.fs.stat(candidate.uri);
			} catch {
				continue;
			}
			if (stat.type & vscode.FileType.Directory) {
				throw new Error(`${this._display(candidate.uri)} is a folder, not a file.`);
			}
			if (candidate.uri.scheme === 'file' && !(await this._realInside(candidate.folder.uri.fsPath, candidate.uri.fsPath))) {
				throw new Error(`${file} leads outside the workspace through a symbolic link, so it is not opened.`);
			}
			return candidate;
		}
		throw new Error(candidates.length
			? `No such file in the workspace: ${file}`
			: `${file} is outside the workspace (${folders.map(f => f.name).join(', ')}); only its files can be opened.`);
	}

	private async _realInside(root: string, file: string): Promise<boolean> {
		try {
			const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
			return insideFolder(realRoot, realFile);
		} catch {
			return false;
		}
	}

	/** Inside a workspace folder, and for a local file, still inside once symlinks are resolved. */
	private async _readableInside(uri: vscode.Uri): Promise<boolean> {
		const folder = vscode.workspace.getWorkspaceFolder(uri);
		if (!folder) {
			return false;
		}
		return uri.scheme !== 'file' || await this._realInside(folder.uri.fsPath, uri.fsPath);
	}

	private _insideWorkspace(uri: vscode.Uri): boolean {
		return !!vscode.workspace.getWorkspaceFolder(uri);
	}

	/** A path relative to its workspace folder (prefixed with the folder's name when there are several), else as it is. */
	private _display(uri: vscode.Uri): string {
		if (uri.scheme === 'untitled') {
			return `untitled:${uri.path}`;
		}
		return vscode.workspace.asRelativePath(uri, (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
	}

	public dispose(): void {
		this._subscriptions.forEach(s => s.dispose());
	}
}
