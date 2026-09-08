/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onceDocumentLoaded } from './events';
import {
	BROWSER_SEARCH_ENGINES,
	BROWSER_SEARCH_NONE,
	BrowserSearchEngineValue,
	buildSearchUrl,
	hasKnownScheme,
	resolveAddressBarInputType,
} from './browserSearch';

interface AIBrowserSettings {
	readonly url: string;
	readonly focusLockEnabled: boolean;
	readonly searchEngine: BrowserSearchEngineValue;
}

interface AIBrowserState {
	readonly url: string;
}

interface OpenExternalMessage {
	readonly type: 'openExternal';
	readonly url: string;
}

type ExtensionToWebviewMessage =
	| { readonly type: 'focus' }
	| { readonly type: 'didChangeFocusLockIndicatorEnabled'; readonly focusLockEnabled: boolean };

interface VsCodeApi<State, Message> {
	setState(state: State): void;
	postMessage(message: Message): void;
}

declare function acquireVsCodeApi(): VsCodeApi<AIBrowserState, OpenExternalMessage>;

const vscode = acquireVsCodeApi();

function isAIBrowserSettings(value: unknown): value is AIBrowserSettings {
	return typeof value === 'object'
		&& value !== null
		&& 'url' in value
		&& typeof value.url === 'string'
		&& 'focusLockEnabled' in value
		&& typeof value.focusLockEnabled === 'boolean'
		&& 'searchEngine' in value
		&& isBrowserSearchEngineValue(value.searchEngine);
}

/**
 * Hosts that get `http` rather than `https` when the user types an address
 * without a scheme. Mirrors `enabledHosts` in `src/extension.ts`; the IPv6
 * forms are bracketed because that is what `URL.hostname` returns.
 */
const localhostHosts = new Set<string>([
	'localhost',
	'127.0.0.1',
	'[0:0:0:0:0:0:0:1]',
	'[::1]',
	'0.0.0.0',
	'[0:0:0:0:0:0:0:0]',
	'[::]'
]);

function isBrowserSearchEngineValue(value: unknown): value is BrowserSearchEngineValue {
	return value === BROWSER_SEARCH_NONE
		|| BROWSER_SEARCH_ENGINES.some(e => e.id === value);
}

function isExtensionToWebviewMessage(value: unknown): value is ExtensionToWebviewMessage {
	return typeof value === 'object'
		&& value !== null
		&& 'type' in value
		&& (value.type === 'focus'
			|| (value.type === 'didChangeFocusLockIndicatorEnabled'
				&& 'focusLockEnabled' in value
				&& typeof value.focusLockEnabled === 'boolean'));
}

function getSettings(): AIBrowserSettings {
	const element = document.getElementById('ai-browser-settings');
	if (element) {
		const data = element.getAttribute('data-settings');
		if (data) {
			const settings: unknown = JSON.parse(data);
			if (isAIBrowserSettings(settings)) {
				return settings;
			}
		}
	}

	throw new Error(`Could not load settings`);
}

const settings = getSettings();

const iframe = document.querySelector('iframe')!;
const header = document.querySelector('.header')!;
const input = header.querySelector<HTMLInputElement>('.url-input')!;
const forwardButton = header.querySelector<HTMLButtonElement>('.forward-button')!;
const backButton = header.querySelector<HTMLButtonElement>('.back-button')!;
const reloadButton = header.querySelector<HTMLButtonElement>('.reload-button')!;
const openExternalButton = header.querySelector<HTMLButtonElement>('.open-external-button')!;

window.addEventListener('message', e => {
	const message: unknown = e.data;
	if (!isExtensionToWebviewMessage(message)) {
		return;
	}

	switch (message.type) {
		case 'focus':
			{
				iframe.focus();
				break;
			}
		case 'didChangeFocusLockIndicatorEnabled':
			{
				toggleFocusLockIndicatorEnabled(message.focusLockEnabled);
				break;
			}
	}
});

onceDocumentLoaded(() => {
	setInterval(() => {
		const iframeFocused = document.activeElement?.tagName === 'IFRAME';
		document.body.classList.toggle('iframe-focused', iframeFocused);
	}, 50);

	iframe.addEventListener('load', () => {
		// Noop
	});

	input.addEventListener('change', e => {
		const target = resolveAddressBarInput((e.target as HTMLInputElement).value);
		if (target !== undefined) {
			navigateTo(target);
		}
	});

	forwardButton.addEventListener('click', () => {
		history.forward();
	});

	backButton.addEventListener('click', () => {
		history.back();
	});

	openExternalButton.addEventListener('click', () => {
		vscode.postMessage({
			type: 'openExternal',
			url: input.value
		});
	});

	reloadButton.addEventListener('click', () => {
		// This does not seem to trigger what we want
		// history.go(0);

		// This incorrectly adds entries to the history but does reload
		// It also always incorrectly always loads the value in the input bar,
		// which may not match the current page if the user has navigated
		navigateTo(input.value);
	});

	navigateTo(settings.url);
	input.value = settings.url;

	toggleFocusLockIndicatorEnabled(settings.focusLockEnabled);

	/**
	 * Turns whatever was typed in the address bar into something navigable:
	 * a URL is used as-is (with a scheme filled in when it is missing), and
	 * anything that reads as a search term goes to the configured engine.
	 * Returns `undefined` when there is nothing to navigate to — an empty
	 * input, or a search term while search is disabled.
	 */
	function resolveAddressBarInput(rawInput: string): string | undefined {
		const trimmed = rawInput.trim();
		switch (resolveAddressBarInputType(trimmed)) {
			case 'empty':
				return undefined;
			case 'url':
				// Scheme-less input such as `example.com` would otherwise be
				// resolved against the webview's own origin. Note this cannot
				// be a plain `scheme:` regex check: in `localhost:3000` the
				// part before the colon is a host, not a scheme.
				return hasKnownScheme(trimmed) ? trimmed : addDefaultScheme(trimmed);
			// 'unknown' is ambiguous (intranet host or a new TLD); Chromium's
			// omnibox defaults it to search, and so do we.
			case 'query':
			case 'unknown':
				return searchFor(trimmed);
		}
	}

	/**
	 * Prefixes scheme-less input with a scheme, picking `http` for
	 * localhost-like hosts the way browsers do — a dev server on
	 * `localhost:3000` almost never speaks https, and this extension exists
	 * largely to open exactly those.
	 */
	function addDefaultScheme(hostAndRest: string): string {
		const asHttps = `https://${hostAndRest}`;
		try {
			return localhostHosts.has(new URL(asHttps).hostname)
				? `http://${hostAndRest}`
				: asHttps;
		} catch {
			return asHttps;
		}
	}

	function searchFor(query: string): string | undefined {
		if (settings.searchEngine === BROWSER_SEARCH_NONE) {
			return undefined;
		}

		const engine = BROWSER_SEARCH_ENGINES.find(e => e.id === settings.searchEngine)
			?? BROWSER_SEARCH_ENGINES[0];
		return buildSearchUrl(query, engine.id);
	}

	function navigateTo(rawUrl: string): void {
		try {
			const url = new URL(rawUrl);

			// Try to bust the cache for the iframe
			// There does not appear to be any way to reliably do this except modifying the url
			const existing = new URLSearchParams(location.search);
			url.searchParams.append('id', existing.get('id')!);
			url.searchParams.append('vscodeBrowserReqId', Date.now().toString());

			iframe.src = url.toString();
		} catch {
			iframe.src = rawUrl;
		}

		vscode.setState({ url: rawUrl });
	}
});

function toggleFocusLockIndicatorEnabled(enabled: boolean) {
	document.body.classList.toggle('enable-focus-lock-indicator', enabled);
}

