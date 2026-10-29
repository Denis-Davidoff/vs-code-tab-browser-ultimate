import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';

const source = readFileSync('preview-src/chat.ts', 'utf8');
const follow = /function followDraft\([\s\S]*?\n\}/.exec(source)![0];
const start = source.indexOf("case 'setTabDraft':") + "case 'setTabDraft':".length;
const receive = source.slice(start, source.indexOf("case 'readTabDraft':", start));

test('a background tab can leave and return with an edited draft without reviving or appending old text', () => {
	const context: any = { draftChat: 'A', draftTab: 'tab-A', drafts: { B: 'old B' }, input: { value: '', focus() {} },
		fromHistory: false, paletteMode: undefined, inputHistory: [], savedView: {}, state: {}, chatDrawerCollapsed: false, chatDrawerSide: 'left', composerTab: 'chat', overviewHeight: undefined,
		autosize() {}, renderSend() {}, post() {}, vscode: { setState() {} },
		currentDraft() { return context.input.value; }, saveDraft() { context.drafts[context.state.chatId] = context.input.value; } };
	const execute = (code: string) => runInNewContext(transpileModule(`(() => { ${code} })()`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, context);
	context.next = { chatId: 'A', activeTab: 'tab-A', tabs: [{ chatId: 'A' }] };
	execute(`${follow}\nfollowDraft(next);`);
	assert.equal(context.drafts.B, undefined, 'departure must prune background draft even if A stays selected');
	context.next = context.state = { chatId: 'B', activeTab: 'tab-B', tabs: [{ chatId: 'A' }, { chatId: 'B' }] };
	execute(`${follow}\nfollowDraft(next);`);
	context.message = { chatId: 'B', text: 'edited B' };
	execute(receive);
	assert.equal(context.input.value, 'edited B');
	execute(receive);
	assert.equal(context.input.value, 'edited B', 'reapplying a transferred snapshot must be idempotent');
});
