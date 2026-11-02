import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule } from 'typescript';

const source = readFileSync('preview-src/chat.ts', 'utf8');
const lift = (name: string) => new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`).exec(source)![0];

function fixture() {
	const page = { id: 'suggest:page:1', kind: 'sharedPage', label: 'Current page' };
	const state = { suggestions: [page], attachments: [] as unknown[], nativeBrowser: 'granted', access: { tabs: [] as any[] } };
	const posted: unknown[] = [];
	const classes = new Set<string>();
	const row = { hidden: false, children: [] as unknown[], replaceChildren(...children: unknown[]) { this.children = children; } };
	const api = runInNewContext(transpileModule([
		"let attachmentsShown = '';", lift('renderAttachments'), lift('browserMenuItems'),
		'({ renderAttachments, browserMenuItems });',
	].join('\n'), {}).outputText, {
		state, post: (message: unknown) => posted.push(message), attachmentsRow: row,
		browserButton: { classList: { toggle: (name: string, on: boolean) => on ? classes.add(name) : classes.delete(name) } },
		fileIconsSignature: '', chipShown: (chip: unknown) => chip,
		isPinChip: (chip: { terminalId?: string }) => !!chip.terminalId,
		pinChipNode: (chip: unknown) => chip,
		browserPinNode: (tab: unknown) => tab,
		toolbarLayoutShape: '', scheduleToolbarLayout() {},
		autosize() {},
	});
	return { state, posted, classes, row, api, page };
}

test('browser menu offers to pin the current page', () => {
	const f = fixture();
	const items = f.api.browserMenuItems();
	assert.equal(items[0].label, 'Pin current browser');
	assert.equal(items[0].description, f.page.label);
	items[0].run();
	assert.equal(JSON.stringify(f.posted), JSON.stringify([{ type: 'acceptSuggestion', id: f.page.id }]));
});

test('browser pins stay in the row across sends and update when the title, owner or open tabs change', () => {
	const f = fixture();
	const tab = { id: 'browser-1', title: 'Google', url: 'https://google.com', owner: 'this' };
	f.state.access.tabs = [tab];
	f.api.renderAttachments(f.state);
	assert.equal(f.row.hidden, false);
	assert.equal(f.row.children[0], tab);
	// Sending consumes draft attachments, while ownership remains.
	f.state.attachments = [];
	f.api.renderAttachments(f.state);
	assert.equal(f.row.children.length, 1);
	f.state.access.tabs = [{ ...tab, title: 'Search results' }];
	f.api.renderAttachments(f.state);
	assert.equal((f.row.children[0] as any).title, 'Search results');
	f.state.access.tabs = [{ ...tab, owner: 'other' }];
	f.api.renderAttachments(f.state);
	assert.equal(f.row.hidden, true);
	f.state.access.tabs = [];
	f.api.renderAttachments(f.state);
	assert.equal(f.row.children.length, 0);
});

test('browser menu pins and unpins the exact tab, including taking one from another chat', () => {
	const f = fixture();
	f.state.suggestions = [];
	f.state.access.tabs = [
		{ id: 'mine', title: 'Mine', owner: 'this' },
		{ id: 'other', title: 'Other', owner: 'other' },
	];
	const items = f.api.browserMenuItems();
	assert.equal(items[0].checked, true);
	items[0].run(); items[1].run();
	assert.equal(JSON.stringify(f.posted), JSON.stringify([
		{ type: 'tabAccess', tabId: 'mine', take: false },
		{ type: 'tabAccess', tabId: 'other', take: true },
	]));
});

test('globe loses its highlight after attachment and suggestions do not use the bottom row', () => {
	const f = fixture();
	f.api.renderAttachments(f.state);
	assert.ok(f.classes.has('has-suggestion'));
	assert.equal(f.row.hidden, true);
	assert.equal(f.row.children.length, 0);
	f.state.suggestions = [];
	f.state.attachments = [{ id: 'attached-page', kind: 'sharedPage', reference: '@1' }];
	f.api.renderAttachments(f.state);
	assert.equal(f.classes.has('has-suggestion'), false);
	assert.equal(f.row.hidden, true);
	assert.equal(f.api.browserMenuItems()[0].label, 'Google Chrome');
	f.state.suggestions = [f.page];
	f.state.attachments = [];
	f.api.renderAttachments(f.state);
	assert.ok(f.classes.has('has-suggestion'));
});
