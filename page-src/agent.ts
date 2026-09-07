/*---------------------------------------------------------------------------------------------
 *  Injected by the extension's proxy into every html page it serves.
 *
 *  Runs in every instrumented frame. Nested frames relay their events through their parent,
 *  prefixing the `<iframe>` selector so the webview receives a full path.
 *--------------------------------------------------------------------------------------------*/

import {
	AgentEvent,
	AgentMessage,
	isAgentMessage,
	packAgentMessage,
} from '../shared/protocol';
import { consoleSnapshot, installConsoleCapture } from './consoleCapture';
import { installCookiePrefix } from './cookies';
import { handlePageRequest } from './pageRequests';
import { findIconHref } from './pageIcon';
import { ElementPicker } from './picker';
import { cssPath } from './selectors';

interface AgentBootstrapConfig {
	readonly realOrigin: string;
	/** Prefix the proxy puts on this session's cookie names; the page must not see it. */
	readonly cookiePrefix?: string;
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

function install(): void {
	// Before anything else: page scripts start logging as soon as they run.
	installConsoleCapture();
	installCookiePrefix(window.__tabBrowserConfig?.cookiePrefix ?? '');

	const realOrigin = window.__tabBrowserConfig?.realOrigin ?? location.origin;

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

	function broadcast(message: AgentMessage): void {
		for (const frame of childFrames()) {
			post(frame.contentWindow, message);
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
		if (title === reportedTitle) {
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
				return;

			case 'icon':
			case 'title':
			case 'navigated':
				// A nested frame's icon, title and url have nothing to do with the panel.
				return;

			case 'pageError':
			case 'console':
			case 'result':
				send(message);
				return;

			case 'cancel':
				// Cancelling in any frame cancels everywhere, without waiting for the webview
				// to send the command back down.
				picker.disable();
				broadcast({ kind: 'disablePicker' });
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

	// -- diagnostics -------------------------------------------------------------------------

	let reportedErrors = 0;

	window.addEventListener('error', event => {
		// Enough to explain a blank page, without flooding the panel.
		if (reportedErrors >= 10) {
			return;
		}
		const target = event.target as (Element & { src?: string; href?: string }) | null;
		const message = target && target !== (window as unknown as Element) && target.tagName
			? `Failed to load ${target.tagName.toLowerCase()}${target.src || target.href ? `: ${target.src || target.href}` : ''}`
			: event.message || String(event.error ?? 'Script error');
		if (!message) {
			return;
		}
		reportedErrors++;
		send({ kind: 'pageError', message: message.slice(0, 300) });
	}, true);

	// -- startup -----------------------------------------------------------------------------

	send({ kind: 'ready', documentUrl: documentUrlOnRealServer() });
	// Every instrumented document reports its icon and title to its parent; only the top one
	// reaches the webview, because a parent frame drops what its children send.
	reportIcon();
	reportTitle();
	watchHead();
	watchNavigation();
	window.addEventListener('pagehide', () => picker.disable());
}
