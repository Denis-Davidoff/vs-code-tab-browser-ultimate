/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';

/*
 * The text half of the editor tools (`editor_reveal`, `editor_context`,
 * `editor_definition`, `editor_references`, `editor_symbols`): paths, columns,
 * cut lines. No `vscode`, so `npm test` loads it.
 */

/** Whether `target` is `folder` itself or inside it, as plain paths; a sibling that only starts like it is not. */
export function insideFolder(folder: string, target: string, sep: string = path.sep): boolean {
	const p = sep === '\\' ? path.win32 : path.posix;
	const rel = p.relative(p.resolve(folder), p.resolve(target));
	if (rel === '') {
		return true;
	}
	return rel !== '..' && !rel.startsWith(`..${sep}`) && !p.isAbsolute(rel);
}

const identifierChar = /[\p{L}\p{N}_$]/u;

/**
 * Where `symbol` stands in `line`, 0-based: its `occurrence`th appearance as a
 * whole identifier (not inside a longer name) — or, only when it never stands
 * alone on the line (`Bar` in `fooBar`), its `occurrence`th appearance at all —
 * else -1. Mixing the two lists counted `tab` in `tab, tabs` twice and answered
 * for `tabs`; an occurrence past the whole ones is refused instead. A model names a symbol by its text and its line,
 * since a column is the thing it is least likely to have counted right.
 */
export function symbolColumn(line: string, symbol: string, occurrence = 1): number {
	if (!symbol) {
		return -1;
	}
	const wanted = Math.max(1, Math.floor(occurrence));
	const whole: number[] = [];
	const any: number[] = [];
	for (let at = line.indexOf(symbol); at >= 0; at = line.indexOf(symbol, at + 1)) {
		any.push(at);
		const before = at > 0 ? line[at - 1] : '';
		const after = line[at + symbol.length] ?? '';
		if (!identifierChar.test(before) && !identifierChar.test(after)) {
			whole.push(at);
		}
	}
	return (whole.length ? whole : any)[wanted - 1] ?? -1;
}

/** One line of a file as a result carries it: trimmed, and cut at `limit` characters. */
export function lineSnippet(text: string, limit = 200): string {
	const line = text.replace(/\s+/g, ' ').trim();
	return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** A selection's text as `editor_context` hands it over: cut at `limit`, the cut said. */
export function cutText(text: string, limit: number): { text: string; truncated?: true } {
	if (text.length <= limit) {
		return { text };
	}
	// Not inside a surrogate pair: a lone half is refused by strict JSON readers (#373, #463).
	let end = limit;
	const code = text.charCodeAt(end - 1);
	if (code >= 0xd800 && code <= 0xdbff) {
		end--;
	}
	return { text: text.slice(0, end), truncated: true };
}

/**
 * A 1-based line number from a model's argument: a positive whole number, or
 * `undefined` for anything else — refused by the caller, never read as "line 1".
 */
export function lineArgument(value: unknown): number | undefined {
	const n = typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
	return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : undefined;
}
