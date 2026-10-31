import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { messageContent } from './messageContent.ts';
import type { ChatEntry } from './chatProtocol';

test('content is scoped to the selected message and includes each saved presentation kind', () => {
	const entries: ChatEntry[] = [
		{ kind: 'assistant', text: '', visualizations: [
			{ at: 0, id: 'chart', revision: 'r1', title: 'Revenue chart' },
			...(['image', 'video', 'audio', 'table', 'sources', 'file'] as const).map((kind, i) => ({ at: i + 1, id: kind, revision: kind, kind, title: `${kind} title` })),
		] },
		{ kind: 'assistant', text: '', visualizations: [{ at: 0, id: 'other', title: 'Another turn' }] },
	];
	const items = messageContent(JSON.parse(JSON.stringify(entries)), [0]);
	assert.deepEqual(items.map(i => i.kind), ['visualization', 'image', 'video', 'audio', 'table', 'sources', 'file']);
	assert.equal(items[0].title, 'Revenue chart');
	assert.equal(items[0].referenceAt, 0);
	assert.ok(items.every(i => i.entry === 0));
	assert.ok(items.every(i => !('base64' in i)));
});

test('rich results and tool blocks retain precise block targets and media types', () => {
	const items = messageContent([
		{ kind: 'result', id: 'result', title: 'Report', at: 0, blocks: [
			{ type: 'text', text: 'Ordinary explanation' },
			{ type: 'image', path: '/captures/preview.png' },
			{ type: 'file', name: 'demo.mp4' },
			{ type: 'file', name: 'recording', mimeType: 'audio/wav' },
			{ type: 'json', title: 'Statistics', value: { count: 2 } },
			{ type: 'link', title: 'Published report', url: 'https://example.com' },
		] },
		{ kind: 'tool', tool: 'mcp', name: 'Tool', id: 'tool', status: 'done', startedAt: 0, blocks: [
			{ type: 'file', name: 'report.pdf' },
		] },
	], [0, 1]);
	assert.deepEqual(items.map(i => [i.kind, i.title, i.entry, i.block]), [
		['image', 'preview.png', 0, 1], ['video', 'demo.mp4', 0, 2], ['audio', 'recording', 0, 3],
		['json', 'Statistics', 0, 4], ['link', 'Published report', 0, 5], ['file', 'report.pdf', 1, 0],
	]);
});

test('user attachments include media and documents while omitting page and element context', () => {
	const items = messageContent([{
		kind: 'user', text: 'Review these', attachments: ['@1 Screenshot', '@2 Recording', '@3 Voice', '@4 report.pdf', '@5 Page', '@6 Element'],
		attachmentKinds: ['screenshot', 'video', 'voice', 'file', 'page', 'element'],
		attachmentData: [{ chip: { id: 'screenshot', kind: 'screenshot', label: 'Screenshot' } }],
	}], [0]);
	assert.deepEqual(items.map(i => i.kind), ['image', 'video', 'audio', 'file']);
	assert.equal(items[0].attachmentId, 'screenshot');
	assert.equal(items[3].title, 'report.pdf');
});

test('the same archived card is indexed once, while distinct revisions remain accessible', () => {
	const ref = { at: 0, id: 'chart', title: 'Chart', revision: 'v1' };
	const items = messageContent([
		{ kind: 'assistant', text: '', visualizations: [ref] },
		{ kind: 'result', id: 'r', title: 'Chart', at: 0, blocks: [{ type: 'file', name: 'chart.html', ref }] },
		{ kind: 'assistant', text: '', visualizations: [{ ...ref, revision: 'v2' }] },
	], [0, 1, 2]);
	assert.equal(items.length, 2);
	assert.equal(items[0].entry, 1);
	assert.equal(items[0].block, 0);
	assert.equal(items[1].entry, 2);
});

test('plain messages and presentation syntax quoted in text do not create content cards', () => {
	assert.deepEqual(messageContent([
		{ kind: 'assistant', text: 'Example: image{"path":"/tmp/example.png"}' },
		{ kind: 'thinking', text: 'Planning a chart', startedAt: 0 },
		{ kind: 'result', id: 'r', title: 'Text', at: 0, blocks: [{ type: 'text', text: 'Hello' }] },
	], [0, 1, 2]), []);
});
