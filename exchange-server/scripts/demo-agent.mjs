// Explicit UI/protocol demo. No AI, local files, browser or shell commands are invoked.
import {randomUUID} from 'node:crypto';
const {EXCHANGE_URL='ws://127.0.0.1:3000',EXCHANGE_POINT_ID,EXCHANGE_KEY}=process.env;
if(!EXCHANGE_POINT_ID||!EXCHANGE_KEY)throw new Error('Set EXCHANGE_POINT_ID and EXCHANGE_KEY');
const socket=new WebSocket(EXCHANGE_URL+'/ws/agent');
const chats=new Map([['demo',[{kind:'notice',text:'Demo client — no AI is running.'},{kind:'user',text:'Show the shared chat interface.'},{kind:'assistant',text:'## Shared AI Browser chat\n\nThis is the **same renderer** used in VS Code.\n\n- Model and effort controls\n- Tools, approvals and Markdown\n- Conversations in the dropdown\n\n```ts\nconst connected = true;\n```'}]],['demo-2',[{kind:'notice',text:'Second demo conversation.'}]]]);
let chatId='demo';
const selection={agent:'claude',model:'demo',effort:'medium'};
const tabs=()=>[...chats.keys()].map((id,index)=>({id:'tab-'+id,chatId:id,title:`Demo ${index+1}`,running:false,agents:0,skillRuns:0,busy:false,queued:0,status:'idle'}));
function snapshot(){
 const entries=chats.get(chatId);
 const view={themeKind:2,voice:{available:false,maxSeconds:60},detecting:false,agents:[{id:'claude',name:'Demo agent',available:true,models:[{id:'demo',label:'Demo model',efforts:['low','medium','high'],defaultEffort:'medium',isDefault:true}]}],selection,chatId,entries,running:false,attachments:[],suggestions:[],pendingSends:[],tabs:tabs(),activeTab:'tab-'+chatId,tabLimit:10,approvals:{policy:{},servers:[]},commands:{},toolbar:[],toolbarRuns:{},skillAgents:[],viewMode:'standard',collapseTools:false,workdir:{picked:false,noProject:true,workspace:[],recent:[],locked:false,empty:true,references:[],recentRepos:[]},hasBrowserTab:false,browserApi:false,newsHidden:true,sleep:{mode:'off',active:false}};
 socket.send(JSON.stringify({type:'chat.snapshot',uiVersion:1,chatId,running:false,messages:entries.filter(e=>'text'in e).map((e,i)=>({id:String(i),role:e.kind==='user'?'user':e.kind==='assistant'?'assistant':'system',text:e.text})),view}));
}
const reply=(message)=>socket.send(JSON.stringify({type:'chat.event',chatId,message}));
socket.addEventListener('open',()=>socket.send(JSON.stringify({type:'auth',version:1,pointId:EXCHANGE_POINT_ID,key:EXCHANGE_KEY})));
socket.addEventListener('message',event=>{
 const command=JSON.parse(event.data);
 if(command.type==='ready'){console.log('Demo UI agent connected');snapshot();return;}
 if(command.type==='chat.pin'&&chats.has(command.chatId))chatId=command.chatId;
 const message=command.type==='chat.command'?command.message:command.type==='chat.send'?{type:'send',text:command.text}:undefined;
 if(message){
  if(chats.has(command.chatId))chatId=command.chatId;
  if(message.type==='send')chats.get(chatId).push({kind:'user',text:message.text},{kind:'assistant',text:'Demo response. The shared chat and relay work; no AI was invoked.'});
  if(message.type==='newChat'||message.type==='newTab'){chatId=randomUUID();chats.set(chatId,[]);}
  if(message.type==='select')Object.assign(selection,message.selection);
  if(message.type==='history')reply({type:'history',chats:tabs().map(tab=>({id:tab.chatId,title:tab.title,agent:'claude',updatedAt:Date.now()}))});
 }
 if(command.id){snapshot();socket.send(JSON.stringify({type:'command.result',id:command.id,ok:true}));}
});
socket.addEventListener('close',event=>console.log('Disconnected',event.code,event.reason));
socket.addEventListener('error',()=>console.error('Connection failed'));
