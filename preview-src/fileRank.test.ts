/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { describe, test } from 'node:test';
import { baseName, depth, rankPath, searchPaths } from './fileRank.ts';

describe('fileRank', () => {
	test('a folder ends with a slash, which is not part of its name', () => {
		assert.strictEqual(baseName('src/chat/'), 'chat');
		assert.strictEqual(baseName('src/chat/chatView.ts'), 'chatView.ts');
		assert.strictEqual(depth('src/chat/'), 1);
		assert.strictEqual(depth('README.md'), 0);
	});

	test('the name before the path, and the start of the name before the rest', () => {
		assert.strictEqual(rankPath('src/chat/chatView.ts', 'chat'), 0);
		assert.strictEqual(rankPath('src/chat/myChatView.ts', 'chatview'), 1);
		assert.strictEqual(rankPath('src/chat/agents.ts', 'chat'), 2);
		assert.strictEqual(rankPath('src/chat/agents.ts', 'src agents'), 3);
		assert.strictEqual(rankPath('src/chat/chatView.ts', 'cvts'), 4);
		assert.strictEqual(rankPath('src/chat/chatView.ts', 'zz'), undefined);
	});

	test('a query with a slash is about the path', () => {
		assert.strictEqual(rankPath('src/chat/chatView.ts', 'chat/chat'), 2);
		assert.strictEqual(rankPath('src/chat/chatView.ts', 'x/chat'), undefined);
	});

	test('without a query, the top level, folders first', () => {
		assert.deepStrictEqual(searchPaths(['b.md', 'a.md', 'src/', 'src/x.ts', 'docs/'], '', 10), ['docs/', 'src/', 'a.md', 'b.md']);
	});

	test('ties go to the shallower, then the shorter', () => {
		assert.deepStrictEqual(searchPaths(['a/b/view.ts', 'view.ts', 'a/view.tsx', 'a/view.ts'], 'view', 3), ['view.ts', 'a/view.ts', 'a/view.tsx']);
	});
});
