import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule, ScriptTarget } from 'typescript';

function method(name: string, context: Record<string, unknown> = {}) {
	const source = readFileSync('src/chat/chatView.ts', 'utf8');
	const text = new RegExp(`\\tprivate (?:async )?${name}\\([\\s\\S]*?\\n\\t\\}`).exec(source)![0].replace(/private (async )?/, '$1function ');
	return runInNewContext(transpileModule(`${text}\n${name};`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, context);
}

test('reordering moves the same tab objects and keeps the active conversation', () => {
	const tabs = ['a', 'b', 'c'].map(id => ({ id }));
	const host = { _tabs: [...tabs], _active: tabs[1], _post() {} };
	const place = method('_placeTab');
	place.call(host, 'a', 'c', true);
	assert.deepEqual(host._tabs.map(t => t.id), ['b', 'c', 'a']);
	place.call(host, 'a', 'b', false);
	assert.deepEqual(host._tabs, tabs);
	place.call(host, 'missing', 'b', true);
	place.call(host, 'b', 'b', true);
	assert.deepEqual(host._tabs, tabs);
	assert.equal(host._active, tabs[1]);
});

async function transfer(fail = false, location: 'tab' | 'window' = 'tab', commandFails = false) {
	const calls: string[] = [];
	const session = { running: true };
	const tab = { id: 'moving', chat: { id: 'conversation', title: 'My chat' }, session, attachments: [{ chip: { id: 'attached' } }],
		moveTo(host: unknown) { calls.push('move'); Object.assign(this, { host }); }, close() { assert.fail('moving must not close the session'); } };
	const source: any = { _tabs: [tab], _active: tab, _remembered: { agent: 'codex' },
		_registry: {}, _runs: {}, _services: {}, _savedDrafts: new Map(), _livePages: new Map(), _repoBusy: new Map(), _gitCommits: new Map(), _windows: new Set(), _childChats: new Set(),
		_draining: new Map(), _chatSkillTabs: new Map([['skill', [{ tab }]]]), _annotationLinks: new Map(),
		_post() { calls.push('post'); }, _saveTabs() { calls.push('save'); }, _fail() { calls.push('error'); } };
	let child: any;
	let closed: (() => void) | undefined;
	class Destination {
		_tabs: unknown[];
		_tabHost = {};
		_view = {};
		_services: unknown;
		_chatSkillTabs = new Map();
		_annotationLinks = new Map();
		_livePages = new Map();
		_savedDrafts = new Map();
		_drainQueues() {}
		messages: any[] = [];
		constructor(...args: any[]) { child = this; this._tabs = [args[5].tab]; this._services = args[5].services; assert.equal(args[5].services, source._services); }
		_bindView() { if (fail) { throw new Error('failed to create view'); } }
		_postMessage(message: any) { this.messages.push(message); }
		_post() {}
		_saveTabs() {}
		_state() { return {}; }
		dispose() { for (const t of this._tabs as any[]) { t.close(); } }
	}
	class Empty { id = 'empty'; constructor(..._args: unknown[]) {} }
	const context = { ChatViewProvider: Destination, ChatTab: Empty, newChat: () => ({}), clearTimeout,
		vscode: { commands: { async getCommands() { return ['workbench.action.moveEditorToNewWindow']; }, async executeCommand() { calls.push('window'); if (commandFails) { throw new Error('window failed'); } } }, ViewColumn: { Active: -1 }, window: { createWebviewPanel: () => ({ webview: {}, visible: true, reveal() {},
			onDidDispose(listener: () => void) { closed = listener; }, onDidChangeViewState() {}, dispose() { closed?.(); } }) } }, tabLimit: () => 10 };
	source._canMoveTab = method('_canMoveTab', context);
	source._moveTabInto = method('_moveTabInto', context);
	const detach = method('_detachTab', context);
	await detach.call(source, tab.id, 'unsent draft', location);
	return { source, child, tab, session, calls };
}

test('context menu transfer preserves live session, attachments, draft and skill tracking', async () => {
	const { source, child, tab, session, calls } = await transfer();
	assert.equal(child._tabs[0], tab);
	assert.equal(tab.session, session);
	assert.equal(session.running, true);
	assert.equal(tab.attachments[0].chip.id, 'attached');
	assert.equal(child.messages[0].type, 'state');
	assert.equal(child.messages[1].text, 'unsent draft');
	assert.equal(child._chatSkillTabs.get('skill')[0].tab, tab);
	assert.equal(source._tabs.length, 1);
	assert.equal(source._active.id, 'empty');
	assert.equal(source._chatSkillTabs.size, 0);
	assert.ok(calls.includes('save'));
});

test('failed setup leaves the source tab and live session intact', async () => {
	const { source, tab, session, calls } = await transfer(true);
	assert.equal(source._tabs[0], tab);
	assert.equal(session.running, true);
	assert.equal(calls.includes('move'), false);
	assert.ok(calls.includes('error'));
});

test('closing a previous surface keeps shared backends until the last moved chat closes', () => {
	const source = readFileSync('src/chat/chatView.ts', 'utf8');
	const body = /\tpublic dispose\(\): void \{[\s\S]*?\n\t\}/.exec(source)![0].replace('public dispose', 'function dispose');
	const dispose = runInNewContext(transpileModule(`${body}\ndispose;`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, { clearTimeout, ChatViewProvider: { _surfaces: new Map() } });
	let backendDisposals = 0, runDisposals = 0, tabCloses = 0;
	const services = { views: new Set<unknown>(), panels: { forget() {} } };
	const surface = () => ({ _windows: new Set(), _pendingPanels: new Map(), _titleRequests: new Map(), _branchNameRequests: new Map(), _gitCommits: new Map(),
		_stateSurfaces: { dispose() {} },
		_sleep: { dispose() {} }, _draftRequests: new Map(), _livePages: new Map(), _voiceCancel() {}, _detachedChat: {}, _panelIdentity: {}, _saveTabs() {}, _services: services,
		_runs: { dispose() { runDisposals++; } }, _registry: { dispose() { backendDisposals++; } },
		_usageChecks: new Map(), _draining: new Map(), _tabs: [{ close() { tabCloses++; } }], _subscriptions: [],
	});
	const previous = surface(), moved = surface();
	services.views.add(previous); services.views.add(moved);
	dispose.call(previous);
	assert.equal(backendDisposals, 0);
	assert.equal(runDisposals, 0);
	assert.equal(tabCloses, 1);
	dispose.call(moved);
	assert.equal(backendDisposals, 1);
	assert.equal(runDisposals, 1);
	assert.equal(tabCloses, 2);
	dispose.call(moved);
	assert.equal(backendDisposals, 1);
});

function existingViews(limit = 10) {
	const messages: any[] = [], errors: string[] = [];
	const services = {};
	const live = { id: 'live', chat: { id: 'chat-live' }, attachments: [], session: { running: true }, moveTo(_host: unknown) {}, close() { assert.fail('must keep live session'); } };
	const old = { id: 'old', chat: { id: 'chat-old' } };
	const sibling = { id: 'sibling', chat: { id: 'chat-sibling' } };
	const source: any = { _tabs: [live, sibling], _active: live, _services: services, _savedDrafts: new Map(), _registry: {}, _repoBusy: new Map(), _gitCommits: new Map(),
		_draining: new Map(), _chatSkillTabs: new Map(), _annotationLinks: new Map(), _livePages: new Map(), _post() {}, _saveTabs() {}, _dragToken: 'secret' };
	const target: any = { _tabs: [old], _active: old, _services: services, _savedDrafts: new Map(), _drainQueues() {}, _view: {}, _tabHost: {}, _chatSkillTabs: new Map(),
		_annotationLinks: new Map(), _livePages: new Map(), _post() {}, _saveTabs() {},
		_state() { return { chatId: this._active.chat.id }; }, _postMessage(message: any) { messages.push(message); } };
	const surfaces = new Map([['source', source], ['target', target]]);
	const context = { clearTimeout, tabLimit: () => limit, ChatViewProvider: { _surfaces: surfaces },
		refuse: (message: string) => errors.push(message), vscode: { l10n: { t: (text: string) => text } } };
	source._canMoveTab = method('_canMoveTab', context);
	source._moveTabInto = method('_moveTabInto', context);
	const accept = method('_acceptTabDrop', context);
	return { source, target, live, old, sibling, messages, errors, accept: (token: string) => accept.call(target, 'source', live.id, token) };
}

test('moving into an existing chat keeps its old tabs and selects the live transferred tab before restoring draft', () => {
	const { source, target, live, old, sibling, messages } = existingViews();
	assert.equal(source._moveTabInto(live, target, 'draft'), true);
	assert.deepEqual(source._tabs, [sibling]);
	assert.deepEqual(target._tabs, [old, live]);
	assert.equal(target._active, live);
	assert.equal(live.session.running, true);
	assert.equal(messages[0].type, 'state');
	assert.equal(messages[0].state.chatId, live.chat.id);
	assert.equal(messages[1].text, 'draft');
});

test('full or closed destinations leave the source session untouched', () => {
	const s = existingViews(1);
	assert.equal(s.source._moveTabInto(s.live, s.target, ''), false);
	assert.equal(s.source._tabs[0], s.live);
	assert.equal(s.errors.length, 1);
	s.target._disposed = true;
	assert.equal(s.source._moveTabInto(s.live, s.target, ''), false);
	assert.equal(s.live.session.running, true);
});

test('cross-view drop validates source, token, age and original conversation', () => {
	const s = existingViews();
	s.source._tabDrag = { id: s.live.id, chatId: s.live.chat.id, at: Date.now(), draft: 'private draft' };
	s.accept('wrong');
	assert.equal(s.source._tabs[0], s.live);
	s.source._tabDrag.at = Date.now() - 120_001;
	s.accept('secret');
	assert.equal(s.source._tabs[0], s.live);
	s.source._tabDrag.at = Date.now();
	s.source._tabDrag.chatId = 'replaced';
	s.accept('secret');
	assert.equal(s.source._tabs[0], s.live);
	s.source._tabDrag.chatId = s.live.chat.id;
	s.accept('secret');
	assert.equal(s.target._active, s.live);
	assert.equal(s.source._tabDrag, undefined);
	assert.equal(s.messages[1].text, 'private draft');
});

test('surface names distinguish sidebar and editor chat panels', () => {
	const label = method('_surfaceLabel');
	assert.equal(label.call({ _panel: undefined }), 'AI Browser (sidebar)');
	assert.equal(label.call({ _panel: {}, _panelIdentity: {}, _surfaceNumber: 4, _active: { chat: { title: 'Fix login' } } }), 'AI Browser #4');
});


test('moving the last chat closes its source panel only after destination has the live chat and draft', () => {
	const s = existingViews();
	s.source._tabs = [s.live];
	let closed = false;
	s.source._panelIdentity = {};
	s.source._closeEmptyPanel = () => s.source._panel.dispose();
	s.source._panel = { dispose() {
		closed = true;
		assert.equal(s.source._tabs.length, 0);
		assert.equal(s.target._active, s.live);
		assert.equal(s.messages[1].type, 'setTabDraft');
	} };
	assert.equal(s.source._moveTabInto(s.live, s.target, 'keep this'), true);
	assert.equal(closed, true);
	assert.equal(s.live.session.running, true);
});

test('a failed transfer never closes the source panel', () => {
	const s = existingViews(1);
	s.source._tabs = [s.live];
	s.source._panel = { dispose() { assert.fail('failed transfer must leave source open'); } };
	assert.equal(s.source._moveTabInto(s.live, s.target, ''), false);
	assert.equal(s.source._tabs[0], s.live);
});

test('history opening switches to the existing owner instead of duplicating a chat', () => {
	const calls: string[] = [];
	const tab = { id: 'other-tab', chat: { id: 'conversation' } };
	const owner = { _tabs: [tab], _selectTab(id: string) { calls.push(id); }, async _focusView() { calls.push('focus'); } };
	const host: any = { _panelIdentity: {}, _tabs: [], _history() { assert.fail('must not reopen history'); } };
	const context = { ChatViewProvider: { _terminalSessions: new Map(), _surfaces: new Map([['owner', owner]]) } };
	host._findOpenChat = method('_findOpenChat', context);
	method('_openChat', context).call(host, tab.chat.id);
	assert.deepEqual(calls, ['other-tab', 'focus']);
	assert.equal(host._tabs.length, 0);
});


test('the main sidebar offers to move a history chat here instead of switching windows', () => {
	const tab = { id: 'other-tab', chat: { id: 'conversation' } };
	const owner = { _tabs: [tab], _surfaceLabel: () => 'AI Browser #2', _selectTab() { assert.fail('must ask before switching'); } };
	const messages: any[] = [];
	const host: any = { _tabs: [], _postMessage(message: any) { messages.push(message); } };
	const context = { ChatViewProvider: { _terminalSessions: new Map(), _surfaces: new Map([['owner', owner]]) } };
	host._findOpenChat = method('_findOpenChat', context);
	method('_openChat', context).call(host, tab.chat.id);
	assert.equal(messages[0].type, 'historyChatOpen');
	assert.equal(messages[0].source, 'AI Browser #2');
	assert.equal(host._tabs.length, 0);
});

test('accepting Move here reads the source draft and transfers the existing session', async () => {
	const tab = { id: 'tab', chat: { id: 'chat' } };
	const calls: string[] = [];
	const owner = { async _readTabDraft(t: unknown) { assert.equal(t, tab); return 'unsent'; },
		_moveTabInto(t: unknown, destination: unknown, draft: string) { assert.equal(t, tab); assert.equal(destination, host); calls.push(draft); return true; } };
	const host = { _findOpenChat: () => ({ surface: owner, tab }), async _focusView() { calls.push('focus main'); } };
	await method('_resolveHistoryChat').call(host, 'chat', 'move');
	assert.deepEqual(calls, ['unsent', 'focus main']);
});


test('moving to a new window moves the editor before transferring the live chat', async () => {
	const { child, tab, calls } = await transfer(false, 'window');
	assert.equal(child._tabs[0], tab);
	assert.ok(calls.indexOf('window') < calls.indexOf('move'));
});

test('failed window creation keeps the live chat in the source', async () => {
	const { source, tab, calls } = await transfer(false, 'window', true);
	assert.equal(source._tabs[0], tab);
	assert.equal(calls.includes('move'), false);
	assert.ok(calls.includes('error'));
});

for (const agent of ['claude', 'codex', 'gemini']) {
	test(`terminal handoff resumes ${agent} without shell interpolation and prevents duplicates`, async () => {
		let options: any;
		let onClose: ((t: unknown) => void) | undefined;
		let disposed = false;
		let shows = 0;
		let closes = 0;
		const terminals = new Map();
		const terminal = { show() { shows++; } };
		const chat = { id: 'chat', agent, title: 'Task', ref: 'session-id', folder: '/task folder' };
		const host: any = {
			_blocked: () => undefined, _untrusted: () => false,
			_history: () => [chat], _windowCwd: () => '/fallback',
			_registry: { agents: [{ id: agent, binary: '/cli path/agent' }] },
			_runs: { runningIn: () => 0 },
			_closeTab() { closes++; },
		};
		const tab = { id: 'tab', chat, cwd: '/task folder', busy: false, queuedCount: 0 };
		host._findOpenChat = () => ({ tab, surface: host });
		const resume = method('_resumeInTerminal', {
			ChatViewProvider: { _terminalSessions: terminals }, isAgentId: () => true, JsonLineProcess: { stopped: async () => undefined },
			agentNames: { [agent]: agent }, geminiPath: () => '/cli path',
			fs: { existsSync: () => true, statSync: () => ({ isDirectory: () => true }) },
			vscode: { TerminalLocation: { Editor: 2 }, ThemeIcon: class {}, l10n: { t: (s: string) => s },
				window: { createTerminal(o: unknown) { options = o; return terminal; },
					onDidCloseTerminal(fn: (t: unknown) => void) { onClose = fn; return { dispose() { disposed = true; } }; },
					showInformationMessage() {}, showWarningMessage() {} } },
		});
		tab.busy = true;
		await resume.call(host, 'chat');
		assert.equal(Boolean(options), false);
		tab.busy = false;
		await resume.call(host, 'chat');
		assert.equal(options.cwd, '/task folder');
		assert.equal(options.shellPath, '/cli path/agent');
		assert.deepEqual(Array.from(options.shellArgs), agent === 'codex' ? ['resume', 'session-id'] : ['--resume', 'session-id']);
		assert.equal(options.location, 2);
		assert.equal(options.env.CLAUDECODE, null);
		assert.equal(closes, 1);
		await resume.call(host, 'chat');
		assert.equal(closes, 1);
		assert.equal(shows, 2);
		onClose?.(terminal);
		assert.equal(terminals.size, 0);
		assert.equal(disposed, true);
		// The history entry works even when no chat tab is open.
		host._findOpenChat = () => undefined;
		await resume.call(host, 'chat');
		assert.equal(options.cwd, '/task folder');
		assert.equal(closes, 1);
	});
}

test('a conversation owned by a terminal cannot be reopened in chat', () => {
	let shown = false;
	const context = { ChatViewProvider: { _terminalSessions: new Map([['chat', { show() { shown = true; } }]]) },
		vscode: { l10n: { t: (s: string) => s }, window: { showInformationMessage() {} } } };
	method('_openChat', context).call({ _findOpenChat() { assert.fail('must not reopen'); } }, 'chat');
	assert.equal(shown, true);
});


test('Chrome open attaches the returned new tab instead of pages discovered while connecting', async () => {
	const oldPage = { url: 'https://private.test' }, newPage = { url: 'about:blank' };
	const chat = { attachments: [] as any[] }, otherChat = { attachments: [] as any[] };
	let disposed = false;
	const host: any = { _active: chat, _tabs: [chat, otherChat], _pendingOpen: { dispose() { disposed = true; } },
		_awaitOpenedPage() { assert.fail('Chrome must not attach the first discovered page'); },
		_pageAttachment(page: unknown) { return { page, chip: { id: 'attachment' } }; },
		_trackLivePage(_id: string, page: unknown) { assert.equal(page, newPage); }, _post() {},
	};
	const open = method('_openBrowser', {
		tabSource: { all: [oldPage, newPage] }, generateUuid: () => 'attachment',
		vscode: { commands: { async executeCommand(command: string) {
			assert.equal(command, 'aiBrowser.openInChrome'); host._active = otherChat; return newPage;
		} } },
	});
	await open.call(host, 'chrome');
	assert.equal(disposed, true);
	assert.equal(chat.attachments[0].page, newPage);
	assert.equal(otherChat.attachments.length, 0);
});

test('Chrome attachments use the browser visibility check with a text editor active', async () => {
	const page = { title: 'Chrome', url: 'https://example.test' };
	const attach = method('_makeAttachment', {
		tabSource: { available: () => true }, generateUuid: () => 'attachment',
		refuse() { assert.fail('visible Chrome must not be refused'); }, confirm() {},
		pageTitle: (title: string) => title, plainInPrompt: (text: string) => text,
		pickElementContext: async (tab: unknown) => { assert.equal(tab, page); return 'Element: Button'; },
		vscode: { l10n: { t: (s: string) => s }, window: { tabGroups: { all: [{ activeTab: { input: {} } }] } } },
	});
	let annotations = 0;
	const host = { _browser: { userTab: page, focusedTab: undefined,
		onScreen(tab: unknown) { assert.equal(tab, page); return true; },
		async capture(_full: boolean, tab: unknown) { assert.equal(tab, page); return { png: { toString: () => 'png' }, url: page.url }; },
		annotationsOf: () => undefined, async annotateTab(tab: unknown) { assert.equal(tab, page); annotations++; },
	} };
	assert.equal((await attach.call(host, 'screenshot')).chip.thumbnail, 'data:image/png;base64,png');
	assert.equal((await attach.call(host, 'element')).text, 'Element: Button');
	await attach.call(host, 'annotation');
	assert.equal(annotations, 1);
});

test('a blocked Codex terminal handoff leaves the chat open and can be retried after other work finishes', async () => {
	let released = false, closes = 0, terminals = 0;
	const chat = { id: 'chat', agent: 'codex', title: 'Task', ref: 'thread', folder: '/task' };
	const host: any = { _blocked: () => undefined, _untrusted: () => false,
		_registry: { agents: [{ id: 'codex', binary: '/codex' }], backend: () => ({ release: async () => released }) },
		_runs: { runningIn: () => 0 }, _closeTab() { closes++; },
	};
	host._findOpenChat = () => ({ tab: { id: 'tab', chat, cwd: '/task', busy: false, queuedCount: 0 }, surface: host });
	const resume = method('_resumeInTerminal', {
		ChatViewProvider: { _terminalSessions: new Map() }, isAgentId: () => true,
		JsonLineProcess: { stopped: async () => undefined }, agentNames: { codex: 'Codex' }, geminiPath: () => '/bin',
		fs: { existsSync: () => true, statSync: () => ({ isDirectory: () => true }) },
		vscode: { TerminalLocation: { Editor: 2 }, ThemeIcon: class {}, l10n: { t: (s: string) => s }, window: {
			showInformationMessage() {}, createTerminal() { terminals++; return { show() {} }; },
			onDidCloseTerminal() { return { dispose() {} }; },
		} },
	});
	await resume.call(host, 'chat');
	assert.equal(closes, 0); assert.equal(terminals, 0);
	released = true;
	await resume.call(host, 'chat');
	assert.equal(closes, 1); assert.equal(terminals, 1);
});


test('explicit Share Tab chooses the user Chrome tab even without a native focused tab', async () => {
	const source = readFileSync('src/extension.ts', 'utf8');
	const body = /const share = async \(target: ShareTarget\) => \{[\s\S]*?\n\t\};/.exec(source)![0];
	const page = { url: 'https://chrome.test' };
	let assigned: unknown;
	const share = runInNewContext(transpileModule(`${body}\nshare;`, {
		compilerOptions: { target: ScriptTarget.ES2022 },
	}).outputText, {
		tabSource: { available: () => true }, browser: { focusedTab: undefined, userTab: page,
			async shareTab(tab: unknown, target: unknown) { assert.equal(tab, page); assigned = target; return { label: 'Codex', url: page.url }; },
		}, vscode: { l10n: { t: (s: string) => s } }, plainInLabel: (s: string) => s, confirm() {},
		refuse() { assert.fail('Chrome tab must be shareable'); },
	});
	const target = { kind: 'codex' };
	await share(target);
	assert.equal(assigned, target);
});


test('waiting for a native tab ignores Chrome pages discovered in the meantime', () => {
	let listener: (page: any) => void = () => {};
	const chrome = { chrome: true }, native = { chrome: false };
	const chat = { attachments: [] as any[] };
	let unsubscribed = false;
	class Disposable {
		private readonly fn: () => void;
		constructor(fn: () => void) { this.fn = fn; }
		dispose() { this.fn(); }
	}
	const wait = method('_awaitOpenedPage', {
		tabSource: { isChrome: (page: any) => page.chrome, onDidOpen(fn: (page: any) => void) {
			listener = fn; return { dispose() { unsubscribed = true; } };
		} }, vscode: { Disposable }, setTimeout: () => 1, clearTimeout() {}, livePageWaitMs: 100,
		generateUuid: () => 'attachment',
	});
	const host = { _pendingOpen: undefined, _tabs: [chat], _active: chat,
		_pageAttachment(page: unknown) { return { page, chip: { id: 'attachment' } }; },
		_trackLivePage() {}, _post() {},
	};
	wait.call(host, chat);
	listener(chrome);
	assert.equal(chat.attachments.length, 0); assert.equal(unsubscribed, false);
	listener(native);
	assert.equal(chat.attachments[0].page, native); assert.equal(unsubscribed, true);
});
