import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

test('commit repair requires the current error action and sends diagnostics to the selected chat without consuming attachments', async () => {
	const source = readFileSync(resolve('src/chat/chatView.ts'), 'utf8');
	const method = /private async _answerCommit\([\s\S]*?\n\t\}/.exec(source)?.[0];
	assert.ok(method);
	const code = transpileModule(`({ ${method.replace('private ', '')} })`, {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const answer = runInNewContext(code)._answerCommit;
	for (const scenario of ['fix', 'dismiss', 'stale-id', 'other-folder', 'other-tab', 'running', 'success']) {
		const sent: { prompt: string; tabId: string; attachments: unknown[] }[] = [];
		const tab = { id: 'tab-current' };
		const job = {
			state: { id: 'error-id', phase: scenario === 'running' ? 'generating' : scenario === 'success' ? 'done' : 'error', message: 'pre-commit: formatting failed' },
			proposedMessage: 'fix: update footer',
		};
		const host = {
			_tabs: [tab], _active: scenario === 'other-tab' ? {} : tab,
			_gitCommits: new Map([['/repo', job]]), _workdir: () => '/repo', _post() {},
			async _send(prompt: string, tabId: string, attachments: unknown[]) { sent.push({ prompt, tabId, attachments }); },
		};
		await answer.call(host, {
			type: scenario === 'dismiss' ? 'dismissGitCommit' : 'fixGitCommit',
			id: scenario === 'stale-id' ? 'old-id' : 'error-id',
			folder: scenario === 'other-folder' ? '/other' : '/repo', tabId: tab.id,
		});
		assert.equal(sent.length, scenario === 'fix' ? 1 : 0, scenario);
		if (sent.length) {
			assert.equal(sent[0].tabId, 'tab-current');
			assert.equal(sent[0].attachments.length, 0);
			assert.match(sent[0].prompt, /formatting failed/);
			assert.match(sent[0].prompt, /fix: update footer/);
			assert.match(sent[0].prompt, /Do not reset, discard changes, bypass hooks or push/);
		}
		assert.equal(host._gitCommits.has('/repo'), scenario !== 'fix' && scenario !== 'dismiss');
	}
});
