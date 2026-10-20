import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

/**
 * The footer's Git read and the view's tab close live in modules that import
 * `vscode`, so the methods are lifted out of the source and run against a
 * stand-in `this`, the way `gitSafety.test.ts` checks `_assertGitFolder`.
 */
function method(file: string, name: string, globals: Record<string, unknown> = {}): (...args: any[]) => any {
	const source = readFileSync(file, 'utf8');
	const found = new RegExp(`(?:private |public )(?:async )?${name}\\([\\s\\S]*?\\n\\t\\}`).exec(source)?.[0];
	assert.ok(found, name);
	const code = transpileModule(`({ ${found.replace(/^(?:private|public) /, '')} })`, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
	return runInNewContext(code, globals)[name];
}
const view = 'src/chat/chatView.ts';

function host(overrides: Record<string, unknown> = {}): any {
	const posted: any[] = [];
	const h: any = {
		posted, reads: [] as string[], _disposed: false, _view: { visible: true }, _viewReady: true, _gitStale: false,
		_gitRefreshes: new Map(), _queued: [] as any[], _workdir: () => '/repo', _blocked: () => undefined,
		_postMessage: (m: any) => posted.push(m),
		...overrides,
	};
	h._refreshWorkdirGit = method(view, '_refreshWorkdirGit', { Promise });
	return h;
}

test('the footer reads no Git in a window where the chat refuses to run', async () => {
	let spawned = false;
	const h = host({ _blocked: () => 'Restricted Mode', _runWorkdirGit: () => { spawned = true; return Promise.resolve(''); } });
	const read = method(view, '_readWorkdirGit', { gitBinary: () => { spawned = true; return Promise.resolve('/usr/bin/git'); } });
	await read.call(h, '/repo');
	assert.equal(spawned, false);
	// Built in another realm by `runInNewContext`, so compared as data.
	assert.deepEqual(JSON.parse(JSON.stringify(h.posted)), [{ type: 'workdirGit', folder: '/repo', error: 'Git is unavailable in this window.' }]);
});

test('a burst of refreshes is one read and one trailing rerun, and every caller is answered after it', async () => {
	const h = host();
	let release!: () => void;
	h._readWorkdirGit = (folder: string) => { h.reads.push(folder); return new Promise<void>(resolve => { release = resolve; }); };
	const first = h._refreshWorkdirGit();
	const rest = [h._refreshWorkdirGit(), h._refreshWorkdirGit(), h._refreshWorkdirGit()];
	assert.equal(h.reads.length, 1);
	release();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(h.reads.length, 2);
	release();
	await Promise.all([first, ...rest]);
	assert.equal(h.reads.length, 2);
	assert.equal(h._gitRefreshes.size, 0);
});

test('nothing is read without a ready view, and the read is owed', async () => {
	const h = host({ _viewReady: false });
	h._readWorkdirGit = () => { h.reads.push('x'); return Promise.resolve(); };
	await h._refreshWorkdirGit();
	assert.equal(h.reads.length, 0);
	assert.equal(h._gitStale, true);
});

test('editor events read nothing while the view is hidden, and a visible burst is debounced', () => {
	const timers: (() => void)[] = [];
	const globals = { gitEventDebounceMs: 300, clearTimeout: () => { timers.length = 0; }, setTimeout: (f: () => void) => { timers.push(f); return timers.length; } };
	const h = host({ _view: { visible: false } });
	let refreshes = 0;
	h._refreshWorkdirGit = () => { refreshes++; return Promise.resolve(); };
	h._gitEventRefresh = method(view, '_gitEventRefresh', globals);
	h._gitEventRefresh();
	assert.equal(timers.length, 0);
	assert.equal(h._gitStale, true);
	h._view.visible = true;
	for (let i = 0; i < 20; i++) { h._gitEventRefresh(); }
	assert.equal(timers.length, 1);
	timers[0]();
	assert.equal(refreshes, 1);
});

test('a Git snapshot is not queued for a view that is not there', () => {
	const h = host({ _view: undefined, _viewReady: false });
	const post = method(view, '_postMessage');
	post.call(h, { type: 'workdirGit', folder: '/repo' });
	post.call(h, { type: 'state' });
	post.call(h, { type: 'openSleep' });
	assert.deepEqual(h._queued, [{ type: 'openSleep' }]);
});

test('a tab the view lets go of is not left closed for when the view comes back', () => {
	const close = method('src/chat/chatTab.ts', 'close');
	const tab = (): any => ({
		_closed: false, _unseen: true, _wasBusy: true, _chat: { id: 'c' },
		_flushWaiting() {}, _endTurnHere() {}, _save() { return Promise.resolve(); }, _dropSession() {},
		_host: { released() {} },
	});
	const viewClosed = tab();
	close.call(viewClosed, 'view');
	assert.equal(viewClosed._closed, false);
	const tabClosed = tab();
	close.call(tabClosed);
	assert.equal(tabClosed._closed, true);
});
