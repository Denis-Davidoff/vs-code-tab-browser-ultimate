/** Runs only in our isolated CDP world. No page text is interpreted as HTML. */
export const annotationSource = String.raw`(() => {
 if (globalThis.__aiBrowserAnnotations) return globalThis.__aiBrowserAnnotations;
 const host = document.createElement('div');
 host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;';
 const shadow = host.attachShadow({mode:'closed'});
 const style = document.createElement('style');
 style.textContent = ':host{color-scheme:light}*{box-sizing:border-box}button,textarea{font:13px system-ui}button{cursor:pointer;color:#172033}button:focus-visible,textarea:focus-visible{outline:2px solid #2563eb}'
  +'.note{position:fixed;pointer-events:auto;font:13px system-ui;color:#172033}.badge{width:29px;height:29px;padding:0;border-radius:50%;background:var(--annotation-color,#2563eb);color:white;font-weight:bold;border:2px solid white;box-shadow:0 2px 8px #0005}.missing .badge{border-style:dashed}'
  +'.card{position:relative;width:260px;max-width:calc(100vw - 16px);padding:3px;background:#fff;border:1px solid var(--annotation-color,#2563eb);border-radius:7px;box-shadow:0 3px 18px #0004}.head{display:flex;gap:3px;align-items:center;height:27px;padding:0 1px}.tag{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#536079;font:12px monospace}.missing .tag{color:#a65b0a}.head button{display:grid;place-items:center;flex:none;width:24px;height:24px;border:0;border-radius:4px;background:transparent;color:#536079;padding:4px}.head button:hover{background:#e9eef7}.head .number{min-width:21px;width:auto;height:21px;padding:0 5px;background:var(--annotation-color,#2563eb);color:#fff;font:600 12px system-ui}.head .number:hover{background:var(--annotation-color,#2563eb);filter:brightness(1.15)}'
  +'.palette{position:absolute;left:3px;right:3px;top:30px;display:grid;grid-template-columns:repeat(5,1fr);gap:6px;padding:8px;background:white;border:1px solid #ccd5e3;border-radius:6px;box-shadow:0 3px 12px #0003;z-index:1}.palette button{width:25px;height:25px;justify-self:center;border:2px solid transparent;border-radius:50%;padding:0}.palette button[aria-pressed=true]{outline:2px solid #172033;outline-offset:2px}'
  +'.card textarea{display:block;width:100%;height:124px;min-height:60px;max-height:calc(100vh - 60px);resize:vertical;color:#172033;background:#fff;border:0;border-radius:4px;padding:4px;margin:0;line-height:1.4}.highlight{position:fixed;border:2px solid #2563eb;background:#2563eb18;pointer-events:none;border-radius:3px}[hidden]{display:none!important}';
 if(typeof CSSStyleSheet==='function'){const sheet=new CSSStyleSheet();sheet.replaceSync(style.textContent);shadow.adoptedStyleSheets=[sheet];}else{shadow.append(style);}
 function button(text, action) { const b=document.createElement('button');b.type='button';b.textContent=text;b.addEventListener('click',e=>{e.stopPropagation();if(e.isTrusted)action();});return b; }
 function iconButton(label,d,action){const b=button('',action);b.title=label;b.setAttribute('aria-label',label);const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width','15');svg.setAttribute('height','15');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.7');svg.setAttribute('aria-hidden','true');const p=document.createElementNS('http://www.w3.org/2000/svg','path');p.setAttribute('d',d);svg.append(p);b.append(svg);return b;}
 let mode=false, url=location.href, records=[], targets=new Map(), nodes=new Map(), nextNumber=1;
 const colors=[['#2563eb','Blue'],['#7c3aed','Purple'],['#be185d','Pink'],['#b91c1c','Red'],['#c2410c','Orange'],['#a16207','Amber'],['#15803d','Green'],['#0f766e','Teal'],['#0369a1','Cyan'],['#475569','Gray']];
 const highlight=document.createElement('div');highlight.className='highlight';highlight.hidden=true;shadow.append(highlight);
 function mount(){if(!host.isConnected && document.documentElement)document.documentElement.append(host);}
 function send(type,id){globalThis.__aiBrowserAnnotationChanged(JSON.stringify({type,url,records,id}));}
 function inside(event){return event.composedPath().includes(host);}
 function snippet(el){
  const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let result='',node,visited=0;
  while((node=walker.nextNode())&&visited++<400&&result.length<180){if(!node.parentElement?.closest('script,style,noscript,input,textarea,select,[contenteditable]'))result+=' '+node.data;}
  return result.replace(/\s+/g,' ').trim().slice(0,180);
 }
 function uuid(){const h=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);}
 function selector(el){
  if(el.id&&el.id.length<1000){const s='#'+CSS.escape(el.id);if(s.length<4000&&document.querySelectorAll(s).length===1)return {selector:s,strong:true};}
  for(const attr of ['data-testid','aria-label']){const value=el.getAttribute(attr);if(value&&value.length<160){const s=el.localName+'['+attr+'='+JSON.stringify(value)+']';try{if(document.querySelectorAll(s).length===1)return {selector:s,strong:true};}catch{}}}
  const parts=[];for(let node=el;node&&node.nodeType===1;node=node.parentElement){let index=1;for(let sib=node.previousElementSibling;sib;sib=sib.previousElementSibling)if(sib.localName===node.localName)index++;parts.unshift(CSS.escape(node.localName)+':nth-of-type('+index+')');if(parts.length>=20)break;}
  const s=parts.join(' > ');return {selector:s.length<=4000?s:'',strong:false};
 }
 function resolve(record){
  const known=targets.get(record.id);if(known&&known.isConnected)return known;
  if(!record.element.selector)return undefined;
  try{const matches=document.querySelectorAll(record.element.selector);const el=matches[0];
   if(matches.length===1&&el.localName===record.element.tag&&(record.element.strong||snippet(el)===record.element.text)){targets.set(record.id,el);return el;}
  }catch{} return undefined;
 }
 function setMode(value){mode=value;highlight.hidden=true;}
 function collapse(record){const node=nodes.get(record.id);if(node){node.open=false;node.card.hidden=true;node.badge.hidden=false;node.palette.hidden=true;}layout();}
 function render(){
  for(const node of nodes.values())node.root.remove();nodes.clear();
  for(const record of records){
   const root=document.createElement('div');root.className='note';root.style.setProperty('--annotation-color',record.color||colors[0][0]);
   const card=document.createElement('div');card.className='card';card.hidden=true;
   const badge=button(String(record.number),()=>{const n=nodes.get(record.id);n.open=true;card.hidden=false;badge.hidden=true;layout();textarea.focus();});badge.className='badge';badge.title='Annotation '+record.number+': '+record.text;
   const palette=document.createElement('div');palette.className='palette';palette.hidden=true;palette.setAttribute('aria-label','Annotation color');
   const label=button(String(record.number),()=>{palette.hidden=!palette.hidden;});label.className='number';label.title='Choose annotation color';label.setAttribute('aria-label','Choose color for annotation '+record.number);
   for(const [color,name] of colors){const swatch=button('',()=>{record.color=color;root.style.setProperty('--annotation-color',color);for(const b of palette.children)b.setAttribute('aria-pressed',b.title===name?'true':'false');palette.hidden=true;send('change');label.focus();});swatch.title=name;swatch.style.background=color;swatch.setAttribute('aria-label',name);swatch.setAttribute('aria-pressed',(record.color||colors[0][0])===color?'true':'false');palette.append(swatch);}
   const head=document.createElement('div');head.className='head';
   const tag=document.createElement('span');tag.className='tag';tag.textContent=record.element.tag;
   const copy=iconButton('Copy annotation (note, element and page)','M9 9h11v12H9z M5 16H3V3h12v2',()=>send('copy',record.id));
   const remove=iconButton('Delete annotation','M3 6h18 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7',()=>send('requestDelete',record.id));
   const addMore=iconButton('Add annotation marker','M12 5v14 M5 12h14',()=>{collapse(record);if(records.length<50){setMode(true);mount();}});
   head.append(label,tag,copy,remove,addMore);
   const textarea=document.createElement('textarea');textarea.maxLength=2000;textarea.placeholder='Describe the change or leave a comment…';textarea.value=record.text;textarea.setAttribute('aria-label','Annotation '+record.number+' text');
   textarea.addEventListener('focus',()=>{palette.hidden=true;});
   textarea.addEventListener('input',e=>{e.stopPropagation();if(!e.isTrusted)return;record.text=textarea.value.slice(0,2000);badge.title='Annotation '+record.number+': '+record.text;send('change');});
   textarea.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Escape'&&!e.isComposing){collapse(record);badge.focus();}});
   palette.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.isComposing){e.stopPropagation();palette.hidden=true;label.focus();}});
   card.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.isComposing){e.preventDefault();e.stopPropagation();if(!palette.hidden){palette.hidden=true;label.focus();}else{collapse(record);badge.focus();}}});
   root.addEventListener('focusout',()=>{setTimeout(()=>{const n=nodes.get(record.id);if(n&&n.open&&(!document.hasFocus()||!root.contains(shadow.activeElement)))collapse(record);},0);});
   card.append(head,textarea,palette);root.append(badge,card);shadow.append(root);nodes.set(record.id,{root,badge,card,tag,textarea,palette,open:false});
  }layout();
 }
 function layout(){
  highlight.hidden=highlight.hidden||!mode;
  const occupied=[];let lost=0;
  for(const record of records){const node=nodes.get(record.id);if(!node)continue;
   const el=resolve(record);const rect=el?.getBoundingClientRect();const visible=!!rect&&rect.width>0&&rect.height>0;
   node.tag.title=(!el?'Element not found — ':'')+record.element.selector;
   node.badge.title=(!el?'Element not found — ':'')+'Annotation '+record.number+': '+record.text;
   node.root.classList.toggle('missing',!el);
   const width=node.open?Math.min(260,innerWidth-16):29,height=node.open?node.card.offsetHeight||160:29;
   let left=visible?rect.right-15:innerWidth-width-12;let top=visible?rect.top-12:60+(lost++)*34;
   left=Math.max(8,Math.min(left,innerWidth-width-8));top=Math.max(8,Math.min(top,innerHeight-height-8));
   if(!node.open){while(occupied.some(p=>Math.abs(p.left-left)<30&&Math.abs(p.top-top)<30)&&top<innerHeight-40)top+=32;occupied.push({left,top});}
   node.root.style.left=left+'px';node.root.style.top=top+'px';
  }
 }
 function move(event){if(!mode||inside(event)||!event.isTrusted)return;const el=event.target;if(!(el instanceof Element))return;const r=el.getBoundingClientRect();highlight.hidden=false;highlight.style.cssText='left:'+r.left+'px;top:'+r.top+'px;width:'+r.width+'px;height:'+r.height+'px';}
 function pick(event){
  if(!mode||inside(event)||!event.isTrusted)return;
  if(location.href!==url){navigate();return;}
  event.preventDefault();event.stopImmediatePropagation();
  if(records.length>=50){setMode(false);return;}
  const el=event.target;if(!(el instanceof Element)||el.getRootNode()!==document)return;
  const locator=selector(el);const record={id:uuid(),number:nextNumber++,createdAt:Date.now(),text:'',color:colors[0][0],element:{...locator,tag:el.localName.slice(0,100),text:snippet(el),role:(el.getAttribute('role')||'').slice(0,80)}};
  records.push(record);targets.set(record.id,el);setMode(false);render();send('change');
  const node=nodes.get(record.id);node.open=true;node.badge.hidden=true;node.card.hidden=false;layout();node.textarea.focus();
 }
 function down(event){if(mode&&!inside(event)&&event.isTrusted){event.preventDefault();event.stopImmediatePropagation();}}
 function key(event){if(event.key==='Escape'&&!event.isComposing&&mode){event.preventDefault();event.stopPropagation();setMode(false);}}
 window.addEventListener('pointermove',move,true);window.addEventListener('pointerdown',down,true);window.addEventListener('click',pick,true);window.addEventListener('keydown',key,true);
 function navigate(){url=location.href;setMode(false);records=[];targets.clear();render();send('navigate');}
 const timer=setInterval(()=>{
  if(location.href!==url){navigate();}
  mount();layout();
 },150);
 const api={
  hydrate(data){url=location.href;records=data.records;nextNumber=data.nextNumber;const ids=new Set(records.map(r=>r.id));for(const id of targets.keys())if(!ids.has(id))targets.delete(id);render();},
  start(data){api.hydrate(data);setMode(true);mount();layout();},
  collect(){return {url:location.href,records:records.map(r=>({...r,elementFound:!!resolve(r)}))};},
  add(sel,text,color,id){
   if(location.href!==url)navigate();
   if(records.length>=50)return {error:'This page already has 50 annotations. Remove a note before adding another.'};
   let el;try{el=document.querySelector(sel);}catch{return {error:'The selector is not valid CSS.'};}
   if(!el)return {error:'No element on the page matches the selector.'};
   const locator=selector(el);const record={id,number:nextNumber++,createdAt:Date.now(),text:String(text).slice(0,2000),color,element:{...locator,tag:el.localName.slice(0,100),text:snippet(el),role:(el.getAttribute('role')||'').slice(0,80)}};
   records.push(record);targets.set(record.id,el);render();send('change');
   return {id:record.id,number:record.number,url};
  },
  remove(ids,expectedUrl){if(expectedUrl!==undefined&&location.href!==expectedUrl)throw new Error('Page changed before annotation removal.');records=records.filter(r=>!ids.includes(r.id));for(const id of ids)targets.delete(id);render();},
  dispose(){clearInterval(timer);window.removeEventListener('pointermove',move,true);window.removeEventListener('pointerdown',down,true);window.removeEventListener('click',pick,true);window.removeEventListener('keydown',key,true);host.remove();delete globalThis.__aiBrowserAnnotations;}
 };
 globalThis.__aiBrowserAnnotations=api;mount();return api;
})()`;
