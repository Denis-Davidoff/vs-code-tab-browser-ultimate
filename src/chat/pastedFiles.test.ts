import { test } from 'node:test';
import * as assert from 'node:assert';
import { pastedFileName, pastedImageType } from './pastedFiles.ts';

test('a pasted file name keeps only its leaf and safe characters', () => {
	assert.strictEqual(pastedFileName('../../etc/passwd'), 'passwd');
	assert.strictEqual(pastedFileName('C:\\Users\\me\\a<b>.txt'), 'a_b_.txt');
	assert.strictEqual(pastedFileName('...'), 'pasted-file');
});

test('a long pasted file name is cut by code point, never inside a surrogate pair', () => {
	const name = pastedFileName('😀' + 'a'.repeat(179) + '.png');
	assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(name));
	assert.strictEqual(Array.from(name).length, 180);
	const kept = pastedFileName('😀' + 'a'.repeat(175) + '.png');
	assert.ok(kept.startsWith('😀'));
});

test('only raster formats the agents take are image input', () => {
	assert.strictEqual(pastedImageType('a.png', 'image/png'), 'image/png');
	assert.strictEqual(pastedImageType('a.svg', 'image/svg+xml'), undefined);
	assert.strictEqual(pastedImageType('a.JPG', ''), 'image/jpeg');
});

test('a pasted file name fits a file system name with the host prefix', () => {
	const name = pastedFileName('漢'.repeat(300) + '.txt');
	assert.ok(Buffer.byteLength(name) <= 200);
	assert.ok(name.endsWith('漢.txt'));
});
