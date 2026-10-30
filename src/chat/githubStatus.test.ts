import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { test } from 'node:test';
import { parseApiPullRequests, parseApiRuns, parseGhPullRequests, parseGhRuns, pickGithubRemote, runState, summarizeChecks } from './githubStatus.ts';

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
