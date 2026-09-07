/*---------------------------------------------------------------------------------------------
 *  The webview panel: the html it is built from, the messages it exchanges with its script,
 *  and the reports the copy menu writes to the clipboard.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BrowserProxy, getConfiguration, isLocalUrl, parseHttpUrl } from './browserProxy';
import { copyReport, slugify } from './clipboardFile';
import * as claudeCode from './claudeCode';
import { defaultIconUrl, discoverIconUrl, fetchIcon } from './favicon';
import { Disposable } from './dispose';
import { generateUuid } from './uuid';
import { ConsoleEntry, CssRule, defaultPreferredAttributes, PickedElement } from '../shared/protocol';
import {
	CopyCommand,
	ExtensionToWebviewMessage,
	TabBrowserSettings,
	WebviewToExtensionMessage,
} from '../shared/webviewProtocol';

export interface ShowOptions {
	readonly preserveFocus?: boolean;
	readonly viewColumn?: vscode.ViewColumn;
}

export class TabBrowserView extends Disposable {

	public static readonly viewType = 'tabBrowser.view';
	private static readonly title = vscode.l10n.t("Tab Browser Ultimate");

	private static getWebviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
		return {
			enableScripts: true,
			enableForms: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
		};
	}

	private readonly _webviewPanel: vscode.WebviewPanel;

	private readonly _onDidDispose = this._register(new vscode.EventEmitter<void>());
	public readonly onDispose = this._onDidDispose.event;

	/** Proves to the webview that a message came from here and not from the page it frames. */
	private readonly _token = generateUuid();

	/** Invalidates icon requests still in flight when the panel navigates away. */
	private _iconToken = 0;
	/** Origin the current tab icon belongs to. */
	private _iconOrigin: string | undefined;

	public static create(
		extensionUri: vscode.Uri,
		proxy: BrowserProxy,
		url: string,
		showOptions?: ShowOptions,
	): TabBrowserView {
		const webview = vscode.window.createWebviewPanel(TabBrowserView.viewType, TabBrowserView.title, {
			viewColumn: showOptions?.viewColumn ?? vscode.ViewColumn.Active,
			preserveFocus: showOptions?.preserveFocus,
		}, {
			retainContextWhenHidden: true,
			...TabBrowserView.getWebviewOptions(extensionUri),
		});
		return new TabBrowserView(extensionUri, proxy, url, webview);
	}

	public static restore(
		extensionUri: vscode.Uri,
		proxy: BrowserProxy,
		url: string,
		webviewPanel: vscode.WebviewPanel,
	): TabBrowserView {
		return new TabBrowserView(extensionUri, proxy, url, webviewPanel);
	}

	private constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _proxy: BrowserProxy,
		url: string,
		webviewPanel: vscode.WebviewPanel,
	) {
		super();

		this._webviewPanel = this._register(webviewPanel);
		this._webviewPanel.webview.options = TabBrowserView.getWebviewOptions(_extensionUri);

		this._register(this._webviewPanel.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
			switch (message.type) {
				case 'openExternal': {
					// Never hand the os a scheme the page could have chosen, such as `file:`.
					const external = parseHttpUrl(message.url);
					if (external) {
						vscode.env.openExternal(vscode.Uri.parse(external.toString()));
					}
					break;
				}

				case 'resolveUrl':
					this._resolveUrl(message.requestId, message.url, message.instrument);
					break;

				case 'copyElement':
					this._copyElement(message.element, message.command);
					break;

				case 'copyConsole':
					this._copyConsole(message.entries, message.documentUrl, message.dropped, message.command);
					break;

				case 'setIcon':
					this._showIcon(message.href);
					break;

				case 'showError':
					vscode.window.showErrorMessage(message.message);
					break;

				case 'openDevTools':
					vscode.commands.executeCommand('workbench.action.webview.openDeveloperTools');
					break;
			}
		}));

		this._register(this._webviewPanel.onDidDispose(() => this.dispose()));

		this._register(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('tabBrowser.focusLockIndicator.enabled')) {
				this._post({
					type: 'didChangeFocusLockIndicatorEnabled',
					focusLockEnabled: getConfiguration().get<boolean>('focusLockIndicator.enabled', true),
				});
			}
		}));

		this.show(url);
	}

	public override dispose(): void {
		this._onDidDispose.fire();
		super.dispose();
	}

	public show(url: string, options?: ShowOptions): void {
		this._webviewPanel.webview.html = this._getHtml(url);
		this._webviewPanel.reveal(options?.viewColumn, options?.preserveFocus);
	}

	/** Runs one of the copy menu's commands from outside the webview. */
	public runCopyCommand(command: CopyCommand): void {
		this._post({ type: 'runCopyCommand', command });
		this._webviewPanel.reveal(undefined, false);
	}

	private _post(message: ExtensionToWebviewMessage): void {
		this._webviewPanel.webview.postMessage({ ...message, token: this._token });
	}

	/**
	 * Decides whether a url should be loaded directly or through the instrumenting proxy and
	 * answers the webview's navigation request.
	 */
	private async _resolveUrl(requestId: number, rawUrl: string, instrument: boolean): Promise<void> {
		const normalized = normalizeUrl(rawUrl);
		const displayUrl = this._proxy.isProxiedUrl(normalized)
			? this._proxy.toRealUrl(normalized)
			: normalized;

		const target = parseHttpUrl(displayUrl);
		const mode = getConfiguration().get<'localhost' | 'always' | 'never'>('proxy.mode', 'localhost');

		const wantsProxy = !!target && mode !== 'never'
			&& (instrument || mode === 'always' || (mode === 'localhost' && isLocalUrl(target)));

		if (!wantsProxy) {
			const error = instrument
				? mode === 'never'
					? vscode.l10n.t("Copying from the page needs the local proxy, but `tabBrowser.proxy.mode` is set to `never`.")
					: vscode.l10n.t("Only http and https pages can be inspected.")
				: undefined;
			this._post({ type: 'didResolveUrl', requestId, loadUrl: displayUrl, displayUrl, instrumented: false, error });
			if (!error) {
				this._resetIcon(displayUrl, false);
			}
			return;
		}

		try {
			const loadUrl = await this._proxy.getProxiedUrl(displayUrl);
			this._post({ type: 'didResolveUrl', requestId, loadUrl, displayUrl, instrumented: true });
			this._resetIcon(displayUrl, true);
		} catch (error) {
			this._post({
				type: 'didResolveUrl',
				requestId,
				loadUrl: displayUrl,
				displayUrl,
				instrumented: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Shows the page's own icon on the panel's tab. Called for whatever the page declares, and
	 * for `/favicon.ico` on pages that declare nothing or are not instrumented at all.
	 */
	private async _showIcon(href: string): Promise<void> {
		if (!getConfiguration().get<boolean>('showPageIcon', true)) {
			return;
		}

		const token = this._iconToken;
		const icon = await fetchIcon(href);
		// Navigated on while this was downloading, or the icon is not an image after all.
		if (!icon || token !== this._iconToken) {
			return;
		}

		try {
			this._webviewPanel.iconPath = icon;
		} catch {
			// The panel was closed while the icon was downloading.
		}
	}

	/** Drops the icon of the page being left, then goes looking for the new one. */
	private async _resetIcon(displayUrl: string, instrumented: boolean): Promise<void> {
		if (!getConfiguration().get<boolean>('showPageIcon', true)) {
			return;
		}

		const origin = parseHttpUrl(displayUrl)?.origin;
		const token = ++this._iconToken;

		if (origin !== this._iconOrigin) {
			// Reloading the same site keeps its icon; going somewhere else must not.
			this._webviewPanel.iconPath = undefined;
			this._iconOrigin = origin;
		}

		// An instrumented page reports what it declares by itself, so only the well known
		// location is worth a request here.
		const href = instrumented
			? defaultIconUrl(displayUrl)
			: await discoverIconUrl(displayUrl) ?? defaultIconUrl(displayUrl);

		if (href && token === this._iconToken) {
			this._showIcon(href);
		}
	}

	private async _copyElement(element: PickedElement, command: CopyCommand): Promise<void> {
		const configuration = getConfiguration();
		const keepPickerActive = configuration.get<boolean>('picker.keepActiveAfterPick', false);

		// `console` never reaches here; a pick always comes from one of the element entries.
		const action = elementActions[command as Exclude<CopyCommand, 'console' | 'consoleClaude'>]
			?? elementActions.element;
		// The menu entries for a path say which one they mean; only "Copy element" is configurable.
		const format: ElementCopyFormat = action.format
			?? configuration.get<ElementCopyFormat>('picker.copyFormat', 'context');
		const text = formatPickedElement(element, format);
		const summary = elementSummary(element, format);

		if (action.toClaude && await this._sendToClaudeCode(element, format, summary, keepPickerActive)) {
			return;
		}

		// A path is a line of text; the reports are documents and worth pasting as one.
		const fileName = format === 'context' || format === 'json'
			? `element-${slugify(element.descriptor)}-${stamp()}.${format === 'json' ? 'json' : 'md'}`
			: undefined;

		const kind = fileName
			? await copyReport(text, fileName)
			: (await vscode.env.clipboard.writeText(text), 'text' as const);

		this._post({ type: 'didCopy', text: summary, keepPickerActive });

		this._announce(kind === 'file' && fileName
			? vscode.l10n.t("Copied element as {0}: {1}", fileName, summary)
			: vscode.l10n.t("Copied element: {0}", summary));
	}

	/**
	 * Writes the report into the workspace and lets Claude Code mention it. Returns false when
	 * that is not possible, so the pick can still end up on the clipboard.
	 */
	private async _sendToClaudeCode(
		element: PickedElement,
		format: ElementCopyFormat,
		summary: string,
		keepPickerActive: boolean,
	): Promise<boolean> {
		if (!await claudeCode.isAvailable()) {
			vscode.window.showWarningMessage(
				vscode.l10n.t("Claude Code is not installed, so the element was copied to the clipboard instead."));
			return false;
		}

		// A bare path can go into a new conversation as text, if that is what is wanted.
		if (format !== 'context'
			&& getConfiguration().get<string>('claude.pathDelivery', 'mention') === 'newConversation'
			&& await claudeCode.openWithPrompt(summary)) {
			this._post({ type: 'didCopy', text: summary, keepPickerActive });
			this._announce(vscode.l10n.t("Added to a new Claude Code conversation: {0}", summary));
			return true;
		}

		const kind = format === 'xpath' ? 'xpath' : format === 'css' ? 'path' : 'context';
		const fileName = `element-${kind}-${slugify(element.descriptor)}-${stamp()}.md`;
		// A mention points at a file, so even a one line path travels as one.
		const report = format === 'context'
			? formatElementContext(element)
			: formatPathReport(element, format, summary);

		let file: vscode.Uri | undefined;
		try {
			file = await claudeCode.mentionReport(report, fileName);
		} catch (error) {
			vscode.window.showErrorMessage(vscode.l10n.t(
				"Could not hand the element to Claude Code: {0}",
				error instanceof Error ? error.message : String(error)));
			return false;
		}

		if (!file) {
			vscode.window.showWarningMessage(vscode.l10n.t(
				"Claude Code mentions files by their path in the workspace, and no folder is open. The element was copied to the clipboard instead."));
			return false;
		}

		this._post({ type: 'didCopy', text: summary, keepPickerActive });
		this._announce(vscode.l10n.t("Added {0} to Claude Code: {1}", fileName, summary));
		return true;
	}

	private async _copyConsole(
		entries: readonly ConsoleEntry[],
		documentUrl: string,
		dropped: number,
		command: CopyCommand,
	): Promise<void> {
		const text = formatConsoleEntries(entries, documentUrl, dropped);
		const summary = vscode.l10n.t("{0} console entries", entries.length);
		const fileName = `console-${slugify(hostOf(documentUrl))}-${stamp()}`;

		if (command === 'consoleClaude' && await claudeCode.isAvailable()) {
			try {
				const file = await claudeCode.mentionReport(
					formatConsoleReport(text, documentUrl), `${fileName}.md`);
				if (file) {
					this._post({ type: 'didCopy', text: summary, keepPickerActive: false });
					this._announce(vscode.l10n.t("Added {0} to Claude Code: {1}", `${fileName}.md`, summary));
					return;
				}
				vscode.window.showWarningMessage(vscode.l10n.t(
					"Claude Code mentions files by their path in the workspace, and no folder is open. The console output was copied to the clipboard instead."));
			} catch (error) {
				vscode.window.showErrorMessage(vscode.l10n.t(
					"Could not hand the console output to Claude Code: {0}",
					error instanceof Error ? error.message : String(error)));
			}
		} else if (command === 'consoleClaude') {
			vscode.window.showWarningMessage(vscode.l10n.t(
				"Claude Code is not installed, so the console output was copied to the clipboard instead."));
		}

		await copyReport(text, `${fileName}.txt`);

		this._post({ type: 'didCopy', text: summary, keepPickerActive: false });
		this._announce(vscode.l10n.t("Copied {0} console entries from {1}", entries.length, documentUrl));
	}

	private _announce(message: string): void {
		if (getConfiguration().get<boolean>('notifyOnCopy', true)) {
			vscode.window.showInformationMessage(message);
		} else {
			vscode.window.setStatusBarMessage(message, 4000);
		}
	}

	private _getHtml(url: string): string {
		const configuration = getConfiguration();
		const nonce = generateUuid();

		const mainJs = this._extensionResourceUrl('media', 'index.js');
		const mainCss = this._extensionResourceUrl('media', 'main.css');
		const codiconsUri = this._extensionResourceUrl('media', 'codicon.css');

		const settings: TabBrowserSettings = {
			token: this._token,
			url,
			focusLockEnabled: configuration.get<boolean>('focusLockIndicator.enabled', true),
			preferAttributes: configuration.get<readonly string[]>(
				'picker.preferAttributes', defaultPreferredAttributes),
		};

		const cspSource = this._webviewPanel.webview.cspSource;

		return /* html */ `<!DOCTYPE html>
			<html>
			<head>
				<meta http-equiv="Content-type" content="text/html;charset=UTF-8">

				<meta http-equiv="Content-Security-Policy" content="
					default-src 'none';
					font-src data:;
					style-src ${cspSource};
					script-src 'nonce-${nonce}';
					frame-src *;
					">

				<meta id="tab-browser-settings" data-settings="${escapeAttribute(JSON.stringify(settings))}">

				<link rel="stylesheet" type="text/css" href="${mainCss}">
				<link rel="stylesheet" type="text/css" href="${codiconsUri}">
			</head>
			<body>
				<header class="header">
					<nav class="controls">
						<button
							title="${vscode.l10n.t("Back")}"
							class="back-button icon"><i class="codicon codicon-arrow-left"></i></button>

						<button
							title="${vscode.l10n.t("Forward")}"
							class="forward-button icon"><i class="codicon codicon-arrow-right"></i></button>

						<button
							title="${vscode.l10n.t("Reload")}"
							class="reload-button icon"><i class="codicon codicon-refresh"></i></button>
					</nav>

					<input
						class="url-input"
						type="text"
						spellcheck="false"
						autocomplete="off"
						aria-label="${vscode.l10n.t("Address")}"
						placeholder="${vscode.l10n.t("https://example.com")}">

					<nav class="controls">
						<div class="copy-menu-container">
							<button
								class="copy-action-button"
								title="${vscode.l10n.t("Copy element")}"><i class="codicon codicon-inspect"></i></button>

							<button
								class="copy-menu-toggle"
								aria-haspopup="menu"
								aria-expanded="false"
								title="${vscode.l10n.t("More copy actions")}"><i
									class="codicon codicon-chevron-down"></i></button>

							<div class="copy-menu" role="menu" hidden>
								<button
									role="menuitem"
									data-command="element"
									data-icon="codicon-inspect"><i class="codicon codicon-inspect"></i><span
										class="copy-menu-label">${vscode.l10n.t("Copy element")}</span><i
										class="codicon codicon-check check"></i></button>
								<button
									role="menuitem"
									data-command="elementXPath"
									data-icon="codicon-list-tree"><i class="codicon codicon-list-tree"></i><span
										class="copy-menu-label">${vscode.l10n.t("Copy element XPath")}</span><i
										class="codicon codicon-check check"></i></button>
								<button
									role="menuitem"
									data-command="elementPath"
									data-icon="codicon-code"><i class="codicon codicon-code"></i><span
										class="copy-menu-label">${vscode.l10n.t("Copy path to element")}</span><i
										class="codicon codicon-check check"></i></button>
								<div class="copy-menu-separator" role="separator"></div>
								<button
									role="menuitem"
									data-command="elementClaude"
									data-icon="codicon-sparkle"><i class="codicon codicon-sparkle"></i><span
										class="copy-menu-label">${vscode.l10n.t("Add element to Claude Code")}</span><i
										class="codicon codicon-check check"></i></button>
								<button
									role="menuitem"
									data-command="elementXPathClaude"
									data-icon="codicon-sparkle"><i class="codicon codicon-sparkle"></i><span
										class="copy-menu-label">${vscode.l10n.t("Add element XPath to Claude Code")}</span><i
										class="codicon codicon-check check"></i></button>
								<button
									role="menuitem"
									data-command="elementPathClaude"
									data-icon="codicon-sparkle"><i class="codicon codicon-sparkle"></i><span
										class="copy-menu-label">${vscode.l10n.t("Add path to element to Claude Code")}</span><i
										class="codicon codicon-check check"></i></button>
								<div class="copy-menu-separator" role="separator"></div>
								<button
									role="menuitem"
									data-command="console"
									data-icon="codicon-terminal"><i class="codicon codicon-terminal"></i><span
										class="copy-menu-label">${vscode.l10n.t("Copy console.log")}</span><i
										class="codicon codicon-check check"></i></button>
								<button
									role="menuitem"
									data-command="consoleClaude"
									data-icon="codicon-sparkle"><i class="codicon codicon-sparkle"></i><span
										class="copy-menu-label">${vscode.l10n.t("Add console.log to Claude Code")}</span><i
										class="codicon codicon-check check"></i></button>
							</div>
						</div>

						<button
							title="${vscode.l10n.t("Open in browser")}"
							class="open-external-button icon"><i class="codicon codicon-link-external"></i></button>
					</nav>
				</header>
				<div class="hint" hidden>
					<span class="hint-message"></span>
					<span class="hint-detail"></span>
				</div>
				<div class="content">
					<div class="iframe-focused-alert">${vscode.l10n.t("Focus Lock")}</div>
					<iframe sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"></iframe>
				</div>

				<script src="${mainJs}" nonce="${nonce}"></script>
			</body>
			</html>`;
	}

	private _extensionResourceUrl(...parts: string[]): vscode.Uri {
		return this._webviewPanel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, ...parts));
	}
}

function withFramePath(element: PickedElement, selector: string): string {
	return [...element.framePath, selector].join(' >>> ');
}

export type ElementCopyFormat = 'context' | 'css' | 'xpath' | 'both' | 'json';

/** What each menu entry copies, and where it sends it. `format: undefined` means configurable. */
const elementActions: Record<Exclude<CopyCommand, 'console' | 'consoleClaude'>, {
	readonly format?: ElementCopyFormat;
	readonly toClaude: boolean;
}> = {
	element: { toClaude: false },
	elementXPath: { format: 'xpath', toClaude: false },
	elementPath: { format: 'css', toClaude: false },
	elementClaude: { format: 'context', toClaude: true },
	elementXPathClaude: { format: 'xpath', toClaude: true },
	elementPathClaude: { format: 'css', toClaude: true },
};

/** The one line shown in the panel's hint bar and in the notification. */
function elementSummary(element: PickedElement, format: ElementCopyFormat): string {
	switch (format) {
		case 'xpath':
			return withFramePath(element, element.xpath);
		case 'css':
		case 'both':
			return withFramePath(element, element.selector);
		default:
			return element.descriptor;
	}
}

/** The console log as a document, for the file a mention points at. */
export function formatConsoleReport(log: string, documentUrl: string): string {
	return [`# Console output of ${documentUrl}`, '', ...fenced(log), ''].join('\n');
}

/**
 * Everything fenced here comes from the page: its markup, its stylesheets, its log. A run of
 * backticks in any of it would end the block early and turn the rest into markdown, so the
 * fence is always longer than the longest run inside it.
 */
function fenced(content: string, language = ''): string[] {
	let longest = 0;
	for (const run of content.match(/`+/g) ?? []) {
		longest = Math.max(longest, run.length);
	}
	const fence = '`'.repeat(Math.max(3, longest + 1));
	return [`${fence}${language}`, content, fence];
}

/** Wraps a bare path in enough context to be worth reading on its own. */
export function formatPathReport(
	element: PickedElement,
	format: ElementCopyFormat,
	path: string,
): string {
	const what = format === 'xpath' ? 'XPath' : 'CSS selector';
	return [
		`# ${element.descriptor}`,
		'',
		`${what} of an element on ${element.documentUrl}`,
		'',
		...fenced(path),
		'',
	].join('\n');
}

export function formatPickedElement(element: PickedElement, format: ElementCopyFormat): string {
	switch (format) {
		case 'css':
			return withFramePath(element, element.selector);
		case 'xpath':
			return withFramePath(element, element.xpath);
		case 'both':
			return `${withFramePath(element, element.selector)}\n${withFramePath(element, element.xpath)}`;
		case 'json':
			return JSON.stringify({
				selector: withFramePath(element, element.selector),
				xpath: withFramePath(element, element.xpath),
				tagName: element.tagName,
				id: element.id,
				classes: element.classes,
				attributes: element.attributes,
				text: element.text,
				documentUrl: element.documentUrl,
				htmlPath: element.htmlPath.join(' > '),
				outerHtml: element.outerHtml,
				rect: element.rect,
				styles: element.styles,
			}, null, 2);
		case 'context':
		default:
			return formatElementContext(element);
	}
}

/** The report the copy menu writes by default: everything an assistant needs about the pick. */
export function formatElementContext(element: PickedElement): string {
	const lines: string[] = [
		'Attached Element Context from Integrated Browser',
		'',
		`Element: ${element.descriptor}`,
		'',
		`URL: ${element.documentUrl}`,
	];

	if (element.framePath.length) {
		lines.push('', `Frame: ${element.framePath.join(' >>> ')}`);
	}

	lines.push(
		'',
		`HTML Path: ${element.htmlPath.join(' > ')}`,
		'',
		'Outer HTML:',
		...fenced(element.outerHtml, 'html'),
		'',
		'Dimensions:',
		`- top: ${element.rect.top}px`,
		`- left: ${element.rect.left}px`,
		`- width: ${element.rect.width}px`,
		`- height: ${element.rect.height}px`,
	);

	const styles = element.styles;
	if (!styles) {
		return lines.join('\n');
	}

	const css: string[] = [];

	for (const rule of styles.matched) {
		css.push(formatCssRule(rule));
	}

	if (styles.inherited.length) {
		css.push('', '/* Inherited */');
		for (const rule of styles.inherited) {
			css.push(formatCssRule(rule));
		}
	}

	if (styles.resolved.length) {
		css.push('', '/* Resolved values */');
		for (const declaration of styles.resolved) {
			css.push(`${declaration.property}: ${declaration.value}${declaration.fromUserAgent ? ' /*UA*/' : ''};`);
		}
	}

	if (styles.variables.length) {
		css.push('', '/* CSS variables */');
		for (const variable of styles.variables) {
			css.push(`${variable.property}: ${variable.value};`);
		}
	}

	if (styles.unreadableStyleSheets) {
		const count = styles.unreadableStyleSheets;
		css.push('', `/* ${count} stylesheet${count === 1 ? '' : 's'} from another origin could not be read */`);
	}

	lines.push('', 'CSS:', ...fenced(css.join('\n'), 'css'));
	return lines.join('\n');
}

function formatCssRule(rule: CssRule): string {
	const lines: string[] = [];
	if (rule.from) {
		lines.push(`/* ${rule.from} */`);
	}
	for (const condition of rule.conditions ?? []) {
		lines.push(`/* ${condition} */`);
	}

	const declarations = rule.declarations.replace(/;\s*$/, '');
	if (declarations.length <= 80) {
		lines.push(`${rule.selector} { ${declarations}; }`);
		return lines.join('\n');
	}

	lines.push(`${rule.selector} {`);
	for (const declaration of splitDeclarations(declarations)) {
		lines.push(`    ${declaration};`);
	}
	lines.push('}');
	return lines.join('\n');
}

/** Splits on the `;` between declarations, ignoring the ones inside `(…)` or a string. */
function splitDeclarations(declarations: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let quote: string | undefined;
	let start = 0;

	for (let i = 0; i < declarations.length; i++) {
		const char = declarations[i];
		if (quote) {
			if (char === '\\') {
				i++;
			} else if (char === quote) {
				quote = undefined;
			}
			continue;
		}
		if (char === '"' || char === '\'') {
			quote = char;
		} else if (char === '(') {
			depth++;
		} else if (char === ')') {
			depth--;
		} else if (char === ';' && depth === 0) {
			parts.push(declarations.slice(start, i).trim());
			start = i + 1;
		}
	}

	parts.push(declarations.slice(start).trim());
	return parts.filter(part => part.length > 0);
}

export function formatConsoleEntries(
	entries: readonly ConsoleEntry[],
	documentUrl: string,
	dropped: number,
): string {
	const lines: string[] = [`Console output — ${documentUrl}`];
	if (dropped > 0) {
		lines.push(`(${dropped} older ${dropped === 1 ? 'entry' : 'entries'} dropped)`);
	}
	lines.push('');

	for (const entry of entries) {
		lines.push(`[${formatTime(entry.time)}] ${entry.level.padEnd(5)} ${entry.text}`);
		if (entry.stack) {
			for (const line of entry.stack.split('\n')) {
				const trimmed = line.trim();
				// The first stack line repeats the message the entry already carries.
				if (trimmed && !entry.text.includes(trimmed)) {
					lines.push(`        ${trimmed}`);
				}
			}
		}
	}

	return lines.join('\n');
}

/** Keeps a report from overwriting one that has been copied but not pasted yet. */
function stamp(): string {
	const now = new Date();
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function hostOf(rawUrl: string): string {
	return parseHttpUrl(rawUrl)?.host ?? 'page';
}

function formatTime(time: number): string {
	const date = new Date(time);
	const pad = (value: number, length = 2) => String(value).padStart(length, '0');
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
		+ `.${pad(date.getMilliseconds(), 3)}`;
}

/** Accepts input like `localhost:3000` or `example.com/path` from the address bar. */
function normalizeUrl(rawUrl: string): string {
	const trimmed = rawUrl.trim();
	if (!trimmed) {
		return trimmed;
	}

	// A colon followed by digits is a port, not a scheme: `localhost:3000` is a host.
	const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
		|| /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(trimmed);
	const withScheme = hasScheme ? trimmed : `http://${trimmed}`;

	return parseHttpUrl(withScheme)?.toString() ?? withScheme;
}

function escapeAttribute(value: string): string {
	return value.replace(/"/g, '&quot;');
}
