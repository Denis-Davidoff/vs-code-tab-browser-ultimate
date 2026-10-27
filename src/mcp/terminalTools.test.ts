import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { TerminalGrants } from './terminalGrants.ts';
import * as protocol from './mcpProtocol.ts';
import * as input from './terminalInput.ts';
import type { Tool, Caller } from './mcpProtocol.ts';

// terminalTools.ts imports its siblings without an extension, which Node's type
// stripping cannot resolve, so it is transpiled and given them here.
function loadTools(): typeof import('./terminalTools.ts') {
	const code = transpileModule(readFileSync(resolve('src/mcp/terminalTools.ts'), 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
	const exports = {};
	const deps: Record<string, unknown> = { './mcpProtocol': protocol, './terminalInput': input };
	runInNewContext(code, { exports, AbortController, require: (name: string) => deps[name] });
	return exports as typeof import('./terminalTools.ts');
}
const mod = loadTools();

const screen = (text = 'ok', cursor = '1.5') => ({
	text, viewport: '$ ', cursor, truncated: false,
	state: { status: 'running' as const, altScreen: false, idleMs: 0, cols: 80, rows: 24, commandState: 'unknown' as const, integration: 'none' as const },
});

function fixture(opts: { denied?: boolean; refuse?: Error } = {}) {
	const grants = new TerminalGrants();
	const sent: unknown[] = [];
	let waitSignal: AbortSignal | undefined;
	const terminal = {
		list: () => [{ id: 't1', name: 'Terminal 1', status: 'running' as const, cwd: '/p', cols: 80, rows: 24, agentControl: 'allowed' as const }],
		read: async () => screen(),
		wait: async (_c: string, _t: string, _o: unknown, signal: AbortSignal) => { waitSignal = signal; return { ...screen('after'), reason: 'idle' }; },
		send: async (_c: string, _t: string, o: unknown) => { if (opts.refuse) { throw opts.refuse; } sent.push(o); return { sent: true as const }; },
		key: async (_c: string, _t: string, o: unknown) => { sent.push(o); return { sent: true as const }; },
	};
	const port = { target: { tabOf: (id: string) => id === 'chat-1' ? 'tab-1' : undefined, terminal, grants, terminalDenied: () => !!opts.denied } } as any;
	const tools = new Map<string, Tool>(mod.terminalTools(port).map(t => [t.name, t]));
	const run = (name: string, args: Record<string, unknown>, caller: Caller = { kind: 'claude', chatId: 'chat-1' } as Caller, signal?: AbortSignal) =>
		tools.get(name)!.run(args, caller, signal) as Promise<any>;
	return { grants, sent, run, tools, waitSignal: () => waitSignal };
}

test('the five tools are the names agentProtocol writes twice', () => {
	assert.deepStrictEqual([...fixture().tools.keys()], [...mod.terminalToolNames]);
	assert.deepStrictEqual([...mod.terminalInputToolNames, ...mod.terminalReadToolNames].sort(), [...mod.terminalToolNames].sort());
});

test('hidden from and refused to a caller without the chat capability', async () => {
	const f = fixture();
	for (const [name, tool] of f.tools) {
		assert.strictEqual(tool.visibleTo?.({ kind: 'claude' } as Caller), false, name);
		assert.strictEqual(tool.visibleTo?.({ kind: 'claude', chatId: 'x' } as Caller), true, name);
		await assert.rejects(f.run(name, { terminalId: 't1', text: 'ls', keys: ['enter'], until: 'idle' }, { kind: 'other' } as Caller), /Only the agents of the AI Browser chat/);
	}
	await assert.rejects(f.run('terminal_list', {}, { kind: 'claude', chatId: 'gone' } as Caller), /no longer open/);
});

test('Terminal on Deny switches every tool off', async () => {
	const f = fixture({ denied: true });
	for (const name of f.tools.keys()) {
		await assert.rejects(f.run(name, { terminalId: 't1', text: 'ls', keys: ['enter'], until: 'idle' }), (e: Error) => e instanceof mod.TerminalRefusal && /Deny/.test(e.message), name);
	}
});

test('typing needs a grant for exactly that input, used once', async () => {
	const f = fixture();
	await assert.rejects(f.run('terminal_send', { terminalId: 't1', text: 'ls' }), /has not approved/);
	assert.strictEqual(f.sent.length, 0);
	f.grants.mint('chat-1', 'terminal_send', input.terminalInputFingerprint('terminal_send', { terminalId: 't1', text: 'ls' }));
	await assert.rejects(f.run('terminal_send', { terminalId: 't1', text: 'rm -rf ~' }), /has not approved/, 'an approval of ls is no approval of another line');
	const result = await f.run('terminal_send', { terminalId: 't1', text: 'ls' });
	assert.strictEqual(result.sent, true);
	assert.strictEqual(result.text, 'after');
	assert.deepStrictEqual(JSON.parse(JSON.stringify(f.sent)), [{ text: 'ls', enter: true }]);
	await assert.rejects(f.run('terminal_send', { terminalId: 't1', text: 'ls' }), /has not approved/, 'single use');
});

test('a bad input burns no grant, and a refusal before typing gives it back', async () => {
	const f = fixture({ refuse: new mod.TerminalRefusal('The user is typing; retry in 900 ms.', true) });
	const fp = input.terminalInputFingerprint('terminal_send', { terminalId: 't1', text: 'ls' });
	f.grants.mint('chat-1', 'terminal_send', fp);
	await assert.rejects(f.run('terminal_send', { terminalId: 't1', text: 'a\x1bb' }));
	assert.strictEqual(f.grants.count('chat-1'), 1, 'validation comes before the grant');
	await assert.rejects(f.run('terminal_send', { terminalId: 't1', text: 'ls' }), /retry in 900/);
	assert.strictEqual(f.grants.count('chat-1'), 1, 'refunded');
});

test('keys are validated, granted and sent by name', async () => {
	const f = fixture();
	await assert.rejects(f.run('terminal_key', { terminalId: 't1', keys: ['launch-missiles'] }));
	f.grants.mint('chat-1', 'terminal_key', input.terminalInputFingerprint('terminal_key', { terminalId: 't1', keys: ['up', 'enter'] }));
	await f.run('terminal_key', { terminalId: 't1', keys: ['up', 'enter'], waitMs: 0 });
	assert.deepStrictEqual(JSON.parse(JSON.stringify(f.sent)), [{ keys: ['up', 'enter'] }]);
});

test('wait checks its arguments and carries the cancellation', async () => {
	const f = fixture();
	await assert.rejects(f.run('terminal_wait', { terminalId: 't1', until: 'soon' }), /`until`/);
	await assert.rejects(f.run('terminal_wait', { terminalId: 't1', until: 'text' }), /`text` is required/);
	const abort = new AbortController();
	const result = await f.run('terminal_wait', { terminalId: 't1', until: 'idle' }, undefined, abort.signal);
	assert.strictEqual(result.reason, 'idle');
	assert.strictEqual(f.waitSignal(), abort.signal);
});

test('a screen result is bounded, keeps the newest text and carries the data note', () => {
	const big = 'a'.repeat(50_000) + 'END';
	const r = mod.screenResult('t1', { ...screen(big), viewport: 'v'.repeat(20_000) }, 1000) as any;
	assert.strictEqual(r.text.length, 1000);
	assert.ok(r.text.endsWith('END'));
	assert.strictEqual(r.truncated, true);
	assert.strictEqual(r.viewport.length, 8000);
	assert.match(r.note, /untrusted data/);
	assert.deepStrictEqual({ ...mod.tailOf('x\u{1F600}', 1) }, { text: '', cut: true }, 'never half a surrogate pair');
});
