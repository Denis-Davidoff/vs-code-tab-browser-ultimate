/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CodexEntry } from './codexToml';

/*
 * Reading a client's config is pure text work, kept apart from the file system
 * so it can be tested against real-world configs. `mcpCheck.ts` supplies the
 * text; nothing here touches disk or vscode.
 *
 * Note the `import type`: it is erased, so Node's type stripping never has to
 * resolve it and this file stays loadable by `npm test`. A *value* import of a
 * sibling would not survive that, which is why the Codex functions below take
 * already-parsed entries rather than calling `codexEntries` themselves.
 */

/** The name our server is registered under, everywhere. */
export const serverName = 'ai-browser';

/**
 * How a client is currently pointed at us, worst last.
 *
 * A config holding several entries is judged by its best one — one working
 * entry is enough for the client to work, whatever else is in the file.
 */
export type ClientState =
	'thisServer' | 'wrongPort' | 'staleToken' | 'otherServer' | 'disabled' | 'none';

const severity: readonly ClientState[] =
	['thisServer', 'wrongPort', 'staleToken', 'otherServer', 'disabled', 'none'];

export function bestState(states: readonly ClientState[]): ClientState {
	for (const candidate of severity) {
		if (states.includes(candidate)) {
			return candidate;
		}
	}
	return 'none';
}

/**
 * Whether `configured` addresses the same endpoint as `url`.
 *
 * The `startsWith(url + '/')` arm accepts the token-in-path form, which is the
 * only way Codex can carry a bearer token.
 */
export function isSameServer(configured: string, url: string): boolean {
	return configured === url || configured.startsWith(`${url}/`);
}

/**
 * State of Claude Code's `.mcp.json`.
 *
 * `staleToken` is worth its own state because it is the common accident: the
 * file was copied from another project, so the URL is right and the token
 * belongs to a different workspace. The symptom is a bare 401, which reads like
 * a broken server rather than a stale file.
 *
 * `wrongPort` is its mirror image and used to be misreported as `otherServer`,
 * which sent people entirely the wrong way. The token is *ours*, so the entry
 * was written by this window; only the port has moved, because ports change
 * when windows open in a different order. "There is a different server there"
 * suggests deleting the entry; the truth is that it is our own entry and the
 * startup repair will correct it. Telling the two apart needs the token, which
 * is why it is checked before the URL is judged.
 */
export function claudeClientState(text: string, url: string, token: string): ClientState {
	let parsed: any;
	try {
		parsed = JSON.parse(text);
	} catch {
		return 'none';
	}

	const entry = parsed?.mcpServers?.[serverName];
	if (!entry || typeof entry !== 'object') {
		return 'none';
	}
	if (entry.enabled === false) {
		return 'disabled';
	}

	const configured = typeof entry.url === 'string' ? entry.url : '';
	if (!isSameServer(configured, url)) {
		return claudeEntryCarriesToken(entry, token) ? 'wrongPort' : 'otherServer';
	}

	const authorization = entry.headers?.Authorization ?? entry.headers?.authorization;
	if (typeof authorization === 'string') {
		// A token from the environment cannot be verified from here, so trust it.
		if (authorization.includes('${') || authorization === `Bearer ${token}`) {
			return 'thisServer';
		}
		return 'staleToken';
	}

	// No header: acceptable only if the token rides in the path.
	return configured === `${url}/${token}` ? 'thisServer' : 'staleToken';
}

/**
 * State of Codex's config, given the files in the order Codex reads them
 * (project first, then global).
 *
 * Entries whose name was already seen are ignored, because that is what Codex
 * does — the first file to define a name wins. `files` must therefore arrive in
 * Codex's own precedence order: project, then global.
 */
export function codexClientState(
	files: readonly (readonly CodexEntry[])[],
	url: string,
	urlWithToken: string,
	token: string,
): ClientState {
	const states: ClientState[] = [];
	const seen = new Set<string>();

	for (const entries of files) {
		for (const entry of entries) {
			if (seen.has(entry.name)) {
				continue;
			}
			seen.add(entry.name);

			if (entry.name.includes('.')) {
				continue; // a sub-table such as `<name>.http_headers`, not a server
			}

			if (entry.values.get('enabled') === 'false') {
				states.push('disabled');
				continue;
			}

			const configured = entry.values.get('url') ?? '';
			if (!isSameServer(configured, url)) {
				states.push(codexEntryCarriesToken(entry, entries, token) ? 'wrongPort' : 'otherServer');
				continue;
			}

			if (configured === urlWithToken || credentialsOf(entry, entries, token) !== 'foreign') {
				states.push('thisServer');
			} else {
				states.push('staleToken');
			}
		}
	}

	return bestState(states);
}

/**
 * Whether a Codex entry's credentials are ours, unverifiable, or somebody
 * else's.
 *
 * Three forms, all supported by Codex, and the reason the earlier "Codex can
 * only *name* a token" belief was wrong:
 *   - `http_headers = { Authorization = "Bearer …" }` — an inline table, which
 *     is what this extension now writes;
 *   - `[mcp_servers.<name>.http_headers]` — the same thing as a sub-table, which
 *     the parser reports as a *separate* entry whose name carries the suffix, so
 *     it has to be found among the siblings;
 *   - `bearer_token_env_var = "FOO"` — the value lives in Codex's environment,
 *     so its presence is all that can be checked from here.
 */
type Credentials = 'ours' | 'unverifiable' | 'foreign';

function credentialsOf(entry: CodexEntry, siblings: readonly CodexEntry[], token: string): Credentials {
	// The value lives in Codex's environment; nothing here can read it.
	if (entry.values.has('bearer_token_env_var')) {
		return 'unverifiable';
	}

	const inline = entry.values.get('http_headers');
	if (inline !== undefined) {
		return judgeAuthorization(inline, token);
	}

	const subTable = siblings.find(other => other.name === `${entry.name}.http_headers`);
	if (subTable) {
		const header = [...subTable.values].find(([key]) => key.toLowerCase() === 'authorization');
		if (!header) {
			return 'unverifiable';
		}
		return header[1].includes(token) ? 'ours' : 'foreign';
	}

	return 'foreign';
}

/**
 * What an `http_headers` value says about the token.
 *
 * The presence of *any* header used to count as credentials, which made the
 * check blind to the accident it exists for: a config copied from another
 * project carries the right URL and another workspace's token, and this
 * reported it as correctly configured — so the report suppressed the reconnect
 * advice while every call 401'd. The Claude side has always compared the token;
 * only Codex trusted the shape.
 *
 * A value that is present but unreadable — a multi-line string, a form not
 * modelled here — is `unverifiable`, deliberately: a false "reconnect" sends
 * the user to fix a file that is already right, which is the worse error.
 */
function judgeAuthorization(raw: string, token: string): Credentials {
	// A multi-line value first, or the pattern below reads its opening """ as an
	// empty basic string and condemns a header that is perfectly correct — the
	// worse of the two errors, since it sends the user to fix a good file.
	if (/authorization\s*=\s*("""|''')/i.test(raw)) {
		return 'unverifiable';
	}
	const match = /authorization\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/i.exec(raw);
	if (match) {
		return (match[1] ?? match[2] ?? '').includes(token) ? 'ours' : 'foreign';
	}
	return /authorization/i.test(raw) ? 'unverifiable' : 'foreign';
}

/**
 * Names of the entries Codex would actually launch against this endpoint.
 *
 * More than one means the project was connected twice — typically once by the
 * project file and once by `codex mcp add` — and Codex then lists every tool
 * twice. Reported, never repaired: the global file is not ours, and "fixing" a
 * duplicate would turn working tools into a 401.
 */
export function codexOurEntries(
	files: readonly (readonly CodexEntry[])[],
	url: string,
): string[] {
	const names: string[] = [];
	const seen = new Set<string>();

	for (const entries of files) {
		for (const entry of entries) {
			if (seen.has(entry.name)) {
				continue;
			}
			seen.add(entry.name);
			if (entry.values.get('enabled') === 'false' || entry.name.includes('.')) {
				continue;
			}
			if (isSameServer(entry.values.get('url') ?? '', url)) {
				names.push(entry.name);
			}
		}
	}

	return names;
}

/* ------------------------------------------------------ recognising our own */

/**
 * Whether an entry carries **our** token, in either place it can live.
 *
 * This is what separates "our entry, stale port" from "somebody else's
 * server", and it must stay equivalent to `claudeEntryIsOurs` in
 * `mcpRepair.ts`, which decides what may be rewritten — see the note on
 * `codexEntryCarriesToken` for why the two are duplicated rather than shared. The token is the only part of an entry that is stable and provably
 * ours: names have changed between releases and the URL is exactly the part
 * that goes stale.
 */
export function claudeEntryCarriesToken(entry: any, token: string): boolean {
	if (typeof entry !== 'object' || entry === null) {
		return false;
	}
	const authorization = entry.headers?.Authorization ?? entry.headers?.authorization;
	if (typeof authorization === 'string' && authorization.includes(token)) {
		return true;
	}
	return typeof entry.url === 'string' && entry.url.endsWith(`/${token}`);
}

/**
 * The same question for a Codex table.
 *
 * **This must stay exactly equivalent to `codexOurTables` in `mcpRepair.ts`.**
 * The two answer the same question for different callers — one decides what
 * the check *reports*, the other what the repair *rewrites* — and if they
 * disagree, the same entry gets silently rewritten by one and reported as a
 * stranger to delete by the other. They cannot share code: both are leaf
 * modules that `npm test` loads directly, so neither may take a relative value
 * import of the other. `mcpRepair.test.ts` asserts that they agree instead.
 *
 * The rule: any value of the table, or of any table sharing its root name,
 * contains the token. Scanning every value rather than just `url` and
 * `http_headers` is what catches a `[mcp_servers.<name>.http_headers]`
 * sub-table, where the key is the header name; it is safe because the token is
 * 64 hex characters and does not turn up in a config by coincidence.
 */
export function codexEntryCarriesToken(
	entry: CodexEntry,
	siblings: readonly CodexEntry[],
	token: string,
): boolean {
	const root = rootTable(entry.name);
	return siblings.some(other =>
		rootTable(other.name) === root
		&& [...other.values.values()].some(value => value.includes(token)));
}

/** `ai-browser.http_headers` -> `ai-browser`; anything else unchanged. */
function rootTable(name: string): string {
	const dot = name.indexOf('.');
	return dot === -1 ? name : name.slice(0, dot);
}

/**
 * Codex entries that look like ours by *name* but are not ours by token.
 *
 * These are the leftovers: entries for projects that have moved or been
 * deleted, and entries belonging to other windows. They are reported and never
 * touched — an entry that looks stale from here may be another window's live
 * one, and removing it would break a working assistant to tidy ours.
 */
export function codexStrangers(
	files: readonly (readonly CodexEntry[])[],
	token: string,
): string[] {
	const names: string[] = [];
	const seen = new Set<string>();

	for (const entries of files) {
		for (const entry of entries) {
			if (seen.has(entry.name) || entry.name.includes('.')) {
				continue;
			}
			seen.add(entry.name);
			const looksLikeOurs = entry.name === serverName || entry.name.startsWith(`${serverName}-`);
			if (looksLikeOurs && !codexEntryCarriesToken(entry, entries, token)) {
				names.push(entry.name);
			}
		}
	}

	return names;
}

/**
 * Servers configured for this project in Claude Code's **local scope**.
 *
 * Local scope lives in `~/.claude.json` under `projects[<path>].mcpServers`,
 * and it *overrides* the project's `.mcp.json`. That makes it the one place a
 * stale entry cannot be fixed by pressing Connect: the write lands in
 * `.mcp.json`, the shadow keeps winning, and the assistant stays pinned to
 * whatever port it was given months ago. The symptom is the worst kind —
 * everything looks correctly configured and nothing works.
 *
 * Reported, never repaired. `~/.claude.json` is Claude Code's own file and
 * holds its credentials and history; a lost update from us rewriting it would
 * cost far more than the stale entry does. `claude mcp remove <name> --scope
 * local` is its owner's tool for the job.
 */
export function claudeLocalScopeShadows(
	text: string,
	folderPath: string,
	token: string,
): string[] {
	let parsed: any;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}

	const servers = parsed?.projects?.[folderPath]?.mcpServers;
	if (typeof servers !== 'object' || servers === null) {
		return [];
	}

	return Object.keys(servers).filter(name =>
		name === serverName || claudeEntryCarriesToken(servers[name], token));
}
