import type { WorkdirGitStatus, GitStatusFile } from './chatProtocol';

/** Porcelain v1 -z keeps filenames literal; renames have an extra source record. */
export function parseGitStatus(output: string): WorkdirGitStatus {
 const staged: GitStatusFile[] = [];
 const unstaged: GitStatusFile[] = [];
 const changed = new Set<string>();
 const deleted = new Set<string>();
 const records = output.split('\0');
 for (let i = 0; i < records.length; i++) {
  const record = records[i];
  if (record.length < 4) { continue; }
  const x = record[0], y = record[1], path = record.slice(3);
  const originalPath = x === 'R' || x === 'C' || y === 'R' || y === 'C' ? records[++i] : undefined;
  if (x === '?' && y === '?') {
   unstaged.push({ path, status: '?' }); changed.add(path); continue;
  }
  if (x !== ' ' && x !== '?') { staged.push({ path, status: x, ...(originalPath ? { originalPath } : {}) }); }
  if (y !== ' ' && y !== '?') { unstaged.push({ path, status: y, ...(originalPath && (y === 'R' || y === 'C') ? { originalPath } : {}) }); }
  if (x === 'D' || y === 'D') { deleted.add(path); }
  else { changed.add(path); }
 }
 return { staged, unstaged, changed: changed.size, deleted: deleted.size };
}
