import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { ScriptTarget, transpileModule } from 'typescript';

test('Bash badge waits five seconds, wakes without output, and cancels on completion or chat switch', () => {
	const source = readFileSync('preview-src/chat.ts', 'utf8');
	const render = /function renderComposerBash\([\s\S]*?\n\}/.exec(source)![0];
	let now = 10_000;
	let nextId = 0;
	const timers = new Map<number, { at: number; run: () => void }>();
	const badge = { hidden: false, textContent: '', title: '' };
	const state: any = { chatId: 'a', entries: [], runningShells: [{ id: 'one', status: 'running', startedAt: now }] };
	const renderBadge = runInNewContext(transpileModule(`
		const bashBadgeDelayMs = 5_000;
		let bashBadgeTimer;
		let pendingBashReveal;
		${render}
		renderComposerBash;
	`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, {
		state, bashRunningBadge: badge, composerTab: 'chat', Date: { now: () => now },
		setTimeout(run: () => void, delay: number) { const id = ++nextId; timers.set(id, { at: now + delay, run }); return id; },
		clearTimeout(id: number) { timers.delete(id); },
	});
	const advance = (ms: number) => {
		now += ms;
		for (const [id, timer] of timers) {
			if (timer.at <= now) { timers.delete(id); timer.run(); }
		}
	};
	renderBadge();
	assert.equal(badge.hidden, true);
	advance(4_999);
	assert.equal(badge.hidden, true);
	advance(1);
	assert.equal(badge.textContent, '1');
	assert.equal(badge.hidden, false);
	state.runningShells.push({ id: 'two', status: 'running', startedAt: now });
	renderBadge();
	assert.equal(badge.textContent, '1', 'a new command must not increment the badge');
	advance(5_000);
	assert.equal(badge.textContent, '2');
	state.runningShells = [];
	renderBadge();
	assert.equal(badge.hidden, true);
	state.runningShells = [{ id: 'quick', status: 'running', startedAt: now }];
	renderBadge();
	advance(100);
	state.runningShells = [];
	renderBadge();
	assert.equal(timers.size, 0, 'completed quick commands must cancel their timer');
	state.runningShells = [{ id: 'switch', status: 'running', startedAt: now }];
	renderBadge();
	state.chatId = 'b';
	state.runningShells = [];
	renderBadge();
	advance(5_000);
	assert.equal(timers.size, 0);
	assert.equal(badge.hidden, true, 'a previous chat must not leave a badge');
});
