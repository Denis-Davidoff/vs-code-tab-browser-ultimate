/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { chatTranscript, transcriptFileName } from './transcript.ts';

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
