/**
 * The composer's GitHub tab: pull requests and Actions runs of the repository
 * the conversation's working folder belongs to. Reading `gh`'s JSON and the REST
 * API's into one shape, and choosing which remote names the repository. Leaf
 * module, under test: no `vscode`, no relative value imports.
 *
 * Three sources, tried in order by the host (`chatView.ts`, `_githubStatus`):
 * the `gh` CLI (signed in), VS Code's own GitHub sign-in (`authentication`,
 * silent — never prompts), and the public API without a token (public
 * repositories only, 60 requests an hour per address).
 */

export type GithubSource = 'gh' | 'vscode' | 'public';

export interface GithubCheckSummary {
	readonly passed: number;
	readonly failed: number;
	readonly pending: number;
}

export interface GithubPullRequest {
	readonly number: number;
	readonly title: string;
	readonly url: string;
	readonly author: string;
	readonly branch: string;
	/** Repository containing the head branch (forks may reuse branch names). */
	readonly headRepo?: string;
	readonly draft: boolean;
	/** ISO time of the last update. */
	readonly updatedAt: string;
	/** `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or empty (only `gh` says). */
	readonly review: string;
	/** Only `gh` reports checks per pull request; absent from the API's list. */
	readonly checks?: GithubCheckSummary;
	/** Its head is the working folder's branch. */
	readonly current?: boolean;
}

export type GithubRunState = 'success' | 'failure' | 'running' | 'queued' | 'cancelled' | 'skipped' | 'other';

export interface GithubRun {
	readonly id: number;
	readonly name: string;
	readonly title: string;
	readonly url: string;
	readonly branch: string;
	readonly event: string;
	readonly state: GithubRunState;
	readonly updatedAt: string;
	readonly current?: boolean;
}

export interface GithubStatus {
	readonly repo: string;
	readonly source: GithubSource;
	readonly branch?: string;
	/** The name `branch` is pushed under, when it tracks another one (`local-work` → `origin/remote-work`). */
	readonly headBranch?: string;
	readonly pushRepo?: string;
	readonly prs: readonly GithubPullRequest[];
	readonly runs: readonly GithubRun[];
	/** Runs could not be read (Actions off, no access) while the pull requests could. */
	readonly runsError?: string;
	/** The repository's default branch, the base a new pull request is opened against. */
	readonly defaultBranch?: string;
	/** The working folder's branch has an upstream on the remote (a pull request needs it pushed). */
	readonly published?: boolean;
	/** The branch's last commit subject: the title a new pull request starts with. */
	readonly suggestedTitle?: string;
}

/** A pull request just opened from the GitHub tab. */
export interface GithubCreatedPr {
	readonly number: number;
	readonly url: string;
}

/**
 * Whether the tab offers to open a pull request for the working folder's
 * branch: one is checked out, it is not the default branch, and no open pull
 * request has it as its head.
 */
export function canOfferPullRequest(status: GithubStatus): boolean {
	const branch = status.headBranch ?? status.branch;
	if (!branch || !status.defaultBranch || branch === status.defaultBranch) { return false; }
	const repo = (status.pushRepo ?? status.repo).toLowerCase();
	return !status.prs.some(pr => pr.branch === branch && (pr.headRepo ?? status.repo).toLowerCase() === repo);
}

/**
 * The `head` of a new pull request: the bare branch when it lives in the
 * repository the tab shows, `owner:branch` when it was pushed to a fork.
 */
export function pullRequestHead(repo: string, pushRepo: string | undefined, branch: string): string {
	if (!pushRepo || pushRepo.toLowerCase() === repo.toLowerCase()) { return branch; }
	return `${pushRepo.split('/')[0]}:${branch}`;
}

/** A pull request's body from the branch's commit subjects, newest last. */
export function pullRequestBody(subjects: readonly string[]): string {
	const lines = subjects.map(s => s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).filter(Boolean).slice(-50);
	return lines.length > 1 ? lines.map(l => `- ${l}`).join('\n') : '';
}

/** A title the user typed: one line, not empty, at most 256 characters as GitHub allows. */
export function pullRequestTitle(typed: unknown): string | undefined {
	if (typeof typed !== 'string') { return undefined; }
	const title = typed.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
	return title && [...title].length <= 256 ? title : undefined;
}

/** `POST /repos/{o}/{n}/pulls`'s answer, or the URL `gh pr create` prints. */
export function parseCreatedPr(output: string): GithubCreatedPr | undefined {
	const trimmed = output.trim();
	if (trimmed.startsWith('{')) {
		try {
			const raw = JSON.parse(trimmed) as Record<string, unknown>;
			const number = num(raw.number);
			const url = httpsUrl(raw.html_url);
			return number && url ? { number, url } : undefined;
		} catch { return undefined; }
	}
	const m = /https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/.exec(trimmed);
	return m ? { number: Number(m[1]), url: m[0] } : undefined;
}

/** What `gh pr list --json` is asked for. */
export const ghPrFields = 'number,title,url,author,headRefName,headRepository,headRepositoryOwner,isDraft,updatedAt,reviewDecision,statusCheckRollup';
/** What `gh run list --json` is asked for. */
export const ghRunFields = 'databaseId,name,displayTitle,url,headBranch,event,status,conclusion,updatedAt';

export const githubListLimit = 30;

const text = (value: unknown, max = 300): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : '';
const httpsUrl = (value: unknown): string => {
	const s = text(value, 2000);
	return /^https:\/\/github\.com\//.test(s) ? s : '';
};
const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;

function arrayOf(json: string): unknown[] {
	const parsed: unknown = JSON.parse(json);
	if (!Array.isArray(parsed)) { throw new Error('Not a list.'); }
	return parsed.slice(0, githubListLimit);
}

/** A check run (`status`/`conclusion`) or a commit status context (`state`), as `gh` mixes them. */
export function summarizeChecks(rollup: unknown): GithubCheckSummary | undefined {
	if (!Array.isArray(rollup) || !rollup.length) { return undefined; }
	let passed = 0, failed = 0, pending = 0;
	for (const c of rollup as Record<string, unknown>[]) {
		const verdict = String(c?.conclusion || c?.state || '').toUpperCase();
		const status = String(c?.status || '').toUpperCase();
		if (status && status !== 'COMPLETED') { pending++; }
		else if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(verdict)) { passed++; }
		else if (['PENDING', 'EXPECTED', ''].includes(verdict)) { pending++; }
		else { failed++; }
	}
	return { passed, failed, pending };
}

export function runState(status: unknown, conclusion: unknown): GithubRunState {
	const s = String(status ?? '').toLowerCase();
	if (s && s !== 'completed') { return s === 'in_progress' ? 'running' : 'queued'; }
	const c = String(conclusion ?? '').toLowerCase();
	if (c === 'success') { return 'success'; }
	if (c === 'failure' || c === 'timed_out' || c === 'startup_failure') { return 'failure'; }
	if (c === 'cancelled') { return 'cancelled'; }
	if (c === 'skipped') { return 'skipped'; }
	return 'other';
}

export function parseGhPullRequests(json: string, branch?: string): GithubPullRequest[] {
	const out: GithubPullRequest[] = [];
	for (const raw of arrayOf(json) as Record<string, unknown>[]) {
		const number = num(raw?.number);
		const url = httpsUrl(raw?.url);
		if (!number || !url) { continue; }
		const head = text(raw.headRefName, 250);
		const repository = raw.headRepository as Record<string, unknown> | undefined;
		const owner = text((raw.headRepositoryOwner as Record<string, unknown> | undefined)?.login, 100);
		const name = text(repository?.name, 100);
		const headRepo = text(repository?.nameWithOwner, 250) || (owner && name ? `${owner}/${name}` : '');
		const checks = summarizeChecks(raw.statusCheckRollup);
		out.push({
			number, url, title: text(raw.title), author: text((raw.author as Record<string, unknown> | undefined)?.login, 100),
			branch: head, draft: raw.isDraft === true, updatedAt: text(raw.updatedAt, 40), review: text(raw.reviewDecision, 40),
			...(headRepo ? { headRepo } : {}),
			...(checks ? { checks } : {}), ...(branch && head === branch ? { current: true } : {}),
		});
	}
	return out;
}

export function parseGhRuns(json: string, branch?: string): GithubRun[] {
	const out: GithubRun[] = [];
	for (const raw of arrayOf(json) as Record<string, unknown>[]) {
		const id = num(raw?.databaseId);
		const url = httpsUrl(raw?.url);
		if (!id || !url) { continue; }
		const head = text(raw.headBranch, 250);
		out.push({
			id, url, name: text(raw.name), title: text(raw.displayTitle), branch: head, event: text(raw.event, 40),
			state: runState(raw.status, raw.conclusion), updatedAt: text(raw.updatedAt, 40), ...(branch && head === branch ? { current: true } : {}),
		});
	}
	return out;
}

/** `GET /repos/{o}/{n}/pulls?state=open`. */
export function parseApiPullRequests(json: string, branch?: string): GithubPullRequest[] {
	const out: GithubPullRequest[] = [];
	for (const raw of arrayOf(json) as Record<string, unknown>[]) {
		const number = num(raw?.number);
		const url = httpsUrl(raw?.html_url);
		if (!number || !url) { continue; }
		const head = text((raw.head as Record<string, unknown> | undefined)?.ref, 250);
		const headRepo = text(((raw.head as Record<string, unknown> | undefined)?.repo as Record<string, unknown> | undefined)?.full_name, 250);
		out.push({
			number, url, title: text(raw.title), author: text((raw.user as Record<string, unknown> | undefined)?.login, 100),
			branch: head, draft: raw.draft === true, updatedAt: text(raw.updated_at, 40), review: '',
			...(headRepo ? { headRepo } : {}),
			...(branch && head === branch ? { current: true } : {}),
		});
	}
	return out;
}

/** `GET /repos/{o}/{n}/actions/runs`: `{ workflow_runs: [...] }`. */
export function parseApiRuns(json: string, branch?: string): GithubRun[] {
	const parsed = JSON.parse(json) as { workflow_runs?: unknown };
	if (!Array.isArray(parsed?.workflow_runs)) { throw new Error('Not a run list.'); }
	return parseGhRuns(JSON.stringify((parsed.workflow_runs as Record<string, unknown>[]).map(r => ({
		databaseId: r?.id, name: r?.name, displayTitle: r?.display_title, url: r?.html_url, headBranch: r?.head_branch,
		event: r?.event, status: r?.status, conclusion: r?.conclusion, updatedAt: r?.updated_at,
	}))), branch);
}

/**
 * Which remote names the repository: the current branch's upstream remote,
 * then `upstream` (a fork's parent, where its pull requests are), then
 * `origin`, then the first one that is on github.com.
 */
export function pickGithubRemote<R>(remotes: readonly { name: string; url: string }[], parse: (url: string) => R | undefined, upstreamRemote?: string): R | undefined {
	const order = [upstreamRemote, 'upstream', 'origin'];
	for (const name of order) {
		const r = name ? remotes.find(x => x.name === name) : undefined;
		const repo = r && parse(r.url);
		if (repo) { return repo; }
	}
	for (const r of remotes) { const repo = parse(r.url); if (repo) { return repo; } }
	return undefined;
}
