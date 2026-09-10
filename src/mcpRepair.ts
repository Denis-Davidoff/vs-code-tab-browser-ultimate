/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CodexEntry } from './codexToml';

/*
 * Bringing an assistant's config back into line with this window.
 *
 * The problem this exists for: the port is written into the config once, at
 * connect time, and a window's port can change between restarts. The entry then
 * addresses a *neighbour's* window — which the workspace-scoped token turns
 * into a bare 401, so the assistant reports "no tools" and pressing Connect
 * again does not obviously help.
 *
 * The whole design rests on one idea:
 *
 *   **An entry is identified by its token, never by its name or its URL.**
 *
 * The token is the only thing about an entry that is stable and ours: it is
 * per workspace, kept in `globalState`, and does not change. The name has
 * changed between releases (`tab-browser` before `ai-browser`, plus the
 * per-project names in the global Codex file) and the URL is precisely the part
 * that goes stale. Matching on either of those would either miss our own
 * entries or, worse, rewrite somebody else's.
 *
 * From that follow the two rules the callers rely on:
 *
 *   - an entry carrying **our** token is provably ours, whatever it is called
 *     and wherever it points, so it may be corrected or collapsed silently;
 *   - anything else is left alone and, at most, reported. A stale-looking entry
 *     may well be a *live* entry of another window, and "fixing" it would break
 *     a working assistant to repair ours.
 *
 * Leaf module: the only import is a type, which is erased, so `npm test` can
 * load this file directly. That is also why the Codex functions take
 * already-parsed entries instead of calling `codexEntries` themselves — the
 * same arrangement `mcpClientState.ts` uses, for the same reason.
 */

export interface Repair {
	/** The new file contents. Identical to the input when `changed` is false. */
	readonly text: string;
	readonly changed: boolean;
	/** Entries that were ours and were folded into the canonical one. */
	readonly collapsed: readonly string[];
}

export interface Endpoint {
	/** Our current base URL, e.g. `http://127.0.0.1:43112/mcp`. */
	readonly url: string;
	readonly token: string;
	/** The name the canonical entry should end up with. */
	readonly name: string;
}

/**
 * Whether a configured URL carries our token as its last path segment.
 *
 * Nothing writes this form any more — Codex turned out to accept a static
 * `Authorization` header after all — but configs written before that discovery
 * still use it, and those are exactly the old configs most in need of repair.
 *
 * The Codex side does not need this: it scans every value for the token, since
 * there the credentials can also live in a sub-table.
 */
function urlCarriesToken(configured: string, token: string): boolean {
	return configured.endsWith(`/${token}`);
}

/* ------------------------------------------------------------------ Claude Code */

/**
 * Rewrites the entries of `.mcp.json` that carry our token.
 *
 * Everything else in the file is left byte-identical in meaning: other MCP
 * servers the project has are read back and written out untouched. An
 * unparsable file is refused outright rather than rewritten, for the same
 * reason `writeClaudeConfig` refuses it — rebuilding it from `{}` would delete
 * every other server the project has.
 */
export function repairClaudeJson(text: string, endpoint: Endpoint): Repair {
	const unchanged: Repair = { text, changed: false, collapsed: [] };

	let parsed: any;
	try {
		parsed = text.trim() === '' ? {} : JSON.parse(text);
	} catch {
		return unchanged;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return unchanged;
	}

	const servers = parsed.mcpServers;
	if (typeof servers !== 'object' || servers === null) {
		return unchanged;
	}

	const ours = Object.keys(servers).filter(name => claudeEntryIsOurs(servers[name], endpoint.token));
	if (ours.length === 0) {
		return unchanged;
	}

	// The entry we keep: the one already under the current name if there is
	// one, so repeated repairs are stable, else the first of ours.
	const source = ours.includes(endpoint.name) ? endpoint.name : ours[0];

	// Renaming onto the current name is only safe when that name is free or
	// already ours. An entry called `ai-browser` carrying somebody *else's*
	// token belongs to another workspace — overwriting it would point that
	// project's assistant at this window, and it is not ours to touch.
	const taken = Object.prototype.hasOwnProperty.call(servers, endpoint.name)
		&& !ours.includes(endpoint.name);
	const canonical = taken ? source : endpoint.name;

	// Merged, not replaced: anything the user added to the entry (a `timeout`,
	// an extra header) survives. Only the three fields that can be wrong are
	// overwritten. Same principle as the Codex side below.
	const base = servers[source];
	const headers: Record<string, unknown> = { ...(base?.headers ?? {}) };
	for (const key of Object.keys(headers)) {
		// A case variant would otherwise sit alongside the one we set.
		if (key.toLowerCase() === 'authorization') {
			delete headers[key];
		}
	}
	const merged = {
		...base,
		type: 'http',
		url: endpoint.url,
		headers: { ...headers, Authorization: `Bearer ${endpoint.token}` },
	};

	for (const name of ours) {
		if (name !== source) {
			delete servers[name];
		}
	}
	if (canonical === source) {
		// Assigning in place keeps the key where it was, so an already correct
		// file serialises byte-identically and repair stays silent.
		servers[source] = merged;
	} else {
		delete servers[source];
		servers[canonical] = merged;
	}

	const collapsed = ours.filter(name => name !== canonical);
	const next = `${JSON.stringify(parsed, null, 2)}\n`;
	return next === text
		? unchanged
		: { text: next, changed: true, collapsed };
}

/** Whether one `.mcp.json` entry carries our token, in either supported place. */
function claudeEntryIsOurs(entry: any, token: string): boolean {
	if (typeof entry !== 'object' || entry === null) {
		return false;
	}
	const authorization = entry.headers?.Authorization ?? entry.headers?.authorization;
	if (typeof authorization === 'string' && authorization.includes(token)) {
		return true;
	}
	return typeof entry.url === 'string' && urlCarriesToken(entry.url, token);
}

/* ------------------------------------------------------------------------ Codex */

/** The `[mcp_servers.<name>]` table we write. */
export function codexTableLines(name: string, endpoint: Endpoint): string[] {
	return [
		`[mcp_servers.${name}]`,
		`url = "${endpoint.url}"`,
		`http_headers = { Authorization = "Bearer ${endpoint.token}" }`,
	];
}

/**
 * Names of the Codex tables that carry our token.
 *
 * A sub-table (`<name>.http_headers`) is reported by the parser as an entry of
 * its own, so it is matched too: it belongs to whichever table it is named
 * after, and has to be dropped along with it.
 */
export function codexOurTables(entries: readonly CodexEntry[], token: string): string[] {
	const owners = new Set<string>();

	for (const entry of entries) {
		// Any value at all, not just `url` and `http_headers`: the credentials
		// can also sit in a `[mcp_servers.<name>.http_headers]` sub-table, where
		// the key is the header name and there is no `http_headers` key to find.
		// Scanning every value is safe because the token is 64 hex characters —
		// it does not turn up in a config by coincidence.
		if ([...entry.values.values()].some(value => value.includes(token))) {
			// Credentials found in a sub-table belong to its parent table.
			owners.add(rootTable(entry.name));
		}
	}

	return entries.map(entry => entry.name).filter(name => owners.has(rootTable(name)));
}

/** `ai-browser.http_headers` -> `ai-browser`; anything else unchanged. */
function rootTable(name: string): string {
	const dot = name.indexOf('.');
	return dot === -1 ? name : name.slice(0, dot);
}

/**
 * Replaces a set of tables with one, by line range.
 *
 * Replaced and never appended to: the same table twice is TOML that does not
 * parse at all, which takes every other server in the file down with it. The
 * ranges come from the parser rather than from `text.includes('[mcp_servers.…]')`,
 * because `[mcp_servers.ai-browser] # ours` is the same table.
 */
export function spliceCodexTables(
	lines: readonly string[],
	ranges: readonly (readonly [number, number])[],
	table: readonly string[],
): string[] {
	const sorted = [...ranges].sort((a, b) => a[0] - b[0]);

	if (sorted.length === 0) {
		return lines.length
			? [...lines, ...(lines.at(-1) === '' ? [] : ['']), ...table]
			: [...table];
	}

	const out: string[] = [];
	let cursor = 0;
	for (const [from, to] of sorted) {
		out.push(...lines.slice(cursor, from));
		cursor = to;
	}
	// The new table goes where the first of the old ones was, so a hand-placed
	// table does not migrate to the bottom of the file on every repair.
	const head = out.length;
	out.push(...lines.slice(cursor));
	out.splice(head, 0, ...table);
	return out;
}

/**
 * Rewrites the Codex tables that carry our token.
 *
 * **Line surgery, not table replacement**, and the difference matters. The
 * connect path replaces our whole table, which is right there: the user just
 * asked for it to be made correct. This runs unattended on every start, and a
 * table it rewrote wholesale would silently drop anything the user had added
 * to it — `startup_timeout_sec`, `enabled_tools`, a comment explaining why the
 * table is there. So only the lines that are actually wrong are touched:
 *
 *   - the header, if the entry is under a name from an older release;
 *   - `url`, which is the line that goes stale;
 *   - `http_headers`, added if the credentials were riding in the URL instead.
 *
 * Three things that each corrupt a config if got wrong:
 *
 *   - **A value can span lines** (`url = """…"""`, `enabled_tools = [`), so an
 *     edit replaces the key's whole value range and not just its first line.
 *     Replacing one line leaves the continuation and the closing delimiter
 *     behind as garbage that no longer parses.
 *   - **The rename can collide.** If our token sits in a table called
 *     `tab-browser` while an `ai-browser` table belongs to someone else,
 *     renaming ours produces two `[mcp_servers.ai-browser]` headers — TOML that
 *     does not parse, taking every MCP server the user has with it. When the
 *     target name is taken by a table that is not ours, the entry keeps the
 *     name it has.
 *   - **Only the `http_headers` sub-table of ours is dropped**, because that is
 *     the one we replace with the inline form. Any other sub-table of our own
 *     entry — `env_http_headers`, say — is the user's and stays.
 *
 * Whole-table removal is still used for *duplicates* of ours: a second table of
 * ours is not a table to fix, it is one to be rid of.
 *
 * The newline style comes from the existing file, or the whole of somebody
 * else's config turns up in the diff.
 */
export function repairCodexToml(
	text: string,
	entries: readonly CodexEntry[],
	endpoint: Endpoint,
): Repair {
	const unchanged: Repair = { text, changed: false, collapsed: [] };

	const ourNames = codexOurTables(entries, endpoint.token);
	if (ourNames.length === 0) {
		return unchanged;
	}

	const roots = [...new Set(ourNames.map(rootTable))];
	// Prefer the entry already under the current name, so repeated repairs are
	// stable; otherwise the first of ours, which keeps it where the user put it.
	const source = roots.includes(endpoint.name) ? endpoint.name : roots[0];

	const foreign = new Set(entries.map(entry => rootTable(entry.name)).filter(name => !roots.includes(name)));
	const canonical = foreign.has(endpoint.name) ? source : endpoint.name;

	const newline = /\r\n/.test(text) ? '\r\n' : '\n';
	const lines = text.split(/\r?\n/);

	const remove = new Set<number>();
	const replace = new Map<number, string[]>();

	/** Marks a key's whole value range for replacement by `with`. */
	const replaceValue = (entry: CodexEntry, key: string, wth: string[]): void => {
		const from = entry.valueLines.get(key);
		if (from === undefined) {
			return;
		}
		const to = entry.valueEndLines.get(key) ?? from + 1;
		replace.set(from, wth);
		for (let line = from + 1; line < to; line++) {
			remove.add(line);
		}
	};

	// Everything the canonical entry needs to know about itself, gathered
	// before the loop so the sub-table and its parent can be decided together.
	const rootEntry = entries.find(entry => entry.name === source);
	const headerSubTable = entries.find(entry => entry.name === `${source}.http_headers`);
	const inlineHeaders = rootEntry?.values.get('http_headers');

	for (const entry of entries) {
		if (!ourNames.includes(entry.name)) {
			continue;
		}

		// A duplicate of ours, sub-tables and all: not a table to fix.
		if (rootTable(entry.name) !== source) {
			for (let line = entry.firstLine; line < entry.endLine; line++) {
				remove.add(line);
			}
			continue;
		}

		if (entry.name.includes('.')) {
			const suffix = entry.name.slice(source.length + 1);

			// A header sub-table alongside an inline `http_headers` is the one
			// ambiguous shape: two sets of headers on one server. Its keys are
			// folded into the inline table (below) and it goes.
			if (entry === headerSubTable && inlineHeaders !== undefined) {
				for (let line = entry.firstLine; line < entry.endLine; line++) {
					remove.add(line);
				}
				continue;
			}

			// Any other sub-table is the user's — `env_http_headers`, say — and
			// a header sub-table that is the *only* credentials is theirs too.
			// Both must follow the rename, or the sub-table is left pointing at
			// a server name that no longer exists and TOML resurrects it as a
			// second, urlless server.
			replace.set(entry.firstLine, [`[mcp_servers.${canonical}.${suffix}]`]);

			if (entry === headerSubTable) {
				// Only the authorization is ours to set; every other header the
				// user put here stays exactly as written.
				const existing = [...entry.valueLines.keys()]
					.find(key => stripQuotes(key).toLowerCase() === 'authorization');
				const line = `${existing ?? 'Authorization'} = "Bearer ${endpoint.token}"`;
				if (existing) {
					replaceValue(entry, existing, [line]);
				} else {
					replace.set(entry.firstLine, [`[mcp_servers.${canonical}.${suffix}]`, line]);
				}
			}
			continue;
		}

		const url = `url = "${endpoint.url}"`;
		const header = `[mcp_servers.${canonical}]`;

		// Merged, never replaced: an `X-Org` the user added to `http_headers`
		// survives, and so do the keys of a header sub-table being folded in.
		const carried = entry === rootEntry && headerSubTable && inlineHeaders !== undefined
			? [...headerSubTable.values].map(([key, value]) => ({ key, value: JSON.stringify(value) }))
			: [];
		const headers = `http_headers = ${mergeAuthorization(inlineHeaders, carried, endpoint.token)}`;

		if (!entry.valueLines.has('url')) {
			// No url at all: put both lines straight after the header.
			replace.set(entry.firstLine, [header, url, headers]);
			continue;
		}

		replace.set(entry.firstLine, [header]);
		if (entry.valueLines.has('http_headers')) {
			replaceValue(entry, 'url', [url]);
			replaceValue(entry, 'http_headers', [headers]);
		} else if (headerSubTable) {
			// The credentials live in the sub-table, which is being kept and
			// updated in place. Adding an inline table as well would be the
			// ambiguous shape this branch exists to avoid.
			replaceValue(entry, 'url', [url]);
		} else {
			// Credentials were in the URL path, the form written before Codex
			// turned out to accept a static header. Move them across.
			replaceValue(entry, 'url', [url, headers]);
		}
	}

	const out: string[] = [];
	for (let line = 0; line < lines.length; line++) {
		if (remove.has(line)) {
			continue;
		}
		const replacement = replace.get(line);
		out.push(...(replacement ?? [lines[line]]));
	}

	let next = out.join(newline);
	if (!next.endsWith(newline)) {
		next += newline;
	}

	const collapsed = roots.filter(name => name !== canonical);
	return next === text
		? unchanged
		: { text: next, changed: true, collapsed };
}

/* ------------------------------------------------ inline tables, minimally */

/*
 * Just enough inline-table handling to change one key and leave the rest
 * alone. The same reasoning as the mini TOML parser next door: a full
 * implementation would be far more than the job needs, and the job is exact —
 * `http_headers = { Authorization = "…", X-Org = "acme" }` must come back with
 * only the authorization changed. Replacing the whole table, which is what
 * this code used to do, silently deleted the user's other headers on every
 * window start.
 */

interface Pair {
	readonly key: string;
	readonly value: string;
}

/** `"x"` / `'x'` -> `x`; anything else unchanged. */
function stripQuotes(raw: string): string {
	const value = raw.trim();
	return /^(".*"|'.*')$/.test(value) ? value.slice(1, -1) : value;
}

/**
 * Splits an inline table's body into its pairs, in order.
 *
 * Commas and `=` inside a quoted value are not separators, and nor are those
 * inside a nested table or array — the same class of mistake `scanLine` exists
 * to avoid at line level.
 */
export function parseInlineTable(raw: string): Pair[] {
	const text = raw.trim();
	if (!text.startsWith('{') || !text.endsWith('}')) {
		return [];
	}

	const body = text.slice(1, -1);
	const pairs: Pair[] = [];
	let depth = 0;
	let quote: string | undefined;
	let start = 0;

	const take = (chunk: string) => {
		const pair = splitPair(chunk);
		if (pair) {
			pairs.push(pair);
		}
	};

	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (quote) {
			if (ch === '\\') { i++; } else if (ch === quote) { quote = undefined; }
			continue;
		}
		if (ch === '"' || ch === '\'') { quote = ch; } else if (ch === '{' || ch === '[') { depth++; } else if (ch === '}' || ch === ']') { depth--; } else if (ch === ',' && depth === 0) {
			take(body.slice(start, i));
			start = i + 1;
		}
	}
	take(body.slice(start));
	return pairs;
}

/** Splits one `key = value` chunk at the first `=` outside a string. */
function splitPair(chunk: string): Pair | undefined {
	let quote: string | undefined;
	for (let i = 0; i < chunk.length; i++) {
		const ch = chunk[i];
		if (quote) {
			if (ch === '\\') { i++; } else if (ch === quote) { quote = undefined; }
			continue;
		}
		if (ch === '"' || ch === '\'') {
			quote = ch;
			continue;
		}
		if (ch === '=') {
			const key = chunk.slice(0, i).trim();
			return key ? { key, value: chunk.slice(i + 1).trim() } : undefined;
		}
	}
	return undefined;
}

/**
 * Returns the inline table with only `Authorization` set to our bearer token.
 *
 * `carried` are keys folded in from a header sub-table that is being removed,
 * added only where the inline table does not already define them.
 */
export function mergeAuthorization(
	existing: string | undefined,
	carried: readonly Pair[],
	token: string,
): string {
	const pairs = existing === undefined ? [] : parseInlineTable(existing);

	for (const pair of carried) {
		if (!pairs.some(have => stripQuotes(have.key).toLowerCase() === stripQuotes(pair.key).toLowerCase())) {
			pairs.push(pair);
		}
	}

	const value = `"Bearer ${token}"`;
	const at = pairs.findIndex(pair => stripQuotes(pair.key).toLowerCase() === 'authorization');
	if (at === -1) {
		pairs.unshift({ key: 'Authorization', value });
	} else {
		pairs[at] = { key: pairs[at].key, value };
	}

	return `{ ${pairs.map(pair => `${pair.key} = ${pair.value}`).join(', ')} }`;
}
