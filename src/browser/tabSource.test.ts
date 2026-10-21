import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind } from 'typescript';

for (const mode of ['absent', 'denied'] as const) {
	test(`Chrome tabs work when the native browser API is ${mode}`, async () => {
		const window = mode === 'absent' ? {} : Object.defineProperties({},
			Object.fromEntries(['browserTabs', 'activeBrowserTab', 'onDidOpenBrowserTab', 'onDidCloseBrowserTab',
				'onDidChangeActiveBrowserTab', 'onDidChangeBrowserTabState'].map(key => [key, {
				get() { throw new Error('CANNOT use API proposal'); },
			}])));
		class Disposable { dispose() {} static from() { return new Disposable(); } }
		const event = () => new Disposable();
		const page = { url: 'https://example.com' };
		const chrome = {
			connected: false, tabs: [] as unknown[], onDidOpenTab: event, onDidCloseTab: event,
			onDidChangeActiveTab: event, onDidChangeTabState: event,
			async openTab(url: string) { assert.equal(url, page.url); return page; },
		};
		const exports: { tabs?: { available(): boolean; readonly all: unknown[]; readonly active: unknown; onDidOpen(fn: () => void): unknown; open(url: string): Promise<unknown> } } = {};
		const code = transpileModule(readFileSync('src/browser/tabSource.ts', 'utf8'), {
			compilerOptions: { module: ModuleKind.CommonJS },
		}).outputText;
		runInNewContext(code, { exports, require(name: string) {
			if (name === 'vscode') { return { window, Disposable }; }
			if (name === '../setup/proposedApi') { return { isBrowserApiGranted() {
				try { return (window as { browserTabs?: unknown }).browserTabs !== undefined; } catch { return false; }
			} }; }
			if (name === './chromeBrowser') { return { chrome, ChromeTab: class {} }; }
			throw new Error(name);
		} });
		const tabs = exports.tabs!;
		assert.equal(tabs.available(), false);
		assert.equal(tabs.all.length, 0);
		assert.equal(tabs.active, undefined);
		tabs.onDidOpen(() => {});
		chrome.connected = true;
		chrome.tabs.push(page);
		assert.equal(tabs.available(), true);
		assert.equal(tabs.all[0], page);
		assert.equal(await tabs.open(page.url), page);
	});
}
