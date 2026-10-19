import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

const source = readFileSync(resolve('src/chat/chatView.ts'), 'utf8');
const method = /private async _commitWorkdir\([\s\S]*?\n\t\}/.exec(source)?.[0];
assert.ok(method);
const code = transpileModule(`({ ${method.replace('private ', '')} })`, {
	compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText;

for (const failed of [false, true]) {
	test(failed ? 'failed commits retain the inline error and repair state without success toast' : 'successful commit uses a toast without retaining a footer banner or chat entry', async () => {
		const entries: { kind: string; text: string }[] = [];
		const toasts: string[] = [];
		let released = false;
		const tab = { id: 'tab', chat: { id: 'chat' }, busy: false, push(entry: { kind: string; text: string }) { entries.push(entry); } };
		const host = {
			_tabs: [tab], _active: tab, _disposed: false, _workdir: () => '/repo', _gitCommits: new Map(), _repoBusy: new Map(),
			_runs: { runningIn: () => 0 }, _blocked: () => false, _busyGitFolders: () => [],
			_gitAccess: { async mutate() { return () => { released = true; }; } },
			_registry: { detecting: false, agents: [{ id: 'codex', available: true }], backend: () => ({ generateCommitMessage: async () => 'Update footer' }) },
			_selection: () => ({ agent: 'codex', model: 'selected' }), _untrusted: () => false, _post() {}, async _refreshWorkdirGit() {},
		};
		const commit = runInNewContext(code, {
			AbortController, generateUuid: () => 'job', gitBinary: async () => '/git',
			async commitChanges() {
				if (failed) { throw new Error('pre-commit check failed'); }
				return { hash: '4c71a87', message: 'Update footer\n\nDetails' };
			},
			timedInformation(message: string) { toasts.push(message); return new Promise(() => {}); },
		})._commitWorkdir;
		await commit.call(host, '/repo', 'tab');
		assert.equal(released, true, 'the toast must not hold the Git lock for ten seconds');
		if (failed) {
			assert.equal(toasts.length, 0);
			assert.equal(host._gitCommits.get('/repo').state.phase, 'error');
			assert.equal(entries[0].kind, 'error');
		} else {
			assert.deepEqual(toasts, ['Committed 4c71a87: Update footer']);
			assert.equal(host._gitCommits.has('/repo'), false);
			assert.equal(entries.length, 0);
		}
	});
}
