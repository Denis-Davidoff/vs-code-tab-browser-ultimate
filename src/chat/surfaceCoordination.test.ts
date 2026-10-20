import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createSourceFile, isClassDeclaration, ScriptKind, ScriptTarget, transpileModule } from 'typescript';
import { GitAccess } from './gitAccess.ts';
import { readChatPanelIdentity } from './chatPanelState.ts';

function method(file: string, name: string, context: Record<string, unknown> = {}): any {
	const text = readFileSync(file, 'utf8');
	const ast = createSourceFile(file, text, ScriptTarget.ES2022, true, ScriptKind.TS);
	const member = ast.statements.filter(isClassDeclaration).flatMap(c => [...c.members]).find(m => m.name?.getText(ast) === name);
	assert.ok(member, name);
	return runInNewContext(transpileModule(`(() => { class Subject { ${member.getText(ast)} } return Subject.prototype['${name}']; })()`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, context);
}
const viewFile = 'src/chat/chatView.ts';

test('a busy agent in another surface blocks same-worktree Git mutations', async () => {
	const idle = { _tabs: [{ busy: false, chat: { id: 'idle' }, cwd: '/repo' }], _repoBusy: new Map() };
	const busy = { _tabs: [{ busy: true, chat: { id: 'working' }, cwd: '/repo/subdir' }], _repoBusy: new Map() };
	const host = { _services: { views: new Set([idle, busy]) }, _runs: { runningIn: () => 0 } };
	const folders = method(viewFile, '_busyGitFolders').call(host);
	assert.deepEqual(Array.from(folders), ['/repo/subdir']);
	const git = new GitAccess(async () => 'git:/repo/.git');
	await assert.rejects(git.mutate('/repo', () => folders), /Wait for agents/);
	busy._tabs[0].busy = false;
	const release = await git.mutate('/repo', () => []);
	try { await assert.rejects(git.launch('/repo/subdir', () => true, () => assert.fail('must not launch during a shared mutation')), /Git is updating/); }
	finally { release(); }
});

test('project command refreshes keep independent lists and throttles even when responses arrive out of order', async () => {
	const pending = new Map<string, (commands: any[]) => void>();
	const requested: [string, boolean][] = [];
	const backend = { commands(cwd: string, ownSettings: boolean) { requested.push([cwd, ownSettings]); return new Promise<any[]>(resolve => pending.set(cwd, resolve)); } };
	let changes = 0;
	const host: any = { _backends: new Map([['codex', { backend }]]), _agents: [{ id: 'codex', available: true }],
		_commandLists: new Map(), _commandsAsked: new Map(), _onDidChange: { fire() { changes++; } } };
	const refresh = method('src/chat/agents.ts', 'refreshCommands');
	const commandsFor = method('src/chat/agents.ts', 'commandsFor');
	const a = refresh.call(host, 'codex', '/A', true), b = refresh.call(host, 'codex', '/B', false);
	pending.get('/B')!([{ name: 'B-only' }]); await b;
	pending.get('/A')!([{ name: 'A-only' }]); await a;
	assert.equal(commandsFor.call(host, '/A').codex[0].name, 'A-only');
	assert.equal(commandsFor.call(host, '/B').codex[0].name, 'B-only');
	await refresh.call(host, 'codex', '/B', false);
	assert.deepEqual(requested, [['/A', true], ['/B', false]]);
	assert.equal(changes, 2);
});

function catalog(storage: any): any {
	const source = readFileSync('src/chat/chatPanelCatalog.ts', 'utf8').replace(/^import .*\n/gm, '').replaceAll('export ', '');
	const Type = runInNewContext(transpileModule(`${source}\nChatPanelCatalog;`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, { readChatPanelIdentity });
	return new Type(storage);
}

test('hidden panel identities, drafts and allocation high-water survive cold start', () => {
	const values = new Map<string, any>();
	const storage = { get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, JSON.parse(JSON.stringify(value))); } };
	const first = catalog(storage);
	const hidden = { id: 'abcdef01-1234-4567-8901-abcdef012345', number: 7 };
	const closed = { id: 'abcdef02-1234-4567-8901-abcdef012345', number: 8 };
	first.remember(hidden, { conversation: 'unsent text' });
	first.remember(closed, {}); first.forget(closed.id);
	const restarted = catalog(storage);
	assert.equal(restarted.highWater, 8);
	assert.equal(restarted.panels.get(hidden.id).drafts.conversation, 'unsent text');
	assert.equal(restarted.panels.has(closed.id), false);
});

test('pending panels own their conversations before any serializer is invoked', async () => {
	const identity = { id: 'abcdef01-1234-4567-8901-abcdef012345', number: 7 };
	const surfaces = new Map<string, any>();
	let constructed = 0;
	class Pending {
		_panelIdentity = identity;
		_surfaceNumber = 7;
		_tabs = [{ id: 'tab', chat: { id: 'conversation' } }];
		_savedDrafts = new Map([['conversation', 'private draft']]);
		constructor(..._args: unknown[]) { constructed++; surfaces.set('pending', this); }
		_bindPanel() {}
	}
	const context = { ChatViewProvider: Pending, readChatPanelIdentity };
	const main: any = { _tabs: [], _pendingPanels: new Map(), _services: { panels: { panels: new Map([[identity.id, { panel: identity }]]) }, views: new Set() } };
	method(viewFile, '_restorePendingPanels', context).call(main);
	const pending = main._pendingPanels.get(identity.id);
	main._services.views.add(pending);
	const find = method(viewFile, '_findOpenChat', { ChatViewProvider: { _surfaces: surfaces } });
	assert.equal(find.call(main, 'conversation').surface, pending);
	const readDraft = method(viewFile, '_readTabDraft');
	assert.equal(await readDraft.call(pending, pending._tabs[0]), 'private draft');
	method(viewFile, 'restoreChatPanel', context).call(main, {}, { panel: identity });
	assert.equal(constructed, 1, 'serializer must reuse the reserved owner');
});

test('moving an idle chat during queue debounce reschedules and sends in the already-ready destination', async () => {
	const timers = new Map<number, () => void>();
	let nextTimer = 0, sent = 0;
	const context = { setTimeout: (fn: () => void) => { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout: (id: number) => timers.delete(id), tabLimit: () => 20 };
	const tab = { id: 'queued', chat: { id: 'conversation' }, attachments: [], readyForQueued: true,
		dequeue() { this.readyForQueued = false; return { text: 'queued message', attachments: [] }; }, moveTo(_host: unknown) {} };
	const sibling = { id: 'other', chat: { id: 'other' } };
	const services = {};
	const surface = (tabs: any[]) => ({ _tabs: tabs, _active: tabs[0], _services: services, _view: {}, _registry: {}, _repoBusy: new Map(),
		_gitCommits: new Map(), _draining: new Map(), _chatSkillTabs: new Map(), _annotationLinks: new Map(), _livePages: new Map(), _savedDrafts: new Map(),
		_post() {}, _saveTabs() {}, _state() { return {}; }, _postMessage() {}, _fail(error: Error) { throw error; },
		_send: async (text: string) => { assert.equal(text, 'queued message'); sent++; } });
	const from: any = surface([tab, sibling]), to: any = surface([sibling]);
	from._canMoveTab = method(viewFile, '_canMoveTab', context);
	from._drainQueues = to._drainQueues = method(viewFile, '_drainQueues', context);
	from._drainQueues();
	assert.equal(timers.size, 1);
	assert.equal(method(viewFile, '_moveTabInto', context).call(from, tab, to, ''), true);
	assert.equal(timers.size, 1, 'source timer is replaced by a destination timer');
	for (const [id, fire] of [...timers]) { timers.delete(id); fire(); }
	await Promise.resolve(); await Promise.resolve();
	assert.equal(sent, 1);
	assert.equal(tab.readyForQueued, false);
});
