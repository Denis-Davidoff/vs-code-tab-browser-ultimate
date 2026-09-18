/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { dueForCheck, isNewerVersion, readManifestVersion } from './updateVersion.ts';

suite('isNewerVersion', () => {

	test('a later patch is newer', () => {
		assert.strictEqual(isNewerVersion('0.5.25', '0.5.24'), true);
	});

	test('the same version is not newer', () => {
		assert.strictEqual(isNewerVersion('0.5.24', '0.5.24'), false);
	});

	test('an older version is not newer', () => {
		assert.strictEqual(isNewerVersion('0.5.23', '0.5.24'), false);
	});

	test('fields are compared as numbers, not as strings', () => {
		// The whole reason this is not a string comparison: '0.5.10' > '0.5.9'
		// is false as text, which would hide every release between .9 and .20.
		assert.strictEqual(isNewerVersion('0.5.10', '0.5.9'), true);
		assert.strictEqual(isNewerVersion('0.10.0', '0.9.99'), true);
		assert.strictEqual(isNewerVersion('1.0.0', '0.99.99'), true);
	});

	test('a missing field counts as zero', () => {
		assert.strictEqual(isNewerVersion('0.6', '0.5.24'), true);
		assert.strictEqual(isNewerVersion('0.5', '0.5.0'), false);
	});

	test('a field that cannot be read as a number answers "not newer"', () => {
		// Offering a downgrade is the unrecoverable direction, so a version
		// this comparison cannot read is never announced.
		assert.strictEqual(isNewerVersion('latest', '0.5.24'), false);
		assert.strictEqual(isNewerVersion('0.5.25', 'unknown'), false);
		assert.strictEqual(isNewerVersion('0.5.25-rc.1', '0.5.25'), false);
	});

	test('the comparison stops at the first differing field', () => {
		// So a suffix further along never gets a say: 0.6.0-rc.1 really is a
		// later release than 0.5.24, and it is decided on the minor field.
		assert.strictEqual(isNewerVersion('0.6.0-rc.1', '0.5.24'), true);
	});
});

suite('readManifestVersion', () => {

	test('reads the version of a manifest', () => {
		assert.strictEqual(readManifestVersion({ name: 'x', version: '0.5.25' }), '0.5.25');
	});

	test('trims it', () => {
		assert.strictEqual(readManifestVersion({ version: ' 0.5.25\n' }), '0.5.25');
	});

	test('anything that is not a non-empty string is nothing to say', () => {
		// The body is whatever the network answered: a proxy login page, an
		// HTML error, a document whose `version` is a number.
		assert.strictEqual(readManifestVersion(undefined), undefined);
		assert.strictEqual(readManifestVersion(null), undefined);
		assert.strictEqual(readManifestVersion('0.5.25'), undefined);
		assert.strictEqual(readManifestVersion({}), undefined);
		assert.strictEqual(readManifestVersion({ version: 5 }), undefined);
		assert.strictEqual(readManifestVersion({ version: '  ' }), undefined);
		assert.strictEqual(readManifestVersion({ version: { major: 1 } }), undefined);
	});
});

suite('dueForCheck', () => {

	const hour = 60 * 60 * 1000;

	test('never checked is due', () => {
		assert.strictEqual(dueForCheck(undefined, 1_000_000, 6 * hour), true);
		assert.strictEqual(dueForCheck(0, 1_000_000, 6 * hour), true);
	});

	test('inside the interval is not due', () => {
		assert.strictEqual(dueForCheck(1_000_000, 1_000_000 + hour, 6 * hour), false);
	});

	test('the interval itself is due', () => {
		assert.strictEqual(dueForCheck(1_000_000, 1_000_000 + 6 * hour, 6 * hour), true);
	});

	test('a stamp in the future is due, not six hours of silence', () => {
		// A clock that moved, or a machine restored from a backup, would
		// otherwise buy silence that never expires.
		assert.strictEqual(dueForCheck(9_000_000, 1_000_000, 6 * hour), true);
	});

	test('an unreadable stamp is due', () => {
		assert.strictEqual(dueForCheck('whenever', 1_000_000, 6 * hour), true);
	});
});
