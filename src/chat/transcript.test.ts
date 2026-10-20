/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { chatTranscript, secondOpinionText, transcriptFileName } from './transcript.ts';

const when = new Date(2026, 9, 16, 14, 5, 9);

suite('chatTranscript', () => {

	test('turns under one heading per speaker, tools as one line each, thinking and notices left out', () => {
		const md = chatTranscript('Fix the build', 'Claude Code', [
			{ kind: 'user', text: 'Why does the build fail?', attachments: ['Screenshot · Home'], at: 1 },
			{ kind: 'thinking', text: 'secret musing', startedAt: 1, endedAt: 2 },
			{ kind: 'tool', id: 't1', tool: 'command', name: 'Bash', input: 'npm run build', status: 'failed', exitCode: 2, startedAt: 1 },
			{ kind: 'tool', id: 't2', tool: 'read', name: 'Read', detail: 'src/a.ts', status: 'done', startedAt: 1 },
			{ kind: 'assistant', text: 'A missing import.' },
			{ kind: 'notice', text: 'Stopped.' },
			{ kind: 'user', text: 'Fix it', attachments: [], at: 2 },
		], when);
		assert.ok(md.startsWith('# Fix the build\n'));
		assert.match(md, /## User\n\nWhy does the build fail\?\n\nAttached: Screenshot · Home/);
		assert.match(md, /## Claude Code\n\n- Ran `npm run build` \(exit code 2\)\n- Read src\/a\.ts\n\nA missing import\./);
		assert.ok(!md.includes('secret musing'));
		assert.ok(!md.includes('Stopped.'));
		assert.strictEqual(md.match(/## User/g)?.length, 2);
	});

	test("an agent's report is quoted in a fence longer than any backtick run in it", () => {
		const md = chatTranscript('t', 'Codex', [
			{ kind: 'tool', id: 'a', tool: 'agent', name: 'Agent', detail: 'read a', status: 'done', startedAt: 1, agent: { calls: [], summary: 'has ```` in it' } },
		], when);
		assert.match(md, /- Started an agent: read a\n\n`````text\nhas ```` in it\n`````/);
	});

	test('file names are the sweep\'s, from the title and the time', () => {
		assert.strictEqual(transcriptFileName('Fix the BUILD!', when), 'chat-fix-the-build-20261016-140509.md');
		assert.strictEqual(transcriptFileName('Привет', when), 'chat-20261016-140509.md');
		assert.match(transcriptFileName('x'.repeat(100), when), /^chat-x{40}-\d{8}-\d{6}\.md$/);
	});
});

suite('secondOpinionText', () => {

	test('asks for an independent answer, without the first answer and without changing files', () => {
		const text = secondOpinionText('Claude Code', [], undefined);
		assert.match(text, /second, independent opinion/);
		assert.match(text, /not a review of Claude Code's answer, which you are not shown/);
		assert.match(text, /Do not change any files yourself/);
		assert.doesNotMatch(text, /conversation before the question/);
		assert.doesNotMatch(text, /attachments/);
	});

	test('names the attachments it cannot hand over, on one line each', () => {
		const text = secondOpinionText('Codex', ['Screenshot\nof the page', 'a.ts'], undefined);
		assert.match(text, /attachments you are not given: Screenshot of the page, a\.ts\./);
	});

	test('points at the conversation file, or carries the conversation itself', () => {
		assert.match(secondOpinionText('Codex', [], { file: '/p/.ai-browser/chat-x.md' }), /is in \/p\/\.ai-browser\/chat-x\.md: read it first/);
		const inline = secondOpinionText('Codex', [], { text: '# Chat\n\n## User\n\nhello' });
		assert.match(inline, /conversation before the question follows/);
		assert.ok(inline.endsWith('## User\n\nhello'));
	});
});
