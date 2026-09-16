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
 * Hosts that get `http` rather than `https`.
 *
 * The bracketed IPv6 forms are deliberate: `URL.hostname` returns an IPv6
 * authority with its brackets, so `::1` would never match. The same set, in the
 * same spelling, is `enabledHosts` in `extension.ts` and `localhostHosts` in
 * `preview-src/index.ts` — three runtimes, no shared import possible.
 */
const localHosts: ReadonlySet<string> = new Set([
	'localhost',
	'127.0.0.1',
	'[0:0:0:0:0:0:0:1]',
	'[::1]',
	'0.0.0.0',
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

/** Whether the input already starts with a scheme we recognise. */
export function hasKnownScheme(input: string): boolean {
	const match = schemePattern.exec(input);
	return match !== null && knownSchemes.has(match[1].toLowerCase());
}

/**
 * Prefixes scheme-less input with a scheme.
 *
 * `https` everywhere except localhost-like hosts, which get `http` — a dev
 * server on `localhost:3000` almost never speaks https, and those are the
 * addresses this extension exists to open. `preview-src/index.ts` picks the
 * same way for the panel's address bar, so both halves behave alike.
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

	const candidate = hasKnownScheme(trimmed) ? trimmed : addDefaultScheme(trimmed);
	try {
		// Parsed, not pattern-matched: this is the only check that answers the
		// question the caller actually has — will the browser take it.
		new URL(candidate);
		return candidate;
	} catch {
		return undefined;
	}
}
