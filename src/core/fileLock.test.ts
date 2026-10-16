/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { suite, test } from 'node:test';
import { withLock } from './fileLock.ts';

async function scratchLock(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-browser-lock-test-'));
	return path.join(dir, 'x.lock');
}

async function abandon(file: string): Promise<void> {
	await fs.writeFile(file, 'crashed-window');
	const old = new Date(Date.now() - 60_000);
	await fs.utimes(file, old, old);
}

/** The pid of a process that has already exited. */
function deadPid(): number {
	return spawnSync(process.execPath, ['-e', '']).pid!;
}

/** Runs `n` lockers at once and reports how many held the lock together. */
async function peakHolders(file: string, n: number): Promise<{ peak: number; ran: number }> {
	let holders = 0;
	let peak = 0;
	let ran = 0;
	await Promise.all(Array.from({ length: n }, () => withLock(file, async () => {
		holders++;
		peak = Math.max(peak, holders);
		ran++;
		await new Promise(resolve => setTimeout(resolve, 20));
		holders--;
	})));
	return { peak, ran };
}

suite('withLock', () => {

	test('one holder at a time', async () => {
		const file = await scratchLock();
		const { peak, ran } = await peakHolders(file, 4);
		assert.strictEqual(peak, 1);
		assert.strictEqual(ran, 4);
	});

	test('an abandoned lock is taken over', async () => {
		const file = await scratchLock();
		await abandon(file);
		assert.strictEqual(await withLock(file, async () => { }), true);
	});

	// Two waiters that both judged the same lock abandoned used to both hold
	// it: the second removed the first's *fresh* lock on the strength of a
	// stat made before it existed.
	test('waiters racing for an abandoned lock still hold it one at a time', async () => {
		for (let round = 0; round < 10; round++) {
			const file = await scratchLock();
			await abandon(file);
			const { peak } = await peakHolders(file, 6);
			assert.strictEqual(peak, 1, `round ${round}`);
		}
	});

	// A second remover busy with the breaker used to send every waiter
	// through its 20 attempts in a tight loop, so `withLock` gave up in
	// milliseconds instead of waiting its second.
	test('a breaker held by a live remover makes waiters wait, not give up', async () => {
		const file = await scratchLock();
		await abandon(file);
		await fs.writeFile(`${file}.break`, `${process.pid}:break`);
		setTimeout(() => { void fs.rm(`${file}.break`, { force: true }); }, 200);
		assert.strictEqual(await withLock(file, async () => { }), true);
	});

	test('a lock whose process has exited is taken over without waiting out its age', async () => {
		const file = await scratchLock();
		await fs.writeFile(file, `${deadPid()}:abc`);
		const started = Date.now();
		assert.strictEqual(await withLock(file, async () => { }), true);
		assert.ok(Date.now() - started < 1_000);
	});

	test('a breaker left by a process that has exited does not block', async () => {
		const file = await scratchLock();
		await abandon(file);
		await fs.writeFile(`${file}.break`, `${deadPid()}:break`);
		assert.strictEqual(await withLock(file, async () => { }), true);
	});

	// Clearing an abandoned *breaker* by path re-created the double-holder
	// race one level down; both are now taken aside and judged on the file
	// that was moved.
	test('waiters racing over an abandoned lock and breaker still hold it one at a time', async () => {
		for (let round = 0; round < 10; round++) {
			const file = await scratchLock();
			await abandon(file);
			await abandon(`${file}.break`);
			const { peak, ran } = await peakHolders(file, 6);
			assert.strictEqual(peak, 1, `round ${round}`);
			assert.strictEqual(ran, 6, `round ${round}`);
		}
	});

	test('a released lock leaves nothing behind', async () => {
		const file = await scratchLock();
		await abandon(file);
		await abandon(`${file}.break`);
		await withLock(file, async () => { });
		assert.deepStrictEqual(await fs.readdir(path.dirname(file)), [], 'no lock, breaker or aside file');
	});

	// A lock taken over from us belongs to somebody else by the time we
	// finish; removing it would let a third window in beside them.
	test('release does not remove a lock that is no longer ours', async () => {
		const file = await scratchLock();
		await withLock(file, async () => {
			await fs.writeFile(file, 'someone-else');
		});
		assert.strictEqual(await fs.readFile(file, 'utf8'), 'someone-else');
	});
});
