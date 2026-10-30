/** Uses a temporary editor profile and a test extension; never reloads the user's editor. */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repo = fileURLToPath(new URL('../', import.meta.url));
const executable = process.argv[2] || '/Applications/VSCodium.app/Contents/MacOS/VSCodium';
const source = process.argv[3];
if (!source) throw new Error('Usage: node scripts/test-visualizations-editor.mjs <editor-executable> <sine-slider.html>');
const html = await readFile(resolve(source), 'utf8');
const root = await mkdtemp(join(tmpdir(), 'abv-'));
const extension = join(root, 'extension');
await mkdir(extension);
await copyFile(join(repo, 'media/visualization.html'), join(extension, 'visualization.html'));
await build({ entryPoints: [join(repo, 'preview-src/visualizationEditorSmoke.ts')], outfile: join(extension, 'probe.js'), bundle: true, platform: 'browser', format: 'iife', target: 'es2022', define: { __SMOKE_HTML__: JSON.stringify(html) }, logLevel: 'silent' });
await writeFile(join(extension, 'package.json'), JSON.stringify({ name: 'visualization-probe', publisher: 'local', version: '0.0.1', engines: { vscode: '^1.85.0' }, main: './extension.cjs', activationEvents: ['onStartupFinished'] }));
await writeFile(join(extension, 'extension.cjs'), `
const vscode = require('vscode');
const fs = require('node:fs');
exports.activate = context => {
  const panel = vscode.window.createWebviewPanel('visualizationProbe', 'Visualization probe', vscode.ViewColumn.One, {enableScripts:true,localResourceRoots:[context.extensionUri]});
  const uri = name => panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri,name)).toString();
  panel.webview.onDidReceiveMessage(value => fs.writeFileSync(${JSON.stringify(join(root, 'result.json'))},JSON.stringify(value,null,2)));
  const visualization = fs.readFileSync(vscode.Uri.joinPath(context.extensionUri,'visualization.html').fsPath).toString('base64');
  panel.webview.html = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \\'none\\'; script-src \\'nonce-probe\\'; style-src \\'nonce-probe\\'; frame-src about:"><meta name="ai-browser-visualization-srcdoc" content="'+visualization+'"><meta name="ai-browser-visualization-nonce" content="probe"><style nonce="probe">body{margin:0;padding:12px}iframe{width:100%;height:420px}</style></head><body><div id="views"></div><script nonce="probe" src="'+uri('probe.js')+'"></script></body></html>';
};
`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, ['--new-window', `--user-data-dir=${join(root, 'profile')}`, `--extensions-dir=${join(root, 'extensions')}`, `--extensionDevelopmentPath=${extension}`, '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', root], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let failure;
child.on('error', error => { failure = error; });
child.stdout.on('data', data => { void writeFile(join(root, 'editor.log'), data, { flag: 'a' }); });
child.stderr.on('data', data => { void writeFile(join(root, 'editor.log'), data, { flag: 'a' }); });
try {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    const raw = await readFile(join(root, 'result.json'), 'utf8').catch(() => undefined);
    if (raw) { const result = JSON.parse(raw); console.log(JSON.stringify(result,null,2)); if (!result.ok) process.exitCode = 1; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const result = await readFile(join(root, 'result.json'), 'utf8').catch(() => undefined);
  if (!result) throw new Error('Editor test timed out. Artifacts: '+root);
  console.log('Editor test artifacts: '+root);
} finally { child.kill(); }
