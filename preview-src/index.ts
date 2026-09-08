/*---------------------------------------------------------------------------------------------
 *  The webview's own script: the toolbar, the address bar and the copy menu, and the bridge
 *  between the previewed page and the extension host.
 *--------------------------------------------------------------------------------------------*/

import {
	AgentCommand,
	AgentEvent,
	cacheBustParameter,
	EditAction,
	isAgentMessage,
	packAgentMessage,
	ShortcutAction,
} from '../shared/protocol';
import {
	BrowserMenuCommand,
	ContextMenuCommand,
	CopyCommand,
	ExtensionToWebviewMessage,
	isConsoleCommand,
	TabBrowserSettings,
	TabBrowserState,
	WebviewToExtensionMessage,
} from '../shared/webviewProtocol';
import { PagePoint, PageRequest } from '../shared/protocol';
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
const contextMenu = document.querySelector<HTMLDivElement>('.context-menu')!;
const contextMenuHeader = contextMenu.querySelector<HTMLDivElement>('.menu-header')!;
const browserMenuToggle = header.querySelector<HTMLButtonElement>('.browser-menu-toggle')!;
const browserMenu = header.querySelector<HTMLDivElement>('.browser-menu')!;
const suggestions = header.querySelector<HTMLDivElement>('.url-suggestions')!;
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
/** Whether a right-click in the page is answered with the panel's own menu. */
let contextMenuEnabled = settings.contextMenuEnabled;
let contextMenuOpen = false;
/** The element the open menu is about, under the name the page knows it by. */
let contextTargetId = '';
/** Whether the page has been told there is something over it; see `reportMenusOpen`. */
let menusOpen = false;
let menusReportScheduled = false;
/** Whether a copy is outstanding, i.e. whether the page has anything to say about one. */
let awaitingClipboardWrite = false;
let clipboardWriteTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * A command was chosen in the context menu and the page is describing the element it was
 * opened on. The pick that comes back is not the picker's, so it is not `pickerActive` that
 * lets it through — and one that arrives with neither pending is a page reporting a pick
 * nobody asked for.
 */
let awaitingContextPick = false;
let contextPickTimer: ReturnType<typeof setTimeout> | undefined;
/** Copy command waiting for the page to be reloaded through the proxy. */
let queuedCommand: CopyCommand | undefined;
/** Menu entry the main half of the split button runs, remembered from the last pick. */
let lastCopyCommand: CopyCommand = vscode.getState()?.lastCopyCommand ?? 'element';
/** The command the running pick was started from; it decides what gets copied. */
let pickCommand: CopyCommand = 'element';
/**
 * How far the page is zoomed. Applied to the frame and not to the page: the injected script
 * must not change how the page behaves, and a `zoom` the page carries itself would show up in
 * every computed style an element report reads.
 */
let zoomLevel = vscode.getState()?.zoom ?? 1;
/** What `Cmd`/`Ctrl` + `+` walks through, as a browser's own zoom does. */
const zoomSteps = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
/** Pixels of pinching or scrolling that amount to one zoom step. */
const gestureStep = 24;
/** After this long, whatever is left over belongs to a gesture that is over. */
const gestureIdle = 300;
let gestureDelta = 0;
let lastGestureAt = 0;
/** Title of the menu button as the host wrote it, before the zoom level is appended to it. */
const browserMenuTitle = browserMenuToggle.title;
/** Pages the panel has been on, newest first: what the address bar completes against. */
let recentUrls: readonly string[] = settings.recentUrls;
/** As many suggestions as a list under the address bar is worth reading. */
const maxSuggestions = 10;
/** Entry of the open suggestion list the arrow keys have moved to; -1 is what was typed. */
let suggestionIndex = -1;
/** What was typed before the arrow keys started filling the field with suggestions. */
let typedUrl = '';
/**
 * The last value navigation was started for. A commit — Enter, or a click on a suggestion —
 * leaves the field holding it, and the `change` event that follows on blur must not navigate a
 * second time for the same text.
 */
let lastCommitted = '';
/**
 * The field holds something the user is typing. Only then is it left alone: after Enter the
 * page's real url — which is the one the server redirected to, and arrives later — is what the
 * address bar is for, and a field that keeps the three words that were typed instead is a
 * field lying about where the panel is.
 */
let editingUrl = false;
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

		case 'didChangeContextMenuEnabled':
			contextMenuEnabled = hostMessage.contextMenuEnabled;
			if (!contextMenuEnabled) {
				closeContextMenu();
			}
			sendToPage({
				kind: 'setContextMenu',
				enabled: contextMenuEnabled,
				preferAttributes: settings.preferAttributes,
			});
			break;

		case 'didChangeAgentOrigins':
			agentOrigins = new Set(hostMessage.origins);
			break;

		case 'didResolveUrl':
			onDidResolveUrl(hostMessage);
			break;

		case 'reloadPage':
			// Through the host like any other navigation: the file may have to be served by a
			// session that is not the one the current page came from.
			navigateTo(displayUrl, { bust: true, instrument: isInstrumented });
			break;

		case 'didChangeRecentUrls':
			recentUrls = hostMessage.urls;
			// Only what is on screen goes stale; the next keystroke reads the new list.
			if (!suggestions.hidden) {
				showSuggestions(typedUrl);
			}
			break;

		case 'zoom':
			stepZoom(hostMessage.direction);
			break;

		case 'edit':
			runEditCommand(hostMessage.action, hostMessage.text);
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
			if (contextMenuEnabled) {
				sendToPage({
					kind: 'setContextMenu',
					enabled: true,
					preferAttributes: settings.preferAttributes,
				});
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
			if (pickerActive || awaitingContextPick) {
				awaitingContextPick = false;
				clearTimeout(contextPickTimer);
				vscode.postMessage({ type: 'copyElement', element: event.element, command: pickCommand });
			}
			break;

		case 'contextMenu':
			// While picking, a right-click is the picker's own business and never reaches here.
			if (!pickerActive && contextMenuEnabled) {
				openContextMenu(event.at, event.descriptor, event.targetId);
			}
			break;

		case 'dismissMenu':
			// A click, a scroll or an Escape somewhere in the page — which is the only way this
			// document hears of one at all, and it may come from a frame that is not the one
			// holding the element. Whatever the panel has standing over the page goes with it,
			// the toolbar's own menus included: a click in the page is not a click on them.
			closeContextMenu();
			setMenuOpen(false);
			setBrowserMenuOpen(false);
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

		case 'copyToClipboard':
			// Only as the answer to a copy that was just asked for. The page can send what the
			// script injected into it sends, and a page free to say "put this on the
			// clipboard" is a page that can overwrite it on a timer.
			if (awaitingClipboardWrite) {
				awaitingClipboardWrite = false;
				vscode.postMessage({ type: 'writeClipboard', text: event.text });
			}
			break;

		case 'shortcut':
			// A browser keeps these keys for itself, so the page never sees them — and while
			// the page has the focus, the page is the only one that hears them at all.
			if (isShortcutAction(event.action)) {
				runBrowserCommand(event.action);
			}
			break;

		case 'zoomGesture':
			onZoomGesture(event.delta);
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
	showUrlInInput();
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

	closeContextMenu();
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

	showUrlInInput();
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
		url.searchParams.set(cacheBustParameter, String(Date.now()));
		return url.toString();
	} catch {
		return rawUrl;
	}
}

function saveState(): void {
	vscode.setState({ url: displayUrl, lastCopyCommand, zoom: zoomLevel });
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
	if (open) {
		// Two menus standing open at once, one of them about an element the other knows
		// nothing about.
		closeContextMenu();
	}
	copyMenu.hidden = !open;
	copyMenuToggle.setAttribute('aria-expanded', String(open));
	copyMenuToggle.classList.toggle('active', open);
	if (open) {
		const current = menuItems().find(item => item.dataset.command === lastCopyCommand);
		(current ?? menuItems()[0])?.focus();
	}
	reportMenusOpen();
}

/**
 * Tells the page whether the panel has anything standing over it, which is what the page
 * watches for a dismissing click for. One flag for all three menus: reported per menu, the
 * second one's closing stopped the watch the first one was still open behind.
 */
function reportMenusOpen(): void {
	// After this turn, not during it: opening one menu closes another, and the page has no use
	// for the moment in between — it would unwatch and watch again for nothing.
	if (menusReportScheduled) {
		return;
	}
	menusReportScheduled = true;
	Promise.resolve().then(() => {
		menusReportScheduled = false;
		const open = !copyMenu.hidden || !browserMenu.hidden || contextMenuOpen;
		if (open === menusOpen) {
			return;
		}
		menusOpen = open;
		sendToPage({ kind: 'menuOpen', open });
	});
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
		const label = item.querySelector<HTMLSpanElement>('.menu-label')?.textContent;
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
	closeContextMenu();
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

// -- the standard editing commands -----------------------------------------------------------

/**
 * Cut, copy, paste and select all. They arrive here as commands and not as keys, because the
 * editor takes those keys for itself and answers them by running `execCommand` on this
 * document — which is the frame it created, one above the page — so the page never performs
 * anything. The address bar *is* in this document, so what has the focus decides where the
 * command goes.
 */
function runEditCommand(action: EditAction, text?: string): void {
	if (document.activeElement !== input) {
		// A copy the page is refused comes back as `copyToClipboard`, and is listened for only
		// until it does or until this runs out — a page free to say "put this on the
		// clipboard" is a page that can overwrite it on a timer.
		if (action === 'copy' || action === 'cut') {
			awaitingClipboardWrite = true;
			clearTimeout(clipboardWriteTimer);
			clipboardWriteTimer = setTimeout(() => (awaitingClipboardWrite = false), 1000);
		}

		// The click that chose the entry took the focus out of the frame, and an editing
		// command applies to a document that has it. The frame's own active element — the
		// field the user was typing in — comes back with it.
		iframe.focus();
		sendToPage({ kind: 'edit', action, text });
		return;
	}

	switch (action) {
		case 'selectAll':
			input.select();
			break;

		case 'undo':
		case 'redo':
			// The field's own history, which the browser keeps for it.
			document.execCommand(action);
			break;

		case 'paste':
			if (text) {
				// Spliced into what is there rather than replacing it, and reported as typing
				// so the completion below follows along.
				input.setRangeText(text, input.selectionStart ?? 0, input.selectionEnd ?? 0, 'end');
				input.dispatchEvent(new Event('input'));
			}
			break;

		case 'copy':
		case 'cut': {
			const taken = input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? undefined);
			let written = false;
			try {
				written = document.execCommand(action);
			} catch {
				// Refused, as it is in the page: the host writes it instead.
			}
			if (!written && taken) {
				vscode.postMessage({ type: 'writeClipboard', text: taken });
				if (action === 'cut') {
					input.setRangeText('', input.selectionStart ?? 0, input.selectionEnd ?? 0, 'end');
					input.dispatchEvent(new Event('input'));
				}
			}
			break;
		}
	}
}

// -- zoom ------------------------------------------------------------------------------------

/**
 * Scale the frame and give it an inversely sized layout viewport so the page reflows.
 * CSS zoom on a cross-site iframe can resize its viewport without scaling its contents in
 * Chromium. A transform also scales the separately composited frame used by VS Code.
 */
function applyZoom(): void {
	iframe.style.transform = `scale(${zoomLevel})`;
	iframe.style.transformOrigin = 'top left';
	iframe.style.width = `${100 / zoomLevel}%`;
	iframe.style.height = `${100 / zoomLevel}%`;

	const percent = `${Math.round(zoomLevel * 100)}%`;
	const detail = browserMenu.querySelector<HTMLSpanElement>('.menu-detail');
	if (detail) {
		detail.textContent = percent;
	}
	// The only place a zoom that is not 100% is otherwise visible is the page itself.
	browserMenuToggle.title = zoomLevel === 1 ? browserMenuTitle : `${browserMenuTitle} · ${percent}`;
}

/**
 * A pinch, or `Cmd`/`Ctrl` + wheel: one gesture is many small deltas, and the zoom it drives is
 * a handful of steps. So the deltas are added up and a step is taken when they amount to one —
 * a mouse wheel notch being about one step, and a trackpad pinch a smooth walk through them.
 */
function onZoomGesture(delta: number): void {
	const now = Date.now();
	// A new gesture, or one that has turned around: what came before it is not part of it.
	if (now - lastGestureAt > gestureIdle || Math.sign(delta) !== Math.sign(gestureDelta)) {
		gestureDelta = 0;
	}
	lastGestureAt = now;
	gestureDelta += delta;

	if (Math.abs(gestureDelta) < gestureStep) {
		return;
	}
	// Pinching out and scrolling up are both a negative delta, and both mean closer.
	const direction = gestureDelta < 0 ? 'in' : 'out';
	gestureDelta = 0;
	stepZoom(direction);
}

function stepZoom(direction: 'in' | 'out' | 'reset'): void {
	const next = direction === 'reset'
		? 1
		: direction === 'in'
			? zoomSteps.find(step => step > zoomLevel + 0.001) ?? zoomSteps[zoomSteps.length - 1]
			: [...zoomSteps].reverse().find(step => step < zoomLevel - 0.001) ?? zoomSteps[0];

	if (next === zoomLevel) {
		return;
	}
	zoomLevel = next;
	applyZoom();
	saveState();
}

// -- the panel's own menu --------------------------------------------------------------------

function browserMenuItems(): HTMLButtonElement[] {
	return Array.from(browserMenu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
}

function setBrowserMenuOpen(open: boolean): void {
	if (open) {
		setMenuOpen(false);
		closeContextMenu();
		hideSuggestions();
	}
	browserMenu.hidden = !open;
	browserMenuToggle.setAttribute('aria-expanded', String(open));
	browserMenuToggle.classList.toggle('active', open);
	if (open) {
		browserMenuItems()[0]?.focus();
	}
	reportMenusOpen();
}

function runBrowserCommand(command: BrowserMenuCommand): void {
	setBrowserMenuOpen(false);

	switch (command) {
		case 'newTab':
			// A panel is the extension host's to open; this one keeps the page it has.
			vscode.postMessage({ type: 'newTab' });
			break;
		case 'zoomIn':
			stepZoom('in');
			break;
		case 'zoomOut':
			stepZoom('out');
			break;
		case 'resetZoom':
			stepZoom('reset');
			break;
		case 'paste':
			// The one editing command that has to go out to the extension host and come back:
			// only the host may read the clipboard.
			vscode.postMessage({ type: 'runEdit', action: 'paste' });
			break;

		default:
			runEditCommand(command);
			break;
	}
}

/**
 * The keys the page forwards, and *only* those. What the page sends is a shape from the script
 * the proxy injected into it, so a page can send it too — and the editing commands must not be
 * reachable that way: a page that could ask for a paste could read the clipboard.
 */
/** The editing commands, which both of the panel's menus offer. */
function isEditAction(command: ContextMenuCommand): command is EditAction {
	return command === 'undo' || command === 'redo' || command === 'copy'
		|| command === 'cut' || command === 'paste' || command === 'selectAll';
}

function isShortcutAction(value: unknown): value is ShortcutAction {
	return value === 'newTab' || value === 'zoomIn' || value === 'zoomOut' || value === 'resetZoom';
}

// -- what the address bar completes ----------------------------------------------------------

/** `http://localhost:3000/a` -> `localhost:3000/a`, and a file url -> the file's own path. */
function displayForm(url: string): string {
	return /^file:/i.test(url)
		? url.replace(/^file:\/\//i, '')
		: url.replace(/^https?:\/\//i, '').replace(/\/$/, '') || url;
}

/**
 * How well a remembered page answers what has been typed, lower being better; `undefined` is
 * no answer at all. What a person types into an address bar is the start of a host or of a
 * path, so those come first, and everything else is ordered by how recently it was open.
 */
function matchRank(url: string, typed: string): number | undefined {
	if (!typed) {
		return 0;
	}
	const bare = displayForm(url).toLowerCase();
	if (bare.startsWith(typed)) {
		return 0;
	}
	if (bare.split(/[/?#]/).some(part => part.startsWith(typed))) {
		return 1;
	}
	if (bare.includes(typed)) {
		return 2;
	}
	// Matched in the scheme alone, which is the least someone can have meant.
	return url.toLowerCase().includes(typed) ? 3 : undefined;
}

function suggestionsFor(query: string): string[] {
	const typed = query.trim().toLowerCase();
	const matches: { readonly url: string; readonly rank: number; readonly age: number }[] = [];

	recentUrls.forEach((url, age) => {
		// The page the panel is already on is not somewhere to go.
		if (url === displayUrl) {
			return;
		}
		const rank = matchRank(url, typed);
		if (rank !== undefined) {
			matches.push({ url, rank, age });
		}
	});

	matches.sort((a, b) => a.rank - b.rank || a.age - b.age);
	return matches.slice(0, maxSuggestions).map(match => match.url);
}

/** The label, with the part the typed text matched marked in it. */
function suggestionLabel(url: string, typed: string): HTMLSpanElement {
	const label = document.createElement('span');
	label.className = 'menu-label';
	const text = displayForm(url);
	const at = typed ? text.toLowerCase().indexOf(typed.trim().toLowerCase()) : -1;

	if (at === -1) {
		label.textContent = text;
		return label;
	}

	const match = document.createElement('span');
	match.className = 'match';
	match.textContent = text.slice(at, at + typed.trim().length);
	label.append(text.slice(0, at), match, text.slice(at + typed.trim().length));
	return label;
}

function showSuggestions(query: string): void {
	const urls = suggestionsFor(query);
	typedUrl = query;
	suggestionIndex = -1;
	suggestions.textContent = '';

	for (const url of urls) {
		const item = document.createElement('button');
		item.type = 'button';
		item.setAttribute('role', 'option');
		item.dataset.url = url;
		const icon = document.createElement('i');
		icon.className = `codicon ${/^file:/i.test(url) ? 'codicon-file-code' : 'codicon-globe'}`;
		item.append(icon, suggestionLabel(url, query));
		// The field keeps the focus, so the click that follows lands on a live suggestion
		// rather than on one the blur has already taken away.
		item.addEventListener('mousedown', event => event.preventDefault());
		item.addEventListener('click', () => commitUrl(url));
		suggestions.appendChild(item);
	}

	suggestions.hidden = !urls.length;
	input.setAttribute('aria-expanded', String(!!urls.length));
}

function hideSuggestions(): void {
	suggestions.hidden = true;
	suggestionIndex = -1;
	input.setAttribute('aria-expanded', 'false');
}

function suggestionButtons(): HTMLButtonElement[] {
	return Array.from(suggestions.querySelectorAll<HTMLButtonElement>('[role="option"]'));
}

/** Arrow keys walk the list and fill the field, so Enter goes where the field says. */
function moveSuggestion(delta: number): void {
	const items = suggestionButtons();
	if (!items.length) {
		return;
	}

	// One past each end is "what I typed", the way an address bar behaves.
	const next = suggestionIndex + delta;
	suggestionIndex = next < -1 ? items.length - 1 : next >= items.length ? -1 : next;

	items.forEach((item, index) => {
		const selected = index === suggestionIndex;
		item.classList.toggle('selected', selected);
		item.setAttribute('aria-selected', String(selected));
		if (selected) {
			item.scrollIntoView({ block: 'nearest' });
		}
	});

	input.value = suggestionIndex === -1 ? typedUrl : items[suggestionIndex].dataset.url ?? '';
}

/** Goes to what the field holds — or to the suggestion the arrow keys stopped on. */
function commitUrl(url: string): void {
	editingUrl = false;
	lastCommitted = url;
	input.value = url;
	hideSuggestions();
	navigateTo(url);
}

/** Puts the page's own url in the field, which is never a value to navigate back to. */
function showUrlInInput(): void {
	if (editingUrl) {
		return;
	}
	// Never assigned when it would not change the text: assigning drops the caret and the
	// selection, and a field somebody has selected the url in is not ours to rearrange.
	if (input.value !== displayUrl) {
		input.value = displayUrl;
	}
	lastCommitted = displayUrl;
}

// -- context menu ----------------------------------------------------------------------------

function contextMenuItems(): HTMLButtonElement[] {
	return Array.from(contextMenu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
}

/**
 * `at` is where the click was, in the top document's viewport: the page has already added what
 * every frame it went through contributes, so the only thing left is where the frame itself
 * sits in this document.
 */
function openContextMenu(at: PagePoint, descriptor: string, targetId: string): void {
	setMenuOpen(false);
	contextTargetId = targetId;
	contextMenuHeader.textContent = descriptor;
	// Unhidden before it is measured: a `[hidden]` element has no size to place it by. Nothing
	// is painted in between, since both happen in this one turn.
	contextMenu.hidden = false;
	contextMenuOpen = true;

	const frame = iframe.getBoundingClientRect();
	const width = contextMenu.offsetWidth;
	const height = contextMenu.offsetHeight;
	// The page reports a point in its own viewport, and the frame's box is the zoomed one: at
	// 150% a point 100px into the page is 150px into the panel.
	const wanted = { x: frame.left + at.x * zoomLevel, y: frame.top + at.y * zoomLevel };
	// Flipped above the cursor rather than pushed up when there is no room below it: pushing it
	// up puts an entry the click never aimed at under the pointer.
	contextMenu.style.left = `${Math.max(2, Math.min(wanted.x, window.innerWidth - width - 2))}px`;
	contextMenu.style.top = `${wanted.y + height + 2 <= window.innerHeight
		? wanted.y
		: Math.max(2, wanted.y - height)}px`;

	// And the keyboard is deliberately *not* taken: this menu offers copy, cut and paste, which
	// act on the selection and the field the page has — and focusing an entry of ours takes the
	// focus out of the page. Escape still closes it, reported by the page like any other
	// dismissal, since the page is watching while a menu is up.

	// Every frame watches for the click that closes this again: the panel cannot see one, and
	// the next click is not necessarily in the frame the menu was opened from.
	reportMenusOpen();
}

function closeContextMenu(): void {
	if (!contextMenuOpen) {
		return;
	}
	contextMenuOpen = false;
	contextMenu.hidden = true;
	// Named, so a frame that has since taken a *new* right-click keeps the element that one is
	// about — this message can arrive after it. A frame that has already handed its element
	// over has nothing left to forget, which is why the pick below closes the same way.
	sendToPage({ kind: 'clearContextTarget', targetId: contextTargetId });
	reportMenusOpen();
}

/**
 * The element is never sent up with the click — describing one is the expensive half of a pick,
 * and most right-clicks end in no command at all — so the page is asked for it here, and holds
 * on to it in the meantime.
 */
function runContextCommand(command: ContextMenuCommand): void {
	const targetId = contextTargetId;

	// Nothing but an element pick has anything to do with the element the menu was opened on.
	if (command === 'inspect') {
		closeContextMenu();
		vscode.postMessage({ type: 'openDevTools' });
		return;
	}

	if (isEditAction(command)) {
		closeContextMenu();
		runBrowserCommand(command);
		return;
	}

	if (isConsoleCommand(command)) {
		closeContextMenu();
		runCopyCommand(command);
		return;
	}

	setLastCopyCommand(command);
	pickCommand = command;
	awaitingContextPick = true;
	showHint('waiting', 'Reading the element…');
	// Asked for *before* the menu is closed, and never the other way round: closing is what
	// tells the page to forget that element, the two messages arrive in the order they are
	// sent, and a page that has forgotten it answers nothing at all.
	sendToPage({ kind: 'pickContextTarget', targetId });
	closeContextMenu();

	// The element can be gone by now — a menu is open for as long as the user wants — and a
	// page with nothing to report says nothing at all.
	clearTimeout(contextPickTimer);
	contextPickTimer = setTimeout(() => {
		if (!awaitingContextPick) {
			return;
		}
		awaitingContextPick = false;
		showHint('error', 'That element is no longer on the page.');
	}, 5000);
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
		// The document the menu was opened on is gone, and with it the element it named.
		closeContextMenu();
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

	// A pinch over the toolbar or the hint bar, where there is no page to report it.
	document.addEventListener('wheel', event => {
		if ((!event.ctrlKey && !event.metaKey) || event.defaultPrevented) {
			return;
		}
		event.preventDefault();
		onZoomGesture(event.deltaMode === 1 ? event.deltaY * 16
			: event.deltaMode === 2 ? event.deltaY * 100 : event.deltaY);
	}, { passive: false });

	input.addEventListener('input', () => {
		editingUrl = true;
		showSuggestions(input.value);
	});

	// Focusing an empty field is a new tab asking where to go; a field that already holds a
	// page is not, and a list dropping over the page for a click is not what was asked for.
	input.addEventListener('focus', () => {
		if (!input.value) {
			showSuggestions('');
		}
	});

	input.addEventListener('blur', () => {
		hideSuggestions();
		// Whatever was typed and not sent anywhere: `change` has had its say by now, so from
		// here on the field belongs to the page again — unless it is holding what was just
		// sent somewhere, in which case the answer to that is on its way and fills it in.
		editingUrl = false;
		if (input.value !== lastCommitted) {
			showUrlInInput();
		}
	});

	input.addEventListener('keydown', event => {
		switch (event.key) {
			case 'ArrowDown':
			case 'ArrowUp': {
				event.preventDefault();
				if (suggestions.hidden) {
					showSuggestions(input.value);
				}
				moveSuggestion(event.key === 'ArrowDown' ? 1 : -1);
				return;
			}

			case 'Enter':
				// Whatever the field holds, which the arrow keys have already filled in.
				event.preventDefault();
				commitUrl(input.value);
				return;

			case 'Escape':
				if (!suggestions.hidden) {
					// The list closes and the typed text stands; the second Escape is the
					// picker's, which the handler on the document takes.
					event.stopPropagation();
					input.value = typedUrl;
					hideSuggestions();
				}
				return;

			case 'Tab':
				hideSuggestions();
				return;
		}
	});

	// Enter and a click on a suggestion have both navigated by now; the `change` that follows
	// on blur is the same value a second time.
	input.addEventListener('change', () => {
		if (input.value !== lastCommitted) {
			commitUrl(input.value);
		}
	});

	forwardButton.addEventListener('click', () => history.forward());
	backButton.addEventListener('click', () => history.back());
	reloadButton.addEventListener('click', () => navigateTo(input.value, { bust: true }));
	openExternalButton.addEventListener('click', () => {
		vscode.postMessage({ type: 'openExternal', url: displayUrl });
	});

	copyActionButton.addEventListener('click', () => runCopyCommand(lastCopyCommand));
	copyMenuToggle.addEventListener('click', () => setMenuOpen(!isMenuOpen()));
	browserMenuToggle.addEventListener('click', () => setBrowserMenuOpen(browserMenu.hidden));

	for (const item of browserMenuItems()) {
		item.addEventListener('click', () => {
			runBrowserCommand(item.dataset.command as BrowserMenuCommand);
		});
	}

	for (const item of menuItems()) {
		item.addEventListener('click', () => {
			runCopyCommand(item.dataset.command as CopyCommand);
		});
	}

	for (const item of contextMenuItems()) {
		item.addEventListener('click', () => {
			runContextCommand(item.dataset.command as ContextMenuCommand);
		});
	}

	// Arrow keys inside a menu, the way a menu is expected to behave.
	for (const [menu, items] of [[copyMenu, menuItems], [contextMenu, contextMenuItems],
		[browserMenu, browserMenuItems]] as const) {
		menu.addEventListener('keydown', event => {
			if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
				return;
			}
			event.preventDefault();
			const entries = items();
			const index = entries.indexOf(document.activeElement as HTMLButtonElement);
			const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
			entries[(next + entries.length) % entries.length]?.focus();
		});
	}

	document.addEventListener('click', event => {
		const target = event.target as Node;
		if (isMenuOpen() && !copyMenu.contains(target) && !copyMenuToggle.contains(target)) {
			setMenuOpen(false);
		}
		if (!browserMenu.hidden && !browserMenu.contains(target)
			&& !browserMenuToggle.contains(target)) {
			setBrowserMenuOpen(false);
		}
		// A click inside the page closes it too, but that one is the page's to report: this
		// document hears nothing of what happens inside the frame.
		if (contextMenuOpen && !contextMenu.contains(target)) {
			closeContextMenu();
		}
	});

	document.addEventListener('keydown', event => {
		if (event.key !== 'Escape') {
			return;
		}
		if (isMenuOpen()) {
			setMenuOpen(false);
			copyMenuToggle.focus();
		} else if (!browserMenu.hidden) {
			setBrowserMenuOpen(false);
			browserMenuToggle.focus();
		} else if (contextMenuOpen) {
			// The menu has the keyboard, so this is where Escape arrives; the page hands back
			// the one that happens while the focus is still inside it.
			closeContextMenu();
			iframe.focus();
		} else if (pickerActive) {
			// The iframe swallows Escape while it has focus, so also listen here.
			setPickerActive(false);
		}
	});

	setLastCopyCommand(lastCopyCommand);
	applyZoom();

	input.value = settings.url;
	lastCommitted = settings.url;
	if (settings.url) {
		navigateTo(settings.url);
	} else {
		// A new tab: nothing to load, and the one useful thing to do with it is to say where
		// to go. Assigning an empty `src` would load this very document into the frame.
		input.focus();
		showSuggestions('');
	}

	toggleFocusLockIndicatorEnabled(settings.focusLockEnabled);
});
