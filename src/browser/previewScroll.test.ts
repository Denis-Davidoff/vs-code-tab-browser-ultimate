import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {createPreviewScrollQueue,type ScrollInput} from '../../exchange-server/apps/web/app/components/preview-scroll.ts';

test('a trackpad burst merges into one bounded command and waits for its receipt',t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const sent:ScrollInput[]=[],done:((ok:boolean)=>void)[]=[];
 const queue=createPreviewScrollQueue((input,complete)=>{sent.push(input);done.push(complete);return true;});
 for(let i=0;i<100;i++)queue.enqueue(.5,.5,0,10);
 t.mock.timers.tick(16);assert.equal(sent.length,1);assert.equal(sent[0].deltaY,1000);
 for(let i=0;i<300;i++)queue.enqueue(.6,.7,0,10);
 t.mock.timers.tick(1000);assert.equal(sent.length,1,'never fills the remote command queue');
 done.shift()!(true);t.mock.timers.tick(16);assert.equal(sent[1].deltaY,2000);assert.equal(sent[1].x,.6);
 done.shift()!(true);t.mock.timers.tick(16);assert.equal(sent[2].deltaY,1000);
 done.shift()!(true);queue.reset();
});
test('a failed scroll discards pending movement; switching tabs invalidates late receipts',t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const sent:ScrollInput[]=[],done:((ok:boolean)=>void)[]=[];
 const queue=createPreviewScrollQueue((input,complete)=>{sent.push(input);done.push(complete);return true;});
 queue.enqueue(.5,.5,0,100);t.mock.timers.tick(16);
 queue.enqueue(.5,.5,0,200);done.shift()!(false);t.mock.timers.tick(1000);assert.equal(sent.length,1);
 queue.enqueue(.5,.5,0,300);t.mock.timers.tick(16);
 queue.reset();queue.enqueue(.2,.2,0,50);t.mock.timers.tick(16);
 done.shift()!(true);queue.enqueue(.2,.2,0,20);t.mock.timers.tick(100);assert.equal(sent.length,3);
 done.shift()!(true);t.mock.timers.tick(16);assert.equal(sent[3].deltaY,20);
 queue.reset();
});
