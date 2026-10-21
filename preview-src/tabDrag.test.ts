import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseChatTabTransfer } from './tabDrag.ts';

test('cross-view drags contain identities only and reject malformed payloads', () => {
	assert.deepEqual(parseChatTabTransfer(JSON.stringify({ source: 'view-1', id: 'tab-1', token: 'opaque', draft: 'must not be imported' })),
		{ source: 'view-1', id: 'tab-1', token: 'opaque' });
	for (const value of ['', 'null', '[]', '{}', '{"source":"x","id":"y","token":3}', 'x'.repeat(2048)]) {
		assert.equal(parseChatTabTransfer(value), undefined);
	}
});


test('releasing a dragged tab outside only clears drag state and never requests a new editor', async () => {
	const { readFileSync } = await import('node:fs');
	const { runInNewContext } = await import('node:vm');
	const { transpileModule } = await import('typescript');
	const source = readFileSync('preview-src/chat.ts', 'utf8');
	const body = /function makeTabDraggable\([\s\S]*?\n\}/.exec(source)![0];
	const handlers = new Map<string, (event: unknown) => void>();
	const messages: unknown[] = [];
	const context = { draggedChatTab: { id: 'moving', draft: 'keep' }, chatTabDragEnded: 0,
		performance: { now: () => 123 }, clearTabDropMarks() {}, post(message: unknown) { messages.push(message); } };
	const attach = runInNewContext(transpileModule(body + '\nmakeTabDraggable;', {}).outputText, context);
	attach({ root: { addEventListener(name: string, handler: (event: unknown) => void) { handlers.set(name, handler); }, classList: { remove() {} } } });
	handlers.get('dragend')!({ clientX: -500, clientY: -500, screenX: 100, screenY: 100, dataTransfer: { dropEffect: 'none' } });
	assert.deepEqual(messages, []);
	assert.equal(context.draggedChatTab, undefined);
	assert.equal(context.chatTabDragEnded, 123);
});

test('tab reordering uses vertical midpoints in the sidebar and horizontal midpoints in the top strip', async () => {
	const { readFileSync } = await import('node:fs');
	const { runInNewContext } = await import('node:vm');
	const { transpileModule } = await import('typescript');
	const source = readFileSync('preview-src/chat.ts', 'utf8');
	const helper = /function tabDropAfter\([\s\S]*?\n\}/.exec(source)![0];
	const wideChat = { matches: false };
	const dropAfter = runInNewContext(transpileModule(helper + '\ntabDropAfter;', {}).outputText, { wideChat });
	const rect = { left: 0, top: 100, width: 240, height: 40 };
	const nearBottom = { clientX: 10, clientY: 135 };
	const nearRight = { clientX: 230, clientY: 105 };
	assert.equal(dropAfter(nearBottom, rect), false);
	assert.equal(dropAfter(nearRight, rect), true);
	wideChat.matches = true;
	assert.equal(dropAfter(nearBottom, rect), true);
	assert.equal(dropAfter(nearRight, rect), false);
});
