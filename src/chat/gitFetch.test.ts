import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { transpileModule, ScriptTarget } from 'typescript';
import { GitFetchScheduler } from './gitFetch.ts';

const exec = promisify(execFile);

test('automatic fetch is throttled per repository, manual fetch bypasses the interval', async () => {
 let time = 100, calls = 0;
 const scheduler = new GitFetchScheduler(120_000, () => time);
 const fetch = async () => { calls++; };
 await scheduler.run('/repo', false, fetch);
 await scheduler.run('/repo', false, fetch); assert.equal(calls, 1);
 await scheduler.run('/other', false, fetch); assert.equal(calls, 2);
 await scheduler.run('/repo', true, fetch); assert.equal(calls, 3);
 time += 120_000; await scheduler.run('/repo', false, fetch); assert.equal(calls, 4);
});

test('simultaneous viewers share a fetch and failed automatic requests are throttled', async () => {
 const scheduler = new GitFetchScheduler();
 let calls = 0, release!: () => void;
 const fetch = async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); };
 const a = scheduler.run('/repo', false, fetch), b = scheduler.run('/repo', false, fetch);
 await Promise.resolve(); assert.equal(calls, 1); release(); await Promise.all([a, b]);
 const failed = async () => { calls++; throw new Error('Offline'); };
 await assert.rejects(scheduler.run('/repo', true, failed), /Offline/);
 await assert.rejects(scheduler.run('/repo', false, failed), /Offline/); assert.equal(calls, 2);
 await scheduler.run('/repo', true, async () => { calls++; }); assert.equal(calls, 3);
});

test('manual requests can recover one failed background fetch without duplicate network work', async () => {
 const scheduler = new GitFetchScheduler();
 let reject!: (error: Error) => void, calls = 0;
 const automatic = scheduler.run('/repo', false, () => new Promise<void>((_, fail) => { reject = fail; }));
 const manual = async () => { calls++; };
 const a = scheduler.run('/repo', true, manual), b = scheduler.run('/repo', true, manual);
 await Promise.resolve(); reject(new Error('Sign in'));
 await assert.rejects(automatic, /Sign in/); await Promise.all([a, b]); assert.equal(calls, 1);
});

test('Chrome and Exchange shared validation retain fetch modes and reject invalid options', () => {
 const source = readFileSync('src/chat/chromeChatProtocol.ts', 'utf8');
 const read = runInNewContext(transpileModule(source.slice(source.indexOf('function readChromeFooterMessage(')) + '\nreadChromeFooterMessage;', { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText);
 for (const fetch of [undefined, 'auto', 'force', 'invalid', true]) {
  const command = read({ type: 'refreshWorkdirGit', ...(fetch === undefined ? {} : { fetch }) });
  if (fetch === true || fetch === 'invalid') assert.equal(command, undefined);
  else { assert.ok(command); assert.equal(command.fetch, fetch); }
 }
});

function fetchMethod(scheduler: GitFetchScheduler, repository?: { fetch(options: { remote: string }): Promise<void> }) {
 const source = readFileSync('src/chat/chatView.ts', 'utf8');
 const method = /private async _fetchWorkdirGit\([\s\S]*?\n\t\}/.exec(source)![0].replace('private ', '');
 return runInNewContext(transpileModule(`({${method}})`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText,
  { fs: { promises: fs }, os, ChatViewProvider: { _gitFetches: scheduler }, gitRepositoryFor: async () => repository })._fetchWorkdirGit;
}

test('background fetch discovers remote commits while preserving HEAD, index and working files', async () => {
 const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'git-fetch-'));
 const bare = path.join(folder, 'remote.git'), writer = path.join(folder, 'writer'), viewer = path.join(folder, 'viewer');
 const git = async (cwd: string, args: string[]) => (await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd })).stdout;
 try {
  await git(folder, ['init', '--bare', '-b', 'main', bare]);
  await git(folder, ['clone', bare, writer]);
  await fs.writeFile(path.join(writer, 'file'), 'initial');
  await git(writer, ['add', '.']); await git(writer, ['commit', '-m', 'initial']); await git(writer, ['push', '-u', 'origin', 'main']);
  await git(folder, ['clone', bare, viewer]);
  await fs.writeFile(path.join(writer, 'file'), 'remote');
  await git(writer, ['commit', '-am', 'remote']); await git(writer, ['push']);
  await fs.writeFile(path.join(viewer, 'file'), 'staged'); await git(viewer, ['add', 'file']);
  await fs.writeFile(path.join(viewer, 'file'), 'unsaved local work');
  const before = await git(viewer, ['rev-parse', 'HEAD']); const index = await git(viewer, ['write-tree']);
  const method = fetchMethod(new GitFetchScheduler());
  const calls: any[] = [];
  const host = { _disposed: false, _blocked: () => false, _untrusted: () => false,
   async _runWorkdirGit(_: string, args: string[], cwd: string, timeout?: number, env?: any) {
    calls.push({ args, timeout, env }); return git(cwd, args);
   } };
  await method.call(host, 'git', viewer, false);
  assert.equal((await git(viewer, ['rev-list', '--count', 'HEAD..@{upstream}'])).trim(), '1');
  assert.equal(await git(viewer, ['rev-parse', 'HEAD']), before);
  assert.equal(await git(viewer, ['write-tree']), index);
  assert.equal(await fs.readFile(path.join(viewer, 'file'), 'utf8'), 'unsaved local work');
  const network = calls.find(call => call.args.includes('fetch'));
  assert.equal(network.timeout, 20_000); assert.equal(network.env.GIT_ASKPASS, '');
  assert.ok(network.args.includes('--no-recurse-submodules'));
 } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

test('untrusted repositories never start Git or network work', async () => {
 const method = fetchMethod(new GitFetchScheduler());
 await assert.rejects(method.call({ _disposed: false, _blocked: () => false, _untrusted: () => true,
  _runWorkdirGit: () => { throw new Error('must not run'); } }, 'git', '/repo', false), /Trust this repository/);
});
