import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

function harness(saved: string | null, editor = false, blocked = false) {
 const listeners = new Map<string, Set<(event?: any) => void>>();
 const mediaListeners = new Set<() => void>();
 const media = { matches: true, addEventListener(_: string, fn: () => void) { mediaListeners.add(fn); }, removeEventListener(_: string, fn: () => void) { mediaListeners.delete(fn); } };
 const root = { dataset: {} as Record<string, string>, style: { colorScheme: '', removeProperty() { this.colorScheme = ''; } } };
 const target = {
  matchMedia: () => media,
  addEventListener(type: string, fn: (event?: any) => void) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(fn); },
  removeEventListener(type: string, fn: (event?: any) => void) { listeners.get(type)?.delete(fn); },
  dispatchEvent(event: { type: string }) { for (const fn of listeners.get(event.type) ?? []) fn(event); },
 };
 const exports: any = {};
 runInNewContext(transpileModule(readFileSync('preview-src/uiTheme.ts', 'utf8'), {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS },
 }).outputText, { exports, window: target, document: { documentElement: root }, Event,
  localStorage: { getItem() { if (blocked) throw Error('blocked'); return saved; }, setItem(_: string, value: string) { if (blocked) throw Error('blocked'); saved = value; } },
 });
 const dispose = exports.initTheme(editor);
 return { root, api: exports, media, mediaListeners, listeners, dispose, saved: () => saved,
  os(light: boolean) { media.matches = light; for (const fn of mediaListeners) fn(); },
  storage(value: string | null, key: string | null = 'ai-browser:theme') { for (const fn of listeners.get('storage') ?? []) fn({ key, newValue: value }); },
 };
}

test('automatic browser appearance tracks device changes; explicit choice persists and wins', () => {
 const h = harness(null);
 assert.equal(h.root.dataset.theme, 'light');
 h.os(false); assert.equal(h.root.dataset.theme, 'dark');
 h.api.setThemePreference('light'); assert.equal(h.saved(), 'light');
 h.os(false); assert.equal(h.root.dataset.theme, 'light');
 assert.equal(harness(h.saved()).root.dataset.theme, 'light');
});

test('automatic editor appearance preserves native themes and removes a local override', () => {
 const h = harness(null, true);
 assert.equal(h.root.dataset.theme, undefined);
 h.api.setThemePreference('light'); assert.equal(h.root.dataset.theme, 'light');
 h.api.setThemePreference('system');
 assert.equal(h.root.dataset.theme, undefined); assert.equal(h.root.style.colorScheme, '');
});

test('website and embedded chat follow storage changes, reset and ignore unrelated preferences', () => {
 const h = harness('dark');
 h.storage('light'); assert.equal(h.root.dataset.theme, 'light'); assert.equal(h.api.getThemePreference(), 'light');
 h.storage('dark', 'unrelated'); assert.equal(h.root.dataset.theme, 'light');
 h.storage(null, null); assert.equal(h.api.getThemePreference(), 'system');
 h.os(false); assert.equal(h.root.dataset.theme, 'dark');
});

test('blocked storage and invalid preferences preserve usable appearance; disposal releases listeners', () => {
 const h = harness('invalid', false, true);
 assert.equal(h.root.dataset.theme, 'light');
 h.api.setThemePreference('dark'); assert.equal(h.root.dataset.theme, 'dark');
 h.dispose(); assert.equal(h.mediaListeners.size, 0);
 for (const handlers of h.listeners.values()) assert.equal(handlers.size, 0);
});
