/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Not a TOML parser — exactly as much of one as the two readers of Codex's
 * config need (checking, and replacing our own table), and no relative imports
 * so `npm test` can load it directly.
 *
 * The two readers *must* agree on where a table starts and ends. They did not,
 * once, and the symptom was our table becoming invisible so that connecting
 * appended a second copy — which is TOML that does not parse at all, taking
 * every unrelated MCP server in the file down with it.
 */

export interface CodexEntry {
	/** Table name after `mcp_servers.`, e.g. `ai-browser`. */
	readonly name: string;
	readonly values: Map<string, string>;
	/** Line index of each key, for surgical edits that keep the rest of the line. */
	readonly valueLines: Map<string, number>;
	/**
	 * Line index just past the last line of each key's *value*.
	 *
	 * Almost always `valueLines + 1`, and the exception is the one that matters:
	 * a value can span lines (`url = """…"""`, `enabled_tools = [`), and an
	 * edit that replaces only the key's first line leaves the continuation and
	 * the closing delimiter behind as garbage. Anything rewriting a value must
	 * replace this whole range.
	 */
	readonly valueEndLines: Map<string, number>;
	/** Line index of the `[mcp_servers.<name>]` header. */
	readonly firstLine: number;
	/**
	 * Line index just past the last key of this table.
	 *
	 * Deliberately *not* the next table header: a comment sitting above the next
	 * table belongs to that table, and swallowing it into ours would delete
	 * someone else's note on every rewrite.
	 */
	readonly endLine: number;
}

interface ScanResult {
	/**
	 * The line with string contents and comments removed. Use it to ask
	 * structural questions, never to read a value out of — the value is exactly
	 * what it drops.
	 */
	readonly code: string;
	/**
	 * The raw line truncated at a real comment. This is what values and table
	 * names are parsed from: it keeps quoted contents, and a `#` inside a string
	 * has already been ruled out as a comment.
	 */
	readonly text: string;
	/** Net bracket depth contributed by this line, for multi-line arrays. */
	readonly depth: number;
	/** Quote style left open at end of line: `"""`, `'''`, or undefined. */
	readonly multiline: string | undefined;
}

/**
 * Walks one line, tracking quoting, and reports what is actually code.
 *
 * A naive scan gets all of these wrong, and each one was a real failure:
 *   - `url = "http://host/mcp#frag"` — `#` inside a string is not a comment;
 *   - `enabled_tools = [` — an array left open, which `codex mcp add` writes;
 *   - `note = 'use """ for prose'` — triple quotes inside a literal string open
 *     nothing;
 *   - `text = """…""""` — four or five closing quotes in a row still close once.
 */
export function scanLine(line: string, initialQuote?: string): ScanResult {
	let code = '';
	let depth = 0;
	let quote = initialQuote;
	let i = 0;
	let commentAt = -1;

	while (i < line.length) {
		const rest = line.slice(i);

		if (quote) {
			// Inside a multi-line string: only its own closing delimiter matters.
			if (rest.startsWith(quote)) {
				quote = undefined;
				i += 3;
				// A run of extra quotes belongs to the string's content, and the
				// delimiter has already been consumed.
				while (i < line.length && line[i] === rest[0] && line[i - 3] === rest[0]) {
					i++;
				}
				continue;
			}
			i++;
			continue;
		}

		if (rest.startsWith('"""') || rest.startsWith("'''")) {
			quote = rest.slice(0, 3);
			i += 3;
			continue;
		}

		const ch = line[i];

		if (ch === '#') {
			commentAt = i; // comment runs to end of line
			break;
		}

		if (ch === '"' || ch === '\'') {
			// Single-line string: skip to its close, honouring \" only in basic strings.
			i++;
			while (i < line.length) {
				if (ch === '"' && line[i] === '\\') {
					i += 2;
					continue;
				}
				if (line[i] === ch) {
					i++;
					break;
				}
				i++;
			}
			continue;
		}

		if (ch === '[' || ch === '{') {
			depth++;
		} else if (ch === ']' || ch === '}') {
			depth--;
		}

		code += ch;
		i++;
	}

	return {
		code,
		text: commentAt === -1 ? line : line.slice(0, commentAt),
		depth,
		multiline: quote,
	};
}

const tableHeader = /^\s*\[\s*mcp_servers\s*\.\s*([^\]\s]+)\s*\]\s*$/;

/**
 * A key and the rest of its line.
 *
 * **The key may be quoted**, and missing that was a config-corrupting bug
 * rather than a gap. TOML lets `"url" = "…"` mean exactly what `url = "…"`
 * means, and a bare-key-only pattern reported such a table as having no `url`
 * at all — so the repair took its "no url, insert both lines" branch and wrote
 * a *second* `url` next to the first. Two definitions of one key is TOML that
 * does not parse, so an unattended startup repair took every MCP server the
 * user had with it. Same family as the rename collision in
 * `Things that break silently`.
 *
 * The quotes are stripped by {@link unquote} before the key is recorded, so
 * every reader asks for the bare name and both spellings answer.
 */
const keyValue = /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/;

/**
 * Strips the quoting from a value.
 *
 * It must **not** try to remove a comment. `scanLine` has already truncated
 * the line at a real comment, and it is the only thing that can tell a real
 * one from a `#` inside a string. Stripping again here read
 * `url = "http://h/mcp#frag"` as `"http://h/mcp` — an unbalanced quote, so
 * even the unquoting below then failed and the caller got the mangled text.
 */
function unquote(raw: string): string {
	const value = raw.trim();
	const match = /^(?:"""([\s\S]*)"""|'''([\s\S]*)'''|"((?:[^"\\]|\\.)*)"|'([^']*)')$/.exec(value);
	if (!match) {
		return value;
	}
	const inner = match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
	// Only basic strings process escapes.
	return match[3] !== undefined ? inner.replace(/\\(.)/g, '$1') : inner;
}

function tableName(header: string): string {
	const raw = tableHeader.exec(header)?.[1] ?? '';
	return unquote(raw);
}

/**
 * Every `[mcp_servers.*]` table in `text`, in file order.
 *
 * Lines inside an unterminated multi-line value belong to the value that opened
 * them — a `[mcp_servers.…]` sitting inside somebody's `instructions = """…"""`
 * is prose, and treating it as a table would rewrite their config.
 */
export function codexEntries(text: string): CodexEntry[] {
	const lines = text.split(/\r?\n/);
	const entries: CodexEntry[] = [];

	let current: {
		name: string;
		values: Map<string, string>;
		valueLines: Map<string, number>;
		valueEndLines: Map<string, number>;
		firstLine: number;
		endLine: number;
	} | undefined;

	/** The key whose value is still being read, for continuation lines. */
	let openKey: string | undefined;

	let quote: string | undefined;
	let depth = 0;

	const flush = () => {
		if (current) {
			entries.push({ ...current });
			current = undefined;
		}
	};

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const inContinuation = quote !== undefined || depth > 0;
		const scan = scanLine(line, quote);
		const nextQuote = scan.multiline;
		const nextDepth = Math.max(0, depth + scan.depth);

		if (inContinuation) {
			// Part of a value that started earlier; never structural.
			if (current) {
				current.endLine = index + 1;
				if (openKey !== undefined) {
					current.valueEndLines.set(openKey, index + 1);
				}
			}
			quote = nextQuote;
			depth = nextDepth;
			continue;
		}
		openKey = undefined;

		// `text`, not `code`: `code` has string contents stripped, which loses both
		// quoted table names and every value. The regexes are anchored, so a
		// string that merely contains `[mcp_servers.x]` cannot masquerade as a
		// header. Named `text` here on purpose — it was called `code`, shadowing
		// the very distinction the comment above draws.
		const text = scan.text;

		if (tableHeader.test(text)) {
			flush();
			current = {
				name: tableName(text),
				values: new Map(),
				valueLines: new Map(),
				valueEndLines: new Map(),
				firstLine: index,
				endLine: index + 1,
			};
		} else if (/^\s*\[/.test(text)) {
			// Some other table: ours ended at its last key, not here.
			flush();
		} else if (current) {
			const kv = keyValue.exec(text);
			if (kv) {
				// The bare name, so a reader asking for `url` finds it whether
				// the file wrote `url` or `"url"`. Recording the quoted spelling
				// verbatim is what made the repair believe the key was absent.
				const key = unquote(kv[1]);
				current.values.set(key, unquote(kv[2]));
				current.valueLines.set(key, index);
				current.valueEndLines.set(key, index + 1);
				current.endLine = index + 1;
				openKey = key;
			}
		}

		quote = nextQuote;
		depth = nextDepth;
	}

	flush();
	return entries;
}
