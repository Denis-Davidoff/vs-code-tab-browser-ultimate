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
export type ClientState = 'thisServer' | 'staleToken' | 'otherServer' | 'disabled' | 'none';

const severity: readonly ClientState[] = ['thisServer', 'staleToken', 'otherServer', 'disabled', 'none'];

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
		return 'otherServer';
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
): ClientState {
	const states: ClientState[] = [];
	const seen = new Set<string>();

	for (const entries of files) {
		for (const entry of entries) {
			if (seen.has(entry.name)) {
				continue;
			}
			seen.add(entry.name);

			if (entry.values.get('enabled') === 'false') {
				states.push('disabled');
				continue;
			}

			const configured = entry.values.get('url') ?? '';
			if (!isSameServer(configured, url)) {
				states.push('otherServer');
				continue;
			}

			if (configured === urlWithToken) {
				states.push('thisServer');
			} else if (entry.values.has('bearer_token_env_var')) {
				// The variable's value lives in Codex's environment, not ours.
				states.push('thisServer');
			} else {
				states.push('staleToken');
			}
		}
	}

	return bestState(states);
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
			if (entry.values.get('enabled') === 'false') {
				continue;
			}
			if (isSameServer(entry.values.get('url') ?? '', url)) {
				names.push(entry.name);
			}
		}
	}

	return names;
}
