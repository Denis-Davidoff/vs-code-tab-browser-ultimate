import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {transpileModule,ModuleKind,ScriptTarget} from 'typescript';
import {controlOf,surfaceControls} from '../src/chat/core/commands.ts';
function compile(source:string){return transpileModule(source,{compilerOptions:{module:ModuleKind.CommonJS,target:ScriptTarget.ES2022}}).outputText;}

test('Chrome opening is offered on every surface',()=>{
 const source=readFileSync('preview-src/chat.ts','utf8');
 const body=/function browserMenuItems\(\): MenuItem\[\] \{[\s\S]*?\n\}/.exec(source)![0];
 const context:any={state:{nativeBrowser:'granted',suggestions:[]},exports:{},post(){}};
 runInNewContext(compile(body+'\nexports.items=browserMenuItems;'),context);
 const items=context.exports.items();assert.equal(items[0].command,'openBrowser.chrome');assert.equal(items[1].label,'VS Code Browser');assert.ok(!items[1].disabled);
 // openMenu disables a row by its command: only the website's map refuses this one.
 assert.equal(controlOf(surfaceControls('exchange'),'openBrowser.chrome').s,'on');
 assert.equal(controlOf(surfaceControls('editor'),'openBrowser.chrome').s,'on');
 assert.equal(controlOf(surfaceControls('chrome'),'openBrowser.chrome').s,'on');
});
test('remote folder picker sends a path for the same conversation and never opens the system picker',()=>{
 const source=readFileSync('preview-src/serverChatHost.ts','utf8');
 const body=/function chooseFolderPath\(\):void \{[\s\S]*?\n\}/.exec(source)![0];
 const nodes:any[]=[],sent:any[]=[],notices:string[]=[];
 const context:any={latest:{chatId:'chat-1',view:{workdir:{current:{path:'/old'}}}},send:(value:any)=>sent.push(value),notice:(value:string)=>notices.push(value),document:{body:{append(){}},createElement(tag:string){const node:any={tag,append(){},showModal(){},close(){this.closed=true;},remove(){},focus(){},select(){}};nodes.push(node);return node;}},exports:{}};
 runInNewContext(compile(body+'\nexports.choose=chooseFolderPath;'),context);
 context.exports.choose();const input=nodes.find(node=>node.tag==='input'),form=nodes.find(node=>node.tag==='form');
 assert.equal(input.value,'/old');input.value=' /project ';form.onsubmit({preventDefault(){}});assert.equal(sent[0].path,'/project');assert.equal(sent[0].type,'setWorkdir');
 context.exports.choose();context.latest.chatId='other';nodes.filter(node=>node.tag==='form').at(-1).onsubmit({preventDefault(){}});assert.equal(sent.length,1);assert.match(notices[0],/conversation changed/);
});

for (const code of [1008, 1006]) {
 test(`connection loader ${code === 1008 ? 'stops on terminal rejection' : 'continues during reconnect'} after rendering a chat`, () => {
  const source=readFileSync('preview-src/serverChatHost.ts','utf8');
  const render=/function render\(\):void \{[\s\S]*?\n\}/.exec(source)![0];
  const connect=/function connect\(\):void \{[\s\S]*?\n\}/.exec(source)![0];
  const ws:any={}; const status={dataset:{busy:'false'},textContent:''}; let retries=0;
  const context:any={exports:{},pointId:'workspace',status,stopped:false,connecting:false,authenticated:true,online:true,rendererReady:true,
   latest:{chatId:'chat',view:{tabs:[],entries:[]}},socket:undefined,app:{},attachments:new Map(),pending:new Map(),feedback:'',
   conversation:{dataset:{},replaceChildren(){}},document:{getElementById:()=>({remove(){}}),documentElement:{style:{}},body:{}},
   location:{href:'https://exchange.test/chat',protocol:'https:',host:'exchange.test'},URL,
   retry:undefined,handshake:undefined,terminals:{syncTerminals(){},fromAgent:()=>false,fromView:()=>false,reconnected(){},disconnected(){}},workspaceExchangeSocket:()=>ws,connectionState(){},emit(){},replaySnapshots(){},clearTimeout(){},
   setTimeout(fn:any){if(fn?.name==='connect')retries++;return 1;},readPatch(){},applyPatch(){},resync(){},notice(){},send(){},result(){},
  };
  runInNewContext(compile(render+'\n'+connect+'\nexports.connect=connect;exports.render=render;'),context);
  context.exports.connect(); ws.onclose({code});
  context.exports.render(); // Later UI rerenders must preserve terminal state too.
  assert.equal(status.dataset.busy,code===1008?'false':'true');
  assert.equal(retries,code===1008?0:1);
  if(code===1008)assert.match(status.textContent,/Sign in again/);
 });
}
