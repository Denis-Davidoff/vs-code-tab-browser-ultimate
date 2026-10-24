import { encryptedExchangeSocket, type ExchangeCipher } from '../core/exchangeCrypto';
import type * as vscode from 'vscode';
import type { BrowserController } from './browserController';
import { isExchangeControlPage, readRemoteBrowserInput } from './remoteBrowserProtocol';

/** A separate media socket: dropped frames never delay chat commands. */
export class ExchangeBrowser {
 private socket?: WebSocket;
 private stopped=false;
 private ready=false;
 private viewers=false;
 viewerCount=0;
 onViewers?:()=>void;
 private stream?:vscode.Disposable;
 private selected?:string;
 private generation=0;
 /** The preview whose capture is still starting; a repeat selection or viewer notice must not start a second one. */
 private starting?:{tabId:string;generation:number;at:number};
 private retry?:ReturnType<typeof setTimeout>;
 private poll?:ReturnType<typeof setInterval>;
 private handshake?:ReturnType<typeof setTimeout>;
 private polling=false;
 private chain=Promise.resolve();
 private queued=0;
 private publishedPage='null';
 private tabs:{id:string;title:string;url:string;kind:'chrome'|'vscode'}[]=[];
 /** Called when the selected page or its address changes, so the chat can offer it. */
 onPage?:()=>void;
 /** The page the website streams, read from the last listing; nothing while no viewer watches. */
 selectedPage():{id:string;title:string;url:string}|undefined{return this.selected&&this.viewers?this.tabs.find(t=>t.id===this.selected):undefined;}
 private publishPage():void{
  const page=JSON.stringify(this.selectedPage()??null);
  if(page!==this.publishedPage){this.publishedPage=page;this.onPage?.();}
 }
 async selectedTab():Promise<vscode.BrowserTab> {
  if(!this.selected)throw new Error('Select a tab in the website Browser panel first.');
  const tab=await this.browser.remoteTab(this.selected);
  if(isExchangeControlPage(tab.url,this.url,this.pointId))throw new Error('Select a website, not the remote workspace itself.');
  return tab;
 }
 constructor(private readonly url:string,private readonly pointId:string,private readonly key:string,private readonly browser:BrowserController,private readonly cipher?:ExchangeCipher){this.connect();}
 private send(value:unknown,frame=false):void{
  if(this.socket?.readyState!==1)return;
  if(frame&&this.socket.bufferedAmount>256_000)return;
  if(this.socket.bufferedAmount>4_000_000){this.socket.close();return;}
  this.socket.send(JSON.stringify(value));
 }
 /** A start that has not settled for this long is taken as stuck: a new one may replace it, and the old one is disposed if it ever lands. */
 private startingNow(tabId?:string):boolean{const s=this.starting;return !!s&&(tabId===undefined||s.tabId===tabId)&&Date.now()-s.at<15_000;}
 private stopStream():void{this.generation++;this.starting=undefined;this.stream?.dispose();this.stream=undefined;}
 private async refresh():Promise<void>{
  if(!this.ready||!this.viewers||this.polling)return;this.polling=true;
  try{const tabs=(await this.browser.remoteTabs()).filter(tab=>!isExchangeControlPage(tab.url,this.url,this.pointId));if(this.selected&&!tabs.some(t=>t.id===this.selected)){this.stopStream();this.selected=undefined;}this.tabs=tabs;this.publishPage();this.send({type:'browser.state',tabs,selected:this.selected??null});}
  catch(error){this.send({type:'browser.state',tabs:[],selected:null,error:error instanceof Error?error.message:'Browser unavailable'});}
  finally{this.polling=false;}
 }
 private async select(tabId:string):Promise<void>{
  const tab=(await this.browser.remoteTabs()).find(tab=>tab.id===tabId);
  if(!tab||isExchangeControlPage(tab.url,this.url,this.pointId))throw new Error('Choose a page to preview, not the remote workspace itself.');
  // The same tab is already streaming or about to: starting again would put two
  // captures on one session, and the older one finishing late would stop the newer.
  if(this.selected===tabId&&(this.stream||this.startingNow(tabId))){await this.refresh();return;}
  this.stopStream();this.selected=tabId;this.publishPage();const generation=this.generation;
  this.starting={tabId,generation,at:Date.now()};
  // Publish selection before starting capture. A browser that cannot produce
  // its first frame must still accept an address from the remote viewer.
  await this.refresh();
  if(generation!==this.generation)return;
  const done=()=>{if(this.starting?.generation===generation)this.starting=undefined;};
  void this.browser.remoteStream(tabId,(data,width,height)=>{
   if(generation===this.generation&&this.ready&&this.viewers)this.send({type:'browser.frame',tabId,data,width,height},true);
  }).then(stream=>{
   done();
   if(generation!==this.generation||!this.viewers||this.stopped){stream.dispose();return;}
   this.stream=stream;
  }).catch(error=>{
   done();
   if(generation===this.generation&&this.ready&&this.viewers)this.send({type:'browser.error',error:error instanceof Error?error.message:'Browser preview could not start'});
  });
 }
 private connect():void{
  if(this.stopped)return;
  const socket=this.socket=encryptedExchangeSocket(this.url+'/ws/stream-agent',this.cipher,true,()=>void this.refresh());
  this.handshake=setTimeout(()=>socket.close(),10000);
  socket.addEventListener('open',()=>socket.send(JSON.stringify({type:'auth',version:1,pointId:this.pointId,key:this.key,encryption:this.cipher?.descriptor??null})));
  socket.addEventListener('message',event=>{
   if(socket!==this.socket||this.stopped)return;
   try{
    if(typeof event.data!=='string'||event.data.length>16000)throw new Error('Invalid stream command');
    const message=JSON.parse(event.data);
    if(message.type==='ready'){clearTimeout(this.handshake);this.ready=true;return;}
    if(!this.ready)throw new Error('Handshake required');
    if(message.type==='browser.viewers'){
     this.viewers=message.active===true;this.viewerCount=Number.isSafeInteger(message.count)&&message.count>=0?message.count:this.viewers?1:0;this.onViewers?.();this.publishPage();
     if(!this.viewers){this.stopStream();}else{void this.refresh();this.chain=this.chain.then(async()=>{if(this.selected&&this.viewers&&!this.stream&&!this.startingNow())await this.select(this.selected);}).catch(error=>this.send({type:'browser.error',error:String(error)}));}return;
    }
    if(message.type!=='browser.command'||typeof message.id!=='string'||!this.viewers)return;
    if(++this.queued>32){this.queued--;this.send({type:'browser.result',id:message.id,ok:false,error:'Too many pending actions'});return;}
    this.chain=this.chain.then(async()=>{
     if(!this.ready||!this.viewers||socket!==this.socket)return;
     try{
      if(message.action==='select'&&typeof message.tabId==='string')await this.select(message.tabId);
      else if(message.action==='pause'){this.stopStream();this.selected=undefined;this.publishPage();await this.refresh();}
      else{
       const input=readRemoteBrowserInput(message.input);
       if(message.action!=='input'||!input||!this.selected||message.tabId!==this.selected)throw new Error('Select the displayed browser tab before controlling it.');
       await this.browser.remoteInput(this.selected,input);
       if(input.action==='close'){this.stopStream();this.selected=undefined;this.publishPage();await this.refresh();}
      }
      this.send({type:'browser.result',id:message.id,ok:true});
     }catch(error){this.send({type:'browser.result',id:message.id,ok:false,error:error instanceof Error?error.message:'Browser action failed'});}
    }).finally(()=>{this.queued--;});
   }catch{socket.close();}
  });
  socket.addEventListener('error',()=>socket.close());
  socket.addEventListener('close',event=>{
   if(socket!==this.socket)return;
   clearTimeout(this.handshake);clearInterval(this.poll);this.ready=false;this.viewers=false;this.viewerCount=0;this.onViewers?.();this.stopStream();this.publishPage();
   if(!this.stopped&&event.code!==4001)this.retry=setTimeout(()=>this.connect(),2000);
  });
  this.poll=setInterval(()=>void this.refresh(),2000);
 }
 dispose():void{this.stopped=true;this.viewers=false;this.viewerCount=0;this.onViewers?.();this.publishPage();clearTimeout(this.retry);clearTimeout(this.handshake);clearInterval(this.poll);this.stopStream();this.socket?.close();}
}
