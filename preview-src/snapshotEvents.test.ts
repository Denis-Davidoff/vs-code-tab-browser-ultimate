import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { snapshotReplay } from './snapshotEvents.ts';

test('a snapshot message is replayed once, and again only when it changes', () => {
	const emitted: unknown[] = [];
	const replay = snapshotReplay(message => emitted.push(message));
	const a = { type: 'workdirGit', folder: '/a', error: 'x' } as const;
	replay([a]); replay([a]); replay(undefined);
	assert.equal(emitted.length, 1);
	replay([a, { type: 'workdirGit', folder: '/b' }]);
	assert.equal(emitted.length, 2);
	replay([{ ...a, error: 'y' }]);
	assert.equal(emitted.length, 3);
});
