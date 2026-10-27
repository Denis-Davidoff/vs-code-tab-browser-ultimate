import { exchangeViewerId } from '../src/core/exchangeViewer';
import {snapshotReplay} from './snapshotEvents';
import { showSentAttachment, showAttachmentPreview } from './sentAttachment';
import {applyPatch,readPatch} from '../src/chat/core/sync';
import { workspaceExchangeSocket } from '../src/core/exchangeCrypto';
import type { ChatViewState, HostToView, ViewToHost } from '../src/chat/chatProtocol';
import type { ChatDraftState } from './chatHost';
import type { ChromeElementAttachment } from '../src/chat/chromeChatProtocol';
import { readExchangeUiCommand, type ExchangeUiMessage } from '../src/chat/exchangeUiProtocol';
import { fileBase64 } from './clipboardFiles';
import { createRemoteTerminalShim } from './remoteTerminal';
import { isTerminalReply, readAgentTerminalFrame, remoteInputFrameMax, splitTerminalData } from '../src/chat/remoteTerminalProtocol';

type Snapshot = {type:'chat.snapshot';uiVersion?:number;chatId:string;view?:ChatViewState;messages?:{role:string;text:string}[]};
const app = document.getElementById('app')!;
const status = document.getElementById('status')!;
// "Connected" is the normal state and says nothing worth a line of its own; only trouble is shown.
const conversation = document.getElementById('conversation') as HTMLSelectElement;
const pointId = new URL(location.href).searchParams.get('point') ?? '';
const storageKey = `ai-browser:web:${pointId}`;
let draftState:ChatDraftState = {};
try { draftState = JSON.parse(sessionStorage.getItem(storageKey) ?? '{}'); } catch { /* Storage can be unavailable. */ }
let socket:WebSocket | undefined, latest:Snapshot | undefined, rendererReady = false, online = false;
let authenticated=false, connecting=true, accessDenied=false;
let handshake:ReturnType<typeof setTimeout>|undefined;
let feedback = '', retry:ReturnType<typeof setTimeout> | undefined, stopped = false;
const eventQueue:HostToView[] = [];
const attachments = new Map<string,ChromeElementAttachment[]>();
const pending = new Map<string,{chatId:string;message?:ExchangeUiMessage;attachmentIds:string[];timer:ReturnType<typeof setTimeout>}>();
let nextReference = 1;
// Git state and the like, carried in each snapshot, for a viewer that connected after it changed.
const replaySnapshots=snapshotReplay(message=>emit(message));
function emit(message:HostToView):void {
  if (!rendererReady) { if(eventQueue.length<100)eventQueue.push(message); return; }
  window.dispatchEvent(new MessageEvent('message',{data:message}));
}
function notice(text:string):void {feedback=text;render();}
/** Terminal tabs: the renderer's terminal messages to and from `terminal.*` frames (see remoteTerminal.ts). */
const terminals=createRemoteTerminalShim({
  // The frame validator wants 8–64 of [A-Za-z0-9_-]; the relay's "legacy" fallback (no sessionStorage) is not one, so terminals get a page-lifetime id.
  viewerId:/^[A-Za-z0-9_-]{8,64}$/.test(exchangeViewerId(pointId))?exchangeViewerId(pointId):'page-'+crypto.getRandomValues(new Uint32Array(2)).join('-'),epoch:()=>shownEpoch,emit,notice,
  send:frame=>{if(!online||socket?.readyState!==WebSocket.OPEN)return false;socket.send(JSON.stringify(frame));return true;},
  // No host clipboard on a website: the viewer's own (copy goes through `copy` below).
  readClipboard:typeof navigator.clipboard?.readText==="function"&&window.isSecureContext?()=>navigator.clipboard.readText():undefined,
  readAgentFrame:readAgentTerminalFrame,isTerminalReply,splitData:splitTerminalData,inputFrameMax:remoteInputFrameMax,
});
function connectionState(connected:boolean):void {
  window.parent.postMessage({type:'ai-browser-connection',connected,online},location.origin);
}
window.addEventListener('message',event=>{
  if(event.origin===location.origin&&event.source===window.parent&&event.data?.type==='ai-browser-request-connection')connectionState(authenticated);
});
/** The agent's numbering of the snapshot on screen, for its patches (`chat.patch`). */
let shownEpoch:string|undefined,shownRev=-1,resyncAt=0;
let resyncTimer:ReturnType<typeof setTimeout>|undefined;
function resync():void {
  if(!latest||socket?.readyState!==WebSocket.OPEN)return;
  // At most once a second — but a request inside that second is deferred, not dropped,
  // or a second patch that did not fit would leave the view stale until the agent's next whole snapshot.
  const wait=1000-(Date.now()-resyncAt);
  if(wait>0){if(!resyncTimer)resyncTimer=setTimeout(()=>{resyncTimer=undefined;resync();},wait);return;}
  resyncAt=Date.now();socket.send(JSON.stringify({type:'chat.resync',id:crypto.randomUUID(),chatId:latest.chatId}));
}
function render():void {
  if(!latest?.view || !rendererReady)return;
  document.getElementById("legacy")?.remove();
  status.dataset.busy=String(connecting||(authenticated&&!online));
  app.hidden=false;
  document.getElementById("waiting")!.hidden=true;
  const view=latest.view;
  const signature=JSON.stringify([latest.chatId,view.tabs.map(tab=>[tab.chatId,tab.title,tab.busy])]);
  if(conversation.dataset.signature!==signature && document.activeElement!==conversation) {
    conversation.replaceChildren(...view.tabs.map(tab=>{const option=document.createElement('option');option.value=tab.chatId;option.textContent=`${tab.busy?'● ':''}${tab.title}`;return option;}));
    conversation.value=latest.chatId;conversation.dataset.signature=signature;
  }
  const local=attachments.get(latest.chatId)??[];
  emit({type:'state',state:{...view,remoteWorkspace:true,suggestions:local.some(a=>a.kind==='page')?[]:view.suggestions??[],attachments:local.map(item=>({id:item.id,label:item.label,kind:item.kind??'file',reference:item.reference,...(item.file&&/^image\/(png|jpeg|webp|gif)$/.test(item.file.mime)?{thumbnail:`data:${item.file.mime};base64,${item.file.base64}`}:{})})),
    blocked:connecting?'Reconnecting…':!online?'Workspace offline. Reconnect your VS Code extension.':view.blocked,
    entries:feedback?[...view.entries,{kind:'notice',text:feedback}]:view.entries,
  }});
  replaySnapshots(view.snapshotEvents);
  terminals.syncTerminals((view.terminals??[]).map(t=>t.id));
}
function result(id:string,ok:boolean,error?:string):void {
  const item=pending.get(id);if(!item)return;
  clearTimeout(item.timer);pending.delete(id);
  if(ok&&item.message?.type==='send')attachments.set(item.chatId,(attachments.get(item.chatId)??[]).filter(a=>!item.attachmentIds.includes(a.id)));
  if(!ok){if(item.message?.type==='send')emit({type:'restoreDraft',chatId:item.chatId,text:item.message.text});
    if(item.message?.type==='gitIndexAction'&&item.chatId===latest?.chatId)emit({type:'gitIndexResult',folder:item.message.folder,error:error??'The Git action could not be completed. Refresh before retrying.'});
    notice(error??'The action could not be completed.');}
  conversation.disabled=false;render();
}
function send(message:ExchangeUiMessage):void {
  if(!latest || !online || socket?.readyState!==WebSocket.OPEN) {
    if(message.type==='gitIndexAction')queueMicrotask(()=>emit({type:'gitIndexResult',folder:message.folder,error:'Workspace offline. Reconnect before updating Git files.'}));
    if(message.type==='send'&&latest)queueMicrotask(()=>emit({type:'restoreDraft',chatId:latest!.chatId,text:message.text}));
    notice('Workspace offline. Your message was not sent.');return;
  }
  const id=crypto.randomUUID(),chatId=latest.chatId;
  const picked=message.type==='send'?(attachments.get(chatId)??[]).slice():[];
  const command=readExchangeUiCommand({type:'chat.command',id,chatId,message,...(picked.length?{attachments:picked}:{})});
  if(!command){if(message.type==='send')queueMicrotask(()=>emit({type:'restoreDraft',chatId,text:message.text}));if(message.type==='gitIndexAction')queueMicrotask(()=>emit({type:'gitIndexResult',folder:message.folder,error:'Git action unavailable. Update the VS Code extension.'}));notice('This action requires a local VS Code window.');return;}
  if(pending.size>=64){if(message.type==='gitIndexAction')queueMicrotask(()=>emit({type:'gitIndexResult',folder:message.folder,error:'Wait for the pending actions to finish.'}));notice('Wait for the pending actions to finish.');return;}
  feedback='';
  const timer=setTimeout(()=>result(id,false,'No acknowledgement. Check the workspace before trying again.'),30000);
  pending.set(id,{chatId,message,attachmentIds:picked.map(a=>a.id),timer});
  socket.send(JSON.stringify(command));
}
async function copy(text:string):Promise<void> {
  if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(text);return;}
  const field=document.createElement('textarea');field.value=text;field.style.position='fixed';field.style.left='-9999px';document.body.append(field);field.select();
  const done=document.execCommand('copy');field.remove();if(!done)throw new Error('Select the text and copy it manually.');
}
function addAttachment(item:Omit<ChromeElementAttachment,'id'|'reference'>,chatId=latest?.chatId,id=crypto.randomUUID()):void {
  if(!chatId)return;
  const draft=attachments.get(chatId)??[];
  const previous=draft.find(a=>a.id===id);
  if(!previous&&draft.length>=8){notice('Attach up to eight files at a time.');return;}
  const total=draft.filter(a=>a.id!==id).reduce((n,a)=>n+(a.file?.base64.length??0),0)+(item.file?.base64.length??0);
  if(total>5_600_000){notice('Attachments must total less than 4 MB.');return;}
  const attachment={...item,id,reference:previous?.reference??`@${nextReference++}`};
  attachments.set(chatId,previous?draft.map(a=>a.id===id?attachment:a):[...draft,attachment]);render();
}
async function addFile(file:File,chatId:string):Promise<void> {
  if(file.size>4_000_000)throw new Error('Files must be smaller than 4 MB.');
  addAttachment({label:file.name,text:`Attached file: ${file.name}`,kind:'file',file:{name:file.name,mime:file.type||'application/octet-stream',base64:await fileBase64(file)}},chatId);
}
function chooseFolderPath():void {
  if(!latest?.view)return;
  const chatId=latest.chatId;
  const dialog=document.createElement('dialog');dialog.className='news-dialog remote-folder-dialog';
  const form=document.createElement('form');
  const heading=document.createElement('h2');heading.textContent='Working folder';
  const label=document.createElement('label');label.textContent='Folder path on the computer running VS Code';
  const input=document.createElement('input');input.type='text';input.required=true;input.maxLength=4096;input.value=latest.view.workdir.current?.path??'';input.placeholder='/path/to/project';label.append(input);
  const actions=document.createElement('div');actions.className='remote-folder-actions';
  const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Cancel';cancel.onclick=()=>dialog.close();
  const submit=document.createElement('button');submit.type='submit';submit.textContent='Use folder';actions.append(cancel,submit);
  form.append(heading,label,actions);dialog.append(form);
  form.onsubmit=event=>{event.preventDefault();const value=input.value.trim();if(!value)return;if(latest?.chatId!==chatId){notice('The conversation changed. Choose the folder again.');dialog.close();return;}send({type:'setWorkdir',path:value});dialog.close();};
  dialog.onclose=()=>dialog.remove();document.body.append(dialog);dialog.showModal();input.focus();input.select();
}
function chooseFile():void {
  if(!latest)return;const chatId=latest.chatId;
  const input=document.createElement('input');input.type='file';input.multiple=true;
  input.addEventListener('change',()=>{void(async()=>{for(const file of Array.from(input.files??[]))await addFile(file,chatId);})().catch(error=>notice(String(error)));});input.click();
}
window.aiBrowserChatHost={
  terminalLease:terminals,
  getState:()=>draftState,
  setState(value){draftState=value;try{sessionStorage.setItem(storageKey,JSON.stringify(value));}catch{/* Keep drafts in memory if storage is full. */}},
  postMessage(message:ViewToHost){
    if(message.type==='ready'){rendererReady=true;render();for(const event of eventQueue.splice(0))emit(event);if(latest)send({type:'ready'});return;}
    if(terminals.fromView(message))return;
    if(message.type==='saveDrafts'||message.type==='tabDraft'||message.type==='reportTheme')return;
    if(message.type==='selectTab'){const tab=latest?.view?.tabs.find(t=>t.id===message.id);if(tab)pinConversation(tab.chatId);return;}
    if(message.type==='copy'){void copy(message.text).catch(error=>notice(String(error)));return;}
    if(message.type==='openLink'&&message.external&&/^https?:\/\//i.test(message.url)){window.open(message.url,'_blank','noopener,noreferrer');return;}
    if(message.type==='exportChat'&&latest?.view){
      const text=latest.view.entries.map(e=>'text'in e?e.text:'').filter(Boolean).join('\n\n');
      if(message.to==='clipboard')void copy(text).catch(error=>notice(String(error)));
      else{const url=URL.createObjectURL(new Blob([text],{type:'text/markdown'}));const a=document.createElement('a');a.href=url;a.download='ai-browser-chat.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}return;
    }
    if(message.type==='chooseWorkdir'){chooseFolderPath();return;}
    if(message.type==='attach'&&message.kind==='file'){chooseFile();return;}
    if(message.type==='pasteFile'&&latest){addAttachment({label:message.name,text:`Attached file: ${message.name}`,kind:'file',file:{name:message.name,mime:message.mime,base64:message.base64}},latest.chatId);emit({type:'pastedFileResult',id:message.id});return;}
    if(message.type==='acceptSuggestion'){if(message.id==='exchange-active-page')send({type:'attach',kind:'page'});return;}
    if(message.type==='removeAttachment'&&latest){attachments.set(latest.chatId,(attachments.get(latest.chatId)??[]).filter(a=>a.id!==message.id));send(message);render();return;}
    if(message.type==='openAttachment'&&message.entry!==undefined){showSentAttachment(latest?.view?.entries,message.entry,message.id);return;}
    if(message.type==='openAttachment'&&message.entry===undefined&&latest){
      const item=(attachments.get(latest.chatId)??[]).find(a=>a.id===message.id);
      if(item){showAttachmentPreview({label:item.label,text:item.text,image:item.file&&/^image\/(png|jpeg|webp|gif)$/.test(item.file.mime)?`data:${item.file.mime};base64,${item.file.base64}`:undefined});return;}
    }
    send(message);
  },
};
/** Shows another of the editor's conversations on the website (a pin); the editor's tab in front is left alone. */
function pinConversation(chatId:string):void {
  if(!latest||socket?.readyState!==WebSocket.OPEN||chatId===latest.chatId)return;
  const id=crypto.randomUUID();conversation.disabled=true;
  const timer=setTimeout(()=>result(id,false,'Could not switch conversations.'),10000);
  pending.set(id,{chatId:latest.chatId,attachmentIds:[],timer});socket.send(JSON.stringify({type:'chat.pin',id,chatId}));
}
conversation.addEventListener('change',()=>pinConversation(conversation.value));
// The renderer's own tab strip picks the conversation, as in Chrome; the select stays hidden.
conversation.hidden=true;
// New chat, history, keep-awake and settings are the renderer's own row now (`remoteBar` in chat.ts).
/** Existing clients can keep reading/sending while the VSIX update is installed. */
function renderLegacy(value:Snapshot):void {
  let panel=document.getElementById('legacy');
  if(!panel){
    panel=document.createElement('section');panel.id='legacy';
    const note=document.createElement('p');note.textContent='Install the updated VS Code extension to enable the full chat interface.';
    const thread=document.createElement('div');thread.id='legacy-messages';
    const form=document.createElement('form'),input=document.createElement('textarea'),button=document.createElement('button');
    input.placeholder='Message your agent…';input.setAttribute('aria-label','Message your agent');button.textContent='Send';
    form.append(input,button);panel.append(note,thread,form);document.getElementById('waiting')!.hidden=true;document.body.append(panel);
    form.addEventListener('submit',event=>{event.preventDefault();if(socket?.readyState===WebSocket.OPEN&&input.value.trim()){socket.send(JSON.stringify({type:'chat.send',id:crypto.randomUUID(),chatId:value.chatId,text:input.value}));input.value='';}});
  }
  const thread=document.getElementById('legacy-messages')!;
  thread.replaceChildren(...(value.messages??[]).map(message=>{const node=document.createElement('p');node.textContent=message.text;node.className=message.role;return node;}));
  status.dataset.busy=String(!online||!latest);status.textContent=online?'Connected · update available':'Workspace offline';
}

function connect():void {
  if(stopped)return;
  clearTimeout(retry);clearTimeout(handshake);
  connecting=true;authenticated=false;online=false;
  connectionState(false);render();
  const base=new URL(location.href).searchParams.get('server')??`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}`;
  const ws=socket=workspaceExchangeSocket(base+'/ws/browser',pointId);status.dataset.busy='true';status.textContent='Connecting…';
  handshake=setTimeout(()=>{if(ws===socket)ws.close();},10000);
  ws.onopen=()=>{if(ws===socket&&!stopped)ws.send(JSON.stringify({type:'auth',version:1,pointId,viewerId:exchangeViewerId(pointId)}));};
  ws.onmessage=event=>{
    if(ws!==socket)return;
    try{const value=JSON.parse(event.data);
      if(terminals.fromAgent(value))return;
      if(value.type==='ready'){clearTimeout(handshake);connecting=false;authenticated=true;online=value.online;status.dataset.busy=String(!online||!latest);status.textContent=online?'Connected':'Workspace offline';connectionState(true);render();if(latest&&rendererReady)send({type:'ready'});}
      else if(value.type==='presence'){online=value.online;status.dataset.busy=String(!online||!latest);status.textContent=online?'Connected':'Workspace offline';connectionState(true);render();}
      else if(value.type==='chat.snapshot'){
        if(value.uiVersion!==1||!value.view){renderLegacy(value);return;}
        clearTimeout(resyncTimer);resyncTimer=undefined;const first=!latest,epoch=shownEpoch;latest=value;shownEpoch=typeof value.epoch==='string'?value.epoch:undefined;if(shownEpoch!==epoch)terminals.reconnected();shownRev=typeof value.rev==='number'?value.rev:-1;feedback='';render();if(first&&rendererReady)send({type:'ready'});
      }else if(value.type==='chat.patch'){
        // A patch of the view on screen; one that does not fit asks for the whole snapshot.
        const patch=readPatch(value.patch);
        const view=patch&&latest?.view&&value.epoch===shownEpoch&&value.chatId===latest.chatId?applyPatch(latest.view as unknown as Record<string,unknown>,shownRev,patch):undefined;
        if(view){latest={...latest!,...(value.top??{}),view:view as unknown as ChatViewState};shownRev=patch!.rev;render();}
        else resync();
      }else if(value.type==='chat.event'){
        if(value.message?.type==='exchangeAttachment'){
          const item=value.message;
          if(item.removed){attachments.set(value.chatId,(attachments.get(value.chatId)??[]).filter(a=>a.id!==item.id));render();}
          else addAttachment({label:item.label,text:item.text,kind:item.kind,file:item.file},value.chatId,item.id);
        }else if(!latest||value.chatId===latest.chatId){
          if(value.message?.type==='chromeAttachment')addAttachment({label:value.message.label,text:value.message.text,kind:'file'});
          else if(value.message?.type==='exchangeBrowser'){if(value.message.message)notice(value.message.message);window.parent.postMessage({type:'ai-browser-swipe',page:'browser'},location.origin);}
          else emit(value.message);
        }
      }else if(value.type==='command.result')result(value.id,value.ok,value.error);
    }catch{notice('The server returned an invalid response.');}
  };
  ws.onclose=event=>{if(ws!==socket)return;clearTimeout(handshake);accessDenied=event.code===1008;authenticated=false;online=false;connecting=event.code!==1008&&!stopped;connectionState(false);status.dataset.busy=String(connecting);status.textContent=event.code===1008?'Sign in again to reconnect.':'Disconnected. Reconnecting…';
    for(const id of [...pending.keys()])result(id,false,'Connection lost. Check the chat before retrying.');render();
    if(!stopped&&event.code!==1008)retry=setTimeout(connect,2000);
  };
  ws.onerror=()=>{if(ws!==socket||stopped)return;status.dataset.busy='true';status.textContent='Reconnecting…';ws.close();};
}
function resumeConnection():void {
  if(document.hidden||accessDenied||(!stopped&&connecting&&socket?.readyState===WebSocket.CONNECTING))return;
  stopped=false;
  // Mobile browsers can leave a dead socket marked OPEN after suspending a tab.
  const previous=socket;socket=undefined;previous?.close();
  for(const id of [...pending.keys()])result(id,false,'Connection interrupted. Check the chat before retrying.');
  connect();
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)resumeConnection();});
window.addEventListener('online',resumeConnection);
window.addEventListener('pageshow',event=>{if(event.persisted)resumeConnection();});
window.addEventListener('pagehide',()=>{stopped=true;clearTimeout(retry);clearTimeout(handshake);socket?.close();for(const item of pending.values())clearTimeout(item.timer);});
window.addEventListener('touchstart',event=>{if(event.target instanceof Element&&event.target.closest('input,textarea,select,[contenteditable="true"]'))return;const touch=event.touches[0];if(!touch)return;gesture={x:touch.clientX,y:touch.clientY};},{passive:true});
let gesture:{x:number;y:number}|undefined;
window.addEventListener('touchend',event=>{const touch=event.changedTouches[0],start=gesture;gesture=undefined;if(touch&&start&&start.x-touch.clientX>70&&Math.abs(start.y-touch.clientY)<45)window.parent.postMessage({type:'ai-browser-swipe',page:'browser'},location.origin);},{passive:true});
connect();
