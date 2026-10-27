import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// A build that bundles `chat.ts` with no `__TERMINAL__` define throws a ReferenceError the moment
// the chat starts, which blanks the whole view. These are the three builds that do.
const builds: readonly (readonly [string, string])[] = [
	['esbuild.webview.mts', "__TERMINAL__: 'true'"],
	// Chrome's side panel and the Exchange website show the editor's shared terminals (preview-src/remoteTerminal.ts).
	['scripts/build-chrome.mjs', "__TERMINAL__: 'true'"],
	['exchange-server/scripts/build-chat.mjs', "__TERMINAL__:'true'"],
];

test('every build of the chat defines __TERMINAL__ true', () => {
	for (const [file, define] of builds) {
		assert.ok(readFileSync(file, 'utf8').includes(define), `${file} defines ${define}`);
	}
});

test('xterm\'s stylesheet is an entry of its own, never imported by the chat script', () => {
	assert.match(readFileSync('esbuild.webview.mts', 'utf8'), /'xterm': path\.join\(rootDir, 'node_modules', '@xterm', 'xterm', 'css', 'xterm\.css'\)/);
	assert.match(readFileSync('scripts/build-chrome.mjs', 'utf8'), /xterm: `\$\{source\}\.\.\/node_modules\/@xterm\/xterm\/css\/xterm\.css`/);
	assert.match(readFileSync('chrome-extension/sidepanel.html', 'utf8'), /<link rel="stylesheet" href="xterm\.css">\s*<link rel="stylesheet" href="chat\.css">/);
	// An imported stylesheet makes esbuild write media/chat.css for the `chat` entry, over the checked-in one.
	for (const file of ['preview-src/chat.ts', 'preview-src/terminalView.ts']) {
		assert.doesNotMatch(readFileSync(file, 'utf8'), /import\s+['"][^'"]*\.css['"]/, file);
	}
});

test('xterm is reached only through the guarded dynamic import', () => {
	const chat = readFileSync('preview-src/chat.ts', 'utf8');
	// `import type` is erased; a value import would keep xterm in the remote bundles.
	assert.ok(!/^import (?!type\b)[^\n]*from '(@xterm[^']*|\.\/terminalView)'/m.test(chat), 'no static import of xterm or the terminal view');
	assert.ok(/if \(__TERMINAL__\) \{\n\t\tif \(!terminalView && !terminalLoading[\s\S]*?import\('\.\/terminalView'\)/.test(chat), 'the import() sits in a positive if');
	assert.ok(!chat.includes('typeof __TERMINAL__'), 'typeof is not folded unminified: use the positive if');
});
