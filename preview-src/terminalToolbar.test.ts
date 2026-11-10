import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { agentMarkText, rovingIndex, scrollTip, watchTip } from './terminalToolbar.ts';

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

test('arrow keys walk the toolbar and wrap; Home and End jump', () => {
	assert.equal(rovingIndex('ArrowRight', 0, 4), 1);
	assert.equal(rovingIndex('ArrowRight', 3, 4), 0, 'wraps to the first');
	assert.equal(rovingIndex('ArrowLeft', 0, 4), 3, 'wraps to the last');
	assert.equal(rovingIndex('Home', 2, 4), 0);
	assert.equal(rovingIndex('End', 0, 4), 3);
	assert.equal(rovingIndex('Enter', 1, 4), undefined, 'other keys are the button\'s');
	assert.equal(rovingIndex('ArrowRight', 0, 0), undefined);
});

test('Scroll to bottom says where the terminal is', () => {
	assert.equal(scrollTip('bottom'), 'Already at the bottom');
	assert.equal(scrollTip('up'), 'Scroll to bottom');
	assert.match(scrollTip('new'), /new output/);
});

test('Watch only says what it means for the agent that holds the terminal', () => {
	assert.equal(watchTip(true, 'Fix the build'), 'Watch only is on: «Fix the build»\'s agent reads this terminal and cannot type');
	assert.match(watchTip(false), /^Watch only is off: The agent may type/);
});
