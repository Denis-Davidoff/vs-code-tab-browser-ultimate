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
	packAgentMessage,
} from '../shared/protocol';
import { consoleSnapshot, installConsoleCapture } from './consoleCapture';
import { PageContextMenu } from './contextMenu';
import { installCookiePrefix } from './cookies';
import { handlePageRequest } from './pageRequests';
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

function install(): void {
	// Before anything else: page scripts start logging as soon as they run.
	installConsoleCapture();
	installCookiePrefix(window.__tabBrowserConfig?.cookiePrefix ?? '');

	const realOrigin = window.__tabBrowserConfig?.realOrigin ?? location.origin;
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
		onDismiss: () => send({ kind: 'dismissContextMenu' }),
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

			case 'contextMenuOpen': {
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

			case 'dismissContextMenu':
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
