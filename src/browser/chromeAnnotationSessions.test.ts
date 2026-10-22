import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { parseAnnotations, annotationColors } from './annotationData.ts';

function fixture() {
  const module = { exports: {} as any };
  runInNewContext(transpileModule(readFileSync('src/browser/chromeAnnotationSessions.ts', 'utf8'), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, setTimeout, clearTimeout,
    require: (name: string) => name === 'node:crypto' ? { randomUUID } : { parseAnnotations, annotationColors },
  });
  const chats = new Set(['chat-1', 'chat-2']);
  const session = new module.exports.ChromeAnnotationSession(() => chats);
  const caller = { kind: 'codex', chatId: 'chat-1' };
  const record = { id: randomUUID(), number: 1, createdAt: 1, text: 'User note', color: annotationColors[0],
    element: { selector: '#save', strong: true, tag: 'button', text: 'Save', role: '' } };
  const tab = { tabId: 7, chatId: 'chat-1', url: 'https://example.test/', pages: [{ url: 'https://example.test/', records: [record], found: [record.id] }] };
  const sync = (results: unknown[] = []) => session.sync({ tabs: [tab], results });
  sync();
  return { session, caller, record, tab, sync, chats, registry: module.exports.chromeAnnotationSessions };
}

test('Chrome MCP annotation sessions expose only the explicitly owning chat and retain page identity', () => {
  const f = fixture();
  assert.equal(f.session.list('chrome-annotations:7', 0, 10, f.caller).annotations[0].author, 'user');
  assert.equal(f.session.list('chrome-annotations:7', 0, 10, f.caller).annotations[0].elementFound, true);
  assert.throws(() => f.session.list('chrome-annotations:7', 0, 10, { kind: 'codex', chatId: 'chat-2' }), /unavailable/);
  assert.equal(f.session.visible({ kind: 'codex' }).length, 0);
  assert.throws(() => f.session.sync({ tabs: [{ ...f.tab, chatId: 'unknown' }], results: [] }), /Invalid/);
  assert.throws(() => f.session.sync({ tabs: [f.tab, f.tab], results: [] }), /Invalid/);
  assert.throws(() => f.session.list('chrome-annotations:7', -1, 10, f.caller), /offset/);
  const result = f.session.get('chrome-annotations:7', [f.record.id, 'missing'], f.caller);
  assert.equal(result.annotations[0].url, f.tab.url); assert.equal(result.missing[0], 'missing');
  f.chats.delete('chat-1');
  assert.equal(f.session.visible(f.caller).length, 0);
  f.session.close();
});

test('MCP mutations wait for Chrome acknowledgement and assistant markers never become user notes', async () => {
  const f = fixture();
  const adding = f.session.add('chrome-annotations:7', '#save', 'Agent note', 'green', f.caller);
  const task = f.sync()[0];
  assert.equal(task.action, 'add'); assert.equal(task.color, annotationColors[6]);
  assert.equal(f.sync()[0].id, task.id, 'poll retries preserve the operation ID');
  const agentRecord = { ...f.record, id: task.annotationId, number: 2, text: 'Agent note' };
  f.tab.pages[0].records.push(agentRecord);
  f.sync([{ id: task.id, value: { id: agentRecord.id, number: 2, url: f.tab.url } }]);
  assert.equal((await adding).id, agentRecord.id);
  assert.equal(f.session.list('chrome-annotations:7', 0, 10, f.caller).annotations[1].author, 'assistant');
  const removing = f.session.remove('chrome-annotations:7', undefined, f.caller);
  const removeTask = f.sync()[0];
  assert.equal(removeTask.ids.length, 2);
  f.sync([{ id: removeTask.id, value: { removed: 2 } }]);
  assert.equal((await removing).removed, 2);
  const failing = f.session.add('chrome-annotations:7', '#missing', '', undefined, f.caller);
  f.sync([{ id: f.sync()[0].id, error: 'No matching element' }]);
  await assert.rejects(failing, /No matching element/);
  f.session.close();
});

test('closing the bridge revokes registry access and cancels pending annotation calls', async () => {
  const f = fixture(); const release = f.registry.register(f.session);
  assert.equal(f.registry.visible(f.caller)[0].capabilities[0], 'annotations');
  const pending = f.session.remove('chrome-annotations:7', [f.record.id], f.caller);
  release();
  await assert.rejects(pending, /connection closed/);
  assert.equal(f.registry.visible(f.caller).length, 0);
  assert.throws(() => f.registry.forTab('chrome-annotations:7', f.caller), /unavailable/);
});

test('sharing an annotated tab with B preserves A grants and routes cleanup with the sending conversation', async () => {
  const f = fixture(); const release = f.registry.register(f.session);
  const shared = { ...f.tab, chatId: 'chat-2', chatIds: ['chat-1', 'chat-2'] };
  const sync = (results: unknown[] = []) => f.session.sync({ tabs: [shared], results });
  try {
    sync();
    assert.equal(f.session.list('chrome-annotations:7', 0, 10, f.caller).annotations[0].id, f.record.id);
    assert.equal(f.session.visible({ kind: 'claude', chatId: 'chat-2' }).length, 1);
    assert.equal(f.session.visible({ kind: 'codex', chatId: 'unrelated' }).length, 0);
    const pending = f.session.add('chrome-annotations:7', '#save', 'A still has access', undefined, f.caller);
    const add = sync()[0]; assert.equal(add.chatId, 'chat-1');
    sync([{ id: add.id, value: { id: add.annotationId } }]); await pending;
    const removal = f.registry.removeSent({ tabId: 7, url: f.tab.url, id: f.record.id, chatId: 'chat-1' });
    const task = sync()[0]; assert.equal(task.chatId, 'chat-1'); assert.equal(task.ids[0], f.record.id);
    sync([{ id: task.id, value: { removed: 1 } }]); assert.equal((await removal).removed, 1);
    f.chats.delete('chat-1'); shared.chatIds = ['chat-2']; sync();
    assert.equal(f.session.visible(f.caller).length, 0);
    assert.throws(() => f.session.get('chrome-annotations:7', [f.record.id], f.caller), /unavailable/);
    assert.throws(() => f.session.sync({ tabs: [{ ...shared, chatIds: ['chat-2', 'unknown-chat'] }], results: [] }), /Invalid/);
  } finally { release(); }
});
