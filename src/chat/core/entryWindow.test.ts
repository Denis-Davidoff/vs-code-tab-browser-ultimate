import * as assert from 'node:assert';
import { test } from 'node:test';
import { windowEntries } from './entryWindow.ts';
import type { ChatEntry } from '../chatProtocol.ts';

const user = (t: string) => ({ kind: 'user', text: t }) as unknown as ChatEntry;
const reply = (t: string) => ({ kind: 'assistant', text: t }) as unknown as ChatEntry;

test('keeps the last N prompts with their replies', () => {
	const entries = [user('a'), reply('1'), user('b'), reply('2'), user('c'), reply('3')];
	const w = windowEntries(entries, 2);
	assert.strictEqual(w.offset, 2);
	assert.deepStrictEqual(w.entries.map(e => (e as { text: string }).text), ['b', '2', 'c', '3']);
});

test('the whole conversation when it is short', () => {
	const entries = [reply('notice'), user('a'), reply('1')];
	assert.deepStrictEqual(windowEntries(entries, 20), { entries, offset: 0 });
});

test('an entry cap starts at a prompt, not inside a turn', () => {
	const entries = [user('a'), ...Array.from({ length: 10 }, (_, i) => reply(String(i))), user('b'), reply('x')];
	const w = windowEntries(entries, 20, 5);
	assert.strictEqual(entries[w.offset].kind, 'user');
	assert.strictEqual(w.offset, 11);
});

test('one turn longer than the cap starts at its own prompt, and the start stays put as it grows', () => {
	const tool = { kind: 'tool' } as unknown as ChatEntry;
	const entries = [user('a'), tool, user('b'), ...Array.from({ length: 500 }, () => tool)];
	const first = windowEntries(entries, 20).offset;
	assert.strictEqual(first, 2);
	entries.push(tool, tool);
	assert.strictEqual(windowEntries(entries, 20).offset, first);
});
