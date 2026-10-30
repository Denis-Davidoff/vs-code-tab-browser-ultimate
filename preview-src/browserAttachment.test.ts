import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule } from 'typescript';

const source = readFileSync('preview-src/chat.ts', 'utf8');
const lift = (name: string) => new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`).exec(source)![0];

function fixture() {
	const page = { id: 'suggest:page:1', kind: 'sharedPage', label: 'Current page' };
	const state = { suggestions: [page], attachments: [] as unknown[], nativeBrowser: 'granted' };
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
	});
	return { state, posted, classes, row, api, page };
}

test('browser menu offers the current page first and accepts it through the text attachment flow', () => {
	const f = fixture();
	const items = f.api.browserMenuItems();
	assert.equal(items[0].label, 'Attach current browser');
	assert.equal(items[0].description, f.page.label);
	items[0].run();
	assert.equal(JSON.stringify(f.posted), JSON.stringify([{ type: 'acceptSuggestion', id: f.page.id }]));
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
