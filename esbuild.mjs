import * as esbuild from 'esbuild';
import { mkdir } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const shared = {
	bundle: true,
	sourcemap: !production,
	minify: production,
	logLevel: 'info',
};

const builds = [
	{
		...shared,
		entryPoints: ['src/extension.ts'],
		outfile: 'out/extension.js',
		platform: 'node',
		format: 'cjs',
		target: 'node18',
		external: ['vscode'],
	},
	{
		...shared,
		entryPoints: ['preview-src/index.ts'],
		outfile: 'media/index.js',
		platform: 'browser',
		format: 'iife',
		target: 'es2020',
	},
	{
		// Injected into every page the proxy serves; not loaded by the webview itself.
		...shared,
		entryPoints: ['page-src/agent.ts'],
		outfile: 'media/agent.js',
		platform: 'browser',
		format: 'iife',
		target: 'es2019',
	},
	{
		// Inline codicon.ttf as a data uri so the webview CSP only needs `font-src data:`,
		// matching how the bundled extension is built.
		...shared,
		entryPoints: ['node_modules/@vscode/codicons/dist/codicon.css'],
		outfile: 'media/codicon.css',
		loader: { '.ttf': 'dataurl' },
	},
];

await mkdir('media', { recursive: true });

if (watch) {
	await Promise.all(builds.map(async config => {
		const ctx = await esbuild.context(config);
		await ctx.watch();
	}));
} else {
	await Promise.all(builds.map(config => esbuild.build(config)));
}
