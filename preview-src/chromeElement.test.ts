import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

function load(file: string, globals: Record<string, unknown> = {}): any {
  const module = { exports: {} };
  runInNewContext(transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, Error, URL, setTimeout, clearTimeout, ...globals,
    require: (specifier: string) => load(path.join(path.dirname(file), `${specifier}.ts`), globals),
  });
  return module.exports;
}

class MockNode {
  localName = 'div'; id = ''; classList: string[] = []; children: MockNode[] = [];
  parentElement: MockNode | null = null;
  outerHTML = '<div></div>'; removed = false; textContent = '';
  handlers = new Map<string, (event: any) => void>();
  style: any = { setProperty() {} };
  append(...nodes: MockNode[]) { this.children.push(...nodes); }
  remove() { this.removed = true; }
  getRootNode() { return {}; }
  getBoundingClientRect() { return { top: 10, left: 20, width: 100, height: 40 }; }
  attachShadow() { return new MockShadow(this); }
  addEventListener(type: string, listener: (event: any) => void) { this.handlers.set(type, listener); }
}
class MockShadow {
  readonly host: MockNode;
  constructor(host: MockNode) { this.host = host; }
  append(..._nodes: MockNode[]) {}
}

function page() {
  const html = new MockNode();
  const target = new MockNode(); target.localName = 'button'; target.id = 'save';
  target.outerHTML = '<button id="save">Save</button>';
  const handlers = new Map<string, (event: any) => void>();
  const window = {
    addEventListener(type: string, listener: (event: any) => void) { handlers.set(type, listener); },
    removeEventListener(type: string) { handlers.delete(type); },
  };
  const picker = load('chrome-extension/elementPicker.ts', {
    window, document: { documentElement: html, createElement: () => new MockNode(), elementFromPoint: () => target },
    ShadowRoot: MockShadow, CSS: { escape: (value: string) => value }, location: { href: 'https://name:password@example.com/page' },
    getComputedStyle: () => ({ getPropertyValue: (name: string) => name === 'display' ? 'block' : '' }),
  });
  return { picker, window: window as any, html, target, handlers };
}

test('picker blocks page navigation, ignores synthetic clicks and returns redacted context on a real selection', async () => {
  const p = page();
  p.target.outerHTML = '<button><input type="password" value="never-send-this"><input autocomplete="one-time-code" value="123456"></button>';
  const result = p.picker.startElementPick('pick-one');
  const overlay = p.html.children[0];
  let prevented = 0, stopped = 0;
  const event = { button: 0, clientX: 25, clientY: 15, isTrusted: false,
    preventDefault() { prevented++; }, stopImmediatePropagation() { stopped++; } };
  overlay.handlers.get('click')!(event);
  assert.equal(overlay.removed, false);
  overlay.handlers.get('click')!({ ...event, isTrusted: true });
  const selected = await result;
  assert.equal(prevented, 2); assert.equal(stopped, 2);
  assert.equal(overlay.removed, true); assert.equal(p.handlers.size, 0);
  assert.equal(selected.selector, 'button#save'); assert.equal(selected.url, 'https://example.com/page');
  assert.equal(selected.dimensions.width, 100);
  assert.match(selected.computedStyle, /display: block/);
  assert.equal(selected.outerHTML.includes('never-send-this'), false);
  assert.equal(selected.outerHTML.includes('123456'), false);
});

test('Escape and matching cancellation clean up the page; an older request cannot cancel a newer pick', async () => {
  const p = page();
  const first = p.picker.startElementPick('first');
  const second = p.picker.startElementPick('second');
  assert.equal(await first, undefined);
  assert.equal(p.html.children[0].removed, true);
  p.window.__aiBrowserChromeElementPicker.cancel('first');
  assert.equal(p.html.children[1].removed, false);
  p.window.__aiBrowserChromeElementPicker.cancel('second');
  assert.equal(await second, undefined); assert.equal(p.html.children[1].removed, true);
  const third = p.picker.startElementPick('third');
  p.handlers.get('keydown')!({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(await third, undefined); assert.equal(p.handlers.size, 0);
});

test('new picks and restored sends retain distinct references after removing earlier elements', () => {
  const { appendPickedElement, restorePickedElements } = load('chrome-extension/elementDrafts.ts');
  const draft: any = { next: 1, attachments: [] };
  appendPickedElement(draft, { id: 'first-element', label: 'First', text: 'First context' });
  const removed = draft.attachments.shift();
  appendPickedElement(draft, { id: 'second-element', label: 'Second', text: 'Second context' });
  assert.equal(draft.attachments[0].reference, '@2');
  const text = restorePickedElements(draft, [removed], 'Inspect @1, not @10');
  assert.equal(text, 'Inspect @3, not @10');
  assert.equal(draft.attachments[1].text, 'First context');
  restorePickedElements(draft, [removed], 'Inspect @1');
  assert.equal(draft.attachments.length, 2);
  for (let i = 0; i < 6; i++) { appendPickedElement(draft, { id: `element-${i}`, label: 'Element', text: 'Context' }); }
  assert.throws(() => appendPickedElement(draft, { id: 'too-many', label: 'Element', text: 'Context' }), /maximum 8/);
});
