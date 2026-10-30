import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';
import { windowEntries } from '../src/chat/core/entryWindow.ts';
import type { ChatEntry } from '../src/chat/chatProtocol.ts';

const source = readFileSync('preview-src/chat.ts', 'utf8');
const code = source.match(/function messageCount\([\s\S]*?\n\}/)![0];
const count = runInNewContext(transpileModule(`${code}\nmessageCount;`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText);

test('new message counts survive sliding history windows and loading earlier tool entries', () => {
	const entries = Array.from({ length: 20 }, () => [
		{ kind: 'user' }, { kind: 'tool' }, { kind: 'notice' }, { kind: 'assistant' },
	]).flat() as ChatEntry[];
	const state = (prompts: number) => {
		const w = windowEntries(entries, prompts);
		return { entries: w.entries, entriesOffset: w.offset, messageCount: entries.filter(e => e.kind === 'user' || e.kind === 'assistant').length };
	};
	const seen = count(state(20));
	entries.push({ kind: 'user' } as ChatEntry);
	assert.equal(count(state(20)) - seen, 1);
	assert.equal(count(state(40)), count(state(20)), 'loading earlier entries does not change the total');
	entries.push({ kind: 'tool' } as ChatEntry);
	assert.equal(count(state(20)) - seen, 1, 'tool activity is not a new message');
	assert.equal(count({ entries: [{ kind: 'user' }, { kind: 'tool' }], entriesOffset: 10 }), 1, 'older hosts never add an offset measured in tools');
});
