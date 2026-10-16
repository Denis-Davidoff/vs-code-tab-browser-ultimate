/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { describe, test } from 'node:test';
import { diffSides, hunkGap } from './diffSides.ts';

describe('diffSides', () => {
	test("Claude Code's Edit: removed lines before, added lines after", () => {
		assert.deepStrictEqual(diffSides('-const a = 1;\n-const b = 2;\n+const a = 3;'), {
			before: 'const a = 1;\nconst b = 2;',
			after: 'const a = 3;',
		});
	});

	test("Claude Code's Write: an empty before", () => {
		assert.deepStrictEqual(diffSides('+line one\n+line two'), { before: '', after: 'line one\nline two' });
	});

	test('a unified diff keeps its context lines on both sides, without the leading space', () => {
		assert.deepStrictEqual(diffSides('@@ -1,3 +1,3 @@\n keep\n-old\n+new\n tail'), {
			before: 'keep\nold\ntail',
			after: 'keep\nnew\ntail',
		});
	});

	test('a second hunk is set off in both sides', () => {
		const { before, after } = diffSides('@@ -1 +1 @@\n-a\n+b\n@@ -40 +40 @@\n-c\n+d');
		assert.strictEqual(before, `a\n${hunkGap}\nc`);
		assert.strictEqual(after, `b\n${hunkGap}\nd`);
	});

	test('file headers and "no newline" markers are left out', () => {
		const diff = 'diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b';
		assert.deepStrictEqual(diffSides(diff), { before: 'a', after: 'b' });
	});

	test('inside a hunk, a line starting "--- " is a removed line, not a header', () => {
		assert.deepStrictEqual(diffSides('@@ -1 +1 @@\n--- a yaml document\n+++ more'), { before: '-- a yaml document', after: '++ more' });
	});

	test("an Edit removing a SQL comment keeps it: '--- x' alone is not a file header", () => {
		assert.deepStrictEqual(diffSides('--- note\n-select 1;\n+select 2;'), { before: '-- note\nselect 1;', after: 'select 2;' });
	});

	test('CRLF line ends are read like LF', () => {
		assert.deepStrictEqual(diffSides('-a\r\n+b\r\n same'), { before: 'a\nsame', after: 'b\nsame' });
	});
});
