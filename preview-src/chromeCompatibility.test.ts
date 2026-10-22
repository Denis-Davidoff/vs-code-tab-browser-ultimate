import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInNewContext } from 'node:vm';
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript';
import { chromeChatCompatibilityError, chromeChatProtocolVersion, chromeChatProtocolHeader, chromeChatVersionHeader, chromeChatCapabilities, chromeChatCapabilitiesHeader, negotiateChromeChatCapabilities, chromeChatFeatureError, chromeChatAttachmentFeature, chromeChatCommandFeature } from '../src/chat/chromeChatCompatibility.ts';

function fixture(snapshot: Record<string, unknown>, responseStatus = 200) {
  const source = readFileSync('chrome-extension/sidepanel.ts', 'utf8');
  const ast = createSourceFile('sidepanel.ts', source, ScriptTarget.ES2022, true);
  const names = new Set(['poll', 'flush', 'bridgeHeaders', 'editorCompatibility', 'requireUpdate', 'supportsFeature']);
  const functions = ast.statements.filter(node => isFunctionDeclaration(node) && names.has(node.name?.text ?? '')).map(node => node.getText(ast)).join('\n');
  const connection = { url: 'http://127.0.0.1:12345', token: 'secret' };
  let sends = 0, renders = 0, retries = 0, network = 0;
  const queued = [{ id: 'pending-message' }];
  const status = { textContent: '', title: '', dataset: {} as Record<string, string> };
  const context: any = createContext({ connection, status, AbortController,
    chromeChatCompatibilityError, chromeChatProtocolVersion, chromeChatProtocolHeader, chromeChatVersionHeader, chromeChatCapabilities, chromeChatCapabilitiesHeader, negotiateChromeChatCapabilities, chromeChatFeatureError, chromeChatAttachmentFeature, chromeChatCommandFeature,
    chromeVersion: '0.5.0', generation: 0, compatible: false, active: connection, latest: undefined, etag: undefined,
    failures: 0, request: undefined, timer: undefined, outbox: queued, flushing: false,
    annotations: { async poll() {}, async retainChats() {} },
    async fetch() { network++; return { status: responseStatus, ok: responseStatus < 400, async json() { return snapshot; }, headers: { get() { return undefined; } } }; },
    async reconcileDelivery() {}, async pollFooterEvents() {}, render() { renders++; }, reset() { context.generation++; context.compatible = false; context.active = undefined; context.latest = undefined; },
    setTimeout() { retries++; return 1; }, clearTimeout() {},
  });
  runInNewContext(transpileModule(functions, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, context);
  const flush = context.flush;
  context.flush = () => { sends++; };
  return { context, connection, status, queued, flush, counts: () => ({ sends, renders, retries, network }) };
}

test('an old or newer incompatible editor shows which extension to update before rendering or flushing drafts', async () => {
  for (const protocolVersion of [undefined, chromeChatProtocolVersion + 1]) {
    const f = fixture({ version: 1, protocolVersion, editorVersion: '0.8.7', view: {} });
    await f.context.poll(f.connection, 0);
    assert.match(f.status.textContent, protocolVersion === undefined ? /Update the AI Browser extension for VS Code/ : /Update the AI Browser extension for Chrome/);
    assert.equal(f.context.compatible, false); assert.equal(f.counts().sends, 0); assert.equal(f.counts().renders, 0);
    assert.equal(f.queued.length, 1, 'pending messages survive an update requirement');
    assert.equal(f.context.generation, 1, 'the old polling generation is stopped');
  }
});

test('compatible protocol versions enable chat even with different release numbers', async () => {
  const f = fixture({ version: 1, protocolVersion: chromeChatProtocolVersion, editorVersion: '0.8.7', view: {} });
  await f.context.poll(f.connection, 0);
  assert.equal(f.context.compatible, true); assert.equal(f.counts().renders, 1); assert.equal(f.counts().sends, 1);
  assert.match(f.status.title, /Chrome 0.5.0.*VS Code 0.8.7/);
});

test('pending commands cannot flush before the compatibility handshake succeeds', async () => {
  const f = fixture({});
  await f.flush();
  assert.equal(f.counts().network, 0); assert.equal(f.queued.length, 1);
});

test('an incompatible optional feature leaves chat usable and explains only that feature', async () => {
  const f = fixture({ version: 1, protocolVersion: chromeChatProtocolVersion, capabilities: { chat: [1], annotations: [2] }, view: {} });
  await f.context.poll(f.connection, 0);
  assert.equal(f.context.compatible, true);
  assert.equal(f.context.supportsFeature('chat'), true);
  assert.equal(f.context.supportsFeature('annotations'), false);
  assert.equal(f.counts().sends, 1);
});

test('an incompatible chat contract keeps pending messages intact', async () => {
  const f = fixture({ version: 1, protocolVersion: chromeChatProtocolVersion, capabilities: { chat: [2], annotations: [1] }, view: {} });
  await f.context.poll(f.connection, 0);
  assert.match(f.status.textContent, /chat feature/);
  assert.equal(f.counts().sends, 0);
  assert.equal(f.queued.length, 1);
});
