import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {transpileModule,ScriptTarget} from 'typescript';

test('Exchange command refusal unlocks Git controls and delivers the error to the same chat',()=>{
 const source=readFileSync('preview-src/serverChatHost.ts','utf8');
 const method=source.slice(source.indexOf('function result('),source.indexOf('\nfunction send(',source.indexOf('function result(')));
 const messages:any[]=[],pending=new Map(),exports:any={};
 pending.set('stage',{chatId:'chat',message:{type:'gitIndexAction',folder:'/project'},timer:0});
 runInNewContext(transpileModule(method+'\nexports.result=result;',{compilerOptions:{target:ScriptTarget.ES2022}}).outputText,{exports,pending,latest:{chatId:'chat'},clearTimeout(){},emit:(message:any)=>messages.push(message),notice(){},render(){},conversation:{},attachments:new Map()});
 exports.result('stage',false,'Git index is locked');
 assert.equal(pending.size,0);assert.equal(messages[0].type,'gitIndexResult');assert.equal(messages[0].folder,'/project');assert.equal(messages[0].error,'Git index is locked');
});

test('Chrome uncertain delivery unlocks Git controls without replaying the mutation',()=>{
 const source=readFileSync('chrome-extension/sidepanel.ts','utf8');
 const method=source.slice(source.indexOf('function restoreCommandDraft('),source.indexOf('\nfunction cancelPick(',source.indexOf('function restoreCommandDraft(')));
 const messages:any[]=[],exports:any={};
 runInNewContext(transpileModule(method+'\nexports.restore=restoreCommandDraft;',{compilerOptions:{target:ScriptTarget.ES2022}}).outputText,{exports,latest:{chatId:'chat'},emit:(message:any)=>messages.push(message)});
 exports.restore({chatId:'chat',message:{type:'gitIndexAction',folder:'/project',action:'stage'}});
 assert.equal(messages.length,1);assert.equal(messages[0].type,'gitIndexResult');assert.match(messages[0].error,/not confirmed/);
 exports.restore({chatId:'other',message:{type:'gitIndexAction',folder:'/other',action:'unstage'}});
 assert.equal(messages.length,1);
});
