/*---------------------------------------------------------------------------------------------
 *  Keeps a page's own requests on the origin it was served from.
 *
 *  A page built with an absolute url for its own api — what `AUTH_URL`, `NEXTAUTH_URL` or
 *  `NEXT_PUBLIC_API_URL` compile into a bundle — asks for `http://localhost:3000/api/…` while
 *  it is being served from the proxy's origin. Three things then go wrong at once, and a login
 *  is exactly that request:
 *
 *  - it is cross-origin, so it is blocked by cors (or preflighted into a failure), since a dev
 *    server has no reason to allow another origin;
 *  - it is cross-site — `127.0.0.1` and `localhost` are different sites, ports being no part of
 *    that — so a `SameSite` cookie is not sent with it at all, and a csrf token is one;
 *  - and the proxy never sees it, so the session's cookie names are not translated back.
 *
 *  The proxy rewrites such urls where it can see them, which is in the html; a bundle is not
 *  html. So they are rewritten here instead, in the three ways a page asks for something.
 *--------------------------------------------------------------------------------------------*/

export function installRequestRewriting(realOrigin: string): void {
	// Nothing to do for a page off the disk (a `file:` origin), or when the page is served from
	// the server it thinks it is talking to.
	if (!/^https?:$/.test(schemeOf(realOrigin)) || realOrigin === location.origin) {
		return;
	}

	/** The same url on this origin, if it is aimed at the server this page was served from. */
	function onOwnOrigin(rawUrl: string): string {
		try {
			const url = new URL(rawUrl, location.href);
			if (url.origin !== realOrigin) {
				return rawUrl;
			}
			return location.origin + url.pathname + url.search + url.hash;
		} catch {
			return rawUrl;
		}
	}

	const originalFetch = window.fetch;
	if (typeof originalFetch === 'function') {
		patch(() => {
			window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
			try {
				if (typeof input === 'string' || input instanceof URL) {
					const rewritten = onOwnOrigin(String(input));
					return originalFetch.call(this, rewritten, init);
				}
				// A `Request` carries its url, its method, its headers and its body, so the
				// only way to change the url is to build another one from it.
				const rewritten = onOwnOrigin(input.url);
				return originalFetch.call(
					this, rewritten === input.url ? input : new Request(rewritten, input), init);
				} catch {
					return originalFetch.call(this, input as RequestInfo, init);
				}
			};
		});
	}

	const open = XMLHttpRequest.prototype.open;
	if (typeof open === 'function') {
		// The signature is variadic and its optional arguments matter (`async`, credentials),
		// so everything but the url is passed on exactly as it arrived.
		patch(() => {
			XMLHttpRequest.prototype.open = function (
				this: XMLHttpRequest,
				method: string,
				url: string | URL,
				...rest: unknown[]
			) {
				return (open as (...args: unknown[]) => void).call(
					this, method, onOwnOrigin(String(url)), ...rest);
			} as typeof XMLHttpRequest.prototype.open;
		});
	}

	const sendBeacon = navigator.sendBeacon;
	if (typeof sendBeacon === 'function') {
		patch(() => {
			navigator.sendBeacon = function (this: Navigator, url: string | URL, data?: BodyInit | null) {
				return sendBeacon.call(this, onOwnOrigin(String(url)), data);
			};
		});
	}
}

/**
 * A page is free to freeze its own globals, and some libraries do. Then this rewriting is not
 * available for that one api — and nothing else about the agent may go with it: the picker, the
 * console, the shortcuts and every mcp tool are installed after this.
 */
function patch(install: () => void): void {
	try {
		install();
	} catch {
		// That api stays as the page left it.
	}
}

function schemeOf(origin: string): string {
	const at = origin.indexOf(':');
	return at === -1 ? '' : origin.slice(0, at + 1);
}
