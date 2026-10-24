import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { changeGitIndex } from './gitIndex.ts';
import { parseGitStatus } from './gitStatus.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createSourceFile, forEachChild, isMethodDeclaration, ScriptTarget, transpileModule } from 'typescript';

function fixture(stat: () => Promise<unknown> = async () => ({ isDirectory: () => false })) {
  const source = readFileSync('src/chat/chatView.ts', 'utf8');
  const ast = createSourceFile('chatView.ts', source, ScriptTarget.ES2022, true);
  const wanted = new Set(['_receiveChromeFooter', '_postMessage', '_workdir', '_usage', '_changeGitIndex', '_refreshWorkdirGit']);
  const methods: string[] = [];
  const visit = (node: any) => {
    if (isMethodDeclaration(node) && wanted.has(node.name.getText(ast))) { methods.push(node.getText(ast)); }
    forEachChild(node, visit);
  };
  visit(ast);
  const View = runInNewContext(transpileModule(`class View { ${methods.join('\n')} }; View;`, {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText, { path, fs: { promises: { stat } }, gitBinary:async()=> 'git', changeGitIndex, parseGitStatus });
  const view = new View();
  const tabA = { id: 'tab-A', chat: { id: 'chat-A', folder: '/A', stats: { contextTokens: 10 } }, started: true };
  const tabB = { id: 'tab-B', chat: { id: 'chat-B', folder: '/B', stats: { contextTokens: 20 } }, started: true };
  const editorMessages: any[] = [];
  Object.assign(view, {
    _chromeCommand: new AsyncLocalStorage(), _tabs: [tabA, tabB], _active: tabB,
    _viewReady: true, _view: { webview: { postMessage(message: unknown) { editorMessages.push(message); } } },
    _stateSurfaces: { publish() {} }, _state: () => ({ chatId: view._active.chat.id }),
    _workspaceFolders: () => [], _limits: new Map(),
  });
  return { view, tabA, tabB, editorMessages };
}

test('concurrent footer requests retain their conversation across awaits and never switch the editor tab', async () => {
  const { view, tabA, tabB, editorMessages } = fixture();
  let unblock!: () => void;
  const barrier = new Promise<void>(resolve => { unblock = resolve; });
  view._receive = async () => {
    await barrier;
    view._postMessage({ type: 'workdirFiles', folder: view._workdir(), entries: [], truncated: false });
  };
  const a: any[] = [], b: any[] = [];
  const first = view._receiveChromeFooter(tabA, { type: 'listWorkdir' }, (message: unknown, chatId: string) => a.push({ message, chatId }));
  const second = view._receiveChromeFooter(tabB, { type: 'listWorkdir' }, (message: unknown, chatId: string) => b.push({ message, chatId }));
  unblock(); await Promise.all([first, second]);
  assert.equal(a[0].message.folder, '/A'); assert.equal(a[0].chatId, 'chat-A');
  assert.equal(b[0].message.folder, '/B'); assert.equal(b[0].chatId, 'chat-B');
  assert.equal(view._active, tabB);
  assert.ok(editorMessages.every(message => message.type === 'state'), 'request answers are not delivered to the editor popup');
  await assert.rejects(view._receiveChromeFooter(tabA, { type: 'compact', tabId: 'tab-B' }), /destination conversation changed/);
});

test('usage answers contain the pinned conversation context rather than the editor conversation', async () => {
  const { view, tabA } = fixture();
  view._registry = { agents: [{ id: 'codex', available: true }], backend: () => ({ usage: async () => ({ agent: 'codex', windows: [], notes: [] }) }) };
  view._receive = () => view._usage();
  const answers: any[] = [];
  await view._receiveChromeFooter(tabA, { type: 'usage' }, (message: unknown) => answers.push(message));
  assert.equal(answers.length, 2); assert.equal(answers[0].loading, true); assert.equal(answers[1].loading, false);
  assert.equal(answers[1].stats.contextTokens, 10);
});

test('a history conversation replacing the same ChatTab cannot receive an old project attachment', async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  const { view, tabA } = fixture(() => pending);
  const replies: unknown[] = [];
  const request = view._receiveChromeFooter(tabA, { type: 'attachPath', path: 'private.txt' }, (message: unknown) => replies.push(message));
  tabA.chat.id = 'replacement-chat';
  finish({ isDirectory: () => false });
  await assert.rejects(request, /destination conversation changed/);
  assert.equal(replies.length, 0, 'no stale project context reaches the replacement chat');
});

for(const surface of ['Chrome','Exchange'])test(`${surface} stages and unstages the pinned chat repository and sends a fresh snapshot to its own popup`,async()=>{
 const folder=mkdtempSync(path.join(tmpdir(),'remote-index-'));
 const git=(args:readonly string[])=>Promise.resolve(execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.com',...args],{cwd:folder,encoding:'utf8'}));
 try{
  await git(['init','-q']);writeFileSync(path.join(folder,'a.txt'),'initial');await git(['add','.']);await git(['commit','-qm','initial']);writeFileSync(path.join(folder,'a.txt'),'changed');
  const {view,tabA,tabB,editorMessages}=fixture();tabA.chat.folder=folder;
  const replies:any[]=[];const reply=(message:any)=>replies.push(message);
  view._disposed=false;view._blocked=()=>undefined;view._withGitMutation=(_folder:string,work:()=>Promise<void>)=>work();
  view._runWorkdirGit=(_git:string,args:readonly string[])=>git(args);
  view._readWorkdirGit=async(target:string)=>view._postMessage({type:'workdirGit',folder:target,status:parseGitStatus(await git(['status','--porcelain=v1','-z']))});
  // Another request already owns a coalesced refresh and a different reply callback.
  view._gitRefreshes=new Map([[folder,{again:false,done:Promise.resolve()}]]);
  view._receive=(message:any)=>view._changeGitIndex(message);
  await view._receiveChromeFooter(tabA,{type:'gitIndexAction',folder,tabId:tabA.id,action:'stage',path:'a.txt'},reply);
  assert.equal((await git(['diff','--cached','--name-only'])).trim(),'a.txt');
  assert.equal(replies.find(m=>m.type==='workdirGit').status.staged[0].path,'a.txt');
  assert.equal(replies.at(-1).type,'gitIndexResult');assert.equal(replies.at(-1).error,undefined);
  replies.length=0;
  await view._receiveChromeFooter(tabA,{type:'gitIndexAction',folder,tabId:tabA.id,action:'unstage',path:'a.txt'},reply);
  assert.equal((await git(['diff','--cached','--name-only'])).trim(),'');
  assert.equal(replies.find(m=>m.type==='workdirGit').status.unstaged[0].path,'a.txt');
  assert.equal(view._active,tabB);assert.ok(editorMessages.every(m=>m.type==='state'));
 }finally{rmSync(folder,{recursive:true,force:true});}
});

test('remote fetch modes stay attached to the pinned conversation and its folder', async () => {
 const { view, tabA, tabB } = fixture();
 const calls: any[] = [];
 view._readWorkdirGit = async (folder: string, fetch: string) => { calls.push({ folder, fetch, tab: view._chromeCommand.getStore().tab }); };
 await view._receiveChromeFooter(tabA, { type: 'refreshWorkdirGit', fetch: 'force' });
 await view._receiveChromeFooter(tabB, { type: 'refreshWorkdirGit', fetch: 'auto' });
 assert.equal(calls[0].folder, '/A'); assert.equal(calls[0].fetch, 'force'); assert.equal(calls[0].tab, tabA);
 assert.equal(calls[1].folder, '/B'); assert.equal(calls[1].fetch, 'auto'); assert.equal(calls[1].tab, tabB);
});
