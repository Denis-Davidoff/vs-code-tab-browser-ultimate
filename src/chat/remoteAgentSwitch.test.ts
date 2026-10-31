import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {AsyncLocalStorage} from 'node:async_hooks';
import {transpileModule,ModuleKind,ScriptTarget} from 'typescript';
import { remoteRefusal, type ConnectionPermissions } from './core/commands.ts';
import { remoteScope } from './core/remoteScope.ts';

function fixture(transport:'server'|'chrome', permissions?: ConnectionPermissions) {
 const source=readFileSync('src/chat/chatView.ts','utf8');
 const method=(name:string)=>new RegExp(`(?:private |public static )(?:async )?${name}(?:<[^>]+>)?\\([^\\n]*\\{[\\s\\S]*?\\n\\t\\}`).exec(source)![0];
 const active=/private get _active[\s\S]*?(?=\n\t\/\*\*)/.exec(source)![0];
 const switches=/private readonly _agentSwitches[\s\S]*?(?=\n\tprivate _tabsSaved)/.exec(source)![0];
 const commands=source.slice(source.indexOf('\tprivate static readonly _exchangeAnnotationOwners'),source.indexOf('\n\tprivate readonly _chromeCommand'));
 const createChat=/public async newChat\([\s\S]*?\n\t\}/.exec(source)![0];
 const code=`class ChatViewProvider { static _surfaces=new Map(); ${active} ${switches} ${method('_stateFor')} ${method('_asActive')} ${method('_select')} ${method('_switchAgent')} ${method('commandChromeSource')} ${createChat} ${commands} } exports.View=ChatViewProvider;`;
 const exports:any={};let serial=0;
 const makeTab=(id:string,agent='codex',started=true):any=>({id,chat:{id,agent,title:id,entries:[],folder:'/project'},attachments:[],pendingSends:[],started,start(chat:any){this.chat=chat;},push(){}});
 runInNewContext(transpileModule(code,{compilerOptions:{module:ModuleKind.CommonJS,target:ScriptTarget.ES2022}}).outputText,{
  exports,selectionKey:'selection',chromeChatCommandFeature:()=> 'chat',exchangeRefusal(){},remoteRefusal:(surface:any,type:string)=>remoteRefusal(surface,type,permissions),remoteScope,newChat:(agent:string)=>({id:`replacement-${++serial}`,agent,entries:[]}),tabLimit:()=>20,
  chatTranscript:()=> 'Conversation transcript',transcriptFileName:()=> 'conversation.md',writeChatTranscript:async()=>'/project/conversation.md',agentNames:{codex:'Codex',claude:'Claude'},generateUuid:()=> 'attachment',vscode:{l10n:{t:(value:string)=>value},Uri:{file:(value:string)=>value}},
 });
 const View=exports.View,view=new View(),native=makeTab('native'),remote=makeTab('remote'),events:any[]=[];
 Object.assign(view,{_frontActive:native,_tabs:[native,remote],_chromeCommand:new AsyncLocalStorage(),_view:{},_exchangeDrafts:new Map(),_remembered:{agent:'codex',models:{},efforts:{}},_context:{globalState:{get:()=>undefined,update:async()=>{}}},
  _registry:{detecting:false,backend:()=>({})},_rememberInput:async()=>{},_send:async(text:string,tabId:string)=>{events.push({sent:text,tabId});},_blocked:()=>undefined,_post(){},_postMessage(){},_focusInput(){},_giveBackQueue(){},_rememberAgent(){},_selection(this:any){return {agent:this._active.chat.agent,model:'model'};},
  _state(this:any){return {chatId:this._active.chat.id,switchTo:this._switchTo};},
  async _receive(this:any,message:any){if(message.type==='select')this._select(message.selection);else if(message.type==='newTab'||message.type==='newChat')await this.newChat(message.location);else await this._switchAgent(message.choice);},
  _selectTab(this:any,id:string){this._active=this._tabs.find((tab:any)=>tab.id===id);},
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

for (const type of ['newTab', 'newChat']) {
 test(`Chrome: ${type} opens a chat and follows it without changing the editor selection`,async()=>{
  const f=fixture('chrome');
  await f.send({type,location:'here'});
  const next=f.view._tabs.at(-1);
  assert.notEqual(next,f.remote);
  assert.equal(f.view._frontActive,f.native);
  assert.equal(f.events.at(-1).chatId,next.chat.id);
 });
 test(`Chrome: ${type} reuses an empty conversation and follows it`,async()=>{
  const f=fixture('chrome');f.remote.started=false;
  await f.send({type,location:'here'});
  assert.equal(f.view._tabs.length,2);
  assert.equal(f.view._frontActive,f.native);
 });
}

test('Chrome conversation restriction is enforced on the host before creation',async()=>{
 const permissions={chrome:{conversations:false}} as unknown as ConnectionPermissions;
 const f=fixture('chrome',permissions);
 await assert.rejects(f.send({type:'newTab',location:'here'}),/disabled for Chrome/);
 assert.equal(f.view._tabs.length,2);
});

test('an Exchange send keeps Exchange permissions when Chrome messaging is disabled',async()=>{
 const permissions={chrome:{messages:false},exchange:{messages:true}} as unknown as ConnectionPermissions;
 const f=fixture('server',permissions);
 await f.send({type:'send',text:'From Exchange'});
 assert.equal(f.events.find((event:any)=>event.sent)?.tabId,f.remote.id);
});

test('connecting a specific agent skips an empty chat belonging to another agent',async()=>{
 const f=fixture('server');f.native.started=false;
 await f.view.newChat('here','pi');
 assert.equal(f.view._frontActive.chat.agent,'pi');
 assert.equal(f.native.chat.agent,'codex');
 const count=f.view._tabs.length;
 await f.view.newChat('here','pi');
 assert.equal(f.view._tabs.length,count,'reuse the empty chat for the requested agent');
 assert.equal(f.view._frontActive.chat.agent,'pi');
});
