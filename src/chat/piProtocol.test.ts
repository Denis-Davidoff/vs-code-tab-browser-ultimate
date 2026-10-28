import { test } from 'node:test';
import * as assert from 'node:assert';
import {
	PiEventReader, isCompactRequest, patchCounts, piArgs, piCommands, piErrorText, piGateExtension, piGateLoaded, piGatePrefix,
	piGateRequest, piGateTool, piMcpEnv, piMcpName, piModels, piResumeArgs, piSignedOut, piThinkingLevels, piTool, piUiResponse, splitPiModel,
} from './piProtocol.ts';
import type { AgentEvent } from './agentProtocol.ts';

/*
 * Samples recorded from pi 1.4.0 (2026-10-27, OpenAI login, gpt-5.6-luna), cut down: the system message,
 * toolcall deltas and credentials are left out; ids and numbers are as Pi sent them.
 */
const usage = (input: number, output: number, cacheRead: number, total: number, cost: number) => ({ input, output, cacheRead, cacheWrite: 0, reasoning: 0, totalTokens: total, cost: { total: cost } });
const callRead = 'call_Axi0gUNzepno9bxBoqm3B8uR|fc_08ee659c';
const callBash = 'call_MF92FmH7UQLIGqIuVaK63Ul8|fc_08ee659c';

const toolTurn: Record<string, unknown>[] = [
	{ type: 'agent_start' }, { type: 'turn_start' },
	{ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', usage: usage(1585, 26, 0, 1611, 0.0003482) } },
	{ type: 'tool_execution_start', toolCallId: callRead, toolName: 'read', args: { path: 'hello.txt', offset: null, limit: null } },
	{ type: 'tool_execution_end', toolCallId: callRead, toolName: 'read', result: { content: [{ type: 'text', text: 'hello pi\n' }], structuredContent: 'hello pi\n' }, isError: false },
	{ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', usage: usage(216, 23, 1408, 1647, 0.0001) } },
	{ type: 'tool_execution_start', toolCallId: callBash, toolName: 'bash', args: { command: 'echo done', timeout: null } },
	{ type: 'tool_execution_update', toolCallId: callBash, toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'done\n' }], details: {} } },
	{ type: 'tool_execution_end', toolCallId: callBash, toolName: 'bash', result: { content: [{ type: 'text', text: 'done\n' }], structuredContent: { output: 'done\n', truncated: false, exit_code: 0 } }, isError: false },
	{ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } },
	{ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'The file says' } },
	{ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ': hello pi.' } },
	{ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', usage: usage(124, 12, 1536, 1672, 0.0000692) } },
	{ type: 'agent_end', messages: [] }, { type: 'agent_settled', aborted: false },
];

const abortTurn: Record<string, unknown>[] = [
	{ type: 'agent_start' },
	{ type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } },
	{ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '**Setting bash timeout**' } },
	{ type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: '**Setting bash timeout**' } },
	{ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', usage: usage(161, 53, 1536, 1750, 0.0001) } },
	{ type: 'tool_execution_start', toolCallId: 'call_4otj|fc_0016', toolName: 'bash', args: { command: 'sleep 40', timeout: 45 } },
	{ type: 'tool_execution_end', toolCallId: 'call_4otj|fc_0016', toolName: 'bash', result: { content: [{ type: 'text', text: 'Command aborted' }], details: {} }, isError: true },
	{ type: 'message_end', message: { role: 'assistant', stopReason: 'error', usage: usage(0, 0, 0, 0, 0), errorMessage: 'This operation was aborted' } },
	{ type: 'agent_settled', aborted: true },
];

function run(messages: Record<string, unknown>[], reader = new PiEventReader()): AgentEvent[] {
	const out: AgentEvent[] = [];
	for (const m of messages) { out.push(...reader.read(m)); }
	return out;
}

test('a turn with two tools: rows, text block, usage summed over requests, context from the last one', () => {
	const reader = new PiEventReader();
	reader.window = 272000;
	const events = run(toolTurn, reader);
	const tools = events.filter(e => e.type === 'tool');
	assert.equal(tools.length, 2);
	assert.deepEqual((tools[0] as any).tool, { kind: 'read', name: 'Read', detail: 'hello.txt' });
	assert.equal((tools[1] as any).tool.kind, 'command');
	assert.equal((tools[1] as any).tool.input, 'echo done');
	const bashEnd = events.filter(e => e.type === 'toolUpdate' && (e as any).update.status === 'done' && (e as any).id === callBash)[0] as any;
	assert.equal(bashEnd.update.exitCode, 0);
	assert.equal(bashEnd.update.output, 'done\n');
	assert.deepEqual(events.filter(e => e.type === 'textBreak').length, 1);
	assert.equal(events.filter(e => e.type === 'text').map(e => (e as any).text).join(''), 'The file says: hello pi.');
	const contexts = events.filter(e => e.type === 'context') as any[];
	assert.equal(contexts.at(-1).used, 1672);
	assert.equal(contexts.at(-1).window, 272000);
	const tokens = events.find(e => e.type === 'tokens') as any;
	// input excludes cache reads in Pi; the chat's "sent" includes them
	assert.equal(tokens.input, 1585 + 216 + 1408 + 124 + 1536);
	assert.equal(tokens.output, 26 + 23 + 12);
	assert.equal(tokens.cached, 1408 + 1536);
	assert.ok(Math.abs(tokens.costUsd - (0.0003482 + 0.0001 + 0.0000692)) < 1e-9);
	assert.equal(tokens.cumulative, false);
	assert.deepEqual(events.at(-1), { type: 'turnEnd' });
});

test('a Stop: aborted settle is "Stopped.", the tool ends stopped, the abort error is not shown', () => {
	const reader = new PiEventReader();
	reader.stopping = true;
	const events = run(abortTurn, reader);
	const end = events.find(e => e.type === 'toolUpdate' && (e as any).update.status) as any;
	assert.equal(end.update.status, 'stopped');
	assert.equal(events.filter(e => e.type === 'thinking').length, 1);
	assert.deepEqual(events.at(-1), { type: 'turnEnd', error: 'Stopped.' });
});

test('thinking from the end event only when no deltas came', () => {
	const events = run([
		{ type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } },
		{ type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: '**Summary**' } },
	]);
	assert.deepEqual(events, [{ type: 'thinking', text: '**Summary**' }]);
});

test('an error in the stream ends the turn with the mapped text; usage is still counted', () => {
	const events = run([
		{ type: 'message_end', message: { role: 'assistant', stopReason: 'error', usage: usage(0, 0, 0, 0, 0), errorMessage: '400 {"error":{"code":"model_not_found","message":"The \'gpt-5.5\' model is not supported when using Codex with a ChatGPT account."}}' } },
		{ type: 'agent_settled', aborted: false },
	]);
	const end = events.at(-1) as any;
	assert.equal(end.type, 'turnEnd');
	assert.match(end.error, /not supported when using Codex/);
	assert.match(end.error, /Pick another model/);
});

test('a failed edit and an edit with a patch', () => {
	const reader = new PiEventReader();
	run([{ type: 'tool_execution_start', toolCallId: 'e1', toolName: 'edit', args: { path: 'a.ts', edits: [{ oldText: 'a', newText: 'b\nc' }] } }], reader);
	const events = reader.read({ type: 'tool_execution_end', toolCallId: 'e1', toolName: 'edit', result: { content: [{ type: 'text', text: 'ok' }], details: { patch: '--- a.ts\n+++ a.ts\n@@\n-a\n+b\n+c\n' } }, isError: false });
	assert.deepEqual((events[0] as any).update.added, 2);
	assert.deepEqual((events[0] as any).update.removed, 1);
	assert.deepEqual(patchCounts('--- x\n+++ x\n-a\n+b\n'), { added: 1, removed: 1 });
});

test('bash exiting non-zero without isError still shows failed', () => {
	const reader = new PiEventReader();
	run([{ type: 'tool_execution_start', toolCallId: 'b1', toolName: 'bash', args: { command: 'false' } }], reader);
	const events = reader.read({ type: 'tool_execution_end', toolCallId: 'b1', toolName: 'bash', result: { content: [], structuredContent: { exit_code: 1 } }, isError: false });
	assert.equal((events.at(-1) as any).update.status, 'failed');
});

test('tool rows: an MCP tool of ours reads ai-browser · tool', () => {
	assert.deepEqual(piTool('mcp__ai_browser__browser_state', {}), { kind: 'mcp', name: 'ai-browser · browser_state' });
	assert.equal(piTool('mcp__other__x', { a: 1 }).name, 'other · x');
	assert.equal(piTool('mystery', {}).kind, 'other');
});

test('thinking levels follow the model map (measured on four models)', () => {
	const null_ = null;
	assert.deepEqual(piThinkingLevels({ reasoning: true, thinkingLevelMap: { off: null_, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: null_, max: null_ } }), ['minimal', 'low', 'medium', 'high']);
	assert.deepEqual(piThinkingLevels({ reasoning: true, thinkingLevelMap: { off: 'off', minimal: null_, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } }), ['off', 'low', 'medium', 'high', 'xhigh', 'max']);
	assert.deepEqual(piThinkingLevels({ reasoning: false }), []);
});

test('models carry the provider, the efforts and the state model as default', () => {
	const list = { models: [
		{ id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', provider: 'openai', reasoning: true, contextWindow: 272000, thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high' } },
		{ id: 'gpt-5-mini', name: 'GPT-5 mini', provider: 'openai', reasoning: false },
		{ id: 'x', name: 'GPT-5 mini', provider: 'azure', reasoning: false },
	] };
	const models = piModels(list, { provider: 'openai', id: 'gpt-5.6-luna' });
	assert.equal(models[0].id, 'openai/gpt-5.6-luna');
	assert.equal(models[0].isDefault, true);
	assert.equal(models[0].defaultEffort, 'medium');
	assert.equal(models[0].description, 'openai · 272K context');
	assert.equal(models[1].label, 'GPT-5 mini · openai');
	assert.equal(models[2].label, 'GPT-5 mini · azure');
	assert.deepEqual(splitPiModel('openai/gpt-5.6-luna'), { provider: 'openai', id: 'gpt-5.6-luna' });
	assert.equal(splitPiModel('nonsense'), undefined);
});

test('signed out: model unknown and an empty list', () => {
	assert.equal(piSignedOut({ data: { model: { id: 'unknown', provider: 'unknown' } } }, []), true);
	assert.equal(piSignedOut({ data: { model: { id: 'm', provider: 'p' } } }, [{}]), false);
});

test('commands: skills and prompts only, by scope', () => {
	const commands = piCommands({ commands: [
		{ name: 'skill:diagram-design', description: 'Draw', source: 'skill', sourceInfo: { scope: 'user' } },
		{ name: 'review', source: 'prompt', sourceInfo: { scope: 'project' } },
		{ name: 'aib-gate', source: 'extension' },
	] });
	assert.deepEqual(commands.map(c => [c.name, c.insert, c.group]), [['skill:diagram-design', '/skill:diagram-design', 'user'], ['review', '/review', 'project']]);
	assert.equal(piGateLoaded({ commands: [{ name: 'aib-gate', source: 'extension' }] }), true);
	assert.equal(piGateLoaded({ commands: [] }), false);
});

test('errors say what to do next', () => {
	assert.match(piErrorText('No API key found for the selected model. Use /login to log into a provider.'), /not signed in/i);
	assert.match(piErrorText('429 rate limit exceeded'), /Wait and send again/);
	assert.match(piErrorText('503 overloaded'), /Send the message again/);
	assert.match(piErrorText('401 invalid api key'), /sign in again/);
	assert.equal(piErrorText('something odd'), 'something odd');
});

test('the gate: a question is read, mapped to Claude-shaped tools, and answered', () => {
	const request = { type: 'extension_ui_request', id: 'u1', method: 'confirm', title: `${piGatePrefix}bash`, message: JSON.stringify({ id: 'c1', input: { command: 'rm -rf x' } }) };
	const gate = piGateRequest(request)!;
	assert.equal(gate.requestId, 'u1');
	assert.equal(gate.callId, 'c1');
	assert.deepEqual(piGateTool(gate.tool, gate.input), { toolName: 'Bash', input: { command: 'rm -rf x' }, readOnly: false });
	// the id is optional, the input may be unreadable
	assert.equal(piGateRequest({ ...request, message: 'not json' })!.callId, undefined);
	assert.equal(piGateRequest({ ...request, title: 'Other extension' }), undefined);
	assert.deepEqual(piUiResponse('u1', true), { type: 'extension_ui_response', id: 'u1', confirmed: true });
	assert.deepEqual(piUiResponse('u1', 'cancel'), { type: 'extension_ui_response', id: 'u1', cancelled: true });
	assert.deepEqual(piGateTool('read', { path: 'a.ts' }), { toolName: 'Read', input: { file_path: 'a.ts' }, readOnly: true, path: 'a.ts' });
	assert.equal(piGateTool('mcp__ai_browser__terminal_send', { text: 'x' }).toolName, 'mcp__ai-browser__terminal_send');
	assert.equal(piGateTool('mcp__a__b__c', {}).toolName, 'mcp__a__b__c');
	assert.equal(piMcpName('mcp__a__b__c'), undefined);
});

test('the gate extension text: no secret, the command, the handler, the MCP registration', () => {
	assert.match(piGateExtension, /registerCommand\("aib-gate"/);
	assert.match(piGateExtension, /pi\.on\("tool_call"/);
	assert.match(piGateExtension, /exposure: "direct"/);
	assert.match(piGateExtension, /\$\{AIB_MCP_TOKEN\}/);
	assert.doesNotMatch(piGateExtension, /Bearer [A-Za-z0-9]{8}/);
	// a template literal in this file: the placeholders must have survived as text
	assert.equal(piGateExtension.includes('${AIB_CHAT}'), true);
});

test('arguments: explicit model, session id, the gate, no context files, trust', () => {
	const args = piArgs({ provider: 'openai', modelId: 'gpt-5.6-luna', thinking: 'low', sessionId: 'abc', extension: '/x/gate.ts', noApprove: true, contextFiles: false });
	assert.deepEqual(args, ['--mode', 'rpc', '--provider', 'openai', '--model', 'gpt-5.6-luna', '--thinking', 'low', '--session-id', 'abc', '-e', '/x/gate.ts', '--no-context-files', '--no-approve']);
	assert.deepEqual(piArgs({ noSession: true, noApprove: false, contextFiles: true }), ['--mode', 'rpc', '--no-session']);
	assert.ok(!piArgs({ thinking: 'bogus', noApprove: false, contextFiles: true }).includes('--thinking'));
	assert.deepEqual(piResumeArgs('abc'), ['--session', 'abc']);
	assert.deepEqual(piMcpEnv(undefined, 'c', undefined), {});
	assert.deepEqual(piMcpEnv({ url: 'http://127.0.0.1:1/mcp', token: 't' }, 'cap', undefined), { AIB_MCP_URL: 'http://127.0.0.1:1/mcp', AIB_MCP_TOKEN: 't', AIB_CHAT: 'cap' });
	assert.equal(isCompactRequest(' /compact '), true);
	assert.equal(isCompactRequest('/compact now'), false);
});

test('a path is judged as Pi will resolve it: the @ prefix and unicode spaces are Pi\'s (measured on Pi 1.4.0)', () => {
	assert.equal(piGateTool('read', { path: '@/etc/hosts' }).path, '/etc/hosts');
	assert.equal(piGateTool('write', { path: '@~/.ssh/x', content: 'c' }).path, '~/.ssh/x');
	assert.equal(piGateTool('grep', { pattern: 'x', path: '@/etc' }).path, '/etc');
	assert.equal(piGateTool('read', { path: ' /etc/hosts' }).path, ' /etc/hosts');
	assert.equal(piGateTool('read', { path: '@@a' }).path, '@a');
});
