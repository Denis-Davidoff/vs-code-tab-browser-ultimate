import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { messageFileDiff, messageFileLabel, messageFiles } from './messageFiles.ts';
import { codexEvents, geminiEvents } from './agentProtocol.ts';
import { diffSides, hunkGap } from './diffSides.ts';
import type { ChatEntry, ToolEntry } from './chatProtocol';

const edit = (over: Partial<ToolEntry> = {}): ToolEntry => ({
	kind: 'tool', tool: 'edit', id: 'edit', name: 'Edit', status: 'done', startedAt: 0, ...over,
});

test('message file paths are relative inside the project and absolute outside it', () => {
	assert.equal(messageFileLabel('/work/project/src/a.ts', '/work/project'), 'src/a.ts');
	assert.equal(messageFileLabel('src/a.ts', '/work/project'), 'src/a.ts');
	assert.equal(messageFileLabel('../global.json', '/work/project'), '/work/global.json');
	assert.equal(messageFileLabel('/work/project-other/a.ts', '/work/project'), '/work/project-other/a.ts');
	assert.equal(messageFileLabel('/etc/config', '/work/project'), '/etc/config');
	assert.equal(messageFileLabel('C:\\Work\\Project\\src\\a.ts', 'c:\\work\\project'), 'src/a.ts');
	assert.equal(messageFileLabel('..\\global.json', 'C:\\Work\\Project'), 'C:/Work/global.json');
	assert.equal(messageFileLabel('/src/a.ts', '/'), 'src/a.ts');
});

test('file diffs contain only the selected file and successful operations in this turn', () => {
	const entries = [
		edit({ input: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-other\n+unrelated', files: [{ path: 'a.ts', status: 'modified' }, { path: 'b.ts', status: 'modified' }] }),
		edit({ detail: 'a.ts', input: '-new\n+final' }),
		edit({ detail: 'a.ts', input: '-final\n+failed', status: 'failed' }),
		edit({ detail: 'a.ts', input: '-final\n+another turn' }),
	];
	const diff = messageFileDiff(entries, [0, 1, 2], 'a.ts')!;
	assert.match(diff, /-old\n\+new/);
	assert.match(diff, /-new\n\+final/);
	assert.doesNotMatch(diff, /unrelated|failed|another turn|b\.ts/);
});

test('apply_patch diffs strip control markers and exclude other files', () => {
	const input = '*** Begin Patch\n*** Update File: a.ts\n@@\n-before\n+after\n*** Add File: b.ts\n+new\n*** End Patch';
	const entries = [edit({ tool: 'mcp', input: JSON.stringify({ patch: input }) })];
	assert.equal(messageFileDiff(entries, [0], 'a.ts'), '@@\n-before\n+after');
	assert.equal(messageFileDiff(entries, [0], 'b.ts'), '+new');
	assert.equal(messageFileDiff(entries, [0], 'missing.ts'), undefined);
	const rename = [edit({ tool: 'mcp', input: '*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n@@\n-before\n+after\n*** End Patch' })];
	assert.equal(messageFileDiff(rename, [0], 'new.ts'), '@@\n-before\n+after');
});

test('Codex multi-file changes keep their boundaries for opening individual diffs', () => {
	const event = codexEvents('item/completed', { item: { type: 'fileChange', id: 'files', status: 'completed', changes: [
		{ path: 'a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new' },
		{ path: 'b.ts', kind: { type: 'delete' }, diff: 'deleted content' },
	] } })[0];
	assert.equal(event.type, 'toolUpdate');
	if (event.type !== 'toolUpdate') { return; }
	const entries = [edit({ input: event.update.input, files: event.update.files })];
	assert.equal(messageFileDiff(entries, [0], 'a.ts'), '@@ -1 +1 @@\n-old\n+new');
	assert.equal(messageFileDiff(entries, [0], 'b.ts'), '-deleted content');
});

test('Codex aggregate diffs omit file headers after a completed hunk', () => {
	const event = codexEvents('item/completed', { item: { type: 'fileChange', id: 'files', status: 'completed', changes: [
		{ path: 'a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-oldA\n+newA' },
		{ path: 'b.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-oldB\n+newB' },
	] } })[0];
	assert.ok(event.type === 'toolUpdate');
	assert.deepEqual(diffSides(event.update.input!), { before: `oldA\n${hunkGap}\noldB`, after: `newA\n${hunkGap}\nnewB` });
});

test('Gemini creation metadata survives tool starts and updates into file history', () => {
	for (const sessionUpdate of ['tool_call', 'tool_call_update']) {
		for (const oldText of [null, '']) {
			const event = geminiEvents({ sessionUpdate, toolCallId: 'write', status: 'completed', kind: 'edit',
				locations: [{ path: '/w/x.txt' }], content: [{ type: 'diff', path: '/w/x.txt', oldText, newText: 'one\ntwo\n',
					_meta: { kind: oldText === null ? 'add' : 'modify' } }],
			})[0];
			assert.ok(event.type === 'tool' || event.type === 'toolUpdate');
			const data = event.type === 'tool' ? event.tool : event.update;
			const entry = edit({ input: data.input, files: data.files, added: data.added, removed: data.removed });
			assert.deepEqual(messageFiles([entry], [0]), [{ path: '/w/x.txt', status: oldText === null ? 'created' : 'modified', added: 2, removed: 0, entry: 0 }]);
		}
	}
});

test('Gemini deletion updates retain the deleted status in file history', () => {
	const event = geminiEvents({ sessionUpdate: 'tool_call_update', toolCallId: 'delete', status: 'completed', kind: 'delete',
		content: [{ type: 'diff', path: '/w/x.txt', oldText: 'gone\n', newText: '' }],
	})[0];
	assert.ok(event.type === 'toolUpdate');
	assert.deepEqual(messageFiles([edit({ input: event.update.input, files: event.update.files })], [0]), [{ path: '/w/x.txt', status: 'deleted', added: 0, removed: 1, entry: 0 }]);
});

test('message files are scoped to their turn, exclude unsuccessful work and accumulate repeated edits', () => {
	const entries: ChatEntry[] = [
		edit({ files: [{ path: './a.ts', status: 'created', added: 4, removed: 0 }] }),
		edit({ files: [{ path: 'a.ts', status: 'modified', added: 2, removed: 1 }] }),
		edit({ detail: 'failed.ts', status: 'failed' }),
		edit({ detail: 'running.ts', status: 'running' }),
		edit({ detail: 'later.ts', added: 1, removed: 0 }),
	];
	assert.deepEqual(messageFiles(entries, [0, 1, 2, 3]), [{ path: 'a.ts', status: 'created', added: 6, removed: 1, entry: 1 }]);
	assert.equal(messageFiles(entries, [4])[0].path, 'later.ts');
});

test('Codex retains every file and individual counts, even when the displayed diff is truncated', () => {
	const event = codexEvents('item/completed', { item: { type: 'fileChange', id: 'files', status: 'completed', changes: [
		{ path: 'new.txt', kind: { type: 'add' }, diff: 'hello\nworld\n' },
		{ path: 'old.txt', kind: { type: 'delete' }, diff: 'gone\n' },
		{ path: 'edit.txt', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new' },
	] } })[0];
	assert.equal(event.type, 'toolUpdate');
	if (event.type !== 'toolUpdate') { return; }
	const tool = edit({ files: event.update.files, input: 'truncated history' });
	const files = messageFiles([JSON.parse(JSON.stringify(tool))], [0]);
	assert.deepEqual(files.map(({ entry, ...file }) => file), [
		{ path: 'new.txt', status: 'created', added: 2, removed: 0 },
		{ path: 'old.txt', status: 'deleted', added: 0, removed: 1 },
		{ path: 'edit.txt', status: 'modified', added: 1, removed: 1 },
	]);
});

test('older unified diffs recover separate file statuses and per-file counts', () => {
	const input = '--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+new\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n';
	assert.deepEqual(messageFiles([edit({ detail: '2 files', input })], [0]), [
		{ path: 'new.ts', status: 'created', added: 1, removed: 0, entry: 0 },
		{ path: 'gone.ts', status: 'deleted', added: 0, removed: 1, entry: 0 },
	]);
});

test('apply_patch calls expose operations without guessing shell commands or treating empty edits as deletion', () => {
	const input = '*** Begin Patch\n*** Add File: new.ts\n+hello\n*** Update File: src/a.ts\n@@\n-before\n+after\n*** Delete File: gone.ts\n*** End Patch';
	const patch = edit({ tool: 'mcp', input: JSON.stringify({ patch: input }) });
	assert.deepEqual(messageFiles([patch], [0]).map(f => [f.path, f.status, f.added, f.removed]), [
		['new.ts', 'created', 1, 0], ['src/a.ts', 'modified', 1, 1], ['gone.ts', 'deleted', undefined, undefined],
	]);
	assert.deepEqual(messageFiles([edit({ tool: 'command', input: 'rm a.ts' })], [0]), []);
	assert.equal(messageFiles([edit({ detail: 'empty.ts', added: 0, removed: 3 })], [0])[0].status, 'modified');
	assert.equal(messageFiles([edit({ name: 'Write', detail: 'a.ts', output: 'File created successfully at: a.ts', added: 2, removed: 0 })], [0])[0].status, 'created');
});
