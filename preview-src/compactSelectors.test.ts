import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {transpileModule,ModuleKind,ScriptTarget} from 'typescript';
const source=readFileSync('preview-src/chat.ts','utf8');
function fn(name:string){return new RegExp(`function ${name}\\([^]*?\\n}`).exec(source)![0];}
function fixture(){
 const opened:any[]=[],clicked:string[]=[],dispatched:any[]=[];
 function node(){const classes=new Set<string>();return {parentElement:null as any,attributes:{} as Record<string,string>,hover:false,focus:false,
  classList:{contains:(name:string)=>classes.has(name),add:(...names:string[])=>names.forEach(name=>classes.add(name)),remove:(...names:string[])=>names.forEach(name=>classes.delete(name))},
  append(child:any){child.parentElement=this;},prepend(child:any){child.parentElement=this;},
  setAttribute(name:string,value:string){this.attributes[name]=value;},matches(){return this.hover;},querySelector(){return this.focus?{}:null;},
 };}
 const compactSelector=node(),selectorStrip=node(),toolbarSettings=node(),selectorControls=node();selectorControls.parentElement=toolbarSettings;
 const state={selection:{agent:'codex',model:'sol',effort:'high'},agents:[{id:'codex',name:'Codex',models:[{id:'sol',label:'GPT-6.1-Sol',efforts:['low','medium','high']}]}]};
 let timeout=()=>{};
 const context:any={exports:{},state,compactSelector,selectorStrip,selectorControls,toolbarSettings,selectorStripTimer:undefined,
  toolbar:{classList:{contains:()=>true}},scheduleToolbarLayout(){},toolbarLayoutShape:'',clearTimeout(){},setTimeout(fn:()=>void){timeout=fn;return 1;},
  menu:node(),approvalPopup:node(),
  showAnchoredOverlay:(popup:any,anchor:any,align:string)=>{popup.classList.add('open');opened.push([popup,anchor,align]);},
  closePopups:(except:any)=>{if(except!==selectorStrip)context.exports.restore();},
  agentPill:{disabled:false,click:()=>clicked.push('platform')},modelPill:{disabled:false,click:()=>clicked.push('model')},
  approveToggle:{textContent:'Ask',click:()=>clicked.push('permissions')},ultracodeBox:{hidden:true},ultracodeInput:{checked:false,click:()=>clicked.push('ultracode')},
  effortRange:{value:'0',dispatchEvent:(event:any)=>dispatched.push(event)},Event,
  labelOf:(value:string)=>value.toUpperCase(),
 };
 runInNewContext(transpileModule(['selectorAnchor','restoreSelectorControls','openCompactSelectors','scheduleSelectorStripClose'].map(fn).join('\n')+'\nexports.open=openCompactSelectors;exports.anchor=selectorAnchor;exports.restore=restoreSelectorControls;exports.leave=scheduleSelectorStripClose;', {compilerOptions:{module:ModuleKind.CommonJS,target:ScriptTarget.ES2022}}).outputText,context);
 return {context,opened,clicked,dispatched,compactSelector,runTimer:()=>timeout()};
}
test('expanded strip reuses the original controls and opens directly above the summary',()=>{
 const f=fixture();const controls=f.context.selectorControls;f.context.exports.open();
 assert.equal(controls.parentElement,f.context.selectorStrip);
 assert.equal(f.opened[0][0],f.context.selectorStrip);assert.equal(f.opened[0][1],f.compactSelector);assert.equal(f.opened[0][2],'center');
 assert.equal(f.compactSelector.attributes['aria-expanded'],'true');
 f.context.exports.open();assert.equal(f.opened.length,1,'repeated hover must not toggle or recreate the strip');
 assert.equal(f.context.exports.anchor(f.context.modelPill),f.context.modelPill);
});
test('closing the strip restores the same live controls without resetting effort',()=>{
 const f=fixture();f.context.effortRange.value='2';f.context.exports.open();f.context.exports.restore();
 assert.equal(f.context.selectorControls.parentElement,f.context.toolbarSettings);
 assert.equal(f.context.effortRange.value,'2');assert.equal(f.compactSelector.attributes['aria-expanded'],'false');
 assert.equal(f.context.selectorStrip.classList.contains('open'),false);
});
test('hover exit tolerates moving to the strip and keeps existing selector menus usable',()=>{
 const f=fixture();f.context.exports.open();f.context.selectorStrip.hover=true;
 f.context.exports.leave();f.runTimer();assert.ok(f.context.selectorStrip.classList.contains('open'));
 f.context.selectorStrip.hover=false;f.context.menu.classList.add('open');
 f.context.exports.leave();f.runTimer();assert.ok(f.context.selectorStrip.classList.contains('open'));
 f.context.menu.classList.remove('open');f.context.exports.leave();f.runTimer();assert.equal(f.context.selectorStrip.classList.contains('open'),false);
});

test('summary keeps its effort indicator visible even when a model has no effort setting',()=>{
 const f=fixture();const node=()=>({dataset:{},hidden:false,textContent:'',setAttribute(){}});
 Object.assign(f.context,{
  compactSelectorLabel:node(),compactEffortDot:node(),effortBox:node(),
  hoverTip:{anchor:null},setPill:(target:any,label:string)=>target.textContent=label,
  updateEffortAppearance:(value:string)=>f.context.compactEffortDot.dataset.effort=value,
 });
 f.context.ultracodeBox.dataset={};f.context.compactSelector.setAttribute=()=>{};
 runInNewContext(transpileModule(fn('renderSelectors')+'\nexports.render=renderSelectors;',{compilerOptions:{module:ModuleKind.CommonJS,target:ScriptTarget.ES2022}}).outputText,f.context);
 f.context.exports.render(f.context.state);
 assert.equal(f.context.compactSelectorLabel.textContent,'Codex › GPT-6.1-Sol');
 assert.equal(f.context.compactEffortDot.dataset.effort,'high');assert.equal(f.context.compactEffortDot.hidden,false);
 f.context.state.agents[0].models[0].efforts=[];f.context.state.selection.effort=undefined;
 f.context.exports.render(f.context.state);
 assert.equal(f.context.compactEffortDot.hidden,false);assert.equal(f.context.compactEffortDot.dataset.effort,'minimal');
});

test('toolbar collapses settings without adding a row and restores full selectors when widened',()=>{
 const f=fixture();const classes=new Set<string>();let scheduled:()=>void=()=>{};
 f.context.toolbar={clientWidth:300,classList:{add:(name:string)=>classes.add(name),remove:(...names:string[])=>names.forEach(name=>classes.delete(name)),contains:(name:string)=>classes.has(name)}};
 const node=(width:number)=>({hidden:false,textContent:'',getBoundingClientRect:()=>({width})});
 Object.assign(f.context,{
  toolbarLayoutFrame:undefined,toolbarLayoutShape:'',requestAnimationFrame:(fn:()=>void)=>{scheduled=fn;return 1;},
  getComputedStyle:()=>({font:'12px sans-serif',paddingLeft:'4',paddingRight:'6',columnGap:'8'}),
  toolbarSettings:{style:{removeProperty(){}},getBoundingClientRect:()=>({width:classes.has('compact-effort')?300:420})},
  toolbarAttachments:node(80),toolbarEnd:node(80),agentsButton:node(0),contextButton:node(0),
  effortBox:{hidden:false},menu:{classList:{contains:()=>false}},approvalPopup:{classList:{contains:()=>false}},
 });
 runInNewContext(transpileModule(fn('scheduleToolbarLayout')+'\nexports.layout=scheduleToolbarLayout;',{compilerOptions:{module:ModuleKind.CommonJS,target:ScriptTarget.ES2022}}).outputText,f.context);
 f.context.exports.layout();scheduled();assert.ok(classes.has('compact-selector-mode'));assert.ok(!classes.has('stacked'));
 f.context.toolbar.clientWidth=900;f.context.exports.layout();scheduled();assert.ok(!classes.has('compact-selector-mode'));assert.ok(!classes.has('compact-effort'));
 f.context.toolbarSettings.getBoundingClientRect=()=>({width:100});f.context.toolbar.clientWidth=500;f.context.exports.layout();scheduled();assert.ok(!classes.has('compact-selector-mode'),'full controls stay visible whenever they fit, even below 760px');assert.ok(!classes.has('compact-effort'));
 f.context.toolbarSettings.getBoundingClientRect=()=>({width:1000});f.context.toolbar.clientWidth=900;f.context.exports.layout();scheduled();assert.ok(classes.has('compact-selector-mode'),'long controls collapse when they overflow, even above 760px');
});
