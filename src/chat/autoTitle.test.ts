import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cleanTitle, titleModel, requestTitle } from './autoTitle.ts';
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
	test(`isolated ${agent} request has bounded context, minimum effort and no conversation`, async () => {
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
 console.log(JSON.stringify(${agent === 'claude' ? "{result:'Короткое название'}" : "{type:'item.completed',item:{type:'agent_message',text:'Короткое название'}}"}));
});\n`, { mode: 0o700 });
			assert.equal(await requestTitle(binary, agent, model(agent === 'claude' ? 'haiku' : 'gpt-mini'), 'x'.repeat(5000), new AbortController().signal), 'Короткое название');
			const request = JSON.parse(await fs.readFile(log, 'utf8'));
			assert.equal(request.text.length, 1200);
			assert.ok(request.cwd.includes('ai-browser-title-'));
			await assert.rejects(fs.stat(request.cwd), { code: 'ENOENT' });
			assert.ok(request.args.includes(agent === 'claude' ? '--no-session-persistence' : '--ephemeral'));
			assert.ok(request.args.includes(agent === 'claude' ? 'low' : 'model_reasoning_effort="low"'));
			assert.ok(!request.args.includes('--resume'));
		} finally { await fs.rm(scratch, { recursive: true, force: true }); }
	});
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
