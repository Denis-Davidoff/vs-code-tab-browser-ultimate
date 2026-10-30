import * as assert from 'node:assert';
import { test } from 'node:test';
import * as path from 'node:path';
import { copyName, gitMarks, isInside, resolveInside, sortEntries } from './fileExplorer.ts';

const root = path.resolve('/tmp/proj');

test('resolveInside keeps paths in the root', () => {
	assert.strictEqual(resolveInside(root, ''), root);
	assert.strictEqual(resolveInside(root, 'a/b.txt'), path.join(root, 'a/b.txt'));
	assert.strictEqual(resolveInside(root, '../x'), undefined);
	assert.strictEqual(resolveInside(root, 'a/../../x'), undefined);
	assert.strictEqual(resolveInside(root, '/etc/hosts'), undefined);
	assert.strictEqual(resolveInside(root, 'a\nb'), undefined);
	assert.ok(isInside(root, path.join(root, 'x')));
	assert.ok(!isInside(root, path.resolve(root, '..', 'proj2')));
});

test('copyName finds a free name', () => {
	const taken = new Set(['a.md', 'a copy.md']);
	assert.strictEqual(copyName('b.md', n => taken.has(n)), 'b.md');
	assert.strictEqual(copyName('a.md', n => taken.has(n)), 'a copy 2.md');
	assert.strictEqual(copyName('.env', n => n === '.env'), '.env copy');
	assert.strictEqual(copyName('dir', n => n === 'dir'), 'dir copy');
});

test('sortEntries puts folders first and numbers in order', () => {
	const sorted = sortEntries([{ name: 'f10', dir: false }, { name: 'z', dir: true }, { name: 'f2', dir: false }]);
	assert.deepStrictEqual(sorted.map(e => e.name), ['z', 'f2', 'f10']);
});

test('gitMarks marks entries of one folder', () => {
	const out = ' M src/a.ts\0?? src/new/x.ts\0?? src/new/y.ts\0A  src/b.ts\0R  src/c.ts\0src/old.ts\0 M src/mix/p.ts\0?? src/mix/q.ts\0 M top.ts\0';
	const m = gitMarks(out, 'src');
	assert.equal(m.get('a.ts'), 'M');
	assert.equal(m.get('new'), 'U');
	assert.equal(m.get('b.ts'), 'A');
	assert.equal(m.get('c.ts'), 'M');
	assert.equal(m.get('mix'), 'M');
	assert.equal(m.has('top.ts'), false);
	assert.equal(gitMarks(out, '').get('src'), 'M');
});
