import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget, JsxEmit } from 'typescript';
import * as previewZoom from '../../exchange-server/apps/web/app/components/preview-zoom.ts';

test('remote address keeps a draft during polling, switches tabs and submits the typed URL',()=>{
 const slots:any[]=[],effects:Function[]=[],sent:any[]=[];
 let index=0;
 const ws:any={readyState:1,send:(value:string)=>sent.push(JSON.parse(value)),close(){}};
 const hooks={
  useRef(value:any){const i=index++;return slots[i]??(slots[i]={current:value});},
  useState(value:any){const i=index++;if(!(i in slots))slots[i]=value;return [slots[i],(next:any)=>{slots[i]=next;}];},
  useEffect(fn:Function){const i=index++;if(!(i in slots)){slots[i]=true;effects.push(fn);}},
 };
 const jsx=(type:any,props:any)=>({type,props});
 const exports:any={};
 const source=readFileSync('exchange-server/apps/web/app/workspace/[id]/remote-browser.tsx','utf8');
 const code=transpileModule(source,{compilerOptions:{module:ModuleKind.CommonJS,target:ScriptTarget.ES2022,jsx:JsxEmit.ReactJSX}}).outputText;
 runInNewContext(code,{exports,require:(name:string)=>{
  if(name==='react')return hooks;
  if(name==='react/jsx-runtime')return {jsx,jsxs:jsx};
  if(name.includes('exchangeCrypto'))return {workspaceExchangeSocket:()=>ws};
  if(name.includes('preview-scroll'))return {createPreviewScrollQueue:()=>({reset(){}})};
  if(name.includes('preview-zoom'))return previewZoom;
  if(name.includes('preview-video'))return {createPreviewVideo:()=>({reset(){},close(){},decode(){}}),supportsPreviewVideo:()=>Promise.resolve(false)};
  return {};
 },WebSocket:{OPEN:1},location:{protocol:'https:',host:'exchange.test'},process:{env:{}},window:{addEventListener(){},removeEventListener(){}},document:{hidden:false,addEventListener(){},removeEventListener(){}},crypto:{randomUUID:()=>String(sent.length)},setTimeout:()=>1,clearTimeout(){}});
 function render(){index=0;return exports.RemoteBrowser({pointId:'point',active:true,onShowChat(){}});}
 function find(node:any,predicate:(node:any)=>boolean):any{
  if(!node||typeof node!=='object')return;
  if(predicate(node))return node;
  for(const child of [node.props?.children].flat(Infinity)){const found=find(child,predicate);if(found)return found;}
 }
 const address=()=>find(render(),n=>n.props?.['aria-label']==='Remote page address').props;
 const state=(id:string,url:string)=>ws.onmessage({data:JSON.stringify({type:'browser.state',selected:id,tabs:[{id,url,title:'Page'}]})});
 render();effects.splice(0).forEach(fn=>fn());
 ws.onmessage({data:JSON.stringify({type:'ready',online:true})});
 state('tab-1','https://old.test');
 address().onFocus();address().onChange({target:{value:'  new.test/path  '}});
 state('tab-1','https://redirect.test');
 assert.equal(address().value,'  new.test/path  ');
 find(render(),n=>n.type==='form').props.onSubmit({preventDefault(){}});
 assert.equal(sent.at(-1).input.url,'https://new.test/path');
 assert.equal(sent.at(-1).tabId,'tab-1');
 state('tab-1','https://new.test/path');assert.equal(address().value,'https://new.test/path');
 address().onFocus();address().onChange({target:{value:'draft'}});
 state('tab-2','https://new.test/path');assert.equal(address().value,'https://new.test/path');
 ws.onmessage({data:JSON.stringify({type:'browser.result',id:'navigation-error',ok:false,error:'Navigation failed'})});
 state('tab-2','https://new.test/path');
 assert.ok(find(render(),n=>n.props?.role==='alert'&&[n.props.children].flat(Infinity).includes('Navigation failed')));
 assert.ok(find(render(),n=>n.type==='button'&&n.props.type==='submit'));
 // The page navigates elsewhere while the field is focused and untouched: the address
 // follows it once focus ends, and later polls with the same URL change nothing.
 address().onFocus();
 state('tab-2','https://moved.test/page');
 assert.equal(address().value,'https://new.test/path');
 address().onBlur();
 assert.equal(address().value,'https://moved.test/page');
 state('tab-2','https://moved.test/page');assert.equal(address().value,'https://moved.test/page');
 // After Enter the field keeps focus; typing again is protected from the navigation's own state updates.
 address().onFocus();address().onChange({target:{value:'a.test'}});
 find(render(),n=>n.type==='form').props.onSubmit({preventDefault(){}});
 address().onChange({target:{value:'b.test'}});
 state('tab-2','https://a.test/landed');
 assert.equal(address().value,'b.test');
 address().onBlur();assert.equal(address().value,'b.test');
 address().onChange({target:{value:'https://moved.test/page'}});address().onBlur();
 state('tab-2','https://moved.test/page');
 // A draft typed by the viewer survives losing focus.
 address().onFocus();address().onChange({target:{value:'typed.test'}});
 state('tab-2','https://moved.test/other');
 address().onBlur();
 assert.equal(address().value,'typed.test');
});
