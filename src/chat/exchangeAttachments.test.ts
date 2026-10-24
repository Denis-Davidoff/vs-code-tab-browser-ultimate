import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule,ModuleKind,ScriptTarget } from 'typescript';
import { setImmediate as flush } from 'node:timers/promises';
import { remoteRefusal } from './core/commands.ts';
import { remoteScope } from './core/remoteScope.ts';

/** Use the real controller routing and annotation listener with independent local/remote tabs. */
function harness(nativeGranted=true){
 const source=readFileSync('src/chat/chatView.ts','utf8');
 const commands=source.slice(source.indexOf('\tprivate static readonly _exchangeAnnotationOwners'),source.indexOf('\n\tprivate readonly _chromeCommand'));
 const annotations=source.slice(source.indexOf('\tprivate _onAnnotations('),source.indexOf('\n\t/**\n\t * Adds an annotation'));
 const remove=source.slice(source.indexOf('\tprivate _removeSentAnnotations('),source.indexOf('\n\t/** Closing a chat tab'));
 const refusal=source.slice(source.indexOf('function exchangeRefusal('),source.indexOf('\nfunction pushKey('));
 const exports:any={};
 const code=refusal+'class ChatViewProvider {static _surfaces=new Map();'+commands+annotations+remove+'} exports.Controller=ChatViewProvider;';
 runInNewContext(transpileModule(code,{compilerOptions:{module:ModuleKind.CommonJS,target:ScriptTarget.ES2022}}).outputText,{exports,URL,isBrowserApiGranted:()=>nativeGranted,tabSource:{open:async(url:string,options:any)=>exports.nativeCalls.push({url,...options})},path:{isAbsolute:(value:string)=>value.startsWith('/'),join:(...parts:string[])=>parts.join('/')},os:{homedir:()=>'/home/user'},isDirectory:(value:string)=>value==='/project',vscode:{commands:{executeCommand:async(name:string)=>exports.nativeCalls.push(name)}},chromeChatCommandFeature:()=> 'chat',remoteRefusal,remoteScope});
 exports.nativeCalls=[];const Controller=exports.Controller,view:any=new Controller(),events:any[]=[],calls:any[]=exports.nativeCalls;
 const localChat={chat:{id:'local-chat'},attachments:[]},remoteChat={chat:{id:'remote-chat'},attachments:[]};
 const page={id:'remote-page',url:'https://example.com',title:'Remote'};
 Object.assign(view,{_view:{},_surfaceId:'source',_tabs:[localChat,remoteChat],_active:localChat,_annotationLinks:new Map(),_blocked:()=>undefined,_post(){},_chromeCommand:{run:(_scope:any,fn:Function)=>fn()},_inputHistory:()=>[],
  _annotationAttachment:(record:any,_url:string,_page:any,id:string)=>({chip:{id,kind:'annotation',label:record.text},text:record.text}),
  _makeAttachment:async(kind:string,target:any,remote:boolean)=>{calls.push({kind,target,remote});return {chip:{id:'screenshot-id',label:'Screenshot'},text:'Remote screenshot',image:{mediaType:'image/png',base64:'aGVsbG8='}};},
  _browser:{annotationsOf:()=>undefined,annotateTab:async(target:any,mode:string)=>calls.push({target,mode}),tabIdOf:(target:any)=>target.id,remoteTab:async(id:string)=>{assert.equal(id,page.id);return page;},removeAnnotations:async(target:any,ids:string[])=>calls.push({removed:ids,target})},
 });
 Controller._surfaces.set('source',view);
 const reply=(message:any,chatId:string)=>events.push({message,chatId});
 const command=(message:any,target:any=page,picked:any[]=[])=>Controller.commandExchangeSource('source','remote-chat',message,picked,reply,target);
 return {Controller,view,events,calls,localChat,remoteChat,page,command};
}
test('remote annotation events update the web draft without attaching to the native active chat',async()=>{
 const h=harness();await h.command({type:'attach',kind:'annotation'});assert.equal(h.calls[0].target,h.page);
 const id='e553a119-1dfc-433e-9a6e-6d077d48885a';
 const change=(text:string)=>({tab:h.page,url:h.page.url,records:[{id,text}],created:[id],removed:[]});
 h.view._onAnnotations(change('First note'));assert.equal(h.localChat.attachments.length,0);assert.equal(h.remoteChat.attachments.length,0);
 assert.equal(h.events.at(-1).chatId,'remote-chat');assert.equal(h.events.at(-1).message.type,'exchangeAttachment');assert.equal(h.events.at(-1).message.text,'First note');
 h.view._onAnnotations({...change('Edited note'),created:[]});assert.equal(h.events.at(-1).message.id,id);assert.equal(h.events.at(-1).message.text,'Edited note');
 const canonical=h.view._exchangeDrafts.get('remote-chat').get(id);assert.equal(canonical.exchangeAnnotation.tabId,h.page.id);
 h.view._removeSentAnnotations([canonical]);await flush();assert.equal(h.calls.at(-1).removed[0],id);assert.equal(h.calls.at(-1).target,h.page);
 h.view._onAnnotations({tab:h.page,url:h.page.url,records:[],created:[],removed:[id]});assert.equal(h.events.at(-1).message.removed,true);
});
test('remote screenshots retain their image data and have an explicit browser target',async()=>{
 const h=harness();await h.command({type:'attach',kind:'screenshot'});
 assert.equal(h.calls[0].target,h.page);assert.equal(h.calls[0].remote,true);assert.equal(h.events[0].message.file.base64,'aGVsbG8=');assert.equal(h.events[0].message.kind,'screenshot');
 await assert.rejects(()=>h.command({type:'attach',kind:'page'},null),/Select a tab/);assert.equal(h.calls.length,1);
});
test('dismissing a remote annotation prevents later edits from silently attaching it again',async()=>{
 const h=harness();await h.command({type:'attach',kind:'pointAnnotation'});
 const id='e553a119-1dfc-433e-9a6e-6d077d48885a',change={tab:h.page,url:h.page.url,records:[{id,text:'Note'}],created:[id],removed:[]};
 h.view._onAnnotations(change);await h.command({type:'removeAttachment',id});const count=h.events.length;
 h.view._onAnnotations({...change,records:[{id,text:'Edited'}],created:[]});assert.equal(h.events.length,count);assert.equal(h.localChat.attachments.length,0);
 h.Controller.releaseExchangeSource('source');assert.equal(h.Controller._exchangeAnnotationOwners.size,0);
});
test('a website session cannot change approvals or reach chats, files and terminals beyond the shared one',async()=>{
 const h=harness();(h.remoteChat as any).id='remote-tab';(h.localChat as any).id='local-tab';
 for(const message of [{type:'setApprovalMode',key:'all',mode:'auto'},{type:'deleteChat',id:'local-chat'},{type:'openChat',id:'local-chat'},{type:'temporaryStorage',action:'all'},{type:'resumeInTerminal',id:'remote-chat'},{type:'openFile',path:'/etc/hosts'},{type:'setAgentBinary',agent:'claude'},{type:'openAgentSetting',agent:'codex'}]){
  await assert.rejects(()=>h.command(message),/only in VS Code/,message.type);
 }
 await assert.rejects(()=>h.command({type:'closeTab',id:'local-tab'}),/not shared/);
 await assert.rejects(()=>h.command({type:'renameTab',id:'local-tab',title:'x'}),/not shared/);
 await assert.rejects(()=>h.command({type:'secondOpinion',chatId:'local-chat',index:0,agent:'codex',model:'m'}),/not shared/);
 assert.equal(h.calls.length,0);
});

test('opening a VS Code browser tab or Chrome needs no selected remote tab',async()=>{
 const h=harness();await h.command({type:'openBrowser',where:'vscode'},null);
 assert.deepEqual(h.calls[0],{url:'about:blank',where:'vscode',preserveFocus:true});assert.equal(h.events[0].message.type,'exchangeBrowser');
 await h.command({type:'openBrowser',where:'chrome'},null);
 assert.equal(h.calls[1],'aiBrowser.openInChrome');assert.equal(h.events[1].message.type,'exchangeBrowser');
});
test('remote folder paths are validated before changing the conversation',async()=>{
 const h=harness();
 for(const folder of ['relative','/missing','/project\n'])await assert.rejects(()=>h.command({type:'setWorkdir',path:folder}),/folder path|does not exist/);
 await assert.rejects(()=>h.command({type:'chooseWorkdir'}),/Enter the folder path/);
 const received:any[]=[];h.view._receive=async(message:any)=>received.push(message);h.view._receiveChromeFooter=async(_tab:any,message:any)=>received.push(message);
 await h.command({type:'setWorkdir',path:' /project '});assert.equal(received[0].path,'/project');
});

test('remote native tab opening reports missing API access without opening a local URL prompt',async()=>{
 const h=harness(false);
 await assert.rejects(()=>h.command({type:'openBrowser',where:'vscode'},null),/native browser API/);
 assert.equal(h.calls.length,0);assert.equal(h.events.length,0);
});
