import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind } from 'typescript';

const exports: Record<string, any> = {};
const vscode: Record<string, any> = {};
runInNewContext(transpileModule(readFileSync('src/chat/fileIconTheme.ts', 'utf8'), {
 compilerOptions: { module: ModuleKind.CommonJS },
}).outputText, { exports, Buffer, require: () => vscode });
const { fileIconId, parseIconTheme, themedGitFiles, decodeFontCharacter } = exports;

test('theme JSON permits comments and trailing commas without changing strings', () => {
 const theme = parseIconTheme(`{/* comment */ "file": "https://example/icon,}", // line
 "fileNames": {"package.json": "package",},}`);
 assert.equal(theme.file, 'https://example/icon,}');
 assert.equal(theme.fileNames['package.json'], 'package');
});

test('file names precede compound extensions, languages and default icons', () => {
 const theme = { file: 'generic', fileNames: { 'package.json': 'npm' }, fileExtensions: { 'spec.ts': 'test', ts: 'typescript' }, languageIds: { shellscript: 'shell' } };
 assert.equal(fileIconId(theme, 'dir/PACKAGE.JSON', 'json'), 'npm');
 assert.equal(fileIconId(theme, 'dir/file.spec.ts', 'typescript'), 'test');
 assert.equal(fileIconId(theme, 'dir/file.ts', undefined), 'typescript');
 assert.equal(fileIconId(theme, 'dir/.bashrc', 'shellscript'), 'shell');
 assert.equal(fileIconId(theme, 'dir/unknown', undefined), 'generic');
});

test('light and high contrast associations override their own entries and inherit others', () => {
 const theme = { file: 'generic', fileExtensions: { ts: 'dark', js: 'js' }, light: { fileExtensions: { ts: 'light' } }, highContrast: { file: 'contrast' } };
 assert.equal(fileIconId(theme, 'main.ts', undefined, 'light'), 'light');
 assert.equal(fileIconId(theme, 'main.js', undefined, 'light'), 'js');
 assert.equal(fileIconId(theme, 'unknown', undefined, 'highContrast'), 'contrast');
});

test('theme failures leave Git changes available', async () => {
 const status = { staged: [], unstaged: [{ path: 'deleted.ts', status: 'D' }], changed: 0, deleted: 1 };
 assert.equal(await themedGitFiles(status, {}, {}), status);
});


test('image and font resources come from the active theme and deleted paths need no file read', async () => {
 const theme = {
  file: 'generic', fileExtensions: { ts: 'typescript' },
  iconDefinitions: { generic: { iconPath: './generic.svg' }, typescript: { fontCharacter: '\\E099', fontColor: '#123456' } },
  fonts: [{ id: 'theme', src: [{ path: './icons.woff', format: 'woff' }] }],
 };
 const reads: string[] = [];
 Object.assign(vscode, {
  workspace: { getConfiguration: () => ({ get: () => 'selected' }), fs: { readFile: async (uri: string) => { reads.push(uri); return Buffer.from(JSON.stringify(theme)); } } },
  extensions: { all: [{ extensionUri: '/extension', packageJSON: { contributes: { iconThemes: [{ id: 'selected', path: 'icons/theme.json' }] } } }] },
  Uri: { joinPath: (...parts: string[]) => parts.join('/') },
  window: { activeColorTheme: { kind: 2 } }, ColorThemeKind: { Light: 1, HighContrast: 3, HighContrastLight: 4 },
 });
 const webview = { options: { enableScripts: true }, asWebviewUri: (uri: string) => `webview:${uri}` };
 const result = await themedGitFiles({ staged: [{ path: 'deleted.ts', status: 'D' }], unstaged: [{ path: 'new.bin', status: '?' }], changed: 1, deleted: 1 }, webview, '/media');
 assert.equal(result.staged[0].icon.character, '\ue099');
 assert.match(result.staged[0].icon.font, /icons\.woff$/);
 assert.match(result.unstaged[0].icon.image, /generic\.svg$/);
 assert.deepEqual(reads, ['/extension/icons/theme.json']);
 assert.equal(webview.options.enableScripts, true);
});


test('CSS font escapes decode into glyphs while Unicode and escape terminators are preserved', () => {
 assert.equal(decodeFontCharacter('\\E099'), '\ue099');
 assert.equal(decodeFontCharacter('\\00E099 '), '\ue099');
 assert.equal(decodeFontCharacter('\\1f600'), '😀');
 assert.equal(decodeFontCharacter('\ue099'), '\ue099');
 assert.equal(decodeFontCharacter('\\41 B'), 'AB');
 assert.equal(decodeFontCharacter('\\110000'), '\ufffd');
 assert.equal(decodeFontCharacter('\\D800'), '\ufffd');
 assert.equal(decodeFontCharacter('\\0'), '\ufffd');
});

test('both high contrast color kinds select highContrast icons instead of light', async () => {
 const theme = {
  file: 'dark', light: { file: 'light' }, highContrast: { file: 'contrast' },
  iconDefinitions: { dark: { iconPath: 'dark.svg' }, light: { iconPath: 'light.svg' }, contrast: { iconPath: 'contrast.svg' } },
 };
 Object.assign(vscode, {
  workspace: { getConfiguration: () => ({ get: () => 'selected' }), fs: { readFile: async () => Buffer.from(JSON.stringify(theme)) } },
  extensions: { all: [{ extensionUri: '/extension', packageJSON: { contributes: { iconThemes: [{ id: 'selected', path: 'theme.json' }] } } }] },
  Uri: { joinPath: (...parts: string[]) => parts.join('/') },
  window: { activeColorTheme: { kind: 2 } }, ColorThemeKind: { Light: 1, HighContrast: 3, HighContrastLight: 4 },
 });
 for (const [kind, expected] of [[1, 'light'], [2, 'dark'], [3, 'contrast'], [4, 'contrast']] as const) {
  vscode.window.activeColorTheme.kind = kind;
  const result = await themedGitFiles({ staged: [{ path: 'unknown', status: 'M' }], unstaged: [], changed: 1, deleted: 0 },
   { options: {}, asWebviewUri: (uri: string) => uri }, '/media');
  assert.ok(result.staged[0].icon.image.endsWith(`${expected}.svg`), `color kind ${kind}`);
 }
});

test('configured associations and open document languages select language icons for deleted or custom files', async () => {
 const theme = {
  file: 'generic', languageIds: { typescript: 'ts', javascript: 'js' },
  iconDefinitions: { generic: { iconPath: 'generic.svg' }, ts: { iconPath: 'typescript.svg' }, js: { iconPath: 'javascript.svg' } },
 };
 const uri = (path: string): any => ({ path, toString: () => `file://${path}`, with: (change: { path: string }) => uri(change.path) });
 const documents: { uri: any; languageId: string }[] = [];
 const scopes: string[] = [];
 Object.assign(vscode, {
  workspace: {
   textDocuments: documents,
   getConfiguration: (section: string, resource: any) => ({ get: () => {
    if (section === 'workbench') { return 'selected'; }
    scopes.push(resource.path);
    return { '*.custom': 'typescript', '**/special.custom': 'javascript' };
   } }),
   fs: { readFile: async () => Buffer.from(JSON.stringify(theme)) },
  },
  extensions: { all: [{ extensionUri: uri('/extension'), packageJSON: { contributes: { iconThemes: [{ id: 'selected', path: 'theme.json' }] } } }] },
  Uri: { joinPath: (base: any, ...parts: string[]) => uri([base.path, ...parts].join('/')) },
  languages: { match: (selector: { pattern: string }, document: any) => {
   const pattern = selector.pattern;
   return pattern === '**/*.custom' ? Number(document.uri.path.endsWith('.custom'))
    : pattern === '**/special.custom' ? Number(document.uri.path.endsWith('/special.custom')) : 0;
  } },
  window: { activeColorTheme: { kind: 2 } }, ColorThemeKind: { Light: 1, HighContrast: 3, HighContrastLight: 4 },
 });
 const status = { staged: [{ path: 'example.custom', status: 'D' }, { path: 'special.custom', status: 'M' }], unstaged: [], changed: 1, deleted: 1 };
 const render = () => themedGitFiles(status, { options: {}, asWebviewUri: (resource: any) => resource.toString() }, uri('/media'), uri('/project'));
 let result = await render();
 assert.ok(result.staged[0].icon.image.endsWith('/typescript.svg'));
 assert.ok(result.staged[1].icon.image.endsWith('/javascript.svg'));
 assert.deepEqual(scopes, ['/project/example.custom', '/project/special.custom']);
 documents.push({ uri: uri('/project/example.custom'), languageId: 'javascript' });
 result = await render();
 assert.ok(result.staged[0].icon.image.endsWith('/javascript.svg'), 'manual language overrides configured association');
 documents[0].languageId = 'plaintext';
 result = await render();
 assert.ok(result.staged[0].icon.image.endsWith('/typescript.svg'), 'plaintext falls back to path association like Explorer');
});
