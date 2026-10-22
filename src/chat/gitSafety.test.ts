import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { GitAccess } from './gitAccess.ts';

const nativeRequire = createRequire(path.resolve('package.json'));
function load<T>(file: string, dependencies: Record<string, unknown> = {}): T {
	const code = transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
	const exports = {};
	runInNewContext(code, { exports, process, Buffer, require: (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : nativeRequire(name) });
	return exports as T;
}
const github = load<typeof import('./githubRepo.ts')>('src/chat/githubRepo.ts');
const repoWork = load<typeof import('./repoWork.ts')>('src/chat/repoWork.ts', { './githubRepo': github });
function method(file: string, name: string, globals: Record<string, unknown> = {}): (...args: any[]) => any {
	const source = readFileSync(file, 'utf8');
	const found = new RegExp(`(?:private |public )(?:async )?${name}\\([\\s\\S]*?\\n\\t\\}`).exec(source)?.[0];
	assert.ok(found, name);
	const code = transpileModule(`({ ${found.replace(/^(?:private|public) /, '')} })`, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
	return runInNewContext(code, globals)[name];
}
const view = 'src/chat/chatView.ts';
async function fixture(work: (state: { scratch: string; storage: string; base: string; copy: string; owned: string; git: string }) => Promise<void>): Promise<void> {
	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-browser-git-safety-'));
	const storage = path.join(scratch, 'storage');
	const base = path.join(storage, 'github', 'owner', 'repo', 'base');
	const owned = 'ai-browser/owned-test';
	const name = `ai-browser-owned-test-${createHash('sha256').update(owned).digest('hex').slice(0, 6)}`;
	const copy = path.join(storage, 'github', 'owner', 'repo', 'copies', name);
	const git = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).trim().split('\n')[0].trim();
	try {
		await fs.mkdir(base, { recursive: true });
		const g = (cwd: string, args: string[]) => repoWork.runGit(git, ['-c', 'commit.gpgsign=false', '-c', 'user.name=Review', '-c', 'user.email=review@example.invalid', '-c', `core.hooksPath=${os.devNull}`, ...args], cwd);
		await g(base, ['init', '-b', 'main']); await g(base, ['commit', '--allow-empty', '-m', 'base']);
		await g(base, ['worktree', 'add', '-b', owned, copy, 'main']);
		await g(base, ['branch', 'existing-feature']);
		await g(copy, ['switch', 'existing-feature']);
		await g(copy, ['commit', '--allow-empty', '-m', 'unmerged feature']);
		await work({ scratch, storage, base, copy, owned, git });
	} finally { await fs.rm(scratch, { recursive: true, force: true }); }
}

for (const removal of ['active-copy', 'recent-copy', 'legacy-branch-metadata', 'detached-copy']) {
	test(`${removal}: cleanup preserves the selected unmerged branch and deletes only the owned branch`, async () => {
		await fixture(async ({ storage, base, copy, owned, git }) => {
			const tab = { _chat: { copy: { repo: 'owner/repo', base: 'main', branch: owned } }, started: false, _post() {} };
			method('src/chat/chatTab.ts', 'updateCopyBranch').call(tab, 'existing-feature');
			assert.equal(tab._chat.copy.branch, 'existing-feature');
			assert.equal((tab._chat.copy as { ownedBranch?: string }).ownedBranch, owned);
			if (removal === 'detached-copy') {
				await repoWork.runGit(git, ['checkout', '--detach'], copy);
				await repoWork.removeStoredCopy(git, storage, copy);
			} else if (removal === 'recent-copy') { await repoWork.removeStoredCopy(git, storage, copy); }
			else { await repoWork.removeCopy(git, storage, { owner: 'owner', name: 'repo' }, copy, removal === 'active-copy' ? owned : 'existing-feature'); }
			assert.equal((await repoWork.runGit(git, ['branch', '--list', owned], base)).trim(), '');
			assert.equal((await repoWork.runGit(git, ['branch', '--list', 'existing-feature'], base)).trim(), 'existing-feature');
			assert.equal((await repoWork.runGit(git, ['log', '-1', '--format=%s', 'existing-feature'], base)).trim(), 'unmerged feature');
		});
	});
}

test('managed-copy ownership is checked before Git, also for selected subdirectories and rewritten markers', async () => {
	await fixture(async ({ storage, base, copy, git }) => {
		await fs.mkdir(path.join(copy, 'sub'));
		const globals = { fs: { promises: fs }, path, managedCopy: repoWork.managedCopy, isOurWorktree: repoWork.isOurWorktree, parseRepo: github.parseRepo };
		const host: any = { _tabs: [], _repoStorage: () => storage };
		host._assertGitFolder = method(view, '_assertGitFolder', globals);
		await host._assertGitFolder(copy);
		await host._assertGitFolder(path.join(copy, 'sub'));
		const marker = await fs.readFile(path.join(copy, '.git'), 'utf8');
		await fs.writeFile(path.join(copy, '.git'), `gitdir: ${path.join(base, '.git')}\n`);
		let called = false;
		const checked = method(view, '_runWorkdirGit', { runGit: () => { called = true; } });
		await assert.rejects(checked.call(host, git, ['commit', '-m', 'wrong repository'], copy), /original Git worktree/);
		await assert.rejects(checked.call(host, git, ['switch', 'main'], path.join(copy, 'sub')), /original Git worktree/);
		assert.equal(called, false);
		await fs.writeFile(path.join(copy, '.git'), marker);
		await host._assertGitFolder(copy);
	});
});

test('real root, subdirectory and symlink aliases share an identity; another worktree stays distinct', async () => {
	await fixture(async ({ base, copy, git, scratch }) => {
		const globals = { fs: { promises: fs }, path, gitBinary: async () => git, runGit: repoWork.runGit };
		const host: any = { _assertGitFolder: async () => {} };
		host._gitWorktreeIdentity = method(view, '_gitWorktreeIdentity', globals);
		await fs.mkdir(path.join(copy, 'sub'));
		const root = await host._gitWorktreeIdentity(copy);
		assert.equal(await host._gitWorktreeIdentity(path.join(copy, 'sub')), root);
		assert.notEqual(await host._gitWorktreeIdentity(base), root);
		if (process.platform !== 'win32') {
			const alias = path.join(scratch, 'alias'); await fs.symlink(copy, alias);
			assert.equal(await host._gitWorktreeIdentity(alias), root);
		}
		const access = new GitAccess(folder => host._gitWorktreeIdentity(folder));
		await assert.rejects(access.mutate(path.join(copy, 'sub'), () => [copy]), /Wait for agents/);
	});
});

test('a blocked composer send preserves its text and attachments instead of starting an agent', async () => {
	const access = new GitAccess(async () => 'same-worktree');
	const release = await access.mutate('/repo', () => []);
	const attachments = [{ chip: { label: 'keep attachment' } }];
	let started = false, restored = '';
	const tab = { id: 'tab', chat: {}, cwd: '/repo/sub', started: true, attachments, push() {},
		takeDraftAttachments() { const draft = this.attachments; this.attachments = []; return draft; },
		async send() { started = true; } };
	const host = {
		_tabs: [tab], _active: tab, _disposed: false, _gitAccess: access, _blocked: () => false,
		_registry: { detecting: false, backend: () => ({}) }, _selection: () => ({ agent: 'codex', model: 'selected' }),
		_rememberInput() {}, _postMessage(message: { text: string }) { restored = message.text; }, _saveTabs() {},
	};
	const send = method(view, '_send');
	await send.call(host, 'keep my message', 'tab');
	assert.equal(started, false); assert.equal(restored, 'keep my message'); assert.equal(tab.attachments, attachments);
	release();
	await send.call(host, 'keep my message', 'tab');
	assert.equal(started, true); assert.equal(tab.attachments.length, 0);
});

test('background toolbar skills use the same Git launch guard as composer sends', async () => {
	const access = new GitAccess(async () => 'same-worktree');
	const release = await access.mutate('/repo', () => []);
	let started = false, failure = '';
	const tab = { id: 'tab', chat: { id: 'chat' }, cwd: '/repo/sub' };
	const host = {
		_tabs: [tab], _active: tab, _disposed: false, _gitAccess: access, _blocked: () => false,
		_toolbar: () => [{ id: 'skill', name: 'skill', agents: 'all', params: [], result: 'silent' }],
		_registry: { detecting: false, commandsFor: () => ({}), backend: () => ({}) },
		_selection: () => ({ agent: 'codex', model: 'selected' }), _chatSkillTabs: new Map(),
		_runs: { isRunning: () => false, start() { started = true; } }, _untrusted: () => false,
	};
	const run = method(view, '_runToolbarSkill', { fillPrompt: () => ({ steps: [{ text: 'run' }] }), adaptSigils: (text: string) => text,
		isDirectory: () => true, refuse: (text: string) => { failure = text; } });
	await run.call(host, 'skill', {}, 'tab');
	assert.equal(started, false); assert.match(failure, /Git is updating/);
	release();
	await run.call(host, 'skill', {}, 'tab');
	assert.equal(started, true);
});

test('Stop cancels a Chrome send waiting behind a push, and a later send can still start', async () => {
	const access = new GitAccess(async () => 'same-worktree');
	// Push/publish can hold the Git lock while this conversation's agent runs.
	const release = await access.mutate('/repo', () => []);
	let running = true, launches = 0;
	const tab = { id: 'tab', chat: {}, cwd: '/repo', started: true, _stopGeneration: 0, _pending: [],
		get stopGeneration() { return this._stopGeneration; },
		_session: { stop() { running = false; } },
		push() {}, async send() { launches++; return true; } };
	const host = { _tabs: [tab], _active: tab, _disposed: false, _gitAccess: access, _blocked: () => false,
		_registry: { detecting: false, backend: () => ({}) }, _selection: () => ({ agent: 'codex', model: 'selected' }),
		_saveTabs() {}, _removeSentAnnotations() {} };
	const send = method(view, '_send');
	const pending = send.call(host, 'Chrome follow-up', 'tab', []);
	await Promise.resolve();
	assert.equal(running, true, 'the running turn makes Stop available');
	method('src/chat/chatTab.ts', 'stop').call(tab);
	assert.equal(running, false);
	release(); await pending;
	assert.equal(launches, 0, 'a send which was still waiting must not restart the stopped agent');
	await send.call(host, 'new message after Stop', 'tab', []);
	assert.equal(launches, 1);
});
