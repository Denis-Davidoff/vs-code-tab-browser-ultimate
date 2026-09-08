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
 * Whether the document in the frame carries the injected agent cannot be read off the order two
 * processes report things in. A document reports in at its own `DOMContentLoaded`, but only a
 * document the proxy serves reports at all — so the panel would have to read *silence* as "no
 * agent", and silence has no moment it can be measured from: the frame's `load` event can
 * arrive before the report of the very same document, and a report can arrive just before the
 * `load` of the *next* one. Pairing the two by number — the n-th report to the n-th document —
 * breaks on any document that never reports, and reading a time window instead credits a new
 * page's report to the page before it. Both of those have been seen.
 *
 * So the frame is *asked*, once per `load`, and only an answer carrying that question's number
 * counts: whichever document is holding the frame answers, an answer for a question that has
 * been superseded is ignored, and no answer at all is a document with no agent in it. A `ready`
 * is an answer of its own kind — it can only come from a document that has the agent — and a
 * late answer takes a write-off back. How long "no answer at all" takes to establish is the one
 * thing left that is not read off an answer; `sawReady` below says what decides it.
 */
/**
 * Origins the local proxy is serving, from the host: the only places a document carrying the
 * agent can speak from, and the only messages `onAgentEvent` is given. `expectsAgent` is the
 * other half — the host says whether *this* navigation was served through the proxy at all, so
 * a page the panel was pointed at directly is never taken for an instrumented one.
 */
let agentOrigins = new Set<string>(settings.agentOrigins);
let expectsAgent = false;

let probeId = 0;
/**
 * Whether anything has reported in since the host resolved this navigation. It decides how long
 * an answer is waited for and nothing else — which document a report came from is not something
 * this can say, and does not need to.
 *
 * A frame that has held a document with the agent will hold another one: what is being waited
 * for is that answer getting out of a main thread the page's own `load` handler may keep for a
 * second — hydration, an analytics burst — and writing the page off for that has an assistant
 * told a page it can read perfectly well is not served through the proxy, which is the one
 * error message that sends it away for good. A frame that has reported nothing at all since the
 * navigation is the other case and gets the short wait: a page opened outside the proxy, or the
 * proxy's own error page, and a copy command has to reload it rather than sit there.
 *
 * The cost of the long wait is the in-frame link that leaves an instrumented page for one the
 * proxy does not serve: the panel keeps saying "inspectable" for a second and a half. A copy
 * command in that window reaches a page with no agent and does nothing until it is run again —
 * which is the lesser of the two, and the only alternative is telling assistants that a page
 * they can read cannot be read every time one takes a while to hydrate.
 */
let sawReady = false;
let silenceTimer: ReturnType<typeof setTimeout> | undefined;
/** How long a document that has said nothing has to answer before it is called uninstrumented. */
const probeTimeout = 150;
/** How long one that has reported in has, its answer being a task behind its own page's work. */
const busyProbeTimeout = 1500;

// -- messages --------------------------------------------------------------------------------

window.addEventListener('message', event => {
	const message: unknown = event.data;

	if (isAgentMessage(message)) {
		// Everything the agent says is taken on trust — that a document has the agent in it,
		// what the picked element is, what the page logged — and all of it ends up in the
		// workspace, in an assistant's context, or in an answer to an mcp client. The page
		// itself can post the same shapes: they are in the script the proxy injects into it.
		// What it cannot do is lie about where the message came from, so that is what is
		// checked — the frame, and an origin the proxy is serving. A page the panel was pointed
		// at directly is not one of those, and neither is one the framed page navigated to.
		if (event.source === iframe.contentWindow && expectsAgent
			&& agentOrigins.has(event.origin)) {
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

		case 'didChangeAgentOrigins':
			agentOrigins = new Set(hostMessage.origins);
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
			// A report can only come from a document that has the agent in it, so whatever the
			// frame was about to be written off for, it is not that.
			sawReady = true;
			clearSilenceTimer();
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

		case 'aliveAnswer':
			// The answer to a question that has since been superseded is about a document the
			// frame has already left, and says nothing about the one in it now.
			if (event.probeId !== probeId) {
				break;
			}
			clearSilenceTimer();
			// Late, and the document has already been written off: take that back.
			if (!isInstrumented || pageReady !== event.ready) {
				pageReady = event.ready;
				isInstrumented = true;
				reportState();
			}
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

function clearSilenceTimer(): void {
	clearTimeout(silenceTimer);
	silenceTimer = undefined;
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
	expectsAgent = message.instrumented;
	isInstrumented = message.instrumented;
	pageReady = false;
	resolvedOnce = true;
	// The frame is starting over, so what is known about the document it was showing goes with
	// it — including a write-off that has not been decided yet, and an answer still in flight
	// for the document being left.
	probeId++;
	sawReady = false;
	clearSilenceTimer();
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
		// Ask the document that just loaded whether the agent is in it, rather than reading
		// that off the order two processes happened to report things in. Only an answer to
		// *this* question counts, so a document that has since been left cannot answer for the
		// one on screen.
		probeId++;
		sendToPage({ kind: 'alive', probeId });

		clearSilenceTimer();
		silenceTimer = setTimeout(() => {
			silenceTimer = undefined;
			// Nobody answered: the frame has navigated somewhere the proxy does not serve, so
			// there is no agent in this document and a copy command has to reload through the
			// proxy rather than wait for silence. An answer that arrives after this takes it
			// back — a page held up long enough to miss the question is still a page we serve.
			isInstrumented = false;
			pageReady = false;
			reportState();
		}, sawReady ? busyProbeTimeout : probeTimeout);
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
