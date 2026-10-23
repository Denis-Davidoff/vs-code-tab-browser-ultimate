import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInNewContext } from 'node:vm';
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript';

function functions(names: string[]) {
  const source = readFileSync('chrome-extension/sidepanel.ts', 'utf8');
  const ast = createSourceFile('sidepanel.ts', source, ScriptTarget.ES2022, true);
  return transpileModule(ast.statements.filter(node => isFunctionDeclaration(node) && names.includes(node.name?.text ?? '')).map(node => node.getText(ast)).join('\n'), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
}

test('uncertain delivery after host restart restores drafts instead of silently replaying commands', async () => {
  const restored: any[] = [], feedback: string[] = [];
  const pending = [{ id: 'one', message: { type: 'send', text: 'May already have run' } }, { id: 'two', message: { type: 'gitCommit' } }];
  const context = createContext({ outbox: pending, outboxSession: 'old-host', persisted: new Set(['one', 'two']),
    restoreCommandDraft: (command: unknown) => restored.push(command), showFeedback: (text: string) => feedback.push(text), async persistOutbox() {} });
  runInNewContext(functions(['reconcileDelivery']), context);
  await (context as any).reconcileDelivery('new-host');
  assert.equal(pending.length, 0); assert.equal(restored.length, 2); assert.match(feedback[0], /before retrying/);
  assert.equal(context.outboxSession, 'new-host');
});

test('same delivery session preserves pending commands for safe duplicate-suppressed retry', async () => {
  const pending = [{ id: 'one' }];
  const context = createContext({ outbox: pending, outboxSession: 'same-host', async persistOutbox() {}, restoreCommandDraft() { assert.fail('must not restore'); }, showFeedback() {} });
  runInNewContext(functions(['reconcileDelivery']), context);
  await (context as any).reconcileDelivery('same-host');
  assert.equal(pending.length, 1);
});

test('resume skips an unrelated profile rejection and reaches the authorized editor', async () => {
  const calls: string[] = [], connected: unknown[] = [];
  const connection = { extensionId: 'extension', url: 'owner' };
  const context = createContext({ status: { dataset: {}, textContent: '' }, resumeLoaded: Promise.resolve(), resuming: false, active: undefined, quickAttempt: undefined,
    resumeState: { key: 'grant', chatId: 'chat-1' }, generation: 0, chromePairingPorts: [1, 2], chromePairingKind: 'discovery', AbortSignal,
    pairingHeaders: () => ({}), editorCompatibility: () => undefined, readChromeChatConnection: (value: unknown) => value,
    chrome: { runtime: { id: 'extension' }, storage: { session: { async set() {} } } },
    connect: (value: unknown) => connected.push(value),
    async fetch(url: string) {
      assert.equal((context.status as any).dataset.busy, 'true', 'resume shows the loading core while discovering and connecting');
      calls.push(url);
      if (url.endsWith('/discovery')) { return { ok: true, async json() { return { kind: 'discovery', version: 1 }; } }; }
      if (url.includes(':1/')) { return { status: 401, ok: false }; }
      return { status: 200, ok: true, async json() { return { connection }; } };
    },
  });
  runInNewContext(functions(['resumeOnce']), context);
  assert.equal(await (context as any).resumeOnce(), true);
  assert.equal(connected[0], connection); assert.equal((context.resumeState as any).key, 'grant');
  assert.ok(calls.includes('http://127.0.0.1:2/resume'));
});

for (const rejected of [false, true]) {
  test(`Stop cancels annotation-delayed Send and restores its draft even when polling ${rejected ? 'fails' : 'succeeds'}`, async () => {
    let resolve!: () => void, reject!: (error: Error) => void;
    const polling = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    const delivered: any[] = [], restored: any[] = [];
    const attachments = [{ id: 'attachment-1' }];
    const context = createContext({ pendingSends: new Set(), annotations: { poll: () => polling },
      elementDrafts: { chat: { attachments } },
      enqueueChromeMessage: (message: unknown, chatId: string) => delivered.push({ message, chatId }),
      emit: (event: unknown) => restored.push(event), showFeedback() { assert.fail('cancelled polling must not show errors'); },
    });
    runInNewContext(functions(['prepareChromeMessage']), context);
    const prepare = (context as any).prepareChromeMessage;
    prepare({ type: 'send', text: 'Follow up' }, 'chat', 0);
    prepare({ type: 'stop' }, 'chat', 0);
    assert.equal(delivered.length, 1); assert.equal(delivered[0].message.type, 'stop');
    assert.equal(restored.length, 1); assert.equal(restored[0].text, 'Follow up');
    assert.equal(context.elementDrafts.chat.attachments, attachments);
    if (rejected) { reject(new Error('Polling failed')); } else { resolve(); }
    await polling.catch(() => {}); await Promise.resolve();
    assert.equal(delivered.length, 1); assert.equal(restored.length, 1);
    if (!rejected) {
      prepare({ type: 'send', text: 'New instruction' }, 'chat', 0);
      await Promise.resolve();
      assert.equal(delivered.length, 2); assert.equal(delivered[1].message.text, 'New instruction');
    }
  });
}

test('Stop in another chat does not cancel an annotation-delayed Send', async () => {
  let resolve!: () => void;
  const polling = new Promise<void>(done => { resolve = done; });
  const delivered: any[] = [];
  const context = createContext({ pendingSends: new Set(), annotations: { poll: () => polling },
    enqueueChromeMessage: (message: unknown, chatId: string) => delivered.push({ message, chatId }),
    emit() { assert.fail('must not restore another chat'); }, showFeedback() {},
  });
  runInNewContext(functions(['prepareChromeMessage']), context);
  (context as any).prepareChromeMessage({ type: 'send', text: 'Keep running' }, 'chat', 0);
  (context as any).prepareChromeMessage({ type: 'stop' }, 'other-chat', 0);
  resolve(); await polling; await Promise.resolve();
  assert.equal(delivered.length, 2); assert.equal(delivered[1].message.type, 'send');
  assert.equal(delivered[1].chatId, 'chat');
});
