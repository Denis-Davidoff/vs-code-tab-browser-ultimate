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

/** Inline tool data shares a bounded budget in remote snapshots. Original values
 * remain in the editor/history; oversized blocks get an explicit remote-only note.
 * This also bounds a single native result, which cannot be fixed by dropping
 * older entries from an Exchange snapshot.
 */
export const remoteRichBytes = 1_000_000;
export function remoteRichEntries(entries: readonly ChatEntry[], limit = remoteRichBytes): readonly ChatEntry[] {
	let remaining = Math.max(0, limit), changed = false;
	const projected = [...entries];
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if ((entry.kind !== 'tool' && entry.kind !== 'result') || !entry.blocks?.length) { continue; }
		const blocks: NonNullable<typeof entry.blocks>[number][] = [];
		let omitted = 0;
		for (const block of entry.blocks) {
			if (block.type !== 'text' && block.type !== 'json') { blocks.push(block); continue; }
			const bytes = utf8Bytes(JSON.stringify(block)) + 1;
			if (bytes <= remaining) { blocks.push(block); remaining -= bytes; }
			else { omitted++; }
		}
		if (omitted) {
			blocks.push({ type: 'text', text: `${omitted} result block(s) exceed this remote view's size budget. Open the conversation in VS Code to inspect or copy the full result. The original data is preserved in the conversation.` });
			projected[index] = { ...entry, blocks }; changed = true;
		}
	}
	return changed ? projected : entries;
}
function utf8Bytes(text: string): number {
	let size = 0;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code < 0x80) { size++; }
		else if (code < 0x800) { size += 2; }
		else if (code >= 0xD800 && code <= 0xDBFF && index + 1 < text.length && text.charCodeAt(index + 1) >= 0xDC00 && text.charCodeAt(index + 1) <= 0xDFFF) { size += 4; index++; }
		else { size += 3; }
	}
	return size;
}
