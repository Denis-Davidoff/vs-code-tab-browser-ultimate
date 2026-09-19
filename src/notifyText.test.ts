/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { plainInNotification } from './notifyText.ts';

suite('plainInNotification', () => {

	// A notification body is rendered as linked text and its links are opened
	// with `allowCommands: true`, so `[label](command:…)` in a page title is a
	// button that runs a command on one click. The page chooses its own title,
	// so there is no shape to validate against the way a version has one.
	test('a command link cannot survive', () => {
		const hostile = '[Retry](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22rm%22%7D)';
		const safe = plainInNotification(hostile);

		assert.ok(!safe.includes('['), 'no label can be opened');
		assert.ok(!safe.includes(']'), 'no label can be closed');
		assert.ok(!/\[[^\]]*\]\(/.test(safe), 'the link pattern is gone');
	});

	test('a link written around ordinary text is neutralised too', () => {
		assert.strictEqual(
			plainInNotification('Orders [Open](command:foo) page'),
			'Orders Open(command:foo) page');
	});

	test('an ordinary title is left as the page wrote it', () => {
		assert.strictEqual(plainInNotification('Orders — Acme Admin'), 'Orders — Acme Admin');
	});

	// Not security: a page can set a title of any length, and a notification is
	// one line with a close button.
	test('a very long title is capped', () => {
		const result = plainInNotification('x'.repeat(500));
		assert.strictEqual(result.length, 80);
		assert.ok(result.endsWith('…'));
	});

	test('a title exactly at the limit is untouched', () => {
		const exact = 'y'.repeat(80);
		assert.strictEqual(plainInNotification(exact), exact);
	});

	test('newlines and runs of whitespace collapse to one line', () => {
		assert.strictEqual(plainInNotification('  Orders\n\tAcme   Admin  '), 'Orders Acme Admin');
	});

	test('an empty title stays empty rather than becoming an ellipsis', () => {
		assert.strictEqual(plainInNotification(''), '');
	});
});
