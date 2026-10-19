import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import * as safeFiles from '../core/safeFiles.ts';

test('activation expires reports across project, shared and legacy directories without following links', async () => {
 const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'report-expiry-test-'));
 const savedHome = process.env.HOME, savedTemp = process.env.TMPDIR;
 process.env.HOME = scratch; process.env.TMPDIR = scratch; safeFiles.resetPrivateTempDirectory();
 try {
  const first = await safeFiles.projectTempDirectory('/project-a', 'reports');
  const second = await safeFiles.projectTempDirectory('/project-b', 'reports');
  const shared = await safeFiles.projectTempDirectory(undefined, 'reports');
  const legacy = path.join(scratch, `ai-browser-${process.getuid?.() ?? 'user'}`);
  await fs.mkdir(legacy, { mode: 0o700 });
  const legacyReports = path.join(legacy, 'reports'); await fs.mkdir(legacyReports);
  const old = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const stale: string[] = [];
  for (const directory of [first, second, shared, legacyReports]) {
   const file = path.join(directory, 'element-old.md');
   await fs.writeFile(file, 'old report'); await fs.utimes(file, old, old); stale.push(file);
  }
  const fresh = path.join(first, 'element-new.md'); await fs.writeFile(fresh, 'new report');
  const personal = path.join(second, 'personal.md'); await fs.writeFile(personal, 'user content'); await fs.utimes(personal, old, old);
  const outside = path.join(scratch, 'outside'); await fs.mkdir(outside);
  const outsideFile = path.join(outside, 'element-old.md'); await fs.writeFile(outsideFile, 'keep'); await fs.utimes(outsideFile, old, old);
  const root = await safeFiles.privateTempDirectory();
  await fs.symlink(outside, path.join(root, 'projects', 'aaaaaaaaaaaaaaaa'));
  const exports: Record<string, any> = {};
  runInNewContext(transpileModule(readFileSync('src/elements/assistants.ts', 'utf8'), {
   compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText, { exports, require: (name: string) => {
   switch (name) {
    case 'fs/promises': return fs;
    case 'path': return path;
    case 'vscode': return { workspace: { workspaceFolders: [] } };
    case '../core/safeFiles': return safeFiles;
    case '../core/temporaryFiles': return { trackTemporaryFile: async () => {}, temporaryProject: () => undefined };
    case '../setup/proposedApi': return { workspaceIsRemoteFromHost: () => false };
    default: throw new Error(`Unexpected dependency ${name}`);
   }
  } });
  await exports.cleanUpReports();
  for (const file of stale) { await assert.rejects(fs.stat(file), { code: 'ENOENT' }); }
  await fs.stat(fresh); await fs.stat(personal); await fs.stat(outsideFile);
  assert.equal((await fs.lstat(path.join(root, 'projects', 'aaaaaaaaaaaaaaaa'))).isSymbolicLink(), true);
 } finally {
  if (savedHome === undefined) { delete process.env.HOME; } else { process.env.HOME = savedHome; }
  if (savedTemp === undefined) { delete process.env.TMPDIR; } else { process.env.TMPDIR = savedTemp; }
  safeFiles.resetPrivateTempDirectory(); await fs.rm(scratch, { recursive: true, force: true });
 }
});
