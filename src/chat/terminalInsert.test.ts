/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { isTerminalInsertKind, quotePath, terminalInsertLimit, terminalInsertPayload } from './terminalInsert.ts';
import { sanitizePaste } from './terminalLogic.ts';

suite('terminalInsertPayload', () => {
	test('a page address goes in bracketed, with no Enter', () => {
		const out = terminalInsertPayload({ text: 'https://example.com/a — Example\n' }, true, sanitizePaste);
		assert.strictEqual(out, '\x1b[200~https://example.com/a — Example\x1b[201~');
	});
	test('a title cannot end the bracket or type a key', () => {
		const out = terminalInsertPayload({ text: 'x\x1b[201~rm -rf ~\r' }, true, sanitizePaste)!;
		assert.strictEqual(out.indexOf('\x1b[201~'), out.length - 6);
		assert.ok(!out.slice(6, -6).includes('\x1b'));
	});
	test('without bracketed paste a multi-line item is one line', () => {
		assert.strictEqual(terminalInsertPayload({ text: 'a\nb\r\n  c\n' }, false, sanitizePaste), 'a b c');
	});
	test('bracketed keeps inner line breaks', () => {
		assert.strictEqual(terminalInsertPayload({ text: 'a\r\nb' }, true, sanitizePaste), '\x1b[200~a\nb\x1b[201~');
	});
	test('paths are quoted and followed by a space', () => {
		assert.strictEqual(terminalInsertPayload({ paths: ['/tmp/a.png', "/tmp/it's me.png"] }, false, sanitizePaste), "/tmp/a.png '/tmp/it'\\''s me.png' ");
	});
	test('empty or too long is refused', () => {
		assert.strictEqual(terminalInsertPayload({ text: '\x1b\x07' }, true, sanitizePaste), undefined);
		assert.strictEqual(terminalInsertPayload({ paths: [] }, true, sanitizePaste), undefined);
		assert.strictEqual(terminalInsertPayload({ text: 'x'.repeat(terminalInsertLimit + 1) }, false, sanitizePaste), undefined);
	});
	test('quotePath and kinds', () => {
		assert.strictEqual(quotePath('/Users/a/.ai-browser/x.png'), '/Users/a/.ai-browser/x.png');
		assert.strictEqual(quotePath('/a b'), "'/a b'");
		assert.ok(isTerminalInsertKind('screenshot'));
		assert.ok(!isTerminalInsertKind('voice'));
	});
});
