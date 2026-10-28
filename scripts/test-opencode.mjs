// Live smoke test of the compiled OpenCode backend against the REAL `opencode` binary,
// with a stubbed `vscode` and a fake MCP server on loopback. Run after `npm run build-ext`:
//   node scripts/test-opencode.mjs [path-to-opencode]
// Env: OC_OUT (default ../out) the compiled tree; OC_MODEL (default opencode/big-pickle).
// Uses free models: a turn takes seconds to a minute, and a free model may be slow to find a
// tool — each scenario asserts only what the protocol guarantees, not what the model says.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const out = process.env.OC_OUT ?? new URL('../out', import.meta.url).pathname;
const binary = process.argv[2] ?? path.join(os.homedir(), '.opencode', 'bin', 'opencode');
const MODEL = process.env.OC_MODEL ?? 'opencode/big-pickle';
class Emitter { constructor() { this.l = []; this.event = f => { this.l.push(f); return { dispose() {} }; }; } fire(e) { for (const f of [...this.l]) f(e); } dispose() { this.l = []; } }
const vscodeStub = {
	EventEmitter: Emitter,
	l10n: { t: (m, ...a) => m.replace(/\{(\d+)\}/g, (_, i) => String(a[i])) },
	extensions: { getExtension: () => ({ packageJSON: { version: '0.0.0' } }) },
};
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'vscode' ? vscodeStub : load.call(this, request, ...rest); };
const { OpencodeBackend } = require(path.join(out, 'chat/opencodeAgent.js'));
const { chatCapability } = require(path.join(out, 'core/chatCapability.js'));

const mcpLog = [];
const server = http.createServer((req, res) => {
	let body = '';
	req.on('data', d => body += d);
	req.on('end', () => {
		if (req.method !== 'POST') { res.writeHead(405).end(); return; }
		const m = JSON.parse(body);
		mcpLog.push({ method: m.method, auth: req.headers.authorization, chat: req.headers['x-ai-browser-chat'], origin: req.headers.origin, name: m.params?.name });
		if (m.id === undefined) { res.writeHead(202).end(); return; }
		const send = result => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result })); };
		if (m.method === 'initialize') return send({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'ai-browser', version: '1' } });
		if (m.method === 'tools/list') return send({ tools: [{ name: 'browser_state', description: 'Reports the browser state. Returns the marker FIG-TREE-42.', inputSchema: { type: 'object', properties: {} } }] });
		if (m.method === 'tools/call') return send({ content: [{ type: 'text', text: 'state: marker FIG-TREE-42, no page open' }] });
		send({});
	});
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const bs = () => ({ url: `http://127.0.0.1:${server.address().port}/mcp`, token: 'mcptoken' });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-live-'));
fs.writeFileSync(path.join(dir, 'a.txt'), 'hello from a.txt\n');
const backend = new OpencodeBackend(binary, () => dir, bs);
const until = async (f, ms = 120000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 25)); } };
const collect = s => { const ev = []; s.onEvent(e => ev.push(e)); return ev; };
const ended = ev => ev.some(e => e.type === 'turnEnd');
const input = text => ({ text, images: [] });
const processes = () => { try { return execFileSync('pgrep', ['-f', `opencode.*(acp|serve --stdio)`], { encoding: 'utf8' }).split('\n').filter(Boolean).length; } catch { return 0; } };
let n = 0; const ok = name => console.log(`ok ${++n} ${name}`);
const show = (ev, types) => ev.filter(e => types.includes(e.type)).map(e => e.type === 'text' ? { type: 'text', text: e.text.slice(0, 80) } : e.type === 'approval' ? { type: 'approval', what: e.request.what, title: e.request.title.slice(0, 80) } : e.type === 'tool' ? { type: 'tool', tool: e.tool.kind + ':' + e.tool.name, detail: e.tool.detail, input: e.tool.input?.slice(0, 60) } : e);
const before = processes();

try {
	// 1 detection: models with efforts, commands; no process left
	{
		const models = await backend.models();
		assert.ok(models.length >= 3, 'models');
		assert.equal(models.filter(m => m.isDefault).length, 1);
		const withEfforts = models.filter(m => m.efforts.length);
		console.log('   models:', models.map(m => m.id + (m.efforts.length ? `[${m.efforts}]` : '')).join(', '));
		console.log('   commands:', backend.knownCommands?.map(c => c.name).join(', '));
		assert.ok(withEfforts.length, 'some model has efforts');
		assert.ok(backend.knownCommands?.some(c => c.name === 'init'));
		await new Promise(r => setTimeout(r, 300));
		assert.equal(processes(), before, 'probe left no process');
		ok('detection: models, efforts, commands, no process left');
	}

	// 2 a turn with a shell command (asked, allowed) and a read inside the project (not asked)
	let sessionRef;
	{
		const s = backend.openSession(dir, undefined, undefined, dir, [], true, 'chat-1'); const ev = collect(s);
		s.onEvent(e => { if (e.type === 'approval') { console.log('   approval card:', e.request.what, JSON.stringify(e.request.title)); setTimeout(() => s.answer(e.request.id, true), 20); } });
		assert.equal(await s.send(input('Run the shell command `echo live-ok-1` with your shell tool, then read the file a.txt, then answer with the word DONE and nothing else.'), MODEL, undefined), true);
		await until(() => ended(ev));
		const cmd = ev.find(e => e.type === 'approval' && e.request.what === 'command');
		assert.ok(cmd, 'shell asked as Terminal: ' + JSON.stringify(show(ev, ['approval'])));
		assert.match(cmd.request.title, /live-ok-1/);
		const row = ev.find(e => e.type === 'tool' && e.tool.kind === 'command');
		assert.ok(row && /live-ok-1/.test(row.tool.input ?? ''), 'row shows the command: ' + JSON.stringify(row));
		assert.ok(ev.some(e => e.type === 'toolUpdate' && e.id === row.id && e.update.status === 'done' && /live-ok-1/.test(e.update.output ?? '') && e.update.exitCode === 0), 'output and exit code');
		assert.ok(!ev.some(e => e.type === 'approval' && e.request.what === 'edit' || e.type === 'approval' && /a\.txt/.test(e.request.title)), 'a read in the project asks nothing');
		assert.ok(ev.some(e => e.type === 'tool' && e.tool.kind === 'read' && /a\.txt/.test(e.tool.detail ?? '')), 'read row');
		const tokens = ev.find(e => e.type === 'tokens'); assert.ok(tokens && tokens.input > 0 && tokens.output > 0);
		assert.ok(ev.some(e => e.type === 'context' && e.window === 200000), 'context');
		assert.ok(ev.some(e => e.type === 'session' && /^ses_/.test(e.id)));
		assert.deepEqual(ev.at(-1), { type: 'turnEnd' });
		assert.ok(ev.filter(e => e.type === 'text').map(e => e.text).join('').trim().length > 0);
		sessionRef = s.ref;
		s.dispose();
		ok('turn with a command (approval card, output, exit code), a read, tokens, context, session id');
		console.log('   events:', JSON.stringify(show(ev, ['tool', 'approval', 'text', 'tokens', 'context', 'turnEnd'])));
	}

	// 3 an edit outside the project is asked as "outside", inside as "edit"; Deny ends the turn with a notice
	{
		const s = backend.openSession(dir, undefined, undefined, dir, [], true, 'chat-2'); const ev = collect(s);
		s.onEvent(e => { if (e.type === 'approval') { console.log('   approval card:', e.request.what, JSON.stringify(e.request.title)); setTimeout(() => s.answer(e.request.id, false), 20); } });
		await s.send(input('Use your write tool to create the file denied.txt in the current folder with the text x.'), MODEL, undefined);
		await until(() => ended(ev));
		const card = ev.find(e => e.type === 'approval');
		assert.ok(card && card.request.what === 'edit' && /denied\.txt/.test(card.request.title), JSON.stringify(show(ev, ['approval'])));
		assert.ok(!fs.existsSync(path.join(dir, 'denied.txt')), 'nothing written');
		const end = ev.find(e => e.type === 'turnEnd');
		assert.ok(!end.error, 'a denied tool is not an error nor a Stop: ' + JSON.stringify(end));
		assert.ok(ev.some(e => e.type === 'notice' && /denied/.test(e.text)));
		s.dispose();
		ok('edit asked as Files in the project; Deny ends the turn with a notice, not "Stopped."');
	}

	// 4 Stop mid-turn: a long command is approved, then Stop
	{
		const s = backend.openSession(dir, undefined, undefined, dir, [], true, 'chat-3'); const ev = collect(s);
		let started;
		s.onEvent(e => { if (e.type === 'approval') { setTimeout(() => s.answer(e.request.id, true), 20); } if (e.type === 'tool' && e.tool.kind === 'command') { started = Date.now(); } });
		await s.send(input('Run the shell command `sleep 60; echo late` with your shell tool and wait for it.'), MODEL, undefined);
		await until(() => started);
		await new Promise(r => setTimeout(r, 1500));
		const t = Date.now(); s.stop();
		await until(() => ended(ev), 15000);
		const ms = Date.now() - t;
		assert.deepEqual(ev.at(-1), { type: 'turnEnd', error: 'Stopped.' });
		assert.ok(s.running === false);
		console.log('   stop answered in', ms, 'ms');
		assert.ok(ms < 5000);
		s.dispose();
		ok('Stop ends a running command turn as "Stopped."');
	}

	// 5 MCP: headers reach our server, the call is one mcp row, and its card is classified as our own tool
	{
		mcpLog.length = 0;
		const s = backend.openSession(dir, undefined, undefined, dir, [], true, 'chat-mcp'); const ev = collect(s);
		s.onEvent(e => { if (e.type === 'approval') { console.log('   approval card:', e.request.what, JSON.stringify(e.request.title), JSON.stringify(e.request.detail?.slice(0, 120))); setTimeout(() => s.answer(e.request.id, true), 20); } });
		await s.send(input('Call the MCP tool browser_state of the ai-browser server and tell me the marker it returns. Use the MCP tool, nothing else.'), MODEL, undefined);
		await until(() => ended(ev), 240000);
		const calls = mcpLog.filter(m => m.method === 'tools/call');
		console.log('   mcp requests:', mcpLog.map(m => m.method + (m.name ? ':' + m.name : '')).join(', '));
		assert.ok(mcpLog.length && mcpLog.every(m => m.auth === 'Bearer mcptoken' && m.chat === chatCapability('chat-mcp') && m.origin === undefined), 'bearer token and chat capability on every request, no Origin');
		assert.ok(calls.length >= 1, 'the model called the tool (free models can fail this: rerun)');
		const card = ev.find(e => e.type === 'approval' && /browser_state/.test(e.request.title + (e.request.detail ?? '')));
		assert.ok(card && card.request.what === 'browser', 'classified as AI Browser: ' + JSON.stringify(show(ev, ['approval'])));
		assert.ok(ev.some(e => e.type === 'tool' && e.tool.kind === 'mcp' && /browser_state/.test(e.tool.name)), 'mcp row');
		assert.match(ev.filter(e => e.type === 'text').map(e => e.text).join(''), /FIG-TREE-42/);
		s.dispose();
		ok('MCP: headers, one mcp row, card classified as AI Browser, marker answered');
	}

	// 6 resume in a fresh process; a message sent mid-turn waits and goes as an own turn
	{
		const s = backend.openSession(dir, sessionRef, undefined, dir, [], true, 'chat-1'); const ev = collect(s);
		const first = await s.send(input('Reply with the single word ALPHA.'), MODEL, undefined);
		assert.equal(first, true);
		const second = s.send(input('Now reply with the single word BETA.'), MODEL, undefined);
		await until(() => ev.filter(e => e.type === 'turnEnd').length === 2);
		assert.equal(await second, true);
		assert.equal(ev.filter(e => e.type === 'autoTurn').length, 1);
		assert.equal(s.ref, sessionRef, 'resumed the same OpenCode session');
		assert.ok(!ev.some(e => e.type === 'session'), 'a resumed session is not announced as new');
		assert.ok(!ev.some(e => e.type === 'text' && /hello from/.test(e.text)), 'history is not replayed');
		s.dispose();
		ok('resume by session id; queued message went as its own turn');
	}

	// 7 effort: a model with variants takes an effort through set_config_option
	{
		const models = await backend.models();
		const m = models.find(x => x.efforts.includes('high'));
		if (m) {
			const s = backend.openSession(dir, undefined, undefined, dir, [], true, 'chat-4'); const ev = collect(s);
			await s.send(input('Reply with the single word OK.'), m.id, 'high');
			await until(() => ended(ev));
			assert.ok(!ev.some(e => e.type === 'turnEnd' && e.error), JSON.stringify(ev.find(e => e.type === 'turnEnd')));
			s.dispose();
			ok(`model ${m.id} with effort high`);
		}
	}

	// 8 an unknown model is a sentence, not a crash
	{
		const s = backend.openSession(dir, undefined, undefined, dir, [], true, 'chat-5');
		await assert.rejects(s.send(input('hi'), 'nope/nothing', undefined), /does not know this model/);
		s.dispose();
		ok('unknown model refused with advice');
	}

	await new Promise(r => setTimeout(r, 500));
	assert.equal(processes(), before, 'processes left behind: ' + processes());
	ok('no opencode process left after every session was disposed');
} finally {
	backend.dispose();
	server.close();
	fs.rmSync(dir, { recursive: true, force: true });
}
console.log('all ok');
process.exit(0);
