/*---------------------------------------------------------------------------------------------
 *  Hides the proxy's cookie prefix from the page.
 *
 *  Cookie jars are keyed by host, not by port, so every site served through the proxy would
 *  share one jar. The proxy therefore prefixes the name of every cookie it hands to the browser
 *  and drops the ones that are not its own on the way back. This shim keeps that invisible to
 *  the page's own scripts: `document.cookie` reads and writes the names the server used.
 *
 *  A write also goes through the same attribute rewriting as a `Set-Cookie` header, and for the
 *  same reason: a page that says `Domain=localhost` or `Secure` is describing the server it
 *  thinks it is talking to, not the plain http `127.0.0.1` origin the browser has it from, and
 *  a browser told that stores nothing at all — the write would simply be lost.
 *--------------------------------------------------------------------------------------------*/

import { prefixCookie, rewriteCookieAttributes } from '../shared/cookies';

export function installCookiePrefix(prefix: string): void {
	if (!prefix) {
		return;
	}

	const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
	const read = descriptor?.get;
	const write = descriptor?.set;
	if (!read || !write) {
		return;
	}

	Object.defineProperty(document, 'cookie', {
		configurable: true,
		enumerable: true,
		get(): string {
			return String(read.call(document))
				.split(';')
				.map(part => part.trim())
				.filter(part => part.startsWith(prefix))
				.map(part => part.slice(prefix.length))
				.join('; ');
		},
		set(value: string) {
			write.call(document, rewriteCookieAttributes(prefixCookie(String(value), prefix)));
		},
	});
}
