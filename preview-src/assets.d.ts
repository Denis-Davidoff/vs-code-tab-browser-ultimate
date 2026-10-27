/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** A `.csv` bundled as text by esbuild (`loader: { '.csv': 'text' }` in esbuild.webview.mts). */
declare module '*.csv' {
	const text: string;
	export default text;
}

/**
 * `true` in the editor's chat view, `false` in the Chrome side panel and the
 * Exchange website (an esbuild `define` in `esbuild.webview.mts`,
 * `scripts/build-chrome.mjs` and `exchange-server/scripts/build-chat.mjs`): the
 * terminal tabs exist in the editor only, and a `false` removes xterm from the
 * bundle. Use it bare, in a positive `if (__TERMINAL__) { … }`: esbuild drops
 * that branch even unminified, which an early return or a `typeof` guard does
 * not. A build with no define throws a ReferenceError at startup, so
 * `terminalBuild.test.ts` checks that all three have it.
 */
declare const __TERMINAL__: boolean;
