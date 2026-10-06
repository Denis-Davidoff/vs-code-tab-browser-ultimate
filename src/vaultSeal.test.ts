/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { isSealed, seal, SealError, unseal } from './vaultSeal.ts';

/** Cheap parameters, so the suite is fast; the default cost has its own test. */
const cheap = { N: 1 << 14, r: 8, p: 1 };

const reason = async (work: Promise<unknown>) => {
	try {
		await work;
	} catch (err) {
		return err instanceof SealError ? err.reason : `unexpected ${String(err)}`;
	}
	return 'no error';
};

suite('seal / unseal', () => {

	test('round-trips, including text outside ASCII', async () => {
		const plain = JSON.stringify({ password: 'pä$$wörd — 🔑' });
		const file = await seal(plain, 'correct horse', cheap);
		assert.ok(isSealed(file));
		assert.strictEqual(await unseal(file, 'correct horse'), plain);
	});

	test('the file does not contain the secret', async () => {
		const file = await seal('{"password":"hunter2"}', 'pass', cheap);
		assert.ok(!file.includes('hunter2'));
		assert.ok(!Buffer.from(JSON.parse(file).data, 'base64').toString('latin1').includes('hunter2'));
	});

	test('a passphrase typed composed or decomposed opens the same file', async () => {
		const file = await seal('x', 'café', cheap);
		assert.strictEqual(await unseal(file, 'café'), 'x');
	});

	test('a wrong passphrase is reported as such', async () => {
		const file = await seal('x', 'right', cheap);
		assert.strictEqual(await reason(unseal(file, 'wrong')), 'wrongPassphrase');
	});

	test('editing a parameter breaks authentication rather than decrypting differently', async () => {
		const file = JSON.parse(await seal('x', 'p', cheap));
		const salted = { ...file, kdf: { ...file.kdf, salt: Buffer.alloc(16, 1).toString('base64') } };
		assert.strictEqual(await reason(unseal(JSON.stringify(salted), 'p')), 'wrongPassphrase');
		const flipped = Buffer.from(file.data, 'base64');
		flipped[0] ^= 1;
		assert.strictEqual(await reason(unseal(JSON.stringify({ ...file, data: flipped.toString('base64') }), 'p')),
			'wrongPassphrase');
	});

	test('a file asking for an unbounded scrypt cost is refused before any work', async () => {
		const file = JSON.parse(await seal('x', 'p', cheap));
		for (const kdf of [{ N: 1 << 24 }, { N: 1000 }, { r: 64 }, { p: 100 }]) {
			const bad = JSON.stringify({ ...file, kdf: { ...file.kdf, ...kdf } });
			assert.strictEqual(await reason(unseal(bad, 'p')), 'unsupported', JSON.stringify(kdf));
		}
	});

	test('other text is not an export', async () => {
		assert.ok(!isSealed('name,url,username,password'));
		assert.strictEqual(await reason(unseal('{"format":"other"}', 'p')), 'notSealed');
		assert.strictEqual(await reason(unseal('not json', 'p')), 'notSealed');
	});

	test('a version from the file is never echoed into the message', async () => {
		// The message reaches a notification, whose body renders links that run commands.
		const crafted = JSON.stringify({ format: 'ai-browser-vault-export', version: '1 [Update](command:workbench.action.terminal.sendSequence)' });
		await assert.rejects(unseal(crafted, 'p'), (err: Error) => !err.message.includes('[') && !err.message.includes('command:'));
	});

	test('a newer version is refused rather than misread', async () => {
		const file = JSON.parse(await seal('x', 'p', cheap));
		assert.strictEqual(await reason(unseal(JSON.stringify({ ...file, version: 2 }), 'p')), 'unsupported');
	});

	test('the default cost works end to end', async () => {
		const file = await seal('x', 'p');
		assert.strictEqual(JSON.parse(file).kdf.N, 1 << 17);
		assert.strictEqual(await unseal(file, 'p'), 'x');
	});
});
