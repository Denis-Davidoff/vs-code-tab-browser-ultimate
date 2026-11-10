import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule } from 'typescript';

const source = readFileSync('preview-src/chat.ts', 'utf8');
const lift = (name: string) => new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`).exec(source)![0];

function fixture() {
	const classes = new Set<string>();
	const attributes = new Map<string, string>();
	const sendButton = { disabled: true, title: '', classList: { add: (...n: string[]) => n.forEach(x => classes.add(x)), remove: (...n: string[]) => n.forEach(x => classes.delete(x)) }, setAttribute: (k: string, v: string) => attributes.set(k, v) };
	const env = {
		state: { running: false, attachments: [] as any[], surface: undefined as string | undefined },
		input: { value: '' }, sendButton, sendOptionsButton: { disabled: false }, posted: [] as any[],
		clipboardHasText: false, composerWasEmpty: false, clipboardPeekedAt: 0, pendingPasteCount: 0, stopRequested: undefined,
		isPinChip: (chip: any) => chip.pinned === true, closeSendMenu() {}, setIcon() {},
		Date, post(message: unknown) { env.posted.push(message); },
	};
	const code = ['composerEmpty', 'canPasteHere', 'pasteMode', 'peekClipboard', 'renderPaste'].map(lift).join('\n');
	const renderPaste = runInNewContext(transpileModule(code, {}).outputText + '\nrenderPaste;', env);
	return { env, classes, attributes, renderPaste };
}

test('an empty box asks once whether the clipboard holds text, not on every render', () => {
	const f = fixture();
	f.renderPaste(false);
	f.renderPaste(false);
	assert.equal(JSON.stringify(f.env.posted), JSON.stringify([{ type: 'composerClipboard', action: 'peek' }]));
});

test('with text on the clipboard and an empty box the button is Paste; typing brings Send back', () => {
	const f = fixture();
	f.env.clipboardHasText = true;
	assert.equal(f.renderPaste(false), true);
	assert.equal(f.attributes.get('aria-label'), 'Paste');
	assert.ok(f.classes.has('paste'));
	assert.equal(f.env.sendOptionsButton.disabled, true);
	f.env.input.value = 'hello';
	assert.equal(f.renderPaste(true), false);
	assert.ok(!f.classes.has('paste'));
});

test('no Paste while the agent runs (Stop keeps its place), with chips in the box, or away from the editor', () => {
	for (const change of [(e: any) => { e.state.running = true; }, (e: any) => { e.state.attachments = [{ kind: 'file' }]; }, (e: any) => { e.state.surface = 'chrome'; }]) {
		const f = fixture();
		f.env.clipboardHasText = true;
		change(f.env);
		assert.equal(f.renderPaste(false), false);
	}
	const pinned = fixture();
	pinned.env.clipboardHasText = true;
	pinned.env.state.attachments = [{ kind: 'terminal', pinned: true }];
	assert.equal(pinned.renderPaste(false), true, 'a pinned terminal is not draft content');
});

test('a paste answer that lands after a switch to another conversation is not typed into its box', () => {
	const typed: string[] = [];
	const env: any = {
		state: { chatId: 'b' }, clipboardHasText: false, pasteRequestedFor: 'a',
		input: { focus() {}, selectionStart: 0, selectionEnd: 0, setRangeText: (t: string) => typed.push(t), dispatchEvent() {} },
		pasteAttachmentTokens: () => false, renderSend() {}, Event: class { type: string; constructor(type: string) { this.type = type; } },
	};
	const answer = runInNewContext(transpileModule(lift('composerClipboardAnswer'), {}).outputText + '\ncomposerClipboardAnswer;', env);
	answer(true, 'secret');
	assert.deepEqual(typed, []);
	assert.equal(env.pasteRequestedFor, undefined);
	env.pasteRequestedFor = 'b';
	answer(true, 'hello');
	assert.deepEqual(typed, ['hello']);
});
