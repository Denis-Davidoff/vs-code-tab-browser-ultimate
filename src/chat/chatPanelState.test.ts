import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule, ScriptTarget } from 'typescript';
import { readChatPanelIdentity } from './chatPanelState.ts';

const panel = { id: 'abcdef01-1234-4567-8901-abcdef012345', number: 4 };
test('panel identity round-trips and rejects invalid persisted data', () => {
	assert.deepEqual(readChatPanelIdentity(JSON.parse(JSON.stringify({ panel }))), panel);
	for (const state of [null, {}, { panel: {} }, { panel: { ...panel, id: '../sidebar' } }, { panel: { ...panel, number: 1 } }, { panel: { ...panel, number: 2.5 } }]) {
		assert.equal(readChatPanelIdentity(state), undefined);
	}
});

function production(name: string, context: Record<string, unknown>) {
	const source = readFileSync('src/chat/chatView.ts', 'utf8');
	const body = new RegExp(`\\tprivate ${name}\\([\\s\\S]*?\\n\\t\\}`).exec(source)![0].replace(`private ${name}`, `function ${name}`);
	return runInNewContext(transpileModule(`${body}\n${name};`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, context);
}

function storage() {
	const values = new Map<string, any>();
	const stored = { id: 'started', title: 'Working chat', agent: 'codex', folder: '/project', entries: ['message'] };
	class Tab {
		id: string;
		started: boolean;
		chat: any;
		constructor(_host: unknown, chat: any) { this.chat = chat; this.id = chat.id; this.started = !!chat.entries.length; }
	}
	let next = 0;
	const context = { ChatTab: Tab, reopened: (chat: any) => ({ ...chat }), newChat: (agent: string, id?: string) => ({ id: id ?? `new-${++next}`, agent, entries: [] }),
		tabLimit: () => 20, path: { isAbsolute }, capAt: (s: string, limit: number) => s.slice(0, limit), tabTitleLimit: 80,
		ChatViewProvider: { _surfaces: new Map<string, any>() } };
	const restore = production('_restoreTabs', context), save = production('_saveTabs', context), find = production('_findOpenChat', context);
	const host = (key: string) => {
		const view: any = { _tabsStorageKey: key, _tabs: [], _remembered: { agent: 'codex' }, _tabsSaved: '', _history: () => [stored],
			_context: { workspaceState: { get: (k: string) => values.get(k), update: (k: string, v: any) => { values.set(k, v); return Promise.resolve(); } } } };
		view._findOpenChat = find;
		return view;
	};
	return { values, stored, Tab, host, save, restore, surfaces: context.ChatViewProvider._surfaces };
}

test('panel tabs restore in order with selection, fresh names and folders, independently from sidebar', () => {
	const s = storage();
	const sidebar = s.host('sidebar'), panelView = s.host('panel-4');
	const started = new s.Tab({}, s.stored);
	const fresh = new s.Tab({}, { id: 'fresh', title: 'Next task', named: true, agent: 'codex', folder: '/other', entries: [] });
	panelView._tabs = [started, fresh]; panelView._active = fresh;
	s.save.call(panelView);
	sidebar._tabs = [new s.Tab({}, { id: 'sidebar-fresh', entries: [] })]; sidebar._active = sidebar._tabs[0];
	s.save.call(sidebar);
	const restored = s.host('panel-4');
	s.restore.call(restored);
	assert.deepEqual(restored._tabs.map((tab: any) => tab.chat.id), ['started', 'fresh']);
	assert.equal(restored._active.chat.id, 'fresh');
	assert.equal(restored._active.chat.title, 'Next task');
	assert.equal(restored._active.chat.folder, '/other');
	assert.equal(s.values.get('sidebar').ids[0], 'sidebar-fresh');
});

test('restoration skips conversations already owned by the main chat and repeated ids', () => {
	const s = storage();
	s.surfaces.set('main', { _tabs: [new s.Tab({}, s.stored)] });
	s.values.set('panel-4', { ids: ['started', 'fresh', 'fresh'], fresh: ['fresh'], active: 'started' });
	const restored = s.host('panel-4');
	s.restore.call(restored);
	assert.deepEqual(restored._tabs.map((tab: any) => tab.chat.id), ['fresh']);
	assert.equal(restored._active.chat.id, 'fresh');
});
