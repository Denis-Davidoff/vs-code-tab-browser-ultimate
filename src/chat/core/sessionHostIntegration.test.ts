import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';
import { SessionHost, sessionChannel } from './sessionHost.ts';

const source = readFileSync('src/chat/chatView.ts', 'utf8');
const body = /\tprivate _publishSessions\(\): void \{[\s\S]*?\n\t\}/.exec(source)![0].replace('private _publishSessions', 'function publish');
const publish = runInNewContext(transpileModule(`${body}\npublish;`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, {});

test('real provider bridge publishes all conversations and retains identity when a tab moves', () => {
	const sessions = new SessionHost();
	const tab = (id: string) => ({ chat: { id, title: id, agent: 'codex', entries: [{ kind: 'assistant', text: 'Hello' }], privateToken: 'never-published' },
		cwd: '/project', running: true, pendingSends: [] });
	const chat = tab('one'), sibling = tab('two');
	const main = { _tabs: [chat, sibling], _disposed: false };
	const panel = { _tabs: [] as ReturnType<typeof tab>[], _disposed: false };
	const services = { sessions, views: new Set([main, panel]) };
	const view = { _services: services };
	publish.call(view);
	assert.equal(sessions.size, 0, 'the experimental bridge is dormant without a consumer');
	sessions.subscribe(() => {});
	publish.call(view);
	assert.equal(sessions.size, 2);
	assert.equal(JSON.stringify(sessions.list()).includes('never-published'), false);
	const before = sessions.serverSeq;
	main._tabs.splice(0, 1); panel._tabs.push(chat);
	publish.call(view);
	assert.equal(sessions.serverSeq, before, 'UI placement is not conversation state');
	services.views.delete(main); publish.call(view);
	assert.equal(sessions.size, 1);
	assert.equal(sessions.snapshot(sessionChannel('one'))?.state.id, 'one');
	services.views.delete(panel); publish.call(view);
	assert.equal(sessions.size, 0);
});
