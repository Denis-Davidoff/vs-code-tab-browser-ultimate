/*---------------------------------------------------------------------------------------------
 *  Hides the proxy's cookie prefix from the page.
 *
 *  Cookie jars are keyed by host, not by port, so every site served through the proxy would
 *  share one jar. The proxy therefore prefixes the name of every cookie it hands to the browser
 *  and drops the ones that are not its own on the way back. This shim keeps that invisible to
 *  the page's own scripts: `document.cookie` reads and writes the names the server used.
 *--------------------------------------------------------------------------------------------*/

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
			write.call(document, addPrefix(String(value), prefix));
		},
	});
}

/** `sid=1; path=/` -> `__tb54321_sid=1; path=/`, leaving the value and attributes alone. */
function addPrefix(cookie: string, prefix: string): string {
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
