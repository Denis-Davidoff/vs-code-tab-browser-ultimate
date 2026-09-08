/*---------------------------------------------------------------------------------------------
 *  The little of Codex's `config.toml` this extension has to understand, in one place because
 *  both readers of it must agree: `mcpCheck.ts` decides whether an entry would reach this
 *  window, and `mcpSetup.ts` replaces our own entry without disturbing the rest of the file.
 *
 *  Not a TOML parser: it reads `[mcp_servers.*]` headers and the plain `key = value` lines
 *  inside them, which is what `codex mcp add` and this extension write. Anything more exotic
 *  reads as unconfigured, which costs a reconnect — but where a table *begins and ends* it has
 *  to be right, because the setup replaces our table by line range: a header this misses is a
 *  table defined twice, and a range that stops short leaves half a value behind. Neither file
 *  parses afterwards. Hence bracket counting for values written over several lines
 *  (`enabled_tools = [`), which `codex mcp add` does write.
 *
 *  And hence multi-line strings, which nothing here writes but an `instructions` value in
 *  somebody's config is full of: read as ordinary lines, a `[mcp_servers.…]` written inside one
 *  is a table that does not exist — reported as a configured server, and rewritten in place,
 *  which edits the middle of somebody's prose and leaves a file Codex cannot parse at all.
 *  Every line of such a string belongs to the value that opened it and to nothing else.
 *--------------------------------------------------------------------------------------------*/

export interface CodexEntry {
	readonly name: string;
	readonly values: ReadonlyMap<string, string>;
	/**
	 * The line each of those values was read from, so a rewrite can replace the one it means.
	 * Searching the table's lines for the key instead finds it inside a multi-line string too.
	 */
	readonly valueLines: ReadonlyMap<string, number>;
	/** Line the `[mcp_servers.<name>]` header stands on. */
	readonly firstLine: number;
	/**
	 * The line after the last one this table claims — its last key, not the next header, so a
	 * comment written above the table that follows is not part of this one.
	 */
	readonly endLine: number;
}

/** The `[mcp_servers.*]` tables of a Codex config, comments taken off. */
export function codexEntries(text: string): CodexEntry[] {
	const entries: CodexEntry[] = [];
	const lines = text.split(/\r?\n/);
	let current: (CodexEntry & {
		values: Map<string, string>;
		valueLines: Map<string, number>;
		endLine: number;
	}) | undefined;

	/** Brackets a value has left open, i.e. how deep into a multi-line array we are. */
	let open = 0;
	/** The delimiter of a multi-line string a value opened and has not closed yet. */
	let multiline: string | undefined;

	lines.forEach((raw, at) => {
		// Inside a multi-line string nothing is markup: not a table header, not a comment, not
		// a bracket. The whole of it belongs to the key that opened it.
		if (multiline) {
			if (raw.includes(multiline)) {
				multiline = undefined;
			}
			if (current) {
				current.endLine = at + 1;
			}
			return;
		}

		const line = withoutComment(raw).trim();
		if (!line) {
			return;
		}

		// The rest of a value written over several lines. It belongs to the table its key was
		// written in — and a `[` in it is an array, never a header.
		if (open > 0) {
			open += bracketDepth(line);
			if (current) {
				current.endLine = at + 1;
			}
			return;
		}

		// Any header ends the previous table, so keys never land in the wrong one.
		if (line.startsWith('[')) {
			current = undefined;
			const name = mcpServerTableName(line);
			if (name !== undefined) {
				current = {
					name,
					values: new Map(),
					valueLines: new Map(),
					firstLine: at,
					endLine: at + 1,
				};
				entries.push(current);
			}
			return;
		}

		const pair = /^([^=]+?)\s*=\s*(.+)$/.exec(line);
		if (!pair) {
			return;
		}

		multiline = openedMultiline(pair[2]);
		open = multiline ? 0 : Math.max(0, bracketDepth(pair[2]));
		if (current) {
			const key = unquote(pair[1].trim()).toLowerCase();
			current.values.set(key, unquote(pair[2].trim()));
			current.valueLines.set(key, at);
			current.endLine = at + 1;
		}
	});

	return entries;
}

/** The delimiter of a multi-line string this value opens and does not close, if any. */
function openedMultiline(value: string): string | undefined {
	return ['"""', "'''"].find(delimiter => (value.split(delimiter).length - 1) % 2 === 1);
}

/** The name in `[mcp_servers.<name>]`, or `undefined` for any other table header. */
function mcpServerTableName(line: string): string | undefined {
	const name = /^\[\s*mcp_servers\s*\.\s*([^\]]+?)\s*\]$/.exec(line)?.[1];
	return name === undefined ? undefined : unquote(name);
}

/** What a line leaves open: `[` and `{` inside strings are text, not brackets. */
function bracketDepth(line: string): number {
	let quote: string | undefined;
	let depth = 0;

	for (const char of line) {
		if (quote) {
			if (char === quote) {
				quote = undefined;
			}
		} else if (char === '"' || char === '\'') {
			quote = char;
		} else if (char === '[' || char === '{') {
			depth++;
		} else if (char === ']' || char === '}') {
			depth--;
		}
	}

	return depth;
}

/** A `#` opens a comment unless it stands inside a string — and a url can carry one. */
function withoutComment(line: string): string {
	let quote: string | undefined;

	for (let at = 0; at < line.length; at++) {
		const char = line[at];
		if (quote) {
			if (char === quote) {
				quote = undefined;
			}
		} else if (char === '"' || char === '\'') {
			quote = char;
		} else if (char === '#') {
			return line.slice(0, at);
		}
	}

	return line;
}

export function unquote(value: string): string {
	return /^(["'])(.*)\1$/.exec(value)?.[2] ?? value;
}
