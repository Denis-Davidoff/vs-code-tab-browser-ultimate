import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { test } from 'node:test';
import { canOfferPullRequest, githubFieldError, parseCreatedPr, pullRequestBody, pullRequestHead, pullRequestTitle, parseApiPullRequests, parseApiRuns, parseGhPullRequests, parseGhRuns, parseGhWorkflows, pickGithubRemote, workflowFileUrl, workflowPath, runState, summarizeChecks, parseWatchedRun, runWatchKey, runInFlight, runEndedText } from './githubStatus.ts';

test('summarizeChecks mixes check runs and status contexts', () => {
	deepStrictEqual(summarizeChecks([
		{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: '' },
		{ status: 'COMPLETED', conclusion: 'FAILURE' }, { state: 'PENDING' }, { state: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'SKIPPED' },
	]), { passed: 3, failed: 1, pending: 2 });
	strictEqual(summarizeChecks([]), undefined);
	strictEqual(summarizeChecks(null), undefined);
});

test('runState', () => {
	strictEqual(runState('in_progress', null), 'running');
	strictEqual(runState('queued', null), 'queued');
	strictEqual(runState('completed', 'success'), 'success');
	strictEqual(runState('completed', 'timed_out'), 'failure');
	strictEqual(runState('COMPLETED', 'CANCELLED'), 'cancelled');
	strictEqual(runState('completed', 'action_required'), 'other');
});

test('gh pull requests: fields, current branch, junk dropped', () => {
	const prs = parseGhPullRequests(JSON.stringify([
		{ number: 7, title: 'Fix\nit', url: 'https://github.com/o/n/pull/7', author: { login: 'me' }, headRefName: 'feat', isDraft: true, updatedAt: '2026-10-30T10:00:00Z', reviewDecision: 'APPROVED', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] },
		{ number: 8, url: 'javascript:alert(1)' },
		{ title: 'no number', url: 'https://github.com/o/n/pull/9' },
	]), 'feat');
	strictEqual(prs.length, 1);
	deepStrictEqual(prs[0], { number: 7, url: 'https://github.com/o/n/pull/7', title: 'Fix it', author: 'me', branch: 'feat', draft: true, updatedAt: '2026-10-30T10:00:00Z', review: 'APPROVED', checks: { passed: 1, failed: 0, pending: 0 }, current: true });
	throws(() => parseGhPullRequests('{}'));
});

test('gh runs and API runs read alike', () => {
	const gh = parseGhRuns(JSON.stringify([{ databaseId: 5, name: 'CI', displayTitle: 'feat: x', url: 'https://github.com/o/n/actions/runs/5', headBranch: 'main', event: 'push', status: 'completed', conclusion: 'failure', updatedAt: 't' }]), 'main');
	const api = parseApiRuns(JSON.stringify({ workflow_runs: [{ id: 5, name: 'CI', display_title: 'feat: x', html_url: 'https://github.com/o/n/actions/runs/5', head_branch: 'main', event: 'push', status: 'completed', conclusion: 'failure', updated_at: 't' }] }), 'main');
	deepStrictEqual(gh, api);
	strictEqual(gh[0].state, 'failure');
	strictEqual(gh[0].current, true);
});

test('API pull requests', () => {
	const prs = parseApiPullRequests(JSON.stringify([{ number: 3, title: 'A', html_url: 'https://github.com/o/n/pull/3', user: { login: 'u' }, head: { ref: 'b' }, draft: false, updated_at: 't' }]));
	deepStrictEqual(prs, [{ number: 3, url: 'https://github.com/o/n/pull/3', title: 'A', author: 'u', branch: 'b', draft: false, updatedAt: 't', review: '' }]);
});

test('pickGithubRemote prefers the upstream branch remote, then upstream, then origin', () => {
	const parse = (url: string) => url.includes('github.com') ? url : undefined;
	const remotes = [{ name: 'gitlab', url: 'gitlab.com/x' }, { name: 'origin', url: 'github.com/me/n' }, { name: 'upstream', url: 'github.com/o/n' }, { name: 'mine', url: 'github.com/m/n' }];
	strictEqual(pickGithubRemote(remotes, parse, 'mine'), 'github.com/m/n');
	strictEqual(pickGithubRemote(remotes, parse), 'github.com/o/n');
	strictEqual(pickGithubRemote(remotes, parse, 'gitlab'), 'github.com/o/n');
	strictEqual(pickGithubRemote([{ name: 'a', url: 'x' }], parse), undefined);
});

test('a pull request is offered for a branch that has none and is not the default', () => {
	const base = { repo: 'o/n', source: 'gh' as const, prs: [], runs: [], defaultBranch: 'main' };
	strictEqual(canOfferPullRequest({ ...base, branch: 'feat' }), true);
	strictEqual(canOfferPullRequest({ ...base, branch: 'main' }), false);
	strictEqual(canOfferPullRequest({ ...base }), false);
	strictEqual(canOfferPullRequest({ ...base, branch: 'feat', defaultBranch: undefined }), false);
	const pr = { number: 1, title: 't', url: 'https://github.com/o/n/pull/1', author: 'a', branch: 'feat', draft: false, updatedAt: '', review: '' };
	strictEqual(canOfferPullRequest({ ...base, branch: 'feat', prs: [pr] }), false);
	// A merged pull request's branch, deleted on the remote: nothing to open a pull request for.
	strictEqual(canOfferPullRequest({ ...base, branch: 'feat', upstreamGone: true }), false);
});

test('the head names the fork when the branch was pushed elsewhere', () => {
	strictEqual(pullRequestHead('o/n', 'o/n', 'feat'), 'feat');
	strictEqual(pullRequestHead('o/n', 'O/N', 'feat'), 'feat');
	strictEqual(pullRequestHead('o/n', undefined, 'feat'), 'feat');
	strictEqual(pullRequestHead('up/n', 'me/n', 'feat'), 'me:feat');
});

test('PR identity includes the head repository for both API and gh results', () => {
	const api = parseApiPullRequests(JSON.stringify([{ number: 1, html_url: 'https://github.com/team/project/pull/1', head: { ref: 'fix', repo: { full_name: 'alice/project' } } }]));
	const gh = parseGhPullRequests(JSON.stringify([{ number: 1, url: 'https://github.com/team/project/pull/1', headRefName: 'fix', headRepository: { name: 'project' }, headRepositoryOwner: { login: 'alice' } }]));
	for (const prs of [api, gh]) {
		strictEqual(prs[0].headRepo, 'alice/project');
		const status = { repo: 'team/project', source: 'gh' as const, branch: 'fix', defaultBranch: 'main', prs, runs: [] };
		strictEqual(canOfferPullRequest(status), true, 'a different fork must not hide creation');
		strictEqual(canOfferPullRequest({ ...status, pushRepo: 'ALICE/PROJECT' }), false, 'the same fork and branch already have a PR');
		strictEqual(canOfferPullRequest({ ...status, prs: [{ ...prs[0], headRepo: 'team/project' }] }), false);
		strictEqual(canOfferPullRequest({ ...status, branch: 'local', headBranch: 'fix', pushRepo: 'alice/project' }), false);
	}
});

test('title and body are one line each and bounded', () => {
	strictEqual(pullRequestTitle('  fix\nthing  '), 'fix thing');
	strictEqual(pullRequestTitle('   '), undefined);
	strictEqual(pullRequestTitle(5), undefined);
	strictEqual(pullRequestTitle('x'.repeat(257)), undefined);
	strictEqual(pullRequestBody(['one']), '');
	strictEqual(pullRequestBody(['one', '', 'two']), '- one\n- two');
});

test('the created pull request is read from the API and from gh', () => {
	deepStrictEqual(parseCreatedPr('{"number":7,"html_url":"https://github.com/o/n/pull/7"}'), { number: 7, url: 'https://github.com/o/n/pull/7' });
	deepStrictEqual(parseCreatedPr('Creating...\nhttps://github.com/o/n/pull/12\n'), { number: 12, url: 'https://github.com/o/n/pull/12' });
	strictEqual(parseCreatedPr('{"number":7,"html_url":"https://evil.example/x"}'), undefined);
	strictEqual(parseCreatedPr('nothing'), undefined);
});

test('githubFieldError explains a code-only validation error', () => {
	strictEqual(githubFieldError({ field: 'head', code: 'invalid' }), 'The branch is not on GitHub. Push it (Branches window → Publish), then try again.');
	strictEqual(githubFieldError({ field: 'title', code: 'missing_field' }), 'Validation failed: title is missing field.');
	strictEqual(githubFieldError({ code: 'custom' }), undefined);
	strictEqual(githubFieldError(undefined), undefined);
});

test('a run names the workflow file it came from, and only a real workflow file', () => {
	const sha = 'a'.repeat(40);
	const workflows = parseGhWorkflows(JSON.stringify([{ id: 7, path: '.github/workflows/ci.yml' }, { id: 8, path: 'dynamic/github-code-scanning/codeql' }, { id: 9, path: '.github/workflows/../../x.yml' }]));
	deepStrictEqual([...workflows], [[7, '.github/workflows/ci.yml']]);
	const gh = parseGhRuns(JSON.stringify([
		{ databaseId: 5, name: 'CI', url: 'https://github.com/o/n/actions/runs/5', headBranch: 'main', headSha: sha, workflowDatabaseId: 7 },
		{ databaseId: 6, name: 'CodeQL', url: 'https://github.com/o/n/actions/runs/6', headBranch: 'main', workflowDatabaseId: 8 },
	]), 'main', workflows);
	strictEqual(gh[0].workflowPath, '.github/workflows/ci.yml');
	strictEqual(gh[0].sha, sha);
	strictEqual(gh[1].workflowPath, undefined);
	const api = parseApiRuns(JSON.stringify({ workflow_runs: [{ id: 5, html_url: 'https://github.com/o/n/actions/runs/5', head_branch: 'feat/x', path: '.github/workflows/release.yaml', head_sha: 'nope' }] }));
	strictEqual(api[0].workflowPath, '.github/workflows/release.yaml');
	strictEqual(api[0].sha, undefined);
	strictEqual(workflowFileUrl('o/n', gh[0]), `https://github.com/o/n/blob/${sha}/.github/workflows/ci.yml`);
	strictEqual(workflowFileUrl('o/n', api[0]), 'https://github.com/o/n/blob/feat/x/.github/workflows/release.yaml');
	strictEqual(workflowPath('.github/workflows/sub/x.yml'), undefined);
	strictEqual(workflowPath('.github/workflows/x.txt'), undefined);
});

test('a watched run reads alike from gh and from the API', () => {
	deepStrictEqual(parseWatchedRun(JSON.stringify({ status: 'in_progress', conclusion: '', displayTitle: 'Fix', name: 'CI', url: 'https://github.com/o/r/actions/runs/1' })),
		{ state: 'running', title: 'Fix', url: 'https://github.com/o/r/actions/runs/1' });
	deepStrictEqual(parseWatchedRun(JSON.stringify({ status: 'completed', conclusion: 'failure', display_title: 'Fix', html_url: 'https://github.com/o/r/actions/runs/1' })),
		{ state: 'failure', title: 'Fix', url: 'https://github.com/o/r/actions/runs/1' });
	deepStrictEqual(parseWatchedRun(JSON.stringify({ status: 'completed', conclusion: 'success', name: 'CI', url: 'javascript:alert(1)' })), { state: 'success', title: 'CI' });
	strictEqual(parseWatchedRun('[]'), undefined);
	strictEqual(parseWatchedRun('not json'), undefined);
	strictEqual(parseWatchedRun('{}'), undefined);
});

test('run watch keys, in flight, ended text', () => {
	strictEqual(runWatchKey('Owner/Repo', 42), 'owner/repo#42');
	strictEqual(runInFlight('running'), true);
	strictEqual(runInFlight('queued'), true);
	strictEqual(runInFlight('success'), false);
	strictEqual(runEndedText('failure'), 'Failed.');
	strictEqual(runEndedText('other'), 'Finished.');
});
