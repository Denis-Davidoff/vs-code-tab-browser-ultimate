import { strict as assert } from 'node:assert';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createSourceFile, forEachChild, isMethodDeclaration, ScriptTarget, transpileModule } from 'typescript';

function fixture(stat: () => Promise<unknown> = async () => ({ isDirectory: () => false })) {
  const source = readFileSync('src/chat/chatView.ts', 'utf8');
  const ast = createSourceFile('chatView.ts', source, ScriptTarget.ES2022, true);
  const wanted = new Set(['_receiveChromeFooter', '_postMessage', '_workdir', '_usage']);
  const methods: string[] = [];
  const visit = (node: any) => {
    if (isMethodDeclaration(node) && wanted.has(node.name.getText(ast))) { methods.push(node.getText(ast)); }
    forEachChild(node, visit);
  };
  visit(ast);
  const View = runInNewContext(transpileModule(`class View { ${methods.join('\n')} }; View;`, {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText, { path, fs: { promises: { stat } } });
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
