import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { transpileModule } from 'typescript';

test('connection chips retain clicks during streaming, manage the correct chat, and show remote viewers access without granting controls', () => {
	const source = readFileSync('preview-src/chat.ts', 'utf8');
	const render = /function renderAttachments\([\s\S]*?\n\}/.exec(source)![0];
	const posted: unknown[] = [];
	const node = (_tag: string, props: object = {}, ...children: any[]) => ({ ...props, children, hidden: false, disabled: false,
		listeners: {} as Record<string, () => void>, addEventListener(type: string, fn: () => void) { this.listeners[type] = fn; } });
	const row = { hidden: true, children: [] as any[], replaceChildren(...children: any[]) { this.children = children; } };
	const run = runInNewContext(transpileModule(`let attachmentsShown = ''; ${render}; renderAttachments;`, {}).outputText, {
		button: (children: any[], props: object) => node('button', props, ...children), el: node, icon: (name: string) => name,
		post: (message: unknown) => posted.push(message), attachmentsRow: row,
		browserButton: { classList: { toggle() {} } }, plusButton: { classList: { toggle() {} } }, suggestionNode() {}, fileIconsSignature: '', chipShown: (chip: unknown) => chip,
		isPinChip: () => false, pinChipNode() {}, browserPinNode() {}, autosize() {}, toolbarLayoutShape: '', scheduleToolbarLayout() {},
	});
	const state: any = { chatId: 'a', suggestions: [], attachments: [], linkedChats: [{ chatId: 'b', title: 'Research', access: 'readWrite', available: true }] };
	run(state);
	assert.equal(row.hidden, false);
	const chip = row.children[0];
	assert.match(chip.children[1].children[1].text, /Read and add notes/);
	run(state);
	assert.equal(row.children[0], chip, 'streaming must not replace a focused chip');
	chip.children[1].listeners.click(); chip.children[0].listeners.click();
	assert.equal(JSON.stringify(posted), JSON.stringify([{ type: 'connectChat', chatId: 'a', targetChatId: 'b' }, { type: 'disconnectChat', chatId: 'a', targetChatId: 'b' }]));
	state.linkedChats[0].owned = true; state.linkedChats[0].taskState = 'running'; run(state);
	assert.match(row.children[0].children[1].children[1].text, /Worker: running/);
	state.linkedChats[0].taskState = 'completed'; run(state);
	assert.match(row.children[0].children[1].children[1].text, /Worker: completed/);
	state.surface = 'chrome'; run(state);
	assert.equal(row.children[0].children[0].hidden, true);
	assert.equal(row.children[0].children[1].disabled, true);
	state.linkedChats = []; run(state);
	assert.equal(row.hidden, true);
});
