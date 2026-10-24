import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { dirname, relative, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { setImmediate as flush, setTimeout as delay } from 'node:timers/promises';

function harness(healthStatus = 200, memory?: {stored:Map<string,any>;secrets:Map<string,string>}) {
	const healthRequests: string[] = [];
	const sockets: FakeSocket[] = [];
	class FakeSocket {
		readyState = 1;
		bufferedAmount = 0;
		readonly sent: string[] = [];
		readonly events = new Map<string, ((event: any) => void)[]>();
		readonly url: string;
		constructor(url: string) { this.url = url; sockets.push(this); }
		send(data: string) { this.sent.push(data); }
		close() { this.readyState = 3; this.emit('close', { code: 1000 }); }
		addEventListener(name: string, listener: (event: any) => void) { this.events.set(name, [...(this.events.get(name) ?? []), listener]); }
		emit(name: string, event: any = {}) { for (const listener of this.events.get(name) ?? []) { listener(event); } }
	}
	const stored = memory?.stored ?? new Map<string, any>(), secrets = memory?.secrets ?? new Map<string, string>();
	const sources: string[] = [];
	const actions: any[] = [];
	let observed: any;
	const commands = new Map<string, (...args: any[]) => unknown>();
	const status = { text: '', command: '', tooltip: '', show() {}, hide() {}, dispose() {} };
	const vscode = {
		workspace: { isTrusted: true }, StatusBarAlignment: { Right: 1 },
		window: { createStatusBarItem: () => status },
		commands: { registerCommand: (name: string, callback: (...args: any[]) => unknown) => { commands.set(name, callback); return { dispose() {} }; } },
	};
	const context = {
		workspaceState: { get: (name: string) => stored.get(name), update: async (name: string, value: unknown) => { stored.set(name, value); } },
		secrets: { get: async (name: string) => secrets.get(name), store: async (name: string, value: string) => { secrets.set(name, value); }, delete: async(name:string)=>{secrets.delete(name);} },
		subscriptions: [] as { dispose(): void }[],
	};
	let choices=[{id:'panel-1',panelId:'sidebar'},{id:'panel-2',panelId:'stable-panel-2'}];
	const chatView = { ChatViewProvider: {
        exchangeViewerConnected:(source:string)=>actions.push({viewerJoined:source}),
		chromeSources: () => choices,
		commandExchangeSource: async (source:string,chatId:string,message:any,_picked:any,reply:any,browserTab:any) => { actions.push({source,chatId,message,...(browserTab?{browserTab}:{})}); reply?.({type:'usage',usage:[],loading:false},chatId); },
		observeChromeSource: (source: string, surface: any) => {
			sources.push(source); observed=surface;
			const refresh=()=>surface.update({ chatId: surface.chatId ?? 'chat-1', entries: [{kind:'tool',id:'tool-1',tool:'command',name:'Test',input:'echo test',output:'test',status:'done',startedAt:1}], running: false, tabs:[{id:'tab-1',chatId:'chat-1',title:'One'},{id:'tab-2',chatId:'chat-2',title:'Two'}], voice:{}, exchangeConnection:{url:'https://private-server.example'} });
			surface.bind(refresh); refresh();
			return { dispose: () => surface.close() };
		},
	}, chatViewId: 'aiBrowser.chat' };
	const modules = new Map<string, any>();
	function load(name: string): any {
		if (modules.has(name)) { return modules.get(name); }
		const module = { exports: {} }; modules.set(name, module.exports);
		const filename = resolve('src/chat',`${name}.ts`);
		const js = transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
		runInNewContext(js, { module, exports: module.exports, WebSocket: FakeSocket, Buffer, URL, Error, AbortSignal, TextEncoder, TextDecoder, crypto:globalThis.crypto, btoa, atob, EventTarget, Event, MessageEvent, setTimeout, clearTimeout,
			fetch: async (url: URL) => { healthRequests.push(String(url)); return { ok: healthStatus === 200, status: healthStatus, json: async () => ({ status: "ok", protocolVersion: 1 }) }; },
			require: (specifier: string) => specifier === 'node:net' ? { isIP } : specifier === 'vscode' ? vscode : specifier === './chatView' ? chatView : load(relative(resolve("src/chat"),resolve(dirname(filename),specifier))),
		});
		return module.exports;
	}
	load('exchangeChat').registerExchangeChat(context);
	const port = load('exchangeConnection').exchangeConnection;
	return { port, stored, secrets, sockets, sources, commands, status, healthRequests, actions, get surface(){return observed;}, setSources(value:typeof choices){choices=value;}, shutdown:()=>{for(const item of context.subscriptions)item.dispose();}, parseUi:load("exchangeUiProtocol").readExchangeUiCommand, dispose: () => port.disconnect() };
}
const pointId = 'b992f496-44cc-4f54-968b-c474b84df86a';
const key = 'exch_' + 'a'.repeat(43);

test('settings connect the originating panel, keep keys out of workspace state, and reflect ready/disconnect', async () => {
	const h = harness();
	try {
		await h.port.connect({ url: 'http://127.0.0.1:3001', pointId, key }, 'panel-2');
		assert.deepEqual(h.sources, ['panel-2']);
		assert.equal(h.sockets[0].url, 'ws://127.0.0.1:3001/ws/agent');
		assert.equal(h.port.state.status, 'connecting');
		assert.equal(h.secrets.get('aiBrowser.exchange.key.' + pointId), key);
		assert.equal(JSON.stringify([...h.stored.values()]).includes(key), false);
		assert.equal(JSON.stringify(h.port.state).includes(key), false);
		h.sockets[0].emit('open');
		assert.equal(JSON.parse(h.sockets[0].sent[0]).key, key);
		h.sockets[0].emit('message', { data: JSON.stringify({ type: 'ready', version: 1 }) });
		await flush();
		assert.equal(h.port.state.status, 'connected');
		h.commands.get('aiBrowser.chat.disconnectExchange')!();
		assert.equal(h.port.state.status, 'disconnected');
		assert.equal(h.port.state.hasKey, true);
		assert.equal(h.sockets[0].readyState, 3);
	} finally { h.dispose(); }
});

test('blank keys reuse the saved key only for the same server and point', async () => {
	const h = harness();
	try {
		await h.port.connect({ url: 'http://127.0.0.1:3001', pointId, key }, 'panel-1');
		h.port.disconnect();
		await h.port.connect({ url: 'http://127.0.0.1:3001', pointId }, 'panel-2');
		assert.equal(h.sockets.length, 2);
		h.port.disconnect();
		await h.port.connect({ url: 'https://another.example', pointId }, 'panel-2');
		assert.equal(h.sockets.length, 2);
		assert.match(h.port.state.error, /connection key/);
	} finally { h.dispose(); }
});

test('refused keys are shown in settings and invalid form data never opens a connection', async () => {
	const h = harness();
	try {
		await h.port.connect({ url: 'http://127.0.0.1:3001', pointId: 'not-an-id', key }, 'panel-1');
		assert.equal(h.sockets.length, 0);
		assert.match(h.port.state.error, /valid connection ID/);
		await h.port.connect({ url: 'http://127.0.0.1:3001', pointId, key }, 'panel-1');
		h.sockets[0].emit('close', { code: 4001 });
		assert.equal(h.port.state.status, 'error');
		assert.match(h.port.state.error, /Connection refused/);
	} finally { h.dispose(); }
});


test('the website LAN address is checked and used for the WebSocket connection', async () => {
	const h = harness();
	try {
		await h.port.connect({ url: 'http://192.168.1.172:3000', pointId, key }, 'panel-1');
		assert.deepEqual(h.healthRequests, ['http://192.168.1.172:3000/api/health']);
		assert.equal(h.sockets[0].url, 'ws://192.168.1.172:3000/ws/agent');
	} finally { h.dispose(); }
});

test('an incorrect server port produces a clear error without saving credentials', async () => {
	const h = harness(404);
	try {
		await h.port.connect({ url: 'http://192.168.1.172:3000', pointId, key }, 'panel-1');
		assert.equal(h.sockets.length, 0);
		assert.equal(h.secrets.size, 0);
		assert.match(h.port.state.error, /HTTP 404/);
	} finally { h.dispose(); }
});


test('full chat snapshots preserve tools and dropdown pinning without exposing connection settings', async () => {
	const h=harness();
	try {
		await h.port.connect({url:'http://127.0.0.1:3000',pointId,key},'panel-2');
		h.sockets[0].emit('message',{data:JSON.stringify({type:'ready',version:1})});await flush();
		const snapshot=h.sockets[0].sent.map(value=>JSON.parse(value)).find(value=>value.type==='chat.snapshot');
		assert.equal(snapshot.uiVersion,1);assert.equal(snapshot.view.entries[0].kind,'tool');assert.equal(snapshot.view.entries[0].output,'test');
		assert.equal(snapshot.view.exchangeConnection,undefined);
		h.sockets[0].emit('message',{data:JSON.stringify({type:'chat.pin',id:randomUUID(),chatId:'chat-2'})});await flush();
		assert.equal(h.surface.chatId,'chat-2');
	}finally{h.dispose();}
});

test('UI controls reach the bound conversation and return asynchronous UI events', async () => {
	const h=harness();
	try {
		await h.port.connect({url:'http://127.0.0.1:3000',pointId,key},'panel-2');
		h.sockets[0].emit('message',{data:JSON.stringify({type:'ready',version:1})});await flush();
		const id=randomUUID();
		h.sockets[0].emit('message',{data:JSON.stringify({type:'chat.command',id,chatId:'chat-1',message:{type:'select',selection:{agent:'codex',model:'model'}}})});await flush();
		assert.equal(h.actions[0].source,'panel-2');assert.equal(h.actions[0].chatId,'chat-1');assert.equal(h.actions[0].message.selection.model,'model');
		assert.ok(h.sockets[0].sent.map(value=>JSON.parse(value)).some(value=>value.type==='chat.event'&&value.message.type==='usage'));
		for(const type of ['connectExchange','disconnectExchange','executeCommand','reportTheme','saveDrafts'])assert.equal(h.parseUi({type:'chat.command',id:randomUUID(),chatId:'chat-1',message:{type}}),undefined);
	}finally{h.dispose();}
});

test('reload restores the same saved key and point into the original stable chat panel',async()=>{
 const first=harness();
 await first.port.connect({url:'http://192.168.1.172:3000',pointId,key},'panel-2');
 assert.equal(first.port.state.url,'http://192.168.1.172:3000');
 first.shutdown();
 const restarted=harness(200,first);
 restarted.setSources([{id:'new-panel-1',panelId:'sidebar'},{id:'new-panel-2',panelId:'stable-panel-2'}]);
 try{
  await delay(30);
  assert.equal(restarted.sockets.length,1);
  assert.deepEqual(restarted.sources,['new-panel-2']);
  assert.equal(restarted.port.state.url,'http://192.168.1.172:3000');
  assert.equal(restarted.port.state.pointId,pointId);assert.equal(restarted.port.state.hasKey,true);
  restarted.sockets[0].emit('open');
  const auth=JSON.parse(restarted.sockets[0].sent[0]);assert.equal(auth.pointId,pointId);assert.equal(auth.key,key);
 }finally{restarted.shutdown();}
});

test('old stored ws addresses migrate to website addresses and accept a blank saved key',async()=>{
 const memory={stored:new Map<string,any>([['aiBrowser.exchange.connection',{url:'ws://127.0.0.1:3000',pointId,autoConnect:false}]]),secrets:new Map([['aiBrowser.exchange.key.'+pointId,key]])};
 const h=harness(200,memory);
 try{
  await flush();assert.equal(h.port.state.url,'http://127.0.0.1:3000');assert.equal(h.port.state.hasKey,true);
  await h.port.connect({url:'http://127.0.0.1:3000',pointId},'panel-1');
  assert.equal(h.sockets.length,1);assert.equal(h.stored.get('aiBrowser.exchange.connection').url,'http://127.0.0.1:3000');
 }finally{h.shutdown();}
});

test('Disconnect preserves credentials and keeps automatic restoration disabled after reload',async()=>{
 const first=harness();await first.port.connect({url:'http://127.0.0.1:3000',pointId,key},'panel-1');first.port.disconnect();first.shutdown();
 const h=harness(200,first);
 try{
  await delay(30);assert.equal(h.sockets.length,0);assert.equal(h.port.state.pointId,pointId);assert.equal(h.port.state.hasKey,true);
  await h.port.connect({url:h.port.state.url,pointId},'panel-1');assert.equal(h.sockets.length,1);
 }finally{h.shutdown();}
});

test('automatic restore does not move a closed detached chat to the sidebar',async()=>{
 const first=harness();await first.port.connect({url:'http://127.0.0.1:3000',pointId,key},'panel-2');first.shutdown();
 const h=harness(200,first);h.setSources([{id:'new-sidebar',panelId:'sidebar'}]);
 try{await delay(30);assert.equal(h.sockets.length,0);assert.equal(h.port.state.hasKey,true);}finally{h.shutdown();}
});

test('browser attachments require and receive the remotely selected tab, never the current editor tab',async()=>{
 const h=harness();
 try{
  await h.port.connect({url:'http://127.0.0.1:3000',pointId,key},'panel-1');
  const socket=h.sockets[0];socket.emit('message',{data:JSON.stringify({type:'ready',version:1})});await flush();
  const send=(id:string)=>socket.emit('message',{data:JSON.stringify({type:'chat.command',id,chatId:'chat-1',message:{type:'attach',kind:'annotation'}})});
  const missing=randomUUID();send(missing);await flush();assert.equal(h.actions.length,0);assert.match(socket.sent.find(s=>s.includes(missing))!,/Select a tab/);
  const remote={id:'remote-tab',url:'https://example.com'};h.surface.browserTab=async()=>remote;
  send(randomUUID());await flush();assert.equal(h.actions[0].browserTab,remote);
  h.surface.browserTab=async()=>{throw new Error('The selected tab was closed');};const closed=randomUUID();send(closed);await flush();
  assert.equal(h.actions.length,1);assert.match(socket.sent.find(s=>s.includes(closed))!,/selected tab was closed/);
 }finally{h.shutdown();}
});

test('workspace passwords stay in SecretStorage, persist on blank reconnect, and can be removed explicitly', async () => {
 const h=harness(),password='a sufficiently long password';
 try {
  await h.port.connect({url:'http://localhost:3000',pointId,key,password},'panel-1');
  assert.equal(h.secrets.get('aiBrowser.exchange.key.password.'+pointId),password);
  assert.equal(h.port.state.hasPassword,true);
  assert.equal(JSON.stringify([...h.stored.values()]).includes(password),false);
  assert.equal(JSON.stringify(h.port.state).includes(password),false);
  h.sockets[0].emit('open');const hello=JSON.parse(h.sockets[0].sent[0]);assert.equal(hello.encryption.version,1);assert.equal(JSON.stringify(hello).includes(password),false);
  h.dispose();
  await h.port.connect({url:'http://localhost:3000',pointId},'panel-1');assert.equal(h.port.state.hasPassword,true);
  h.dispose();
  await h.port.connect({url:'http://localhost:3000',pointId,password:''},'panel-1');
  assert.equal(h.port.state.hasPassword,false);assert.equal(h.secrets.has('aiBrowser.exchange.key.password.'+pointId),false);
  h.sockets.at(-1)!.emit('open');assert.equal(JSON.parse(h.sockets.at(-1)!.sent[0]).encryption,null);
 } finally {h.shutdown();}
});

test('openBrowser does not require an already selected browser tab',async()=>{
 const h=harness();try{
  await h.port.connect({url:'http://127.0.0.1:3000',pointId,key},'panel-1');
  const socket=h.sockets[0];socket.emit('message',{data:JSON.stringify({type:'ready',version:1})});await flush();
  h.surface.browserTab=async()=>{throw new Error('No tab is selected');};
  socket.emit('message',{data:JSON.stringify({type:'chat.command',id:randomUUID(),chatId:'chat-1',message:{type:'openBrowser',where:'vscode'}})});await flush();
  assert.equal(h.actions.length,1);assert.equal(h.actions[0].message.type,'openBrowser');
 }finally{h.shutdown();}
});

test('a relay that carries patches gets numbered snapshots and then patches; an older one only snapshots', async () => {
 const state=(text:string)=>({chatId:'chat-1',entries:[{kind:'assistant',text:'a long earlier answer '.repeat(200)},{kind:'assistant',text}],running:true,tabs:[{id:'tab-1',chatId:'chat-1',title:'One'}],voice:{}});
 for (const features of [['patch'],undefined]) {
  const h=harness();
  try{
   await h.port.connect({url:'http://127.0.0.1:3000',pointId,key},'panel-1');
   const socket=h.sockets[0];socket.emit('message',{data:JSON.stringify({type:'ready',version:1,...(features?{features}:{})})});await flush();
   h.surface.update(state('one'));await delay(40);
   h.surface.update(state('one two'));await delay(40);
   const frames=socket.sent.map(s=>JSON.parse(s)).filter(m=>m.type==='chat.snapshot'||m.type==='chat.patch');
   const last=frames.at(-1);
   if(features){
    assert.equal(last.type,'chat.patch');assert.equal(last.patch.entries.from,1);assert.equal(last.patch.entries.upsert[0].text,'one two');
    const full=[...frames].reverse().find((m:any)=>m.type==='chat.snapshot');assert.ok(full.epoch);assert.equal(last.epoch,full.epoch);assert.equal(last.base,last.rev-1);
    const resync=randomUUID();socket.emit('message',{data:JSON.stringify({type:'chat.resync',id:resync,chatId:'chat-1'})});await flush();
    assert.equal(JSON.parse(socket.sent.at(-2)!).type,'chat.snapshot');assert.ok(socket.sent.at(-1)!.includes(resync));
    // Patches stopped: a whole snapshot follows on its own, for the relay's cache.
    h.surface.update(state('one two three'));await delay(40);
    assert.equal(JSON.parse(socket.sent.at(-1)!).type,'chat.patch');
    await delay(2100);
    const trailing=JSON.parse(socket.sent.at(-1)!);assert.equal(trailing.type,'chat.snapshot');assert.equal(trailing.view.entries[1].text,'one two three');
   }else{
    assert.ok(frames.every((m:any)=>m.type==='chat.snapshot'&&m.epoch===undefined));
   }
  }finally{h.shutdown();}
 }
});

test('each additional Exchange viewer renews awake protection, repeated presence does not',async()=>{
 const h=harness();
 try{
  await h.port.connect({url:'https://exchange.test',pointId,key},'panel-2');
  const ws=h.sockets[0];ws.emit('open');
  assert.ok(JSON.parse(ws.sent[0]).features.includes('chat-viewers'));
  ws.emit('message',{data:JSON.stringify({type:'ready',version:1})});await flush();
  for(const count of [0,1,1,2,1,2,0]){ws.emit('message',{data:JSON.stringify({type:'chat.viewers',count})});await flush();}
  assert.deepEqual(h.actions,[{viewerJoined:'panel-2'},{viewerJoined:'panel-2'},{viewerJoined:'panel-2'}]);
 }finally{h.shutdown();}
});
