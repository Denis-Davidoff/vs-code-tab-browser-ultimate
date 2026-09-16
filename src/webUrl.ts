/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Turning what somebody typed into an address into something openable.
 * No imports at all, so `npm test` can load it.
 */

/**
 * Minimal `URL`, declared rather than imported.
 *
 * The base config's `lib` is `ES2022` with no `DOM`, so there is no ambient
 * `URL`; Node provides the global at runtime. `extension.ts` carries the same
 * declaration for the same reason. `declare` emits nothing, so this survives
 * Node's type stripping, which is what lets `npm test` load this file.
 */
declare class URL {
	constructor(input: string);
	hostname: string;
	protocol: string;
}

/**
 * Hosts this extension treats as a local dev server.
 *
 * Two questions are answered from it and they are deliberately the same
 * predicate: which URIs the external opener claims (`extension.ts`), and which
 * scheme-less addresses get `http` rather than `https` (below). Letting them
 * drift means the opener offers to open a host whose typed form then gets
 * `https` and cannot connect.
 *
 * The bracketed IPv6 forms are deliberate: `URL.hostname` returns an IPv6
 * authority with its brackets, so `::1` would never match.
 *
 * `preview-src/index.ts` carries a third copy, `localhostHosts`, and **that one
 * is genuinely unavoidable** — the webview is a separate bundle with its own
 * tsconfig and runtime, so nothing in `src/` can reach it. This module is a leaf
 * (no relative value imports, so `npm test` can load it), which constrains what
 * *it* may import and not who may import it — `extension.ts` imports from here.
 */
export const localHosts: ReadonlySet<string> = new Set([
	'localhost',
	// localhost IPv4
	'127.0.0.1',
	// localhost IPv6
	'[0:0:0:0:0:0:0:1]',
	'[::1]',
	// all interfaces IPv4
	'0.0.0.0',
	// all interfaces IPv6
	'[0:0:0:0:0:0:0:0]',
	'[::]',
]);

/**
 * Schemes that count as already being one.
 *
 * Mirrors `ALL_KNOWN_SCHEMES` in `preview-src/browserSearch.ts`. It is a list
 * and not a pattern because **a pattern gets `localhost:3000` wrong**: that
 * matches `^[a-z][a-z0-9+.-]*:` perfectly well, so a syntactic check reads
 * `localhost` as the scheme, leaves the input alone, and hands the browser an
 * address it cannot open. The whole point of this module is the case that trap
 * ruins.
 */
const knownSchemes: ReadonlySet<string> = new Set([
	'http', 'https', 'javascript',
	'file', 'ftp', 'ftps', 'about', 'data', 'view-source', 'mailto',
	'chrome', 'edge', 'vscode', 'vscode-insiders',
]);

const schemePattern = /^([a-z][a-z0-9+\-.]*):/i;

/** A scheme followed by `//`, which is unambiguous whether or not we know it. */
const authoritySchemePattern = /^[a-z][a-z0-9+\-.]*:\/\//i;

/** Whether the input already starts with a scheme we recognise. */
export function hasKnownScheme(input: string): boolean {
	const match = schemePattern.exec(input);
	return match !== null && knownSchemes.has(match[1].toLowerCase());
}

/** What follows the colon in `host:port` — a port, and then nothing or a path. */
const portPattern = /^\d+(?:$|[/?#])/;

/** `C:\` or `C:/` — a Windows drive, not a one-letter scheme. */
const windowsDrivePattern = /^[a-z]:[\\/]/i;

/**
 * Whether the input declares a scheme at all — known to us or not.
 *
 * Three questions, because one test cannot separate the cases:
 *
 * - `scheme://` is unambiguous. `ws://localhost:8080` is not in the known list,
 *   and prefixing produced `https://ws://localhost:8080`, which **parses** —
 *   hostname `ws` — so nothing downstream refused it and the browser silently
 *   opened nonsense.
 * - A scheme we know needs no separator: `mailto:`, `about:`, `data:`.
 * - An **opaque** scheme we do not know is the hard one, because `tel:+3612345`
 *   and `localhost:3000` have the identical shape `word:rest`. What separates
 *   them is the *rest*: a port is digits, optionally followed by a path, query
 *   or fragment. Anything else — `+3612345`, `?xt=urn:…`, `calendar.example/x`
 *   — is an opaque scheme, and prefixing it either mangled it
 *   (`https://magnet:?xt=…`) or made it unparseable and so refused outright.
 *
 * A one-letter "scheme" followed by a slash is excluded first: `C:\dev` is a
 * Windows drive, and reading it as a scheme would hand the browser a path it
 * cannot open instead of refusing it.
 */
function declaresScheme(input: string): boolean {
	if (windowsDrivePattern.test(input)) {
		return false;
	}
	if (authoritySchemePattern.test(input) || hasKnownScheme(input)) {
		return true;
	}
	const match = schemePattern.exec(input);
	return match !== null && !portPattern.test(input.slice(match[0].length));
}

/**
 * Whether scheme-less input can be read as `host[:port][/path]` at all.
 *
 * Needed because `new URL('https://' + input)` invents a host rather than
 * failing: `/Users/m5/x.html` became `https:///Users/m5/x.html`, `./rel.html`
 * became `https://./rel.html`, `//example.com` became `https:////example.com`
 * and `C:\dev\index.html` became `https://c/dev/index.html`. Every one of those
 * parses, so the parse check alone let all of them through.
 */
function looksLikeAuthority(input: string): boolean {
	// A path, not a host. A protocol-relative address is *not* in this set — it
	// is stripped of its leading `//` before we get here.
	if (/^[/.\\]/.test(input)) {
		return false;
	}
	// A Windows drive letter, not a scheme. `Open File` is the route for those.
	if (windowsDrivePattern.test(input)) {
		return false;
	}
	return true;
}

/**
 * Prefixes scheme-less input with a scheme.
 *
 * `https` everywhere except localhost-like hosts, which get `http` — a dev
 * server on `localhost:3000` almost never speaks https, and those are the
 * addresses this extension exists to open. `preview-src/index.ts` makes the same
 * `http`/`https` choice for the panel's address bar — but only that choice: it
 * still prefixes an unknown `scheme://`, which this module stopped doing, so the
 * two are no longer interchangeable.
 */
export function addDefaultScheme(input: string): string {
	const asHttps = `https://${input}`;
	try {
		return localHosts.has(new URL(asHttps).hostname) ? `http://${input}` : asHttps;
	} catch {
		return asHttps;
	}
}

/**
 * What to open for what somebody typed, or `undefined` if it cannot be made
 * into an address at all.
 *
 * Refusing is the point: prefixing a scheme onto anything at all yields a
 * string that *looks* like a URL and is not (`https://hello world`), and
 * handing that to the browser opens a broken tab rather than saying so.
 */
export function normalizeAddress(input: string): string | undefined {
	const trimmed = input.trim();
	if (!trimmed) {
		return undefined;
	}

	if (declaresScheme(trimmed)) {
		// Already an address of some kind. Returned untouched even when the
		// scheme is one we do not model — mangling it is strictly worse than
		// handing it on and letting the browser refuse it.
		return parses(trimmed) ? trimmed : undefined;
	}

	// A protocol-relative address is a real one missing only its scheme, and it is
	// what a copy out of HTML or Markdown looks like. `https://` + `//example.com`
	// does resolve correctly, but only by an accident of URL parsing — four
	// slashes collapse — so the slashes are dropped rather than relied upon. An
	// earlier pass grouped this with the genuinely broken cases and refused it,
	// losing an address that had always worked.
	const bare = trimmed.startsWith('//') ? trimmed.slice(2) : trimmed;

	if (!looksLikeAuthority(bare)) {
		return undefined;
	}

	const candidate = addDefaultScheme(bare);
	// Parsed *and* checked for a host: the parse alone answers "is this a URL",
	// which is not the question — `https://?q=1` is a URL with no host.
	try {
		return new URL(candidate).hostname ? candidate : undefined;
	} catch {
		return undefined;
	}
}

function parses(candidate: string): boolean {
	try {
		new URL(candidate);
		return true;
	} catch {
		return false;
	}
}
