import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { cleanCommitMessage, commitContextLimit, requestCommitMessage } from './commitMessage.ts';

test('commit messages accept a subject and body but reject empty, control and oversized output', () => {
	assert.equal(cleanCommitMessage(' fix: update footer\n\nExplain the change.\n'), 'fix: update footer\n\nExplain the change.');
	assert.equal(cleanCommitMessage('```text\nfix: update footer\n```'), 'fix: update footer');
	for (const text of ['', 'a'.repeat(121), 'bad\0message', 'ok\n\n' + 'x'.repeat(4000)]) { assert.throws(() => cleanCommitMessage(text)); }
});

for (const agent of ['claude', 'codex'] as const) {
	test(`commit generation uses the selected ${agent} model and effort, without tools or chat history`, async () => {
		if (process.platform === 'win32') { return; }
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'commit-model-test-'));
		try {
			const binary = path.join(directory, 'fake-agent');
			const log = path.join(directory, 'request.json');
			await fs.writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
let text = '';
process.stdin.on('data', chunk => text += chunk);
process.stdin.on('end', () => {
 fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), text }));
 console.log(JSON.stringify(${agent === 'claude' ? "{result: 'fix: update Git footer'}" : "{type:'item.completed',item:{type:'agent_message',text:'fix: update Git footer'}}"}));
});\n`, { mode: 0o700 });
			assert.equal(await requestCommitMessage(binary, agent, 'selected-model', 'high', 'x'.repeat(200_000), new AbortController().signal, directory), 'fix: update Git footer');
			const request = JSON.parse(await fs.readFile(log, 'utf8'));
			assert.equal(request.args[request.args.indexOf('--model') + 1], 'selected-model');
			assert.ok(request.args.includes(agent === 'claude' ? 'high' : 'model_reasoning_effort="high"'));
			assert.ok(!request.args.includes('--resume'));
			if (agent === 'claude') { assert.equal(request.args[request.args.indexOf('--tools') + 1], ''); }
			else { assert.ok(request.args.includes('shell_tool')); assert.ok(request.args.includes('read-only')); }
			assert.equal(request.text.length, commitContextLimit);
			assert.match(request.cwd, /ai-browser-commit-/);
			await assert.rejects(fs.stat(request.cwd), { code: 'ENOENT' });
		} finally { await fs.rm(directory, { recursive: true, force: true }); }
	});
}

test('generation errors and cancellation are reported instead of substituting a fallback message', async () => {
	const controller = new AbortController(); controller.abort();
	await assert.rejects(requestCommitMessage('/missing', 'codex', 'selected', 'high', 'diff', controller.signal));
	await assert.rejects(requestCommitMessage('/missing', 'claude', 'selected', undefined, 'diff', new AbortController().signal), /ENOENT/);
});
