/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import type { ToolbarSkill } from './chatProtocol.ts';
import { adaptSigils, extractResult, fillPrompt, nextDecision, nextNo, nextYes, stepGate, validToolbarSkill, valueProblem, withNextDecision, withResultMarkers } from './toolbarText.ts';

const base = { id: 'abc-1', name: 'pr-review', prompt: 'Review PR {{pr}} with /one-more-review', result: 'chat', agents: 'all', icon: 'git-pull-request', params: [{ name: 'pr', type: 'number' }] };

suite('toolbar skills', () => {
	test('a valid skill is kept, trimmed and cut', () => {
		const skill = validToolbarSkill({ ...base, label: '  Review   PR  ', tooltip: 'x'.repeat(300) }) as ToolbarSkill;
		assert.strictEqual(typeof skill, 'object');
		assert.strictEqual(skill.label, 'Review PR');
		assert.strictEqual(skill.tooltip?.length, 200);
		assert.deepStrictEqual(skill.params, [{ name: 'pr', type: 'number', maxLength: undefined, preset: undefined, options: undefined }]);
	});

	test('a name with a space, an empty prompt or a duplicate parameter is refused', () => {
		assert.match(validToolbarSkill({ ...base, name: 'pr review' }) as string, /no spaces/);
		assert.match(validToolbarSkill({ ...base, prompt: '   ' }) as string, /empty/);
		assert.match(validToolbarSkill({ ...base, params: [{ name: 'a' }, { name: 'a' }] }) as string, /Two parameters/);
		assert.match(validToolbarSkill({ ...base, params: [{ name: 'c', type: 'choice', options: [] }] }) as string, /lists no values/);
		assert.match(validToolbarSkill({ ...base, params: [{ name: 'n', type: 'number', preset: 'ten' }] }) as string, /number is needed/);
		assert.strictEqual(typeof validToolbarSkill({ ...base, name: 'pdf:pdf' }), 'object');
	});

	test('a name is lower case, and a colour is a theme colour or #rrggbb', () => {
		assert.strictEqual((validToolbarSkill({ ...base, name: 'PR-Review' }) as ToolbarSkill).name, 'pr-review');
		assert.deepStrictEqual((validToolbarSkill({ ...base, colors: { text: 'green', border: '#A1B2C3', icon: 'red; background: url(x)' } }) as ToolbarSkill).colors,
			{ text: 'green', border: '#a1b2c3', icon: undefined });
		assert.strictEqual((validToolbarSkill({ ...base, colors: { icon: 'url(x)' } }) as ToolbarSkill).colors, undefined);
		// The one colour of an earlier build tinted the label and the icon.
		assert.deepStrictEqual((validToolbarSkill({ ...base, color: 'blue' }) as ToolbarSkill).colors, { text: 'blue', border: undefined, icon: 'blue' });
	});

	test('values are checked by type, and filled in', () => {
		const skill = validToolbarSkill({ ...base, params: [
			{ name: 'pr', type: 'number' },
			{ name: 'tone', type: 'choice', options: ['short', 'long'] },
			{ name: 'note', type: 'text', maxLength: 5 },
		], prompt: 'PR {{pr}}, {{ tone }}, {{note}}, {{other}}' }) as ToolbarSkill;
		assert.deepStrictEqual(fillPrompt(skill, { pr: '42', tone: 'short', note: 'hi' }), { steps: [{ text: 'PR 42, short, hi, {{other}}' }] });
		assert.deepStrictEqual(fillPrompt(skill, { pr: 'x', tone: 'short', note: 'hi' }), { error: 'pr: a number is needed.' });
		assert.deepStrictEqual(fillPrompt(skill, { pr: '1', tone: 'medium', note: 'hi' }), { error: 'tone: one of short, long.' });
		assert.deepStrictEqual(fillPrompt(skill, { pr: '1', tone: 'long', note: 'toolong' }), { error: 'note: at most 5 characters.' });
		assert.strictEqual(valueProblem({ name: 'x', type: 'text' }, '  '), 'a value is needed.');
	});

	test('skills are written the way the agent that runs them reads them', () => {
		const codex = [{ name: 'one-more-review', insert: '$one-more-review', group: 'user' as const }];
		const claude = [{ name: 'one-more-review', insert: '/one-more-review', group: 'user' as const }];
		assert.strictEqual(adaptSigils('Run /one-more-review, then /usr/bin', codex), 'Run $one-more-review, then /usr/bin');
		assert.strictEqual(adaptSigils('Run $one-more-review.', claude), 'Run /one-more-review.');
		assert.strictEqual(adaptSigils('a/one-more-review', codex), 'a/one-more-review');
	});

	test('the result between the last pair of markers is what is copied', () => {
		const prompt = withResultMarkers('Do it');
		assert.ok(prompt.indexOf('<<<RESULT') < prompt.indexOf('Do it') && prompt.lastIndexOf('<<<RESULT') > prompt.indexOf('Do it'));
		const r = (text: string) => extractResult(text);
		assert.deepStrictEqual(r('Here:\n<<<RESULT\nline 1\nline 2\nRESULT>>>\nDone.'), { text: 'line 1\nline 2', source: 'markers' });
		assert.deepStrictEqual(r('You asked for <<<RESULT … RESULT>>>.\n<<<RESULT\n42\nRESULT>>>'), { text: '42', source: 'markers' });
		assert.strictEqual(r('no markers here'), undefined);
	});

	test('a marker is a line of its own, so a result may mention the markers', () => {
		const r = (text: string) => extractResult(text);
		// The commit message that described this very feature.
		const reply = 'I wrote the message.\n\n<<<RESULT\nSubject\n\n- read from <<<RESULT / RESULT>>> markers,\n  which the prompt asks for.\n\nEnd.\nRESULT>>>';
		assert.deepStrictEqual(r(reply), { text: 'Subject\n\n- read from <<<RESULT / RESULT>>> markers,\n  which the prompt asks for.\n\nEnd.', source: 'markers' });
		assert.deepStrictEqual(r('<<<RESULT  \r\nx\r\n  RESULT>>>\r\n'), { text: 'x', source: 'markers' });
		// Written inline, with no marker on a line of its own, it is still read.
		assert.deepStrictEqual(r('The answer: <<<RESULT 42 RESULT>>>'), { text: ' 42 ', source: 'markers' });
	});

	test('a fence around the marked result is dropped, and a fence is the fallback', () => {
		const r = (text: string) => extractResult(text);
		assert.deepStrictEqual(r('<<<RESULT\n```text\nSubject\n\nBody\n```\nRESULT>>>'), { text: 'Subject\n\nBody', source: 'markers' });
		// A result that contains a block, rather than being one, is kept whole.
		assert.deepStrictEqual(r('<<<RESULT\nUse:\n```\nnpm test\n```\nRESULT>>>'), { text: 'Use:\n```\nnpm test\n```', source: 'markers' });
		assert.deepStrictEqual(r('Here is the message:\n\n```\nChat: a\n\n- b\n```\n\nNEWS.md has an entry.'), { text: 'Chat: a\n\n- b', source: 'fence' });
		// The last block, and a shorter fence inside a longer one is content.
		assert.deepStrictEqual(r('```\nfirst\n```\n````md\nx\n```\ny\n```\n````'), { text: 'x\n```\ny\n```', source: 'fence' });
		assert.strictEqual(r('Inline ```code``` only'), undefined);
	});
});

suite('toolbar skills of several prompts', () => {
	const base = { id: 'a1', name: 'chain', prompt: 'Fix {{what}}', params: [{ name: 'what' }] };

	test('follow-ups are kept in order, empty ones dropped, an empty check is no check', () => {
		const skill = validToolbarSkill({ ...base, followUps: [
			{ prompt: ' Run the tests ', check: '  ' },
			{ prompt: '' },
			'Commit {{what}}',
			{ prompt: 'Push', check: ' the tests for {{what}} pass ' },
		] }) as ToolbarSkill;
		assert.deepStrictEqual(skill.followUps, [
			{ prompt: 'Run the tests' },
			{ prompt: 'Commit {{what}}' },
			{ prompt: 'Push', check: 'the tests for {{what}} pass' },
		]);
		assert.strictEqual((validToolbarSkill(base) as ToolbarSkill).followUps, undefined);
		assert.match(validToolbarSkill({ ...base, followUps: Array.from({ length: 10 }, () => 'x') }) as string, /at most 10 prompts/);
	});

	test('the parameters fill every prompt and every check', () => {
		const skill = validToolbarSkill({ ...base, followUps: ['Commit {{what}}', { prompt: 'Push', check: '{{what}} is fixed' }] }) as ToolbarSkill;
		assert.deepStrictEqual(fillPrompt(skill, { what: 'the login' }), { steps: [
			{ text: 'Fix the login' },
			{ text: 'Commit the login' },
			{ text: 'Push', check: 'the login is fixed' },
		] });
	});

	test('the check is asked for, and the last marker line answers it', () => {
		const asked = withNextDecision('Run the tests', 'they all pass');
		assert.ok(asked.startsWith('Run the tests\n\n'));
		assert.ok(asked.includes('they all pass'));
		// Quoting the instruction names both; the last line is the answer.
		assert.strictEqual(nextDecision(`I will answer ${nextYes} or ${nextNo}.\nAll 12 pass.\n${nextYes}`), true);
		assert.strictEqual(nextDecision(`Two failed.\n**${nextNo}**`), false);
		assert.strictEqual(nextDecision(`${nextYes}\nlater: ${nextNo}\n${nextNo}`), false);
		assert.strictEqual(nextDecision('Done, everything passes.'), undefined);
	});

	test('the gate: no check always goes on; a check needs a clean step and a yes', () => {
		assert.deepStrictEqual(stepGate(undefined, 'Stopped.', ''), { go: true });
		assert.deepStrictEqual(stepGate('ok', undefined, nextYes), { go: true });
		assert.strictEqual(stepGate('ok', undefined, nextNo).go, false);
		assert.strictEqual(stepGate('ok', undefined, 'no marker').go, false);
		assert.strictEqual(stepGate('ok', 'Prompt is too long', nextYes).go, false);
	});
});
