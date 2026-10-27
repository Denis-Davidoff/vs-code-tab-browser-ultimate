/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What an agent can do to a terminal through `ChatViewProvider._terminalApi` — the real method, cut out
 * of `chatView.ts`, run against the real `TerminalTab` and typing gate. The rules that matter: only a
 * terminal pinned to the caller's own conversation is reachable, a terminal that does not exist reads
 * the same as one pinned elsewhere, and typing goes through the gate (user typing, the emergency stop,
 * an exited shell) and writes nothing when refused.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { suite, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule, ScriptTarget } from 'typescript';
import { TerminalPins } from './terminalPins.ts';
import { AgentTypingGate, UnreadTracker, typingQuietMs } from './terminalControl.ts';
import { TerminalTab, type TerminalSessionLike, type TerminalStarter } from './terminalTab.ts';
import { planKeys, typedTextProblem } from '../mcp/terminalInput.ts';

const source = readFileSync('src/chat/chatView.ts', 'utf8');

class TerminalRefusal extends Error {
	readonly retryable: boolean;
	constructor(message: string, retryable = false) { super(message); this.retryable = retryable; }
}

function liftStatic(name: string, context: Record<string, unknown>) {
	const match = new RegExp(`\\tprivate static ${name}\\([\\s\\S]*?\\n\\t\\}`).exec(source);
	assert.ok(match, `${name} is in chatView.ts`);
	const body = match[0].replace(/^\tprivate static /, 'function ');
	return runInNewContext(transpileModule(`${body}\n${name};`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, context);
}

class Session implements TerminalSessionLike {
	written: string[] = [];
	exited = false;
	exitCode: number | undefined;
	waits: unknown[] = [];
	write(data: string): void { this.written.push(data); }
	resize(): void { /* not used */ }
	ack(): void { /* not used */ }
	replay() { return { data: '', seq: 0 }; }
	dispose(): void { /* not used */ }
	async readScreen(options: unknown) { return { text: `read ${JSON.stringify(options)}`, viewport: '', cursor: '1.1', truncated: false, state: {} } as never; }
	async waitFor(options: unknown) { this.waits.push(options); return { text: '', viewport: '', cursor: '1.2', truncated: false, state: {}, reason: 'idle' } as never; }
}

async function rig() {
	let now = 1_000_000;
	const pins = new TerminalPins();
	const sessions = new Map<string, Session>();
	const terminals = new Map<string, TerminalTab>();
	const make = async (id: string) => {
		const session = new Session();
		sessions.set(id, session);
		const starter: TerminalStarter = async () => ({ session });
		const tab = new TerminalTab(id, `Terminal ${id}`, '/w', undefined, starter, () => undefined, () => undefined,
			{ now: () => now, controls: { gate: new AgentTypingGate(() => now), unread: new UnreadTracker(() => now) } });
		await tab.start();
		terminals.set(id, tab);
		return tab;
	};
	const tabsByChat: Record<string, { id: string }> = { 'chat-a': { id: 'tab-a' }, 'chat-b': { id: 'tab-b' } };
	const ChatViewProvider = {
		_pins: pins,
		_tabOfChat: (chatId: string) => tabsByChat[chatId] ? { tab: tabsByChat[chatId], surface: {} } : undefined,
		_terminalAcross: (id: string) => terminals.has(id) ? { terminal: terminals.get(id), surface: {} } : undefined,
		_pinnedInfos: (tab: { id: string }) => pins.pinsOf(tab.id).map(id => ({ id, name: terminals.get(id)!.name })),
	};
	const api = liftStatic('_terminalApi', { ChatViewProvider, TerminalRefusal, typedTextProblem, planKeys })();
	await make('t1'); await make('t2');
	pins.pin('tab-a', 't1');
	pins.pin('tab-b', 't2');
	return { api, pins, sessions, advance: (ms: number) => { now += ms; }, terminals, make };
}

async function refusal(promise: Promise<unknown>): Promise<TerminalRefusal> {
	try { await promise; } catch (error) { assert.ok(error instanceof TerminalRefusal, String(error)); return error; }
	assert.fail('expected a refusal');
}

suite('terminal_* — which terminals a conversation can reach', () => {
	test('list shows only the caller\'s own pins', async () => {
		const r = await rig();
		assert.deepEqual(r.api.list('chat-a').map((t: { id: string }) => t.id), ['t1']);
		assert.deepEqual(r.api.list('chat-b').map((t: { id: string }) => t.id), ['t2']);
		assert.equal(r.api.list('chat-unknown').length, 0);
	});

	test('a terminal pinned elsewhere, one that does not exist and one nobody pinned are refused alike, on every call', async () => {
		const r = await rig();
		await r.make('t3');
		const messages = new Set<string>();
		for (const id of ['t2', 'nope', 't3']) {
			messages.add((await refusal(r.api.read('chat-a', id, {}))).message);
			messages.add((await refusal(r.api.wait('chat-a', id, { until: 'idle', timeoutMs: 10 }, new AbortController().signal))).message);
			messages.add((await refusal(r.api.send('chat-a', id, { text: 'ls', enter: true }))).message);
			messages.add((await refusal(r.api.key('chat-a', id, { keys: ['enter'] }))).message);
		}
		assert.equal(messages.size, 1);
		assert.match([...messages][0], /not attached to this conversation/);
		for (const s of r.sessions.values()) { assert.deepEqual(s.written, []); }
	});

	test('a conversation that is no longer open is refused, and so is a terminal unpinned meanwhile', async () => {
		const r = await rig();
		assert.match((await refusal(r.api.read('chat-gone', 't1', {}))).message, /no longer open/);
		r.pins.unpin('tab-a', 't1');
		assert.match((await refusal(r.api.send('chat-a', 't1', { text: 'ls', enter: true }))).message, /not attached/);
	});
});

suite('terminal_read and terminal_wait', () => {
	test('read goes to the screen with the options, and says when the user last typed', async () => {
		const r = await rig();
		const first = await r.api.read('chat-a', 't1', { since: '1.0', maxChars: 500 });
		assert.equal(first.text, 'read {"since":"1.0","maxChars":500}');
		assert.equal(first.userTypedMsAgo, undefined);
		r.terminals.get('t1')!.input('x');
		r.advance(250);
		assert.equal((await r.api.read('chat-a', 't1', {})).userTypedMsAgo, 250);
	});

	test('wait passes the abort signal on, so a cancelled call stops waiting', async () => {
		const r = await rig();
		const controller = new AbortController();
		await r.api.wait('chat-a', 't1', { until: 'text', text: 'ready', timeoutMs: 1000 }, controller.signal);
		const options = r.sessions.get('t1')!.waits[0] as { signal: AbortSignal; text: string; until: string };
		assert.equal(options.signal, controller.signal);
		assert.equal(options.until, 'text');
		assert.equal(options.text, 'ready');
	});
});

suite('terminal_send and terminal_key', () => {
	test('send types the text and Enter, and nothing more', async () => {
		const r = await rig();
		assert.deepEqual(JSON.parse(JSON.stringify(await r.api.send('chat-a', 't1', { text: 'ls -la', enter: true }))), { sent: true });
		assert.equal((await r.api.send('chat-a', 't1', { text: 'git st', enter: false })).sent, true);
		assert.deepEqual(r.sessions.get('t1')!.written, ['ls -la\r', 'git st']);
		assert.deepEqual(r.sessions.get('t2')!.written, []);
	});

	test('what is typed is one line without a control character, so the card shows exactly what the shell gets', async () => {
		const r = await rig();
		for (const text of ['ls\nrm -rf ~', 'a\rb', 'x\u001b[201~y', 'a\u0000b']) {
			await refusal(r.api.send('chat-a', 't1', { text, enter: true }));
		}
		assert.deepEqual(r.sessions.get('t1')!.written, []);
	});

	test('while the user is typing the call is refused as retryable and writes nothing; after the quiet period it goes', async () => {
		const r = await rig();
		r.terminals.get('t1')!.input('a');
		r.advance(200);
		const refused = await refusal(r.api.send('chat-a', 't1', { text: 'ls', enter: true }));
		assert.equal(refused.retryable, true);
		assert.match(refused.message, /typing in this terminal/);
		assert.deepEqual(r.sessions.get('t1')!.written, ['a']);
		r.advance(typingQuietMs);
		const sent = await r.api.send('chat-a', 't1', { text: 'ls', enter: true });
		assert.equal(sent.sent, true);
		assert.ok(sent.userTypedMsAgo >= typingQuietMs);
		assert.deepEqual(r.sessions.get('t1')!.written, ['a', 'ls\r']);
	});

	test('the emergency stop refuses typing (not retryable) but not reading, and releasing it restores both', async () => {
		const r = await rig();
		r.terminals.get('t1')!.setAgentControl(false);
		const refused = await refusal(r.api.key('chat-a', 't1', { keys: ['ctrl-c'] }));
		assert.equal(refused.retryable, false);
		assert.match(refused.message, /paused agent control/);
		assert.deepEqual(r.sessions.get('t1')!.written, []);
		assert.equal((await r.api.read('chat-a', 't1', {})).cursor, '1.1');
		r.terminals.get('t1')!.setAgentControl(true);
		await r.api.key('chat-a', 't1', { keys: ['ctrl-c'] });
		assert.deepEqual(r.sessions.get('t1')!.written, ['\x03']);
	});

	test('key sends the named keys as their bytes in order, and refuses a name it does not know', async () => {
		const r = await rig();
		await r.api.key('chat-a', 't1', { keys: ['Up', 'enter', 'escape', 'shift+tab'] });
		assert.deepEqual(r.sessions.get('t1')!.written, ['\x1b[A\r\x1b\x1b[Z']);
		const bad = await refusal(r.api.key('chat-a', 't1', { keys: ['enter', 'hyper-z'] }));
		assert.match(bad.message, /Unknown key/);
		assert.equal(r.sessions.get('t1')!.written.length, 1);
	});

	test('an exited shell takes no input', async () => {
		const r = await rig();
		const session = r.sessions.get('t1')!;
		// The shell ends: the tab learns it through the handlers its starter was given.
		const tab = r.terminals.get('t1')!;
		(tab as unknown as { _exited(code: number): void })._exited(0);
		const refused = await refusal(r.api.send('chat-a', 't1', { text: 'ls', enter: true }));
		assert.match(refused.message, /has exited/);
		assert.deepEqual(session.written, []);
	});
});
