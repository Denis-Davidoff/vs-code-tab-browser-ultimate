import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createChromeTerminalLink } from './chromeTerminalLink.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('frames are batched and posted one request at a time, in order', async () => {
	const posts: unknown[][] = [];
	let release!: () => void;
	const link = createChromeTerminalLink({
		post: async frames => { posts.push([...frames]); if (posts.length === 1) { await new Promise<void>(r => { release = r; }); } return true; },
		get: () => new Promise(() => {}), deliver: () => {}, maxBatch: 2,
	});
	link.send({ n: 1 }); link.send({ n: 2 }); link.send({ n: 3 });
	await tick();
	assert.deepEqual(posts, [[{ n: 1 }, { n: 2 }]]);
	link.send({ n: 4 });
	release(); await tick(); await tick();
	assert.deepEqual(posts, [[{ n: 1 }, { n: 2 }], [{ n: 3 }, { n: 4 }]]);
});

test('a refused post drops what is queued; a stopped link takes nothing', async () => {
	const posts: unknown[][] = [];
	const link = createChromeTerminalLink({ post: async frames => { posts.push([...frames]); return false; }, get: () => new Promise(() => {}), deliver: () => {}, maxBatch: 1 });
	link.send({ n: 1 }); link.send({ n: 2 });
	await tick(); await tick();
	assert.deepEqual(posts, [[{ n: 1 }]]);
	link.stop();
	assert.equal(link.send({ n: 3 }), false);
});

test('the poll loop follows the cursor, delivers frames, and retries after a failure', async () => {
	const asked: number[] = [];
	const delivered: unknown[] = [];
	let calls = 0;
	const link = createChromeTerminalLink({
		post: async () => true, deliver: frame => delivered.push(frame), wait: async () => {},
		get: async after => {
			asked.push(after); calls++;
			if (calls === 1) { return { cursor: 3, frames: ['a', 'b'] }; }
			if (calls === 2) { throw new Error('offline'); }
			if (calls === 3) { return { cursor: 4, frames: ['c'] }; }
			link.stop(); throw new Error('stopped');
		},
	});
	link.start(); link.start();
	for (let i = 0; i < 10; i++) { await tick(); }
	assert.deepEqual(asked, [0, 3, 3, 4]);
	assert.deepEqual(delivered, ['a', 'b', 'c']);
	assert.equal(link.polling, false);
});
