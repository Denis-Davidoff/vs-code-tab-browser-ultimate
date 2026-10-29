import type { ChatEntry } from '../chatProtocol';

/**
 * How much of a conversation a remote surface (Chrome, the Exchange website) is sent:
 * the last `prompts` turns of the user, at most `maxEntries` entries. Sending the whole
 * conversation made connecting slow; earlier turns come with `loadEarlier`. Leaf, under test.
 */
export const remotePromptsStep = 20;
export const remoteMaxEntriesStep = 400;

export interface EntryWindow {
	readonly entries: readonly ChatEntry[];
	/** Index of the first entry sent; 0 when the whole conversation is there. */
	readonly offset: number;
}

export function windowEntries(entries: readonly ChatEntry[], prompts: number, maxEntries = Math.ceil(prompts / remotePromptsStep) * remoteMaxEntriesStep): EntryWindow {
	let start = entries.length;
	let seen = 0;
	while (start > 0 && seen < prompts) {
		start--;
		if (entries[start].kind === 'user') { seen++; }
	}
	if (seen < prompts) { start = 0; }
	if (entries.length - start > maxEntries) {
		// Over the cap: start at the first prompt inside it, or — when the current turn alone is longer
		// than the cap — at that turn's own prompt. Never mid-turn: the start would then move with every
		// new entry, and the view rebuilds the thread when it moves.
		let cut = entries.length - maxEntries;
		while (cut < entries.length && entries[cut].kind !== 'user') { cut++; }
		if (cut === entries.length) {
			cut = entries.length - maxEntries;
			while (cut > start && entries[cut].kind !== 'user') { cut--; }
		}
		start = cut;
	}
	return { entries: start ? entries.slice(start) : entries, offset: start };
}

/**
 * `aiBrowser.chat.visibleTurns` as last read by the chat (`visibleTurns.ts`): the number of turns
 * every view is sent at first and added per "Show earlier messages". Kept here so the Chrome bridge
 * and the website's connection, which do not load `vscode`, read the same value.
 */
let configuredTurns = remotePromptsStep;
export function setVisibleTurns(turns: number): void { configuredTurns = turns; }
export function currentVisibleTurns(): number { return configuredTurns; }
