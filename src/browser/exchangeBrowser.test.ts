import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

function fixture(streamPending=false, videoMode?: 'supported'|'unsupported'|'failure',deviceIdentity=true) {
 const starts: string[] = [], disposed: string[] = [], finish: (() => void)[] = [];
 const encoders:any[]=[],videoAttempts:string[]=[];
 const sent:any[]=[],frames:((data:string,width:number,height:number)=>void)[]=[];
 const listeners = new Map<string, (event: any) => void>();
 const socket = { readyState: 1, bufferedAmount: 0, send(data:string) {sent.push(JSON.parse(data));}, close() {}, addEventListener(name: string, listener: (event: any) => void) { listeners.set(name, listener); } };
 let listingError: Error | undefined;
 let tabs = [{ id: 'a', title: 'A', url: 'https://a.test', kind: 'chrome' }, { id: 'b', title: 'B', url: 'https://b.test', kind: 'vscode' }];
 const context: any = { exports: {}, URL, Date: { now: () => Date.now() }, setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {}, require(name: string) {
  if(name==='node:crypto')return {createHash};
  if(name==='vscode')return {env:{machineId:'test-workstation'}};
  return name.includes('exchangeCrypto') ? { encryptedExchangeSocket: () => socket } : { isExchangeControlPage: () => false, readRemoteBrowserInput: (input: unknown) => input };
 } };
 const source = readFileSync('src/browser/exchangeBrowser.ts', 'utf8');
 runInNewContext(transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText, context);
 const browser = new context.exports.ExchangeBrowser('https://exchange.test', 'workspace', 'key', { ...(videoMode?{async remoteVideoEncoder(_tabId:string,output:Function,failed:Function){videoAttempts.push(_tabId);if(videoMode==='unsupported')throw new Error('Unsupported');const encoder={disposed:false,keys:0,failed,async push(_data:string,width:number,height:number){if(videoMode==='failure')throw new Error('Failed');output({codec:'avc1.420028',streamId:'stream-1',timestamp:100,key:true,data:'AAAAAQ==',width,height});},requestKeyframe(){this.keys++;},dispose(){this.disposed=true;}};encoders.push(encoder);return encoder;}}:{}), async remoteTabs() { if(listingError)throw listingError; return tabs; }, async remoteTab(id:string) { const tab=tabs.find(tab=>tab.id===id); if(!tab)throw new Error('Tab closed'); return tab; }, async remoteStream(tabId:string,frame:(data:string,width:number,height:number)=>void) { starts.push(tabId); frames.push(frame); const stream={ dispose() { disposed.push(tabId); } }; if(streamPending)return new Promise(resolve=>finish.push(()=>resolve(stream)));return stream; }, async remoteInput(tabId:string,input:any) { notifications.push({tabId,input}); } },undefined,deviceIdentity);
 const notifications: unknown[] = [];
 browser.onPage = () => notifications.push(browser.selectedPage()?.id ?? null);
 function message(value: unknown) { listeners.get('message')!({ data: JSON.stringify(value) }); }
 async function action(action: string, tabId?: string) { message({ type: 'browser.command', id: 'command', action, tabId }); await browser.chain; }
 message({ type: 'ready' });
 return { browser, notifications, starts, disposed, finish, message, action, listeners, sent, frames, socket, encoders, videoAttempts, setVideoMode(mode:typeof videoMode){videoMode=mode;}, setListingError(error?:Error) { listingError=error; }, setTabs(next: typeof tabs) { tabs = next; } };
}

test('page suggestions survive hidden browser screens and clear on pause or disconnect', async () => {
 const f = fixture();
 f.message({ type: 'browser.viewers', active: true }); await f.browser.chain;
 await f.action('select', 'a'); await f.action('select', 'b');
 assert.deepEqual(f.notifications, ['a', 'b']);
 await f.action('pause'); assert.deepEqual(f.notifications, ['a', 'b', null]);
 await f.action('select', 'a');
 f.message({ type: 'browser.viewers', active: false });
 assert.equal(f.notifications.at(-1), 'a', 'switching to chat keeps the selected page suggestion');
 assert.equal(f.browser.selectedPage()?.id, 'a');
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

test('a fitted tab is put back when the viewer pauses, switches tabs or leaves',async()=>{
 const f=fixture();
 f.message({type:'browser.viewers',active:true});await f.browser.chain;
 await f.action('select','a');
 const fit=()=>{f.message({type:'browser.command',id:'fit',action:'input',tabId:'a',input:{action:'fit',width:400,height:700}});return f.browser.chain;};
 const unfits=()=>f.notifications.filter((n:any)=>n?.input?.action==='unfit').map((n:any)=>n.tabId);
 await fit();await f.action('select','b');assert.deepEqual(unfits(),['a']);
 await f.action('select','a');await fit();f.message({type:'browser.viewers',active:false});assert.deepEqual(unfits(),['a','a']);
 f.message({type:'browser.viewers',active:false});assert.deepEqual(unfits(),['a','a'],'put back once');
});


test('a hidden mobile browser keeps attachment targeting and fresh metadata without restarting video', async () => {
 const f=fixture();
 f.message({type:'browser.viewers',active:true});await f.browser.chain;
 await f.action('select','a');
 f.message({type:'browser.viewers',active:false});
 assert.equal(f.browser.selectedPage()?.id,'a');
 assert.deepEqual(f.disposed,['a'],'the hidden screen stops video capture');
 const before=f.starts.length;
 f.setTabs([{id:'a',title:'Updated while chatting',url:'https://a.test/new',kind:'chrome'}]);
 await f.browser.refresh();
 assert.equal(f.browser.selectedPage()?.title,'Updated while chatting');
 assert.equal(f.browser.selectedPage()?.url,'https://a.test/new');
 assert.equal((await f.browser.selectedTab()).url,'https://a.test/new','accepting the suggestion still resolves its tab');
 assert.equal(f.starts.length,before,'metadata updates do not restart capture');
 f.setTabs([]);await f.browser.refresh();
 assert.equal(f.browser.selectedPage(),undefined);
 assert.equal(f.notifications.at(-1),null,'a tab closed while chatting removes its suggestion');
});

test('stream reconnection restores the selected page for chat without an active browser viewer', async () => {
 const f=fixture();
 f.message({type:'browser.viewers',active:true});await f.browser.chain;
 await f.action('select','b');
 f.message({type:'browser.viewers',active:false});
 f.listeners.get('close')!({code:1006});assert.equal(f.browser.selectedPage(),undefined);
 f.message({type:'ready'});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.browser.selectedPage()?.id,'b');
 assert.equal(f.notifications.at(-1),'b');
 assert.deepEqual(f.starts,['b'],'reconnection restores metadata without starting hidden video');
});


test('unchanged preview frames are suppressed without changing moving frames or dimensions', async () => {
 const f=fixture();f.message({type:'browser.viewers',active:true});await f.browser.chain;
 await f.action('select','a');
 const frame=f.frames[0],sent=()=>f.sent.filter(message=>message.type==='browser.frame');
 for(let n=0;n<100;n++)frame('same-jpeg',1440,1000);
 assert.equal(sent().length,1,'100 identical captures use one transmitted image');
 frame('changed-jpeg',1440,1000);assert.equal(sent().length,2);
 frame('changed-jpeg',720,1000);assert.equal(sent().length,3,'a dimension change must be delivered');
 frame('changed-jpeg',720,1000);assert.equal(sent().length,3);
});

test('new viewers immediately receive the current frame and paused previews send a fresh first frame', async () => {
 const f=fixture();f.message({type:'browser.viewers',active:true,count:1});await f.browser.chain;
 await f.action('select','a');f.frames[0]('same-jpeg',1440,1000);
 const count=()=>f.sent.filter(message=>message.type==='browser.frame').length;
 assert.equal(count(),1);
 f.message({type:'browser.viewers',active:true,count:2});await f.browser.chain;
 assert.equal(count(),2,'a joining viewer need not wait for the page to change');
 const replayIndex=f.sent.map(message=>message.type).lastIndexOf('browser.frame');
 assert.equal(f.sent[replayIndex-1].type,'browser.state','selection metadata precedes the image for encrypted viewers');
 f.message({type:'browser.viewers',active:false});
 f.message({type:'browser.viewers',active:true,count:1});await f.browser.chain;
 f.frames[0]('old-capture',1440,1000);assert.equal(count(),2,'superseded captures cannot send');
 f.frames[1]('same-jpeg',1440,1000);assert.equal(count(),3,'resuming resets duplicate suppression');
});

test('a failed frame send can retry the same image and a periodic frame repairs missed delivery', async () => {
 const f=fixture();f.message({type:'browser.viewers',active:true});await f.browser.chain;
 await f.action('select','a');
 const frame=f.frames[0],count=()=>f.sent.filter(message=>message.type==='browser.frame').length;
 f.socket.bufferedAmount=300_000;frame('same-jpeg',1440,1000);assert.equal(count(),0);
 f.socket.bufferedAmount=0;frame('same-jpeg',1440,1000);assert.equal(count(),1);
 f.browser.lastFrameAt=Date.now()-15_001;
 frame('same-jpeg',1440,1000);assert.equal(count(),2,'unchanged pages still deliver a periodic recovery image');
});


test('unchanged tab listings are suppressed but a new viewer receives the current browser state', async () => {
 const f=fixture();f.message({type:'browser.viewers',active:true,count:1});await f.browser.chain;
 await f.action('select','a');
 const count=()=>f.sent.filter(message=>message.type==='browser.state').length;
 const initial=count();
 await f.browser.refresh();await f.browser.refresh();assert.equal(count(),initial);
 f.message({type:'browser.viewers',active:true,count:2});await f.browser.chain;
 assert.equal(count(),initial+1,'new viewers get the listing even when no tabs changed');
 f.setTabs([{id:'a',title:'Navigated',url:'https://a.test/new',kind:'chrome'}]);
 await f.browser.refresh();assert.equal(count(),initial+2,'changed metadata remains immediate');
});


test('a transient listing error is followed by a fresh state even when no tabs changed', async () => {
 const f=fixture();f.message({type:'browser.viewers',active:true});await f.browser.chain;
 await f.action('select','a');
 f.setListingError(new Error('Temporary failure'));await f.browser.refresh();
 assert.equal(f.sent.at(-1).type,'browser.state');assert.equal(f.sent.at(-1).selected,null);
 f.setListingError();await f.browser.refresh();
 assert.equal(f.sent.at(-1).type,'browser.state');assert.equal(f.sent.at(-1).selected,'a');
 assert.equal(f.sent.at(-1).tabs.length,2);
});


test('a viewer without a selected page receives only tab metadata, never an empty frame', async () => {
 const f=fixture();f.message({type:'browser.viewers',active:true});await f.browser.chain;
 const states=f.sent.filter(message=>message.type==='browser.state');
 assert.ok(states.length>0);assert.equal(states.at(-1).error,undefined);
 assert.equal(states.at(-1).selected,null);assert.equal(states.at(-1).tabs.length,2);
 assert.equal(f.sent.filter(message=>message.type==='browser.frame').length,0);
});


test('negotiated H.264 packets replace JPEG and a mixed viewer downgrade restarts JPEG', async () => {
 const f=fixture(false,'supported');
 f.message({type:'browser.viewers',active:true,count:1,video:'h264'});await f.browser.chain;
 await f.action('select','a');f.frames[0]('jpeg-input',1600,1000);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.sent.at(-1).type,'browser.video');assert.equal(f.sent.at(-1).codec,'avc1.420028');
 const encoder=f.encoders[0];
 f.message({type:'browser.viewers',active:true,count:2,video:'h264'});await f.browser.chain;
 assert.ok(encoder.keys>0,'joining viewers request an independently decodable frame');
 f.message({type:'browser.viewers',active:true,count:2});await f.browser.chain;
 assert.equal(encoder.disposed,true);f.frames[1]('jpeg-input',1600,1000);
 assert.equal(f.sent.at(-1).type,'browser.frame');
});

test('unsupported or failed encoding falls back to JPEG without closing the browser channel', async () => {
 for(const mode of ['unsupported','failure'] as const){
  const f=fixture(false,mode);f.message({type:'browser.viewers',active:true,video:'h264'});await f.browser.chain;
  await f.action('select','a');f.frames[0]('jpeg-input',1600,1000);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.sent.at(-1).type,'browser.frame');assert.equal(f.socket.readyState,1);
  if(mode==='failure')assert.equal(f.encoders[0].disposed,true);
 }
});


test('a tab that initially could not encode retries H.264 after navigating to a supported page', async () => {
 const f=fixture(false,'unsupported');f.message({type:'browser.viewers',active:true,video:'h264'});await f.browser.chain;
 await f.action('select','a');assert.equal(f.videoAttempts.length,1);
 f.setVideoMode('supported');f.setTabs([{id:'a',title:'Secure page',url:'https://a.test/new',kind:'chrome'}]);
 await f.browser.refresh();await f.browser.chain;assert.equal(f.videoAttempts.length,2);
 f.frames[1]('new-jpeg-input',1440,900);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.sent.at(-1).type,'browser.video');
});


test('media handshake uses a server-specific machine hash without exposing the raw machine ID',()=>{
 const f=fixture();f.listeners.get('open')!({});
 const hello=f.sent.find(value=>value.type==='auth');
 assert.equal(hello.deviceId,createHash('sha256').update('test-workstationhttps://exchange.test').digest('hex'));
 assert.ok(!JSON.stringify(hello).includes('test-workstation'));
});

test('older servers receive the legacy media handshake without unknown strict-schema fields',()=>{
 const f=fixture(false,undefined,false);f.listeners.get('open')!({});
 assert.equal(f.sent.find(value=>value.type==='auth').deviceId,undefined);
});
