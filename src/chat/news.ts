/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Reading NEWS.md for the chat's empty state.
 *
 * The file is written by hand, so the reader is forgiving: an HTML comment is
 * skipped, the first heading is the file's title, the paragraph before the
 * first `## ` is the introduction, and each `## ` heading starts an entry
 * whose `-` / `*` bullets are its items (an indented line continues the item
 * above it). Anything else is ignored rather than refused — a typo in a news
 * file must not cost the chat its welcome. A leaf module, under test.
 */

import type { ChatNews } from './chatProtocol';

/** How many entries the empty state shows; the file may hold more. */
export const newsEntryLimit = 6;

export function parseNews(markdown: string, limit = newsEntryLimit): ChatNews {
	const text = markdown.replace(/<!--[\s\S]*?(-->|$)/g, '');
	const intro: string[] = [];
	const entries: { title: string; items: string[] }[] = [];
	let introDone = false;

	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trimEnd();
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			if (heading[1].length === 2) {
				entries.push({ title: heading[2].trim(), items: [] });
			}
			// A title heading, or a deeper one, starts nothing of its own; it does
			// end the introduction if text came before it.
			introDone = introDone || intro.length > 0 || heading[1].length === 2;
			continue;
		}
		const current = entries[entries.length - 1];
		if (current) {
			const bullet = /^\s{0,3}[-*+]\s+(.*)$/.exec(line);
			if (bullet) {
				current.items.push(bullet[1].trim());
			} else if (/^\s+\S/.test(line) && current.items.length) {
				current.items[current.items.length - 1] += ` ${line.trim()}`;
			}
			continue;
		}
		if (!introDone) {
			if (line.trim()) {
				intro.push(line.trim());
			} else if (intro.length) {
				introDone = true;
			}
		}
	}

	return {
		intro: intro.join(' '),
		entries: entries.filter(e => e.title && e.items.length).slice(0, Math.max(0, limit)),
	};
}
