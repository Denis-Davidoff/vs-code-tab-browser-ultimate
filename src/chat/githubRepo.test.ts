/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { describe, test } from 'node:test';
import { cloneUrl, compareUrl, defaultBranchOf, parseRepo, validBranch, workBranchName } from './githubRepo.ts';

describe('parseRepo', () => {
	test('every usual spelling of one repository', () => {
		for (const typed of [
			'microsoft/vscode', ' microsoft/vscode ', 'https://github.com/microsoft/vscode', 'https://github.com/microsoft/vscode.git',
			'github.com/microsoft/vscode/', 'https://www.github.com/microsoft/vscode/tree/main/src', 'git@github.com:microsoft/vscode.git',
			'https://github.com/microsoft/vscode?tab=readme',
		]) {
			assert.deepStrictEqual(parseRepo(typed), { owner: 'microsoft', name: 'vscode' }, typed);
		}
	});

	test('another host, a transport, or a malformed name is refused', () => {
		for (const typed of [
			'https://gitlab.com/a/b', 'ext::sh -c touch% /tmp/x', 'file:///etc/passwd', 'a', 'a/', '/b', '-x/y', 'a b/c', 'a/..', 'a/b c',
			'git@gitlab.com:a/b.git', 'example.com/a/b',
		]) {
			assert.strictEqual(parseRepo(typed), undefined, typed);
		}
	});

	test('the clone address is built, never taken as typed', () => {
		assert.strictEqual(cloneUrl(parseRepo('git@github.com:o/r.git')!), 'https://github.com/o/r.git');
	});
});

describe('branches', () => {
	test('a usual branch is taken; an option or an invalid ref is not', () => {
		assert.strictEqual(validBranch(' feature/x-1 '), 'feature/x-1');
		for (const bad of ['', '-f', '--upload-pack=x', 'a..b', 'a b', 'x.lock', 'x/', 'a@{1}', 'a//b']) {
			assert.strictEqual(validBranch(bad), undefined, bad);
		}
	});

	test('a work branch is ours, dated', () => {
		assert.strictEqual(workBranchName(new Date(2026, 9, 17, 9, 5), 'AB-12cd-99'), 'ai-browser/20261017-0905-ab12cd');
	});

	test('the default branch from the remote HEAD', () => {
		assert.strictEqual(defaultBranchOf('origin/main\n'), 'main');
		assert.strictEqual(defaultBranchOf('main'), undefined);
	});

	test('a pull request page', () => {
		assert.strictEqual(compareUrl({ owner: 'o', name: 'r' }, 'main', 'ai-browser/x'), 'https://github.com/o/r/compare/main...ai-browser/x?expand=1');
	});
});
