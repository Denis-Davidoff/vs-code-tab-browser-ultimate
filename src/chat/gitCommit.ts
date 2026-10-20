/** Git is injected so the same workflow can be exercised against temporary repositories. */
export type CommitGit = (args: readonly string[]) => Promise<string>;
export type CommitScope = 'smart' | 'staged' | 'all';

export function commitContext(files: string, diff: string, history: string, branch = ''): string {
	const limit = 120_000;
	// The branch is where a task ID usually is (feature/ABC-123-…); it is data, like the rest.
	const branchLine = branch.trim() ? `Branch: ${branch.trim().split('\n')[0].slice(0, 200)}\n\n` : '';
	const header = `${branchLine}Recent commit subjects (style and task IDs only):\n${history.slice(0, 2000)}\n\nStaged files:\n${files.slice(0, 20_000)}\n\nStaged diff:\n`;
	const room = limit - header.length - 80;
	return header + diff.slice(0, room) + (diff.length > room ? '\n[Diff truncated; summarize only the changes shown.]' : '');
}

/** Commit Staged, or stage all when the index is empty. Never include unstaged edits in a staged commit. */
export async function commitChanges(git: CommitGit, generate: (context: string) => Promise<string>, guard: () => void, phase: (phase: 'generating' | 'committing') => void, scope: CommitScope = 'smart'): Promise<{ message: string; hash: string }> {
	guard();
	await git(['rev-parse', '--show-toplevel']);
	const unresolved = await git(['diff', '--name-only', '--diff-filter=U', '-z']);
	if (unresolved) { throw new Error('Resolve merge conflicts before committing.'); }
	let files = await git(['diff', '--cached', '--no-relative', '--name-status', '--no-renames', '--no-ext-diff', '--no-textconv']);
	if (scope === 'all' || (!files && scope === 'smart')) {
		guard();
		await git(['add', '--all', '--', ':/']);
		files = await git(['diff', '--cached', '--no-relative', '--name-status', '--no-renames', '--no-ext-diff', '--no-textconv']);
	}
	if (!files.trim()) { throw new Error(scope === 'staged' ? 'No staged changes to commit.' : 'No changes to commit.'); }
	const tree = (await git(['write-tree'])).trim();
	const head = async () => {
		const ref = await git(['symbolic-ref', '--quiet', 'HEAD']).catch(() => '');
		const hash = await git(['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '');
		return `${ref.trim()}\n${hash.trim()}`;
	};
	const originalHead = await head();
	const [diff, history, branch] = await Promise.all([
		git(['diff', '--cached', '--no-relative', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3']),
		git(['log', '-5', '--format=%s']).catch(() => ''),
		git(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
	]);
	guard();
	if ((await git(['write-tree'])).trim() !== tree) { throw new Error('The staged files changed while reading the diff. Press Commit again.'); }
	phase('generating');
	const message = await generate(commitContext(files, diff, history, branch));
	guard();
	if ((await git(['write-tree'])).trim() !== tree || await head() !== originalHead) {
		throw new Error('The staged files or branch changed while the message was being generated. Review the changes and press Commit again.');
	}
	guard();
	phase('committing');
	// Message is a single execFile argument, never a shell command. Git still runs its normal commit checks.
	await git(['commit', '--cleanup=verbatim', '-m', message]);
	const hash = (await git(['rev-parse', '--short', 'HEAD'])).trim();
	return { message, hash };
}
