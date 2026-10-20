import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync, readlinkSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { parseGitStatus } from './gitStatus.ts';
import type { SwitchDialogs, SwitchGit } from './gitBranchSwitch.ts';

const nativeRequire = createRequire(path.resolve('package.json'));
const exports: Record<string, unknown> = {};
runInNewContext(transpileModule(readFileSync('src/chat/gitBranchSwitch.ts', 'utf8'), {
	compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText, { exports, require: (name: string) => name === './gitStatus' ? { parseGitStatus } : nativeRequire(name) });
const { switchAndUpdate } = exports as unknown as typeof import('./gitBranchSwitch.ts');
const cancel: SwitchDialogs = {
	changes: async () => undefined, commit: async () => undefined, discard: async () => false,
	offline: async () => false, localName: async () => undefined,
};

async function repository(work: (git: SwitchGit, folder: string) => Promise<void>): Promise<void> {
	const folder = mkdtempSync(path.join(os.tmpdir(), 'ai-browser-switch-'));
	const git: SwitchGit = async args => execFileSync('git', ['-c', `core.hooksPath=${os.devNull}`,
		'-c', 'commit.gpgsign=false', '-c', 'user.name=Switch Test', '-c', 'user.email=switch@example.invalid', ...args],
		{ cwd: folder, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
	try {
		await git(['init', '-b', 'main']);
		writeFileSync(path.join(folder, 'file.txt'), 'initial');
		await git(['add', '.']); await git(['commit', '-m', 'initial']);
		await git(['branch', 'feature']);
		await work(git, folder);
	} finally { rmSync(folder, { recursive: true, force: true }); }
}

test('dirty changes are not carried across branches; cancel leaves index and files intact', async () => {
	await repository(async (git, folder) => {
		writeFileSync(path.join(folder, 'file.txt'), 'staged'); await git(['add', '.']);
		writeFileSync(path.join(folder, 'file.txt'), 'unstaged');
		let asked = false;
		assert.equal(await switchAndUpdate(git, 'feature', false, { ...cancel, changes: async () => { asked = true; return undefined; } }), undefined);
		assert.equal(asked, true);
		assert.equal((await git(['branch', '--show-current'])).trim(), 'main');
		assert.equal(await git(['show', ':file.txt']), 'staged');
		assert.equal(readFileSync(path.join(folder, 'file.txt'), 'utf8'), 'unstaged');
	});
});

test('stash includes untracked files, keeps index state, and remains saved after checkout', async () => {
	await repository(async (git, folder) => {
		writeFileSync(path.join(folder, 'file.txt'), 'staged'); await git(['add', '.']);
		writeFileSync(path.join(folder, 'file.txt'), 'unstaged');
		writeFileSync(path.join(folder, 'new.txt'), 'new file');
		const result = await switchAndUpdate(git, 'feature', false, { ...cancel, changes: async () => 'stash' });
		assert.equal(result?.branch, 'feature'); assert.ok(result?.stash);
		assert.equal(readFileSync(path.join(folder, 'file.txt'), 'utf8'), 'initial');
		assert.equal(existsSync(path.join(folder, 'new.txt')), false);
		await git(['switch', 'main']); await git(['stash', 'apply', '--index', result.stash.hash]);
		assert.equal(await git(['show', ':file.txt']), 'staged');
		assert.equal(readFileSync(path.join(folder, 'file.txt'), 'utf8'), 'unstaged');
		assert.equal(readFileSync(path.join(folder, 'new.txt'), 'utf8'), 'new file');
		assert.equal((await git(['rev-parse', 'refs/stash'])).trim(), result.stash.hash);
	});
});

test('Commit All saves staged, unstaged and untracked content on original branch', async () => {
	await repository(async (git, folder) => {
		writeFileSync(path.join(folder, 'file.txt'), 'staged'); await git(['add', '.']);
		writeFileSync(path.join(folder, 'file.txt'), 'latest'); writeFileSync(path.join(folder, 'new.txt'), 'new');
		await switchAndUpdate(git, 'feature', false, { ...cancel, changes: async () => 'commit', commit: async preview => {
			assert.ok(preview.includes('new.txt') && preview.includes('latest')); return 'save all';
		} });
		assert.equal((await git(['log', 'main', '-1', '--format=%s'])).trim(), 'save all');
		assert.equal(await git(['show', 'main:file.txt']), 'latest');
		assert.equal(await git(['show', 'main:new.txt']), 'new');
	});
});

test('Discard requires confirmation and preserves ignored files', async () => {
	await repository(async (git, folder) => {
		writeFileSync(path.join(folder, '.gitignore'), 'ignored.txt');
		await git(['add', '.']); await git(['commit', '-m', 'ignore']);
		writeFileSync(path.join(folder, 'file.txt'), 'dirty'); await git(['add', '.']);
		writeFileSync(path.join(folder, 'new.txt'), 'untracked'); writeFileSync(path.join(folder, 'ignored.txt'), 'keep');
		const dialogs: SwitchDialogs = { ...cancel, changes: async () => 'discard' };
		assert.equal(await switchAndUpdate(git, 'feature', false, dialogs), undefined);
		assert.equal(readFileSync(path.join(folder, 'file.txt'), 'utf8'), 'dirty');
		await switchAndUpdate(git, 'feature', false, { ...dialogs, discard: async () => true });
		assert.equal(existsSync(path.join(folder, 'new.txt')), false);
		assert.equal(readFileSync(path.join(folder, 'ignored.txt'), 'utf8'), 'keep');
		assert.equal(readFileSync(path.join(folder, 'file.txt'), 'utf8'), 'initial');
	});
});

test('editing tracked or untracked contents during confirmation cancels discard', async () => {
	for (const file of ['file.txt', 'new.txt']) {
		await repository(async (git, folder) => {
			writeFileSync(path.join(folder, file), 'before');
			await assert.rejects(switchAndUpdate(git, 'feature', false, { ...cancel, changes: async () => 'discard',
				discard: async () => { writeFileSync(path.join(folder, file), 'changed while asking'); return true; },
			}), /files changed/);
			assert.equal(readFileSync(path.join(folder, file), 'utf8'), 'changed while asking');
		});
	}
});

test('remote checkout creates tracking branch once and fast-forwards existing branch', async () => {
	await repository(async (git, folder) => {
		await git(['remote', 'add', 'origin', '.']);
		await git(['config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/server-branch']);
		const first = await switchAndUpdate(git, 'origin/server-branch', true, cancel);
		assert.equal(first?.branch, 'server-branch');
		assert.equal((await git(['rev-parse', '--abbrev-ref', '@{upstream}'])).trim(), 'origin/server-branch');
		await git(['switch', 'main']);
		writeFileSync(path.join(folder, 'file.txt'), 'remote update');
		await git(['add', '.']); await git(['commit', '-m', 'update']);
		await git(['update-ref', 'refs/remotes/origin/server-branch', 'HEAD']);
		// The fetch endpoint below models a remote that has advanced beyond the local tracking branch.
		const remoteHead = (await git(['rev-parse', 'HEAD'])).trim();
		const fetch = async (args: readonly string[]) => args[0] === 'fetch'
			? git(['update-ref', 'refs/remotes/origin/server-branch', remoteHead]) : git(args);
		const second = await switchAndUpdate(fetch, 'origin/server-branch', true, cancel);
		assert.equal(second?.branch, 'server-branch'); assert.equal(second?.note, undefined);
		assert.equal(readFileSync(path.join(folder, 'file.txt'), 'utf8'), 'remote update');
	});
});

test('conflicting local upstream prompts for a new name without repointing existing branch', async () => {
	await repository(async git => {
		await git(['remote', 'add', 'origin', '.']);
		const result = await switchAndUpdate(git, 'origin/feature', true, { ...cancel, localName: async existing => {
			assert.equal(existing, 'feature'); return 'feature-copy';
		} });
		assert.equal(result?.branch, 'feature-copy');
		assert.equal((await git(['for-each-ref', '--format=%(upstream)', 'refs/heads/feature'])).trim(), '');
	});
});

test('fetch failure requires explicit offline choice; divergence never merges automatically', async () => {
	await repository(async (git, folder) => {
		await git(['remote', 'add', 'origin', '.']); await git(['fetch', 'origin']);
		await git(['branch', '--set-upstream-to=origin/main', 'feature']);
		const offline: SwitchGit = args => args[0] === 'fetch' ? Promise.reject(new Error('offline')) : git(args);
		assert.equal(await switchAndUpdate(offline, 'feature', false, cancel), undefined);
		assert.equal((await git(['branch', '--show-current'])).trim(), 'main');
		const result = await switchAndUpdate(offline, 'feature', false, { ...cancel, offline: async () => true });
		assert.ok(result?.note?.includes('local copy'));
		writeFileSync(path.join(folder, 'local.txt'), 'local'); await git(['add', '.']); await git(['commit', '-m', 'local']);
		await git(['switch', 'main']); writeFileSync(path.join(folder, 'remote.txt'), 'remote');
		await git(['add', '.']); await git(['commit', '-m', 'remote']);
		const divergent = await switchAndUpdate(git, 'feature', false, cancel);
		assert.ok(divergent?.note?.includes('could not fast-forward'));
		assert.equal((await git(['log', '-1', '--format=%s'])).trim(), 'local');
		assert.equal((await git(['status', '--porcelain'])).trim(), '');
	});
});

test('in-progress operation and occupied worktree refuse before touching dirty changes', async () => {
	await repository(async (git, folder) => {
		writeFileSync(path.join(folder, '.git', 'MERGE_HEAD'), (await git(['rev-parse', 'HEAD'])).trim());
		await assert.rejects(switchAndUpdate(git, 'feature', false, cancel), /Finish or abort/);
		rmSync(path.join(folder, '.git', 'MERGE_HEAD'));
		const worktree = path.join(folder, 'other-worktree');
		await git(['worktree', 'add', worktree, 'feature']);
		await assert.rejects(switchAndUpdate(git, 'feature', false, cancel), /another worktree/);
	});
});

test('stash remains discoverable when checkout fails after saving changes', async () => {
	await repository(async (git, folder) => {
		writeFileSync(path.join(folder, 'file.txt'), 'keep me');
		let saved: { hash: string; branch: string } | undefined;
		const failing: SwitchGit = args => args[0] === 'switch' ? Promise.reject(new Error('checkout failed')) : git(args);
		await assert.rejects(switchAndUpdate(failing, 'feature', false, { ...cancel, changes: async () => 'stash', stashed: stash => { saved = stash; } }), /checkout failed/);
		assert.ok(saved); assert.equal(saved.branch, 'main');
		assert.equal((await git(['rev-parse', 'refs/stash'])).trim(), saved.hash);
		assert.equal(await git(['show', `${saved.hash}:file.txt`]), 'keep me');
	});
});

test('remote branch removed by fetch is not checked out; local-ahead commits are preserved', async () => {
	await repository(async (git, folder) => {
		await git(['remote', 'add', 'origin', '.']); await git(['fetch', 'origin']);
		const removed: SwitchGit = args => args[0] === 'fetch' ? git(['update-ref', '-d', 'refs/remotes/origin/feature']) : git(args);
		await git(['branch', '--set-upstream-to=origin/feature', 'feature']);
		await assert.rejects(switchAndUpdate(removed, 'origin/feature', true, cancel), /no longer exists/);
		assert.equal((await git(['branch', '--show-current'])).trim(), 'main');
		await git(['branch', '--set-upstream-to=origin/main', 'feature']);
		await git(['switch', 'feature']); writeFileSync(path.join(folder, 'ahead.txt'), 'ahead');
		await git(['add', '.']); await git(['commit', '-m', 'local ahead']);
		const head = (await git(['rev-parse', 'HEAD'])).trim(); await git(['switch', 'main']);
		const result = await switchAndUpdate(git, 'feature', false, cancel);
		assert.equal(result?.note, undefined); assert.equal((await git(['rev-parse', 'HEAD'])).trim(), head);
	});
});

test('a local branch change during fetch cancels before handling any files', async () => {
	await repository(async git => {
		await git(['remote', 'add', 'origin', '.']); await git(['fetch', 'origin']);
		await git(['branch', '--set-upstream-to=origin/main', 'feature']);
		const racing: SwitchGit = async args => {
			if (args[0] === 'fetch') { await git(['switch', 'feature']); return ''; }
			return git(args);
		};
		await assert.rejects(switchAndUpdate(racing, 'feature', false, cancel), /current branch changed/);
	});
});

test('dangling untracked symlinks can be stashed, committed or discarded before checkout', { skip: process.platform === 'win32' }, async () => {
	for (const choice of ['stash', 'commit', 'discard'] as const) {
		await repository(async (git, folder) => {
			symlinkSync('missing-target', path.join(folder, 'link'));
			const result = await switchAndUpdate(git, 'feature', false, {
				...cancel, changes: async () => choice, commit: async () => 'save symlink', discard: async () => true,
			});
			assert.equal(result?.branch, 'feature');
			if (choice === 'stash') {
				assert.ok(result.stash);
				await git(['switch', 'main']); await git(['stash', 'apply', '--index', result.stash.hash]);
				assert.equal(readlinkSync(path.join(folder, 'link')), 'missing-target');
			} else if (choice === 'commit') {
				assert.equal(await git(['show', 'main:link']), 'missing-target');
			} else { assert.equal((await git(['status', '--porcelain'])).trim(), ''); }
		});
	}
});

test('retargeting a symlink to an equal-content file invalidates discard confirmation', { skip: process.platform === 'win32' }, async () => {
	await repository(async (git, folder) => {
		writeFileSync(path.join(folder, 'a.txt'), 'same'); writeFileSync(path.join(folder, 'b.txt'), 'same');
		symlinkSync('a.txt', path.join(folder, 'link'));
		await assert.rejects(switchAndUpdate(git, 'feature', false, {
			...cancel, changes: async () => 'discard', discard: async () => {
				unlinkSync(path.join(folder, 'link')); symlinkSync('b.txt', path.join(folder, 'link')); return true;
			},
		}), /files changed/);
		assert.equal(readlinkSync(path.join(folder, 'link')), 'b.txt');
		assert.equal((await git(['branch', '--show-current'])).trim(), 'main');
	});
});

test('a local branch remains accessible after fetch prunes its deleted upstream', async () => {
	await repository(async (git, folder) => {
		const remote = path.join(folder, 'remote.git');
		await git(['init', '--bare', remote]); await git(['remote', 'add', 'origin', remote]);
		await git(['push', 'origin', 'main', 'feature']);
		await git(['branch', '--set-upstream-to=origin/feature', 'feature']);
		await git(['push', 'origin', '--delete', 'feature']);
		// Keep the local bare fixture out of the working tree status.
		writeFileSync(path.join(folder, '.git', 'info', 'exclude'), 'remote.git/\n');
		const head = (await git(['rev-parse', 'refs/heads/feature'])).trim();
		const result = await switchAndUpdate(git, 'feature', false, cancel);
		assert.equal(result?.branch, 'feature'); assert.ok(result?.note?.includes('upstream branch no longer exists'));
		assert.equal((await git(['rev-parse', 'HEAD'])).trim(), head);
	});
});
