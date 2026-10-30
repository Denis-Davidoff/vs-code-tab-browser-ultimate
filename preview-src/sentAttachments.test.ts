import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';
import { composerLinks, composerListItem } from './composerFormatting.ts';
import { attachmentMarker, readAttachmentMarkers } from './attachmentMarkers.ts';

const source = readFileSync('preview-src/chat.ts', 'utf8');
const lift = (name: string) => new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`).exec(source)![0];

function fixture(entry: any) {
	const posted: unknown[] = [];
	let menu: any[] = [];
	const element = (tag: string, props: any = {}, ...children: any[]): any => {
		const classes = new Set((props.class ?? '').split(' '));
		const node: any = {
			tag, children: [] as any[], title: props.title, dataset: {}, attributes: {} as Record<string, string>,
			classList: { add: (name: string) => classes.add(name), contains: (name: string) => classes.has(name) },
			handlers: {} as Record<string, (e: any) => void>, setAttribute(name: string, value: string) { this.attributes[name] = value; },
			addEventListener(name: string, fn: (event: any) => void) { this.handlers[name] = fn; },
			append(...items: any[]) { this.children.push(...items.filter(item => item !== undefined && item !== false)); },
			querySelectorAll(selector: string): any[] {
				return this.children.flatMap((child: any) => !child.querySelectorAll ? [] : [
					...((selector.startsWith('.') ? child.classList.contains(selector.slice(1)) : child.tag === selector) ? [child] : []), ...child.querySelectorAll(selector),
				]);
			},
			get childElementCount() { return this.children.filter((child: any) => child.tag).length; },
		};
		node.append(...children);
		return node;
	};
	const context = {
		state: { entries: [{ kind: 'assistant' }, entry], entriesOffset: 20 }, posted,
		post: (message: unknown) => posted.push(message),
		el: element, icon: (name: string) => element('i', { class: `icon-${name}` }),
		themeFileIcon: (name: string) => element('i', { class: `theme-${name}` }),
		input: { focus() {} }, document: { createTextNode: (text: string) => ({ text }) },
		markCommands: (text: string) => [{ text }], withFileIcons: (nodes: any[]) => nodes,
		knownCommands: () => [], copyButton: (text: () => string) => {
			const node = element('button');
			node.handlers.click = () => posted.push({ type: 'copy', text: text() });
			return node;
		}, hasSelection: () => false, getSelection: () => null,
		openMenu: (_anchor: any, items: any[]) => { menu = items; },
		gate: () => ({ s: 'on' }),
		attachmentClipboardType: 'application/x-ai-browser-attachments',
		attachmentMarker, sentAttachmentCopySequence: 0,
		composerLinks, composerListItem, linkNode: (url: string, text: string) => element('span', { class: 'link', text, title: url }),
	};
	const code = [source.match(/const attachmentTokenPattern = [^\n]+/)![0],
		...['attachmentToken', 'tokensIn', 'plainToken', 'chipIcon', 'attachmentIcon', 'markAttachmentTokens',
			'sentAttachmentAt', 'sentAttachmentChip', 'wireSentAttachment', 'markComposerText', 'renderPromptText', 'promptNode'].map(lift),
		'({ promptNode, sentAttachmentChip });',
	].join('\n');
	const api = runInNewContext(transpileModule(code, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, context);
	return { api, posted, menu: () => menu };
}

const entry = {
	kind: 'user', text: 'Look [@3   NEWS.md      ][@1   scripts/      ] [@2   docs/      ]',
	attachments: ['@1 scripts/', '@2 docs/', '@3 NEWS.md'],
	attachmentData: [
		{ chip: { id: 'scripts', kind: 'file', label: 'scripts/', filePath: '/project/scripts' }, text: 'Folder' },
		{ chip: { id: 'docs', kind: 'file', label: 'docs/', filePath: '/project/docs' }, text: 'Folder' },
		{ chip: { id: 'news', kind: 'file', label: 'NEWS.md', filePath: '/project/NEWS.md' }, file: 'file:///project/NEWS.md' },
	],
};

test('sent inline badges replace the duplicate attachment row and use file and folder icons', () => {
	const f = fixture(entry);
	const prompt = f.api.promptNode(entry);
	assert.equal(prompt.querySelectorAll('.att-token-wrap').length, 3);
	assert.equal(prompt.querySelectorAll('.bubble-attachments').length, 0);
	assert.equal(prompt.querySelectorAll('.theme-NEWS.md').length, 1);
	assert.equal(prompt.querySelectorAll('.theme-scripts/').length, 1);
	assert.equal(prompt.querySelectorAll('.theme-docs/').length, 1);
});

test('Copy prompt exports portable badges and keeps the original message text and list markers', () => {
	const message = { ...entry, text: `Hello\n- ${entry.text}\n1. Done` };
	const f = fixture(message);
	const prompt = f.api.promptNode(message);
	prompt.querySelectorAll('button')[0].handlers.click();
	const copied = f.posted.find((item: any) => item.type === 'copy') as any;
	assert.equal(copied.text, 'Hello\n- Look [att:news|NEWS.md][att:scripts|scripts/] [att:docs|docs/]\n1. Done');
	assert.deepEqual(readAttachmentMarkers(copied.text)?.items.map(item => item.id), ['news', 'scripts', 'docs']);
	assert.equal(JSON.stringify(f.posted[0]), JSON.stringify({ type: 'rememberAttachments', ids: ['news', 'scripts', 'docs'] }));
});

test('sent badges open and reattach the correct item after history offsets, and can copy its path', () => {
	const f = fixture(entry);
	const badge = f.api.promptNode(entry).querySelectorAll('.att-token-wrap')[0];
	const event = { preventDefault() {}, stopPropagation() {} };
	badge.handlers.click(event);
	assert.equal(JSON.stringify(f.posted[0]), JSON.stringify({ type: 'openAttachment', id: 'news', entry: 21 }));
	badge.handlers.contextmenu(event);
	f.menu().find(item => item.label === 'Copy').run();
	f.menu().find(item => item.label === 'Insert into message').run();
	assert.equal(JSON.stringify(f.posted.slice(1)), JSON.stringify([
		{ type: 'rememberAttachments', ids: ['news'] },
		{ type: 'copy', text: attachmentMarker(entry.attachmentData[2].chip) }, { type: 'reattachAttachment', id: 'news', entry: 21 },
	]));
});

test('attachments without inline tokens still render once using the shared badge markup', () => {
	const f = fixture({ ...entry, text: '' });
	const prompt = f.api.promptNode({ ...entry, text: '' });
	assert.equal(prompt.querySelectorAll('.att-token-wrap').length, 3);
	assert.equal(prompt.querySelectorAll('.bubble-attachments').length, 1);
});

test('non-file attachments retain their own icon instead of using the file label as an icon name', () => {
	const message = { kind: 'user', text: '[@1 Page]', attachments: ['@1 Page'], attachmentKinds: ['sharedPage'], attachmentData: [{ chip: { id: 'page', kind: 'sharedPage', label: 'Page' } }] };
	const f = fixture(message);
	const prompt = f.api.promptNode(message);
	assert.equal(prompt.querySelectorAll('.icon-globe').length, 1);
	assert.equal(prompt.querySelectorAll('.theme-Page').length, 0);
});

test('sent badges drag an attachment snapshot that can be pasted back into the draft', () => {
	const f = fixture(entry);
	const badge = f.api.promptNode(entry).querySelectorAll('.att-token-wrap')[0];
	assert.equal(badge.draggable, true);
	const data = new Map();
	badge.handlers.dragstart({ dataTransfer: { setData: (key: string, value: string) => data.set(key, value) } });
	assert.equal(data.get('text/plain'), attachmentMarker(entry.attachmentData[2].chip));
	const payload = JSON.parse(data.get('application/x-ai-browser-attachments'));
	assert.equal(payload.items[0].id, 'news');
	assert.ok(payload.text.startsWith('[@3\u00a0'));
	assert.equal(JSON.stringify(f.posted[0]), JSON.stringify({ type: 'rememberAttachments', ids: ['news'] }));
});

test('user prompts render nested lists, inline attachments and links together without duplicate badges', () => {
	const message = { ...entry, text: '- [@1 scripts/]\n  1. Read [@3 NEWS.md]\n  2. https:/google.com\n- [@2 docs/]' };
	const f = fixture(message);
	const prompt = f.api.promptNode(message);
	assert.equal(prompt.querySelectorAll('ul').length, 1);
	assert.equal(prompt.querySelectorAll('ol').length, 1);
	assert.equal(prompt.querySelectorAll('li').length, 4);
	assert.equal(prompt.querySelectorAll('.att-token-wrap').length, 3);
	assert.equal(prompt.querySelectorAll('.bubble-attachments').length, 0);
	assert.equal(prompt.querySelectorAll('.link')[0].title, 'https://google.com/');
});

test('reattaching saved content makes a fresh attachment while preserving file, image and snapshot data', () => {
	const host = readFileSync('src/chat/chatView.ts', 'utf8');
	const method = /\tprivate _reattachAttachment\([\s\S]*?\n\t\}/.exec(host)![0];
	let blocked = false;
	const saved = { chip: { id: 'original', kind: 'file', label: 'image.png', reference: '@9' }, text: 'original snapshot', file: 'file:///image.png', image: { base64: 'abc', mediaType: 'image/png' } };
	const active = { chat: { entries: [{ kind: 'user', attachmentData: [saved] }] }, attachments: [] as any[] };
	let posts = 0;
	const instance = runInNewContext(transpileModule(`class Host { ${method} }\nnew Host();`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, {
		generateUuid: () => 'fresh', vscode: { Uri: { parse: (uri: string) => ({ uri }) } },
	});
	Object.assign(instance, { _active: active, _blocked: () => blocked, _post: () => posts++, _focusInput() {} });
	instance._reattachAttachment('original', 0);
	assert.equal(active.attachments[0].chip.id, 'fresh');
	assert.equal(active.attachments[0].chip.reference, undefined);
	assert.equal(active.attachments[0].text, saved.text);
	assert.equal(active.attachments[0].image, saved.image);
	assert.equal(active.attachments[0].file.uri, saved.file);
	assert.equal(saved.chip.id, 'original');
	assert.equal(posts, 1);
	blocked = true;
	instance._reattachAttachment('original', 0);
	assert.equal(active.attachments.length, 1);
});
