import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { localFileLink } from './fileLinks.ts';

test('local Markdown links preserve paths and extract editor positions', () => {
	assert.deepEqual(localFileLink('/project/app.ts:12:3'), { path: '/project/app.ts', line: 12, column: 3 });
	assert.deepEqual(localFileLink('src/app.ts#L42'), { path: 'src/app.ts', line: 42, column: undefined });
	assert.deepEqual(localFileLink('file:///tmp/My%20Folder/app.ts#L8C2'), { path: '/tmp/My Folder/app.ts', line: 8, column: 2 });
	assert.deepEqual(localFileLink('../folder/'), { path: '../folder/' });
	assert.deepEqual(localFileLink('~/file.txt'), { path: '~/file.txt' });
	assert.deepEqual(localFileLink('C:\\project\\app.ts:9'), { path: 'C:\\project\\app.ts', line: 9, column: undefined });
});

test('web links, executable schemes, remote hosts and invalid paths are excluded', () => {
	for (const target of ['https://example.com/a', 'http://localhost/a', 'command:workbench.action.quit', 'vscode://file/tmp/a', 'javascript:alert(1)', 'data:text/html,test', 'file://server/share/a', '//server/share', '\\\\server\\share', '#heading', '', '/tmp/%00bad', '/tmp/a\nb']) {
		assert.equal(localFileLink(target), undefined, target);
	}
});
