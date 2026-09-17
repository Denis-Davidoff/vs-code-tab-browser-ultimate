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
	 * table belongs to that table, and covering it into ours would delete
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
	/**
	 * Net `[`/`]` depth contributed by this line, for multi-line arrays.
	 *
	 * **Kept apart from {@link braces}, and that separation is load-bearing.**
	 * One shared counter let an unclosed `{` be cancelled by a stray `]` — two
	 * ordinary hand-edit typos — so the document balanced, `codexUnterminated`
	 * answered "well-formed", and a deletion range that covered another
	 * server's table was approved. Two wrongs made a right in the one arithmetic
	 * that decides whether a config may be rewritten.
	 */
	readonly depth: number;
	/** Net `{`/`}` depth. An inline table that does not close on its own line is
	 * already malformed TOML, so this leaving a line open is a refusal signal
	 * rather than a continuation this parser needs to model. */
	readonly braces: number;
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
	let braces = 0;
	let quote = initialQuote;
	let i = 0;
	let commentAt = -1;

	while (i < line.length) {
		const rest = line.slice(i);

		if (quote) {
			// Inside a multi-line string: only its own closing delimiter matters.
			//
			// **A basic string processes escapes; a literal one does not.** In a
			// triple-quoted basic string, a backslash-escaped quote followed by
			// two ordinary ones is content, not the delimiter, and closing on it
			// ends the string in the wrong place. Two such sequences on a line
			// rebalance the scan, so the document reads as well-formed while a
			// `[mcp_servers.x]` written inside somebody's prose is reported as a
			// real table — and the repair would then rewrite the inside of a
			// string. The triple-apostrophe form is literal, where a backslash is
			// just a character, so this applies to the basic form alone. Mirrors
			// the single-line branch below, which has always honoured `\"`.
			if (quote === '"""' && line[i] === '\\') {
				i += 2;
				continue;
			}
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

		if (ch === '[') {
			depth++;
		} else if (ch === ']') {
			depth--;
		} else if (ch === '{') {
			braces++;
		} else if (ch === '}') {
			braces--;
		}

		code += ch;
		i++;
	}

	return {
		code,
		text: commentAt === -1 ? line : line.slice(0, commentAt),
		depth,
		braces,
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
 * Whether the document ends inside a value that was never closed.
 *
 * **A file that answers true must not be rewritten.** `codexEntries` keeps a
 * table open across continuation lines, which is right for *identifying* one —
 * a multi-line array or triple-quoted string belongs to the table it started
 * in. It is unsafe as a *deletion* range: an unbalanced `[` never brings the
 * depth back to zero, so that table's `endLine` runs to end of file and every
 * table below it falls inside it. Pruning one stale entry then deleted the
 * user's whole global Codex config — every other MCP server and this window's
 * own live entry — while reporting the one name it meant to remove.
 *
 * The precondition is malformed TOML, which Codex cannot load either; the point
 * is that "broken" and "emptied" are very different states to hand back, one is
 * a character to restore and the other is not, and nothing here takes a backup.
 * It is also reachable from this project's own history — several past releases
 * wrote TOML that does not parse.
 *
 * So both writers ask first, and leave a file they cannot finish reading alone.
 */
export function codexUnterminated(text: string): boolean {
	// Mirrors `codexEntries`' own accounting exactly — `scan.depth` and the same
	// clamp — because a second, independently written counter is the drift this
	// project has already been bitten by once (`codexOurTables` vs
	// `codexEntryCarriesToken`). If the two ever disagree, this one is wrong.
	let quote: string | undefined;
	let depth = 0;
	let braces = 0;
	for (const line of text.split(/\r?\n/)) {
		const scan = scanLine(line, quote);
		quote = scan.multiline;
		depth = Math.max(0, depth + scan.depth);
		braces = Math.max(0, braces + scan.braces);
	}
	return quote !== undefined || depth > 0 || braces > 0;
}

/**
 * A line that is credibly a table header — `[key]` or `[[key]]`, where the key
 * is a dotted path of bare or quoted TOML keys, with an optional comment.
 *
 * **This is the discriminator the whole guard turns on**, because the two things
 * it must tell apart look identical to a looser test:
 *
 *   - `  [3, 4]` — the last element of a nested array, written without a
 *     trailing comma. Well-formed TOML, and a whole line wrapped in brackets.
 *     `3, 4` is not a key path (the comma disqualifies it), so this is content.
 *   - `[mcp_servers.someone-elses-server]` — a real table, and deleting the
 *     range that contains it takes a server the user configured by hand.
 *
 * `[1]` satisfies both readings and is therefore treated as a header: refusing
 * a prune costs a tidy-up, approving one costs somebody their config.
 */
const credibleHeader =
	/^\s*\[\[?\s*(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*'))*\s*\]\]?\s*(?:#.*)?$/;

/**
 * Whether the lines `[from, to)` can be deleted as one unit.
 *
 * Both line-range deleters in `mcpRepair.ts` ask this before removing a table,
 * and it answers the one question that makes a range safe: **does this range
 * contain anything that is not the table it names?**
 *
 * Two conditions, and neither is sufficient alone:
 *
 *   - **No credible table header after the range's own first line** — tested
 *     against the raw text, *regardless of what the scanner believes the
 *     structural state to be*. That last clause is the whole lesson. An earlier
 *     version only looked for a header while it thought it was at top level, and
 *     an unclosed `[` before a header — with a later `]` rebalancing the range —
 *     hid a real `[mcp_servers.someone-else]` from it completely. The range then
 *     satisfied both conditions and the deletion took that server with it, while
 *     the confirmation named only the one entry it meant to remove.
 *   - **The range ends at structural level.** Scanning it from its own first
 *     line must bring quoting, bracket depth and brace depth back to nothing. If
 *     it does not, the parser lost track *inside this very range*, so the
 *     `endLine` that produced it is not to be trusted.
 *
 * The reverse mistake is just as real and is why the first condition is not a
 * bare "does this line start with `[`": that fires on a nested array's last
 * element, refusing a legitimate prune for good, since the refusal propagates to
 * the completion marker.
 *
 * A credible header sitting inside a triple-quoted string is refused too. That
 * is a false refusal, taken knowingly: it costs one untidied entry, where the
 * other direction costs a server the extension never owned.
 *
 * Deliberately **not** a whole-document verdict. `codexUnterminated` is that.
 */
export function codexRangeDeletable(text: string, from: number, to: number): boolean {
	const lines = text.split(/\r?\n/);
	let quote: string | undefined;
	let depth = 0;
	let braces = 0;

	for (let index = from; index < to && index < lines.length; index++) {
		// Before the scan, and without consulting it: the point is to see a
		// header the structural view has lost.
		if (index > from && credibleHeader.test(lines[index])) {
			return false;
		}

		const scan = scanLine(lines[index], quote);
		quote = scan.multiline;
		depth = Math.max(0, depth + scan.depth);
		braces = Math.max(0, braces + scan.braces);
	}

	return quote === undefined && depth === 0 && braces === 0;
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
