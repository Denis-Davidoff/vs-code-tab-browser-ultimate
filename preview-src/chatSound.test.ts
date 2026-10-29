import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript';
import { visibleTerminalFront } from './terminalTabs.ts';

const source = readFileSync('preview-src/chat.ts', 'utf8');
const ast = createSourceFile('chat.ts', source, ScriptTarget.ES2022, true);
function declaration(name: string): string {
  const node = ast.statements.find(node => isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, name);
  return node.getText(ast);
}

function fixture(activeChat?: boolean) {
  const sounds: unknown[][] = [], notifications: unknown[][] = [];
  const document = { hidden: false, focused: true, hasFocus() { return this.focused; } };
  const sound = { enabled: true, activeChat, sound: 'chime', volume: 60, repeat: 1, notify: true };
  const api = runInNewContext(transpileModule(`let soundBusy;
    ${declaration('soundOnFinish')}
    ({ finish: soundOnFinish });`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, {
    document, visibleTerminalFront, remoteSurface: (s: any) => !!s.surface && s.surface !== 'editor',
    effectiveSound: (s: any) => s.sound, soundOn: () => sound.enabled,
    playChatSound: (...args: unknown[]) => sounds.push(args), notifyFinished: (...args: unknown[]) => notifications.push(args),
  });
  const state = { activeTab: 'a', sound, tabs: [
    { id: 'a', title: 'Active', busy: true, status: 'working' },
    { id: 'b', title: 'Background', busy: true, status: 'working' },
  ], terminals: [{ id: 'terminal' }], terminalFront: undefined as string | undefined,
    windowFocused: true as boolean | undefined, surface: 'editor' };
  api.finish(state);
  return { sounds, notifications, document, state, finish: (...ids: string[]) => {
    for (const tab of state.tabs) { if (ids.includes(tab.id)) { tab.busy = false; tab.status = 'read'; } }
    api.finish(state);
  } };
}

test('active visible chat finishes silently by default, including older hosts, without suppressing notifications', () => {
  for (const activeChat of [undefined, false]) {
    const f = fixture(activeChat);
    assert.equal(f.sounds.length, 0, 'initial snapshot is silent');
    f.finish('a');
    assert.equal(f.sounds.length, 0);
    assert.equal(f.notifications.length, 1);
    f.finish('b');
    assert.equal(f.sounds.length, 1, 'background chat still sounds');
    f.finish('b');
    assert.equal(f.sounds.length, 1, 'unchanged snapshots do not repeat it');
  }
});

test('checkbox enables active chat sound while the master switch still controls it', () => {
  const f = fixture(true);
  f.finish('a');
  assert.equal(f.sounds.length, 1);
  f.state.sound.enabled = false;
  f.finish('b');
  assert.equal(f.sounds.length, 1);
});

test('hidden pages and conversations behind terminals still sound with the checkbox off', () => {
  const hidden = fixture(false); hidden.document.hidden = true; hidden.finish('a');
  assert.equal(hidden.sounds.length, 1);
  const terminal = fixture(false); terminal.state.terminalFront = 'terminal'; terminal.finish('a');
  assert.equal(terminal.sounds.length, 1);
});

test('inactive VS Code window sounds, but moving focus to another workbench control stays silent', () => {
  const inactive = fixture(false); inactive.state.windowFocused = false; inactive.finish('a');
  assert.equal(inactive.sounds.length, 1);
  const workbench = fixture(false); workbench.document.focused = false; workbench.finish('a');
  assert.equal(workbench.sounds.length, 0, 'host window focus takes precedence over webview keyboard focus');
});

test('browser surfaces use their own window focus independently of the editor', () => {
  for (const surface of ['chrome', 'exchange']) {
    const inactive = fixture(false); inactive.state.surface = surface; inactive.document.focused = false; inactive.finish('a');
    assert.equal(inactive.sounds.length, 1);
    const active = fixture(false); active.state.surface = surface; active.state.windowFocused = false; active.finish('a');
    assert.equal(active.sounds.length, 0);
  }
});

test('older editor hosts fall back to document focus', () => {
  const f = fixture(false); f.state.windowFocused = undefined; f.document.focused = false; f.finish('a');
  assert.equal(f.sounds.length, 1);
});

test('simultaneous finishes play one sound if a background chat finished too; approval waits stay silent', () => {
  const both = fixture(false); both.finish('a', 'b');
  assert.equal(both.sounds.length, 1);
  const waiting = fixture(true); waiting.state.tabs[0].busy = false; waiting.state.tabs[0].status = 'waiting'; waiting.finish();
  assert.equal(waiting.sounds.length, 0);
});

test('browser preference persists both checkbox values and ignores malformed values', () => {
  let saved: string | null = null;
  const api = runInNewContext(transpileModule(`const deviceSoundKey = 'sound'; let deviceSound = {};
    ${declaration('readDeviceSound')}
    ${declaration('setDeviceSound')}
    ({ read: readDeviceSound, set: setDeviceSound });`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, {
    localStorage: { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } },
  });
  assert.equal(api.read().activeChat, undefined);
  api.set({ activeChat: true }); assert.equal(api.read().activeChat, true);
  api.set({ activeChat: false }); assert.equal(api.read().activeChat, false);
  saved = '{"activeChat":"true"}'; assert.equal(api.read().activeChat, undefined);
});
