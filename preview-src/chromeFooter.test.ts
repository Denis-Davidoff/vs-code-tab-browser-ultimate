import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInNewContext } from 'node:vm';
import { createSourceFile, forEachChild, isBinaryExpression, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript';
import { chromeChatCapabilities, chromeChatCommandFeature, chromeChatFeatureError, chromeChatFooterCommands } from '../src/chat/chromeChatCompatibility.ts';
import { createRemoteTerminalShim } from './remoteTerminal.ts';

function fixture(events: unknown[] = []) {
  const source = readFileSync('chrome-extension/sidepanel.ts', 'utf8');
  const ast = createSourceFile('sidepanel.ts', source, ScriptTarget.ES2022, true);
  let post = '';
  const visit = (node: any) => {
    if (isBinaryExpression(node) && node.left.getText(ast) === 'window.aiBrowserChatHost') {
      post = (node.right as any).properties.find((property: any) => property.name?.getText(ast) === 'postMessage').getText(ast);
    }
    forEachChild(node, visit);
  };
  visit(ast);
  const declared = (name: string) => ast.statements.find(node => isFunctionDeclaration(node) && node.name?.text === name)!.getText(ast);
  const poll = declared('pollFooterEvents');
  // postMessage hands every message to prepareChromeMessage, which forwards
  // anything but a send at once; its send path is tested in chromeDelivery.test.ts.
  const prepare = declared('prepareChromeMessage');
  const sent: any[] = [], emitted: any[] = [], attached: any[] = [], feedback: string[] = [];
  const latest = { chatId: 'chat-B', view: { tabs: [{ chatId: 'chat-A' }, { chatId: 'chat-B' }] } };
  const context = createContext({ latest, active: {}, generation: 1, footerCursor: 0,
    // The real terminal shim (#521): the lifted postMessage hands terminal messages to it first.
    terminals: createRemoteTerminalShim({ viewerId: 'viewer-test', epoch: () => undefined, send: () => false, emit() {}, notice() {}, readAgentFrame: () => undefined, isTerminalReply: () => false, splitData: (d: string) => [d], inputFrameMax: 4096 }),
    chromeChatCapabilities, chromeChatCommandFeature, chromeChatFeatureError, chromeChatFooterCommands,
    pendingSends: new Set(), annotations: { async poll() {} },
    supported: new Set(Object.values(chromeChatFooterCommands).flat()), passive: new Set(['ready']),
    async persistOutbox() {}, supportsFeature: () => true, bridgeHeaders: () => ({}), AbortSignal,
    enqueueChromeMessage: (...args: unknown[]) => sent.push(args),
    emit: (message: unknown) => emitted.push(message), showFeedback: (text: string) => feedback.push(text),
    async addChromeAttachment(...args: unknown[]) { attached.push(args); },
    async fetch() { return { ok: true, async json() { return { cursor: events.length, events }; } }; },
  });
  runInNewContext(transpileModule(`const host = { ${post} }; function post(message) { host.postMessage(message); }\n${prepare}\n${poll}`, {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText, context);
  return { context, sent, emitted, attached, feedback };
}

test('footer controls in the shared Chrome renderer forward requests instead of silently dropping them', () => {
  const f = fixture();
  for (const message of [
    { type: 'usage' }, { type: 'compact', tabId: 'tab-B' }, { type: 'listCommands', agent: 'codex' },
    { type: 'runToolbarSkill', id: 'review', values: {}, tabId: 'tab-B' },
    { type: 'chooseWorkdir' }, { type: 'listWorkdir' }, { type: 'refreshWorkdirGit' },
    { type: 'gitCommit', folder: '/project', tabId: 'tab-B' },
    { type: 'gitBranchAction', folder: '/project', action: 'switch', name: 'main' },
    { type: 'openRepo', repo: 'owner/name', branch: '', mode: 'copy' },
  ]) { (f.context as any).post(message); }
  assert.equal(f.sent.length, 10);
  assert.ok(f.sent.every(([, chatId, generation]) => chatId === 'chat-B' && generation === 1));
  assert.match(f.feedback[0], /VS Code/);
});

test('results update only their conversation while project attachments return to their original draft', async () => {
  const f = fixture([
    { id: 1, chatId: 'chat-A', message: { type: 'usage', usage: [], loading: false } },
    { id: 2, chatId: 'chat-B', message: { type: 'usage', usage: [], loading: false } },
    { id: 3, chatId: 'chat-A', message: { type: 'chromeAttachment', label: 'file.ts', text: 'Attached file: /A/file.ts' } },
    { id: 4, chatId: 'chat-B', message: { type: 'gitBranchResult', folder: '/B', action: 'switch' } },
  ]);
  await (f.context as any).pollFooterEvents({}, 1);
  assert.deepEqual(f.emitted.map(m => m.type), ['usage', 'gitBranchResult']);
  assert.equal(f.attached[0][0], 'chat-A'); assert.equal(f.attached[0][2].label, 'file.ts');
  assert.equal(f.context.footerCursor, 4);
  await (f.context as any).pollFooterEvents({}, 1);
  assert.equal(f.attached.length, 1, 'polling the same events never duplicates a project attachment');
});

test('a disconnected generation cannot deliver stale footer answers', async () => {
  const f = fixture([{ id: 1, chatId: 'chat-B', message: { type: 'usage', usage: [], loading: false } }]);
  await (f.context as any).pollFooterEvents({}, 0);
  assert.equal(f.emitted.length, 0); assert.equal(f.context.footerCursor, 0);
});
