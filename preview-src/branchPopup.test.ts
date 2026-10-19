import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

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
