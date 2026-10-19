import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cleanTitle, cleanBranchName, availableBranchName, titleModel, requestTitle } from './autoTitle.ts';
import type { ChatModel } from './chatProtocol.ts';

const model = (id: string): ChatModel => ({ id, label: id, efforts: ['low', 'high'], isDefault: false });

test('title model is small and listed; expensive defaults are never fallback', () => {
	assert.equal(titleModel([model('gpt-6-astra'), model('gpt-6-luna')])?.id, 'gpt-6-luna');
	assert.equal(titleModel([model('gpt-mini'), model('gpt-nano')])?.id, 'gpt-nano');
	assert.equal(titleModel([model('claude-haiku-4-5')])?.id, 'claude-haiku-4-5');
	assert.equal(titleModel([model('default'), model('gpt-6-astra')]), undefined);
	assert.equal(titleModel([]), undefined);
});

test('reject prose, multiline and oversized titles', () => {
	assert.equal(cleanTitle('"Исправление панели навыков"'), 'Исправление панели навыков');
	assert.equal(cleanTitle('Title\nExplanation'), undefined);
	assert.equal(cleanTitle('a'.repeat(61)), undefined);
	assert.equal(cleanTitle(''), undefined);
});

for (const agent of ['claude', 'codex'] as const) {
 for (const purpose of [undefined, 'branch'] as const) {
	test(`isolated ${agent} ${purpose ?? "title"} request has bounded context, minimum effort and no conversation`, async () => {
		if (process.platform === 'win32') { return; } // executable fixture uses a POSIX shebang
		const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'title-test-'));
		try {
			const binary = path.join(scratch, 'fake-agent');
			const log = path.join(scratch, 'request.json');
			await fs.writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
let text = '';
process.stdin.on('data', c => text += c);
process.stdin.on('end', () => {
 fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({text, cwd: process.cwd(), args: process.argv.slice(2)}));
 console.log(JSON.stringify(${agent === 'claude' ? JSON.stringify({result: purpose ? 'feat/git-magic' : 'Короткое название'}) : JSON.stringify({type:'item.completed',item:{type:'agent_message',text: purpose ? 'feat/git-magic' : 'Короткое название'}})}));
});\n`, { mode: 0o700 });
			assert.equal(await requestTitle(binary, agent, model(agent === 'claude' ? 'haiku' : 'gpt-mini'), 'x'.repeat(5000), new AbortController().signal, purpose), purpose ? 'feat/git-magic' : 'Короткое название');
			const request = JSON.parse(await fs.readFile(log, 'utf8'));
			assert.equal(request.text.length, purpose ? 5000 : 1200);
			assert.ok(request.cwd.includes('ai-browser-title-'));
			await assert.rejects(fs.stat(request.cwd), { code: 'ENOENT' });
			assert.ok(request.args.includes(agent === 'claude' ? '--no-session-persistence' : '--ephemeral'));
			assert.ok(request.args.includes(agent === 'claude' ? 'low' : 'model_reasoning_effort="low"'));
			assert.ok(!request.args.includes('--resume'));
		} finally { await fs.rm(scratch, { recursive: true, force: true }); }
	});
}

}

test('cancelled or unavailable title request safely keeps the fallback', async () => {
	const controller = new AbortController();
	controller.abort();
	assert.equal(await requestTitle('/missing-agent', 'codex', model('gpt-mini'), 'text', controller.signal), undefined);
	assert.equal(await requestTitle('/missing-agent', 'claude', model('haiku'), 'text', new AbortController().signal), undefined);
});

test('late title preserves manual names, replaced chats, closed tabs and discarded history', async () => {
	const { transpileModule, ModuleKind, ScriptTarget } = await import('typescript');
	const { runInNewContext } = await import('node:vm');
	const source = await fs.readFile(path.resolve('src/chat/chatTab.ts'), 'utf8');
	const method = /public applyGeneratedTitle\(chatId: string, title: string\): void \{[\s\S]*?\n\t\}/.exec(source)?.[0];
	assert.ok(method);
	const compiled = transpileModule(`({ ${method.replace('public ', '')} })`, {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const apply = runInNewContext(compiled).applyGeneratedTitle;
	for (const blocked of ['none', 'named', 'other-chat', 'closed', 'discarded', 'unstarted']) {
		let saves = 0;
		let posts = 0;
		const state = {
			_closed: blocked === 'closed', _discarded: blocked === 'discarded', started: blocked !== 'unstarted',
			_chat: { id: blocked === 'other-chat' ? 'other' : 'chat', title: 'Original', named: blocked === 'named' },
			_save() { saves++; return Promise.resolve(); }, _post() { posts++; },
		};
		apply.call(state, 'chat', 'Generated title');
		assert.equal(state._chat.title, blocked === 'none' ? 'Generated title' : 'Original');
		assert.equal(saves, blocked === 'none' ? 1 : 0);
		assert.equal(posts, saves);
		assert.equal(state._chat.named, blocked === 'named');
	}
});

 test('branch names reject instructions, invalid refs and prose', () => {
  assert.equal(cleanBranchName('feat/git-magic'), 'feat/git-magic');
  for (const value of ['Hello world', 'feat/../oops', '-danger', 'feat//name', 'feat/', 'feat/a.lock', 'foo\nbar', '']) {
   assert.equal(cleanBranchName(value), undefined, value);
  }
 });


test('suggested branch names avoid exact, ancestor and descendant conflicts in Git', async () => {
	const { execFileSync } = await import('node:child_process');
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'branch-name-test-'));
	const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
	try {
		git('init', '-q');
		const tree = execFileSync('git', ['mktree'], { cwd: directory, input: '', encoding: 'utf8' }).trim();
		const commit = execFileSync('git', ['commit-tree', tree, '-m', 'fixture'], {
			cwd: directory, encoding: 'utf8', env: { ...process.env,
				GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
				GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
		}).trim();
		const branches = ['feat', 'feat-new', 'feat-new-2/child', 'fix/bug', 'fix-2/child', 'fix-3'];
		for (const name of branches) { git('update-ref', `refs/heads/${name}`, commit); }
		for (const [proposed, expected] of [
			['feat/new', 'feat-new-3'], ['fix', 'fix-4'], ['fix/bug', 'fix/bug-2'], ['feature/new', 'feature/new'],
		]) {
			const name = availableBranchName(proposed, branches);
			assert.equal(name, expected);
			git('check-ref-format', `refs/heads/${name}`);
			git('branch', name, commit);
		}
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});
