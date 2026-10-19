import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { test } from 'node:test';
import { configureTemporaryFiles, trackTemporaryFile, temporaryStorage } from './temporaryFiles.ts';

async function harness() {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'temp-storage-test-'));
 const inventory = path.join(root, 'inventory'); await fs.mkdir(inventory);
 configureTemporaryFiles(async () => inventory, () => '/project-one');
 const options = { root, inventory, projects: [], project: '/project-one', requestsRoot: root };
 const write = async (category: string, name: string, project?: string, tracked = true) => {
  const directory = path.join(root, category); await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, name); await fs.writeFile(file, 'test');
  const earlier = new Date(Date.now() - 120_000); await fs.utimes(file, earlier, earlier);
  if (tracked) { await trackTemporaryFile(file, project ?? '/project-one'); }
  return file;
 };
 return { root, options, write, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('inventory survives scans and project cleaning respects ownership and draft attachments', async () => {
 const h = await harness();
 try {
  const own = await h.write('screenshots', 'one.png');
  const other = await h.write('screenshots', 'two.png', '/project-two');
  const draft = await h.write('recordings', 'abcd.mp4');
  let result = await temporaryStorage(h.options);
  assert.equal(result.files, 3); assert.equal(result.bytes, 12);
  result = await temporaryStorage({ ...h.options, cleanup: 'project', protectedFiles: [draft] });
  assert.equal(result.deleted, 1); assert.equal(result.skipped, 1); assert.equal(result.files, 2);
  await assert.rejects(fs.stat(own)); await fs.stat(other); await fs.stat(draft);
  result = await temporaryStorage({ ...h.options, cleanup: 'all' });
  assert.equal(result.deleted, 2); assert.equal(result.files, 0);
  assert.equal((await fs.readdir(h.options.inventory)).length, 0);
 } finally { await h.cleanup(); }
});

test('busy state and dynamic protection prevent deleting in-use files', async () => {
 const h = await harness();
 try {
  const file = await h.write('screenshots', 'one.png');
  assert.equal((await temporaryStorage({ ...h.options, cleanup: 'all', busy: 'Recording' })).deleted, 0);
  assert.equal((await temporaryStorage({ ...h.options, cleanup: 'all', protect: () => true })).deleted, 0);
  await fs.stat(file);
 } finally { await h.cleanup(); }
});

test('recent legacy files, unknown files, live credentials and files from another live process are kept', async () => {
 const h = await harness();
 try {
  const recent = await h.write('screenshots', 'recent.png', undefined, false);
  const now = new Date(); await fs.utimes(recent, now, now);
  const unknown = await h.write('screenshots', 'user.txt', undefined, false);
  const secret = await h.write('chat', `mcp-${process.pid}-aaaa.json`, undefined, false);
  const foreign = await h.write('screenshots', 'foreign.png');
  for (const name of await fs.readdir(h.options.inventory)) {
   const file = path.join(h.options.inventory, name);
   const record = JSON.parse(await fs.readFile(file, 'utf8'));
   if (record.file === foreign) { record.pid = process.ppid; await fs.writeFile(file, JSON.stringify(record)); }
  }
  const result = await temporaryStorage({ ...h.options, cleanup: 'all' });
  assert.equal(result.deleted, 0); assert.equal(result.skipped, 3);
  for (const file of [recent, unknown, secret, foreign]) { await fs.stat(file); }
 } finally { await h.cleanup(); }
});

test('legacy stale captures are removed without following file or folder symlinks', async () => {
 const h = await harness();
 const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'temp-outside-test-'));
 try {
  const old = await h.write('screenshots', 'old.png', undefined, false);
  const time = new Date(Date.now() - 48 * 60 * 60 * 1000); await fs.utimes(old, time, time);
  const outsideFile = path.join(outside, 'keep.png'); await fs.writeFile(outsideFile, 'keep'); await fs.utimes(outsideFile, time, time);
  await fs.symlink(outsideFile, path.join(h.root, 'screenshots', 'link.png'));
  await fs.symlink(outside, path.join(h.root, 'reports'));
  const result = await temporaryStorage({ ...h.options, cleanup: 'all' });
  assert.equal(result.deleted, 1); await fs.stat(outsideFile);
  assert.equal((await fs.lstat(path.join(h.root, 'screenshots', 'link.png'))).isSymbolicLink(), true);
 } finally { await h.cleanup(); await fs.rm(outside, { recursive: true, force: true }); }
});


test('freshly handed-off files remain protected while consumers finish reading', async () => {
 const h = await harness();
 try {
  const file = await h.write('screenshots', 'handoff.png');
  const now = new Date(); await fs.utimes(file, now, now);
  const result = await temporaryStorage({ ...h.options, cleanup: 'all' });
  assert.equal(result.deleted, 0); assert.equal(result.skipped, 1); await fs.stat(file);
 } finally { await h.cleanup(); }
});

test('project report folders only delete known reports and keep user files and ignore rules', async () => {
 const h = await harness();
 try {
  const project = path.join(h.root, 'project');
  const reports = path.join(project, '.ai-browser'); await fs.mkdir(reports, { recursive: true });
  const report = path.join(reports, 'chat-example.md');
  await fs.writeFile(report, 'temporary');
  const time = new Date(Date.now() - 48 * 60 * 60 * 1000); await fs.utimes(report, time, time);
  await fs.writeFile(path.join(reports, 'notes.md'), 'user content');
  await fs.writeFile(path.join(reports, '.gitignore'), '*');
  const result = await temporaryStorage({ ...h.options, projects: [project], project, cleanup: 'project' });
  assert.equal(result.deleted, 1);
  await fs.stat(path.join(reports, 'notes.md')); await fs.stat(path.join(reports, '.gitignore'));
 } finally { await h.cleanup(); }
});

test('abandoned isolated request instructions can be cleaned, but recent requests remain intact', async () => {
 const h = await harness();
 try {
  const oldDirectory = await fs.mkdtemp(path.join(h.root, 'ai-browser-title-'));
  const newDirectory = await fs.mkdtemp(path.join(h.root, 'ai-browser-commit-'));
  const oldFile = path.join(oldDirectory, 'instructions.txt');
  const newFile = path.join(newDirectory, 'instructions.txt');
  await fs.writeFile(oldFile, 'instructions'); await fs.writeFile(newFile, 'instructions');
  const time = new Date(Date.now() - 48 * 60 * 60 * 1000); await fs.utimes(oldFile, time, time);
  const result = await temporaryStorage({ ...h.options, cleanup: 'all' });
  assert.equal(result.deleted, 1); await assert.rejects(fs.stat(oldFile)); await fs.stat(newFile);
 } finally { await h.cleanup(); }
});

test('reusing a capture filename updates project ownership atomically', async () => {
 const h = await harness();
 try {
  const file = await h.write('screenshots', 'reused.png');
  await trackTemporaryFile(file, '/project-two');
  const result = await temporaryStorage({ ...h.options, cleanup: 'project' });
  assert.equal(result.deleted, 0); await fs.stat(file);
  const all = await temporaryStorage({ ...h.options, project: '/project-two', cleanup: 'project' });
  assert.equal(all.deleted, 1);
 } finally { await h.cleanup(); }
});

test('home project captures and legacy temp captures stay accounted with their original ownership', async () => {
 const h = await harness();
 try {
  const projectFile = await h.write('projects/0123456789abcdef/captures', 'home.png');
  const legacy = path.join(h.root, 'legacy');
  const legacyFile = await h.write('legacy/screenshots', 'legacy.png');
  await fs.mkdir(path.join(legacy, 'inventory'));
  for (const name of await fs.readdir(h.options.inventory)) {
   const index = path.join(h.options.inventory, name);
   const record = JSON.parse(await fs.readFile(index, 'utf8'));
   if (record.file === legacyFile) { await fs.rename(index, path.join(legacy, 'inventory', name)); }
  }
  const result = await temporaryStorage({ ...h.options, legacyRoots: [legacy], cleanup: 'project' });
  assert.equal(result.deleted, 2);
  await assert.rejects(fs.stat(projectFile)); await assert.rejects(fs.stat(legacyFile));
 } finally { await h.cleanup(); }
});

test('shared miscellaneous storage only cleans registered extension artifacts', async () => {
 const h = await harness();
 try {
  const known = await h.write('shared/files', 'once.bin');
  const unknown = await h.write('shared/files', 'personal.bin', undefined, false);
  const result = await temporaryStorage({ ...h.options, cleanup: 'all' });
  assert.equal(result.deleted, 1); await assert.rejects(fs.stat(known)); await fs.stat(unknown);
 } finally { await h.cleanup(); }
});

test('runtime discovery refuses a linked shared folder', async () => {
 const h = await harness();
 const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-outside-test-'));
 try {
  const runtime = path.join(outside, 'runtime'); await fs.mkdir(runtime);
  const request = await fs.mkdtemp(path.join(runtime, 'ai-browser-title-'));
  const instructions = path.join(request, 'instructions.txt'); await fs.writeFile(instructions, 'keep');
  const time = new Date(Date.now() - 48 * 60 * 60 * 1000); await fs.utimes(instructions, time, time);
  await fs.symlink(outside, path.join(h.root, 'shared'));
  const result = await temporaryStorage({ ...h.options, cleanup: 'all' });
  assert.equal(result.deleted, 0); await fs.stat(instructions);
 } finally { await h.cleanup(); await fs.rm(outside, { recursive: true, force: true }); }
});

test('cleanup refuses linked ancestors of credential folders and linked workspace roots', async () => {
 const h = await harness();
 const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-ancestor-test-'));
 try {
  const chat = path.join(outside, 'runtime', 'chat'); await fs.mkdir(chat, { recursive: true });
  const credentials = path.join(chat, 'mcp-2147483647-aaaa.json'); await fs.writeFile(credentials, 'keep');
  const reports = path.join(outside, '.ai-browser'); await fs.mkdir(reports);
  const report = path.join(reports, 'chat-keep.md'); await fs.writeFile(report, 'keep');
  const time = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await fs.utimes(credentials, time, time); await fs.utimes(report, time, time);
  await fs.symlink(outside, path.join(h.root, 'shared'));
  const project = path.join(h.root, 'linked-project'); await fs.symlink(outside, project);
  const options = { ...h.options, projects: [project], project };
  assert.equal((await temporaryStorage({ ...options, cleanup: 'all' })).deleted, 0);
  assert.equal((await temporaryStorage({ ...options, cleanup: 'project' })).deleted, 0);
  await fs.stat(credentials); await fs.stat(report);
 } finally { await h.cleanup(); await fs.rm(outside, { recursive: true, force: true }); }
});


test('manual cleanup removes legacy captures younger than a day after handoff grace expires', async () => {
 const h = await harness();
 try {
  const file = await h.write('screenshots', 'legacy-recent.png', undefined, false);
  const result = await temporaryStorage({ ...h.options, cleanup: 'all' });
  assert.equal(result.deleted, 1); assert.equal(result.skipped, 0);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
 } finally { await h.cleanup(); }
});
