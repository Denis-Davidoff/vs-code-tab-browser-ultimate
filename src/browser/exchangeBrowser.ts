import type { RemoteVideoEncoder } from './remoteVideo';
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
 private video?:RemoteVideoEncoder;
 private videoWanted=false;
 private videoFailedFor?:string;
 private selected?:string;
 private generation=0;
 /** Keep one full frame for new viewers; unchanged pages need only a periodic recovery frame. */
 private lastFrame?:{type:'browser.frame';tabId:string;data:string;width:number;height:number};
 private lastFrameAt=0;
 private replayFrame():void{if(this.video){this.video.requestKeyframe();return;}if(this.lastFrame&&this.lastFrame.tabId===this.selected&&this.ready&&this.viewers&&this.send(this.lastFrame,true))this.lastFrameAt=Date.now();}
 /** The tab laid out at the viewer's size; put back when the viewer stops watching it. */
 private fitted?:string;
 private unfit():void{const id=this.fitted;this.fitted=undefined;if(id)void this.browser.remoteInput(id,{action:'unfit'}).catch(()=>{});}
 /** The preview whose capture is still starting; a repeat selection or viewer notice must not start a second one. */
 private starting?:{tabId:string;generation:number;at:number};
 private retry?:ReturnType<typeof setTimeout>;
 private poll?:ReturnType<typeof setInterval>;
 private handshake?:ReturnType<typeof setTimeout>;
 private polling=false;
 private chain=Promise.resolve();
 private queued=0;
 private publishedPage='null';
 private publishedState?:string;
 private forceState=false;
 private tabs:{id:string;title:string;url:string;kind:'chrome'|'vscode'}[]=[];
 /** Called when the selected page or its address changes, so the chat can offer it. */
 onPage?:()=>void;
 /** The selected page remains available to chat when mobile navigation pauses its video stream. */
 selectedPage():{id:string;title:string;url:string}|undefined{return this.selected&&this.ready&&!this.stopped?this.tabs.find(t=>t.id===this.selected):undefined;}
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
 private send(value:unknown,frame=false):boolean{
  if(this.socket?.readyState!==1)return false;
  if(frame&&this.socket.bufferedAmount>256_000)return false;
  if(this.socket.bufferedAmount>4_000_000){this.socket.close();return false;}
  this.socket.send(JSON.stringify(value));
  return true;
 }
 /** A start that has not settled for this long is taken as stuck: a new one may replace it, and the old one is disposed if it ever lands. */
 private startingNow(tabId?:string):boolean{const s=this.starting;return !!s&&(tabId===undefined||s.tabId===tabId)&&Date.now()-s.at<15_000;}
 private stopStream(restoreSize=true):void{this.video?.dispose();this.video=undefined;this.videoFailedFor=undefined;this.lastFrame=undefined;this.lastFrameAt=0;if(restoreSize)this.unfit();this.generation++;this.starting=undefined;this.stream?.dispose();this.stream=undefined;}
 private async refresh(force=false):Promise<void>{
  if(force)this.forceState=true;
  if(!this.ready||(!this.viewers&&!this.selected)||this.polling)return;this.polling=true;
  try{
   const previousUrl=this.tabs.find(tab=>tab.id===this.selected)?.url;
   const tabs=(await this.browser.remoteTabs()).filter(tab=>!isExchangeControlPage(tab.url,this.url,this.pointId));
   if(this.selected&&!tabs.some(t=>t.id===this.selected)){this.stopStream();this.selected=undefined;}
   this.tabs=tabs;this.publishPage();
   const state={type:'browser.state',tabs,selected:this.selected??null},signature=JSON.stringify(state);
   if(this.forceState||signature!==this.publishedState){if(this.send(state)){this.publishedState=signature;this.forceState=false;this.replayFrame();}}
   // A tab may start on about:blank or an insecure page where WebCodecs is unavailable.
   if(this.videoWanted&&this.selected&&this.videoFailedFor===this.selected&&previousUrl!==tabs.find(tab=>tab.id===this.selected)?.url){
    const selected=this.selected;
    this.chain=this.chain.then(async()=>{
     if(this.selected!==selected||!this.ready||!this.viewers||!this.videoWanted||this.videoFailedFor!==selected)return;
     this.stopStream(false);await this.select(selected);
    }).catch(error=>{this.send({type:'browser.error',error:String(error)});});
   }
  }catch(error){this.publishedState=undefined;this.send({type:'browser.state',tabs:[],selected:null,error:error instanceof Error?error.message:'Browser unavailable'});}
  finally{this.polling=false;}
 }

 private async select(tabId:string):Promise<void>{
  const tab=(await this.browser.remoteTabs()).find(tab=>tab.id===tabId);
  if(!tab||isExchangeControlPage(tab.url,this.url,this.pointId))throw new Error('Choose a page to preview, not the remote workspace itself.');
  // The same tab is already streaming or about to: starting again would put two
  // captures on one session, and the older one finishing late would stop the newer.
  if(this.selected===tabId&&(this.stream||this.startingNow(tabId))){await this.refresh(true);return;}
  this.stopStream(this.selected!==tabId);this.selected=tabId;this.publishPage();const generation=this.generation;
  this.starting={tabId,generation,at:Date.now()};
  // Publish selection before starting capture. A browser that cannot produce
  // its first frame must still accept an address from the remote viewer.
  await this.refresh();
  if(generation!==this.generation)return;
  const done=()=>{if(this.starting?.generation===generation)this.starting=undefined;};
  if(this.videoWanted&&this.videoFailedFor!==tabId&&this.browser.remoteVideoEncoder){
   try{
    const video=await this.browser.remoteVideoEncoder(tabId,chunk=>{
     if(generation===this.generation&&this.ready&&this.viewers)this.send({type:'browser.video',tabId,...chunk},true);
    },()=>{if(generation===this.generation){this.videoFailedFor=tabId;this.video?.dispose();this.video=undefined;}});
    if(generation!==this.generation||this.stopped){video.dispose();return;}
    if(this.videoFailedFor===tabId)video.dispose();else this.video=video;
   }catch{this.videoFailedFor=tabId;}
  }
  if(generation!==this.generation)return;

  void this.browser.remoteStream(tabId,(data,width,height)=>{
   if(generation!==this.generation||!this.ready||!this.viewers)return;
   if(this.video){
    const video=this.video;
    void video.push(data,width,height).catch(()=>{
     if(generation!==this.generation||this.video!==video)return;
     video.dispose();this.video=undefined;this.videoFailedFor=tabId;
     const next={type:'browser.frame' as const,tabId,data,width,height};
     if(this.send(next,true)){this.lastFrame=next;this.lastFrameAt=Date.now();}
    });
    return;
   }
   const previous=this.lastFrame;
   if(previous?.tabId===tabId&&previous.data===data&&previous.width===width&&previous.height===height&&Date.now()-this.lastFrameAt<15_000)return;
   const next={type:'browser.frame' as const,tabId,data,width,height};
   // A dropped send must not suppress the next retry of that image.
   if(this.send(next,true)){this.lastFrame=next;this.lastFrameAt=Date.now();}
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
  this.publishedState=undefined;
  const socket=this.socket=encryptedExchangeSocket(this.url+'/ws/stream-agent',this.cipher,true,()=>{void this.refresh(true);});
  this.handshake=setTimeout(()=>socket.close(),10000);
  socket.addEventListener('open',()=>socket.send(JSON.stringify({type:'auth',version:1,pointId:this.pointId,key:this.key,encryption:this.cipher?.descriptor??null})));
  socket.addEventListener('message',event=>{
   if(socket!==this.socket||this.stopped)return;
   try{
    if(typeof event.data!=='string'||event.data.length>16000)throw new Error('Invalid stream command');
    const message=JSON.parse(event.data);
    if(message.type==='ready'){clearTimeout(this.handshake);this.ready=true;void this.refresh();return;}
    if(!this.ready)throw new Error('Handshake required');
    if(message.type==='browser.viewers'){
     const videoWanted=message.video==='h264';
     if(videoWanted!==this.videoWanted){this.videoWanted=videoWanted;this.stopStream(false);}
     this.viewers=message.active===true;this.viewerCount=Number.isSafeInteger(message.count)&&message.count>=0?message.count:this.viewers?1:0;this.onViewers?.();this.publishPage();
     if(!this.viewers){this.stopStream();}else{void this.refresh(true);this.chain=this.chain.then(async()=>{if(this.selected&&this.viewers&&!this.stream&&!this.startingNow())await this.select(this.selected);}).catch(error=>{this.send({type:'browser.error',error:String(error)});});}return;
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
       if(input.action==='fit')this.fitted=this.selected;else if(input.action==='unfit')this.fitted=undefined;
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
