import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { installChatSelectionCopy } from './chatSelection.ts';

function fixture(serialize?: (selection: Selection) => string | undefined) {
  const handlers = new Map<string, (event: any) => void>();
  const copied: string[] = [];
  const anchor = {}, focus = {};
  const selection = { isCollapsed: false, anchorNode: anchor, focusNode: focus, toString: () => 'Selected reply\nwith a second line' };
  const document = {
    activeElement: null as null | { closest(selector: string): unknown },
    getSelection: () => selection,
    addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
  };
  let inside = true;
  installChatSelectionCopy(document as unknown as Document, { contains: () => inside } as unknown as HTMLElement, text => copied.push(text), serialize);
  const dispatch = (type: string, extra: Record<string, unknown> = {}) => {
    let prevented = false;
    const data: string[] = [];
    handlers.get(type)!({ key: 'c', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, isComposing: false,
      preventDefault: () => { prevented = true; }, stopPropagation() {},
      clipboardData: { setData: (format: string, text: string) => data.push(format, text) }, ...extra });
    return { prevented, data };
  };
  return { document, copied, selection, dispatch, outside: () => { inside = false; } };
}

test('Ctrl+C and Cmd+C send exact selected text to the editor without clearing selection', () => {
  for (const modifiers of [{ ctrlKey: true, metaKey: false }, { ctrlKey: false, metaKey: true }]) {
    const f = fixture();
    assert.equal(f.dispatch('keydown', modifiers).prevented, true);
    assert.deepEqual(f.copied, ['Selected reply\nwith a second line']);
    assert.equal(f.selection.isCollapsed, false);
  }
});

test('native menu copy uses the editor clipboard even without a browser clipboard payload', () => {
  const f = fixture();
  const event = f.dispatch('copy');
  assert.equal(event.prevented, true);
  assert.deepEqual(event.data, ['text/plain', f.selection.toString()]);
  f.dispatch('copy', { clipboardData: null });
  assert.deepEqual(f.copied, [f.selection.toString(), f.selection.toString()]);
});

test('editing fields, empty selections, selections outside the chat and unrelated keys retain native behavior', () => {
  const f = fixture();
  f.document.activeElement = { closest: () => ({}) };
  assert.equal(f.dispatch('keydown').prevented, false);
  assert.equal(f.dispatch('copy').prevented, false);
  f.document.activeElement = null;
  f.selection.isCollapsed = true;
  assert.equal(f.dispatch('keydown').prevented, false);
  f.selection.isCollapsed = false;
  assert.equal(f.dispatch('keydown', { key: 'v' }).prevented, false);
  assert.equal(f.dispatch('keydown', { isComposing: true }).prevented, false);
  f.outside();
  assert.equal(f.dispatch('copy').prevented, false);
  assert.deepEqual(f.copied, []);
});

test('selected sent badges use their portable serialization for keyboard and menu copy', () => {
  const f = fixture(() => 'Text [att:id|file.ts]');
  f.dispatch('keydown');
  const copied = f.dispatch('copy');
  assert.deepEqual(f.copied, ['Text [att:id|file.ts]', 'Text [att:id|file.ts]']);
  assert.deepEqual(copied.data, ['text/plain', 'Text [att:id|file.ts]']);
});
