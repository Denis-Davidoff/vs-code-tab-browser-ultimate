/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, test } from 'node:test';
import {
	LineSplitter, chatTitle, claudeApproval, claudeApprovalAnswer, claudeEvents, claudeModels, claudeRateLimitWindows, claudeUsage,
	claudeTool, codexAgentThreadEvents, codexApproval, codexApprovalAnswer, codexEvents, codexPatchPaths, outsideProject, codexModels, codexUsage, compareCliVersions, parseCliVersion, parseLine, toolDetail, unwrapShell, windowLabel,
} from './agentProtocol.ts';

// The samples below are trimmed copies of what Claude Code 2.1.301 and
// codex-cli 0.145.0 answered on 2026-10-16.

suite('LineSplitter', () => {

	test('a line split across two chunks comes out once, whole', () => {
		const s = new LineSplitter();
		assert.deepStrictEqual(s.push('{"a":'), []);
		assert.deepStrictEqual(s.push('1}\n{"b"'), ['{"a":1}']);
		assert.deepStrictEqual(s.push(':2}\n'), ['{"b":2}']);
	});

	test('a carriage return before the newline is dropped, blank lines are skipped', () => {
		const s = new LineSplitter();
		assert.deepStrictEqual(s.push('x\r\n\n  \ny\n'), ['x', 'y']);
	});

	test('parseLine takes objects only', () => {
		assert.deepStrictEqual(parseLine('{"type":"x"}'), { type: 'x' });
		assert.strictEqual(parseLine('[1]'), undefined);
		assert.strictEqual(parseLine('not json'), undefined);
	});
});

suite('claudeModels', () => {

	const initialize = {
		models: [
			{ value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
			{ value: 'haiku', displayName: 'Haiku 5.5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
			{ value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', supportsThinkingOff: true },
			{ displayName: 'no value' },
		],
	};

	test('reads id, label and effort levels, and skips an entry with no value', () => {
		const models = claudeModels(initialize);
		assert.deepStrictEqual(models.map(m => m.id), ['default', 'haiku', 'claude-haiku-4-5-20251001']);
		assert.strictEqual(models[0].label, 'Default (recommended)');
		assert.deepStrictEqual(models[1].efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
		assert.strictEqual(models[1].defaultEffort, 'high');
	});

	test('a model without supportsEffort has no levels, whatever else it lists', () => {
		assert.deepStrictEqual(claudeModels(initialize)[2].efforts, []);
		assert.strictEqual(claudeModels(initialize)[2].defaultEffort, undefined);
	});

	test('only the `default` alias is the default', () => {
		assert.deepStrictEqual(claudeModels(initialize).map(m => m.isDefault), [true, false, false]);
	});

	test('anything that is not a model list is no models', () => {
		assert.deepStrictEqual(claudeModels(undefined), []);
		assert.deepStrictEqual(claudeModels({ models: 'x' }), []);
	});
});

suite('codexModels', () => {

	const list = {
		data: [
			{ id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', hidden: false, isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'ultra' }] },
			{ id: 'secret', model: 'secret', hidden: true },
			{ id: 'gpt-5.6-luna', model: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', defaultReasoningEffort: 'nonsense', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
		],
		nextCursor: null,
	};

	test('reads models with their efforts and default, and skips a hidden one', () => {
		const models = codexModels(list);
		assert.deepStrictEqual(models.map(m => m.id), ['gpt-5.6-sol', 'gpt-5.6-luna']);
		assert.deepStrictEqual(models[0].efforts, ['low', 'medium', 'ultra']);
		assert.strictEqual(models[0].defaultEffort, 'low');
		assert.strictEqual(models[0].isDefault, true);
	});

	test('a default effort the model does not list is ignored', () => {
		assert.strictEqual(codexModels(list)[1].defaultEffort, undefined);
	});
});

suite('usage', () => {

	test('Claude: limits[] is read in percent, with ISO reset times and scoped labels', () => {
		const usage = claudeUsage({
			subscription_type: 'team',
			rate_limits_available: true,
			rate_limits: {
				five_hour: { utilization: 99 },
				limits: [
					{ kind: 'session', percent: 5, resets_at: '2026-10-16T11:40:00.239788+00:00' },
					{ kind: 'weekly_all', percent: 23, resets_at: '2026-10-20T03:00:00+00:00' },
					{ kind: 'weekly_scoped', percent: 0, scope: { model: { display_name: 'Fable' } } },
				],
				extra_usage: { is_enabled: true },
				spend: { used: { amount_minor: 1250, currency: 'EUR', exponent: 2 } },
			},
		});
		assert.strictEqual(usage.plan, 'team');
		assert.deepStrictEqual(usage.windows.map(w => [w.label, w.usedPercent]), [
			['5-hour limit', 5], ['Weekly limit', 23], ['Weekly · Fable', 0],
		]);
		assert.strictEqual(usage.windows[1].resetsAt, Date.parse('2026-10-20T03:00:00+00:00'));
		assert.deepStrictEqual(usage.notes, ['Extra usage is on — 12.50 EUR used this month.']);
	});

	test('Claude: without limits[] the older five_hour / seven_day fields are read', () => {
		const usage = claudeUsage({ rate_limits: { five_hour: { utilization: 7 }, seven_day: { utilization: 30 } } });
		assert.deepStrictEqual(usage.windows.map(w => [w.label, w.usedPercent]), [['5-hour limit', 7], ['Weekly limit', 30]]);
	});

	test('Claude: an account without plan limits says so', () => {
		const usage = claudeUsage({ rate_limits_available: false });
		assert.deepStrictEqual(usage.windows, []);
		assert.strictEqual(usage.notes.length, 1);
	});

	test('Claude: the rate_limit_event reports a fraction, which is turned into a percentage', () => {
		const windows = claudeRateLimitWindows({
			type: 'rate_limit_event',
			rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.06, resetsAt: 1792150800 }, seven_day: { utilization: 0.23 } } },
		});
		assert.deepStrictEqual(windows, [
			{ label: '5-hour limit', usedPercent: 6, resetsAt: 1792150800000 },
			{ label: 'Weekly limit', usedPercent: 23, resetsAt: undefined },
		]);
	});

	test('Codex: both windows, labelled by length, with reset times in seconds', () => {
		const usage = codexUsage({
			rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1792156873 }, secondary: { usedPercent: 40, windowDurationMins: 10080 }, planType: 'plus', credits: { hasCredits: false, unlimited: false, balance: '0' } },
		});
		assert.strictEqual(usage.plan, 'plus');
		assert.deepStrictEqual(usage.windows.map(w => [w.label, w.usedPercent]), [['5-hour limit', 12], ['Weekly limit', 40]]);
		assert.strictEqual(usage.windows[0].resetsAt, 1792156873000);
		assert.deepStrictEqual(usage.notes, []);
	});

	test('Codex: several limits are prefixed with their names', () => {
		const usage = codexUsage({
			rateLimitsByLimitId: {
				a: { limitName: 'Codex', primary: { usedPercent: 1, windowDurationMins: 300 } },
				b: { limitName: 'Reviews', primary: { usedPercent: 2, windowDurationMins: 1440 } },
			},
		});
		assert.deepStrictEqual(usage.windows.map(w => w.label), ['Codex · 5-hour limit', 'Reviews · 1-day limit']);
	});

	test('windowLabel names the lengths the CLIs use', () => {
		assert.strictEqual(windowLabel(300), '5-hour limit');
		assert.strictEqual(windowLabel(10080), 'Weekly limit');
		assert.strictEqual(windowLabel(120), '2-hour limit');
		assert.strictEqual(windowLabel(45), '45-minute limit');
	});
});

suite('claudeEvents', () => {

	test('the session id comes from system/init', () => {
		assert.deepStrictEqual(claudeEvents({ type: 'system', subtype: 'init', session_id: 'abc' }), [{ type: 'session', id: 'abc' }]);
		assert.deepStrictEqual(claudeEvents({ type: 'system', subtype: 'status' }), []);
	});

	test('text comes from deltas only, never again from the complete message', () => {
		assert.deepStrictEqual(
			claudeEvents({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } } }),
			[{ type: 'text', text: 'ok' }]);
		assert.deepStrictEqual(
			claudeEvents({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }),
			[]);
	});

	test('a Bash call carries its command for the body and its description for the row', () => {
		assert.deepStrictEqual(
			claudeEvents({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo hi && ls', description: 'Echo and list directory' } }] } }),
			[{ type: 'tool', id: 't1', tool: { kind: 'command', name: 'Bash', detail: 'Echo and list directory', input: 'echo hi && ls' } }]);
	});

	test('a tool result comes back by id, failed when is_error', () => {
		assert.deepStrictEqual(
			claudeEvents({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hi\na.txt', is_error: false }] } }),
			[{ type: 'toolUpdate', id: 't1', update: { output: 'hi\na.txt', status: 'done' } }]);
		assert.deepStrictEqual(
			claudeEvents({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'denied' }], is_error: true }] } }),
			[{ type: 'toolUpdate', id: 't2', update: { output: 'denied', status: 'failed' } }]);
	});

	test("a failed Bash result's leading \"Exit code N\" becomes the exit code", () => {
		assert.deepStrictEqual(
			claudeEvents({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: 'Exit code 1\nhi\ncat: missing.txt: No such file', is_error: true }] } }),
			[{ type: 'toolUpdate', id: 't3', update: { output: 'hi\ncat: missing.txt: No such file', status: 'failed', exitCode: 1 } }]);
	});

	test('thinking deltas, and a new text block breaks the text', () => {
		assert.deepStrictEqual(
			claudeEvents({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Counting' } } }),
			[{ type: 'thinking', text: 'Counting' }]);
		assert.deepStrictEqual(
			claudeEvents({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text', text: '' } } }),
			[{ type: 'textBreak' }]);
	});

	test("a sub-agent's text is not the reply, and its tools go on the agent's row", () => {
		assert.deepStrictEqual(claudeEvents({ type: 'stream_event', parent_tool_use_id: 't1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } } }), []);
		assert.deepStrictEqual(
			claudeEvents({ type: 'assistant', parent_tool_use_id: 't1', message: { content: [{ type: 'text', text: 'x' }, { type: 'tool_use', id: 's1', name: 'Read', input: { file_path: '/a/b.ts' } }] } }),
			[{ type: 'agentCall', parentId: 't1', name: 'Read', detail: '/a/b.ts' }]);
		assert.deepStrictEqual(claudeEvents({ type: 'user', parent_tool_use_id: 't1', message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: 'x' }] } }), []);
	});

	test('an Agent call is an agent row with its type and its prompt', () => {
		const [event] = claudeEvents({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a1', name: 'Agent', input: { description: 'Count files', prompt: 'Count the files\nin src', subagent_type: 'general-purpose', run_in_background: true } }] } });
		assert.strictEqual(event.type, 'tool');
		assert.ok(event.type === 'tool');
		assert.strictEqual(event.tool.kind, 'agent');
		assert.strictEqual(event.tool.detail, 'Count files');
		assert.strictEqual(event.tool.input, 'Count the files\nin src');
		assert.deepStrictEqual(event.tool.agent, { type: 'general-purpose', background: true });
	});

	test('a background launch keeps the row running and records the model', () => {
		assert.deepStrictEqual(
			claudeEvents({ type: 'user', tool_use_result: { status: 'async_launched', resolvedModel: 'claude-haiku-5-5' }, message: { content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'Async agent launched' }] } }),
			[{ type: 'toolUpdate', id: 'a1', update: { agent: { background: true, model: 'claude-haiku-5-5' } } }]);
	});

	test('task events: started, progress, and the notification that ends the row', () => {
		assert.deepStrictEqual(
			claudeEvents({ type: 'system', subtype: 'task_started', tool_use_id: 'a1', subagent_type: 'Explore', is_backgrounded: true }),
			[{ type: 'toolUpdate', id: 'a1', update: { agent: { type: 'Explore', background: true } } }]);
		assert.deepStrictEqual(
			claudeEvents({ type: 'system', subtype: 'task_progress', tool_use_id: 'a1', last_tool_name: 'Grep', usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 4000 } }),
			[{ type: 'toolUpdate', id: 'a1', update: { agent: { tokens: 1200, toolUses: 3, durationMs: 4000, lastTool: 'Grep' } } }]);
		assert.deepStrictEqual(
			claudeEvents({ type: 'system', subtype: 'task_notification', tool_use_id: 'a1', status: 'completed', summary: '12 files', usage: { total_tokens: 2000, tool_uses: 4, duration_ms: 9000 } }),
			[{ type: 'toolUpdate', id: 'a1', update: { status: 'done', output: '12 files', agent: { tokens: 2000, toolUses: 4, durationMs: 9000, summary: '12 files' } } }]);
		const stopped = claudeEvents({ type: 'system', subtype: 'task_notification', tool_use_id: 'a2', status: 'killed' });
		assert.ok(stopped[0].type === 'toolUpdate' && stopped[0].update.status === 'stopped');
		const failed = claudeEvents({ type: 'system', subtype: 'task_notification', tool_use_id: 'a3', status: 'failed' });
		assert.ok(failed[0].type === 'toolUpdate' && failed[0].update.status === 'failed');
		assert.deepStrictEqual(claudeEvents({ type: 'system', subtype: 'task_progress' }), []);
	});

	test('a task that is not an agent is not read, and task_updated finds its row through the task map', () => {
		const tasks = new Map<string, string>();
		assert.deepStrictEqual(claudeEvents({ type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'sh', task_type: 'local_bash', is_backgrounded: true }, tasks), []);
		assert.strictEqual(tasks.size, 0);
		assert.deepStrictEqual(
			claudeEvents({ type: 'system', subtype: 'task_started', task_id: 'k1', tool_use_id: 'a1', task_type: 'local_agent', subagent_type: 'Explore', is_backgrounded: false }, tasks),
			[{ type: 'toolUpdate', id: 'a1', update: { agent: { type: 'Explore', background: undefined } } }]);
		assert.deepStrictEqual(
			claudeEvents({ type: 'system', subtype: 'task_updated', task_id: 'k1', patch: { is_backgrounded: true } }, tasks),
			[{ type: 'toolUpdate', id: 'a1', update: { agent: { background: true } } }]);
		assert.deepStrictEqual(claudeEvents({ type: 'system', subtype: 'task_updated', task_id: 'k1', patch: { status: 'running' } }, tasks), []);
		assert.deepStrictEqual(claudeEvents({ type: 'system', subtype: 'task_updated', task_id: 'unknown', patch: { is_backgrounded: true } }, tasks), []);
	});

	test('the CLI requesting on its own is an automatic turn', () => {
		assert.deepStrictEqual(claudeEvents({ type: 'system', subtype: 'status', status: 'requesting' }), [{ type: 'autoTurn' }]);
	});

	test('result reports the turn\'s tokens and the process\'s cost, then ends the turn', () => {
		const events = claudeEvents({
			type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.0036,
			usage: { input_tokens: 2, cache_creation_input_tokens: 8026, cache_read_input_tokens: 26577, output_tokens: 3 },
		});
		assert.deepStrictEqual(events, [
			{ type: 'tokens', input: 34605, output: 3, cached: 26577, costUsd: 0.0036, cumulative: false },
			{ type: 'turnEnd', error: undefined },
		]);
	});

	test('a failed result carries its message', () => {
		const events = claudeEvents({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] });
		assert.deepStrictEqual(events.at(-1), { type: 'turnEnd', error: 'boom' });
	});

	test('a rate limit event becomes limits', () => {
		const events = claudeEvents({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.5 } } } });
		assert.strictEqual(events[0].type, 'limits');
	});
});

suite('codexEvents', () => {

	test('text deltas', () => {
		assert.deepStrictEqual(codexEvents('item/agentMessage/delta', { delta: 'ok', threadId: 't' }), [{ type: 'text', text: 'ok' }]);
	});

	test('a command item becomes a terminal row, unwrapped and summarised from its actions', () => {
		assert.deepStrictEqual(
			codexEvents('item/started', { item: { type: 'commandExecution', id: 'e1', command: "/bin/zsh -lc 'ls -la && cat a.txt'", commandActions: [{ type: 'listFiles' }, { type: 'read', name: 'a.txt' }] } }),
			[{ type: 'tool', id: 'e1', tool: { kind: 'command', name: 'Terminal', detail: 'Listed files, Read a.txt', input: 'ls -la && cat a.txt' } }]);
		assert.deepStrictEqual(codexEvents('item/started', { item: { type: 'userMessage', id: 'u' } }), []);
	});

	test('each agent message is its own block', () => {
		assert.deepStrictEqual(codexEvents('item/started', { item: { type: 'agentMessage', id: 'm' } }), [{ type: 'textBreak' }]);
	});

	test('a finished command reports its output and exit code; a failed one fails', () => {
		assert.deepStrictEqual(
			codexEvents('item/completed', { item: { type: 'commandExecution', id: 'e1', status: 'failed', exitCode: 1, aggregatedOutput: 'cat: missing.txt: No such file' } }),
			[{ type: 'toolUpdate', id: 'e1', update: { output: 'cat: missing.txt: No such file', status: 'failed', exitCode: 1 } }]);
		assert.deepStrictEqual(
			codexEvents('item/commandExecution/outputDelta', { itemId: 'e1', delta: 'line\n' }),
			[{ type: 'toolUpdate', id: 'e1', update: { output: 'line\n', append: true } }]);
	});

	test('a file change carries its diff and its counts', () => {
		const [event] = codexEvents('item/started', { item: { type: 'fileChange', id: 'f', changes: [{ path: 'src/a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new\n+more' }] } });
		assert.deepStrictEqual(event, { type: 'tool', id: 'f', tool: { kind: 'edit', name: 'Edit', detail: 'src/a.ts', input: '@@ -1 +1 @@\n-old\n+new\n+more', added: 2, removed: 1 } });
	});

	test('reasoning summaries are thinking, a new summary part is a paragraph', () => {
		assert.deepStrictEqual(codexEvents('item/reasoning/summaryTextDelta', { delta: 'Calculating' }), [{ type: 'thinking', text: 'Calculating' }]);
		assert.deepStrictEqual(codexEvents('item/reasoning/summaryPartAdded', { summaryIndex: 0 }), []);
		assert.deepStrictEqual(codexEvents('item/reasoning/summaryPartAdded', { summaryIndex: 1 }), [{ type: 'thinking', text: '\n\n' }]);
	});

	test('turn/completed: completed, failed and interrupted', () => {
		assert.deepStrictEqual(codexEvents('turn/completed', { turn: { status: 'completed' } }), [{ type: 'turnEnd', error: undefined }]);
		assert.deepStrictEqual(codexEvents('turn/completed', { turn: { status: 'failed', error: { message: 'quota' } } }), [{ type: 'turnEnd', error: 'quota' }]);
		assert.deepStrictEqual(codexEvents('turn/completed', { turn: { status: 'interrupted' } }), [{ type: 'turnEnd', error: 'Stopped.' }]);
	});

	test('token usage is the thread total', () => {
		assert.deepStrictEqual(
			codexEvents('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 14267, cachedInputTokens: 10, outputTokens: 5 }, last: {} } }),
			[{ type: 'tokens', input: 14267, output: 5, cached: 10, cumulative: true }]);
	});

	test('a spawned agent is a row; a wait is not, and its states end the agent', () => {
		const [spawn] = codexEvents('item/started', { item: { type: 'collabAgentToolCall', id: 'c1', tool: 'spawnAgent', prompt: 'Read the docs\nand report', model: 'gpt-6', receiverThreadIds: ['th1'] } });
		assert.ok(spawn.type === 'tool');
		assert.strictEqual(spawn.tool.kind, 'agent');
		assert.strictEqual(spawn.tool.detail, 'Read the docs');
		assert.deepStrictEqual(spawn.tool.agent, { type: 'spawnAgent', model: 'gpt-6', threadId: 'th1' });
		assert.deepStrictEqual(
			codexEvents('item/completed', { item: { type: 'collabAgentToolCall', id: 'c1', tool: 'spawnAgent', status: 'completed', receiverThreadIds: ['th1'] } }),
			[{ type: 'toolUpdate', id: 'c1', update: { agent: { threadId: 'th1' } } }]);
		assert.deepStrictEqual(codexEvents('item/started', { item: { type: 'collabAgentToolCall', id: 'w1', tool: 'wait' } }), []);
		assert.deepStrictEqual(
			codexEvents('item/completed', { item: { type: 'collabAgentToolCall', id: 'w1', tool: 'wait', agentsStates: { th1: { status: 'completed', message: 'done reading' }, th2: { status: 'interrupted' } } } }),
			[{ type: 'agentStates', states: [{ threadId: 'th1', status: 'done', message: 'done reading' }, { threadId: 'th2', status: 'stopped', message: undefined }] }]);
	});

	test('subAgentActivity: started is a row keyed by the agent thread, completed and interrupted end it', () => {
		const started = { type: 'subAgentActivity', id: 'call_1', kind: 'started', agentThreadId: 'th-a', agentPath: '/root/read_a' };
		assert.deepStrictEqual(codexEvents('item/started', { item: started }), [
			{ type: 'tool', id: 'th-a', tool: { kind: 'agent', name: 'Agent', detail: 'read a', agent: { type: '/root/read_a', threadId: 'th-a' } } },
		]);
		assert.deepStrictEqual(codexEvents('item/completed', { item: started }), []);
		assert.deepStrictEqual(codexEvents('item/started', { item: { ...started, id: 'x', kind: 'completed' } }), [{ type: 'toolUpdate', id: 'th-a', update: { status: 'done' } }]);
		assert.deepStrictEqual(codexEvents('item/started', { item: { ...started, id: 'y', kind: 'interrupted' } }), [{ type: 'toolUpdate', id: 'th-a', update: { status: 'stopped' } }]);
		assert.deepStrictEqual(codexEvents('item/started', { item: { ...started, kind: 'interacted' } }), []);
	});

	test("an agent's own thread fills its card: calls, tokens, report", () => {
		assert.deepStrictEqual(
			codexAgentThreadEvents('th-a', 'item/started', { threadId: 'th-a', item: { type: 'commandExecution', id: 'e', command: "/bin/zsh -lc 'cat a.txt'" } }),
			[{ type: 'agentCall', parentId: 'th-a', name: 'Terminal', detail: 'cat a.txt' }]);
		assert.deepStrictEqual(
			codexAgentThreadEvents('th-a', 'thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 18390, inputTokens: 18306, outputTokens: 84 } } }),
			[{ type: 'toolUpdate', id: 'th-a', update: { agent: { tokens: 18390 } } }]);
		assert.deepStrictEqual(
			codexAgentThreadEvents('th-a', 'item/completed', { item: { type: 'agentMessage', id: 'm', text: 'a.txt holds hello' } }),
			[{ type: 'toolUpdate', id: 'th-a', update: { agent: { summary: 'a.txt holds hello' } } }]);
		assert.deepStrictEqual(codexAgentThreadEvents('th-a', 'item/agentMessage/delta', { delta: 'x' }), []);
		assert.deepStrictEqual(codexAgentThreadEvents('th-a', 'turn/completed', { turn: { status: 'completed' } }), []);
		const [nested] = codexAgentThreadEvents('th-a', 'item/started', { item: { type: 'subAgentActivity', id: 'c', kind: 'started', agentThreadId: 'th-b', agentPath: '/root/read_a/check' } });
		assert.ok(nested.type === 'tool' && nested.id === 'th-b');
	});

	test('a web search and an image view still finish', () => {
		assert.deepStrictEqual(codexEvents('item/completed', { item: { type: 'webSearch', id: 'w', status: 'completed' } }), [{ type: 'toolUpdate', id: 'w', update: { status: 'done' } }]);
	});

	test('an error Codex is retrying is not reported', () => {
		assert.deepStrictEqual(codexEvents('error', { error: { message: 'x' }, willRetry: true }), []);
		assert.deepStrictEqual(codexEvents('error', { error: { message: 'x' }, willRetry: false }), [{ type: 'notice', text: 'x' }]);
	});
});

suite('small readers', () => {

	test('toolDetail prefers the command, then a path', () => {
		assert.strictEqual(toolDetail({ file_path: '/a', command: 'ls' }), 'ls');
		assert.strictEqual(toolDetail({ file_path: '/a' }), '/a');
		assert.strictEqual(toolDetail('x'), undefined);
	});

	test('chatTitle takes the first non-empty line and cuts it', () => {
		assert.strictEqual(chatTitle('\n  Fix the header  \nmore'), 'Fix the header');
		assert.strictEqual(chatTitle(''), 'New chat');
		assert.strictEqual(chatTitle('x'.repeat(80), 10), `${'x'.repeat(9)}…`);
	});
});

suite('CLI versions', () => {

	test('the version is read out of what each CLI prints', () => {
		assert.strictEqual(parseCliVersion('2.1.301 (Claude Code)'), '2.1.301');
		assert.strictEqual(parseCliVersion('codex-cli 0.162.0-alpha.17.2\n'), '0.162.0-alpha.17.2');
		assert.strictEqual(parseCliVersion('no version here'), undefined);
	});

	test('a newer alpha beats an older release — the case that hid the current Codex models', () => {
		const sorted = ['0.145.0', '0.162.0-alpha.17.2'].sort(compareCliVersions);
		assert.deepStrictEqual(sorted, ['0.162.0-alpha.17.2', '0.145.0']);
	});

	test('fields are numbers, and a release beats its own pre-release', () => {
		assert.ok(compareCliVersions('0.10.0', '0.9.9') < 0);
		assert.ok(compareCliVersions('1.0.0-beta', '1.0.0') > 0);
		assert.strictEqual(compareCliVersions('2.1.301', '2.1.301'), 0);
	});

	test('a copy whose version could not be read comes last', () => {
		assert.deepStrictEqual([undefined, '0.1.0'].sort(compareCliVersions), ['0.1.0', undefined]);
	});
});

suite('tool rows', () => {

	test('the shell around a Codex command is taken off, quoting included', () => {
		assert.strictEqual(unwrapShell("/bin/zsh -lc 'echo hi && cat a.txt'"), 'echo hi && cat a.txt');
		assert.strictEqual(unwrapShell("bash -c 'echo '\\''quoted'\\'''"), "echo 'quoted'");
		assert.strictEqual(unwrapShell('/bin/sh -c "echo \\"x\\""'), 'echo "x"');
		assert.strictEqual(unwrapShell('npm test'), 'npm test');
	});

	test('Claude tools: Edit becomes a diff with counts, MCP tools are named by server and tool', () => {
		assert.deepStrictEqual(claudeTool('Edit', { file_path: '/a.ts', old_string: 'a', new_string: 'b\nc' }),
			{ kind: 'edit', name: 'Edit', detail: '/a.ts', input: '-a\n+b\n+c', added: 2, removed: 1 });
		assert.strictEqual(claudeTool('mcp__ai-browser__browser_click', { selector: '#go' }).name, 'ai-browser · browser_click');
		assert.strictEqual(claudeTool('Grep', { pattern: 'TODO', path: 'src' }).detail, '"TODO" in src');
	});
});

suite('approvals', () => {
	// Recorded from Claude Code 2.1.301 run with `--permission-prompt-tool stdio`.
	const claudeBash = {
		subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash',
		input: { command: 'touch made-by-test.txt', description: 'Create an empty file called made-by-test.txt' },
		description: 'Create an empty file called made-by-test.txt',
		tool_use_id: 'toolu_01ToS8h6vH6iAN68DiZuShtH',
	};

	test('reads a Claude command, a browser tool, an edit and anything else', () => {
		assert.deepStrictEqual(claudeApproval('r1', claudeBash, '/w'), {
			id: 'r1', what: 'command', title: 'touch made-by-test.txt', detail: 'Create an empty file called made-by-test.txt',
		});
		assert.deepStrictEqual(claudeApproval('r2', { tool_name: 'mcp__ai-browser__browser_fill', input: { selector: '#email', value: 'Hello there' } }, '/w'), {
			id: 'r2', what: 'browser', title: 'browser_fill', detail: 'selector: #email\nvalue: Hello there',
		});
		assert.strictEqual(claudeApproval('r3', { tool_name: 'mcp__ai-browser-picto-2a3f1f__browser_state', input: {} }, '/w').what, 'browser');
		// Somebody else's server named like ours is not the browser.
		assert.strictEqual(claudeApproval('r3b', { tool_name: 'mcp__ai-browser-evil__run', input: {} }, '/w').what, 'mcp');
		// Another server's tool is a category of its own, by server.
		assert.deepStrictEqual(claudeApproval('r4', { tool_name: 'mcp__figma__get_screenshot', input: { node: '1:2' } }, '/w'), {
			id: 'r4', what: 'mcp', server: 'figma', title: 'get_screenshot', detail: 'node: 1:2',
		});
		assert.deepStrictEqual(claudeApproval('r5', { tool_name: 'Edit', input: { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' } }, '/w'), {
			id: 'r5', what: 'edit', title: '/w/a.ts', detail: 'Edit',
		});
		// Inside means inside the folder, not a name that starts like it.
		assert.strictEqual(claudeApproval('r5b', { tool_name: 'Write', input: { file_path: '/w-old/a.ts' } }, '/w').what, 'outside');
		assert.strictEqual(claudeApproval('r5c', { tool_name: 'Edit', input: { file_path: '../x/a.ts' } }, '/w').what, 'outside');
		assert.strictEqual(claudeApproval('r5d', { tool_name: 'Write', input: { file_path: 'src/a.ts' } }, '/w').what, 'edit');
		assert.deepStrictEqual(claudeApproval('r5e', { tool_name: 'Read', display_name: 'Read', input: { file_path: '/etc/hosts' } }, '/w'), {
			id: 'r5e', what: 'outside', title: '/etc/hosts', detail: 'Read',
		});
		assert.deepStrictEqual(claudeApproval('r6', { tool_name: 'WebFetch', input: { url: 'https://x', prompt: 'the price' } }, '/w'), {
			id: 'r6', what: 'web', title: 'https://x', detail: 'the price',
		});
		assert.strictEqual(claudeApproval('r6b', { tool_name: 'WebSearch', input: { query: 'vscode api' } }, '/w').what, 'web');
	});

	test('shows a command whole, line breaks and all', () => {
		// What the card shows must be what Allow runs: folded into one line,
		// `rm -rf build` read as an argument of `echo`.
		const command = `echo done\nrm -rf build\n${'x'.repeat(900)}`;
		assert.strictEqual(claudeApproval('r', { tool_name: 'Bash', input: { command } }, '/w').title, command);
		const huge = claudeApproval('r', { tool_name: 'Bash', input: { command: 'y'.repeat(100_010) } }, '/w').title;
		assert.ok(huge.includes('10 more characters not shown'));
	});

	test('answers Claude with the input as it was, or a refusal', () => {
		assert.deepStrictEqual(claudeApprovalAnswer(claudeBash.input, true), { behavior: 'allow', updatedInput: claudeBash.input });
		assert.strictEqual(claudeApprovalAnswer(claudeBash.input, false).behavior, 'deny');
		assert.deepStrictEqual(claudeApprovalAnswer(undefined, true), { behavior: 'allow', updatedInput: {} });
	});

	// Recorded from codex-cli 0.162.0-alpha.17.2 with approvalPolicy untrusted and approvalsReviewer user.
	const codexCommand = {
		kind: 'command', threadId: 't', turnId: 'u', itemId: 'exec-1',
		command: "/bin/zsh -lc 'touch made-by-codex.txt'", cwd: '/w',
		availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch', 'made-by-codex.txt'] } }, 'cancel'],
	};
	const codexMcp = {
		threadId: 't', turnId: 'u', serverName: 'ai-browser', mode: 'form',
		_meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'], tool_title: 'Browser state', tool_params: { selector: '#email' } },
		message: 'Allow the ai-browser MCP server to run tool "browser_state"?',
		requestedSchema: { type: 'object', properties: {} },
	};

	test('reads a Codex command, an MCP tool call and a patch', () => {
		assert.deepStrictEqual(codexApproval('1:5', 'item/commandExecution/requestApproval', codexCommand), {
			id: '1:5', what: 'command', title: 'touch made-by-codex.txt', detail: undefined,
		});
		assert.deepStrictEqual(codexApproval('1:6', 'mcpServer/elicitation/request', codexMcp), {
			id: '1:6', what: 'browser', title: 'browser_state', detail: 'selector: #email',
		});
		assert.deepStrictEqual(codexApproval('1:7', 'mcpServer/elicitation/request', { ...codexMcp, serverName: 'figma' }), {
			id: '1:7', what: 'mcp', server: 'figma', title: 'browser_state', detail: 'selector: #email',
		});
		assert.strictEqual(codexApproval('1:8', 'item/fileChange/requestApproval', { reason: 'write a file' }, ['/w/a.txt'], '/w')?.what, 'edit');
		// Measured: the v2 request carries only `itemId`; the paths come from its item.
		assert.deepStrictEqual(codexApproval('1:8', 'item/fileChange/requestApproval', { itemId: 'e', reason: null, grantRoot: null }, ['/w/hello.txt'], '/w'), {
			id: '1:8', what: 'edit', title: '/w/hello.txt', detail: undefined,
		});
		assert.strictEqual(codexApproval('1:8', 'item/fileChange/requestApproval', {}, ['/etc/x'], '/w')?.what, 'outside');
		const root = codexApproval('1:8', 'item/fileChange/requestApproval', { grantRoot: '/w' }, [], '/w');
		assert.strictEqual(root?.what, 'outside');
		assert.match(root?.detail ?? '', /everything under \/w/);
		// Typing into a running command is the terminal's; opening the network for one is the internet's.
		assert.strictEqual(codexApproval('1:10', 'item/commandExecution/requestApproval', { kind: 'writeStdin', command: null })?.what, 'command');
		const network = codexApproval('1:11', 'item/commandExecution/requestApproval', { command: 'curl x', networkApprovalContext: { host: 'example.com' } });
		assert.strictEqual(network?.what, 'web');
		assert.strictEqual(network?.title, 'Network access: example.com');
		assert.strictEqual(codexApproval('1:9', 'execCommandApproval', { command: ['ls', '-la'] })?.title, 'ls -la');
	});

	test('reads every way out of the project as outside it', () => {
		// No local folder: the CLI works in the home directory, which is not the project.
		assert.strictEqual(outsideProject(undefined, '/w/a.ts'), true);
		assert.strictEqual(claudeApproval('n1', { tool_name: 'Write', input: { file_path: path.join(os.homedir(), '.zshrc') } }, undefined).what, 'outside');
		// `~` is the home directory, as the CLI expands it — not a folder named `~`.
		assert.strictEqual(outsideProject('/w', '~/.zshrc'), true);
		assert.strictEqual(outsideProject('/w', '~other/x'), true);
		assert.strictEqual(claudeApproval('n2', { tool_name: 'Edit', input: { file_path: '~/.zshrc' } }, '/w').what, 'outside');
		// The path the CLI says the question is about counts too.
		assert.strictEqual(claudeApproval('n3', { tool_name: 'Read', input: { file_path: 'notes.md' }, blocked_path: '/etc/hosts' }, '/w').what, 'outside');
		// An absolute search pattern names where it looks.
		assert.strictEqual(claudeApproval('n4', { tool_name: 'Glob', input: { pattern: '/etc/**' } }, '/w').what, 'outside');
		assert.strictEqual(claudeApproval('n5', { tool_name: 'Glob', input: { pattern: 'src/**/*.ts' } }, '/w').what, 'other');
		// A file tool that names no file cannot be promised to stay inside.
		assert.strictEqual(claudeApproval('n6', { tool_name: 'Write', input: {} }, '/w').what, 'outside');
	});

	test('follows a symlink out of the project', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
		const away = fs.mkdtempSync(path.join(os.tmpdir(), 'away-'));
		try {
			fs.symlinkSync(away, path.join(root, 'link'));
			assert.strictEqual(outsideProject(root, path.join(root, 'link', '.zshrc')), true);
			assert.strictEqual(outsideProject(root, 'link/new/file.txt'), true);
			assert.strictEqual(outsideProject(root, 'src/new.ts'), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(away, { recursive: true, force: true });
		}
	});

	test('reads where a Codex patch moves a file, and a patch with no paths', () => {
		assert.deepStrictEqual(codexPatchPaths([{ path: '/w/a.txt', kind: { type: 'update', move_path: '/home/u/.zshrc' } }]), ['/w/a.txt', '/home/u/.zshrc']);
		assert.deepStrictEqual(codexPatchPaths({ '/w/a.txt': { update: {}, move_path: '/etc/x' } }), ['/w/a.txt', '/etc/x']);
		assert.strictEqual(codexApproval('m1', 'applyPatchApproval', { fileChanges: { '/w/a.txt': { move_path: '/etc/x' } } }, [], '/w')?.what, 'outside');
		assert.strictEqual(codexApproval('m2', 'item/fileChange/requestApproval', {}, [], '/w')?.what, 'outside');
	});

	test('does not read a form a server asks for as an approval', () => {
		assert.strictEqual(codexApproval('1:1', 'mcpServer/elicitation/request', { ...codexMcp, _meta: {} }), undefined);
		assert.strictEqual(codexApproval('1:1', 'item/tool/requestUserInput', {}), undefined);
	});

	test('answers Codex in each method’s own shape', () => {
		assert.deepStrictEqual(codexApprovalAnswer('item/commandExecution/requestApproval', codexCommand, true), { decision: 'accept' });
		// `decline` is not among the decisions offered, so the refusal is `cancel`.
		assert.deepStrictEqual(codexApprovalAnswer('item/commandExecution/requestApproval', codexCommand, false), { decision: 'cancel' });
		assert.deepStrictEqual(codexApprovalAnswer('item/commandExecution/requestApproval', { command: 'x' }, false), { decision: 'decline' });
		assert.deepStrictEqual(codexApprovalAnswer('item/fileChange/requestApproval', {}, false), { decision: 'decline' });
		assert.deepStrictEqual(codexApprovalAnswer('mcpServer/elicitation/request', codexMcp, true), { action: 'accept', content: null });
		assert.deepStrictEqual(codexApprovalAnswer('mcpServer/elicitation/request', codexMcp, false), { action: 'decline', content: null });
		assert.deepStrictEqual(codexApprovalAnswer('execCommandApproval', {}, true), { decision: 'approved' });
	});
});
