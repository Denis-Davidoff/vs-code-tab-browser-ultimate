/*---------------------------------------------------------------------------------------------
 *  The little of Codex's `config.toml` this extension has to understand, in one place because
 *  both readers of it must agree: `mcpCheck.ts` decides whether an entry would reach this
 *  window, and `mcpSetup.ts` replaces our own entry without disturbing the rest of the file.
 *
 *  Not a TOML parser: it reads `[mcp_servers.*]` headers and the plain `key = value` lines
 *  inside them, which is what `codex mcp add` and this extension write. Anything more exotic
 *  reads as unconfigured, which costs a reconnect — but a header is recognised wherever TOML
 *  allows one to be written, comment and quotes included, because a table this misses is a
 *  table the setup would define a second time, and a file with a table twice in it does not
 *  parse at all.
 *--------------------------------------------------------------------------------------------*/

export interface CodexEntry {
	readonly name: string;
	readonly values: ReadonlyMap<string, string>;
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
	let current: (CodexEntry & { values: Map<string, string>; endLine: number }) | undefined;

	lines.forEach((raw, at) => {
		const line = withoutComment(raw).trim();
		if (!line) {
			return;
		}

		// Any header ends the previous table, so keys never land in the wrong one.
		if (line.startsWith('[')) {
			current = undefined;
			const name = mcpServerTableName(line);
			if (name !== undefined) {
				current = { name, values: new Map(), firstLine: at, endLine: at + 1 };
				entries.push(current);
			}
			return;
		}

		const pair = /^([^=]+?)\s*=\s*(.+)$/.exec(line);
		if (current && pair) {
			current.values.set(unquote(pair[1].trim()).toLowerCase(), unquote(pair[2].trim()));
			current.endLine = at + 1;
		}
	});

	return entries;
}

/** The name in `[mcp_servers.<name>]`, or `undefined` for any other table header. */
function mcpServerTableName(line: string): string | undefined {
	const name = /^\[\s*mcp_servers\s*\.\s*([^\]]+?)\s*\]$/.exec(line)?.[1];
	return name === undefined ? undefined : unquote(name);
}

/** A `#` opens a comment unless it stands inside a string — and a url can carry one. */
export function withoutComment(line: string): string {
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
