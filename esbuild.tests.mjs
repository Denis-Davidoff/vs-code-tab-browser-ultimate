/*---------------------------------------------------------------------------------------------
 *  Builds the test bundles: the extension sources with `vscode` swapped for a stub, so they
 *  can run under plain node.
 *--------------------------------------------------------------------------------------------*/

import * as esbuild from 'esbuild';

const shared = {
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	logLevel: 'warning',
};

await Promise.all([
	esbuild.build({
		...shared,
		entryPoints: ['src/browserProxy.ts'],
		outfile: 'test/.bundles/proxy-bundle.mjs',
		alias: { vscode: './test/vscode-mock.mjs' },
	}),
	esbuild.build({
		...shared,
		entryPoints: ['src/extension.ts'],
		outfile: 'test/.bundles/extension-bundle.mjs',
		alias: { vscode: './test/vscode-stub-entry.mjs' },
	}),
	esbuild.build({
		...shared,
		entryPoints: ['src/tabBrowserView.ts'],
		outfile: 'test/.bundles/view-bundle.mjs',
		alias: { vscode: './test/vscode-stub-entry.mjs' },
	}),
	esbuild.build({
		...shared,
		entryPoints: ['src/mcpSetup.ts'],
		outfile: 'test/.bundles/mcp-setup-bundle.mjs',
		alias: { vscode: './test/vscode-stub-entry.mjs' },
	}),
	esbuild.build({
		...shared,
		entryPoints: ['src/mcpCheck.ts'],
		outfile: 'test/.bundles/mcp-check-bundle.mjs',
		alias: { vscode: './test/vscode-stub-entry.mjs' },
	}),
	esbuild.build({
		...shared,
		entryPoints: ['src/browserController.ts'],
		outfile: 'test/.bundles/controller-bundle.mjs',
		alias: { vscode: './test/vscode-stub-entry.mjs' },
	}),
	esbuild.build({
		...shared,
		entryPoints: ['src/mcpServer.ts'],
		outfile: 'test/.bundles/mcp-bundle.mjs',
		alias: { vscode: './test/vscode-stub-entry.mjs' },
	}),
	esbuild.build({
		...shared,
		entryPoints: ['src/assistants.ts'],
		outfile: 'test/.bundles/assistants-bundle.mjs',
		alias: { vscode: './test/vscode-stub-entry.mjs' },
	}),
	esbuild.build({
		...shared,
		entryPoints: ['src/terminalLinks.ts'],
		outfile: 'test/.bundles/terminal-links-bundle.mjs',
		alias: { vscode: './test/vscode-stub-entry.mjs' },
	}),
	esbuild.build({
		...shared,
		entryPoints: ['src/favicon.ts'],
		outfile: 'test/.bundles/favicon-bundle.mjs',
		alias: { vscode: './test/vscode-stub-entry.mjs' },
	}),
	// The webview's own script, driven by the host test in a fixture that stands in for the
	// panel: what it reports to the extension host depends on the order two events arrive in.
	esbuild.build({
		...shared,
		format: 'iife',
		platform: 'browser',
		target: 'es2020',
		entryPoints: ['preview-src/index.ts'],
		outfile: 'test/.bundles/webview-bundle.js',
	}),
	// Injected into a real page by the host test, which then picks an element through it.
	esbuild.build({
		...shared,
		format: 'iife',
		platform: 'browser',
		target: 'es2020',
		globalName: 'tabBrowserPage',
		entryPoints: ['page-src/selectors.ts'],
		outfile: 'test/.bundles/page-bundle.js',
	}),
	esbuild.build({
		...shared,
		format: 'iife',
		platform: 'browser',
		target: 'es2020',
		globalName: 'tabBrowserPageIcon',
		entryPoints: ['page-src/pageIcon.ts'],
		outfile: 'test/.bundles/page-icon-bundle.js',
	}),
	esbuild.build({
		...shared,
		format: 'iife',
		platform: 'browser',
		target: 'es2020',
		globalName: 'tabBrowserRequests',
		entryPoints: ['page-src/pageRequests.ts'],
		outfile: 'test/.bundles/page-requests-bundle.js',
	}),
	esbuild.build({
		...shared,
		format: 'iife',
		platform: 'browser',
		target: 'es2020',
		globalName: 'tabBrowserPicker',
		entryPoints: ['page-src/picker.ts'],
		outfile: 'test/.bundles/picker-bundle.js',
	}),
]);
