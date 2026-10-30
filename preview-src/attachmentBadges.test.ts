import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule, ScriptTarget } from 'typescript';
import { attachmentMarker, readAttachmentMarkers } from './attachmentMarkers.ts';

const source = readFileSync('preview-src/chat.ts', 'utf8');
const lift = (name: string) => new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`).exec(source)![0];

function fixture() {
	const handlers = new Map<string, ((event: any) => void)[]>();
	const documentHandlers = new Map<string, ((event: any) => void)[]>();
	const input = {
		value: '', selectionStart: 0, selectionEnd: 0, selectionDirection: 'forward', style: {},
		setSelectionRange(start: number, end: number, direction = 'forward') { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; },
		addEventListener(name: string, fn: (event: any) => void) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
		focus() {},
		getBoundingClientRect: () => ({ left: 0, right: 300, top: 0, bottom: 100 }),
	};
	const posted: unknown[] = [];
	let dropOffset = 0;
	const chip = { id: 'file', reference: '@1', label: 'file.ts', filePath: '/project/file.ts', kind: 'file' };
	const document = {
		activeElement: input, addEventListener(name: string, fn: (event: any) => void) { documentHandlers.set(name, [...documentHandlers.get(name) ?? [], fn]); }, createTextNode: (text: string) => ({ textContent: text }),
		body: { append() {} },
		execCommand(command: string) { commands.push(command); return true; },
		caretRangeFromPoint: () => ({ startContainer: inputMirror, startOffset: dropOffset }),
		createRange: () => ({ selectNodeContents() {}, setEnd() {}, toString: () => input.value.slice(0, dropOffset) }),
	};
	const commands: string[] = [];
	const rect = { left: 10, right: 150, top: 10, bottom: 30 };
	const inputMirror = { style: {}, contains: () => true, querySelectorAll: () => [{ cloneNode: () => ({ style: {}, classList: { add() {} }, remove() {} }), getBoundingClientRect: () => ({ ...rect, height: 20 }), getClientRects: () => [rect], querySelector: () => ({ classList: { add() {}, remove() {} }, getBoundingClientRect: () => ({ ...rect, left: 130 }) }) }] };
	const element = (_tag: string, props: any = {}, ...children: any[]) => ({
		textContent: (props.text ?? '') + children.map(c => c.textContent ?? c).join(''),
		className: props.class, classList: { add() {} },
	});
	const context = {
		input, inputMirror, document, draftChat: 'chat', commands,
		window: { addEventListener() {} }, gate: () => ({ s: 'on' }),
		attachmentClipboardType: 'application/x-ai-browser-attachments',
		attachmentMarker, readAttachmentMarkers,
		state: {}, chipOfToken: () => chip, syncAttachmentTokens() {},
		post: (message: unknown) => posted.push(message),
		rememberAttachmentCaret() {}, saveDraft() {}, autosize() {}, renderSend() {}, paintInput() {},
		el: element, chipIcon: () => element('i'), icon: () => element('i'),
	};
	const code = [source.match(/const attachmentTokenPattern = [^\n]+/)![0],
		...['attachmentToken', 'tokensIn', 'setInputText', 'plainToken', 'markAttachmentTokens', 'copyAttachments'].map(lift),
		source.slice(source.indexOf('/** A right-click on a token:'), source.indexOf('function attachmentIcon(')),
		'({ attachmentToken, tokensIn, snapToTokens, copyAttachments, copyToken, markAttachmentTokens, moveAttachmentText });',
	].join('\n');
	const api = runInNewContext(transpileModule(code, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, context);
	const event = (name: string, data: any = {}, onDocument = false) => {
		const e = { preventDefault() {}, stopPropagation() {}, ...data };
		for (const handler of (onDocument ? documentHandlers : handlers).get(name) ?? []) { handler(e); }
	};
	return { input, chip, posted, api, event, commands, dropAt: (offset: number) => { dropOffset = offset; } };
}

test('badge mirror keeps exactly the text and whitespace of its token', () => {
	const f = fixture();
	for (const label of ['file.ts', 'folder with spaces/', 'a very long name '.repeat(9)]) {
		const token = f.api.attachmentToken({ ...f.chip, label });
		const nodes = f.api.markAttachmentTokens(`Before ${token} after`, () => f.chip, (text: string) => [{ textContent: text }]);
		assert.equal(nodes.map((node: any) => node.textContent).join(''), `Before ${token} after`);
	}
});

test('partial selections expand to the complete badge and copy path plus attachment metadata', () => {
	const f = fixture();
	const token = f.api.attachmentToken(f.chip);
	f.input.value = `Before ${token} after`;
	f.input.setSelectionRange(10, 14);
	const clipboard = new Map();
	f.api.copyAttachments({ clipboardData: { setData: (kind: string, value: string) => clipboard.set(kind, value) }, preventDefault() {} }, false);
	assert.equal(f.input.selectionStart, 7);
	assert.equal(f.input.selectionEnd, 7 + token.length);
	assert.equal(clipboard.get('text/plain'), attachmentMarker(f.chip));
	const rich = JSON.parse(clipboard.get('application/x-ai-browser-attachments'));
	assert.equal(rich.items[0].id, f.chip.id);
	assert.equal(rich.text, token);
});

test('Shift+arrow selects the whole badge as one character', () => {
	const f = fixture();
	const token = f.api.attachmentToken(f.chip);
	f.input.value = token;
	f.input.setSelectionRange(0, 0);
	f.event('keydown', { key: 'ArrowRight', shiftKey: true });
	assert.equal(f.input.selectionStart, 0);
	assert.equal(f.input.selectionEnd, token.length);
	f.input.setSelectionRange(token.length, token.length);
	f.event('keydown', { key: 'ArrowLeft', shiftKey: true });
	assert.equal(f.input.selectionStart, 0);
	assert.equal(f.input.selectionEnd, token.length);
	assert.equal(f.input.selectionDirection, 'backward');
});

test('click opens the attachment, Shift+click selects, and the remove button does not open it', () => {
	const f = fixture();
	f.input.value = f.api.attachmentToken(f.chip);
	const click = (x: number, shiftKey = false) => {
		f.event('mousedown', { button: 0, clientX: x, clientY: 20 });
		f.event('click', { clientX: x, clientY: 20, shiftKey });
	};
	click(50);
	assert.equal(JSON.stringify(f.posted), JSON.stringify([{ type: 'openAttachment', id: f.chip.id }]));
	assert.equal(f.input.selectionEnd, f.input.value.length);
	click(50, true);
	assert.equal(f.posted.length, 1);
	click(140);
	assert.equal(f.input.value, '');
	assert.equal(f.posted.length, 1);
});

test('moving a badge in either direction preserves other text and drops inside itself are harmless', () => {
	const f = fixture();
	const token = f.api.attachmentToken(f.chip);
	const text = `abc${token}xyz`;
	assert.equal(f.api.moveAttachmentText(text, 3, 3 + token.length, 0).text, `${token}abcxyz`);
	assert.equal(f.api.moveAttachmentText(text, 3, 3 + token.length, text.length).text, `abcxyz${token}`);
	assert.equal(f.api.moveAttachmentText(text, 3, 3 + token.length, 5).text, text);
});

test('badge menu copy and cut use the native rich clipboard handlers', () => {
	const f = fixture();
	f.input.value = f.api.attachmentToken(f.chip);
	f.api.copyToken({ start: 0, end: f.input.value.length }, false);
	f.api.copyToken({ start: 0, end: f.input.value.length }, true);
	assert.deepEqual(f.commands, ['copy', 'cut']);
});

test('mouse dragging moves the whole badge even when the pointer has left its original bounds', () => {
	const f = fixture();
	const token = f.api.attachmentToken(f.chip);
	f.input.value = `Before ${token} after`;
	f.event('mousedown', { button: 0, clientX: 12, clientY: 20 });
	f.dropAt(f.input.value.length);
	f.event('mousemove', { buttons: 1, clientX: 200, clientY: 20 }, true);
	f.event('mouseup', { clientX: 200, clientY: 20 }, true);
	assert.equal(f.input.value, `Before  after${token}`);
	assert.equal(f.posted.length, 0);
});

test('dropping outside the input or pressing Escape cancels a badge move', () => {
	for (const escape of [false, true]) {
		const f = fixture();
		const value = `Before ${f.api.attachmentToken(f.chip)} after`;
		f.input.value = value;
		f.event('mousedown', { button: 0, clientX: 50, clientY: 20 });
		f.dropAt(value.length);
		f.event('mousemove', { buttons: 1, clientX: 200, clientY: 20 }, true);
		if (escape) { f.event('keydown', { key: 'Escape' }, true); }
		f.event('mouseup', { clientX: escape ? 200 : 400, clientY: 20 }, true);
		f.event('click', { clientX: 200, clientY: 20 });
		assert.equal(f.input.value, value);
		assert.equal(f.posted.length, 0);
	}
});
