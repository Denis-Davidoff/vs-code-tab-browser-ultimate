/*---------------------------------------------------------------------------------------------
 *  The webview's own script: the toolbar, the address bar and the copy menu, and the bridge
 *  between the previewed page and the extension host.
 *--------------------------------------------------------------------------------------------*/

import { AgentCommand, AgentEvent, isAgentMessage, packAgentMessage } from '../shared/protocol';
import {
	CopyCommand,
	ExtensionToWebviewMessage,
	isConsoleCommand,
	TabBrowserSettings,
	TabBrowserState,
	WebviewToExtensionMessage,
} from '../shared/webviewProtocol';
import { PageRequest } from '../shared/protocol';
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
/** False until the host has answered the first navigation, i.e. nothing is loaded yet. */
let resolvedOnce = false;
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
/** How long a page served through the proxy may take to report in before it is called dead. */
const readyCheckTimeout = 15000;
let pendingNavigation: { readonly requestId: number; readonly bust: boolean } | undefined;
let pendingConsoleRequest: number | undefined;
let consoleRequestTimer: ReturnType<typeof setTimeout> | undefined;
/** The menu entry the pending console request came from. */
let consoleCommand: CopyCommand = 'console';
/**
 * Reports that have arrived, and how many of them a loaded document has already been credited
 * with. A document reports once, at its own `DOMContentLoaded`, and only the proxy puts that
 * script in a document — so an uncredited report is the newest thing known about the frame,
 * and a `load` with nothing uncredited behind it is a document that carries no agent.
 *
 * The two events come from two processes with nothing ordering them, which is why the second
 * half of that is not read off the counts as they stand: a report still in flight would make
 * an instrumented page look like one the proxy does not serve. So a document is given
 * `reportGrace` to be heard from before it is written off, and a report arriving later than
 * that takes the write-off back. Pairing them by number instead — the n-th report to the n-th
 * document — is what silent documents make impossible: they report nothing to shift the
 * pairing with, so everything after one of them read as uninstrumented.
 *
 * Which leaves one case the two events cannot be told apart in: a report arriving *later* than
 * `reportGrace` after a load, with nothing else having happened. It could be that document,
 * heard from very late, or the first word of one that is loading right now — and it is read as
 * the latter, because that is the order these arrive in when nothing goes wrong, and because
 * being wrong the other way is the worse of the two: a page the panel can read perfectly well
 * reported as one it cannot. Where they *can* be told apart is inside the grace window, which
 * is the only place a late report has ever been seen: an ipc, not a third of a second.
 *
 * Both counts are reset by a navigation the host resolves, the one moment where the frame is
 * known to be starting over.
 */
let readyCount = 0;
let creditedReports = 0;
let silenceTimer: ReturnType<typeof setTimeout> | undefined;
/** How long after `load` a document may still report in before it is called uninstrumented. */
const reportGrace = 150;

// -- messages --------------------------------------------------------------------------------

window.addEventListener('message', event => {
	const message: unknown = event.data;

	if (isAgentMessage(message)) {
		if (event.source === iframe.contentWindow) {
			onAgentEvent(message as AgentEvent);
		}
		return;
	}

	// The framed page can post here as well. Only the extension host knows the token, which
	// lives in this document's dom and is therefore out of a cross origin page's reach.
	if (typeof message !== 'object' || message === null || !('type' in message)
		|| (message as { token?: unknown }).token !== settings.token) {
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

		case 'runPageRequest':
			runPageRequest(hostMessage.requestId, hostMessage.request);
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
			readyCount++;
			if (silenceTimer) {
				// The document that just loaded, heard from a moment after its own `load`
				// event: two processes, and this report has an ipc to cross. It belongs to
				// that document and not to the next one, so it is credited to it here — and
				// there is nothing left to write off.
				clearTimeout(silenceTimer);
				silenceTimer = undefined;
				creditedReports = readyCount;
			}
			// Only the proxy puts this script in a document, so a document that reports in is
			// instrumented by definition — including when the frame's `load` event won this
			// race and has already written the document off as a page we do not serve.
			isInstrumented = true;
			pageReady = true;
			reportState();
			// A navigation inside the frame lands here, and the address bar has to follow it.
			setDisplayUrl(event.documentUrl);
			if (readyCheckTimer) {
				clearTimeout(readyCheckTimer);
				readyCheckTimer = undefined;
			}
			// Only the top document reports in here, so anything the panel is still complaining
			// about — a slow server, an error from the document being left — is now stale.
			if (hint.dataset.state === 'error') {
				hideHint();
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

		case 'navigated':
			setDisplayUrl(event.documentUrl);
			break;

		case 'result':
			vscode.postMessage({
				type: 'didRunPageRequest',
				requestId: event.requestId,
				value: event.value,
				error: event.error,
			});
			break;

		case 'icon':
			vscode.postMessage({ type: 'setIcon', href: event.href });
			break;

		case 'title':
			vscode.postMessage({ type: 'setTitle', title: event.title });
			break;

		case 'cancel':
			setPickerActive(false);
			break;

		case 'console':
			if (event.requestId !== pendingConsoleRequest) {
				return;
			}
			endConsoleRequest();
			if (!event.entries.length) {
				showHint('error', 'The page has not logged anything yet.');
				return;
			}
			vscode.postMessage({
				type: 'copyConsole',
				entries: event.entries,
				documentUrl: event.documentUrl,
				dropped: event.dropped,
				command: consoleCommand,
			});
			break;

		case 'pageError':
			// Surfaced in the panel so a blank page is not a dead end.
			console.error('[tab browser] page error:', event.message);
			showHint('error', event.message);
			break;
	}
}

/**
 * An mcp client is asking the page something. The page has to be instrumented for that, and
 * saying so is more useful than a request that quietly never answers.
 */
function runPageRequest(requestId: number, request: PageRequest): void {
	if (!isInstrumented || !pageReady) {
		vscode.postMessage({
			type: 'didRunPageRequest',
			requestId,
			// Before the first navigation resolves nothing is loaded at all, which is a wait,
			// not a verdict on the page.
			error: !resolvedOnce || isInstrumented
				? 'The page has not finished loading.'
				: 'This page is not served through the local proxy, so it cannot be inspected.',
		});
		return;
	}
	sendToPage({ kind: 'request', requestId, request });
}

/** Points the address bar, the saved state and "Open in browser" at the page actually shown. */
function setDisplayUrl(url: string): void {
	if (!url || url === displayUrl) {
		return;
	}
	displayUrl = url;
	if (document.activeElement !== input) {
		input.value = displayUrl;
	}
	saveState();
	reportState();
}

function endConsoleRequest(): void {
	pendingConsoleRequest = undefined;
	if (consoleRequestTimer) {
		clearTimeout(consoleRequestTimer);
		consoleRequestTimer = undefined;
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
	resolvedOnce = true;
	// The frame is starting over, so what is known about the document it was showing goes with
	// it — including a write-off that has not been decided yet.
	readyCount = 0;
	creditedReports = 0;
	clearTimeout(silenceTimer);
	silenceTimer = undefined;
	endConsoleRequest();
	reportState();

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
		}, readyCheckTimeout);
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

/**
 * The host cannot see any of this: the url changes with in-page navigation, and whether the
 * page can be inspected is only known here.
 */
function reportState(): void {
	vscode.postMessage({ type: 'didChangeState', url: displayUrl, instrumented: isInstrumented, ready: pageReady });
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

	if (!menuItems().some(item => item.dataset.command === command)) {
		// The entry was remembered while an assistant was installed that is no longer there.
		command = lastCopyCommand = 'element';
	}

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

	const isPick = !isConsoleCommand(command);
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

	if (isPick) {
		pickCommand = command;
		setPickerActive(true);
		return;
	}

	const requestId = nextRequestId++;
	pendingConsoleRequest = requestId;
	consoleCommand = command;
	showHint('waiting', 'Collecting console output…');
	sendToPage({ kind: 'collectConsole', requestId });

	// The page may have navigated somewhere the injected script never reached.
	consoleRequestTimer = setTimeout(() => {
		if (pendingConsoleRequest !== requestId) {
			return;
		}
		endConsoleRequest();
		pageReady = false;
		showHint('error', 'The page did not answer. Reload it and try again.');
	}, 5000);
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

/** The assistant a menu entry sends to, if any. */
function assistantOf(command: CopyCommand): string | undefined {
	return command.endsWith('Claude') ? 'Claude Code' : command.endsWith('Codex') ? 'Codex' : undefined;
}

/** What the running pick will do with the element, for the hint bar. */
function pickDescription(): string {
	const what = pickCommand.startsWith('elementXPath')
		? 'its XPath'
		: pickCommand.startsWith('elementPath') ? 'its path' : 'it';
	const assistant = assistantOf(pickCommand);
	return assistant ? `add ${what} to ${assistant}` : `copy ${what}`;
}

function showHint(state: HintState, detail?: string): void {
	if (hintResetTimer) {
		clearTimeout(hintResetTimer);
		hintResetTimer = undefined;
	}

	hint.dataset.state = state;
	hint.hidden = false;

	switch (state) {
		case 'picking':
			hintMessage.textContent = `Click an element to ${pickDescription()}. Esc to cancel.`;
			hintDetail.textContent = detail ?? '';
			break;
		case 'waiting':
			hintMessage.textContent = detail ?? 'Loading the page through the local proxy…';
			hintDetail.textContent = '';
			break;
		case 'copied':
			const assistant = assistantOf(lastCopyCommand);
			hintMessage.textContent = assistant ? `Added to ${assistant}:` : 'Copied to clipboard:';
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

	iframe.addEventListener('load', () => {
		// A report that no loaded document has been credited with yet is this document's own:
		// the one before it had already loaded when that report arrived.
		if (readyCount > creditedReports) {
			creditedReports = readyCount;
			return;
		}

		// Nothing has reported since the document before this one, so either the frame has
		// navigated somewhere the proxy does not serve — no agent in it, and a copy command
		// has to reload through the proxy rather than wait for silence — or the report of this
		// one is still on its way from another process. Hence the wait before writing it off;
		// a report that arrives after it still takes the write-off back.
		clearTimeout(silenceTimer);
		silenceTimer = setTimeout(() => {
			silenceTimer = undefined;
			if (readyCount > creditedReports) {
				creditedReports = readyCount;
				return;
			}
			isInstrumented = false;
			pageReady = false;
			reportState();
		}, reportGrace);
	});

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
