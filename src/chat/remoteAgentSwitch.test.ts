import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {AsyncLocalStorage} from 'node:async_hooks';
import {transpileModule,ModuleKind,ScriptTarget} from 'typescript';

function fixture(transport:'server'|'chrome') {
 const source=readFileSync('src/chat/chatView.ts','utf8');
 const method=(name:string)=>new RegExp(`(?:private |public static )(?:async )?${name}(?:<[^>]+>)?\\([^\\n]*\\{[\\s\\S]*?\\n\\t\\}`).exec(source)![0];
 const active=/private get _active[\s\S]*?(?=\n\t\/\*\*)/.exec(source)![0];
 const switches=/private readonly _agentSwitches[\s\S]*?(?=\n\tprivate _tabsSaved)/.exec(source)![0];
 const commands=source.slice(source.indexOf('\tprivate static readonly _exchangeAnnotationOwners'),source.indexOf('\n\tprivate readonly _chromeCommand'));
 const code=`class ChatViewProvider { static _surfaces=new Map(); ${active} ${switches} ${method('_stateFor')} ${method('_asActive')} ${method('_select')} ${method('_switchAgent')} ${method('commandChromeSource')} ${commands} } exports.View=ChatViewProvider;`;
 const exports:any={};let serial=0;
 const makeTab=(id:string,agent='codex',started=true):any=>({id,chat:{id,agent,title:id,entries:[],folder:'/project'},attachments:[],started,start(chat:any){this.chat=chat;},push(){}});
 runInNewContext(transpileModule(code,{compilerOptions:{module:ModuleKind.CommonJS,target:ScriptTarget.ES2022}}).outputText,{
  exports,selectionKey:'selection',chromeChatCommandFeature:()=> 'chat',exchangeRefusal(){},newChat:(agent:string)=>({id:`replacement-${++serial}`,agent,entries:[]}),tabLimit:()=>20,
  chatTranscript:()=> 'Conversation transcript',transcriptFileName:()=> 'conversation.md',writeChatTranscript:async()=>'/project/conversation.md',agentNames:{codex:'Codex',claude:'Claude'},generateUuid:()=> 'attachment',vscode:{l10n:{t:(value:string)=>value},Uri:{file:(value:string)=>value}},
 });
 const View=exports.View,view=new View(),native=makeTab('native'),remote=makeTab('remote'),events:any[]=[];
 Object.assign(view,{_frontActive:native,_tabs:[native,remote],_chromeCommand:new AsyncLocalStorage(),_view:{},_exchangeDrafts:new Map(),_remembered:{agent:'codex',models:{},efforts:{}},_context:{globalState:{get:()=>undefined,update:async()=>{}}},
  _blocked:()=>undefined,_post(){},_postMessage(){},_giveBackQueue(){},_rememberAgent(){},_selection(this:any){return {agent:this._active.chat.agent};},
  _state(this:any){return {chatId:this._active.chat.id,switchTo:this._switchTo};},
  async _receive(this:any,message:any){if(message.type==='select')this._select(message.selection);else await this._switchAgent(message.choice);},
  _addTab(this:any,agent:string){const tab=makeTab(`new-${++serial}`,agent,false);this._tabs.push(tab);this._active=tab;return tab;},
 });
 View._surfaces.set('source',view);
 const reply=(message:any,chatId:string)=>events.push({message,chatId});
 const send=(message:any)=>transport==='server'?View.commandExchangeSource('source',remote.chat.id,message,[],reply):View.commandChromeSource('source',remote.chat.id,message,[],reply);
 return {view,native,remote,events,send};
}
for(const transport of ['server','chrome'] as const){
 test(`${transport}: pending agent choice belongs to the background conversation and survives snapshots`,async()=>{
  const f=fixture(transport);await f.send({type:'select',selection:{agent:'claude'}});
  assert.equal(f.view._stateFor('remote').switchTo,'claude');assert.equal(f.view._stateFor('native').switchTo,undefined);assert.equal(f.view._frontActive,f.native);
  assert.equal(f.view._stateFor('remote').switchTo,'claude');
  await f.send({type:'switchAgent',choice:'cancel'});assert.equal(f.view._stateFor('remote').switchTo,undefined);
 });
 for(const choice of ['newTab','replace','continue'] as const)test(`${transport}: ${choice} acts on the remote chat and follows its resulting conversation`,async()=>{
  const f=fixture(transport);await f.send({type:'select',selection:{agent:'claude'}});await f.send({type:'switchAgent',choice});
  assert.equal(f.view._frontActive,f.native);assert.equal(f.native.chat.agent,'codex');
  const next=f.view._tabs.find((tab:any)=>tab.chat.agent==='claude');assert.ok(next);assert.equal(f.events.at(-1).chatId,next.chat.id);
  if(choice==='replace')assert.equal(next,f.remote);else assert.notEqual(next,f.remote);
  if(choice==='continue')assert.equal(next.attachments[0].text.includes('read it first'),true);
 });
}
