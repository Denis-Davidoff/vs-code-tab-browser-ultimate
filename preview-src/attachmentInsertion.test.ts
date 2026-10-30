import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

const source = readFileSync(resolve('preview-src/chat.ts'), 'utf8');
const lift = (name: string) => {
	const body = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`).exec(source)?.[0];
	assert.ok(body, name);
	return body;
};
const pattern = /const attachmentTokenPattern = [^\n]+/.exec(source)?.[0];

function sandbox(value: string, caret: number) {
	const posted: unknown[] = [];
	const input = {
		value, selectionStart: caret,
		setSelectionRange(start: number) { this.selectionStart = start; },
	};
	const context: Record<string, unknown> = {
		input, posted, draftChat: 'chat', fromHistory: false,
		attachmentCaret: { chat: 'chat', value, start: caret, end: caret },
		tokenedChips: new Map(), pastedTokens: new Map(), removedByToken: new Set(),
		pendingAttachmentPastes: new Map(),
		isPinChip: (chip: { terminalId?: string }) => !!chip.terminalId,
		post: (message: unknown) => posted.push(message),
		rememberAttachmentCaret() {}, saveDraft() {}, autosize() {}, renderSend() {}, paintInput() {},
	};
	const code = transpileModule([pattern, ...['attachmentToken', 'draftChips', 'tokensIn', 'setInputText', 'syncAttachmentTokens'].map(lift),
		'globalThis.sync = syncAttachmentTokens;'].join('\n'), {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	runInNewContext(code, context);
	return { input, posted, sync: context.sync as (s: unknown) => void };
}

const state = (chips: unknown[]) => ({ chatId: 'chat', attachments: chips });
const chip = { id: 'a', kind: 'file', label: 'tsconfig.json', reference: '@1' };

test('a new attachment is put into the text at the caret, as a token', () => {
	const box = sandbox('Please use now', 'Please use'.length);
	box.sync(state([chip]));
	assert.equal(box.input.value, 'Please use [@1  tsconfig.json      ] now');
	box.sync(state([chip]));
	assert.equal(box.input.value, 'Please use [@1  tsconfig.json      ] now', 'a token already there is not added twice');
});

test('deleting a token removes its attachment, and a label change follows the chip', () => {
	const box = sandbox('', 0);
	box.sync(state([chip]));
	box.sync(state([{ ...chip, label: 'other.json' }]));
	assert.equal(box.input.value, '[@1  other.json      ] ');
	box.input.value = 'plain';
	box.sync(state([chip]));
	assert.equal(JSON.stringify(box.posted), JSON.stringify([{ type: 'removeAttachment', id: 'a' }]));
	box.sync(state([chip]));
	assert.equal(box.posted.length, 1, 'asked once');
});
