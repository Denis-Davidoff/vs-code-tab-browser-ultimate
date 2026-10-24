import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setImmediate as flush } from 'node:timers/promises';

function harness(fail=false){
 const source=readFileSync('chrome-extension/sidepanel.ts','utf8');
 const handlers=source.slice(source.indexOf("    if (message.type === 'openLink'"),source.indexOf("    if (message.type === 'acceptSuggestion'"));
 const calls:any[]=[],errors:string[]=[],exports:any={};
 runInNewContext('exports.open = message => {'+handlers+'};',{
  exports,chrome:{tabs:{async create(options:any){calls.push(options);if(fail)throw new Error('Cannot create tab');}}},showFeedback:(error:string)=>errors.push(error),
 });
 return {open:exports.open,calls,errors};
}

test('Chrome plugin opens an ordinary blank page and preserves link URLs',async()=>{
 const h=harness();
 h.open({type:'openBrowser',where:'chrome'});
 h.open({type:'openLink',url:'http://localhost:5173/path?q=hello#part'});
 await flush();
 assert.equal(h.calls[0].url,'about:blank');
 assert.equal(h.calls[1].url,'http://localhost:5173/path?q=hello#part');
 h.open({type:'openLink',url:'javascript:alert(1)'});
 assert.equal(h.calls.length,2);
});

test('Chrome plugin reports tab creation failures',async()=>{
 const h=harness(true);h.open({type:'openBrowser'});await flush();
 assert.match(h.errors[0],/Cannot create tab/);
});

test('VS Code browser requests are not intercepted by local Chrome tab creation',()=>{
 const h=harness();h.open({type:'openBrowser',where:'vscode'});
 assert.equal(h.calls.length,0);
});
