import type { WorkdirGitStatus } from './chatProtocol';
import type { CommitGit } from './gitCommit';

/** Change only the index; unstage never restores, removes or overwrites working files. */
export async function changeGitIndex(git: CommitGit, status: WorkdirGitStatus, action: 'stage' | 'unstage', selected?: string): Promise<void> {
	const files = action === 'stage' ? status.unstaged : status.staged;
	const file = selected === undefined ? undefined : files.find(f => f.path === selected);
	if (selected !== undefined && !file) { throw new Error('This file is no longer in that group. Refresh the Git changes.'); }
	if (!files.length) { return; }
	const paths = file ? [file.path, ...(file.originalPath && file.status === 'R' ? [file.originalPath] : [])].map(p => `:(top,literal)${p}`) : [':/'];
	if (action === 'stage') { await git(['add', '--all', '--', ...paths]); return; }
	const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '');
	if (head.trim()) { await git(['reset', '--quiet', 'HEAD', '--', ...paths]); }
	else { await git(['rm', '-r', '--cached', '--force', '--ignore-unmatch', '--', ...paths]); }
}
