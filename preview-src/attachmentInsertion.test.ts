import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

test('chip insertion updates visible composer and draft after editing a skill prompt', () => {
	const source = readFileSync(resolve('preview-src/chat.ts'), 'utf8');
	const body = /function insertAttachmentReference\(reference: string\): void \{[\s\S]*?\n\}/.exec(source)?.[0];
	assert.ok(body);
	let draft = '';
	let mirror = '';
	let refreshed = false;
	const input = {
		value: 'Please use',
		focus() {},
		setRangeText(text: string, start: number, end: number) {
			this.value = this.value.slice(0, start) + text + this.value.slice(end);
		},
	};
	const skillPrompt = {};
	const context = {
		input, paletteTarget: skillPrompt, attachmentCaret: undefined, draftChat: 'chat',
		rememberAttachmentCaret() {},
		saveDraft() { draft = input.value; },
		autosize() { mirror = input.value; },
		renderSend() { refreshed = true; },
		// This is the editor-specific path that must not handle a composer insertion.
		afterBoxEdit() { assert.fail('composer insertion used the stale palette target'); },
	};
	const code = transpileModule(`${body}\ninsertAttachmentReference('@2');`, {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	runInNewContext(code, context);
	assert.equal(input.value, 'Please use @2 ');
	assert.equal(draft, input.value);
	assert.equal(mirror, input.value);
	assert.equal(refreshed, true);
});
