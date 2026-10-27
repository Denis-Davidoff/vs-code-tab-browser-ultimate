import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { runInNewContext, createContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { parseAnnotations, annotationClipboardText } from '../src/browser/annotationData.ts';

function fixture(options: { rejectClipboard?: boolean; noClipboard?: boolean; legacyCopy?: boolean } = {}) {
  const pages = new Map<number, any>();
  const changes: any[] = [], clipboard: string[] = [], errors: unknown[] = [];
  let saved: any, confirm = false, inPage = false, selectedText = '', removedFields = 0, pageFields = 0, panelFields = 0;
  const context = createContext({ module: { exports: {} }, exports: {}, Error, Map, Set, Promise,
    require: () => ({ parseAnnotations, annotationClipboardText }),
    navigator: { clipboard: options.noClipboard ? undefined : { async writeText(value: string) {
      if (!inPage || options.rejectClipboard) { throw new Error('Document is not focused'); }
      clipboard.push(value);
    } } },
    HTMLElement: class {},
    document: { activeElement: null, getSelection: () => null, documentElement: { append() { pageFields++; } }, body: { append() { if (inPage) { pageFields++; } else { panelFields++; } } },
      createElement: () => ({ value: '', style: {}, setAttribute() {}, select() { selectedText = this.value; }, remove() { removedFields++; } }),
      execCommand: (command: string) => { assert.equal(command, 'copy'); if (options.legacyCopy === false) { return false; } clipboard.push(selectedText); return true; },
    },
  });
  context.exports = context.module.exports;
  function addTab(id: number) { pages.set(id, { url: `https://example.test/${id}`, events: [], records: [], api: undefined }); }
  const chrome = {
    storage: { session: { async set(value: unknown) { saved = JSON.parse(JSON.stringify(value)); } } },
    tabs: { async get(id: number) { if (!pages.has(id)) { throw new Error('Tab closed'); } return { id, url: pages.get(id).url }; } },
    scripting: { async executeScript(options: any) {
      const page = pages.get(options.target.tabId); if (!page) { throw new Error('Tab closed'); }
      if (options.files) {
        page.api ??= {
          hydrate(data: any) { page.records = JSON.parse(JSON.stringify(data.records)); page.nextNumber = data.nextNumber; },
          start(data: any) { this.hydrate(data); page.picking = true; page.mode = data.mode; },
          collect() { return { url: page.url, records: page.records.map((record: any) => ({ ...record, elementFound: true })) }; },
          remove(ids: string[], url: string) { assert.equal(page.url, url); page.records = page.records.filter((record: any) => !ids.includes(record.id)); },
          add(selector: string, text: string, color: string, id: string) {
            const record = note(page.nextNumber++, id); record.text = text; record.color = color; record.element.selector = selector; page.records.push(record);
            return { id, number: record.number, url: page.url };
          },
          dispose() { page.api = undefined; },
        };
        return [];
      }
      context.location = { href: page.url };
      context.window = { __aiBrowserAnnotations: page.api, __aiBrowserChromeAnnotationEvents: page.events, confirm: () => confirm };
      inPage = true;
      try { return [{ result: await options.func(...(options.args ?? [])) }]; }
      finally { inPage = false; }
    } },
  };
  context.chrome = chrome;
  runInNewContext(transpileModule(readFileSync('chrome-extension/annotations.ts', 'utf8'), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText, context);
  const manager = new context.module.exports.ChromeAnnotations((tab: unknown, page: unknown) => changes.push(JSON.parse(JSON.stringify({ tab, page }))), (error: unknown) => errors.push(error));
  return { manager, pages, changes, clipboard, errors, addTab, removedFields: () => removedFields, pageFields: () => pageFields, panelFields: () => panelFields, saved: () => saved, confirm: (value: boolean) => { confirm = value; } };
}
function note(number: number, id: string = randomUUID()) {
  return { id, number, createdAt: 1, text: 'User note', color: '#2563eb', element: { selector: '#save', strong: true, tag: 'button', text: 'Save', role: '' } };
}

test('Chrome annotation edits stay bound to the originating chat, survive navigation and retain numbers', async () => {
  const f = fixture(); f.addTab(1); f.addTab(2);
  await f.manager.start(1, 'chat-1');
  const page = f.pages.get(1); page.records.push(note(1));
  await f.manager.poll();
  await f.manager.start(2, 'chat-2');
  page.records[0].text = 'Updated note';
  await f.manager.poll();
  assert.equal(f.changes.at(-1).tab.chatId, 'chat-1');
  assert.equal(f.changes.at(-1).page.records[0].text, 'Updated note');
  const original = page.url; page.url = 'https://example.test/new'; page.api = undefined;
  await f.manager.poll(); assert.equal(page.records.length, 0);
  page.url = original; page.api = undefined;
  await f.manager.poll(); assert.equal(page.records[0].text, 'Updated note'); assert.equal(page.nextNumber, 2);
  assert.equal(f.errors.length, 0); assert.equal(f.saved().annotationTabs.length, 2);
});

test('Chrome annotation copy and delete use the shared record and require confirmation for a nonempty note', async () => {
  const f = fixture(); f.addTab(1); await f.manager.start(1, 'chat-1');
  const page = f.pages.get(1); const record = note(1); page.records.push(record);
  page.events.push({ type: 'copy', id: record.id, url: page.url }); await f.manager.poll();
  assert.equal(f.clipboard[0], annotationClipboardText(record, page.url));
  page.events.push({ type: 'requestDelete', id: record.id, url: page.url }); await f.manager.poll();
  assert.equal(page.records.length, 1);
  f.confirm(true); page.events.push({ type: 'requestDelete', id: record.id, url: page.url }); await f.manager.poll();
  assert.equal(page.records.length, 0); assert.equal(f.changes.at(-1).page.records.length, 0);
});

test('Chrome MCP operations keep assistant provenance and remove sent notes from an older URL without touching the current page', async () => {
  const f = fixture(); f.addTab(1); await f.manager.start(1, 'chat-1');
  const page = f.pages.get(1), id = randomUUID();
  const value = await f.manager.execute({ id: randomUUID(), chatId: 'chat-1', tabId: 1, url: page.url, action: 'add', selector: '#save', text: 'Agent note', annotationId: id });
  assert.equal(value.id, id); assert.equal(f.manager.snapshot()[0].assistant[0], id);
  await assert.rejects(f.manager.execute({ id: randomUUID(), chatId: 'wrong-chat', tabId: 1, url: page.url, action: 'remove', ids: [id] }), /changed|available/);
  const original = page.url; page.url = 'https://example.test/new'; page.api = undefined;
  await f.manager.poll();
  page.records.push(note(2)); await f.manager.poll();
  await f.manager.remove(1, original, [id]);
  assert.equal(page.records.length, 1); assert.equal(f.manager.snapshot()[0].pages.find((p: any) => p.url === original).records.length, 0);
  await f.manager.retainChats(new Set()); assert.equal(f.manager.snapshot().length, 0); assert.equal(page.api, undefined);
});

test('closing the original chat removes its markers even after another chat starts annotating the same tab', async () => {
  const f = fixture(); f.addTab(1); await f.manager.start(1, 'chat-1');
  const page = f.pages.get(1), original = note(1); page.records.push(original);
  await f.manager.poll();
  await f.manager.start(1, 'chat-2');
  const second = note(2); page.records.push(second); await f.manager.poll();
  assert.equal(f.manager.snapshot()[0].owners[original.id], 'chat-1');
  assert.equal(f.manager.snapshot()[0].owners[second.id], 'chat-2');
  await f.manager.retainChats(new Set(['chat-2']));
  assert.equal(page.records.length, 1); assert.equal(page.records[0].id, second.id);
  f.manager.dismiss(1, second.id); f.manager.sent(1, second.id);
  const restored = fixture(); restored.manager.restore(f.saved().annotationTabs);
  assert.equal(restored.manager.snapshot()[0].sent[0], second.id);
  assert.equal(restored.manager.snapshot()[0].dismissed[0], second.id);
});

test('both conversations retain annotation grants across save, restore and MCP cleanup from A', async () => {
  const f = fixture(); f.addTab(1); await f.manager.start(1, 'chat-1');
  const page = f.pages.get(1), record = note(1); page.records.push(record); await f.manager.poll();
  await f.manager.start(1, 'chat-2');
  const restored = fixture(); restored.addTab(1); restored.manager.restore(f.saved().annotationTabs);
  await restored.manager.poll();
  assert.deepEqual(Array.from(restored.manager.snapshot()[0].chatIds).sort(), ['chat-1', 'chat-2']);
  await restored.manager.execute({ id: randomUUID(), chatId: 'chat-1', tabId: 1, url: page.url, action: 'remove', ids: [record.id] });
  assert.equal(restored.pages.get(1).records.length, 0);
  await restored.manager.retainChats(new Set(['chat-2']));
  assert.deepEqual(Array.from(restored.manager.snapshot()[0].chatIds), ['chat-2']);
  await assert.rejects(restored.manager.execute({ id: randomUUID(), chatId: 'chat-1', tabId: 1, url: page.url, action: 'remove', ids: [] }), /available/);
});


test('Chrome starts both picker modes and preserves point context across storage and restore', async () => {
  const f = fixture(); f.addTab(1);
  await f.manager.start(1, 'chat-1', 'point');
  const page = f.pages.get(1);
  assert.equal(page.mode, 'point');
  const record = { ...note(1), point: { x: 120, y: 350, viewportX: 120, viewportY: 50, elements: [note(1).element] } };
  page.records.push(record);
  await f.manager.poll();
  const restored = fixture(); restored.addTab(1); restored.manager.restore(f.saved().annotationTabs);
  await restored.manager.poll();
  await restored.manager.start(1, 'chat-1', 'element');
  assert.equal(restored.pages.get(1).mode, 'element');
  assert.deepEqual(restored.pages.get(1).records[0].point, record.point);
});


for (const noClipboard of [false, true]) {
  test(`Chrome annotation copy falls back in the side panel, never the page, when Clipboard API is ${noClipboard ? 'missing' : 'denied'}`, async () => {
    const f = fixture({ rejectClipboard: true, noClipboard }); f.addTab(1); await f.manager.start(1, 'chat-1');
    const page = f.pages.get(1), record = note(1); page.records.push(record);
    page.events.push({ type: 'copy', id: record.id, url: page.url }); await f.manager.poll();
    assert.equal(f.clipboard[0], annotationClipboardText(record, page.url));
    assert.equal(f.errors.length, 0); assert.equal(f.removedFields(), 1);
    assert.equal(f.pageFields(), 0); assert.equal(f.panelFields(), 1);
  });
}

test('a refused fallback reports copy failure and cleans up its temporary field', async () => {
  const f = fixture({ rejectClipboard: true, legacyCopy: false }); f.addTab(1); await f.manager.start(1, 'chat-1');
  const page = f.pages.get(1), record = note(1); page.records.push(record);
  page.events.push({ type: 'copy', id: record.id, url: page.url }); await f.manager.poll();
  assert.equal(f.clipboard.length, 0); assert.equal(f.removedFields(), 1); assert.equal(f.pageFields(), 0);
  assert.match(String(f.errors[0]), /Could not copy the annotation/);
});
