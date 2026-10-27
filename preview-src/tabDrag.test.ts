import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseChatTabTransfer } from './tabDrag.ts';
import { conversationBadge } from './chatTerminal.ts';

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

test('compact tab metadata retains identity and reports status and capped agent counts', async () => {
	const { readFileSync } = await import('node:fs');
	const { runInNewContext } = await import('node:vm');
	const { transpileModule } = await import('typescript');
	const source = readFileSync('preview-src/chat.ts', 'utf8');
	const body = /function fillTab\([\s\S]*?\n\}/.exec(source)![0];
	const element = (_tag: string, props: { class?: string; text?: string; [key: string]: unknown } = {}, ...children: unknown[]) => ({
		...props, children, attributes: {} as Record<string, string>,
		setAttribute(name: string, value: string) { this.attributes[name] = value; },
		removeAttribute(name: string) { delete this.attributes[name]; },
	});
	const fill = runInNewContext(transpileModule(body + '\nfillTab;', {}).outputText, {
		el: element, icon: (name: string) => element('i', { icon: name }),
		tabMark: (status: string) => element('span', { status }),
		tabMarks: { working: 'Working', waiting: 'Waiting', read: 'Finished', unread: 'Unread', failed: 'Failed' },
		agentsOf: (t: { agents: number; skillRuns: number }) => t.agents + t.skillRuns,
		conversationBadge,
	});
	for (const status of ['working', 'waiting', 'read', 'unread', 'failed']) {
		const children: ReturnType<typeof element>[] = [];
		const label = { title: '', setAttribute() {}, replaceChildren(...nodes: typeof children) { children.push(...nodes); } };
		const tab = { title: 'A named task', status, agents: 101, skillRuns: 3 };
		fill({ tab, label, close: {}, compactNumber: 7 }, 'Claude');
		assert.equal(children[0].class, `tab-compact status-${status}`);
		assert.equal((children[0].children[0] as { text: string }).text, '7');
		assert.equal(children.at(-1)?.text, '99+');
		assert.match(label.title, /A named task — Claude/);
		assert.match(label.title, /104 agents running/);
	}
});

test('a conversation tab with pinned terminals shows their count and says which in its tooltip; one without shows nothing', async () => {
	const { readFileSync } = await import('node:fs');
	const { runInNewContext } = await import('node:vm');
	const { transpileModule } = await import('typescript');
	const source = readFileSync('preview-src/chat.ts', 'utf8');
	const body = /function fillTab\([\s\S]*?\n\}/.exec(source)![0];
	const element = (_tag: string, props: { class?: string; text?: string; title?: string } = {}, ...children: unknown[]) => ({
		...props, children, attributes: {} as Record<string, string>,
		setAttribute(name: string, value: string) { this.attributes[name] = value; },
		removeAttribute(name: string) { delete this.attributes[name]; },
	});
	const fill = runInNewContext(transpileModule(body + '\nfillTab;', {}).outputText, {
		el: element, icon: (name: string) => element('i', { class: name }),
		tabMark: () => undefined, tabMarks: {}, conversationBadge,
		agentsOf: (t: { agents: number; skillRuns: number }) => t.agents + t.skillRuns,
	});
	const run = (terminals?: { id: string; name: string; status: string }[]) => {
		const children: ReturnType<typeof element>[] = [];
		const label = { title: '', setAttribute() {}, replaceChildren(...nodes: typeof children) { children.push(...nodes); } };
		fill({ tab: { title: 'Fix tests', agents: 0, skillRuns: 0, terminals }, label, close: {}, compactNumber: 1 }, undefined);
		return { children, label };
	};
	const withPins = run([{ id: 't1', name: 'Terminal 2', status: 'running' }, { id: 't2', name: 'build', status: 'exited' }]);
	const badge = withPins.children.find(c => c.class === 'tab-terminals');
	assert.ok(badge, 'the badge is in the label');
	assert.equal(badge.title, '2 terminals pinned: Terminal 2, build');
	assert.equal((badge.children[1] as { text: string }).text, '2');
	assert.match(withPins.label.title, /2 terminals pinned: Terminal 2, build/);
	assert.equal(run().children.some(c => c.class === 'tab-terminals'), false);
	assert.equal(run([]).children.some(c => c.class === 'tab-terminals'), false);
});
