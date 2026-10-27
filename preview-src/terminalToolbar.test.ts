import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { agentMarkText } from './terminalToolbar.ts';

const pin = { tabId: 't1', title: 'Fix the build' };

test('the agent mark says who drives the terminal and what it is doing', () => {
	assert.equal(agentMarkText({}), '', 'no pin, no mark');
	assert.equal(agentMarkText({ pinnedBy: pin }), 'Agent · Fix the build');
	assert.equal(agentMarkText({ pinnedBy: pin, agentActive: true }), 'Agent typing · Fix the build');
	assert.equal(agentMarkText({ pinnedBy: pin, agentControl: 'paused' }), 'Agent paused · Fix the build');
	assert.equal(agentMarkText({ pinnedBy: pin, agentControl: 'paused', agentActive: true }), 'Agent paused · Fix the build', 'a paused agent is not typing');
	assert.equal(agentMarkText({ pinnedBy: { tabId: 't', title: '  ' } }), 'Agent · a conversation');
	assert.equal(agentMarkText({ pinnedBy: pin, agentControl: 'allowed' }), 'Agent · Fix the build');
});
