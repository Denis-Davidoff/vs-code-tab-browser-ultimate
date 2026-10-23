import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

function fixture() {
 const listeners = new Map<string, (event: any) => void>();
 const socket = { readyState: 1, bufferedAmount: 0, send() {}, close() {}, addEventListener(name: string, listener: (event: any) => void) { listeners.set(name, listener); } };
 let tabs = [{ id: 'a', title: 'A', url: 'https://a.test', kind: 'chrome' }, { id: 'b', title: 'B', url: 'https://b.test', kind: 'vscode' }];
 const context: any = { exports: {}, setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {}, require(name: string) {
  return name.includes('exchangeCrypto') ? { encryptedExchangeSocket: () => socket } : { isExchangeControlPage: () => false, readRemoteBrowserInput: (input: unknown) => input };
 } };
 const source = readFileSync('src/browser/exchangeBrowser.ts', 'utf8');
 runInNewContext(transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText, context);
 const browser = new context.exports.ExchangeBrowser('https://exchange.test', 'workspace', 'key', { async remoteTabs() { return tabs; }, async remoteStream() { return { dispose() {} }; } });
 const notifications: unknown[] = [];
 browser.onPage = () => notifications.push(browser.selectedPage()?.id ?? null);
 function message(value: unknown) { listeners.get('message')!({ data: JSON.stringify(value) }); }
 async function action(action: string, tabId?: string) { message({ type: 'browser.command', id: 'command', action, tabId }); await browser.chain; }
 message({ type: 'ready' });
 return { browser, notifications, message, action, listeners, setTabs(next: typeof tabs) { tabs = next; } };
}

test('page suggestions follow selection, pause, viewers and disconnect without chat activity', async () => {
 const f = fixture();
 f.message({ type: 'browser.viewers', active: true }); await f.browser.chain;
 await f.action('select', 'a'); await f.action('select', 'b');
 assert.deepEqual(f.notifications, ['a', 'b']);
 await f.action('pause'); assert.deepEqual(f.notifications, ['a', 'b', null]);
 await f.action('select', 'a');
 f.message({ type: 'browser.viewers', active: false });
 assert.equal(f.notifications.at(-1), null);
 f.message({ type: 'browser.viewers', active: true }); await f.browser.chain;
 assert.equal(f.notifications.at(-1), 'a');
 f.listeners.get('close')!({ code: 4001 });
 assert.equal(f.notifications.at(-1), null);
});

test('page suggestions update on navigation and clear when the selected tab disappears', async () => {
 const f = fixture();
 f.message({ type: 'browser.viewers', active: true }); await f.browser.chain;
 await f.action('select', 'a');
 f.setTabs([{ id: 'a', title: 'New title', url: 'https://a.test/new', kind: 'chrome' }]);
 await f.browser.refresh();
 assert.equal(f.notifications.length, 2);
 assert.equal(f.browser.selectedPage().url, 'https://a.test/new');
 await f.browser.refresh(); assert.equal(f.notifications.length, 2, 'unchanged polls do not republish');
 f.setTabs([]); await f.browser.refresh();
 assert.equal(f.notifications.at(-1), null);
});
