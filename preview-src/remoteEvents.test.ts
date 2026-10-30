import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';
import { isBackgroundCompletion } from './remoteEvents.ts';

test('PR completion clears pending state while another conversation is selected', () => {
	const source = readFileSync('preview-src/chat.ts', 'utf8');
	const handler = source.slice(source.indexOf("  case 'githubStatus': {"), source.indexOf("  case 'workdirGit': {"));
	const pending = new Set(['/a']);
	let rendered = false;
	const receive = runInNewContext(transpileModule(`(message) => { switch(message.type) { ${handler} } }`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, {
		githubPrCreatingIn: pending, gitFolder: '/b', renderComposerGithub: () => { rendered = true; },
	});
	const message = { type: 'githubStatus' as const, folder: '/a', createError: 'Request failed' };
	assert.equal(isBackgroundCompletion(message), true);
	receive(message);
	assert.equal(pending.size, 0);
	assert.equal(rendered, false, 'completion must not overwrite the currently selected folder');
	assert.equal(isBackgroundCompletion({ type: 'githubStatus', folder: '/a', created: { number: 1, url: 'https://example.test/pr/1' } }), true);
	assert.equal(isBackgroundCompletion({ type: 'githubStatus', folder: '/a' }), false);
	assert.equal(isBackgroundCompletion(undefined), false);
});
