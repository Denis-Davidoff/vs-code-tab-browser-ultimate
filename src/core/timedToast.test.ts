import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { plainInLabel, plainInNotification } from './notifyText.ts';

const compiled = transpileModule(readFileSync(resolve('src/core/timedToast.ts'), 'utf8'), {
	compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText;
function load(window: unknown, schedule: (callback: () => void, ms: number) => unknown): (message: string) => void {
	const exports: Record<string, any> = {};
	runInNewContext(compiled, { exports, setTimeout: schedule,
		require(name: string) {
			if (name === 'vscode') { return { window, ProgressLocation: { Notification: 15 } }; }
			if (name === './notifyText') { return { plainInLabel, plainInNotification }; }
			throw new Error(name);
		},
	});
	return exports.timedInformation;
}

test('native commit success toast closes at ten seconds and renders completed work', async () => {
	let visible = false, now = 0;
	const timers: { at: number; callback: () => void }[] = [];
	const reports: { increment: number }[] = [];
	let options: any;
	const show = load({ withProgress(value: unknown, task: (progress: unknown) => Promise<void>) {
		options = value; visible = true;
		return task({ report: (value: { increment: number }) => reports.push(value) }).then(() => { visible = false; });
	} }, (callback, ms) => { timers.push({ at: now + ms, callback }); return 1; });
	show('Committed 4c71a87: Update footer');
	assert.equal(options.location, 15);
	assert.equal(options.cancellable, false);
	assert.equal(options.title, 'Committed 4c71a87: Update footer');
	assert.equal(reports[0].increment, 100);
	assert.equal(timers[0].at, 10_000);
	now = 9999;
	for (const timer of timers.filter(t => t.at <= now)) { timer.callback(); }
	await Promise.resolve();
	assert.equal(visible, true);
	now = 10_000;
	for (const timer of timers.filter(t => t.at <= now)) { timer.callback(); }
	await Promise.resolve();
	assert.equal(visible, false);
});

test('toast neutralizes linked commands and notification API failures never fail the operation', async () => {
	let title = '';
	load({ withProgress(options: { title: string }) { title = options.title; return Promise.resolve(); } }, () => 0)('Committed abc: [Run](command:evil) $(check)');
	assert.ok(!title.includes('[') && !title.includes(']') && !title.includes('$('));
	assert.doesNotThrow(() => load({ withProgress() { throw new Error('editor closed'); } }, () => 0)('Success'));
	assert.doesNotThrow(() => load({ withProgress() { return Promise.reject(new Error('editor closed')); } }, () => 0)('Success'));
	await new Promise(resolve => setImmediate(resolve));
});
