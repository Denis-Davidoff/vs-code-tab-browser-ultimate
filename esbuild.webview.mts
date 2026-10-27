/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as esbuild from 'esbuild';
import * as path from 'node:path';

const rootDir = import.meta.dirname;
const srcDir = path.join(rootDir, 'preview-src');
const outDir = path.join(rootDir, 'media');

const args = process.argv.slice(2);
const isWatch = args.includes('--watch');

const options = {
	entryPoints: {
		// Script running inside the webview panel.
		'index': path.join(srcDir, 'index.ts'),
		// Script running inside the chat view. Same CSP rules as the panel, so
		// the same `iife` format.
		'chat': path.join(srcDir, 'chat.ts'),
		// Codicon font, referenced by the panel html. The `.ttf` is inlined as a
		// data uri because the panel's CSP only allows `font-src data:`.
		'codicon': path.join(rootDir, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'),
		// xterm's stylesheet, loaded by the chat view's own `<link>`. An entry of its
		// own, never `import 'xterm.css'` from `chat.ts`: esbuild would then write
		// `media/chat.css` for the `chat` entry over the checked-in stylesheet.
		'xterm': path.join(rootDir, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'),
	},
	// The terminal tabs exist in the editor's chat view only. The Chrome side panel and
	// the Exchange website build the same `chat.ts` with this `false`, which removes
	// xterm from their bundle (`scripts/build-chrome.mjs`, `exchange-server/scripts/build-chat.mjs`).
	define: { __TERMINAL__: 'true' },
	bundle: true,
	// Loaded via a plain `<script>` tag, so it must not be an ES module.
	format: 'iife' as const,
	platform: 'browser' as const,
	target: 'es2022',
	outdir: outDir,
	// `.csv` as text: the chat's icon picker reads the codicon list (codicon.csv).
	loader: { '.ttf': 'dataurl' as const, '.csv': 'text' as const },
	minify: !isWatch,
	sourcemap: true,
	logLevel: 'info' as const,
};

if (isWatch) {
	const ctx = await esbuild.context(options);
	await ctx.watch();
} else {
	await esbuild.build(options);
}
