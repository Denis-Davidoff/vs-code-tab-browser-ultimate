import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { AttachmentChip, ChatTabSummary, TerminalTabSummary } from '../src/chat/chatProtocol';
import {
	agentControlRow, askAgentRows, chipShown, composerPlaceholder, conversationBadge, conversationRows, conversationShown, isPinChip,
	looksLikeHomeDirectory, pinChipOpenTitle, pinChipStatus, pinRows, pinSummary, shortName, terminalMarks, type AskInput,
} from './chatTerminal.ts';

const terminal = (over: Partial<TerminalTabSummary> = {}): TerminalTabSummary => ({ id: 't1', name: 'Terminal 1', cwd: '/work/app', status: 'running', ...over });
const tab = (id: string, over: Partial<ChatTabSummary> = {}): ChatTabSummary =>
	({ id, chatId: `c-${id}`, title: `Chat ${id}`, running: false, agents: 0, skillRuns: 0, busy: false, queued: 0, ...over });
const agents = [
	{ id: 'claude' as const, name: 'Claude Code', available: true },
	{ id: 'codex' as const, name: 'Codex', available: true },
	{ id: 'gemini' as const, name: 'Gemini CLI', available: false },
];
const input = (over: Partial<AskInput> = {}): AskInput => ({
	terminal: terminal(), agents, tabs: [tab('a'), tab('b')], frontTab: 'a', tabLimit: 10, hasSelection: false, ...over,
});

test('Ask agent: a new chat per available agent, the picked one first, then the open conversations', () => {
	const rows = askAgentRows(input({ defaultAgent: 'codex' }));
	assert.deepEqual(rows.map(r => r.kind), ['new', 'new', 'tab', 'tab']);
	assert.deepEqual(rows.filter(r => r.kind === 'new').map(r => r.label), ['New chat — Codex', 'New chat — Claude Code'], 'an agent that cannot start has no row');
	assert.deepEqual(askAgentRows(input()).filter(r => r.kind === 'new').map(r => r.label), ['New chat — Claude Code', 'New chat — Codex'], 'no pick keeps the host\'s order');
	const first = rows[0];
	assert.ok(first.kind === 'new' && first.agent === 'codex' && !first.disabled);
});

test('Ask agent: where the agent will work is said, and the home folder says it has no project', () => {
	const [claude] = askAgentRows(input());
	assert.equal(claude.description, 'in /work/app');
	const [home] = askAgentRows(input({ terminal: terminal({ cwd: '/Users/m5' }) }));
	assert.match(home.description, /^in \/Users\/m5 — the home folder, so no project rules apply$/);
	const [selected] = askAgentRows(input({ hasSelection: true }));
	assert.match(selected.description, /· with the selected text$/);
});

test('Ask agent: a new chat is disabled at the tab limit, with the reason, and an open conversation still works', () => {
	const rows = askAgentRows(input({ tabLimit: 2 }));
	const news = rows.filter(r => r.kind === 'new');
	assert.ok(news.every(r => r.disabled), 'every new chat is disabled');
	assert.equal(news[0].description, '2 chats are open — close one first');
	assert.equal(askAgentRows(input({ tabs: [tab('a')], tabLimit: 1 })).find(r => r.kind === 'new')?.description, '1 chat is open — close one first');
	assert.ok(rows.filter(r => r.kind === 'tab').length === 2, 'the open conversations stay on offer');
	assert.ok(askAgentRows(input({ tabLimit: 3 })).filter(r => r.kind === 'new').every(r => !r.disabled), 'below the limit it is on');
});

test('Ask agent: with no agent available a disabled row says so, in place of the new chats', () => {
	const rows = askAgentRows(input({ agents: agents.map(a => ({ ...a, available: false })) }));
	assert.equal(rows[0].kind, 'none');
	assert.ok(rows[0].kind === 'none' && rows[0].disabled);
	assert.equal(rows.filter(r => r.kind === 'tab').length, 2);
});

test('Ask agent: a conversation row has its title, agent and state, and the front one is checked', () => {
	const rows = askAgentRows(input({
		tabs: [tab('a', { agent: 'claude', status: 'working', busy: true }), tab('b', { title: 'Docs', agent: 'codex', status: 'waiting' }), tab('c')],
		frontTab: 'b',
	})).filter(r => r.kind === 'tab');
	assert.deepEqual(rows.map(r => [r.label, r.description, r.kind === 'tab' && r.checked]), [
		['Chat a', 'Claude Code · working', false],
		['Docs', 'Codex · waiting for you', true],
		['Chat c', 'New chat · idle', false],
	]);
	assert.deepEqual(rows.map(r => r.icon), ['sync', 'bell', 'comment']);
});

test('Ask agent: the conversation that owns the terminal says so, and another one says it takes it over', () => {
	const owned = terminal({ pinnedBy: { tabId: 'a', title: 'Fix tests' } });
	const rows = askAgentRows(input({ terminal: owned })).filter(r => r.kind === 'tab');
	assert.match(rows[0].description, /already pinned$/);
	assert.match(rows[1].description, /takes it over from «Fix tests»$/);
});

test('home directory shapes', () => {
	for (const home of ['/Users/m5', '/Users/m5/', '/home/denys', '/root', 'C:\\Users\\Denys', 'c:/Users/denys/']) { assert.ok(looksLikeHomeDirectory(home), home); }
	for (const other of ['/Users/m5/dev', '/home', '/Users', '/work/app', 'C:\\Users', '/Users/m5/dev/x/']) { assert.ok(!looksLikeHomeDirectory(other), other); }
});

test('"+" menu: a row per terminal, pinned here or not, and who else uses it', () => {
	const list = [
		terminal({ id: 't1', name: 'Terminal 1', pinnedBy: { tabId: 'a', title: 'Chat a' } }),
		terminal({ id: 't2', name: 'build', status: 'exited' }),
		terminal({ id: 't3', name: 'logs', pinnedBy: { tabId: 'b', title: 'Docs' } }),
	];
	const rows = pinRows(list, 'a');
	assert.deepEqual(rows.map(r => r.pinned), [true, false, false]);
	assert.equal(rows[0].description, 'running · /work/app');
	assert.equal(rows[1].description, 'ended');
	assert.equal(rows[2].description, 'running · /work/app · used by «Docs» — pinning moves it here');
	assert.equal(pinSummary(list, 'a'), '1 pinned to this chat');
	assert.equal(pinSummary(list, 'c'), 'Let the agent read and type in a terminal');
	assert.deepEqual(pinRows([], 'a'), []);
});

test('marks: unread, typing and who uses a terminal, with the reason in the tooltip', () => {
	assert.deepEqual(terminalMarks(terminal()), [], 'a plain terminal has no mark');
	assert.deepEqual(terminalMarks(terminal({ unread: true })).map(m => m.kind), ['unread']);
	const used = terminal({ pinnedBy: { tabId: 'a', title: 'Fix tests', agent: 'claude' } });
	assert.deepEqual(terminalMarks(used, 'Claude Code'), [{ kind: 'pinned', title: 'Used by Claude Code · Fix tests' }]);
	assert.deepEqual(terminalMarks({ ...used, agentActive: true, unread: true }, 'Claude Code').map(m => m.kind), ['unread', 'typing', 'pinned']);
	assert.equal(terminalMarks({ ...used, agentActive: true }, 'Claude Code')[0].title, 'Claude Code · Fix tests is typing here');
	assert.equal(terminalMarks(used)[0].title, 'Used by Fix tests', 'without the agent\'s name only the conversation is named');
});

test('marks: paused replaces pinned and stops the typing mark; a stale agentActive without an owner is nothing', () => {
	const paused = terminal({ pinnedBy: { tabId: 'a', title: 'Fix tests' }, agentControl: 'paused', agentActive: true });
	assert.deepEqual(terminalMarks(paused).map(m => m.kind), ['paused']);
	assert.match(terminalMarks(paused)[0].title, /its input is paused$/);
	assert.deepEqual(terminalMarks(terminal({ agentActive: true })), []);
});

test('the pause row follows the state and exists only while a conversation uses the terminal', () => {
	assert.equal(agentControlRow(terminal()), undefined);
	const pause = agentControlRow(terminal({ pinnedBy: { tabId: 'a', title: 'x' } }));
	assert.deepEqual([pause?.label, pause?.allowed], ['Pause agent input', false]);
	const resume = agentControlRow(terminal({ pinnedBy: { tabId: 'a', title: 'x' }, agentControl: 'paused' }));
	assert.deepEqual([resume?.label, resume?.allowed], ['Resume agent input', true]);
});

test('a conversation tab shows a count of its pinned terminals, and nothing without any', () => {
	assert.equal(conversationBadge(tab('a')), undefined);
	assert.equal(conversationBadge(tab('a', { terminals: [] })), undefined);
	assert.deepEqual(conversationBadge(tab('a', { terminals: [{ id: 't1', name: 'Terminal 2', status: 'running' }] })),
		{ count: 1, title: 'Terminal 2 is pinned — the agent can read and type there' });
	const many = conversationBadge(tab('a', { terminals: ['a', 'b', 'c', 'd', 'e'].map(n => ({ id: n, name: n, status: 'running' as const })) }));
	assert.equal(many?.count, 5);
	assert.equal(many?.title, '5 terminals pinned: a, b, c and 2 more');
});

test('a conversation tab has a Go to and an Unpin row per pinned terminal', () => {
	assert.deepEqual(conversationRows(tab('a')), []);
	const rows = conversationRows(tab('a', { terminals: [{ id: 't1', name: 'zsh', status: 'running' }, { id: 't2', name: 'old', status: 'exited' }] }));
	assert.deepEqual(rows.map(r => [r.kind, r.id, r.label]), [
		['go', 't1', 'Go to «zsh»'], ['unpin', 't1', 'Unpin «zsh»'],
		['go', 't2', 'Go to «old» (ended)'], ['unpin', 't2', 'Unpin «old» (ended)'],
	]);
});

test('the tab label is refilled when its terminals change, not otherwise', () => {
	const a = tab('a', { terminals: [{ id: 't1', name: 'zsh', status: 'running' }] });
	assert.equal(conversationShown(a), conversationShown(tab('a', { terminals: [{ id: 't1', name: 'zsh', status: 'running' }] })));
	assert.notEqual(conversationShown(a), conversationShown(tab('a')));
	assert.notEqual(conversationShown(a), conversationShown(tab('a', { terminals: [{ id: 't1', name: 'zsh', status: 'exited' }] })));
	assert.notEqual(conversationShown(a), conversationShown(tab('a', { terminals: [{ id: 't1', name: 'build', status: 'running' }] })));
});

test('the composer asks about the pinned terminal, and keeps its own text without one', () => {
	const base = 'Start typing here…';
	assert.equal(composerPlaceholder(base, undefined), base);
	assert.equal(composerPlaceholder(base, tab('a')), base);
	assert.equal(composerPlaceholder(base, tab('a', { terminals: [] })), base);
	const one = { id: 't1', name: 'Terminal 2', status: 'running' as const };
	assert.equal(composerPlaceholder(base, tab('a', { terminals: [one] })), 'Ask about «Terminal 2»…');
	assert.equal(composerPlaceholder(base, tab('a', { terminals: [one, { ...one, id: 't2', name: 'logs' }] })), 'Ask about «Terminal 2» and «logs»…');
	assert.equal(composerPlaceholder(base, tab('a', { terminals: [one, { ...one, id: 't2' }, { ...one, id: 't3' }] })), 'Ask about «Terminal 2» and 2 more terminals…');
});

test('a name chosen by the user is one short line', () => {
	assert.equal(shortName('  a\n b\t c  '), 'a b c');
	assert.equal(shortName('x'.repeat(60)).length, 40);
	assert.ok(shortName('x'.repeat(60)).endsWith('…'));
	assert.equal(shortName('short'), 'short');
});

test('the pinned chip: recognised by its pin, drawn from its status, rebuilt when that changes', () => {
	const chip = (over: Partial<AttachmentChip> = {}): AttachmentChip => ({ id: 'pin:t1', kind: 'terminal', label: 'Terminal 1', pinned: true, terminalId: 't1', terminalStatus: 'running', ...over }) as AttachmentChip;
	assert.ok(isPinChip(chip()));
	assert.ok(!isPinChip(chip({ pinned: undefined })), 'a terminal chip that is not a pin is an ordinary one');
	assert.ok(!isPinChip(chip({ terminalId: undefined })));
	assert.ok(!isPinChip({ id: 'x', kind: 'file', label: 'a.ts' } as AttachmentChip));
	assert.equal(pinChipStatus(chip()), 'running');
	assert.equal(pinChipStatus(chip({ terminalStatus: 'exited' })), 'exited');
	assert.equal(pinChipStatus(chip({ terminalStatus: undefined })), 'running');
	assert.equal(pinChipOpenTitle(chip()), 'Go to Terminal 1');
	assert.equal(pinChipOpenTitle(chip({ terminalStatus: 'closed' })), 'Terminal 1 was closed');
	assert.deepEqual(chipShown(chip()), chipShown(chip()));
	assert.notDeepEqual(chipShown(chip()), chipShown(chip({ terminalStatus: 'exited' })));
	assert.notDeepEqual(chipShown(chip()), chipShown(chip({ label: 'build' })));
});
