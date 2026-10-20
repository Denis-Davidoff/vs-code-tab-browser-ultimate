import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { gitDiffSides } from './gitDiff.ts';

test('a partly staged file compares HEAD with index or index with working tree according to its group', () => {
	const file = { path: 'file.txt', status: 'M' };
	assert.deepEqual(gitDiffSides(file, true), { before: { path: 'file.txt', ref: 'HEAD' }, after: { path: 'file.txt', ref: '' } });
	assert.deepEqual(gitDiffSides(file, false), { before: { path: 'file.txt', ref: '' }, after: { path: 'file.txt' } });
});

test('added and deleted files have an empty side, including unborn HEAD', () => {
	assert.equal(gitDiffSides({ path: 'new.txt', status: 'A' }, true).before, undefined);
	assert.equal(gitDiffSides({ path: 'untracked.txt', status: '?' }, false).before, undefined);
	assert.deepEqual(gitDiffSides({ path: 'deleted.txt', status: 'D' }, false), { before: { path: 'deleted.txt', ref: '' }, after: undefined });
	assert.deepEqual(gitDiffSides({ path: 'deleted.txt', status: 'D' }, true), { before: { path: 'deleted.txt', ref: 'HEAD' }, after: undefined });
});

test('renames compare the previous path against the new path', () => {
	assert.deepEqual(gitDiffSides({ path: 'new name.txt', originalPath: 'old name.txt', status: 'R' }, true), {
		before: { path: 'old name.txt', ref: 'HEAD' }, after: { path: 'new name.txt', ref: '' },
	});
});
