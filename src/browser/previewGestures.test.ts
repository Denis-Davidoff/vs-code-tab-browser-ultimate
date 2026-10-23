import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

function gestures() {
 const source=readFileSync('exchange-server/apps/web/app/workspace/[id]/remote-browser.tsx','utf8');
 const handlers=source.slice(source.indexOf('  function pointerDown('),source.indexOf('  function command('));
 const wheel=source.slice(source.indexOf('    const wheel = (event: WheelEvent)'),source.indexOf('    let gestureZoom'));
 const node={scrollLeft:100,scrollTop:50,clientHeight:600,setPointerCapture(_id:number){}};
 const zoomRef={current:1},input:any[]=[],zooms:number[]=[];
 const exported:any={};let switched=0;
 runInNewContext(transpileModule(handlers+wheel+'\nexports.down=pointerDown;exports.move=pointerMove;exports.up=pointerUp;exports.wheel=wheel;', {compilerOptions:{module:ModuleKind.CommonJS,target:ScriptTarget.ES2022}}).outputText,{
  exports:exported,pointers:{current:new Map()},touch:{current:null},pinch:{current:null},frameRef:{current:{width:800,height:600}},image:{current:{getBoundingClientRect:()=>({width:400,height:600})}},scrollQueue:{current:{reset(){},enqueue:(x:number,y:number,deltaX:number,deltaY:number)=>input.push({action:"scroll",x,y,deltaX,deltaY})}},ignoreClickUntil:{current:0},zoomRef,node,
  point:()=>({x:.5,y:.5}),input:(value:any)=>input.push(value),onShowChat:()=>switched++,matchMedia:()=>({matches:true}),changeZoom:(value:number)=>{zoomRef.current=value;zooms.push(value);},
 });
 const event=(id:number,x:number,y:number)=>({pointerId:id,pointerType:'touch',clientX:x,clientY:y,currentTarget:node});
 return {handlers:exported,event,node,input,zoomRef,zooms,switched:()=>switched};
}
test('pinching scales the preview without sending page input when either finger lifts',()=>{
 const h=gestures();h.handlers.down(h.event(1,100,100));h.handlers.down(h.event(2,200,100));h.handlers.move(h.event(2,300,100));
 assert.equal(h.zoomRef.current,2);h.handlers.up(h.event(2,300,100));h.handlers.up(h.event(1,100,100));assert.equal(h.input.length,0);
});
test('one finger pans a zoomed preview instead of scrolling or clicking the remote page',()=>{
 const h=gestures();h.zoomRef.current=2;h.handlers.down(h.event(1,100,100));h.handlers.move(h.event(1,60,80));h.handlers.up(h.event(1,60,80));
 assert.equal(h.node.scrollLeft,140);assert.equal(h.node.scrollTop,70);assert.equal(h.input.length,0);
});
test('at fit scale vertical swipes scroll the remote page and right swipes return to chat',()=>{
 const h=gestures();h.handlers.down(h.event(1,100,200));h.handlers.move(h.event(1,100,100));assert.equal(h.input.length,1,'scrolls before the finger lifts');h.handlers.up(h.event(1,100,100));assert.equal(h.input[0].action,'scroll');assert.equal(h.input[0].deltaY,200);
 h.handlers.down(h.event(1,100,100));h.handlers.up(h.event(1,210,100));assert.equal(h.switched(),1);assert.equal(h.input.length,1);
});
test('desktop pinch wheel zooms while an ordinary wheel scrolls the remote page',()=>{
 const h=gestures();let prevented=false;
 const wheel={ctrlKey:true,metaKey:false,deltaX:0,deltaY:-50,deltaMode:0,clientX:150,clientY:150,preventDefault(){prevented=true;}};
 h.handlers.wheel(wheel);assert.equal(prevented,true);assert.ok(h.zoomRef.current>1);assert.equal(h.input.length,0);
 h.zoomRef.current=1;h.handlers.wheel({...wheel,ctrlKey:false,deltaY:100});assert.equal(h.input[0].action,'scroll');assert.equal(h.input[0].deltaY,100);
});
