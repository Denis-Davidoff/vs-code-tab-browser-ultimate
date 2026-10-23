import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { isExchangeControlPage, readRemoteBrowserInput } from './remoteBrowserProtocol.ts';
test('remote input accepts normalized clicks, bounded scroll, Unicode text and HTTP navigation',()=>{
 for(const input of [
  {action:'click',x:0.5,y:1,button:'left',count:2},
  {action:'move',x:0.25,y:0.75},
  {action:'scroll',x:0,y:0,deltaX:0,deltaY:-2000},
  {action:'text',text:'Привет 👋'},
  {action:'key',key:'Enter',modifiers:0},
  {action:'navigate',url:'http://localhost:5173/path'},
  {action:'reload'},
  {action:'close'},
 ])assert.deepEqual(readRemoteBrowserInput(input),input);
});
test('remote input rejects arbitrary CDP, invalid coordinates, oversized text and local files',()=>{
 for(const input of [
  {action:'click',x:NaN,y:0,button:'left',count:1},
  {action:'click',x:-0.1,y:0,button:'left',count:1},
  {action:'click',x:0,y:0,button:'left',count:1,method:'Runtime.evaluate'},
  {action:'scroll',x:0,y:0,deltaX:0,deltaY:2001},
  {action:'key',key:'Enter',modifiers:16},
  {action:'text',text:'x'.repeat(4001)},
  {action:'navigate',url:'file:///etc/passwd'},
  {action:'navigate',url:'javascript:alert(1)'},
  {action:'navigate',url:'https://user:pass@example.com'},
  {action:'devtools'},
  {action:'Runtime.evaluate',expression:'process.exit()'},
 ])assert.equal(readRemoteBrowserInput(input),undefined);
});

test('stream sources exclude the remote workspace, including a LAN alias, while keeping real websites',()=>{
 const id='b992f496-44cc-4f54-968b-c474b84df86a',server='ws://127.0.0.1:3000';
 for(const url of [`http://localhost:3000/workspace/${id}`,`http://192.168.1.172:3000/workspace/${id}/?test=1`,'http://localhost:3000/workspace/another-point',`http://localhost:3000/remote-chat/index.html?point=${id}`])assert.equal(isExchangeControlPage(url,server,id),true,url);
 for(const url of ['https://accounts.google.com/v3/signin/identifier','http://localhost:5173','http://localhost:5173/workspace/project','https://example.com/workspace/another-point'])assert.equal(isExchangeControlPage(url,server,id),false,url);
});
