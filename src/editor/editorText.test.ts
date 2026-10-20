/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { cutText, insideFolder, lineArgument, lineSnippet, symbolColumn } from './editorText.ts';

suite('editor text', () => {

	test('a path is inside its folder; a sibling that only starts like it is not', () => {
		assert.ok(insideFolder('/w/app', '/w/app', '/'));
		assert.ok(insideFolder('/w/app', '/w/app/src/a.ts', '/'));
		assert.ok(!insideFolder('/w/app', '/w/app-old/a.ts', '/'));
		assert.ok(!insideFolder('/w/app', '/w/app/../secret', '/'));
		assert.ok(!insideFolder('/w/app', '/home/u/.ssh/id_rsa', '/'));
		assert.ok(insideFolder('C:\\w\\app', 'C:\\w\\app\\src\\a.ts', '\\'));
		assert.ok(!insideFolder('C:\\w\\app', 'D:\\other', '\\'));
	});

	test('a symbol is found as a whole identifier before a substring', () => {
		const line = 'const userTab = this.userTabs.find(t => t === userTab);';
		assert.strictEqual(symbolColumn(line, 'userTab'), 6);
		assert.strictEqual(symbolColumn(line, 'userTab', 2), line.lastIndexOf('userTab'));
		assert.strictEqual(symbolColumn(line, 'userTabs'), line.indexOf('userTabs'));
		assert.strictEqual(symbolColumn('function $set() {}', '$set'), 9);
		assert.strictEqual(symbolColumn('fooBar()', 'Bar'), 3);
		assert.strictEqual(symbolColumn('nothing here', 'x'), -1);
		assert.strictEqual(symbolColumn('a', ''), -1);
		// A second `tab` that is only inside `tabs` is not a second `tab`.
		assert.strictEqual(symbolColumn('tab, tabs', 'tab', 2), -1);
		assert.strictEqual(symbolColumn('fooBar, bazBar', 'Bar', 2), 11);
	});

	test('lines are trimmed and cut, selections cut outside a surrogate pair', () => {
		assert.strictEqual(lineSnippet('   return   value;  '), 'return value;');
		assert.strictEqual(lineSnippet('x'.repeat(300)).length, 200);
		assert.deepStrictEqual(cutText('abc', 5), { text: 'abc' });
		assert.deepStrictEqual(cutText('ab😀', 3), { text: 'ab', truncated: true });
	});

	test('a line number is a positive whole number or nothing', () => {
		assert.strictEqual(lineArgument(12), 12);
		assert.strictEqual(lineArgument('7'), 7);
		assert.strictEqual(lineArgument(0), undefined);
		assert.strictEqual(lineArgument(1.5), undefined);
		assert.strictEqual(lineArgument('x'), undefined);
		assert.strictEqual(lineArgument(undefined), undefined);
	});
});
