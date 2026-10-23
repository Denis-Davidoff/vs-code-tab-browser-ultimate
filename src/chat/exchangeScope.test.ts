import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {AsyncLocalStorage} from 'node:async_hooks';
import {setImmediate as tick} from 'node:timers/promises';
import {transpileModule,ScriptTarget} from 'typescript';

function fixture() {
 const source=readFileSync('src/chat/chatView.ts','utf8');
 const accessor=/private get _active\(\): ChatTab \{[^\n]+\}\n\tprivate set _active\(tab: ChatTab\) \{[^\n]+\}/.exec(source)![0];
 const stateFor=/private _stateFor\(chatId\?: string\): ChatViewState \{[\s\S]*?\n\t\}/.exec(source)![0];
 const asActive=/private _asActive<T>\(tab: ChatTab, run: \(\) => T\): T \{[\s\S]*?\n\t\}/.exec(source)![0];
 const js=transpileModule(`class View {${accessor}\n${stateFor}\n${asActive}\n_state(){return {chatId:this._active.chat.id};}}\nView;`,{compilerOptions:{target:ScriptTarget.ES2022}}).outputText;
 const View=runInNewContext(js,{});
 const view=new View();
 const native={chat:{id:'native'}},remote={chat:{id:'remote'}};
 view._frontActive=native;view._tabs=[native,remote];view._chromeCommand=new AsyncLocalStorage();
 return {view,native,remote};
}
test('remote actions keep their conversation across awaits without switching the editor',async()=>{
 const {view,native,remote}=fixture();
 await view._chromeCommand.run({tab:remote,chatId:'remote',remote:true},async()=>{
  assert.equal(view._active,remote);await tick();assert.equal(view._active,remote);
  const next={chat:{id:'new'}};view._active=next;assert.equal(view._active,next);assert.equal(view._frontActive,native);
 });
 assert.equal(view._active,native);
 await view._chromeCommand.run({tab:remote,chatId:'remote'},async()=>{assert.equal(view._active,native);});
});
test('pinned snapshots escape command scope and restore the actual editor tab',()=>{
 const {view,native,remote}=fixture();
 view._chromeCommand.run({tab:remote,chatId:'remote',remote:true},()=>{
  assert.equal(view._stateFor('remote').chatId,'remote');assert.equal(view._stateFor('native').chatId,'native');assert.equal(view._frontActive,native);
 });
});
