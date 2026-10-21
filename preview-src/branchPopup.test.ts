import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

test('branch keyboard navigation walks actions and rows top to bottom, and Escape restores focus', () => {
 const source = readFileSync(resolve('preview-src/chat.ts'), 'utf8');
 const start = source.indexOf("branchSearch.addEventListener('keydown'");
 const end = source.indexOf('/** Adding or editing a toolbar skill', start);
 assert.ok(start >= 0 && end > start);
 // Several handlers may listen for one event on one element; each is called.
 const handlers: Record<string, ((event: any) => void)[]> = {};
 const doc: { activeElement: any } = { activeElement: undefined };
 class HTMLButtonElement {
  disabled = false; hidden = false; offsetParent = {};
  readonly name: string;
  constructor(name: string) { this.name = name; }
  focus() { doc.activeElement = this; }
  closest(_: string): any { return undefined; }
  addEventListener(type: string, handler: (event: any) => void) { (handlers[`${this.name}:${type}`] ??= []).push(handler); }
 }
 const search = Object.assign(new HTMLButtonElement('search'), { value: '' });
 const push = new HTMLButtonElement('push'), pr = new HTMLButtonElement('pr'), create = new HTMLButtonElement('create');
 const first = new HTMLButtonElement('first'), remove = new HTMLButtonElement('remove'), cancel = new HTMLButtonElement('cancel');
 const last = new HTMLButtonElement('last'), hiddenStash = new HTMLButtonElement('stash');
 hiddenStash.hidden = true;
 const syncRow = { querySelectorAll: () => [push, pr], querySelector: () => undefined };
 const firstRow = { querySelectorAll: () => [first, remove, cancel], querySelector: () => first };
 const lastRow = { querySelectorAll: () => [last], querySelector: () => last };
 for (const [button, row] of [[push, syncRow], [pr, syncRow], [first, firstRow], [remove, firstRow], [cancel, firstRow], [last, lastRow]] as const) {
  button.closest = (selector: string) => selector.includes('.git-branch-row') && row !== syncRow ? row
   : selector.includes('git-branch-sync-actions') && row === syncRow ? row : undefined;
 }
 let closed = false;
 const popup = Object.assign(new HTMLButtonElement('popup'), {
  querySelectorAll: () => [push, pr, hiddenStash, create, first, last],
  contains: (node: unknown) => node !== search,
 });
 const context = {
  document: doc, branchSearch: search, HTMLButtonElement,
  branchList: new HTMLButtonElement('list'), branchPopup: popup, branchButton: new HTMLButtonElement('button'),
  branchCreate: create, branchState: undefined,
  closePopups() { closed = true; },
 };
 runInNewContext(transpileModule(source.slice(start, end), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
 }).outputText, context);
 // A key goes to the focused element and bubbles up to the popup, as in the
 // page: ↓ in the search box focused the first item and the popup's handler,
 // reading the active element, moved it a second step.
 function key(_: string, value: string, isComposing = false) {
  let prevented = false, stopped = false;
  const target = doc.activeElement;
  const path = target === popup ? ['popup'] : [target.name, 'popup'];
  for (const name of path) {
   for (const handler of handlers[`${name}:keydown`] ?? []) {
    handler({ key: value, isComposing, target, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
   }
   if (stopped) { break; }
  }
  return { prevented, stopped };
 }
 search.focus();
 key('search', 'ArrowDown'); assert.equal(doc.activeElement, push);
 key('popup', 'ArrowRight'); assert.equal(doc.activeElement, pr);
 key('popup', 'ArrowDown'); assert.equal(doc.activeElement, create, 'the hidden stash row is skipped');
 key('popup', 'ArrowDown'); assert.equal(doc.activeElement, first);
 key('popup', 'ArrowRight'); assert.equal(doc.activeElement, remove);
 key('popup', 'ArrowRight'); assert.equal(doc.activeElement, cancel);
 key('popup', 'ArrowLeft'); assert.equal(doc.activeElement, remove);
 key('popup', 'ArrowDown'); assert.equal(doc.activeElement, last, 'down from a row\'s delete goes to the next row');
 key('popup', 'Home'); assert.equal(doc.activeElement, push);
 key('popup', 'End'); assert.equal(doc.activeElement, last);
 key('popup', 'ArrowUp'); assert.equal(doc.activeElement, first);
 key('popup', 'ArrowUp'); assert.equal(doc.activeElement, create);
 key('popup', 'ArrowUp'); assert.equal(doc.activeElement, pr);
 key('popup', 'ArrowUp'); assert.equal(doc.activeElement, push);
 key('popup', 'ArrowUp'); assert.equal(doc.activeElement, search);
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
