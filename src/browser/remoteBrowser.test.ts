import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { takeRemotePick, onRemotePick } from './remotePick.ts';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { setImmediate as flush } from 'node:timers/promises';

/** Exercise the production controller methods without starting VS Code. */
function harness(screencast=true, navigationError?:string, sessionBlocked=false) {
 const source=readFileSync('src/browser/browserController.ts','utf8');
 const methods=source.slice(source.indexOf('\tpublic async remoteTabs()'),source.indexOf('\n\t/**\n\t * One CDP session per tab'));
 const calls:{method:string;params:any}[]=[],frames:any[]=[],listeners=new Map<string,Function>();
 let held=0,clock=10000,open=true,disposed=0;
 const tab={id:'tab-1',title:'Example',url:'http://localhost:5173',async close(){open=false;},async startCDPSession(){return {};}};
 const client={on(method:string,fn:Function){listeners.set(method,fn);return {dispose:()=>listeners.delete(method)};},async send(method:string,params:any){
  calls.push({method,params});
  if(method==='Page.navigate')return navigationError?{errorText:navigationError}:{loaderId:'load-1'};
  if(method==='Page.startScreencast'&&!screencast)throw new Error('Not supported');
  if(method==='Page.getLayoutMetrics')return {cssLayoutViewport:{clientWidth:1000,clientHeight:800,pageX:0,pageY:100}};
  if(method==='Page.captureScreenshot')return {data:'/9j/AA=='};
  if(method==='Page.getNavigationHistory')return {currentIndex:1,entries:[{id:2},{id:3},{id:4}]};
  return {};
 }};
 const exports:any={};const intervals=new Set<Function>();
 const code=`class Controller {_screencasts=new Map(); async _settle(){} _identify(){} _idOf(tab){return tab.id;} _hold(){held(1);return ()=>held(-1);} async _sessionFor(){if(sessionBlocked)return new Promise(()=>{});return session;} ${methods}} exports.Controller=Controller;`;
 runInNewContext(transpileModule(code,{compilerOptions:{module:ModuleKind.CommonJS,target:ScriptTarget.ES2022}}).outputText,{
  exports,sessionBlocked,CDPClient:class {async attachToPage(){return 'navigation-session';}send(method:string,params:any){return client.send(method,params);}dispose(){disposed++;}},takeRemotePick,held:(n:number)=>held+=n,session:{client,sessionId:'page-session'},requireGrant(){},vscode:{workspace:{isTrusted:true},Disposable:class {private done=false;private readonly fn:()=>void;constructor(fn:()=>void){this.fn=fn;}dispose(){if(!this.done){this.done=true;this.fn();}}}},tabSource:{get all(){return open?[tab]:[];}},stripMarker:(v:string)=>v,Date:{now:()=>clock},setTimeout,clearTimeout,setInterval:(fn:Function)=>{intervals.add(fn);return fn;},clearInterval:(fn:Function)=>intervals.delete(fn),
 });
 return {controller:new exports.Controller(),tab,calls,frames,listeners,intervals,held:()=>held,disposed:()=>disposed,advance:(n:number)=>clock+=n,close:()=>open=false};
}
test('stream acknowledges all frames, filters other sessions, throttles and releases its tab',async()=>{
 const h=harness(),stream=await h.controller.remoteStream('tab-1',(...frame:any[])=>h.frames.push(frame));
 await flush();h.frames.length=0;h.advance(200);
 const event={data:'/9j/AA==',sessionId:7,metadata:{deviceWidth:1000,deviceHeight:800}};
 h.listeners.get('Page.screencastFrame')!(event,'other');assert.equal(h.frames.length,0);
 h.listeners.get('Page.screencastFrame')!(event,'page-session');h.listeners.get('Page.screencastFrame')!(event,'page-session');
 assert.equal(h.frames.length,1);assert.equal(h.calls.filter(c=>c.method==='Page.screencastFrameAck').length,2);assert.equal(h.held(),1);
 stream.dispose();assert.equal(h.listeners.size,0);assert.equal(h.intervals.size,0);assert.equal(h.held(),0);assert.equal(h.calls.at(-1)?.method,'Page.stopScreencast');
});
test('unsupported screencast falls back to screenshots; closed tabs never fall through to another tab',async()=>{
 const h=harness(false),stream=await h.controller.remoteStream('tab-1',(...frame:any[])=>h.frames.push(frame));
 await flush();assert.equal(h.frames.length,1);assert.deepEqual(h.frames[0],['/9j/AA==',1000,800]);
 h.close();await assert.rejects(()=>h.controller.remoteInput('tab-1',{action:'reload'}),/closed/);stream.dispose();assert.equal(h.held(),0);
});

test('preview fallback captures the live view without clipping, scaling or emulating its viewport',async()=>{
 const h=harness(false),stream=await h.controller.remoteStream('tab-1',()=>{});
 await flush();
 const captures=h.calls.filter(c=>c.method==='Page.captureScreenshot');assert.equal(captures.length,1);
 assert.equal(captures[0].params.fromSurface,false);
 assert.equal(captures[0].params.captureBeyondViewport,false);
 assert.equal(captures[0].params.clip,undefined);
 assert.ok(!h.calls.some(c=>c.method.startsWith('Emulation.')));
 stream.dispose();assert.equal(h.held(),0);
});
test('remote input maps normalized coordinates and sends native text and navigation commands',async()=>{
 const h=harness();
 await h.controller.remoteInput('tab-1',{action:'click',x:0.5,y:0.25,button:'left',count:1});
 const mouse=h.calls.filter(c=>c.method==='Input.dispatchMouseEvent');assert.equal(mouse.length,3);assert.equal(mouse[0].params.type,'mouseMoved');assert.equal(mouse[1].params.type,'mousePressed');assert.equal(mouse[0].params.x,500);assert.equal(mouse[0].params.y,200);
 await h.controller.remoteInput('tab-1',{action:'text',text:'Привет 👋'});assert.equal(h.calls.at(-1)?.params.text,'Привет 👋');
 await h.controller.remoteInput('tab-1',{action:'back'});assert.equal(h.calls.at(-1)?.params.entryId,2);assert.equal(h.held(),0);
});

test('a pick waiting on the tab takes a remote left click by its coordinates instead of the page',async()=>{
 const h=harness();const taken:number[][]=[];
 const pick=onRemotePick(h.tab,async(x,y)=>{taken.push([x,y]);return true;});
 await h.controller.remoteInput('tab-1',{action:'click',x:0.5,y:0.25,button:'left',count:1});
 assert.deepEqual(taken,[[500,200]]);assert.equal(h.calls.filter(c=>c.method==='Input.dispatchMouseEvent').length,0);
 await h.controller.remoteInput('tab-1',{action:'click',x:0.5,y:0.25,button:'right',count:1});
 assert.equal(taken.length,1);assert.equal(h.calls.filter(c=>c.method==='Input.dispatchMouseEvent').length,3);
 pick.dispose();
 await h.controller.remoteInput('tab-1',{action:'click',x:0.1,y:0.1,button:'left',count:1});
 assert.equal(taken.length,1);assert.equal(h.calls.filter(c=>c.method==='Input.dispatchMouseEvent').length,6);assert.equal(h.held(),0);
});
test('a pick handler that declines lets the click reach the page',async()=>{
 const h=harness();const pick=onRemotePick(h.tab,async()=>false);
 await h.controller.remoteInput('tab-1',{action:'click',x:0.5,y:0.25,button:'left',count:1});
 assert.equal(h.calls.filter(c=>c.method==='Input.dispatchMouseEvent').length,3);pick.dispose();
});

test('closing from the remote viewer closes only the selected tab and does not start a CDP session',async()=>{
 const h=harness();await h.controller.remoteInput('tab-1',{action:'close'});
 assert.equal(h.calls.length,0);assert.equal(h.held(),0);
 await assert.rejects(()=>h.controller.remoteTab('tab-1'),/closed/);
});

test('remote navigation addresses the selected page directly and reports browser failures',async()=>{
 const h=harness();
 await h.controller.remoteInput('tab-1',{action:'navigate',url:'https://example.com/new'});
 assert.deepEqual(h.calls.map(c=>c.method),['Page.navigate']);
 assert.equal(h.calls[0].params.url,'https://example.com/new');
 assert.equal(h.held(),0);
 const failed=harness(true,'net::ERR_NAME_NOT_RESOLVED');
 await assert.rejects(()=>failed.controller.remoteInput('tab-1',{action:'navigate',url:'https://missing.invalid'}),/ERR_NAME_NOT_RESOLVED/);
 assert.equal(failed.held(),0);
});

test('remote Enter includes the character needed to submit forms; keyUp never repeats it',async()=>{
 const h=harness();
 await h.controller.remoteInput('tab-1',{action:'key',key:'Enter',modifiers:0});
 const events=h.calls.filter(c=>c.method==='Input.dispatchKeyEvent').map(c=>c.params);
 assert.equal(events[0].type,'keyDown');assert.equal(events[0].key,'Enter');
 assert.equal(events[0].text,'\r');assert.equal(events[0].unmodifiedText,'\r');
 assert.equal(events[1].type,'keyUp');assert.equal(events[1].text,undefined);
 assert.equal(events[1].unmodifiedText,undefined);assert.equal(h.held(),0);
});

test('remote Shift+Enter keeps newline behavior but Control/Alt/Meta+Enter remain shortcuts',async()=>{
 for(const modifiers of [8,1,2,4]){
  const h=harness();await h.controller.remoteInput('tab-1',{action:'key',key:'Enter',modifiers});
  const down=h.calls.find(c=>c.method==='Input.dispatchKeyEvent')!.params;
  assert.equal(down.modifiers,modifiers);assert.equal(down.text,modifiers===8?'\r':undefined);
 }
});

 test('navigation bypasses a stalled screenshot session and disposes its own channel',async()=>{
 const h=harness(true,undefined,true);
 await h.controller.remoteInput('tab-1',{action:'navigate',url:'https://example.com'});
 assert.equal(h.calls.at(-1)?.method,'Page.navigate');
 assert.equal(h.disposed(),1);assert.equal(h.held(),0);
 const failed=harness(true,'net::ERR_ABORTED',true);
 await assert.rejects(()=>failed.controller.remoteInput('tab-1',{action:'navigate',url:'https://example.com'}),/ERR_ABORTED/);
 assert.equal(failed.disposed(),1);assert.equal(failed.held(),0);
 });

test('an older stream disposed while a newer one runs does not stop the shared screencast',async()=>{
 const h=harness(),first=await h.controller.remoteStream('tab-1',()=>{}),second=await h.controller.remoteStream('tab-1',()=>{});
 const stops=()=>h.calls.filter(c=>c.method==='Page.stopScreencast').length;
 first.dispose();assert.equal(stops(),0);assert.equal(h.held(),1);
 second.dispose();assert.equal(stops(),1);assert.equal(h.held(),0);
 first.dispose();second.dispose();assert.equal(stops(),1,'a repeated disposal changes nothing');
 const third=await h.controller.remoteStream('tab-1',()=>{});third.dispose();assert.equal(stops(),2,'the tab can be streamed again after the last one stopped');
});
