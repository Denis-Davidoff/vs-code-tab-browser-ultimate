import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { applyPatch, diffState, readPatch, sameJson } from './sync.ts';

// A small deterministic generator, so a failure reproduces.
function rng(seed: number): () => number {
	return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
}
function randomState(r: () => number): Record<string, unknown> {
	const s: Record<string, unknown> = {};
	for (const key of ['chatId', 'running', 'selection', 'workdir', 'usage', 'blocked']) {
		if (r() < 0.8) { s[key] = r() < 0.5 ? Math.floor(r() * 4) : { v: Math.floor(r() * 3), list: [Math.floor(r() * 2)] }; }
	}
	const n = Math.floor(r() * 6);
	s.entries = Array.from({ length: n }, () => ({ kind: 'assistant', text: 'x'.repeat(Math.floor(r() * 3)) }));
	return s;
}

test('applying the diff of two states gives the second', () => {
	const r = rng(7);
	for (let i = 0; i < 3000; i++) {
		const a = randomState(r), b = randomState(r);
		const patch = diffState(a, b, 4, 5);
		const result = patch ? applyPatch(a, 4, patch) : a;
		assert.ok(result && sameJson(result, b), JSON.stringify({ a, b, patch }));
	}
});

test('a streaming reply sends only the last entry', () => {
	const prev = { chatId: 'c', entries: [{ t: 'a' }, { t: 'b' }] };
	const next = { chatId: 'c', entries: [{ t: 'a' }, { t: 'bc' }] };
	assert.deepEqual(diffState(prev, next, 1, 2), { base: 1, rev: 2, entries: { from: 1, upsert: [{ t: 'bc' }], length: 2 } });
	assert.equal(diffState(prev, prev, 1, 2), undefined);
});

test('a patch for another revision, or one that does not fit, is refused', () => {
	const prev = { entries: [1, 2] };
	const patch = diffState(prev, { entries: [1, 2, 3] }, 1, 2)!;
	assert.equal(applyPatch(prev, 0, patch), undefined);
	assert.equal(applyPatch({ entries: [] }, 1, patch), undefined);
	assert.equal(readPatch({ base: 2, rev: 2 }), undefined);
	assert.equal(readPatch({ base: 1, rev: 2, unset: [3] }), undefined);
	assert.ok(readPatch(patch));
});
