import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { GitAccess } from './gitAccess.ts';

const identity = async (folder: string) => folder.startsWith('/repo') ? 'worktree:repo' : folder;

test('a running root-folder agent blocks mutations from subdirectories and releases the failed reservation', async () => {
	const access = new GitAccess(identity);
	await assert.rejects(access.mutate('/repo/sub', () => ['/repo']), /Wait for agents/);
	const release = await access.mutate('/repo', () => []);
	release();
	let started = false;
	await access.launch('/repo/sub', () => true, () => { started = true; });
	assert.equal(started, true);
});

test('checkout/commit locks reject chat and skill starts in the same worktree, including aliases', async () => {
	const access = new GitAccess(identity);
	const release = await access.mutate('/repo', () => []);
	try {
		for (const folder of ['/repo', '/repo/sub']) {
			await assert.rejects(access.launch(folder, () => true, () => assert.fail('agent started during mutation')), /Git is updating/);
		}
		await assert.rejects(access.mutate('/repo/sub', () => []), /Another Git operation/);
		let unrelated = false;
		await access.launch('/other-worktree', () => true, () => { unrelated = true; });
		assert.equal(unrelated, true);
		const releaseOther = await access.mutate('/other-worktree', () => ['/unrelated']);
		releaseOther();
	} finally { release(); }
	await access.launch('/repo', () => true, () => {});
});

test('an agent starting while Git identity resolves is detected before the mutation starts', async () => {
	let resolve!: (key: string) => void;
	const pending = new Promise<string>(r => { resolve = r; });
	let busy = false;
	const access = new GitAccess(async () => pending);
	const mutation = access.mutate('/repo/sub', () => busy ? ['/repo'] : []);
	await access.launch('/repo', () => true, () => { busy = true; });
	resolve('worktree:repo');
	await assert.rejects(mutation, /Wait for agents/);
});

test('a reservation blocks launches while existing busy-folder identities are resolving', async () => {
	let resolveBusy!: (key: string) => void;
	const pending = new Promise<string>(r => { resolveBusy = r; });
	const access = new GitAccess(async folder => folder === '/busy-alias' ? pending : 'worktree:repo');
	const mutation = access.mutate('/repo', () => ['/busy-alias']);
	await Promise.resolve();
	await assert.rejects(access.launch('/repo', () => true, () => assert.fail('start')), /Git is updating/);
	resolveBusy('worktree:repo');
	await assert.rejects(mutation, /Wait for agents/);
});

test('stale conversations are not started after asynchronous lock discovery', async () => {
	const access = new GitAccess(identity);
	const release = await access.mutate('/other', () => []);
	try { await assert.rejects(access.launch('/repo', () => false, () => assert.fail('stale start')), /conversation or working folder changed/); }
	finally { release(); }
});


test('queued work waits for a mutation to release instead of being dropped', async () => {
	const access = new GitAccess(identity);
	const release = await access.mutate('/repo', () => []);
	let started = false;
	const queued = access.launch('/repo/sub', () => true, () => { started = true; }, true);
	await Promise.resolve();
	assert.equal(started, false);
	release();
	await queued;
	assert.equal(started, true);
});
