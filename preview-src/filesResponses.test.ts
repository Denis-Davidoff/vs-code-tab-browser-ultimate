import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';

test('Files ignores stale responses, including returning to the same folder and drops on other crumbs', () => {
	const source = readFileSync('preview-src/chat.ts', 'utf8');
	const lift = (name: string) => new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`).exec(source)![0];
	const posted: any[] = [];
	const context: any = { filesFolder: '/project', filesDir: 'A', filesRequest: 0, filesListingRequest: 0, filesSelected: new Set(), filesEntries: [], filesPending: false,
		post: (message: any) => posted.push(message), renderFiles() {}, filesPathCompletions() {},
	};
	const api = runInNewContext(transpileModule([lift('filesPost'), lift('filesAnswer'), '({ filesPost, filesAnswer });'].join('\n'), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, context);
	api.filesPost('list');
	const oldA = posted.at(-1);
	context.filesDir = 'B'; api.filesPost('list');
	const b = posted.at(-1);
	context.filesDir = 'A'; api.filesPost('list');
	const newA = posted.at(-1);
	api.filesAnswer({ ...newA, entries: [{ name: 'new', dir: false }] });
	api.filesAnswer({ ...b, entries: [{ name: 'B', dir: false }] });
	api.filesAnswer({ ...oldA, entries: [{ name: 'stale', dir: false }] });
	assert.equal(context.filesDir, 'A');
	assert.equal(context.filesEntries[0].name, 'new');
	api.filesPost('drop', { dir: 'other', uris: [] });
	api.filesAnswer({ ...posted.at(-1), entries: [{ name: 'other', dir: false }] });
	assert.equal(context.filesDir, 'A');
	assert.equal(context.filesEntries[0].name, 'new');
	assert.equal(context.filesPending, false);
});
