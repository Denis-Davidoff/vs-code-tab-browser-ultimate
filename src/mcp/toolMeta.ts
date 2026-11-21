/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Denys Davydov. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What `tools/list` says about a tool beyond its schema: the MCP behaviour
 * hints, an icon for its group, and which of those a client's protocol version
 * may be sent.
 *
 * **Hints, not permissions.** `readOnlyHint`, `destructiveHint` and the rest are
 * what the spec calls them — advice to a client deciding whether to ask. They
 * decide nothing here: the chat's approval menu files every call by
 * `ourToolClass`, and the terminal tools need a one-shot grant whatever a hint
 * says. A client that trusts a hint and skips its own question is still
 * stopped by those.
 *
 * Leaf module: `npm test` loads it, and the test beside it reads the tool
 * files as text and fails on a tool with no entry here, or an entry for a tool
 * that no longer exists.
 */

export interface ToolHints {
	readonly readOnlyHint: boolean;
	readonly destructiveHint: boolean;
	readonly idempotentHint: boolean;
	readonly openWorldHint: boolean;
}

function hints(readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean, openWorldHint: boolean): ToolHints {
	return { readOnlyHint, destructiveHint, idempotentHint, openWorldHint };
}

/** Reads the extension's own state. */
const read = hints(true, false, true, false);
/** Reads a web page: the page is the open world. */
const web = hints(true, false, true, true);
/** Sets something of ours; doing it twice is doing it once. */
const set = hints(false, false, true, false);
/** Adds something of ours (a card, a note, a sound); doing it twice adds two. */
const add = hints(false, false, false, false);
/** Takes something of ours away (a tab, an annotation, an agent's work). */
const remove = hints(false, true, false, false);
/** Acts in a page: a click or a key can submit, delete or buy. */
const act = hints(false, true, false, true);
/** Writes into a page's fields without pressing anything: the same value twice is one fill. */
const write = hints(false, false, true, true);

/** Every tool's hints, by name. A tool missing here gets none — and fails the test. */
export const toolHints: Readonly<Record<string, ToolHints>> = {
	browser_state: read,
	browser_tabs: read,
	browser_select_tab: set,
	browser_navigate: hints(false, false, false, true),
	browser_close_tab: remove,
	browser_snapshot: web,
	browser_inspect_element: web,
	browser_selected_element: read,
	browser_html: web,
	browser_text: web,
	browser_frames: web,
	browser_forms: web,
	browser_scroll: hints(false, false, false, false),
	browser_click: act,
	browser_hover: hints(false, false, true, true),
	browser_press: act,
	browser_type: act,
	browser_drag: act,
	browser_fill: write,
	browser_fill_form: write,
	browser_wait_for: web,
	browser_wait_for_login: web,
	browser_screenshot: web,
	browser_console: web,
	browser_text_segments: web,
	browser_replace_text: hints(false, false, true, false),
	browser_restore_text: set,
	browser_annotations_add: add,
	browser_annotations_list: read,
	browser_annotations_get: read,
	browser_annotations_remove: remove,
	browser_annotations_clear: remove,
	browser_recording_start: add,
	browser_recording_pause: set,
	browser_recording_resume: set,
	browser_recording_status: read,
	browser_recording_stop: hints(false, false, false, false),

	editor_context: read,
	editor_reveal: set,
	editor_definition: read,
	editor_references: read,
	editor_symbols: read,

	skill_list: read,
	skill_get: read,


};

export type ToolGroup = 'browser' | 'editor' | 'chat' | 'terminal' | 'skill';

export function toolGroup(name: string): ToolGroup {
	if (name.startsWith('editor_')) {
		return 'editor';
	}
	if (name.startsWith('chat_')) {
		return 'chat';
	}
	if (name.startsWith('terminal_')) {
		return 'terminal';
	}
	if (name.startsWith('skill_')) {
		return 'skill';
	}
	return 'browser';
}

/** 16×16 outlines in `currentColor`, one per group. Data URIs: nothing to fetch, nothing a client could be pointed elsewhere by. */
const iconPaths: Readonly<Record<ToolGroup, string>> = {
	browser: '<circle cx="8" cy="8" r="6.5"/><path d="M1.5 8h13M8 1.5c2 2 2.8 4.2 2.8 6.5S10 12.5 8 14.5M8 1.5C6 3.5 5.2 5.7 5.2 8S6 12.5 8 14.5"/>',
	editor: '<path d="M5.5 4 1.5 8l4 4M10.5 4l4 4-4 4"/>',
	chat: '<path d="M2 3h12v8H7l-3 2.5V11H2z"/>',
	terminal: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="m4 6 2.5 2L4 10M8 10.5h4"/>',
	skill: '<path d="M3 2.5h7l3 3v8H3zM10 2.5v3h3M5.5 8.5h5M5.5 11h3.5"/>',
};

export interface ToolIcon {
	readonly src: string;
	readonly mimeType: 'image/svg+xml';
	readonly sizes: readonly string[];
}

const icons = new Map<ToolGroup, readonly ToolIcon[]>();

export function toolIcons(name: string): readonly ToolIcon[] {
	const group = toolGroup(name);
	let found = icons.get(group);
	if (!found) {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" `
			+ `stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${iconPaths[group]}</svg>`;
		found = [{ src: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, mimeType: 'image/svg+xml', sizes: ['any'] }];
		icons.set(group, found);
	}
	return found;
}
