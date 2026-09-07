/*---------------------------------------------------------------------------------------------
 *  The webview's own script: the toolbar, the address bar and the copy menu, and the bridge
 *  between the previewed page and the extension host.
 *--------------------------------------------------------------------------------------------*/

import { AgentCommand, AgentEvent, isAgentMessage, packAgentMessage } from '../shared/protocol';
import {
	CopyCommand,
	ExtensionToWebviewMessage,
	TabBrowserSettings,
	TabBrowserState,
	WebviewToExtensionMessage,
} from '../shared/webviewProtocol';
import { onceDocumentLoaded } from './events';

interface VsCodeApi<State, Message> {
	getState(): State | undefined;
	setState(state: State): void;
	postMessage(message: Message): void;
}

declare function acquireVsCodeApi(): VsCodeApi<TabBrowserState, WebviewToExtensionMessage>;

const vscode = acquireVsCodeApi();

function getSettings(): TabBrowserSettings {
	const element = document.getElementById('tab-browser-settings');
	const data = element?.getAttribute('data-settings');
	if (data) {
		return JSON.parse(data) as TabBrowserSettings;
	}
	throw new Error('Could not load settings');
}

const settings = getSettings();

const iframe = document.querySelector('iframe')!;
const header = document.querySelector('.header')!;
const input = header.querySelector<HTMLInputElement>('.url-input')!;
const forwardButton = header.querySelector<HTMLButtonElement>('.forward-button')!;
const backButton = header.querySelector<HTMLButtonElement>('.back-button')!;
const reloadButton = header.querySelector<HTMLButtonElement>('.reload-button')!;
const openExternalButton = header.querySelector<HTMLButtonElement>('.open-external-button')!;
const copyActionButton = header.querySelector<HTMLButtonElement>('.copy-action-button')!;
const copyMenuToggle = header.querySelector<HTMLButtonElement>('.copy-menu-toggle')!;
const copyMenu = header.querySelector<HTMLDivElement>('.copy-menu')!;
const hint = document.querySelector<HTMLDivElement>('.hint')!;
const hintMessage = hint.querySelector<HTMLSpanElement>('.hint-message')!;
const hintDetail = hint.querySelector<HTMLSpanElement>('.hint-detail')!;

/** Url shown in the address bar, always the one of the real server. */
let displayUrl = settings.url;
/** Url actually loaded in the iframe, which may point at the local proxy. */
let loadedUrl = settings.url;
/** True when the page is served through the proxy, i.e. carries the agent script. */
let isInstrumented = false;
/** True once the injected script in the current page has announced itself. */
let pageReady = false;
let pickerActive = false;
/** Copy command waiting for the page to be reloaded through the proxy. */
let queuedCommand: CopyCommand | undefined;
/** Menu entry the main half of the split button runs, remembered from the last pick. */
let lastCopyCommand: CopyCommand = vscode.getState()?.lastCopyCommand ?? 'element';
/** The command the running pick was started from; it decides what gets copied. */
let pickCommand: CopyCommand = 'element';
let hintResetTimer: ReturnType<typeof setTimeout> | undefined;
let readyCheckTimer: ReturnType<typeof setTimeout> | undefined;
let nextRequestId = 1;
let pendingNavigation: { readonly requestId: number; readonly bust: boolean } | undefined;
let pendingConsoleRequest: number | undefined;

// -- messages --------------------------------------------------------------------------------

window.addEventListener('message', event => {
	const message: unknown = event.data;

	if (isAgentMessage(message)) {
		if (event.source === iframe.contentWindow) {
			onAgentEvent(message as AgentEvent);
		}
		return;
	}

	if (typeof message !== 'object' || message === null || !('type' in message)) {
		return;
	}

	const hostMessage = message as ExtensionToWebviewMessage;
	switch (hostMessage.type) {
		case 'focus':
			iframe.focus();
			break;

		case 'didChangeFocusLockIndicatorEnabled':
			toggleFocusLockIndicatorEnabled(hostMessage.focusLockEnabled);
			break;

		case 'didResolveUrl':
			onDidResolveUrl(hostMessage);
			break;

		case 'runCopyCommand':
			runCopyCommand(hostMessage.command);
			break;

		case 'didCopy':
			showHint('copied', hostMessage.text);
			if (!hostMessage.keepPickerActive) {
				setPickerActive(false);
			}
			break;
	}
});

function onAgentEvent(event: AgentEvent): void {
	switch (event.kind) {
		case 'ready': {
			pageReady = true;
			if (readyCheckTimer) {
				clearTimeout(readyCheckTimer);
				readyCheckTimer = undefined;
			}
			const queued = queuedCommand;
			queuedCommand = undefined;
			if (queued) {
				runCopyCommand(queued);
			} else if (pickerActive) {
				sendToPage({ kind: 'enablePicker', preferAttributes: settings.preferAttributes });
			}
			break;
		}

		case 'hover':
			if (pickerActive) {
				showHint('picking', [...event.framePath, event.selector].join(' >>> '));
			}
			break;

		case 'pick':
			if (pickerActive) {
				vscode.postMessage({ type: 'copyElement', element: event.element, command: pickCommand });
			}
			break;

		case 'icon':
			vscode.postMessage({ type: 'setIcon', href: event.href });
			break;

		case 'cancel':
			setPickerActive(false);
			break;

		case 'console':
			if (event.requestId !== pendingConsoleRequest) {
				return;
			}
			pendingConsoleRequest = undefined;
			if (!event.entries.length) {
				showHint('error', 'The page has not logged anything yet.');
				return;
			}
			vscode.postMessage({
				type: 'copyConsole',
				entries: event.entries,
				documentUrl: event.documentUrl,
				dropped: event.dropped,
			});
			break;

		case 'pageError':
			// Surfaced in the panel so a blank page is not a dead end.
			console.error('[tab browser] page error:', event.message);
			showHint('error', event.message);
			break;
	}
}

function sendToPage(command: AgentCommand): void {
	iframe.contentWindow?.postMessage(packAgentMessage(command), '*');
}

// -- navigation ------------------------------------------------------------------------------

function navigateTo(rawUrl: string, options?: { readonly bust?: boolean; readonly instrument?: boolean }): void {
	const requestId = nextRequestId++;
	pendingNavigation = { requestId, bust: !!options?.bust };
	vscode.postMessage({
		type: 'resolveUrl',
		requestId,
		url: rawUrl,
		instrument: options?.instrument ?? (pickerActive || !!queuedCommand),
	});
}

function onDidResolveUrl(message: Extract<ExtensionToWebviewMessage, { type: 'didResolveUrl' }>): void {
	if (pendingNavigation?.requestId !== message.requestId) {
		return;
	}
	const bust = pendingNavigation.bust;
	pendingNavigation = undefined;

	displayUrl = message.displayUrl;
	loadedUrl = message.loadUrl;
	isInstrumented = message.instrumented;
	pageReady = false;
	pendingConsoleRequest = undefined;

	if (document.activeElement !== input) {
		input.value = displayUrl;
	}
	saveState();

	if (message.error) {
		queuedCommand = undefined;
		showHint('error', message.error);
		setPickerActive(false);
	}

	iframe.src = bust ? withCacheBust(loadedUrl) : loadedUrl;

	// If the proxy served the page, its script always reports in. Silence means the page never
	// arrived, so say so instead of leaving a blank frame.
	if (readyCheckTimer) {
		clearTimeout(readyCheckTimer);
	}
	if (isInstrumented) {
		readyCheckTimer = setTimeout(() => {
			readyCheckTimer = undefined;
			if (!pageReady) {
				queuedCommand = undefined;
				showHint('error', `No response from ${displayUrl}. Is the server running on that port?`);
			}
		}, 8000);
	}
}

function withCacheBust(rawUrl: string): string {
	// Assigning the same `src` does not reload the frame, so vary the url instead.
	try {
		const url = new URL(rawUrl);
		url.searchParams.set('vscodeBrowserReqId', String(Date.now()));
		return url.toString();
	} catch {
		return rawUrl;
	}
}

function saveState(): void {
	vscode.setState({ url: displayUrl, lastCopyCommand });
}

// -- copy menu -------------------------------------------------------------------------------

function menuItems(): HTMLButtonElement[] {
	return Array.from(copyMenu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
}

function setMenuOpen(open: boolean): void {
	copyMenu.hidden = !open;
	copyMenuToggle.setAttribute('aria-expanded', String(open));
	copyMenuToggle.classList.toggle('active', open);
	if (open) {
		const current = menuItems().find(item => item.dataset.command === lastCopyCommand);
		(current ?? menuItems()[0])?.focus();
	}
}

function isMenuOpen(): boolean {
	return !copyMenu.hidden;
}

/** Moves a menu entry onto the main half of the split button, the way a menu button behaves. */
function setLastCopyCommand(command: CopyCommand): void {
	lastCopyCommand = command;
	saveState();

	for (const item of menuItems()) {
		const isCurrent = item.dataset.command === command;
		item.classList.toggle('current', isCurrent);
		item.setAttribute('aria-checked', String(isCurrent));
		if (!isCurrent) {
			continue;
		}

		const icon = copyActionButton.querySelector('.codicon');
		if (icon && item.dataset.icon) {
			icon.className = `codicon ${item.dataset.icon}`;
		}
		const label = item.querySelector<HTMLSpanElement>('.copy-menu-label')?.textContent;
		if (label) {
			copyActionButton.title = label;
			copyActionButton.setAttribute('aria-label', label);
		}
	}
}

/**
 * Every command needs the injected page script. If the current page is not served through the
 * proxy yet, reload it there first and run the command once it reports in.
 */
function runCopyCommand(command: CopyCommand): void {
	setMenuOpen(false);
	setLastCopyCommand(command);

	const isPick = command === 'element' || command === 'elementXPath' || command === 'elementClaude';
	if (isPick && pickerActive) {
		// A second click on the running command turns picking back off.
		if (command === pickCommand) {
			setPickerActive(false);
			return;
		}
		pickCommand = command;
		showHint('picking');
		return;
	}

	if (!isInstrumented || !pageReady) {
		queuedCommand = command;
		showHint('waiting');
		if (!isInstrumented) {
			navigateTo(displayUrl, { instrument: true });
		}
		return;
	}

	switch (command) {
		case 'element':
		case 'elementXPath':
		case 'elementClaude':
			pickCommand = command;
			setPickerActive(true);
			break;

		case 'console': {
			const requestId = nextRequestId++;
			pendingConsoleRequest = requestId;
			showHint('waiting', 'Collecting console output…');
			sendToPage({ kind: 'collectConsole', requestId });
			break;
		}
	}
}

function setPickerActive(active: boolean): void {
	if (active === pickerActive) {
		return;
	}
	pickerActive = active;
	document.body.classList.toggle('picking', active);

	if (!active) {
		sendToPage({ kind: 'disablePicker' });
		if (hint.dataset.state === 'picking') {
			hideHint();
		}
		return;
	}

	showHint('picking');
	sendToPage({ kind: 'enablePicker', preferAttributes: settings.preferAttributes });
}

// -- hint bar --------------------------------------------------------------------------------

type HintState = 'picking' | 'copied' | 'error' | 'waiting';

function showHint(state: HintState, detail?: string): void {
	if (hintResetTimer) {
		clearTimeout(hintResetTimer);
		hintResetTimer = undefined;
	}

	hint.dataset.state = state;
	hint.hidden = false;

	switch (state) {
		case 'picking':
			hintMessage.textContent = pickCommand === 'elementXPath'
				? 'Click an element to copy its XPath. Esc to cancel.'
				: pickCommand === 'elementClaude'
					? 'Click an element to add it to Claude Code. Esc to cancel.'
					: 'Click an element to copy it. Esc to cancel.';
			hintDetail.textContent = detail ?? '';
			break;
		case 'waiting':
			hintMessage.textContent = detail ?? 'Loading the page through the local proxy…';
			hintDetail.textContent = '';
			break;
		case 'copied':
			hintMessage.textContent = pickCommand === 'elementClaude'
				? 'Added to Claude Code:'
				: 'Copied to clipboard:';
			hintDetail.textContent = detail ?? '';
			hintResetTimer = setTimeout(() => (pickerActive ? showHint('picking') : hideHint()), 4000);
			break;
		case 'error':
			hintMessage.textContent = detail ?? 'Something went wrong.';
			hintDetail.textContent = '';
			hintResetTimer = setTimeout(hideHint, 20000);
			break;
	}
}

function hideHint(): void {
	hint.hidden = true;
	delete hint.dataset.state;
	hintMessage.textContent = '';
	hintDetail.textContent = '';
}

function toggleFocusLockIndicatorEnabled(enabled: boolean): void {
	document.body.classList.toggle('enable-focus-lock-indicator', enabled);
}

// -- wiring ----------------------------------------------------------------------------------

onceDocumentLoaded(() => {
	setInterval(() => {
		const iframeFocused = document.activeElement?.tagName === 'IFRAME';
		document.body.classList.toggle('iframe-focused', iframeFocused);
	}, 50);

	input.addEventListener('change', event => {
		navigateTo((event.target as HTMLInputElement).value);
	});

	forwardButton.addEventListener('click', () => history.forward());
	backButton.addEventListener('click', () => history.back());
	reloadButton.addEventListener('click', () => navigateTo(input.value, { bust: true }));
	openExternalButton.addEventListener('click', () => {
		vscode.postMessage({ type: 'openExternal', url: displayUrl });
	});

	copyActionButton.addEventListener('click', () => runCopyCommand(lastCopyCommand));
	copyMenuToggle.addEventListener('click', () => setMenuOpen(!isMenuOpen()));

	for (const item of menuItems()) {
		item.addEventListener('click', () => {
			runCopyCommand(item.dataset.command as CopyCommand);
		});
	}

	// Arrow keys inside the menu, the way a menu is expected to behave.
	copyMenu.addEventListener('keydown', event => {
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
			return;
		}
		event.preventDefault();
		const items = menuItems();
		const index = items.indexOf(document.activeElement as HTMLButtonElement);
		const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
		items[(next + items.length) % items.length]?.focus();
	});

	document.addEventListener('click', event => {
		const target = event.target as Node;
		if (isMenuOpen() && !copyMenu.contains(target) && !copyMenuToggle.contains(target)) {
			setMenuOpen(false);
		}
	});

	document.addEventListener('keydown', event => {
		if (event.key !== 'Escape') {
			return;
		}
		if (isMenuOpen()) {
			setMenuOpen(false);
			copyMenuToggle.focus();
		} else if (pickerActive) {
			// The iframe swallows Escape while it has focus, so also listen here.
			setPickerActive(false);
		}
	});

	setLastCopyCommand(lastCopyCommand);

	input.value = settings.url;
	navigateTo(settings.url);

	toggleFocusLockIndicatorEnabled(settings.focusLockEnabled);
});
