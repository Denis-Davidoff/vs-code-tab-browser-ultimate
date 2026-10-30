import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';
import { composerLinks, composerListEdit, composerListStarter } from './composerFormatting.ts';

const source = readFileSync('preview-src/chat.ts', 'utf8');
const lift = (name: string) => new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`).exec(source)![0];

function fixture() {
	const posted: any[] = [], sent: any[] = [];
	const handlers = new Map<string, ((event: any) => void)[]>();
	const input = {
		value: '', selectionStart: 0, selectionEnd: 0, textContent: '', style: {},
		setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; },
		setRangeText(text: string, start: number, end: number) { this.value = this.value.slice(0, start) + text + this.value.slice(end); },
		addEventListener(name: string, handler: (event: any) => void) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
		dispatchEvent(event: any) { for (const handler of handlers.get(event.type) ?? []) { handler(event); } },
	};
	let items: any[] = [];
	const panel = { classList: { contains: () => false } };
	const context = {
		input, composerLinks, composerListEdit, composerListStarter, composerLinkPress: undefined, draggedAttachment: undefined,
		inputMirror: { querySelectorAll: () => [{ dataset: { url: 'https://google.com/' }, getClientRects: () => [{ left: 10, right: 150, top: 10, bottom: 30 }] }] },
		isMacView: true, modKey: '⌘', navigator: { platform: 'Mac' }, localFileLink: () => undefined,
		agentsPanel: panel, allAgentsPanel: panel, historyPanel: panel, agentAppsPanel: panel, skillEditor: panel,
		openMenu: (_anchor: any, rows: any[]) => { items = rows; }, post: (message: any) => posted.push(message),
		document: { createTextNode: (text: string) => ({ textContent: text }) },
		el: (_tag: string, props: any) => ({ textContent: props.text, dataset: {} }),
		markCommands: (text: string) => [{ textContent: text }], linkNode: (_url: string, text: string) => ({ textContent: text }),
		rememberAttachmentCaret() {}, Event: class { type: string; constructor(type: string) { this.type = type; } },
		paletteMode: undefined, paletteTarget: input, paletteKey: () => false, walking: () => false, recall: () => false,
		send: (mode?: string) => sent.push(mode),
	};
	const linkEvents = source.slice(source.indexOf('let composerLinkPress:'), source.indexOf('/** The mirror behind the box, kept to its text and its scroll. */'));
	const keys = source.slice(source.lastIndexOf("input.addEventListener('keydown', event => {"), source.indexOf("sendButton.addEventListener('click', () => {"));
	const api = runInNewContext(transpileModule([lift('markComposerText'), lift('composerLinkHit'), lift('linkMenu'), linkEvents, keys, '({ markComposerText });'].join('\n'), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, context);
	const event = (type: string, data: any = {}) => {
		let prevented = false;
		const event = { type, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, preventDefault() { prevented = true; }, stopPropagation() {}, ...data };
		input.dispatchEvent(event);
		return prevented;
	};
	const value = (text: string) => { input.value = text; input.setSelectionRange(text.length, text.length); };
	return { input, posted, sent, api, event, value, items: () => items };
}

test('real input handlers continue lists without sending; ordinary and modified Enter still send', () => {
	const f = fixture();
	f.value('1. Item');
	assert.equal(f.event('keydown', { key: 'Enter' }), true);
	assert.equal(f.input.value, '1. Item\n2. ');
	assert.equal(f.sent.length, 0);
	f.event('keydown', { key: 'Tab' });
	assert.equal(f.input.value, '1. Item\n  2. ');
	f.event('keydown', { key: 'Tab', shiftKey: true });
	assert.equal(f.input.value, '1. Item\n2. ');
	f.event('keydown', { key: 'Enter', metaKey: true });
	assert.deepEqual(f.sent, ['queue']);
	f.value('Ordinary message');
	f.event('keydown', { key: 'Enter' });
	assert.equal(f.sent.length, 2);
	assert.equal(f.event('keydown', { key: 'Enter', shiftKey: true }), false);
});

test('typing the bare starter normalizes it, while composition and Shift+Enter are left to the editor', () => {
	const f = fixture();
	f.value('1 '); f.event('input');
	assert.equal(f.input.value, '1. ');
	assert.equal(f.input.selectionStart, 3);
	f.value('1 '); f.event('input', { isComposing: true });
	assert.equal(f.input.value, '1 ');
	assert.equal(f.event('keydown', { key: 'Enter', isComposing: true }), false);
	assert.equal(f.sent.length, 0);
});

test('mirror links preserve the exact text and expose the normalized destination', () => {
	const f = fixture();
	const text = 'Visit https:/google.com and www.example.com.';
	const nodes = f.api.markComposerText(text, new Set());
	assert.equal(nodes.map((node: any) => node.textContent).join(''), text);
	assert.equal(nodes.find((node: any) => node.dataset?.url)?.dataset.url, 'https://google.com/');
});

test('draft URL clicks open internally or externally without opening a text selection', () => {
	const f = fixture();
	const click = (extra: any = {}) => {
		f.event('mousedown', { clientX: 20, clientY: 20 });
		f.event('click', { clientX: 20, clientY: 20, ...extra });
	};
	click(); click({ metaKey: true });
	assert.deepEqual(f.posted.map(message => message.external), [false, true]);
	assert.equal(f.posted[0].url, 'https://google.com/');
	f.input.setSelectionRange(0, 5); click();
	f.input.setSelectionRange(0, 0); click({ shiftKey: true });
	click({ clientX: 40 });
	assert.equal(f.posted.length, 2);
});

test('draft URL menu opens in either browser and copies the link', () => {
	const f = fixture();
	assert.equal(f.event('contextmenu', { clientX: 20, clientY: 20 }), true);
	for (const label of ['Open in AI Browser', 'Open in System Browser', 'Copy Link']) {
		f.items().find(item => item.label === label).run();
	}
	assert.equal(f.posted[0].type, 'openLink'); assert.equal(f.posted[0].external, false);
	assert.equal(f.posted[1].type, 'openLink'); assert.equal(f.posted[1].external, true);
	assert.equal(f.posted[2].type, 'copy'); assert.equal(f.posted[2].text, 'https://google.com/');
});
