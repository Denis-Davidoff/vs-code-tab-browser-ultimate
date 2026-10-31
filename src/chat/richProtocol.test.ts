import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { resultBlocks, richNotice, richPlan, richProgress, richCitations, codexEvents, claudeEvents } from './agentProtocol.ts';

const gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

test('multipart results preserve text, JSON types, native images, file bytes, resource links and unknown fields', () => {
	const blocks = resultBlocks([
		{ type: 'text', text: 'First block' },
		{ type: 'json', value: { count: 2, valid: false, missing: null } },
		{ type: 'image', mimeType: 'image/gif', data: gif },
		{ type: 'image', source: { type: 'base64', media_type: 'image/gif', data: gif } },
		{ type: 'resource', resource: { uri: 'report.txt', mimeType: 'text/plain', blob: 'aGk=' } },
		{ type: 'resource_link', uri: 'https://example.com', name: 'Source' },
		{ type: 'futureBlock', custom: { preserved: true } },
	], { nested: [1, true, null] });
	assert.deepEqual(blocks.map(block => block.type), ['text', 'json', 'image', 'image', 'file', 'link', 'json', 'json']);
	assert.deepEqual(blocks[1], { type: 'json', value: { count: 2, valid: false, missing: null } });
	assert.deepEqual(blocks[6], { type: 'json', value: { type: 'futureBlock', custom: { preserved: true } } });
	assert.equal(blocks[4].type === 'file' && blocks[4].base64, 'aGk=');
});

test('Claude and Codex pass structured result blocks to the shared chat controller', () => {
	const content = [{ type: 'text', text: 'Image follows' }, { type: 'image', mimeType: 'image/gif', data: gif }];
	const claude = claudeEvents({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content }] } });
	const codex = codexEvents('item/completed', { item: { id: 'tool', type: 'mcpToolCall', status: 'completed', result: { content, structuredContent: { value: 42 } } } });
	assert.equal(claude[0].type === 'toolUpdate' && claude[0].update.blocks?.[1].type, 'image');
	assert.deepEqual(codex[0].type === 'toolUpdate' && codex[0].update.blocks?.at(-1), { type: 'json', title: 'Structured result', value: { value: 42 } });
});

test('native provider plans and MCP progress normalize statuses and stable identities', () => {
	const plan = codexEvents('turn/plan/updated', { turnId: 'turn-1', explanation: 'Ship', plan: [{ step: 'Read', status: 'completed' }, { step: 'Build', status: 'inProgress' }] });
	assert.equal(plan[0].type, 'plan');
	assert.deepEqual(plan[0].type === 'plan' && plan[0].steps.map(step => step.status), ['done', 'inProgress']);
	const progress = codexEvents('item/mcpToolCall/progress', { itemId: 'tool-1', message: 'Downloading' });
	assert.deepEqual(progress, [{ type: 'progress', id: 'progress:tool-1', title: 'Tool progress', stage: 'Downloading', related: { toolId: 'tool-1' }, cancel: {} }]);
	const claude = claudeEvents({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'todo', name: 'TodoWrite', input: { todos: [{ content: 'Read', status: 'completed' }, { content: 'Build', status: 'in_progress' }, { content: 'Skip', status: 'cancelled' }] } }] } });
	assert.deepEqual(claude.find(event => event.type === 'plan')?.steps.map(step => step.status), ['done', 'inProgress', 'cancelled']);
});

test('notification actions, progress and plans reject executable URLs, invalid values and ambiguous state', () => {
	assert.throws(() => richNotice({ text: 'Notice', level: 'fatal' }), /level/);
	assert.throws(() => richNotice({ text: 'Notice', actions: [{ label: 'Run', kind: 'link', url: 'command:evil' }] }), /HTTP/);
	assert.throws(() => richNotice({ text: 'Notice', actions: [{ label: 'Run', kind: 'shell', text: 'rm' }] }), /kind/);
	for (const percent of [-1, 101, NaN, '50']) { assert.throws(() => richProgress({ id: 'job', percent }), /percent/); }
	assert.equal(richProgress({ id: 'job', percent: null }).percent, null);
	assert.throws(() => richPlan({ id: 'plan', steps: [{ id: 'one', text: 'A', status: 'pending' }, { id: 'one', text: 'B', status: 'done' }] }), /unique/);
	assert.throws(() => richPlan({ id: 'plan', steps: [{ text: 'A', status: 'inProgress' }, { text: 'B', status: 'inProgress' }] }), /Only one/);
});

test('citations bind exact UTF-16 ranges and validate file, URL and message targets', () => {
	const text = '🐈 A **cat** sits here.';
	const citation = richCitations([{ quote: '**cat**', target: { type: 'url', url: 'https://example.com' } }], text)[0];
	assert.equal(text.slice(citation.start, citation.end), '**cat**');
	assert.throws(() => richCitations([{ quote: 'cat', target: { type: 'url', url: 'javascript:alert(1)' } }], text), /HTTP/);
	assert.throws(() => richCitations([{ quote: 'cat', target: { type: 'file', path: 'relative', line: 0 } }], text), /absolute/);
	assert.throws(() => richCitations([{ quote: 'cat', target: { type: 'message' } }], text), /requires/);
	assert.throws(() => richCitations([{ quote: 'cat', target: { type: 'url', url: 'https://example.com' } }], 'cat cat'), /exactly once/);
	assert.equal(richCitations([{ start: 4, end: 7, target: { type: 'file', path: '/tmp/a.ts', line: 12 } }], 'cat cat')[0].end, 7);
});

test('native dynamic image results and multiple text blocks retain their typed data', () => {
	const events = codexEvents('item/completed', { item: { type: 'dynamicToolCall', id: 'dynamic', success: true, contentItems: [{ type: 'inputText', text: 'Image' }, { type: 'inputImage', imageUrl: `data:image/gif;base64,${gif}` }] } });
	const blocks = events[0].type === 'toolUpdate' ? events[0].update.blocks : [];
	assert.deepEqual(blocks, [{ type: 'text', text: 'Image' }, { type: 'image', mimeType: 'image/gif', base64: gif }]);
	const texts = codexEvents('item/completed', { item: { type: 'mcpToolCall', id: 'texts', result: { content: [{ type: 'text', text: 'One' }, { type: 'text', text: 'Two' }] } } });
	assert.equal(texts[0].type === 'toolUpdate' && texts[0].update.blocks?.length, 2);
	assert.throws(() => richCitations([{ start: 1, end: 2, target: { type: 'url', url: 'https://example.com' } }], '🐈'), /range/);
	assert.throws(() => richNotice({ text: 'Reveal', actions: [{ label: 'Show', kind: 'reveal' }] }), /target/);
});
