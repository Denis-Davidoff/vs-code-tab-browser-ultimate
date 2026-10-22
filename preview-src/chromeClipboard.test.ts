import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createSourceFile, forEachChild, isBinaryExpression, ScriptTarget, transpileModule } from 'typescript';

function fixture() {
  const source = readFileSync('chrome-extension/sidepanel.ts', 'utf8');
  const ast = createSourceFile('sidepanel.ts', source, ScriptTarget.ES2022, true);
  let method = '';
  const visit = (node: any) => {
    if (isBinaryExpression(node) && node.left.getText(ast) === 'window.aiBrowserChatHost') {
      method = (node.right as any).properties.find((property: any) => property.name?.getText(ast) === 'postMessage').getText(ast);
    }
    forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(method);
  const attached: any[] = [], emitted: any[] = [];
  const latest = { chatId: 'chat-B', view: { tabs: [{ id: 'tab-A', chatId: 'chat-A' }, { id: 'tab-B', chatId: 'chat-B' }] } };
  const post = runInNewContext(transpileModule(`const host = { ${method} }; host.postMessage;`, {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText, { supportsFeature: () => true, latest, active: {}, generation: 1,
    addChromeAttachment: async (...args: any[]) => { attached.push(args); },
    emit: (message: any) => emitted.push(message),
  });
  return { post, latest, attached, emitted };
}
const paste = { type: 'pasteFile', id: 'paste-1', chatId: 'chat-A', tabId: 'tab-A', name: 'private.txt', mime: 'text/plain', base64: 'aGVsbG8=' };

test('a clipboard read begun in A attaches to A after the Chrome conversation selector changes to B', async () => {
  const f = fixture();
  f.post(paste); await Promise.resolve();
  assert.equal(f.attached.length, 1); assert.equal(f.attached[0][0], 'chat-A');
  assert.equal(f.emitted[0].id, paste.id); assert.equal(f.emitted[0].error, undefined);
});

test('a clipboard read whose destination closed is rejected instead of attaching to the current chat', () => {
  const f = fixture(); f.latest.view.tabs = [{ id: 'tab-B', chatId: 'chat-B' }];
  f.post(paste);
  assert.equal(f.attached.length, 0); assert.match(f.emitted[0].error, /destination chat/);
  f.post({ ...paste, tabId: 'tab-B' });
  assert.equal(f.attached.length, 0, 'a mismatched tab/chat pair is rejected too');
});
