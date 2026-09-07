/*---------------------------------------------------------------------------------------------
 *  Cookie names and attributes as they have to look on the proxy's own origin.
 *
 *  Two places rewrite cookies and they have to agree, or a cookie set by a script would not
 *  survive what the server sets and the other way round: `src/browserProxy.ts` rewrites the
 *  `Set-Cookie` headers it forwards, and `page-src/cookies.ts` the writes a page makes through
 *  `document.cookie`.
 *
 *  Two things are rewritten. The name carries the session's prefix, because cookie jars are
 *  keyed by host and not by port, so every site served through the proxy shares one jar. And
 *  the attributes that name a *different* origin than the one the browser sees are dropped:
 *  the proxy is plain http on `127.0.0.1`, so `Domain=localhost`, `Secure` and
 *  `SameSite=None` do not describe it, and a browser that is told them stores nothing at all.
 *--------------------------------------------------------------------------------------------*/

/** `sid=1; Path=/` -> `__tb54321_sid=1; Path=/`. The page hides the prefix again. */
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
	return cookie
		.split(';')
		.filter(part => {
			const name = part.trim().toLowerCase();
			return !name.startsWith('domain=')
				&& name !== 'secure'
				&& name !== 'partitioned';
		})
		.map(part => (/^\s*samesite\s*=\s*none\s*$/i.test(part) ? ' SameSite=Lax' : part))
		.join(';');
}

/** A cookie the proxy hands to the browser: prefixed, and about the origin it is served from. */
export function rewriteSetCookie(cookie: string, prefix: string): string {
	return rewriteCookieAttributes(prefixCookie(cookie, prefix));
}
