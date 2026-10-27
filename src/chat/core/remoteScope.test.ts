import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { remoteGone, remoteScope } from './remoteScope.ts';

test('a remote command is refused in one order: the conversation, the chat itself, then the surface', () => {
	const tab = { chat: { id: 'c' } };
	const view = { tabs: [tab], live: true, blocked: undefined as string | undefined };
	const tabOf = (v: typeof view) => v.live ? v.tabs.find(t => t.chat.id === 'c') : undefined;
	const blocked = (v: typeof view) => v.blocked;
	assert.throws(() => remoteScope('chrome', undefined, tabOf, blocked, undefined), new RegExp(remoteGone.chrome));
	assert.throws(() => remoteScope('exchange', { ...view, live: false }, tabOf, blocked, 'no'), new RegExp(remoteGone.exchange));
	assert.throws(() => remoteScope('chrome', { ...view, blocked: 'Restricted Mode' }, tabOf, blocked, 'no'), /Restricted Mode/);
	assert.throws(() => remoteScope('chrome', view, tabOf, blocked, 'Only in VS Code.'), /Only in VS Code/);
	assert.equal(remoteScope('chrome', view, tabOf, blocked, undefined).tab, tab);
});
