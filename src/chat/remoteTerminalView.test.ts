import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { remoteTerminalReason, remoteTerminalView, type RemoteTerminalGates } from './remoteTerminalView.ts';
import type { TerminalTabSummary } from './chatProtocol.ts';

const open: RemoteTerminalGates = { surface: 'chrome', encrypted: true, setting: true, consent: 'unasked', blocked: false };
const shared: TerminalTabSummary[] = [{ id: 't1', name: 'zsh', cwd: '/Users/me/dev/project', status: 'running', remote: true, pinnedBy: { tabId: 'x', title: 'secret' } }];
const support = () => ({ available: true as const, limit: 8, agents: ['claude' as const], website: { allowed: true as const } });

test('the setting off: the entry stays, disabled, naming the setting both ways', () => {
	for (const surface of ['chrome', 'exchange'] as const) {
		const view = remoteTerminalView({ ...open, surface, setting: false }, () => shared, support);
		assert.deepEqual(view.terminals, []);
		assert.equal(view.terminalSupport.available, false);
		const reason = (view.terminalSupport as { reason: string }).reason;
		assert.match(reason, /AI Browser › Chat: Remote Terminal/);
		assert.match(reason, /aiBrowser\.chat\.remoteTerminal/);
		assert.deepEqual(view.controls.newTerminal, { s: 'off', reason });
	}
});

test('the website needs encryption; Chrome\'s loopback bridge does not', () => {
	assert.match(remoteTerminalReason({ ...open, surface: 'exchange', encrypted: false })!, /encrypted/);
	assert.equal(remoteTerminalReason({ ...open, surface: 'chrome', encrypted: false }), undefined);
});

test('a declined consent and a blocked window each say so', () => {
	assert.match(remoteTerminalReason({ ...open, consent: 'no' })!, /declined/);
	assert.match(remoteTerminalReason({ ...open, blocked: true })!, /not available/);
});

test('on: only shared summaries, the folder by its last segment, no pin and no sharing row', () => {
	const view = remoteTerminalView(open, () => shared, support);
	assert.deepEqual(view.terminals, [{ id: 't1', name: 'zsh', status: 'running', cwd: 'project', remote: true }]);
	assert.deepEqual(view.terminalSupport, { available: true, limit: 8, agents: ['claude'] });
	assert.deepEqual(view.controls, {});
});

test('the two open settings: shell only, agent only, neither', () => {
	const shellOnly = remoteTerminalView({ ...open, openShell: true, openAgent: false }, () => shared, support);
	assert.deepEqual(shellOnly.terminalSupport, { available: true, limit: 8, agents: [] });
	const agentOnly = remoteTerminalView({ ...open, openShell: false, openAgent: true }, () => shared, support);
	assert.deepEqual(agentOnly.terminalSupport, { available: true, limit: 8, agents: ['claude'], shell: false });
	const neither = remoteTerminalView({ ...open, openShell: false, openAgent: false }, () => shared, support);
	assert.equal(neither.terminalSupport.available, false);
	assert.match((neither.terminalSupport as { reason: string }).reason, /remoteTerminalShell.*remoteTerminalAgent/);
	assert.equal(neither.controls.newTerminal?.s, 'off');
	// Already shared terminals stay watchable and manageable.
	assert.equal(neither.terminals.length, 1);
	assert.equal(neither.controls.closeTerminal, undefined);
});
