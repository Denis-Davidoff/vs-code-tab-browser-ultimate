import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

function fixture(saved: string | null = null, blocked = false) {
  const root = { dataset: {} as Record<string, string> };
  let listener: ((event: { key: string | null; newValue: string | null }) => void) | undefined;
  const exports: any = {};
  runInNewContext(transpileModule(readFileSync('preview-src/chatAppearance.ts', 'utf8'), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText, { exports, document: { documentElement: root },
    localStorage: {
      getItem() { if (blocked) throw Error('blocked'); return saved; },
      setItem(_key: string, value: string) { if (blocked) throw Error('blocked'); saved = value; },
    }, window: {
      addEventListener(_name: string, fn: typeof listener) { listener = fn; },
      removeEventListener() { listener = undefined; },
    },
  });
  const dispose = exports.initChatAppearance();
  return { root, api: exports, saved: () => saved, dispose,
    storage(key: string | null, newValue: string | null) { listener?.({ key, newValue }); } };
}

test('file icons start enabled, toggle immediately and restore the saved choice', () => {
  const f = fixture();
  assert.equal(f.root.dataset.chatFileIcons, 'true');
  f.api.setChatFileIcons(false);
  assert.equal(f.api.getChatFileIcons(), false);
  assert.equal(f.root.dataset.chatFileIcons, 'false');
  assert.equal(fixture(f.saved()).api.getChatFileIcons(), false);
  f.api.setChatFileIcons(true);
  assert.equal(f.root.dataset.chatFileIcons, 'true');
});

test('display preference follows other chat windows and storage reset without changing theme', () => {
  const f = fixture('false');
  f.storage('ai-browser:theme', 'dark');
  assert.equal(f.api.getChatFileIcons(), false);
  f.storage('ai-browser:chat-file-icons', 'true');
  assert.equal(f.api.getChatFileIcons(), true);
  f.api.setChatFileIcons(false); f.storage(null, null);
  assert.equal(f.root.dataset.chatFileIcons, 'true');
  f.dispose(); f.storage('ai-browser:chat-file-icons', 'false');
  assert.equal(f.api.getChatFileIcons(), true);
});

test('blocked storage still permits changing the display for the current session', () => {
  const f = fixture(null, true);
  f.api.setChatFileIcons(false);
  assert.equal(f.root.dataset.chatFileIcons, 'false');
});
