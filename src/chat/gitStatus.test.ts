import { deepStrictEqual, strictEqual } from 'node:assert';
import { test } from 'node:test';
import { parseGitStatus } from './gitStatus.ts';

test('counts files once across index and working tree, with deletions separate', () => {
 const result = parseGitStatus('MM both.ts\0 D removed.ts\0A  new.ts\0?? untracked.ts\0');
 strictEqual(result.changed, 3);
 strictEqual(result.deleted, 1);
 deepStrictEqual(result.staged.map(f => f.path), ['both.ts', 'new.ts']);
 deepStrictEqual(result.unstaged.map(f => f.path), ['both.ts', 'removed.ts', 'untracked.ts']);
});
test('preserves literal filenames and skips the source record of a rename', () => {
 const result = parseGitStatus('R  new name\n.ts\0old name.ts\0 M another.ts\0');
 deepStrictEqual(result.staged, [{ path: 'new name\n.ts', status: 'R', originalPath: 'old name.ts' }]);
 strictEqual(result.changed, 2);
 strictEqual(result.unstaged[0].path, 'another.ts');
});
test('clean repositories return zero counts and empty groups', () => {
 deepStrictEqual(parseGitStatus(''), { staged: [], unstaged: [], changed: 0, deleted: 0 });
});
