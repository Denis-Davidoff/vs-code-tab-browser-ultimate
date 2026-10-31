import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { remoteFileControls, remoteFileLevels, remoteFileRefusal } from './remoteFiles.ts';
import type { ViewToHost } from '../chatProtocol';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';
import { remoteRefusal } from './commands.ts';
import { remoteScope } from './remoteScope.ts';

for (const surface of ['chrome', 'exchange'] as const) {
	test(`${surface} file permissions distinguish browsing, attaching and writing`, () => {
		const read: ViewToHost = { type: 'listWorkdir' };
		const attach: ViewToHost = { type: 'attachPath', path: 'docs' };
		for (const [i, level] of remoteFileLevels.entries()) {
			assert.equal(!remoteFileRefusal(surface, level, read), i >= 1);
			assert.equal(!remoteFileRefusal(surface, level, attach), i >= 2);
			for (const action of ['list', 'complete', 'attach', 'newFolder', 'copy', 'cut', 'paste', 'upload'] as const) {
				const required = action === 'list' || action === 'complete' ? 1 : action === 'attach' ? 2 : 3;
				const message: ViewToHost = { type: 'files', action, folder: '/project', dir: '', request: 1 };
				assert.equal(!remoteFileRefusal(surface, level, message), i >= required, `${level}: ${action}`);
				assert.equal(remoteFileControls(surface, level)[`files.${action}`]?.s !== 'off', i >= required);
			}
			assert.equal(remoteFileRefusal(surface, level, { type: 'stop' }), undefined);
		}
	});
}

test('host enforces each surface permission before dispatch and remote clients cannot change it', async () => {
	const source = readFileSync('src/chat/chatView.ts', 'utf8');
	const methods = ['commandChromeSource', 'commandExchangeSource'].map(name => new RegExp(`public static async ${name}\\([\\s\\S]*?\\n\\t\\}`).exec(source)![0]);
	const settings = { chrome: 'read', exchange: 'write' };
	const calls: ViewToHost[] = [];
	const Controller = runInNewContext(transpileModule(`class Controller { ${methods.join('\n')} }; Controller;`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, {
		remoteRefusal, remoteScope, remoteFileRefusal, remoteFileSettings: () => settings,
		chromeChatCommandFeature: () => 'workdir', exchangeRefusal() {},
	});
	const tab = { chat: { id: 'chat' } };
	Controller._surfaces = new Map([['source', {
		_view: {}, _tabs: [tab], _blocked: () => undefined, _chromeCommand: new AsyncLocalStorage(),
		_receiveChromeFooter: async (_tab: unknown, message: ViewToHost) => calls.push(message), _post() {},
	}]]);
	const attach = { type: 'files', action: 'attach', folder: '/project', dir: '', paths: ['docs'], request: 1 };
	await assert.rejects(Controller.commandChromeSource('source', 'chat', attach), /Chrome.*read/);
	assert.equal(calls.length, 0);
	await Controller.commandExchangeSource('source', 'chat', attach);
	assert.equal(calls.length, 1);
	settings.chrome = 'attach';
	await Controller.commandChromeSource('source', 'chat', attach);
	assert.equal(calls.length, 2);
	settings.exchange = 'off';
	await assert.rejects(Controller.commandExchangeSource('source', 'chat', { type: 'listWorkdir' }), /website.*off/);
	for (const command of ['commandChromeSource', 'commandExchangeSource']) {
		await assert.rejects(Controller[command]('source', 'chat', { type: 'remoteTerminalSettings', action: 'setFiles', surface: 'chrome', value: 'write' }), /only in VS Code|available in the editor/);
	}
});
