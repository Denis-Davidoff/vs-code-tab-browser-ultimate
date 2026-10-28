// Manual smoke test of the compiled OpenRouter agent against a fake OpenAI-compatible
// server and a fake MCP server on loopback. Run after `npm run build-ext`:
//   node scripts/test-openrouter.mjs
import http from 'node:http';
import Module from 'node:module';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const KEY = 'sk-or-v1-SECRETKEY123';
class Emitter { constructor() { this.l = []; this.event = f => { this.l.push(f); return { dispose() {} }; }; } fire(e) { for (const f of [...this.l]) f(e); } dispose() { this.l = []; } }
const vscodeStub = {
	EventEmitter: Emitter,
	l10n: { t: (m, ...a) => m.replace(/\{(\d+)\}/g, (_, i) => String(a[i])) },
	extensions: { getExtension: () => ({ packageJSON: { version: '0.0.0' } }) },
};
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'vscode' ? vscodeStub : load.call(this, request, ...rest); };
const { OpenRouterBackend } = require('../out/chat/openrouterAgent.js');

let script = []; // queue of responders for /chat/completions
const modelRequests = [];
const mcpLog = [];
const sse = (res, chunks) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const c of chunks) res.write(c === '[DONE]' ? 'data: [DONE]\n\n' : typeof c === 'string' && c.startsWith(':') ? c + '\n\n' : `data: ${JSON.stringify(c)}\n\n`); res.end(); };
const delta = (d, finish = null, extra = {}) => ({ id: 'g', choices: [{ index: 0, delta: d, finish_reason: finish }], ...extra });

const server = http.createServer((req, res) => {
	let body = '';
	req.on('data', d => body += d);
	req.on('end', () => {
		if (req.url === '/mcp') {
			const m = JSON.parse(body);
			mcpLog.push({ method: m.method, auth: req.headers.authorization, chat: req.headers['x-ai-browser-chat'], sid: req.headers['mcp-session-id'], origin: req.headers.origin, params: m.params });
			if (m.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
			const send = result => { res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result })); };
			if (m.method === 'initialize') return send({ protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'ai-browser' } });
			if (m.method === 'tools/list') return send({ tools: [{ name: 'browser_state', description: 'state', inputSchema: { type: 'object', properties: {} } }, { name: 'terminal_send', description: 'type', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] });
			if (m.method === 'tools/call') return send({ content: [{ type: 'text', text: 'PAGE ' + 'x'.repeat(30000) }] });
			return send({});
		}
	if (req.url === '/v1/chat/completions') {
		modelRequests.push({ auth: req.headers.authorization, body: JSON.parse(body) });
		const next = script.shift();
		if (!next) { res.writeHead(500).end('{"error":{"message":"no script"}}'); return; }
		next(res);
		return;
	}
	res.writeHead(404).end();
	});
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const models = [{ id: 'fake/model', name: 'Fake', reasoning: 'low', images: false }, { id: 'fake/notools', tools: false }];
const config = (over = {}) => ({
	apiKey: async () => KEY, models: () => models, endpoint: () => `http://127.0.0.1:${port}/v1`,
	entries: () => undefined, ...over,
});
const bs = () => ({ url: `http://127.0.0.1:${port}/mcp`, token: 'mcptoken' });
const collect = session => { const ev = []; session.onEvent(e => ev.push(e)); return ev; };
const until = async (f, ms = 8000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)); } };
const ended = ev => ev.some(e => e.type === 'turnEnd');
const turnEnds = ev => ev.filter(e => e.type === 'turnEnd');
const input = text => ({ text, images: [] });
const noKey = ev => assert.ok(!JSON.stringify(ev).includes(KEY), 'key leaked into events');
let n = 0; const ok = name => console.log(`ok ${++n} ${name}`);

// 1 text + reasoning + usage
{
	const be = new OpenRouterBackend(config(), bs); const s = be.openSession('/', undefined, undefined, '/', [], true, 'chat1'); const ev = collect(s);
	script.push(res => sse(res, [': OPENROUTER PROCESSING', delta({ reasoning: 'hmm' }), delta({ content: 'Hel' }), delta({ content: 'lo' }), delta({}, 'stop', { usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.002 } }), '[DONE]']));
	assert.equal(await s.send(input('hi'), 'fake/model', 'high'), true);
	await until(() => ended(ev));
	assert.deepEqual(ev.filter(e => e.type === 'text').map(e => e.text).join(''), 'Hello');
	assert.ok(ev.some(e => e.type === 'thinking' && e.text === 'hmm'));
	assert.ok(ev.some(e => e.type === 'session' && /^or-/.test(e.id)));
	assert.deepEqual(ev.find(e => e.type === 'tokens'), { type: 'tokens', input: 12, output: 3, cached: 0, costUsd: 0.002, cumulative: false });
	assert.equal(modelRequests.at(-1).auth, `Bearer ${KEY}`);
	assert.deepEqual(modelRequests.at(-1).body.reasoning, { effort: 'high' });
	assert.ok(modelRequests.at(-1).body.tools.length === 2);
	noKey(ev); s.dispose(); be.dispose(); ok('text, reasoning, usage, cost, key only in the header');
}

// 2 tool call -> approval allow -> MCP -> final answer; result capped
{
	mcpLog.length = 0;
	const be = new OpenRouterBackend(config(), bs); const s = be.openSession('/', undefined, undefined, '/', [], true, 'chat2'); const ev = collect(s);
	s.onEvent(e => { if (e.type === 'approval') { setTimeout(() => s.answer(e.request.id, true), 5); } });
	script.push(res => sse(res, [delta({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'browser_state', arguments: '' } }] }), delta({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }), delta({}, 'tool_calls', { usage: { prompt_tokens: 5, completion_tokens: 2 } }), '[DONE]']));
	script.push(res => sse(res, [delta({ content: 'Done.' }), delta({}, 'stop', { usage: { prompt_tokens: 9, completion_tokens: 1 } }), '[DONE]']));
	await s.send(input('state?'), 'fake/model', undefined); await until(() => ended(ev));
	const approval = ev.find(e => e.type === 'approval').request;
	assert.equal(approval.what, 'browser'); assert.equal(approval.title, 'browser_state');
	assert.ok(ev.some(e => e.type === 'tool' && e.tool.name === 'ai-browser · browser_state'));
	assert.ok(ev.some(e => e.type === 'toolUpdate' && e.update.status === 'done'));
	const call = mcpLog.find(m => m.method === 'tools/call');
	assert.equal(call.auth, 'Bearer mcptoken'); assert.ok(call.chat && call.chat !== 'chat2', 'capability, not the chat id'); assert.equal(call.sid, 'sess-1'); assert.equal(call.origin, undefined);
	const second = modelRequests.at(-1).body.messages;
	const tool = second.find(m => m.role === 'tool'); assert.equal(tool.tool_call_id, 'c1'); assert.ok(tool.content.length < 20100 && /more characters cut/.test(tool.content));
	assert.deepEqual(ev.find(e => e.type === 'tokens'), { type: 'tokens', input: 14, output: 3, cached: 0, cumulative: false });
	assert.equal(ev.filter(e => e.type === 'text').map(e => e.text).join(''), 'Done.');
	noKey(ev); s.dispose(); be.dispose(); ok('tool call: approval, MCP headers, result cap, second round, summed usage');
}

// 3 denied, and a terminal tool is a command card
{
	mcpLog.length = 0;
	const be = new OpenRouterBackend(config(), bs); const s = be.openSession('/', undefined, undefined, '/', [], true, 'chat3'); const ev = collect(s);
	s.onEvent(e => { if (e.type === 'approval') { setTimeout(() => s.answer(e.request.id, false), 5); } });
	script.push(res => sse(res, [delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'terminal_send', arguments: '{"text":"rm -rf x"}' } }] }, 'tool_calls'), '[DONE]']));
	script.push(res => sse(res, [delta({ content: 'ok' }, 'stop'), '[DONE]']));
	await s.send(input('x'), 'fake/model', undefined); await until(() => ended(ev));
	assert.equal(ev.find(e => e.type === 'approval').request.what, 'command');
	assert.ok(!mcpLog.some(m => m.method === 'tools/call'), 'a denied call never reaches the server');
	assert.match(modelRequests.at(-1).body.messages.find(m => m.role === 'tool').content, /denied/);
	s.dispose(); be.dispose(); ok('deny: no server call, model told');
}

// 4 an unknown tool name the model invents is refused without a card
{
	mcpLog.length = 0;
	const be = new OpenRouterBackend(config(), bs); const s = be.openSession('/', undefined, undefined, '/', [], true, 'chat4'); const ev = collect(s);
	script.push(res => sse(res, [delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'run_shell', arguments: '{}' } }] }, 'tool_calls'), '[DONE]']));
	script.push(res => sse(res, [delta({ content: 'ok' }, 'stop'), '[DONE]']));
	await s.send(input('x'), 'fake/model', undefined); await until(() => ended(ev));
	assert.ok(!ev.some(e => e.type === 'approval')); assert.ok(!mcpLog.some(m => m.method === 'tools/call'));
	s.dispose(); be.dispose(); ok('an invented tool is refused');
}

// 5 retries: 429 twice then success; no retry on 401/402/404
{
	const be = new OpenRouterBackend(config(), bs);
	let s = be.openSession('/', undefined, undefined, '/', [], true, 'c5'); let ev = collect(s);
	const before = modelRequests.length;
	script.push(res => res.writeHead(429, { 'retry-after': '0' }).end('{"error":{"message":"slow down"}}'));
	script.push(res => res.writeHead(503).end('{}'));
	script.push(res => sse(res, [delta({ content: 'fine' }, 'stop'), '[DONE]']));
	await s.send(input('x'), 'fake/notools', undefined); await until(() => ended(ev), 15000);
	assert.equal(modelRequests.length - before, 3); assert.equal(turnEnds(ev)[0].error, undefined);
	assert.ok(!('tools' in modelRequests.at(-1).body), 'tools:false is respected');
	s.dispose();
	for (const [status, re] of [[401, /API key is invalid/], [402, /credits/], [404, /does not know this model/]]) {
		s = be.openSession('/', undefined, undefined, '/', [], true, 'c5'); ev = collect(s); const b = modelRequests.length;
		script.push(res => res.writeHead(status).end('{"error":{"message":"m"}}'));
		await s.send(input('x'), 'fake/notools', undefined); await until(() => ended(ev));
		assert.equal(modelRequests.length - b, 1, `no retry on ${status}`); assert.match(turnEnds(ev)[0].error, re); s.dispose();
	}
	s = be.openSession('/', undefined, undefined, '/', [], true, 'c5'); ev = collect(s); const b = modelRequests.length;
	for (let i = 0; i < 4; i++) script.push(res => res.writeHead(500).end('{}'));
	await s.send(input('x'), 'fake/notools', undefined); await until(() => ended(ev), 20000);
	assert.equal(modelRequests.length - b, 4, 'bounded: 1 + 3 retries'); assert.match(turnEnds(ev)[0].error, /HTTP 500/);
	s.dispose(); be.dispose(); ok('retries only 429/5xx, bounded; 401/402/404 texts');
}

// 6 stop mid-stream
{
	const be = new OpenRouterBackend(config(), bs); const s = be.openSession('/', undefined, undefined, '/', [], true, 'c6'); const ev = collect(s);
	script.push(res => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify(delta({ content: 'part' }))}\n\n`); /* never ends */ });
	await s.send(input('x'), 'fake/notools', undefined); await until(() => ev.some(e => e.type === 'text'));
	s.stop(); await until(() => ended(ev));
	assert.equal(turnEnds(ev)[0].error, 'Stopped.'); assert.equal(s.running, false);
	s.dispose(); be.dispose(); ok('stop aborts the stream');
}

// 7 stop while an approval is pending; message queued mid-turn goes as its own turn
{
	const be = new OpenRouterBackend(config(), bs); const s = be.openSession('/', undefined, undefined, '/', [], true, 'c7'); const ev = collect(s);
	script.push(res => sse(res, [delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'browser_state', arguments: '{}' } }] }, 'tool_calls'), '[DONE]']));
	script.push(res => sse(res, [delta({ content: 'second turn' }, 'stop'), '[DONE]']));
	await s.send(input('one'), 'fake/model', undefined);
	await until(() => ev.some(e => e.type === 'approval'));
	const queued = s.send(input('two'), 'fake/model', undefined);
	s.stop();
	await until(() => ev.some(e => e.type === 'approvalDone'));
	assert.equal(await queued, true);
	await until(() => turnEnds(ev).length === 2);
	assert.equal(turnEnds(ev)[0].error, 'Stopped.'); assert.ok(ev.some(e => e.type === 'autoTurn'));
	// the history stays valid: every tool_call has its answer
	const msgs = modelRequests.at(-1).body.messages;
	const calls = msgs.filter(m => m.tool_calls).flatMap(m => m.tool_calls.map(c => c.id)); const answers = msgs.filter(m => m.role === 'tool').map(m => m.tool_call_id);
	assert.deepEqual(calls, answers);
	s.dispose(); be.dispose(); ok('stop answers pending approvals; queued message runs as an auto turn; history valid');
}

// 8 resume from saved entries (the in-flight prompt is not doubled)
{
	const entries = [{ kind: 'user', text: 'earlier q', attachments: [] }, { kind: 'assistant', text: 'earlier a' }, { kind: 'user', text: 'new q', attachments: [] }];
	const be = new OpenRouterBackend(config({ entries: ref => ref === 'or-saved' ? entries : undefined }), bs); const s = be.openSession('/', 'or-saved', undefined, '/', [], true, 'c8'); const ev = collect(s);
	script.push(res => sse(res, [delta({ content: 'ok' }, 'stop'), '[DONE]']));
	await s.send(input('new q'), 'fake/notools', undefined); await until(() => ended(ev));
	assert.deepEqual(modelRequests.at(-1).body.messages, [{ role: 'user', content: 'earlier q' }, { role: 'assistant', content: 'earlier a' }, { role: 'user', content: 'new q' }]);
	assert.equal(s.ref, 'or-saved'); s.dispose(); be.dispose(); ok('resume rebuilt from stored chat');
}

// 9 images only for a model that declares them
{
	const be = new OpenRouterBackend(config({ models: () => [{ id: 'v/yes', images: true }, { id: 'v/no' }] }), bs);
	for (const [id, expectImage] of [['v/yes', true], ['v/no', false]]) {
		const s = be.openSession('/', undefined, undefined, '/', [], true, 'c9'); const ev = collect(s);
		script.push(res => sse(res, [delta({ content: 'ok' }, 'stop'), '[DONE]']));
		await s.send({ text: 'look', images: [{ mediaType: 'image/png', base64: 'AAAA' }] }, id, undefined); await until(() => ended(ev));
		const content = modelRequests.at(-1).body.messages[0].content;
		assert.equal(Array.isArray(content) && content.some(p => p.type === 'image_url'), expectImage); s.dispose();
	}
	be.dispose(); ok('image_url only when declared');
}

// 10 detection: no key, no models, bad endpoint, good
{
	const probe = async over => { const be = new OpenRouterBackend(config(over), bs); try { return (await be.models()).length; } catch (e) { return e.message; } finally { be.dispose(); } };
	assert.equal(await probe({ apiKey: async () => undefined }), 2);
	assert.match(await probe({ models: () => [] }), /No OpenRouter models/);
	assert.match(await probe({ endpoint: () => 'http://evil.example/v1' }), /https address/);
	assert.equal(await probe({}), 2);
	ok('detection: optional key / no models / bad endpoint / good');
}

// 11 no MCP server: the turn still answers, with a notice
{
	const be = new OpenRouterBackend(config(), () => undefined); const s = be.openSession('/', undefined, undefined, '/', [], true, 'c11'); const ev = collect(s);
	script.push(res => sse(res, [delta({ content: 'ok' }, 'stop'), '[DONE]']));
	await s.send(input('x'), 'fake/model', undefined); await until(() => ended(ev));
	assert.ok(ev.some(e => e.type === 'notice' && /browser tools are not available/.test(e.text))); assert.ok(!('tools' in modelRequests.at(-1).body));
	s.dispose(); be.dispose(); ok('no MCP server -> notice, plain chat');
}

// 12 compatible servers accept requests without an API key
{
	const be = new OpenRouterBackend(config({ apiKey: async () => undefined }), bs); const s = be.openSession('/', undefined, undefined, '/', [], true, 'c12');
	const ev = collect(s);
	script.push(res => sse(res, [delta({ content: 'keyless' }, 'stop'), '[DONE]']));
	await s.send(input('x'), 'fake/model', undefined); await until(() => ended(ev));
	assert.equal(modelRequests.at(-1).auth, undefined);
	assert.ok(ev.some(e => e.type === 'text' && e.text === 'keyless'));
	s.dispose(); be.dispose(); ok('send without a key omits Authorization');
}

// 13 a model on this computer: its own server, never the OpenRouter key, and a bad endpoint setting does not hide it
{
	const local = [{ id: 'llama3.1:8b', endpoint: `http://127.0.0.1:${port}/v1` }];
	const over = { models: () => local, endpoint: () => 'http://evil.example/v1' };
	const be = new OpenRouterBackend(config(over), bs);
	assert.equal((await be.models()).length, 1);
	const s = be.openSession('/', undefined, undefined, '/', [], true, 'c13'); const ev = collect(s);
	script.push(res => sse(res, [delta({ content: 'from here' }, 'stop'), '[DONE]']));
	await s.send(input('x'), 'llama3.1:8b', undefined); await until(() => ended(ev));
	assert.equal(modelRequests.at(-1).auth, undefined, 'the OpenRouter key must not reach a local server');
	assert.equal(modelRequests.at(-1).body.model, 'llama3.1:8b');
	assert.ok(ev.some(e => e.type === 'text' && e.text === 'from here'));
	noKey(ev); s.dispose(); be.dispose(); ok('local model: own server, no key, bad global endpoint ignored');
}

server.close(); server.closeAllConnections?.();
console.log('all ok');
process.exit(0);
