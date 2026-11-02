import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule } from 'typescript';

const source = readFileSync('src/chat/chatView.ts', 'utf8');
function method(name: string, context: Record<string, unknown> = {}) {
	const text = new RegExp(`\\tprivate ${name}\\([\\s\\S]*?\\n\\t\\}`).exec(source)![0].replace('private ', 'function ');
	return runInNewContext(transpileModule(`${text}\n${name};`, {}).outputText, context);
}

test('pinning the current browser grants the captured conversation access without creating a draft attachment', () => {
	const page = { title: 'Google', url: 'https://google.com' };
	const assigned: unknown[] = [];
	const chat = { chat: { id: 'chat' }, attachments: [] };
	const host = { _blocked: () => undefined, _post() {}, _browser: {
		userTab: page, tabIdOf: () => 'page-1', setTabOwner: (...args: unknown[]) => assigned.push(args),
	} };
	const pin = method('_pinCurrentBrowser', { tabSource: { all: [page] } });
	pin.call(host, chat);
	assert.deepEqual(assigned, [['page-1', 'chat']]);
	assert.equal(chat.attachments.length, 0);
});

test('each sent message sees current pinned page titles and URLs and excludes other chats', () => {
	let tabs = [{ id: 'mine', title: 'Old title', url: 'https://old.test', owner: 'this' }, { id: 'other', title: 'Private', url: 'https://private.test', owner: 'other' }];
	const host = { _browser: { accessTabs: () => tabs } };
	const context = method('_pinnedBrowserContext', { plainInPrompt: (text: string) => text });
	const chat = { chat: { id: 'chat' } };
	assert.match(context.call(host, chat), /Old title/);
	assert.doesNotMatch(context.call(host, chat), /private\.test/);
	tabs = [{ ...tabs[0], title: 'New title', url: 'https://new.test' }];
	assert.match(context.call(host, chat), /New title.*new\.test/);
	tabs = [];
	assert.equal(context.call(host, chat), undefined);
});

test('Clear transfers browser pins while a different saved conversation releases only the old chat’s tabs', () => {
	const calls: unknown[] = [];
	const host = { _browser: {
		accessTabs(id: string) { assert.equal(id, 'old'); return [{ id: 'mine', owner: 'this' }, { id: 'other', owner: 'other' }]; },
		setTabOwner: (...args: unknown[]) => calls.push(args),
	} };
	const move = method('_moveBrowserPins');
	move.call(host, 'old', { chat: { id: 'new' } }, true);
	move.call(host, 'old', { chat: { id: 'saved' } }, false);
	assert.deepEqual(calls, [['mine', 'new'], ['mine', undefined]]);
});
