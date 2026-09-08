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
		// Codicon font, referenced by the panel html. The `.ttf` is inlined as a
		// data uri because the panel's CSP only allows `font-src data:`.
		'codicon': path.join(rootDir, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'),
	},
	bundle: true,
	// Loaded via a plain `<script>` tag, so it must not be an ES module.
	format: 'iife' as const,
	platform: 'browser' as const,
	target: 'es2022',
	outdir: outDir,
	loader: { '.ttf': 'dataurl' as const },
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
