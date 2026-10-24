import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

function fixture(streamPending=false) {
 const starts: string[] = [], disposed: string[] = [], finish: (() => void)[] = [];
 const listeners = new Map<string, (event: any) => void>();
 const socket = { readyState: 1, bufferedAmount: 0, send() {}, close() {}, addEventListener(name: string, listener: (event: any) => void) { listeners.set(name, listener); } };
 let tabs = [{ id: 'a', title: 'A', url: 'https://a.test', kind: 'chrome' }, { id: 'b', title: 'B', url: 'https://b.test', kind: 'vscode' }];
 const context: any = { exports: {}, Date: { now: () => Date.now() }, setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {}, require(name: string) {
  return name.includes('exchangeCrypto') ? { encryptedExchangeSocket: () => socket } : { isExchangeControlPage: () => false, readRemoteBrowserInput: (input: unknown) => input };
 } };
 const source = readFileSync('src/browser/exchangeBrowser.ts', 'utf8');
 runInNewContext(transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText, context);
 const browser = new context.exports.ExchangeBrowser('https://exchange.test', 'workspace', 'key', { async remoteTabs() { return tabs; }, async remoteStream(tabId:string) { starts.push(tabId); const stream={ dispose() { disposed.push(tabId); } }; if(streamPending)return new Promise(resolve=>finish.push(()=>resolve(stream)));return stream; }, async remoteInput(tabId:string,input:any) { notifications.push({tabId,input}); } });
 const notifications: unknown[] = [];
 browser.onPage = () => notifications.push(browser.selectedPage()?.id ?? null);
 function message(value: unknown) { listeners.get('message')!({ data: JSON.stringify(value) }); }
 async function action(action: string, tabId?: string) { message({ type: 'browser.command', id: 'command', action, tabId }); await browser.chain; }
 message({ type: 'ready' });
 return { browser, notifications, starts, disposed, finish, message, action, listeners, setTabs(next: typeof tabs) { tabs = next; } };
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

 test('selection and navigation commands are not blocked by pending preview startup',async()=>{
 const f=fixture(true);
 f.message({type:'browser.viewers',active:true});await f.browser.chain;
 await f.action('select','b');
 assert.equal(f.browser.selectedPage()?.id,'b');
 f.message({type:'browser.command',id:'navigate',action:'input',tabId:'b',input:{action:'navigate',url:'https://example.com'}});
 await f.browser.chain;
 assert.deepEqual(JSON.parse(JSON.stringify(f.notifications.at(-1))),{tabId:'b',input:{action:'navigate',url:'https://example.com'}});
 });

test('viewer counts include distinct connections and clear on disconnect',async()=>{
 const f=fixture();let changes=0;f.browser.onViewers=()=>changes++;
 f.message({type:'browser.viewers',active:true,count:2});await f.browser.chain;
 assert.equal(f.browser.viewerCount,2);
 f.message({type:'browser.viewers',active:true,count:1});await f.browser.chain;
 assert.equal(f.browser.viewerCount,1);
 f.listeners.get('close')!({code:4001});assert.equal(f.browser.viewerCount,0);assert.equal(changes,3);
});

test('a repeated selection or viewer notice does not start a second capture while one is starting',async()=>{
 const f=fixture(true);
 f.message({type:'browser.viewers',active:true});await f.browser.chain;
 await f.action('select','b');
 await f.action('select','b');
 f.message({type:'browser.viewers',active:true,count:2});await f.browser.chain;
 assert.deepEqual(f.starts,['b']);
 f.finish[0]();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(f.disposed,[]);
 await f.action('select','b');assert.deepEqual(f.starts,['b'],'a running preview is kept');
 await f.action('select','a');
 assert.deepEqual(f.starts,['b','a']);assert.deepEqual(f.disposed,['b']);
});

test('a start superseded while pending is disposed when it lands, and a failed start can be retried',async()=>{
 const f=fixture(true);
 f.message({type:'browser.viewers',active:true});await f.browser.chain;
 await f.action('select','a');await f.action('select','b');
 assert.deepEqual(f.starts,['a','b']);
 f.finish[0]();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(f.disposed,['a'],'the superseded start never becomes the active stream');
 f.finish[1]();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(f.disposed,['a']);
 f.message({type:'browser.viewers',active:false});assert.deepEqual(f.disposed,['a','b']);
});

test('a capture start that never settles does not block selecting the tab again',async()=>{
 const f=fixture(true);
 const realNow=Date.now;let clock=realNow();Date.now=()=>clock;
 try{
  f.message({type:'browser.viewers',active:true});await f.browser.chain;
  await f.action('select','b');await f.action('select','b');
  assert.deepEqual(f.starts,['b']);
  clock+=16_000;
  await f.action('select','b');
  assert.deepEqual(f.starts,['b','b'],'the stuck start is replaced');
  f.finish[0]();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.disposed,['b'],'the stuck start is disposed if it lands late');
 }finally{Date.now=realNow;}
});
