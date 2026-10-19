import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export interface TemporaryFolder {
 path: string;
 files: number;
 bytes: number;
 protected: number;
}
export interface TemporaryStorage {
 project?: string;
 projectFiles: number;
 projectBytes: number;
 folders: TemporaryFolder[];
 files: number;
 bytes: number;
 deleted: number;
 skipped: number;
 errors: number;
 busy?: string;
}
export function temporaryProject(): string | undefined { return currentProject(); }

interface RecordFile { file: string; project?: string; pid: number }
let inventory: (() => Promise<string>) | undefined;
let currentProject: () => string | undefined = () => undefined;

export function configureTemporaryFiles(directory: () => Promise<string>, project: () => string | undefined): void {
 inventory = directory; currentProject = project;
}

/** A separate private record per file avoids lost updates between VS Code windows. */
export async function trackTemporaryFile(file: string, project?: string): Promise<void> {
 if (!inventory) { return; }
 if (arguments.length < 2) { project = currentProject(); }
 let temporary: string | undefined;
 try {
  const directory = await inventory();
  const name = createHash('sha256').update(path.resolve(file)).digest('hex') + '.json';
  temporary = path.join(directory, `${name}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, JSON.stringify({ file: path.resolve(file), project, pid: process.pid }), { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, path.join(directory, name));
 } catch { /* Accounting must not interrupt capture or delivery. */ }
 finally { if (temporary) { await fs.unlink(temporary).catch(() => {}); } }
}

async function realDirectory(directory: string): Promise<boolean> {
 try { const info = await fs.lstat(directory); return info.isDirectory() && !info.isSymbolicLink(); } catch { return false; }
}
/** Resolve the trusted base once; links in descendants must not change the destination. */
async function containedDirectory(directory: string, base: string): Promise<boolean> {
 if (!await realDirectory(base) || !await realDirectory(directory)) { return false; }
 const relative = path.relative(base, directory);
 if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) { return false; }
 const actualBase = await fs.realpath(base).catch(() => undefined);
 const actualDirectory = await fs.realpath(directory).catch(() => undefined);
 return !!actualBase && actualDirectory === path.join(actualBase, relative);
}
function running(pid: number): boolean {
 try { process.kill(pid, 0); return true; } catch (error: any) { return error.code !== 'ESRCH'; }
}

/** Only known capture directories and extension report names are eligible; never recurse through links. */
export async function temporaryStorage(options: {
 root: string; legacyRoots?: readonly string[]; inventory: string; projects: readonly string[]; project?: string;
 protectedFiles?: readonly string[]; cleanup?: 'all' | 'project'; busy?: string; requestsRoot?: string; protect?: (file: string) => boolean;
}): Promise<TemporaryStorage> {
 const records = new Map<string, RecordFile>();
 const metadata = new Map<string, string>();
 for (const directory of [options.inventory, ...(options.legacyRoots ?? []).map(root => path.join(root, 'inventory'))]) {
  if (!await realDirectory(directory)) { continue; }
  for (const name of await fs.readdir(directory)) {
   if (!/^[a-f0-9]{64}\.json$/.test(name)) { continue; }
   const index = path.join(directory, name);
   try {
    if (!(await fs.lstat(index)).isFile()) { continue; }
    const entry: RecordFile = JSON.parse(await fs.readFile(index, 'utf8'));
    if (typeof entry.file !== 'string' || !path.isAbsolute(entry.file) || (!Number.isInteger(entry.pid) || entry.pid <= 0) || (entry.project !== undefined && typeof entry.project !== 'string')) { continue; }
    records.set(entry.file, entry); metadata.set(entry.file, index);
   } catch { /* Incomplete or old record. */ }
  }
 }
 const folders = new Map<string, TemporaryFolder>();
 const candidates: { directory: string; pattern: RegExp; base?: string; project?: string; service?: boolean; request?: boolean; trackedOnly?: boolean }[] = [];
 for (const root of [options.root, ...(options.legacyRoots ?? [])]) {
 const firstCandidate = candidates.length;
 candidates.push(
  { directory: path.join(root, 'screenshots'), pattern: /\.png$/i },
  { directory: path.join(root, 'recordings'), pattern: /^[a-f0-9-]+\.(mp4|webm)$/i },
  { directory: path.join(root, 'voice'), pattern: /^voice-[a-f0-9-]+\.m4a$/i },
  { directory: path.join(root, 'reports'), pattern: /^(element|chat)-[a-z0-9-]+\.md$/ },
  { directory: path.join(root, 'chat'), pattern: /^mcp-\d+-[a-f0-9-]+\.json$/, service: true },
  { directory: path.join(root, 'shared', 'runtime', 'chat'), pattern: /^mcp-\d+-[a-f0-9-]+\.json$/, service: true },
 );
 const owners = [path.join(root, 'shared')];
 const projectsDirectory = path.join(root, 'projects');
 if (await realDirectory(projectsDirectory)) {
  for (const name of await fs.readdir(projectsDirectory)) {
   if (/^[a-f0-9]{16}$/.test(name)) {
    const directory = path.join(projectsDirectory, name);
    if (await realDirectory(directory)) { owners.push(directory); }
   }
  }
 }
 for (const owner of owners) {
  if (!await realDirectory(owner)) { continue; }
  candidates.push({ directory: path.join(owner, 'captures'), pattern: /\.png$|^[a-f0-9-]+\.(mp4|webm)$|^voice-[a-f0-9-]+\.m4a$/i },
   { directory: path.join(owner, 'reports'), pattern: /^(element|chat)-[a-z0-9-]+\.md$/ },
   { directory: path.join(owner, 'files'), pattern: /./, trackedOnly: true });
 }
 for (let index = firstCandidate; index < candidates.length; index++) { candidates[index].base = root; }
 }
 // Legacy isolated AI requests clean themselves in finally. Only abandoned old instructions are eligible.
 for (const requestRoot of [options.requestsRoot ?? os.tmpdir(), path.join(options.root, 'shared', 'runtime'), path.join(options.root, 'runtime')]) {
 if (!await realDirectory(requestRoot)) { continue; }
 if (requestRoot.startsWith(options.root + path.sep)) {
  const root = await fs.realpath(options.root).catch(() => undefined);
  if (!root || await fs.realpath(requestRoot).catch(() => undefined) !== path.join(root, path.relative(options.root, requestRoot))) { continue; }
 }
 for (const name of await fs.readdir(requestRoot).catch(() => [])) {
  if (!/^ai-browser-(title|commit)-[a-zA-Z0-9]+$/.test(name)) { continue; }
  const directory = path.join(requestRoot, name);
  const stat = await fs.lstat(directory).catch(() => undefined);
  if (stat?.isDirectory() && (process.getuid === undefined || stat.uid === process.getuid()) && (stat.mode & 0o077) === 0) {
   candidates.push({ directory, pattern: /^instructions\.txt$/, request: true, base: requestRoot });
  }
 }
 }
 const projects = new Set([...options.projects, ...[...records.values()].flatMap(record => record.project ? [record.project] : [])]);
 for (const project of projects) { candidates.push({ directory: path.join(project, '.ai-browser'), pattern: /^(element|chat)-[a-z0-9-]+\.md$/, project, base: project }); }
 const result: TemporaryStorage = { project: options.project, projectFiles: 0, projectBytes: 0, folders: [], files: 0, bytes: 0, deleted: 0, skipped: 0, errors: 0, busy: options.busy };
 const protectedFiles = new Set(options.protectedFiles?.map(file => path.resolve(file)));
 for (const candidate of candidates) {
  if (!await realDirectory(candidate.directory)) { continue; }
  // A linked workspace root or any linked descendant is outside the cleanup scope.
  if (!candidate.base || !await containedDirectory(candidate.directory, candidate.base)) { continue; }
  const row: TemporaryFolder = { path: candidate.directory, files: 0, bytes: 0, protected: 0 };
  folders.set(row.path, row);
  for (const name of await fs.readdir(candidate.directory).catch(() => [])) {
   if (!candidate.pattern.test(name)) { continue; }
   const file = path.join(candidate.directory, name);
   try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) { continue; }
    const record = records.get(file);
    if (candidate.trackedOnly && !record) { continue; }
    const owner = record?.project ?? candidate.project;
    const servicePid = candidate.service ? Number(/^mcp-(\d+)-/.exec(name)?.[1]) : undefined;
    const protectedFile = Date.now() - stat.mtimeMs < 60_000 || !!options.busy || !!options.protect?.(file) || protectedFiles.has(file)
     || (record && record.pid !== process.pid && running(record.pid))
     || (servicePid !== undefined && running(servicePid))
     // Isolated request folders may still be the working directory of a live CLI.
     || (candidate.request && Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000);
    const selected = options.cleanup === 'all' || (options.cleanup === 'project' && !!options.project && owner === options.project);
    if (selected && !protectedFile) {
     await fs.unlink(file); result.deleted++;
     const index = metadata.get(file);
     if (index) { await fs.unlink(index).catch(() => {}); }
     continue;
    }
    if (selected && protectedFile) { result.skipped++; }
    row.files++; row.bytes += stat.size;
    if (options.project && owner === options.project) { result.projectFiles++; result.projectBytes += stat.size; }
    if (protectedFile) { row.protected++; }
   } catch (error: any) { if (error.code !== 'ENOENT') { result.errors++; } }
  }
  if (candidate.request && options.cleanup === 'all' && !options.busy && !(options.protect?.(candidate.directory))) {
   const stat = await fs.lstat(candidate.directory).catch(() => undefined);
   if (stat && Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) { await fs.rmdir(candidate.directory).catch(() => {}); }
  }
 }
 if (options.cleanup && !options.busy) {
  for (const [file, index] of metadata) {
   const record = records.get(file)!;
   if (options.cleanup === 'project' && record.project !== options.project) { continue; }
   if (await fs.lstat(file).then(() => true, () => false)) { continue; }
   await fs.unlink(index).catch(() => {});
  }
 }
 result.folders = [...folders.values()];
 result.files = result.folders.reduce((sum, row) => sum + row.files, 0);
 result.bytes = result.folders.reduce((sum, row) => sum + row.bytes, 0);
 return result;
}
