/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { openrouterApproval, ourToolClass } from './agentProtocol.ts';
import { isAgentAuthenticationError } from './agentAuthText.ts';
import { classifyClient } from '../mcp/mcpProtocol.ts';
import {
	messagesForModel,
	CompletionReader, OpenRouterApiError, SseParser, completionBody, entriesToMessages, isRetryableStatus, mcpResultToText, mcpToolsToOpenAi,
	openrouterChatModels, openrouterEndpoint, openrouterErrorText, parseToolArguments, readOpenRouterModels, readUsage, retryDelayMs, sanitiseToolName, userContent,
} from './openrouterProtocol.ts';

// Built from OpenAI's chat-completions format and OpenRouter's documented
// differences, NOT recorded from the live service (no key was available): they
// guard the readers against our own edits, not against the service.

function chunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ id: 'gen-1', choices: [{ index: 0, delta, finish_reason: null }], ...extra });
}

suite('OpenRouter: SSE', () => {
	test('events are cut anywhere, comments and CRLF are read, [DONE] is a payload', () => {
		const p = new SseParser();
		const out = [...p.push(': OPENROUTER PROCESSING\n\ndata: {"a":'), ...p.push('1}\r\n\r\ndata: [DO'), ...p.push('NE]\n\n')];
		assert.deepStrictEqual(out, ['{"a":1}', '[DONE]']);
	});
	test('an event the server did not close is given by flush; a lone CR is not split early', () => {
		const p = new SseParser();
		assert.deepStrictEqual(p.push('data: x\r'), []);
		assert.deepStrictEqual(p.push('\n\r\n'), ['x']);
		assert.deepStrictEqual(p.push('data: tail'), []);
		assert.deepStrictEqual(p.flush(), ['tail']);
	});
	test('multi-line data joins and other fields are ignored', () => {
		const p = new SseParser();
		assert.deepStrictEqual(p.push('event: x\ndata: a\ndata: b\n\n'), ['a\nb']);
	});
});

suite('OpenRouter: the completion stream', () => {
	test('text and reasoning deltas, finish reason, usage with cost', () => {
		const r = new CompletionReader();
		assert.deepStrictEqual(r.apply(chunk({ role: 'assistant', content: '', reasoning: 'think ' })), { text: '', thinking: 'think ' });
		assert.deepStrictEqual(r.apply(chunk({ content: 'Hel' })), { text: 'Hel', thinking: '' });
		r.apply(chunk({ content: 'lo' }));
		r.apply(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, cost: 0.0012, prompt_tokens_details: { cached_tokens: 3 } } }));
		r.apply('[DONE]');
		assert.strictEqual(r.text, 'Hello');
		assert.strictEqual(r.finishReason, 'stop');
		assert.strictEqual(r.done, true);
		assert.deepStrictEqual(r.usage, { input: 10, output: 4, cached: 3, costUsd: 0.0012 });
	});
	test('reasoning_details are read only when reasoning is absent', () => {
		const r = new CompletionReader();
		assert.strictEqual(r.apply(chunk({ reasoning: 'a', reasoning_details: [{ type: 'reasoning.text', text: 'a' }] })).thinking, 'a');
		assert.strictEqual(r.apply(chunk({ reasoning_details: [{ type: 'reasoning.text', text: 'b' }] })).thinking, 'b');
	});
	test('tool calls are assembled across chunks by index, a repeated name is not doubled', () => {
		const r = new CompletionReader();
		r.apply(chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'browser_click', arguments: '' } }] }));
		r.apply(chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'browser_state', arguments: '{}' } }] }));
		r.apply(chunk({ tool_calls: [{ index: 0, function: { name: 'browser_click', arguments: '{"selector":' } }] }));
		r.apply(chunk({ tool_calls: [{ index: 0, function: { arguments: '"#go"}' } }] }));
		assert.deepStrictEqual(r.toolCalls(), [
			{ id: 'call_a', name: 'browser_click', arguments: '{"selector":"#go"}' },
			{ id: 'call_b', name: 'browser_state', arguments: '{}' },
		]);
	});
	test('a call with no name is dropped and one with no id gets one', () => {
		const r = new CompletionReader();
		r.apply(chunk({ tool_calls: [{ index: 0, function: { arguments: '{}' } }, { index: 1, function: { name: 'x', arguments: '' } }] }));
		assert.deepStrictEqual(r.toolCalls(), [{ id: 'call_1', name: 'x', arguments: '' }]);
	});
	test('an error object in the stream throws with a readable text', () => {
		const r = new CompletionReader();
		assert.throws(() => r.apply(JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded' }, choices: [{ finish_reason: 'error', delta: {} }] })), (e: unknown) => e instanceof OpenRouterApiError && e.status === 429 && /rate limited/.test(e.message) && /Rate limit exceeded/.test(e.message));
	});
	test('garbage and comments are ignored', () => {
		const r = new CompletionReader();
		assert.deepStrictEqual(r.apply('not json'), { text: '', thinking: '' });
		assert.deepStrictEqual(r.apply('[1,2]'), { text: '', thinking: '' });
	});
	test('usage readers', () => {
		assert.strictEqual(readUsage(undefined), undefined);
		assert.strictEqual(readUsage({}), undefined);
		assert.deepStrictEqual(readUsage({ prompt_tokens: 1, completion_tokens: 2 }), { input: 1, output: 2, cached: 0 });
		assert.strictEqual(readUsage({ prompt_tokens: 1, cost: -1 })?.costUsd, undefined);
	});
	test('tool arguments: empty is none, a non-object is refused', () => {
		assert.deepStrictEqual(parseToolArguments(''), {});
		assert.deepStrictEqual(parseToolArguments('{"a":1}'), { a: 1 });
		assert.strictEqual(parseToolArguments('[1]'), undefined);
		assert.strictEqual(parseToolArguments('{"a":'), undefined);
	});
});

suite('OpenRouter: errors and retries', () => {
	test('each status says what happened and the next step', () => {
		assert.match(openrouterErrorText(401, '{"error":{"message":"No auth credentials found"}}'), /API key is invalid.*401/i);
		assert.ok(isAgentAuthenticationError(openrouterErrorText(401, '')));
		assert.ok(!isAgentAuthenticationError(openrouterErrorText(402, '')) && !isAgentAuthenticationError(openrouterErrorText(429, '')));
		assert.match(openrouterErrorText(402, ''), /credits/);
		assert.match(openrouterErrorText(404, ''), /model/);
		assert.match(openrouterErrorText(429, ''), /rate limited/);
		assert.match(openrouterErrorText(503, '{"error":{"message":"overloaded"}}'), /HTTP 503.*overloaded/);
	});
	test('the service message is plain and cut', () => {
		const text = openrouterErrorText(400, JSON.stringify({ error: { message: 'bad\n[x](command:evil)' + 'z'.repeat(1000) } }));
		assert.ok(!text.includes('\n'));
		assert.ok(text.length < 700);
	});
	test('only 429 and 5xx are retried, with a capped backoff', () => {
		assert.deepStrictEqual([400, 401, 402, 404, 429, 500, 503].map(isRetryableStatus), [false, false, false, false, true, true, true]);
		assert.deepStrictEqual([0, 1, 2].map(n => retryDelayMs(n)), [1000, 2000, 4000]);
		assert.strictEqual(retryDelayMs(0, '7'), 7000);
		assert.strictEqual(retryDelayMs(0, '9999'), 30_000);
		assert.strictEqual(retryDelayMs(0, 'Wed, 21 Oct 2026 07:28:00 GMT'), 1000);
	});
});

suite('OpenRouter: configuration', () => {
	test('models are validated, de-duplicated and capped', () => {
		const models = readOpenRouterModels([
			{ id: 'openai/gpt-x', name: 'GPT X', maxTokens: 1000, temperature: 0.5, reasoning: 'high', tools: false, images: true },
			{ id: 'openai/gpt-x' }, { id: 'bad id' }, { id: '' }, { id: 5 }, 'x', null,
			{ id: 'b/m', maxTokens: -1, temperature: 9, reasoning: 'extreme' },
		]);
		assert.deepStrictEqual(models, [
			{ id: 'openai/gpt-x', name: 'GPT X', maxTokens: 1000, temperature: 0.5, reasoning: 'high', tools: false, images: true },
			{ id: 'b/m' },
		]);
		assert.deepStrictEqual(readOpenRouterModels('nope'), []);
		assert.strictEqual(readOpenRouterModels(Array.from({ length: 300 }, (_, i) => ({ id: `m/${i}` }))).length, 100);
	});
	test('the picker lists efforts only for a reasoning model', () => {
		const chat = openrouterChatModels([{ id: 'a/b', reasoning: 'medium' }, { id: 'c/d', name: 'D', tools: false }]);
		assert.deepStrictEqual(chat[0].efforts, ['low', 'medium', 'high']);
		assert.strictEqual(chat[0].defaultEffort, 'medium');
		assert.deepStrictEqual(chat[1].efforts, []);
		assert.deepStrictEqual(chat.map(m => m.isDefault), [true, false]);
	});
	test('the endpoint is https or loopback http, with nothing else in it', () => {
		assert.deepStrictEqual(openrouterEndpoint(''), { url: 'https://openrouter.ai/api/v1' });
		assert.deepStrictEqual(openrouterEndpoint('http://127.0.0.1:8080/v1/'), { url: 'http://127.0.0.1:8080/v1' });
		assert.deepStrictEqual(openrouterEndpoint('https://gateway.example/api'), { url: 'https://gateway.example/api' });
		for (const bad of ['http://example.com/v1', 'ftp://x', 'nope', 'https://u:p@x.com', 'https://x.com/v1?k=1', 'http://127.0.0.1.evil.com/v1', 'http://localhost.evil.com']) {
			assert.ok('error' in openrouterEndpoint(bad), bad);
		}
	});
});

suite('OpenRouter: tools and messages', () => {
	test('names are sanitised, unique, and mapped back', () => {
		assert.strictEqual(sanitiseToolName('a.b c', new Set()), 'a_b_c');
		assert.strictEqual(sanitiseToolName('a_b_c', new Set(['a_b_c'])), 'a_b_c_2');
		assert.strictEqual(sanitiseToolName('x'.repeat(100), new Set()).length, 56);
		const { tools, names } = mcpToolsToOpenAi({ tools: [
			{ name: 'browser.click', description: 'Click', inputSchema: { type: 'object', properties: { s: { type: 'string' } } } },
			{ name: 'browser_click', inputSchema: 'bad' },
			{ title: 'no name' },
		] });
		assert.deepStrictEqual(tools.map(t => t.function.name), ['browser_click', 'browser_click_2']);
		assert.strictEqual(names.get('browser_click'), 'browser.click');
		assert.strictEqual(names.get('browser_click_2'), 'browser_click');
		assert.deepStrictEqual(tools[1].function.parameters, { type: 'object', properties: {} });
	});
	test('a result is text, cut with the cut said, images set aside, errors flagged', () => {
		const r = mcpResultToText({ content: [{ type: 'text', text: 'a'.repeat(30) }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'image', data: 'x', mimeType: 'text/html' }], isError: true }, 10);
		assert.match(r.text, /^a{10}\n… 20 more characters cut\.$/);
		assert.strictEqual(r.isError, true);
		assert.deepStrictEqual(r.images, [{ mediaType: 'image/png', base64: 'AAAA' }]);
		assert.strictEqual(mcpResultToText(undefined).text, '');
	});
	test('the cut never splits a surrogate pair', () => {
		const r = mcpResultToText({ content: [{ type: 'text', text: '😀'.repeat(5) }] }, 3);
		assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(r.text));
		assert.ok(r.text.startsWith('😀😀😀'));
	});
	test('images go as data URLs only for a model that declared them', () => {
		const img = [{ mediaType: 'image/png', base64: 'AAAA' }];
		assert.deepStrictEqual(userContent('look', img, true), [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]);
		const plainText = userContent('look', img, false);
		assert.ok(typeof plainText === 'string' && /not shown/.test(plainText) && !plainText.includes('AAAA'));
		assert.strictEqual(userContent('hi', [], false), 'hi');
	});
	test('a resumed conversation is rebuilt from prompts and replies only, starting at a prompt', () => {
		const messages = entriesToMessages([
			{ kind: 'notice', text: 'n' },
			{ kind: 'assistant', text: 'orphan' },
			{ kind: 'user', text: 'one', attachments: [] },
			{ kind: 'thinking', text: 't', startedAt: 1 },
			{ kind: 'assistant', text: 'a1' }, { kind: 'assistant', text: 'a2' },
			{ kind: 'user', text: 'two', attachments: [] },
		]);
		assert.deepStrictEqual(messages, [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'a1\n\na2' }, { role: 'user', content: 'two' }]);
		const cut = entriesToMessages([{ kind: 'user', text: 'x'.repeat(50), attachments: [] }, { kind: 'assistant', text: 'y'.repeat(5) }, { kind: 'user', text: 'z', attachments: [] }], 10);
		assert.deepStrictEqual(cut, [{ role: 'user', content: 'z' }]);
	});
	test('the request streams, includes usage, and sends tools only when the model allows', () => {
		const tools = mcpToolsToOpenAi({ tools: [{ name: 'browser_state', inputSchema: { type: 'object' } }] }).tools;
		const body = completionBody({ model: { id: 'a/b', maxTokens: 50, reasoning: 'low' }, messages: [{ role: 'user', content: 'hi' }], tools, effort: 'high' });
		assert.strictEqual(body.stream, true);
		assert.deepStrictEqual(body.usage, { include: true });
		assert.deepStrictEqual(body.reasoning, { effort: 'high' });
		assert.strictEqual(body.max_tokens, 50);
		assert.ok(Array.isArray(body.tools));
		const none = completionBody({ model: { id: 'a/b', tools: false }, messages: [], tools });
		assert.ok(!('tools' in none) && !('reasoning' in none));
		assert.deepStrictEqual(completionBody({ model: { id: 'a/b', reasoning: 'medium' }, messages: [], tools: [], effort: 'bogus' }).reasoning, { effort: 'medium' });
	});
});

suite('OpenRouter: approvals fail closed', () => {
	test('our tools keep their categories, anything unlisted is Other tools', () => {
		assert.strictEqual(openrouterApproval('1', 'browser_click', { selector: '#a' }, '').what, 'browser');
		assert.strictEqual(openrouterApproval('1', 'editor_context', {}, '').what, 'browser');
		assert.strictEqual(openrouterApproval('1', 'chat_stop_agent', {}, '').what, 'chat');
		assert.strictEqual(openrouterApproval('1', 'terminal_send', { terminalId: 't', text: 'ls' }, '').what, 'command');
		assert.strictEqual(openrouterApproval('1', 'terminal_send', { terminalId: 't', text: 'ls' }, '').terminal?.tool, 'terminal_send');
		assert.strictEqual(openrouterApproval('1', 'made_up_tool', {}, '').what, 'other');
		assert.strictEqual(ourToolClass('made_up_tool').what, 'other');
	});
	test('the card shows the arguments whole', () => {
		const card = openrouterApproval('1', 'browser_fill', { selector: '#a', value: 'x\ny' }, '');
		assert.match(card.detail ?? '', /selector: #a\nvalue: x\ny/);
	});
	test('the client is classified as OpenRouter', () => {
		assert.strictEqual(classifyClient('ai-browser-openrouter'), 'openrouter');
	});
});

test('messagesForModel turns historical images into a note for a text-only model', () => {
	const history = [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }] as never;
	const text = messagesForModel(history, false)[0] as unknown as { content: string };
	assert.match(text.content, /^look/);
	assert.doesNotMatch(JSON.stringify(text), /image_url/);
	assert.equal(messagesForModel(history, true)[0], (history as unknown as unknown[])[0]);
});
