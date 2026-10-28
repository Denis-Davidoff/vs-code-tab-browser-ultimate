/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { openrouterApproval, outsideProject } from './agentProtocol.ts';
import {
	OpencodeUpdates, opencodeApproval, opencodeApprovalAnswer, opencodeCodeCalls, opencodeCommands, opencodeCurrentModel,
	opencodeEffortLevels, opencodeEffortOption, opencodeErrorText, opencodeExitText, opencodeModels, opencodePermissionConfig, opencodeTurnEnd,
} from './opencodeProtocol.ts';

// Samples recorded from OpenCode 2.1.1 over `opencode acp`, 2026-10-27.
const sessionNew = {
	sessionId: 'ses_1',
	configOptions: [
		{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'opencode/big-pickle', options: [{ value: 'opencode/beam-free', name: 'opencode/Beam Free' }, { value: 'opencode/big-pickle', name: 'opencode/Big Pickle' }, { value: 'opencode/glm-5.3-flash-free', name: 'opencode/GLM 5.3 Flash Free' }] },
		{ id: 'mode', name: 'Session Mode', category: 'mode', type: 'select', currentValue: 'build', options: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' }] },
	],
};
const afterModelChange = {
	configOptions: [
		{ id: 'model', category: 'model', type: 'select', currentValue: 'opencode/glm-5.3-flash-free', options: [{ value: 'opencode/glm-5.3-flash-free', name: 'x' }] },
		{ id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'default', options: [{ value: 'low', name: 'low' }, { value: 'high', name: 'high' }, { value: 'max', name: 'max' }, { value: 'default', name: 'default' }] },
	],
};
const helpers = { outsideProject, ourToolCard: openrouterApproval };
const root = '/proj';
const code = (c: string) => ({ toolCall: { toolCallId: 't', name: 'execute', title: 'execute', kind: 'other', status: 'pending', rawInput: { code: c } }, options: [] });

suite('opencode models', () => {
	test('models come from the model option, the current one is the default', () => {
		const models = opencodeModels(sessionNew);
		assert.deepStrictEqual(models.map(m => m.id), ['opencode/beam-free', 'opencode/big-pickle', 'opencode/glm-5.3-flash-free']);
		assert.deepStrictEqual(models.map(m => m.isDefault), [false, true, false]);
		assert.strictEqual(opencodeCurrentModel(sessionNew), 'opencode/big-pickle');
	});
	test('efforts are the probe\'s per model, and default is not a level', () => {
		const levels = opencodeEffortLevels(opencodeEffortOption(afterModelChange));
		assert.deepStrictEqual(levels, ['low', 'high', 'max']);
		const models = opencodeModels(sessionNew, new Map([['opencode/glm-5.3-flash-free', levels]]));
		assert.deepStrictEqual(models[2].efforts, ['low', 'high', 'max']);
		assert.deepStrictEqual(models[1].efforts, []);
		assert.strictEqual(opencodeEffortOption(sessionNew), undefined);
	});
	test('garbage answers read as nothing', () => {
		assert.deepStrictEqual(opencodeModels(undefined), []);
		assert.deepStrictEqual(opencodeModels({ configOptions: [{ id: 'model', type: 'select', options: 4 }] }), []);
	});
	test('commands skip compact', () => {
		const list = opencodeCommands({ availableCommands: [{ name: 'init', description: 'guided AGENTS.md setup' }, { name: 'compact', description: 'Compact the session' }, { name: 'review', description: 'r' }] });
		assert.deepStrictEqual(list.map(c => c.name), ['init', 'review']);
		assert.strictEqual(list[0].insert, '/init');
	});
});

suite('opencode updates', () => {
	const shell = (u: OpencodeUpdates) => [
		...u.events({ sessionUpdate: 'tool_call', toolCallId: 'a', name: 'shell', title: 'shell', kind: 'execute', status: 'pending', locations: [{ path: '/w' }], rawInput: { cwd: '/w' } }),
	];
	test('a tool row waits for its input, then shows the command and its output', () => {
		const u = new OpencodeUpdates();
		assert.deepStrictEqual(shell(u), [], 'a shell call\'s first rawInput is only its cwd: held back');
	});
	test('empty rawInput holds the row back', () => {
		const u = new OpencodeUpdates();
		assert.deepStrictEqual(u.events({ sessionUpdate: 'tool_call', toolCallId: 'a', name: 'read', title: 'read', kind: 'read', status: 'pending', locations: [], rawInput: {} }), []);
		const shown = u.events({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'in_progress', kind: 'read', title: 'read', locations: [{ path: '/w/b.txt' }], rawInput: { path: '/w/b.txt' } });
		assert.deepStrictEqual(shown, [{ type: 'tool', id: 'a', tool: { kind: 'read', name: 'Read', detail: '/w/b.txt' } }]);
		const done = u.events({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Read file' } }] });
		assert.deepStrictEqual(done, [{ type: 'toolUpdate', id: 'a', update: { output: 'Read file', status: 'done' } }]);
	});
	test('a shell command shows its command, output and exit code', () => {
		const u = new OpencodeUpdates();
		u.events({ sessionUpdate: 'tool_call', toolCallId: 'c', name: 'shell', title: 'shell', kind: 'execute', status: 'pending', rawInput: {} });
		const start = u.events({ sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'in_progress', kind: 'execute', title: 'echo hello-acp', rawInput: { command: 'echo hello-acp', cwd: '/w' } });
		assert.deepStrictEqual(start, [{ type: 'tool', id: 'c', tool: { kind: 'command', name: 'Terminal', detail: undefined, input: 'echo hello-acp' } }]);
		assert.deepStrictEqual(u.events({ sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'in_progress', rawInput: { command: 'echo hello-acp', cwd: '/w' } }), []);
		const end = u.events({ sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'hello-acp\n' } }], rawOutput: { metadata: { status: 'completed', exit: 0 } } });
		assert.deepStrictEqual(end, [{ type: 'toolUpdate', id: 'c', update: { output: 'hello-acp\n', status: 'done', exitCode: 0 } }]);
	});
	test('an edit shows a diff from its input and takes the final one from the update', () => {
		const u = new OpencodeUpdates();
		u.events({ sessionUpdate: 'tool_call', toolCallId: 'e', name: 'edit', title: 'edit', kind: 'edit', status: 'pending', locations: [], rawInput: {} });
		const [start] = u.events({ sessionUpdate: 'tool_call_update', toolCallId: 'e', status: 'in_progress', kind: 'edit', title: 'edit', locations: [{ path: '/w/b.txt' }], rawInput: { path: '/w/b.txt', oldString: 'alpha beta', newString: 'gamma beta' } });
		assert.ok(start.type === 'tool' && start.tool.kind === 'edit' && start.tool.added === 1 && start.tool.removed === 1 && start.tool.detail === '/w/b.txt');
		const [end] = u.events({ sessionUpdate: 'tool_call_update', toolCallId: 'e', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Edited b.txt (1 replacement)' } }, { type: 'diff', path: '/w/b.txt', oldText: 'alpha beta\n', newText: 'gamma beta\n' }] });
		assert.ok(end.type === 'toolUpdate' && end.update.status === 'done' && end.update.added === 1 && /^-alpha beta$/m.test(end.update.input ?? ''));
	});
	test('a write is a diff of new content', () => {
		const u = new OpencodeUpdates();
		const events = u.events({ sessionUpdate: 'tool_call_update', toolCallId: 'w', status: 'in_progress', kind: 'edit', title: 'a.txt', locations: [{ path: '/w/a.txt' }], rawInput: { path: 'a.txt', content: 'x\ny' } });
		assert.ok(events[0].type === 'tool' && events[0].tool.added === 2 && events[0].tool.removed === 0);
	});
	test('an MCP call through code mode is one mcp row named by the tool it calls', () => {
		const u = new OpencodeUpdates();
		const events = u.events({ sessionUpdate: 'tool_call_update', toolCallId: 'm', status: 'in_progress', kind: 'other', name: 'execute', title: 'execute', rawInput: { code: 'const s = await tools["ai-browser"].browser_state();\nreturn s;' } });
		assert.ok(events[0].type === 'tool' && events[0].tool.kind === 'mcp' && events[0].tool.name === 'ai-browser · browser_state');
	});
	test('thinking, text, context', () => {
		const u = new OpencodeUpdates();
		assert.deepStrictEqual(u.events({ sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text: 'Hi' } }), [{ type: 'text', text: 'Hi' }]);
		assert.deepStrictEqual(u.events({ sessionUpdate: 'agent_thought_chunk', messageId: 'm:reasoning:0', content: { type: 'text', text: 'hm' } }), [{ type: 'thinking', text: 'hm' }]);
		assert.deepStrictEqual(u.events({ sessionUpdate: 'usage_update', used: 6312, size: 200000, cost: { amount: 0, currency: 'USD' } }), [{ type: 'context', used: 6312, window: 200000 }]);
		assert.deepStrictEqual(u.events({ sessionUpdate: 'available_commands_update', availableCommands: [] }), []);
	});
	test('a retry is told once per attempt, with the provider\'s message', () => {
		const u = new OpencodeUpdates();
		const retry = (attempt: number) => ({ sessionUpdate: 'session_info_update', _meta: { 'opencode/retry': { attempt, nextRetryAt: 'x', error: { type: 'provider.rate-limit', message: 'fake error 429', status: 429 } } } });
		const first = u.events(retry(2));
		assert.ok(first[0].type === 'notice' && /attempt 2/.test(first[0].text) && /fake error 429/.test(first[0].text));
		assert.deepStrictEqual(u.events(retry(2)), []);
		assert.deepStrictEqual(u.events({ sessionUpdate: 'session_info_update', _meta: { 'opencode/retry': null } }), []);
		assert.strictEqual(u.events(retry(3)).length, 1);
	});
});

suite('opencode turn end and failures', () => {
	const usage = { inputTokens: 6120, outputTokens: 39, totalTokens: 12611, thoughtTokens: 217, cachedReadTokens: 6235 };
	test('tokens add the cache to the input and thinking to the output', () => {
		const [tokens, end] = opencodeTurnEnd({ stopReason: 'end_turn', usage });
		assert.deepStrictEqual(tokens, { type: 'tokens', input: 12355, output: 256, cached: 6235, cumulative: false });
		assert.deepStrictEqual(end, { type: 'turnEnd' });
		assert.strictEqual(12355 + 256, usage.totalTokens);
	});
	test('cancelled is Stopped only when we stopped; a denied tool ends the turn with a notice', () => {
		assert.deepStrictEqual(opencodeTurnEnd({ stopReason: 'cancelled' }, { stopped: true }), [{ type: 'turnEnd', error: 'Stopped.' }]);
		const denied = opencodeTurnEnd({ stopReason: 'cancelled' }, { denied: true });
		assert.ok(denied[0].type === 'notice' && denied[1].type === 'turnEnd' && !denied[1].error);
	});
	test('other stop reasons', () => {
		assert.match(String((opencodeTurnEnd({ stopReason: 'max_tokens' }).at(-1) as { error?: string }).error), /context window/);
		assert.match(String((opencodeTurnEnd({ stopReason: 'refusal' }).at(-1) as { error?: string }).error), /refused/);
	});
	test('errors say what to do', () => {
		assert.match(opencodeErrorText(-32000, 'Authentication required: provider authentication required'), /opencode auth login/);
		assert.match(opencodeErrorText(-32603, 'Internal error: fake error 429', 'provider.rate-limit'), /rate limiting/);
		assert.match(opencodeErrorText(-32602, 'Invalid params: model not found: nope/nothing'), /Pick another model/);
		assert.match(opencodeErrorText(-32603, 'Internal error: boom'), /boom/);
		assert.match(opencodeExitText('spawn opencode ENOENT', true), /opencodePath/);
		assert.match(opencodeExitText('exit 1', false), /resumes this conversation/);
	});
});

suite('opencode code mode', () => {
	test('direct and bracketed calls are read, with plain JSON arguments', () => {
		assert.deepStrictEqual(opencodeCodeCalls('const s = await tools["ai-browser"].browser_state();\nreturn s;'), [{ server: 'ai-browser', tool: 'browser_state' }]);
		assert.deepStrictEqual(opencodeCodeCalls('return tools.testsrv.magic_number();'), [{ server: 'testsrv', tool: 'magic_number' }]);
		assert.deepStrictEqual(opencodeCodeCalls('await tools["ai-browser"].terminal_send({"terminalId":"t1","text":"ls (x)"})'), [{ server: 'ai-browser', tool: 'terminal_send', args: { terminalId: 't1', text: 'ls (x)' } }]);
	});
	test('anything else done with tools or the world is unreadable', () => {
		for (const c of [
			'const t = tools; return t["ai-browser"].browser_state()',
			'const s = tools["ai-browser"]; return s.terminal_send({})',
			'await fetch("http://127.0.0.1:1")',
			'tools["ai-browser"].browser_state(); require("fs")',
			'return 1',
			'tools[name].x()',
			'tools.a.b(); const f = tools.a.c;',
		]) {
			assert.strictEqual(opencodeCodeCalls(c), undefined, c);
		}
	});
	test('approval cards: ours by ourToolClass, the worst call wins, unreadable code is a command', () => {
		const state = opencodeApproval('1', code('return await tools["ai-browser"].browser_state();'), root, helpers);
		assert.strictEqual(state.what, 'browser');
		const send = opencodeApproval('1', code('await tools["ai-browser"].terminal_send({"terminalId":"t","text":"rm -rf ~"});'), root, helpers);
		assert.strictEqual(send.what, 'command');
		assert.ok(send.terminal && !send.terminal.read && send.terminal.args?.text === 'rm -rf ~');
		const mixed = opencodeApproval('1', code('await tools["ai-browser"].browser_state(); await tools["ai-browser"].terminal_key({"keys":["Enter"]});'), root, helpers);
		assert.ok(mixed.terminal && !mixed.terminal.read);
		assert.match(mixed.detail ?? '', /browser_state/);
		const hidden = opencodeApproval('1', code('const t = tools; await t["ai-browser"].terminal_send({text:"x"})'), root, helpers);
		assert.strictEqual(hidden.what, 'command');
		assert.match(hidden.detail ?? '', /terminal_send/);
		const other = opencodeApproval('1', code('return tools.testsrv.magic_number();'), root, helpers);
		assert.deepStrictEqual([other.what, other.server, other.title], ['mcp', 'testsrv', 'magic_number']);
		const unknownOurs = opencodeApproval('1', code('return tools["ai-browser"].brand_new_tool();'), root, helpers);
		assert.strictEqual(unknownOurs.what, 'other');
		const builtin = opencodeApproval('1', code('return tools.opencode.list_mcp_resources({"server":"x"});'), root, helpers);
		assert.strictEqual(builtin.what, 'other');
	});
	test('a server named like ours but with a suffix that is not a hash is not ours', () => {
		assert.strictEqual(opencodeApproval('1', code('return tools["ai-browser-evil"].browser_state();'), root, helpers).what, 'mcp');
	});
});

suite('opencode approvals', () => {
	const call = (c: Record<string, unknown>) => ({ toolCall: { toolCallId: 't', status: 'pending', ...c }, options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'always', kind: 'allow_always', name: 'Always allow' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }] });
	test('commands, edits, reads and fetches are sorted by kind and path', () => {
		const shell = opencodeApproval('1', call({ name: 'shell', title: 'echo hi', kind: 'execute', locations: [{ path: '/proj' }], rawInput: { command: 'echo hi\nrm -rf build' } }), root, helpers);
		assert.deepStrictEqual([shell.what, shell.title], ['command', 'echo hi\nrm -rf build']);
		const inside = opencodeApproval('1', call({ name: 'write', title: 'a.txt', kind: 'edit', locations: [{ path: '/proj/a.txt' }], rawInput: { path: 'a.txt', content: 'x' }, content: [{ type: 'diff', path: '/proj/a.txt', oldText: null, newText: 'x' }] }), root, helpers);
		assert.strictEqual(inside.what, 'edit');
		assert.strictEqual(opencodeApproval('1', call({ name: 'write', kind: 'edit', locations: [{ path: '/etc/x' }] }), root, helpers).what, 'outside');
		assert.strictEqual(opencodeApproval('1', call({ name: 'write', kind: 'edit', locations: [] }), root, helpers).what, 'outside');
		assert.strictEqual(opencodeApproval('1', call({ name: 'read', title: 'read', kind: 'read', locations: [{ path: '/etc/hosts' }] }), root, helpers).what, 'outside');
		assert.strictEqual(opencodeApproval('1', call({ name: 'webfetch', kind: 'fetch', rawInput: { url: 'https://x.test' } }), root, helpers).what, 'web');
		assert.strictEqual(opencodeApproval('1', call({ name: 'task', kind: 'other', rawInput: {} }), root, helpers).what, 'other');
	});
	test('answers pick allow once or reject, never always', () => {
		const p = call({});
		assert.deepStrictEqual(opencodeApprovalAnswer(p, true), { outcome: { outcome: 'selected', optionId: 'once' } });
		assert.deepStrictEqual(opencodeApprovalAnswer(p, false), { outcome: { outcome: 'selected', optionId: 'reject' } });
		assert.deepStrictEqual(opencodeApprovalAnswer({ options: [{ optionId: 'always', kind: 'allow_always' }] }, true), { outcome: { outcome: 'cancelled' } });
	});
	test('the permission config asks for everything but reads in the project', () => {
		const c = JSON.parse(opencodePermissionConfig);
		assert.strictEqual(c.permission['*'], 'ask');
		// A bare 'allow' would replace OpenCode's own question before reading a .env file (measured).
		assert.deepStrictEqual(c.permission.read, { '*': 'allow', '*.env': 'ask', '*.env.*': 'ask', '*.env.example': 'allow' });
	});
});

test('opencodeCodeCalls refuses an escaped identifier outside strings', () => {
	assert.equal(opencodeCodeCalls('t\\u006fols["ai-browser"].browser_state({})'), undefined);
	assert.equal(opencodeCodeCalls('tools["ai-browser"].browser_state({}); \\u0066etch("http://x")'), undefined);
	assert.ok(opencodeCodeCalls('tools["ai-browser"].browser_fill({"value":"caf\\u00e9"})'));
});
