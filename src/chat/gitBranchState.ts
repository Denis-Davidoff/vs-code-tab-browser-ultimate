import type { GitBranchState } from './chatProtocol';

/** Full refs distinguish local branches from remote names containing slashes. */
export function parseGitBranches(current: string, refs: string): GitBranchState {
	const branches: { name: string; remote: boolean }[] = [];
	for (const line of refs.split('\n')) {
		const [ref, symbolic] = line.split('\0');
		if (!ref || symbolic) { continue; }
		if (ref.startsWith('refs/heads/')) { branches.push({ name: ref.slice(11), remote: false }); }
		else if (ref.startsWith('refs/remotes/')) { branches.push({ name: ref.slice(13), remote: true }); }
	}
	return { current: current.trim().replace(/^refs\/heads\//, ''), branches };
}

/** Explicit switch targets; no reset, automatic stash, or forced branch deletion. */
export function branchCommand(action: 'switch' | 'create' | 'delete', name: string, remote = false): string[] {
	if (action === 'delete') {
		if (remote) { throw new Error('Only local branches can be deleted here.'); }
		return ['branch', '-d', '--', name];
	}
	if (action === 'create') { return ['switch', '-c', name, '--']; }
	if (remote) { return ['switch', '--track', '-c', name.slice(name.indexOf('/') + 1), `refs/remotes/${name}`, '--']; }
	return ['switch', '--no-guess', name, '--'];
}
