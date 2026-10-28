// Manual smoke test of the compiled Pi agent against the REAL installed `pi` (signed in; never reads ~/.pi/agent/auth.json),
// with a fake MCP server on loopback. Uses a cheap model, a handful of tiny turns. Run after `npx tsc -p tsconfig.json`:
//   node scripts/test-pi.mjs [path-to-pi] [provider/model]
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
class Emitter { constructor() { this.l = []; this.event = f => { this.l.push(f); return { dispose: () => { this.l = this.l.filter(x => x !== f); } }; }; } fire(e) { for (const f of [...this.l]) f(e); } dispose() { this.l = []; } }
const vscodeStub = { EventEmitter: Emitter, l10n: { t: (m, ...a) => m.replace(/\{(\d+)\}/g, (_, i) => String(a[i])) }, extensions: { getExtension: () => ({ packageJSON: { version: '0.0.0' } }) } };
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'vscode' ? vscodeStub : load.call(this, request, ...rest); };
const { PiBackend } = require('../out/chat/piAgent.js');

const binary = process.argv[2] ?? path.join(os.homedir(), '.local', 'bin', 'pi');
const MODEL = process.argv[3] ?? 'openai/gpt-5.6-luna';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-test-'));
fs.writeFileSync(path.join(work, 'hello.txt'), 'hello pi\n');

// ---- a fake MCP server (what the gate's registerMcpServer reaches)
const mcpLog = [];
const server = http.createServer((req, res) => {
	let body = '';
	req.on('data', d => body += d);
	req.on('end', () => {
		if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
		if (req.method !== 'POST') { res.writeHead(405).end(); return; }
		const m = JSON.parse(body);
		mcpLog.push({ method: m.method, auth: req.headers.authorization, chat: req.headers['x-ai-browser-chat'], client: m.params?.clientInfo?.name, tool: m.params?.name });
		if (m.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
		const send = result => { res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result })); };
		if (m.method === 'initialize') return send({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'ai-browser', version: '1' } });
		if (m.method === 'tools/list') return send({ tools: [{ name: 'browser_state', description: 'Reports the browser state. Call it when asked about the browser.', inputSchema: { type: 'object', properties: {} } }] });
		if (m.method === 'tools/call') return send({ content: [{ type: 'text', text: 'FAKE-STATE: no page is open' }] });
		send({});
	});
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const mcpUrl = `http://127.0.0.1:${server.address().port}/mcp`;
const TOKEN = 'faketoken-not-secret';

const backend = new PiBackend(binary, () => work, () => ({ url: mcpUrl, token: TOKEN }));
const results = [];
const step = async (name, fn) => { const t = Date.now(); try { await fn(); results.push(`ok   ${name} (${Date.now() - t} ms)`); } catch (e) { results.push(`FAIL ${name}: ${e.stack ?? e}`); } };

/** Sends one message and collects events until turnEnd. `onApproval(request)` returns true/false (or undefined to leave it). */
function turn(session, text, { onApproval, onEvent, timeout = 90_000, effort } = {}) {
	return new Promise((resolve, reject) => {
		const events = [];
		const timer = setTimeout(() => reject(new Error('turn timed out; events: ' + JSON.stringify(events.map(e => e.type)))), timeout);
		const sub = session.onEvent(e => {
			events.push(e);
			onEvent?.(e);
			if (e.type === 'approval') { const answer = onApproval?.(e.request); if (answer !== undefined) session.answer(e.request.id, answer); }
			if (e.type === 'turnEnd') { clearTimeout(timer); sub.dispose(); resolve(events); }
		});
		session.send({ text, images: [] }, MODEL, effort).catch(err => { clearTimeout(timer); reject(err); });
	});
}
const textOf = events => events.filter(e => e.type === 'text').map(e => e.text).join('');
const leftovers = () => { try { return execFileSync('pgrep', ['-f', 'pi.*--mode rpc.*aib-gate'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean); } catch { return []; } };

let ref;
await step('detection: models and commands from the real pi (no prompt)', async () => {
	const models = await backend.models();
	assert.ok(models.length > 0, 'no models listed');
	const luna = models.find(m => m.id === MODEL);
	assert.ok(luna, `${MODEL} not listed; have ${models.slice(0, 5).map(m => m.id)}`);
	console.log('  models:', models.length, '| luna efforts:', luna.efforts.join(','), '| default:', models.find(m => m.isDefault)?.id);
	const cmds = await backend.commands(work);
	console.log('  commands:', cmds.length, cmds.slice(0, 3).map(c => c.insert).join(' '));
	assert.ok(!cmds.some(c => c.name === 'aib-gate'));
});

await step('usage says there are no plan limits', async () => { const u = await backend.usage(); assert.equal(u.windows.length, 0); assert.ok(u.notes?.length); });

const session = backend.openSession(work, undefined, 0, work, [], true, 'chat-1');
await step('a real tiny turn: text, tokens, session ref, the one-time notice, no approval', async () => {
	let sessionEvent;
	session.onEvent(e => { if (e.type === 'session') sessionEvent = e.id; });
	const events = await turn(session, 'Reply with exactly the word: pong', { effort: 'low' });
	assert.match(textOf(events).toLowerCase(), /pong/);
	const end = events.at(-1);
	assert.equal(end.error, undefined, 'turn error: ' + end.error);
	const tokens = events.find(e => e.type === 'tokens');
	assert.ok(tokens && tokens.input > 0 && tokens.output > 0, 'no tokens');
	assert.equal(tokens.cumulative, false);
	assert.ok(events.some(e => e.type === 'context' && e.used > 0), 'no context');
	assert.ok(events.some(e => e.type === 'notice' || sessionEvent), 'no notice/session');
	assert.ok(sessionEvent, 'no session event');
	assert.equal(session.ref, sessionEvent);
	assert.equal(session.running, false);
	ref = session.ref;
	console.log('  tokens:', JSON.stringify(tokens), '| ref', ref);
	console.log('  notice:', (events.find(e => e.type === 'notice')?.text ?? '(first turn notice was emitted before the listener)').slice(0, 80));
});

await step('a read inside the project is allowed without a card', async () => {
	let asked = 0;
	const events = await turn(session, 'Read hello.txt with the read tool and tell me its content in a few words.', { onApproval: () => { asked++; return true; } });
	assert.ok(events.some(e => e.type === 'tool' && e.tool.kind === 'read'), 'no read row');
	assert.equal(asked, 0, 'a project read asked');
	assert.match(textOf(events).toLowerCase(), /hello pi/);
});

await step('gate: bash is asked as Terminal; Allow runs it', async () => {
	const requests = [];
	const events = await turn(session, 'Run `echo allowed-run` with the bash tool and report its output.', { onApproval: r => { requests.push(r); return true; } });
	assert.equal(requests.length, 1, 'expected one card');
	assert.equal(requests[0].what, 'command');
	assert.match(requests[0].title, /echo allowed-run/);
	const done = events.find(e => e.type === 'toolUpdate' && e.update.exitCode === 0);
	assert.ok(done, 'bash did not run');
	assert.match(done.update.output, /allowed-run/);
});

await step('gate: Deny blocks the tool, Pi tells the model, the turn ends', async () => {
	const marker = path.join(work, 'must-not-exist');
	const events = await turn(session, `Run \`touch ${marker}\` with the bash tool.`, { onApproval: () => false });
	assert.ok(!fs.existsSync(marker), 'the denied command ran');
	const failed = events.find(e => e.type === 'toolUpdate' && e.update.status === 'failed');
	assert.ok(failed, 'denied tool not shown as failed');
	console.log('  denied output:', JSON.stringify(failed.update.output));
});

await step('gate: a write outside the project is a card of its own kind', async () => {
	const outside = path.join(os.tmpdir(), 'pi-outside-' + process.pid + '.txt');
	const requests = [];
	await turn(session, `Write the text x to the file ${outside} with the write tool.`, { onApproval: r => { requests.push(r); return false; } });
	assert.ok(requests.length >= 1 && requests[0].what === 'outside', 'expected an outside card, got ' + JSON.stringify(requests.map(r => r.what)));
	assert.ok(!fs.existsSync(outside));
});

await step('browser tools: the gate registered our server, Pi calls it, the card is the AI Browser category', async () => {
	const requests = [];
	const events = await turn(session, 'Call the browser_state tool of the ai-browser server and report what it says.', { onApproval: r => { requests.push(r); return true; } });
	const calls = mcpLog.filter(l => l.method === 'tools/call');
	console.log('  fake server saw:', JSON.stringify(mcpLog.map(l => [l.method, l.client, l.auth === `Bearer ${TOKEN}`, l.chat ? 'chat-cap' : '-'])));
	assert.ok(calls.length >= 1, 'the fake server never got a tools/call');
	assert.equal(calls[0].auth, `Bearer ${TOKEN}`);
	assert.ok(calls[0].chat, 'no X-AI-Browser-Chat header');
	assert.ok(requests.some(r => r.what === 'browser'), 'card kinds: ' + JSON.stringify(requests.map(r => [r.what, r.title])));
	assert.match(textOf(events), /FAKE-STATE|no page/i);
	assert.ok(events.some(e => e.type === 'tool' && e.tool.kind === 'mcp'));
});

await step('Stop: abort kills the running command fast, the turn ends "Stopped."', async () => {
	let stopped;
	const t0 = () => Date.now();
	let started;
	const events = await turn(session, 'Run `sleep 40` with the bash tool, nothing else.', {
		onApproval: () => true,
		onEvent: e => { if (e.type === 'tool' && e.tool.kind === 'command' && !started) { started = t0(); setTimeout(() => { stopped = t0(); session.stop(); }, 1500); } },
	});
	assert.ok(started && stopped, 'the tool never started');
	assert.deepEqual(events.at(-1), { type: 'turnEnd', error: 'Stopped.' });
	console.log('  stop to end:', Date.now() - stopped, 'ms');
	assert.ok(Date.now() - stopped < 8000);
	assert.equal(session.running, false);
	try { execFileSync('pgrep', ['-f', 'sleep 40']); assert.fail('sleep 40 is still running'); } catch (e) { if (e.name === 'AssertionError') throw e; }
});

await step('after a Stop the next message works on the same process (set_model / thinking change, no restart)', async () => {
	const events = await turn(session, 'Reply with exactly the word: again', { effort: 'medium' });
	assert.match(textOf(events).toLowerCase(), /again/);
	assert.equal(events.at(-1).error, undefined);
});

await step('a message sent while a turn runs is steered (queued) and answered', async () => {
	let sentAt;
	const events = await turn(session, 'Run `sleep 6` with the bash tool, then say done.', {
		onApproval: () => true,
		onEvent: e => { if (e.type === 'tool' && !sentAt) { sentAt = true; session.send({ text: 'Also end your final answer with the word STEERED.', images: [] }, MODEL, undefined).catch(err => console.log('  steer error', err.message)); } },
	});
	console.log('  final text:', JSON.stringify(textOf(events).slice(-80)));
	assert.equal(events.at(-1).error, undefined);
	assert.match(textOf(events), /STEERED/i, 'the steered message was not taken into the turn');
});

const disposedRef = session.ref;
session.dispose();
await new Promise(r => setTimeout(r, 1500));
await step('dispose leaves no pi process behind', async () => { assert.deepEqual(leftovers(), []); });

await step('resume by ref: a new session in a new process remembers the conversation', async () => {
	const resumed = backend.openSession(work, disposedRef, 0, work, [], true, 'chat-1');
	assert.equal(resumed.ref, disposedRef);
	const events = await turn(resumed, 'What single word did I ask you to reply with in my very first message? Answer with just that word.');
	assert.match(textOf(events).toLowerCase(), /pong/);
	resumed.dispose();
});

await step('untrusted folder (ownSettings=false): -na still loads the gate and the turn works', async () => {
	const s = backend.openSession(work, undefined, 0, work, [], false, 'chat-2');
	const events = await turn(s, 'Reply with exactly the word: ok');
	assert.equal(events.at(-1).error, undefined);
	s.dispose();
});

await step('a model the login cannot use gives a message that says what to do', async () => {
	const s = backend.openSession(work, undefined, 0, work, [], true, 'chat-3');
	const models = await backend.models();
	const bad = models.find(m => m.id === 'openai/gpt-5-mini');
	if (!bad) { console.log('  (gpt-5-mini not listed; skipped)'); s.dispose(); return; }
	const events = await new Promise((resolve, reject) => {
		const ev = []; s.onEvent(e => { ev.push(e); if (e.type === 'turnEnd') resolve(ev); });
		s.send({ text: 'hi', images: [] }, bad.id, undefined).catch(reject);
	});
	console.log('  error:', events.at(-1).error?.slice(0, 160));
	assert.ok(events.at(-1).error, 'expected an error on a model the account cannot use (the catalogue lies for a ChatGPT login)');
	s.dispose();
});

backend.dispose();
server.close();
fs.rmSync(work, { recursive: true, force: true });
await new Promise(r => setTimeout(r, 500));
await step('backend.dispose leaves no pi process behind', async () => { assert.deepEqual(leftovers(), []); });

console.log('\n' + results.join('\n'));
process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
