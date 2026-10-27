import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { ChatAgent, ChatTabSummary, TerminalTabSummary } from '../src/chat/chatProtocol';
import { conversationNeeded, frontStripId, lastOutput, shouldFocusComposer, stripTabs, terminalAddition, terminalCloseText, terminalStripTab, terminalTabShown, terminalTabTitle, visibleTerminalFront, withPendingTitle } from './terminalTabs.ts';

const terminal = (over: Partial<TerminalTabSummary> = {}): TerminalTabSummary => ({ id: 't1', name: 'zsh', cwd: '/work', status: 'running', ...over });
const chat = (id: string): ChatTabSummary => ({ id, chatId: `c-${id}`, title: id, running: false, agents: 0, skillRuns: 0, busy: false, queued: 0 });
const agent = (id: string): ChatAgent => ({ id, name: id === 'claude' ? 'Claude Code' : 'Codex' }) as unknown as ChatAgent;

test('a terminal is given to the strip as a tab, carrying itself', () => {
	const tab = terminalStripTab(terminal());
	assert.equal(tab.id, 't1');
	assert.equal(tab.title, 'zsh');
	assert.equal(tab.terminal?.cwd, '/work');
	assert.equal(tab.busy, true, 'closing a running shell asks first');
	assert.equal(terminalStripTab(terminal({ status: 'exited', exitCode: 0 })).busy, false);
	assert.equal(terminalStripTab(terminal({ status: 'exited' })).running, false);
});

test('the strip is the conversations, then the terminals', () => {
	const state = { tabs: [chat('a'), chat('b')], terminals: [terminal({ id: 't1' }), terminal({ id: 't2' })] };
	assert.deepEqual(stripTabs(state).map(t => t.id), ['a', 'b', 't1', 't2']);
	assert.deepEqual(stripTabs({ tabs: [chat('a')] }).map(t => t.id), ['a'], 'a state with no terminals is the conversations');
	assert.equal(stripTabs({ tabs: [chat('a')] })[0].terminal, undefined);
});

test('the front tab is the terminal in front, else the conversation', () => {
	const base = { activeTab: 'a', terminals: [terminal({ id: 't1' })] };
	assert.equal(frontStripId({ ...base, terminalFront: 't1' }), 't1');
	assert.equal(frontStripId(base), 'a');
	assert.equal(frontStripId({ ...base, terminalFront: 'gone' }), 'a', 'an id the list does not hold is no terminal');
	assert.equal(frontStripId({ activeTab: 'a', terminalFront: 't1' }), 'a');
});

test('the tab is refilled only when what it shows changes', () => {
	assert.equal(terminalTabShown(terminal()), terminalTabShown(terminal()));
	assert.notEqual(terminalTabShown(terminal()), terminalTabShown(terminal({ name: 'build' })));
	assert.notEqual(terminalTabShown(terminal()), terminalTabShown(terminal({ status: 'exited', exitCode: 1 })));
});

test('the tooltip names the state and the folder', () => {
	assert.equal(terminalTabTitle(terminal()), 'zsh\nRunning\n/work');
	assert.equal(terminalTabTitle(terminal({ status: 'exited', exitCode: 2, agent: 'claude' }), 'Claude Code'), 'zsh — Claude Code\nThe process ended with code 2\n/work');
	assert.match(terminalTabTitle(terminal({ status: 'exited' })), /The process ended\n/);
	assert.match(terminalCloseText(terminal()), /still running.*the shell/);
	assert.match(terminalCloseText(terminal({ agent: 'codex' })), /the agent/);
});

test('"New terminal" is not offered where there is no terminal support, and says why where it cannot work', () => {
	assert.deepEqual(terminalAddition(undefined, 0), { kind: 'hidden' });
	assert.deepEqual(terminalAddition({ available: false, reason: 'Not in a remote window.' }, 0), { kind: 'off', reason: 'Not in a remote window.' });
	assert.deepEqual(terminalAddition({ available: true, limit: 2, agents: [] }, 1), { kind: 'on', agents: [] });
	const full = terminalAddition({ available: true, limit: 2, agents: [] }, 2);
	assert.equal(full.kind, 'off');
	assert.match(full.kind === 'off' ? full.reason : '', /2 terminals are open/);
	const one = terminalAddition({ available: true, limit: 1, agents: [] }, 1);
	assert.equal(one.kind, 'off');
	assert.equal(one.kind === 'off' ? one.reason : '', '1 terminal is open — close one first.');
});

test('only the agents the host lists, and the view knows, are offered, in the host\'s order', () => {
	const offer = terminalAddition({ available: true, limit: 8, agents: ['codex', 'claude', 'gemini'] }, 0, [agent('claude'), agent('codex')]);
	assert.equal(offer.kind, 'on');
	assert.deepEqual(offer.kind === 'on' ? offer.agents.map(a => a.id) : [], ['codex', 'claude']);
});

test('the last output of a screen joins wrapped rows, drops trailing blank lines and takes the end', () => {
	const rows = [
		{ text: 'one', wrapped: false },
		{ text: 'two part 1 ', wrapped: false },
		{ text: 'part 2', wrapped: true },
		{ text: 'three   ', wrapped: false },
		{ text: '', wrapped: false },
		{ text: '   ', wrapped: false },
	];
	assert.equal(lastOutput(rows, 60), 'one\ntwo part 1 part 2\nthree');
	assert.equal(lastOutput(rows, 2), 'two part 1 part 2\nthree');
	assert.equal(lastOutput([], 10), '');
	assert.equal(lastOutput([{ text: 'x'.repeat(50), wrapped: false }], 10, 20), 'x'.repeat(20));
	assert.equal(lastOutput([{ text: 'a', wrapped: true }], 10), 'a', 'a wrapped first row has nothing to join to');
});

test('a pending Chrome pairing request puts the conversation in front, and the terminal comes back once it is answered', () => {
	const base = { activeTab: 'a', terminals: [terminal({ id: 't1' })], terminalFront: 't1' };
	assert.equal(conversationNeeded(base), false);
	assert.equal(visibleTerminalFront(base), 't1');
	const asking = { ...base, chromeConnectionRequest: { id: 'r1', extensionId: 'abc' } };
	assert.equal(conversationNeeded(asking), true);
	assert.equal(visibleTerminalFront(asking), undefined, 'the Allow / Deny banner is in the column a terminal hides');
	assert.equal(frontStripId(asking), 'a', 'and the strip says so too');
	assert.equal(frontStripId({ ...asking, chromeConnectionRequest: undefined }), 't1');
	// A blocked chat is not a reason to hide a terminal.
	assert.equal(visibleTerminalFront({ ...base, blocked: 'Restricted Mode' } as typeof base), 't1');
	assert.equal(visibleTerminalFront({ terminalFront: 'gone', terminals: [terminal({ id: 't1' })] }), undefined);
});

test('a composer focus that found a terminal in front is applied at the state that takes the terminal away, and never over one that stays', () => {
	const terminals = [terminal({ id: 't1' })];
	assert.equal(shouldFocusComposer(true, { terminals, terminalFront: 't1' }), false, 'the terminal stays in front: it keeps the keyboard');
	assert.equal(shouldFocusComposer(true, { terminals }), true, 'a conversation is in front now');
	assert.equal(shouldFocusComposer(true, { terminals, terminalFront: 'gone' }), true);
	assert.equal(shouldFocusComposer(false, { terminals }), false, 'nothing was asked');
	assert.equal(shouldFocusComposer(true, { terminals, terminalFront: 't1', chromeConnectionRequest: { id: 'r', extensionId: 'e' } }), true);
});

test('a renamed terminal shows its new name at once: the name is the terminal\'s, not the strip tab\'s title', () => {
	const tab = terminalStripTab(terminal({ name: 'zsh' }));
	const renamed = withPendingTitle(tab, 'Build');
	assert.equal(renamed.title, 'Build');
	assert.equal(renamed.terminal?.name, 'Build');
	assert.equal(renamed.terminal?.cwd, '/work', 'the rest of the terminal is kept');
	assert.equal(tab.terminal?.name, 'zsh', 'the original is not changed');
	// What the label is refilled from changes, so the new name is drawn.
	assert.notEqual(terminalTabShown(renamed.terminal!), terminalTabShown(tab.terminal!));
	assert.match(terminalTabTitle(renamed.terminal!), /^Build\n/);
	// A conversation's tab only has its title.
	const conversation = withPendingTitle(chat('a'), 'New name');
	assert.equal(conversation.title, 'New name');
	assert.equal('terminal' in conversation, false);
});

test('the marks of a terminal are in the label it is refilled from, so a mark that changes is drawn', () => {
	const base = terminalTabShown(terminal());
	const owner = { tabId: 'a', title: 'Fix tests', agent: 'claude' as const };
	assert.notEqual(terminalTabShown(terminal({ unread: true })), base);
	assert.notEqual(terminalTabShown(terminal({ pinnedBy: owner })), base);
	assert.notEqual(terminalTabShown(terminal({ pinnedBy: owner, agentControl: 'paused' })), terminalTabShown(terminal({ pinnedBy: owner, agentControl: 'allowed' })));
	assert.notEqual(terminalTabShown(terminal({ pinnedBy: owner, agentActive: true })), terminalTabShown(terminal({ pinnedBy: owner })));
	assert.equal(terminalTabShown(terminal({ pinnedBy: owner })), terminalTabShown(terminal({ pinnedBy: { ...owner } })), 'an equal summary is the same label');
});

test('the tooltip of a pinned terminal names who uses it, and says when its input is paused', () => {
	const owner = { tabId: 'a', title: 'Fix tests' };
	assert.equal(terminalTabTitle(terminal({ pinnedBy: owner }), undefined, 'Claude Code'), 'zsh\nRunning\n/work\nUsed by Claude Code · Fix tests');
	assert.equal(terminalTabTitle(terminal({ pinnedBy: owner }), undefined), 'zsh\nRunning\n/work\nUsed by Fix tests');
	assert.match(terminalTabTitle(terminal({ pinnedBy: owner, agentControl: 'paused' })), /\(its input is paused\)$/);
});
