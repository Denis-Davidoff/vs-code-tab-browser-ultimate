/*---------------------------------------------------------------------------------------------
 *  Injected by the extension's proxy into every html page it serves.
 *
 *  Runs in every instrumented frame. Nested frames relay their events through their parent,
 *  prefixing the `<iframe>` selector so the webview receives a full path.
 *--------------------------------------------------------------------------------------------*/

import {
	AgentEvent,
	AgentMessage,
	cacheBustParameter,
	isAgentMessage,
	EditAction,
	packAgentMessage,
	ShortcutAction,
} from '../shared/protocol';
import { consoleSnapshot, installConsoleCapture } from './consoleCapture';
import { PageContextMenu } from './contextMenu';
import { installCookiePrefix } from './cookies';
import { handlePageRequest } from './pageRequests';
import { installRequestRewriting } from './requests';
import { findIconHref } from './pageIcon';
import { ElementPicker } from './picker';
import { cssPath, describeElement } from './selectors';

interface AgentBootstrapConfig {
	/**
	 * Where the page's own urls belong: the origin of the real server, or — for a page served
	 * off the disk — the `file:` url of the folder it was served from.
	 */
	readonly realOrigin: string;
	/** Prefix the proxy puts on this session's cookie names; the page must not see it. */
	readonly cookiePrefix?: string;
	/**
	 * Path prefix this session answers under, which is the session's and not the page's. Only
	 * a session serving the disk has one, and every url reported from here has it taken off.
	 */
	readonly basePath?: string;
}

declare global {
	interface Window {
		__tabBrowserConfig?: AgentBootstrapConfig;
		__tabBrowserInstalled?: boolean;
	}
}

if (!window.__tabBrowserInstalled) {
	window.__tabBrowserInstalled = true;
	install();
}

/** One patch of the page's own globals that will not take must not stop the rest. */
function tryInstall(install: () => void): void {
	try {
		install();
	} catch {
		// The page has that api locked down; everything else still works.
	}
}

function install(): void {
	// Before anything else: page scripts start logging as soon as they run. Each of these
	// patches an api of the page's own, and a page is free to have frozen it — so one that
	// cannot be installed must not take the rest of the agent down with it: the picker, the
	// element reports, the shortcuts and every mcp tool come after.
	tryInstall(installConsoleCapture);
	tryInstall(() => installCookiePrefix(window.__tabBrowserConfig?.cookiePrefix ?? ''));

	const realOrigin = window.__tabBrowserConfig?.realOrigin ?? location.origin;

	// And before the page asks for anything, since the first thing a framework does on the
	// client is fetch its own api.
	tryInstall(() => installRequestRewriting(realOrigin));
	const basePath = window.__tabBrowserConfig?.basePath ?? '';

	// -- messaging ---------------------------------------------------------------------------

	function send(event: AgentEvent): void {
		try {
			window.parent?.postMessage(packAgentMessage(event), '*');
		} catch {
			// The parent may be gone.
		}
	}

	function childFrames(): HTMLIFrameElement[] {
		return Array.prototype.slice.call(document.querySelectorAll('iframe, frame'));
	}

	function post(target: Window | null | undefined, message: AgentMessage): void {
		try {
			target?.postMessage(packAgentMessage(message), '*');
		} catch {
			// A cross-origin frame without our script; nothing to do.
		}
	}

	function broadcast(message: AgentMessage, except?: MessageEventSource | null): void {
		for (const frame of childFrames()) {
			if (!except || frame.contentWindow !== except) {
				post(frame.contentWindow, message);
			}
		}
	}

	function findFrameElement(source: MessageEventSource | null): HTMLIFrameElement | undefined {
		if (!source) {
			return undefined;
		}
		for (const frame of childFrames()) {
			if (frame.contentWindow === source) {
				return frame;
			}
		}
		return undefined;
	}

	function onRealServer(rawUrl: string): string {
		try {
			const current = new URL(rawUrl, location.href);
			// Only what we serve ourselves is on the proxy; a cdn url is already where it belongs.
			if (current.origin !== location.origin) {
				return current.toString();
			}
			// The panel's own way of making the frame load a page twice is not part of the url
			// of anything, and a page reloaded on every save would carry it into every report.
			current.searchParams.delete(cacheBustParameter);
			// A page served off the disk. Rebuilt rather than re-hosted, because a `URL` cannot
			// be moved between `file:` and a scheme with a host — and because the path it is
			// served under starts with a segment that is the session's, not the page's.
			if (realOrigin.indexOf('file:') === 0) {
				const rest = basePath && current.pathname.indexOf(basePath) === 0
					? current.pathname.slice(basePath.length)
					: current.pathname;
				return realOrigin + rest + current.search + current.hash;
			}
			const real = new URL(realOrigin);
			current.protocol = real.protocol;
			current.host = real.host;
			return current.toString();
		} catch {
			return rawUrl;
		}
	}

	function documentUrlOnRealServer(): string {
		return onRealServer(location.href);
	}

	// -- page icon and title -------------------------------------------------------------------

	let reportedIcon: string | undefined;
	let reportedTitle: string | undefined;

	function reportIcon(): void {
		const href = findIconHref();
		if (!href || href === reportedIcon) {
			return;
		}
		reportedIcon = href;
		send({ kind: 'icon', href: onRealServer(href) });
	}

	function reportTitle(): void {
		const title = document.title;
		// An empty title is not a title: the panel names such a tab after the host instead.
		if (!title || title === reportedTitle) {
			return;
		}
		reportedTitle = title;
		send({ kind: 'title', title });
	}

	function watchHead(): void {
		// Single page apps swap the icon and the title after the fact, often more than once.
		let scheduled = 0;
		const observer = new MutationObserver(() => {
			if (scheduled) {
				return;
			}
			scheduled = setTimeout(() => {
				scheduled = 0;
				reportIcon();
				reportTitle();
			}, 200) as unknown as number;
		});
		observer.observe(document.head ?? document.documentElement, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ['href', 'rel', 'sizes', 'type'],
			// `document.title = '...'` only rewrites the text node inside <title>.
			characterData: true,
		});
	}

	// -- in page navigation --------------------------------------------------------------------

	/**
	 * A single page app changes the url without loading a document, so nothing else would tell
	 * the panel that its address bar is out of date.
	 */
	function watchNavigation(): void {
		let reported = location.href;
		const report = () => {
			if (location.href === reported) {
				return;
			}
			reported = location.href;
			send({ kind: 'navigated', documentUrl: documentUrlOnRealServer() });
			reportIcon();
			reportTitle();
		};

		for (const name of ['pushState', 'replaceState'] as const) {
			const original = history[name];
			history[name] = function (this: History, ...args: Parameters<History['pushState']>) {
				const result = original.apply(this, args);
				setTimeout(report, 0);
				return result;
			};
		}
		window.addEventListener('popstate', () => setTimeout(report, 0));
		window.addEventListener('hashchange', report);
	}

	// -- picker ------------------------------------------------------------------------------

	const picker = new ElementPicker({
		onHover: selector => send({ kind: 'hover', selector, framePath: [] }),
		onPick: element => send({ kind: 'pick', element }),
		onCancel: () => {
			// Cancelling inside this document must not leave nested frames picking.
			broadcast({ kind: 'disablePicker' });
			send({ kind: 'cancel' });
		},
		documentUrl: documentUrlOnRealServer,
	});

	// -- context menu ------------------------------------------------------------------------

	/**
	 * Only one document in the chain may be holding a target: the panel asks for it by nothing
	 * but "the one you told me about", so a stale target in a frame nobody clicked in would
	 * answer for the click that happened somewhere else.
	 */
	const contextMenu = new PageContextMenu({
		highlight: element => picker.highlight(element),
		clearHighlight: () => picker.clearHighlight(),
		onOpen: (at, descriptor, targetId) => {
			broadcast({ kind: 'clearContextTarget' });
			send({ kind: 'contextMenu', at, descriptor, targetId });
		},
		onDismiss: () => send({ kind: 'dismissMenu' }),
	});

	/** Where this frame's content box starts, so a nested click lands where the cursor is. */
	function frameOffset(frame: HTMLIFrameElement): { x: number; y: number } {
		const rect = frame.getBoundingClientRect();
		const style = getComputedStyle(frame);
		return {
			x: rect.left + frame.clientLeft + (parseFloat(style.paddingLeft) || 0),
			y: rect.top + frame.clientTop + (parseFloat(style.paddingTop) || 0),
		};
	}

	// -- command handling --------------------------------------------------------------------

	window.addEventListener('message', event => {
		const message: unknown = event.data;
		if (!isAgentMessage(message)) {
			return;
		}

		switch (message.kind) {
			case 'enablePicker':
			case 'disablePicker': {
				// Picker commands only ever travel downwards.
				if (event.source && event.source !== window && event.source !== window.parent) {
					return;
				}
				if (message.kind === 'enablePicker') {
					picker.enable(message.preferAttributes);
				} else {
					picker.disable();
				}
				broadcast(message);
				return;
			}

			case 'setContextMenu': {
				// Like the picker's, these only ever travel downwards.
				if (event.source && event.source !== window && event.source !== window.parent) {
					return;
				}
				picker.setPreferredAttributes(message.preferAttributes);
				contextMenu.setEnabled(message.enabled);
				broadcast(message);
				return;
			}

			case 'menuOpen': {
				if (event.source && event.source !== window && event.source !== window.parent) {
					return;
				}
				contextMenu.setOpen(message.open, message.targetId);
				broadcast(message);
				return;
			}

			case 'pickContextTarget': {
				if (event.source && event.source !== window && event.source !== window.parent) {
					return;
				}
				const target = contextMenu.take(message.targetId);
				if (target) {
					send({
						kind: 'pick',
						element: describeElement(
							target, picker.preferredAttributes, documentUrlOnRealServer()),
					});
				}
				// The click may have happened in a frame further down; only that one answers.
				broadcast(message);
				return;
			}

			case 'clearContextTarget': {
				if (event.source && event.source !== window && event.source !== window.parent) {
					return;
				}
				contextMenu.clear();
				broadcast(message);
				return;
			}

			case 'request': {
				if (event.source && event.source !== window && event.source !== window.parent) {
					return;
				}
				const requestId = message.requestId;
				const fail = (error: unknown) => send({
					kind: 'result',
					requestId,
					error: error instanceof Error ? error.message : String(error),
				});

				try {
					// `waitFor` answers later; everything else is done by the time it returns.
					Promise.resolve(handlePageRequest(message.request, documentUrlOnRealServer()))
						.then(value => send({ kind: 'result', requestId, value }), fail);
				} catch (error) {
					fail(error);
				}
				return;
			}

			case 'alive': {
				if (event.source && event.source !== window && event.source !== window.parent) {
					return;
				}
				// Answered by whichever document is holding the frame when the question
				// arrives, which is the whole point of asking: the webview cannot tell a
				// document with no agent from one whose report has not arrived yet.
				send({
					kind: 'aliveAnswer',
					probeId: message.probeId,
					ready: document.readyState !== 'loading',
				});
				return;
			}

			case 'edit': {
				if (event.source && event.source !== window && event.source !== window.parent) {
					return;
				}
				runEditCommand(message.action, message.text);
				return;
			}

			case 'collectConsole': {
				if (event.source && event.source !== window && event.source !== window.parent) {
					return;
				}
				// Only this document's console; nested frames keep their own buffers.
				const snapshot = consoleSnapshot();
				send({
					kind: 'console',
					requestId: message.requestId,
					entries: snapshot.entries,
					dropped: snapshot.dropped,
					documentUrl: documentUrlOnRealServer(),
				});
				return;
			}
		}

		// Everything else is an event bubbling up from a nested frame.
		const frame = findFrameElement(event.source);
		if (!frame) {
			return;
		}

		switch (message.kind) {
			case 'ready':
				// A frame finished loading while picking: bring it up to speed instead of
				// bothering the webview with it.
				if (picker.active) {
					post(frame.contentWindow, { kind: 'enablePicker', preferAttributes: picker.preferredAttributes });
				}
				if (contextMenu.enabled) {
					post(frame.contentWindow, {
						kind: 'setContextMenu',
						enabled: true,
						preferAttributes: picker.preferredAttributes,
					});
				}
				return;

			case 'icon':
			case 'title':
			case 'navigated':
				// A nested frame's icon, title and url have nothing to do with the panel.
				return;

			case 'aliveAnswer':
				// Nothing asks a nested frame, and its answer would say nothing about the
				// document the panel is holding — only the top one can answer for that.
				return;

			case 'pageError':
			case 'console':
			case 'result':
			case 'shortcut':
			case 'zoomGesture':
			case 'copyToClipboard':
				send(message);
				return;

			case 'cancel':
				// Cancelling in any frame cancels everywhere, without waiting for the webview
				// to send the command back down.
				picker.disable();
				broadcast({ kind: 'disablePicker' });
				send(message);
				return;

			case 'contextMenu': {
				// The click was in a descendant, so nothing in this document is under it, and
				// no other frame of ours can be either.
				contextMenu.clear();
				broadcast({ kind: 'clearContextTarget' }, event.source);
				const offset = frameOffset(frame);
				send({
					kind: 'contextMenu',
					at: { x: message.at.x + offset.x, y: message.at.y + offset.y },
					descriptor: message.descriptor,
					targetId: message.targetId,
				});
				return;
			}

			case 'dismissMenu':
				send(message);
				return;

			case 'hover':
				send({
					kind: 'hover',
					selector: message.selector,
					framePath: [cssPath(frame, picker.preferredAttributes), ...message.framePath],
				});
				return;

			case 'pick':
				send({
					kind: 'pick',
					element: {
						...message.element,
						framePath: [cssPath(frame, picker.preferredAttributes), ...message.element.framePath],
					},
				});
				return;
		}
	});

	// -- the standard editing commands ---------------------------------------------------------

	/** What a copy would take: the selection, or the part of a field that is selected. */
	function selectedText(): string {
		const active = document.activeElement as HTMLInputElement | null;
		if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
			&& typeof active.selectionStart === 'number') {
			return String(active.value ?? '')
				.slice(active.selectionStart ?? 0, active.selectionEnd ?? undefined);
		}
		return String(window.getSelection() ?? '');
	}

	/**
	 * Cut, copy, paste and select all, in the document that actually has the keyboard.
	 *
	 * The command arrives at the top document and is passed to whichever frame holds the focus,
	 * because that is the one the user is editing in — a command run everywhere would copy from
	 * three documents at once.
	 */
	function runEditCommand(action: EditAction, text?: string): void {
		const focused = document.activeElement;
		if (focused instanceof HTMLIFrameElement || focused instanceof HTMLFrameElement) {
			post(focused.contentWindow, { kind: 'edit', action, text });
			return;
		}

		switch (action) {
			case 'undo':
			case 'redo':
			case 'selectAll':
				// What a browser does with these keys, in the document that has the keyboard.
				document.execCommand(action);
				return;

			case 'paste':
				// Through the editing pipeline rather than by assigning `value`: this fires
				// `beforeinput` and `input`, so a framework sees the change and undo still
				// works. Nothing about it needs the clipboard, which the page cannot read.
				if (text) {
					document.execCommand('insertText', false, text);
				}
				return;

			case 'copy':
			case 'cut': {
				// A document with no user activation of its own may be refused the clipboard,
				// and this command arrived as a message rather than as a keystroke — so what
				// it selected goes to the extension host, which is allowed to write it.
				const taken = selectedText();
				let written = false;
				try {
					written = document.execCommand(action);
				} catch {
					// Refused; the host writes it instead.
				}
				if (!written && taken) {
					send({ kind: 'copyToClipboard', text: taken });
					if (action === 'cut') {
						document.execCommand('delete');
					}
				}
				return;
			}
		}
	}

	// -- the panel's own keyboard shortcuts ----------------------------------------------------

	/**
	 * A browser keeps `Cmd`/`Ctrl` + `T`, `+`, `-` and `0` for itself, so a page never sees
	 * them — and here the panel is the browser. While the page has the focus nothing else
	 * hears them at all: a key pressed inside a frame reaches no listener above it, and the
	 * editor's own keybindings never see it either. Hence the capture phase: a page that
	 * swallows keys is not being asked.
	 */
	window.addEventListener('keydown', event => {
		if (!(event.metaKey || event.ctrlKey) || event.altKey) {
			return;
		}

		const action: ShortcutAction | undefined =
			event.key === '=' || event.key === '+' ? 'zoomIn'
				: event.key === '-' || event.key === '_' ? 'zoomOut'
					: event.key === '0' ? 'resetZoom'
						// `+` needs shift on most layouts, so shift is only in the way here.
						: (event.key === 't' || event.key === 'T') && !event.shiftKey ? 'newTab'
							: undefined;
		if (!action) {
			return;
		}

		event.preventDefault();
		send({ kind: 'shortcut', action });
	}, true);

	/**
	 * Zooming by gesture. A pinch on a trackpad arrives as a `wheel` event carrying `ctrlKey`
	 * — the convention every browser uses for it — which is also exactly what `Cmd`/`Ctrl` +
	 * wheel produces, so one listener answers both. Not passive, because the page must not
	 * scroll under a gesture that was never about scrolling.
	 */
	window.addEventListener('wheel', event => {
		// Whether the page wanted it is not ours to decide, exactly as with a right-click: a
		// map or a canvas app that zooms on `ctrl` + wheel says so by taking the event, and
		// this listener sits last of all of them to hear that. A browser gives the page the
		// same chance, which is how those apps zoom at all.
		if ((!event.ctrlKey && !event.metaKey) || event.defaultPrevented) {
			return;
		}
		event.preventDefault();
		// A line or a page of scrolling, in the pixels the panel counts in.
		const delta = event.deltaMode === 1 ? event.deltaY * 16
			: event.deltaMode === 2 ? event.deltaY * 100 : event.deltaY;
		send({ kind: 'zoomGesture', delta });
	}, { passive: false });

	// -- diagnostics -------------------------------------------------------------------------

	let reportedErrors = 0;

	window.addEventListener('error', event => {
		// A subresource that did not load is the page's business and not the panel's: a dev
		// server rebuilding answers 404 for the chunk the page is still asking for, and a
		// banner over the page for something that resolves itself in a second is noise. It is
		// recorded either way — `consoleCapture` puts it in the console, where a browser puts
		// it too, so the copy menu and the mcp tools still see it.
		if (event.target && event.target !== window && (event.target as Element).tagName) {
			return;
		}

		// Enough to explain a blank page, without flooding the panel.
		if (reportedErrors >= 10) {
			return;
		}
		const message = event.message || String(event.error ?? 'Script error');
		if (!message) {
			return;
		}
		reportedErrors++;
		send({ kind: 'pageError', message: message.slice(0, 300) });
	}, true);

	// -- startup -----------------------------------------------------------------------------

	/**
	 * `ready` is what the panel waits on before it picks, reads or drives anything, so it must
	 * not be sent from where this script runs — the top of `<head>`, where there is no body to
	 * act on and no `<title>` parsed yet. The rest is in place from the first line either way:
	 * the console is captured and errors are reported from the moment the script is evaluated.
	 */
	function reportReady(): void {
		send({ kind: 'ready', documentUrl: documentUrlOnRealServer() });
		// Every instrumented document reports its icon and title to its parent; only the top one
		// reaches the webview, because a parent frame drops what its children send.
		reportIcon();
		reportTitle();
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', reportReady, { once: true });
	} else {
		reportReady();
	}

	watchHead();
	watchNavigation();
	window.addEventListener('pagehide', () => {
		picker.disable();
		contextMenu.clear();
	});
}
