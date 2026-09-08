/*---------------------------------------------------------------------------------------------
 *  Cookie names and attributes as they have to look on the proxy's own origin.
 *
 *  Two places rewrite cookies and they have to agree, or a cookie set by a script would not
 *  survive what the server sets and the other way round: `src/browserProxy.ts` rewrites the
 *  `Set-Cookie` headers it forwards, and `page-src/cookies.ts` the writes a page makes through
 *  `document.cookie`.
 *
 *  Two things are rewritten.
 *
 *  **The name carries the session's prefix**, because cookie jars are keyed by host and not by
 *  port, so every site served through the proxy shares one jar.
 *
 *  **And the attributes are the ones a cookie needs in a frame**, which is where the panel's
 *  page lives: the top-level document is the editor's webview, so as far as the browser is
 *  concerned the page is a third party in somebody else's site. A cookie without
 *  `SameSite=None; Secure` is then not merely withheld from the next request — it is not
 *  stored at all, and a login cannot be completed inside the panel because the csrf cookie
 *  never exists. So `SameSite` is forced to `None` and `Secure` is added, rather than the
 *  other way round: `Secure` costs nothing over `http://127.0.0.1`, which the browser counts
 *  as a trustworthy origin.
 *
 *  What `SameSite=None` gives up is taken back on the way *upstream*, and not by the prefix
 *  above — the prefixed names are exactly the ones the proxy restores. A cookie that is sent
 *  with every cross-site request is an invitation for any page the panel has visited to post
 *  to this port with the session behind it, so `BrowserProxy._fromOwnPage` forwards cookies
 *  only for a request one of this session's own documents made. That is the check `SameSite`
 *  would have made in the browser, made here instead because the browser cannot make it for a
 *  page it has as a third party.
 *
 *  `Domain` is still dropped, since it names a host the browser does not have the page from.
 *--------------------------------------------------------------------------------------------*/

/** `sid=1; Path=/` -> `__tb1f3a9c2b_sid=1; Path=/`. The page hides the prefix again. */
export function prefixCookie(cookie: string, prefix: string): string {
	const separator = cookie.indexOf('=');
	if (separator === -1) {
		return cookie;
	}
	const name = cookie.slice(0, separator).trim();
	if (!name || name.startsWith(prefix)) {
		return cookie;
	}
	return `${prefix}${name}=${cookie.slice(separator + 1)}`;
}

/** The same cookie, described in terms of the origin the browser actually has it from. */
export function rewriteCookieAttributes(cookie: string): string {
	const parts = cookie
		.split(';')
		.filter(part => {
			const name = part.trim().toLowerCase();
			return !name.startsWith('domain=')
				&& !name.startsWith('samesite=')
				&& name !== 'secure'
				// Partitioned would key the cookie to the top-level site, which is a webview
				// whose identity is not the panel's to keep.
				&& name !== 'partitioned';
		});

	return [...parts, ' SameSite=None', ' Secure'].join(';');
}

/** A cookie the proxy hands to the browser: prefixed, and about the origin it is served from. */
export function rewriteSetCookie(cookie: string, prefix: string): string {
	return rewriteCookieAttributes(prefixCookie(cookie, prefix));
}

/**
 * The prefix a session's cookies carry, from the origin it serves and *not* from its port: a
 * port is handed out again on every restart, and a cookie name that changes with it is a
 * session the user has to log into again every morning. Cookies ignore ports, so the name is
 * the only thing keeping two proxied sites apart — and it has to be the same name tomorrow.
 */
export function cookiePrefixFor(key: string): string {
	// FNV-1a, because what is needed is a short stable name and nothing else.
	let hash = 0x811c9dc5;
	for (let at = 0; at < key.length; at++) {
		hash ^= key.charCodeAt(at);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `__tb${hash.toString(16).padStart(8, '0')}_`;
}
