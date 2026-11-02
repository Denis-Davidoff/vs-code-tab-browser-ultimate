import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { codexEvents } from './agentProtocol.ts';
import { CodexShells } from './codexShells.ts';

const startup = { type: 'commandExecution', id: 'server', command: '/bin/zsh -lc "npm run dev"', cwd: '/project',
	processId: '6761', source: 'unifiedExecStartup', status: 'inProgress', commandActions: [] };

test('unified exec retains its process identity and never completes an inProgress command', () => {
	const shells = new CodexShells(codexEvents);
	const start = shells.events('item/started', { threadId: 'thread', item: startup });
	assert.ok(start[0].type === 'tool');
	assert.equal(start[0].tool.kind, 'command');
	assert.deepEqual(start[0].tool.shell, { provider: 'codex', processId: '6761' });
	const yielded = shells.events('item/completed', { threadId: 'thread', item: { ...startup, aggregatedOutput: 'Ready\n', exitCode: null } });
	assert.equal(yielded.length, 1);
	assert.ok(yielded[0].type === 'toolUpdate');
	assert.equal(yielded[0].update.status, undefined);
	assert.equal(yielded[0].update.shell?.background, true);
});

test('write_stdin interactions update the existing command and append only new output', () => {
	const shells = new CodexShells(codexEvents);
	shells.events('item/started', { threadId: 'thread', item: startup });
	const read = { ...startup, id: 'read', source: 'unifiedExecInteraction', command: '', status: 'inProgress' };
	assert.deepEqual(shells.events('item/started', { threadId: 'thread', item: read }), []);
	assert.deepEqual(shells.events('item/commandExecution/outputDelta', { threadId: 'thread', itemId: 'read', delta: 'Request\n' }),
		[{ type: 'toolUpdate', id: 'server', update: { output: 'Request\n', append: true } }]);
	const yielded = shells.events('item/completed', { threadId: 'thread', item: { ...read, status: 'completed', exitCode: null, aggregatedOutput: 'Request\n' } });
	assert.ok(yielded[0].type === 'toolUpdate');
	assert.equal(yielded[0].id, 'server');
	assert.equal(yielded[0].update.output, undefined, 'streamed bytes must not be appended again');
	assert.equal(yielded[0].update.status, undefined);
	const exit = shells.events('item/completed', { threadId: 'thread', item: { ...read, exitCode: 0, status: 'completed', aggregatedOutput: 'Stopped\n' } });
	assert.ok(exit[0].type === 'toolUpdate');
	assert.equal(exit[0].id, 'server');
	assert.equal(exit[0].update.status, 'done');
	assert.equal(exit[0].update.append, true);
	assert.equal(exit[0].update.shell?.background, false);
});

test('native terminalInteraction binds the process without making a second command row', () => {
	const shells = new CodexShells(codexEvents);
	shells.events('item/started', { threadId: 'thread', item: { ...startup, processId: null } });
	assert.deepEqual(shells.events('item/commandExecution/terminalInteraction', { threadId: 'thread', itemId: 'server', processId: '6761', stdin: '' }),
		[{ type: 'toolUpdate', id: 'server', update: { shell: { provider: 'codex', processId: '6761', background: true } } }]);
	assert.deepEqual(shells.events('item/started', { threadId: 'thread', item: { ...startup, id: 'read', source: 'unifiedExecInteraction' } }), []);
});

test('process identities are scoped to threads, and a reused process id starts a new command after exit', () => {
	const shells = new CodexShells(codexEvents);
	shells.events('item/started', { threadId: 'a', item: startup });
	const b = shells.events('item/started', { threadId: 'b', item: { ...startup, id: 'other', source: 'unifiedExecInteraction' } });
	assert.ok(b[0].type === 'tool' && b[0].id === 'other');
	shells.events('item/completed', { threadId: 'a', item: { ...startup, status: 'completed', exitCode: 0 } });
	const next = shells.events('item/started', { threadId: 'a', item: { ...startup, id: 'next' } });
	assert.ok(next[0].type === 'tool' && next[0].id === 'next');
});

test('a completion without a start restores a command row before applying its result', () => {
	const shells = new CodexShells(codexEvents);
	const events = shells.events('item/completed', { threadId: 'a', item: { ...startup, status: 'failed', exitCode: 1, aggregatedOutput: 'Error\n' } });
	assert.equal(events.length, 2);
	assert.ok(events[0].type === 'tool' && events[0].id === 'server');
	assert.ok(events[1].type === 'toolUpdate' && events[1].update.status === 'failed');
	assert.equal(shells.events('item/completed', { threadId: 'a', item: { ...startup, status: 'failed', exitCode: 1 } }).length, 1);
});

test('non-shell dynamic tools and their arbitrary content are not reinterpreted as commands', () => {
	const shells = new CodexShells(codexEvents);
	const events = shells.events('item/started', { threadId: 'a', item: { type: 'dynamicToolCall', id: 'dynamic', tool: 'exec', arguments: { code: 'tools.exec_command({cmd:"echo data"})' } } });
	assert.ok(events[0].type === 'tool' && events[0].tool.kind === 'mcp');
});
