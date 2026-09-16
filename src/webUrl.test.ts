/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { addDefaultScheme, hasKnownScheme, localHosts, normalizeAddress } from './webUrl.ts';

suite('hasKnownScheme', () => {

	test('recognises the schemes a browser takes', () => {
		for (const input of ['http://a', 'https://a', 'file:///x', 'HTTPS://A', 'about:blank']) {
			assert.ok(hasKnownScheme(input), input);
		}
	});

	test('a host and port is not a scheme', () => {
		// The trap this module exists for: `localhost:3000` matches
		// `^[a-z][a-z0-9+.-]*:` exactly as a scheme does, so a syntactic check
		// leaves it alone and the browser is handed something it cannot open.
		for (const input of ['localhost:3000', 'example.com:8080', 'myhost:1']) {
			assert.ok(!hasKnownScheme(input), input);
		}
	});

	test('an unknown scheme is not known', () => {
		assert.ok(!hasKnownScheme('gopher://a'));
	});
});

suite('localHosts', () => {

	test('carries the bracketed IPv6 spellings', () => {
		// `URL.hostname` returns an IPv6 authority *with* its brackets, so a bare
		// `::1` in this set would never match anything. It is shared with the
		// external URI opener in `extension.ts`, so getting it wrong would make
		// the opener claim a host whose typed form then cannot connect.
		for (const host of ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]',
			'[0:0:0:0:0:0:0:1]', '[0:0:0:0:0:0:0:0]']) {
			assert.ok(localHosts.has(host), host);
		}
		assert.ok(!localHosts.has('::1'), 'an unbracketed IPv6 form would never match');
	});
});

suite('addDefaultScheme', () => {

	test('https for an ordinary host', () => {
		assert.strictEqual(addDefaultScheme('example.com'), 'https://example.com');
		assert.strictEqual(addDefaultScheme('example.com/a/b?q=1'), 'https://example.com/a/b?q=1');
	});

	test('http for localhost-like hosts, with or without a port', () => {
		// A dev server on localhost almost never speaks https, and those are the
		// addresses this extension exists to open.
		assert.strictEqual(addDefaultScheme('localhost:3000'), 'http://localhost:3000');
		assert.strictEqual(addDefaultScheme('localhost'), 'http://localhost');
		assert.strictEqual(addDefaultScheme('127.0.0.1:8080/app'), 'http://127.0.0.1:8080/app');
		assert.strictEqual(addDefaultScheme('0.0.0.0:5173'), 'http://0.0.0.0:5173');
	});

	test('the bracketed IPv6 forms match', () => {
		// `URL.hostname` returns an IPv6 authority *with* its brackets, so the
		// set has to hold the bracketed spelling or none of these ever match.
		assert.strictEqual(addDefaultScheme('[::1]:3000'), 'http://[::1]:3000');
		assert.strictEqual(addDefaultScheme('[::]:3000'), 'http://[::]:3000');
	});

	test('a host that only looks local still gets https', () => {
		assert.strictEqual(addDefaultScheme('localhost.example.com'), 'https://localhost.example.com');
		assert.strictEqual(addDefaultScheme('127.0.0.2'), 'https://127.0.0.2');
	});
});

suite('normalizeAddress', () => {

	test('leaves an address that already has a scheme alone', () => {
		assert.strictEqual(normalizeAddress('http://localhost:3000/a'), 'http://localhost:3000/a');
		assert.strictEqual(normalizeAddress('https://example.com'), 'https://example.com');
		assert.strictEqual(normalizeAddress('file:///tmp/a.html'), 'file:///tmp/a.html');
	});

	test('trims, so a pasted address with spaces around it still opens', () => {
		assert.strictEqual(normalizeAddress('  example.com  '), 'https://example.com');
	});

	test('supplies the scheme that was missing', () => {
		assert.strictEqual(normalizeAddress('example.com/a'), 'https://example.com/a');
		assert.strictEqual(normalizeAddress('localhost:3000'), 'http://localhost:3000');
	});

	test('is idempotent, so a second pass through changes nothing', () => {
		// Both the status bar prompt and `aiBrowser.show` normalise, and the
		// first calls the second.
		for (const input of ['example.com', 'localhost:3000', 'https://a.b/c']) {
			const once = normalizeAddress(input);
			assert.ok(once);
			assert.strictEqual(normalizeAddress(once), once, input);
		}
	});

	test('an unknown scheme is handed on, never prefixed', () => {
		// `https://` + `ws://localhost:8080` parses — hostname `ws` — so the
		// parse check let the mangled form through and the browser silently
		// opened nonsense. Anything carrying `scheme://` is left alone.
		assert.strictEqual(normalizeAddress('ws://localhost:8080'), 'ws://localhost:8080');
		assert.strictEqual(normalizeAddress('chrome-extension://abc/x'), 'chrome-extension://abc/x');
		assert.strictEqual(normalizeAddress('gopher://a'), 'gopher://a');
	});

	test('a path is refused rather than turned into a host', () => {
		// Every one of these parses once `https://` is in front of it, which is
		// why the parse check alone was not enough: `/Users/m5/x.html` became
		// `https:///Users/m5/x.html` and `./rel.html` became `https://./rel.html`.
		for (const input of ['/Users/m5/x.html', './rel.html', '../up.html', '//example.com']) {
			assert.strictEqual(normalizeAddress(input), undefined, input);
		}
	});

	test('a Windows drive letter is not a scheme', () => {
		// `C:` matches `scheme:` syntactically, and prefixing produced
		// `https://c/dev/index.html` — a valid URL pointing at a host named `c`.
		assert.strictEqual(normalizeAddress('C:\\dev\\index.html'), undefined);
		assert.strictEqual(normalizeAddress('C:/dev/index.html'), undefined);
		assert.strictEqual(normalizeAddress('d:\\x'), undefined);
	});

	test('a host is required, not merely a parseable URL', () => {
		// `https://?q=1` is a URL and has no host.
		assert.strictEqual(normalizeAddress('?q=1'), undefined);
		assert.strictEqual(normalizeAddress('#frag'), undefined);
	});

	test('refuses what cannot become an address', () => {
		// Prefixing a scheme onto anything yields a string that looks like a URL
		// and is not; opening it is a broken tab instead of an answer.
		for (const input of ['', '   ', 'hello world', 'https://']) {
			assert.strictEqual(normalizeAddress(input), undefined, JSON.stringify(input));
		}
	});
});
