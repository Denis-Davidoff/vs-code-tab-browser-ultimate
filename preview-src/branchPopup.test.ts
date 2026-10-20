import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

test('branch keyboard navigation reaches rows and actions and Escape restores focus', () => {
 const source = readFileSync(resolve('preview-src/chat.ts'), 'utf8');
 const start = source.indexOf("branchSearch.addEventListener('keydown'");
 const end = source.indexOf('/** Adding or editing a toolbar skill', start);
 assert.ok(start >= 0 && end > start);
 const handlers: Record<string, (event: any) => void> = {};
 const doc: { activeElement: any } = { activeElement: undefined };
 const control = (name: string) => ({
  name, focus() { doc.activeElement = this; },
  addEventListener(type: string, handler: (event: any) => void) { handlers[`${name}:${type}`] = handler; },
 });
 const search = { ...control('search'), value: '' };
 const first = control('first'), remove = control('remove'), cancel = control('cancel'), last = control('last');
 const firstRow = { querySelectorAll: () => [first, remove, cancel] };
 const lastRow = { querySelectorAll: () => [last] };
 Object.assign(first, { closest: () => firstRow });
 Object.assign(remove, { closest: () => firstRow });
 Object.assign(cancel, { closest: () => firstRow });
 Object.assign(last, { closest: () => lastRow });
 let closed = false;
 const context = {
  document: doc, branchSearch: search,
  branchList: { ...control('list'), querySelectorAll: () => [first, last] },
  branchPopup: control('popup'), branchButton: control('button'),
  closePopups() { closed = true; },
 };
 runInNewContext(transpileModule(source.slice(start, end), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
 }).outputText, context);
 function key(target: string, value: string, isComposing = false) {
  let prevented = false, stopped = false;
  handlers[`${target}:keydown`]({ key: value, isComposing,
   preventDefault() { prevented = true; }, stopPropagation() { stopped = true; },
  });
  return { prevented, stopped };
 }
 search.focus();
 key('search', 'ArrowDown'); assert.equal(doc.activeElement, first);
 key('list', 'ArrowRight'); assert.equal(doc.activeElement, remove);
 key('list', 'ArrowRight'); assert.equal(doc.activeElement, cancel);
 key('list', 'ArrowLeft'); assert.equal(doc.activeElement, remove);
 key('list', 'ArrowDown'); assert.equal(doc.activeElement, last);
 key('list', 'Home'); assert.equal(doc.activeElement, first);
 key('list', 'End'); assert.equal(doc.activeElement, last);
 key('list', 'ArrowUp'); assert.equal(doc.activeElement, first);
 key('list', 'ArrowUp'); assert.equal(doc.activeElement, search);
 key('search', 'ArrowUp'); assert.equal(doc.activeElement, last);
 key('popup', 'Escape', true); assert.equal(closed, false);
 assert.deepEqual(key('popup', 'Escape'), { prevented: true, stopped: true });
 assert.equal(closed, true); assert.equal(doc.activeElement, context.branchButton);
});

test('deleting a branch keeps the popup and search query; switch/create still close it', () => {
 const source = readFileSync(resolve('preview-src/chat.ts'), 'utf8');
 const block = /case 'gitBranchResult': \{[\s\S]*?\n  \}/.exec(source)?.[0];
 assert.ok(block);
 const compiled = transpileModule(`(function(message) { switch (message.type) { ${block} } })`, {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
 }).outputText;
 for (const action of ['delete', 'switch', 'create']) {
  let open = true, searchFocused = false, branchFocused = false;
  const search = { value: 'feature', focus() { searchFocused = true; } };
  const context = {
   gitFolder: '/repo', branchBusy: true, branchDeleting: 'feature/old', branchError: { textContent: '' },
   branchPopup: { classList: { contains: () => open } }, branchSearch: search,
   branchButton: { focus() { branchFocused = true; } }, renderBranches() {}, renderGitChanges() {},
   closePopups() { open = false; },
  };
  runInNewContext(compiled, context)({ type: 'gitBranchResult', folder: '/repo', action });
  assert.equal(open, action === 'delete');
  assert.equal(searchFocused, action === 'delete');
  assert.equal(branchFocused, action !== 'delete');
  assert.equal(search.value, 'feature');
  assert.equal(context.branchBusy, false);
  assert.equal(context.branchDeleting, undefined);
 }
});
