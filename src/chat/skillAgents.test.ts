import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { SkillAgents } from './skillAgents.ts';
import { codexEvents } from './agentProtocol.ts';
import type { AgentEvent } from './agentProtocol.ts';

const agent = (id: string, background = true, parentId?: string): AgentEvent => ({
	type: 'tool', id, tool: { kind: 'agent', name: 'Agent', detail: id, agent: { calls: [], background, parentId, threadId: id } },
});

test('wait for all background children across parent turnEnd, including nested agents', () => {
	const children = new SkillAgents();
	children.observe(agent('one'));
	children.observe(agent('two', true, 'one'));
	children.observe({ type: 'turnEnd' });
	assert.equal(children.running, true);
	children.observe({ type: 'toolUpdate', id: 'one', update: { status: 'done' } });
	assert.equal(children.running, true);
	children.observe({ type: 'agentStates', states: [{ threadId: 'two', status: 'done' }] });
	assert.equal(children.running, false);
	children.observe(agent('two')); // another job on the same Codex thread
	assert.equal(children.running, true);
	children.observe({ type: 'toolUpdate', id: 'two', update: { status: 'done' } });
	assert.equal(children.running, false);
});

test('failed parents settle orphaned children and background shells never block steps', () => {
	const children = new SkillAgents();
	children.observe(agent('one'));
	children.observe(agent('two', true, 'one'));
	children.observe({ type: 'toolUpdate', id: 'one', update: { status: 'failed' } });
	assert.equal(children.running, false);
	children.observe({ type: 'tool', id: 'server', tool: { kind: 'command', name: 'Bash', detail: 'dev server' } });
	children.observe({ type: 'toolUpdate', id: 'server', update: { agent: { background: true } } });
	assert.equal(children.running, false);
});

test('foreground agents end with the parent; failure settles remaining children', () => {
	const children = new SkillAgents();
	children.observe({ type: 'tool', id: 'sync', tool: { kind: 'agent', name: 'Agent' } });
	children.observe({ type: 'turnEnd' });
	assert.equal(children.running, false);
	children.observe(agent('background'));
	children.observe({ type: 'turnEnd', error: 'Stopped.' });
	assert.equal(children.running, false);
});

test('legacy Codex spawn stays active until its own state reports completion', () => {
	const children = new SkillAgents();
	const start = codexEvents('item/started', { item: { type: 'collabAgentToolCall', id: 'call', tool: 'spawnAgent', receiverThreadIds: ['thread'] } });
	assert.equal(start[0]?.type, 'tool');
	if (start[0].type === 'tool') { assert.equal(start[0].tool.agent?.background, true); }
	start.forEach(event => children.observe(event));
	children.observe({ type: 'turnEnd' });
	assert.equal(children.running, true);
	children.observe({ type: 'agentStates', states: [{ threadId: 'thread', status: 'done' }] });
	assert.equal(children.running, false);
	children.observe({ type: 'agentStates', states: [{ threadId: 'thread', status: 'running' }] });
	assert.equal(children.running, true);
	children.observe({ type: 'agentStates', states: [{ threadId: 'thread', status: 'done' }] });
	assert.equal(children.running, false);
});
