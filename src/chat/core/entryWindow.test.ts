import * as assert from 'node:assert';
import { test } from 'node:test';
import { remoteRichEntries, remoteRichBytes, windowEntries } from './entryWindow.ts';
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


test('remote rich results bound a single oversized native JSON block without changing the original', () => {
	const value = { result: 'x'.repeat(16_000_000) };
	const original: ChatEntry[] = [{ kind: 'tool', id: 'native', tool: 'mcp', name: 'Large result', status: 'done', startedAt: 1, blocks: [{ type: 'json', value }] }];
	const remote = remoteRichEntries(original);
	assert.ok(Buffer.byteLength(JSON.stringify(remote)) < remoteRichBytes);
	assert.ok(JSON.stringify(remote).includes('original data is preserved'));
	assert.strictEqual(original[0].kind === 'tool' && original[0].blocks?.[0].type === 'json' && original[0].blocks[0].value, value);
});

test('the remote rich budget is shared by entries, prefers newer data, and counts UTF-8', () => {
	const result = (id: string, value: string): ChatEntry => ({ kind: 'result', id, title: id, at: 1, blocks: [{ type: 'json', value }] });
	const originals = [result('old', 'a'.repeat(600_000)), result('new', '🐈'.repeat(160_000))];
	const remote = remoteRichEntries(originals);
	assert.ok(Buffer.byteLength(JSON.stringify(remote)) < remoteRichBytes + 1000);
	assert.equal(remote[0].kind === 'result' && remote[0].blocks[0].type, 'text');
	assert.strictEqual(remote[1], originals[1]);
	assert.equal(originals[0].kind === 'result' && originals[0].blocks[0].type, 'json');
	const small = [result('small', 'hello')]; assert.strictEqual(remoteRichEntries(small), small);
});
