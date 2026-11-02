/** Runs a disposable headless browser, never an existing browser profile or user tab. */
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'ai-browser-visualization-browser-'));
const probes = [];
let server;
try {
  await build({ entryPoints: [join(root, 'preview-src/visualizationSmoke.ts')], outfile: join(temporary, 'smoke.js'), bundle: true, platform: 'browser', format: 'iife', target: 'es2022', logLevel: 'silent' });
  await build({ entryPoints: [join(root, 'preview-src/chatBootstrapSmoke.ts')], outfile: join(temporary, 'bootstrap.js'), bundle: true, platform: 'browser', format: 'iife', target: 'es2022', logLevel: 'silent' });
  await build({ entryPoints: [join(root, 'preview-src/chatSurfaceSmoke.ts')], outfile: join(temporary, 'surfaces.js'), bundle: true, platform: 'browser', format: 'iife', target: 'es2022', logLevel: 'silent' });
  server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const asset = /^\/surface-assets\/(editor|chrome|exchange)\/([\w.-]+)$/.exec(url.pathname);
    if (asset && ['chat.js', 'chat.css', 'appearance.css', 'liquid-loader.css', 'sidepanel.css', 'web-chat.css', 'visualization.html', 'visualization.js'].includes(asset[2])) {
      const directory = asset[1] === 'editor' ? 'media' : asset[1] === 'chrome' ? 'chrome-extension/dist' : 'exchange-server/apps/web/public/remote-chat';
      response.setHeader('Content-Type', asset[2].endsWith('.css') ? 'text/css' : asset[2].endsWith('.html') ? 'text/html' : 'text/javascript');
      response.end(await readFile(join(root, directory, asset[2]))); return;
    }
    if (url.pathname === '/surface-parity') {
      response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><body><pre id="result">RUNNING</pre><script src="/surfaces.js"></script></body></html>'); return;
    }
    if (url.pathname === '/isolated' || url.pathname === '/webview-bootstrap' || url.pathname === '/fake.html' || url.searchParams.get('vscode-coi') === '2') {
      response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    }
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    // A VS Code resource document can be loaded by the parent service worker,
    // but its new document cannot route relative subresources through that worker.
    if (url.pathname === '/resource/visualization.html') {
      response.setHeader('Content-Type', 'text/html'); response.end(await readFile(join(root, 'media/visualization.html'))); return;
    }
    if (url.pathname === '/fake.html') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><body></body></html>'); return; }
    if (url.pathname === '/webview-bootstrap') {
      response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><body><pre id="result">RUNNING</pre><script src="/bootstrap.js"></script></body></html>'); return;
    }
    if (url.pathname === '/egress') { probes.push(request.url); response.writeHead(200); response.end('Forbidden probe reached the server'); return; }
    if (url.pathname === '/' || url.pathname === '/isolated') {
      response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; frame-src 'self'");
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html><head><meta charset="utf-8"><title>Visualization integration test</title>' + (url.pathname === '/isolated' ? '<meta name="ai-browser-visualization-renderer" content="/resource/visualization.html?vscode-coi=2">' : '') + '</head><body><div id="views"></div><pre id="result">RUNNING</pre><script src="/smoke.js"></script></body></html>'); return;
    }
    const files = { '/surfaces.js': join(temporary, 'surfaces.js'), '/smoke.js': join(temporary, 'smoke.js'), '/bootstrap.js': join(temporary, 'bootstrap.js'), ...Object.fromEntries(['chat.js','chat.css','appearance.css','liquid-loader.css','visualization.html','visualization.js'].map(name => ['/'+name,join(root,'media',name)])) };
    if (!files[url.pathname]) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', url.pathname.endsWith('.html') ? 'text/html' : url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript');
    response.end(await readFile(files[url.pathname]));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const binary = process.env.CHROME_BIN || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'chromium');
  const child = spawn(binary, ['--headless', '--disable-gpu', '--disable-background-networking', '--disable-extensions', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${join(temporary, 'profile')}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
  let socket;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let settled = false;
      const check = () => { if (settled) return; const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(errors); if (match) { settled = true; resolve(match[1]); } else { setTimeout(check, 50); } };
      child.once('error', error => { settled = true; reject(error); }); child.once('exit', code => { settled = true; reject(new Error(`Browser exited ${code}: ${errors.slice(-1000)}`)); }); check();
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    const pending = new Map();
    let nextId = 0;
    const logs = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) { const waiter = pending.get(message.id); pending.delete(message.id); if (message.error) waiter?.reject(new Error(JSON.stringify(message.error))); else waiter?.resolve(message.result); }
      else if (message.method === 'Runtime.exceptionThrown' || message.method === 'Log.entryAdded') logs.push(message.params);
    });
    socket.addEventListener('close', () => { for (const waiter of pending.values()) waiter.reject(new Error('Test browser disconnected.')); pending.clear(); });
    const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Test browser timed out: ${method}`)); }, 5000);
      pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
    for (const testPath of process.argv.includes('--surfaces') ? ['/surface-parity'] : ['/', '/isolated', '/webview-bootstrap', '/surface-parity']) {
    const { targetId } = await call('Target.createTarget', { url: `http://127.0.0.1:${address.port}${testPath}` });
    const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
    await call('Runtime.enable', {}, sessionId); await call('Log.enable', {}, sessionId);
    let output = '';
    for (let attempt = 0; attempt < 400; attempt++) {
      const value = await call('Runtime.evaluate', { expression: 'document.getElementById("result")?.textContent', returnByValue: true }, sessionId);
      output = value.result?.value || '';
      if (/^(PASS|FAIL):/.test(output)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const expected = testPath === '/surface-parity' ? /PASS: editor, Chrome and Exchange/ : testPath === '/webview-bootstrap' ? /PASS: full chat bootstrap, hidden parent, host snapshots, child rejection/ : /PASS: sandbox, CSP, host message isolation, persistent frame, revision state/;
    assert.match(output, expected, output + '\n' + JSON.stringify(logs).slice(-5000));
    await call('Target.closeTarget', { targetId });
    }
  } finally { clearTimeout(timer); socket?.close(); if (child.pid && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); } }
  assert.deepEqual(probes, [], 'Generated content made an external request, including navigation.');
  console.log(process.argv.includes('--surfaces') ? 'PASS: editor, Chrome and Exchange scroll navigation, usage and Stop at phone, tablet and desktop widths.' : 'PASS: full chat bootstrap under VS Code preload, host delivery, child rejection; sandbox and CSP; native images, files, tables, media, typed notifications, progress, plans, JSON search/copy and bound citations; cross-surface scroll navigation, usage and Stop.');
} finally {
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  await rm(temporary, { recursive: true, force: true });
}
