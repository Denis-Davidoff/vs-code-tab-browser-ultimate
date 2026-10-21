import type { GitBranchState, GitHeadUpstream } from './chatProtocol';

/**
 * Reads `for-each-ref --format=` {@link branchRefFormat}. Full refs tell local
 * branches from remote names containing slashes. The current branch also gets
 * its upstream and how far apart the two are — read from refs already
 * fetched, so it costs no network; and each remote's `HEAD` gives its
 * default branch. Older two-field lines (ref, symref) still parse.
 */
export function parseGitBranches(current: string, refs: string, remoteUrls?: string): GitBranchState {
	const branches: { name: string; remote: boolean }[] = [];
	const name = current.trim().replace(/^refs\/heads\//, '');
	const defaults = new Map<string, string>();
	let head: GitHeadUpstream | undefined;
	for (const line of refs.split('\n')) {
		const [ref, symbolic, upstream = '', remote = '', track = '', remoteRef = ''] = line.split('\0');
		if (!ref) { continue; }
		if (symbolic) {
			// `refs/remotes/origin/HEAD` → `refs/remotes/origin/main`: the remote's default branch.
			const match = /^refs\/remotes\/([^/]+)\/HEAD$/.exec(ref);
			if (match && symbolic.startsWith(`refs/remotes/${match[1]}/`)) { defaults.set(match[1], symbolic.slice(`refs/remotes/${match[1]}/`.length)); }
			continue;
		}
		if (ref.startsWith('refs/heads/')) {
			branches.push({ name: ref.slice(11), remote: false });
			if (name && ref.slice(11) === name && upstream.startsWith('refs/remotes/') && remote && remote !== '.') {
				const { ahead, behind, gone } = parseTrack(track);
				// The branch's name on the remote is `remoteref`; the tracking ref
				// can sit elsewhere under a custom fetch refspec, and reading the
				// name from it pushed to a branch of the wrong name.
				const prefix = `refs/remotes/${remote}/`;
				const branch = remoteRef.startsWith('refs/heads/') ? remoteRef.slice(11)
					: upstream.startsWith(prefix) ? upstream.slice(prefix.length) : upstream.slice(13);
				head = { remote, branch, ahead, behind, gone, tracking: upstream };
			}
		} else if (ref.startsWith('refs/remotes/')) { branches.push({ name: ref.slice(13), remote: true }); }
	}
	const remotes = parseRemoteUrls(remoteUrls ?? '').map(r => ({ ...r, ...(defaults.has(r.name) ? { defaultBranch: defaults.get(r.name) } : {}) }));
	return { current: name, branches, ...(head ? { upstream: head } : {}), ...(remoteUrls !== undefined ? { remotes } : {}) };
}

/** The `for-each-ref` format {@link parseGitBranches} reads. */
export const branchRefFormat = '%(refname)%00%(symref)%00%(upstream)%00%(upstream:remotename)%00%(upstream:track)%00%(upstream:remoteref)';

/** `[ahead 3, behind 1]`, `[ahead 3]`, `[behind 1]`, `[gone]` or nothing. */
export function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
	const ahead = /ahead (\d+)/.exec(track);
	const behind = /behind (\d+)/.exec(track);
	return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0, gone: /\bgone\b/.test(track) };
}

/**
 * `git config --get-regexp '^remote\..*\.url$'`: one remote per line, in
 * config order. A remote with several urls is listed once, with its first.
 */
export function parseRemoteUrls(output: string): { name: string; url: string }[] {
	const remotes: { name: string; url: string }[] = [];
	for (const line of output.split('\n')) {
		const match = /^remote\.(.+)\.url (.+)$/.exec(line.trim());
		// Credentials in an https url (`https://user:token@host/…`) stay here:
		// the state goes to the webview, which needs only the host and path.
		if (match && !remotes.some(r => r.name === match[1])) { remotes.push({ name: match[1], url: match[2].replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1') }); }
	}
	return remotes;
}

/**
 * The remote a branch with no upstream is published to: the one asked for
 * when it exists, else `origin`, else the only one. Several and none of them
 * `origin` is the caller's question to ask.
 */
export function publishRemote(remotes: readonly string[], asked?: string): string | undefined {
	if (asked !== undefined) { return remotes.includes(asked) ? asked : undefined; }
	if (remotes.includes('origin')) { return 'origin'; }
	return remotes.length === 1 ? remotes[0] : undefined;
}

/**
 * Whether pushing `branch` to `remote` lands on that remote's default branch —
 * the one push this window asks about first. Without a known default, `main`
 * and `master` count.
 */
export function pushesDefaultBranch(branch: string, defaultBranch?: string): boolean {
	return defaultBranch ? branch === defaultBranch : branch === 'main' || branch === 'master';
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
