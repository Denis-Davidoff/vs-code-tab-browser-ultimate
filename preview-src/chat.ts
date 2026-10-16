/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * The AI Browser chat view, inside its webview.
 *
 * The extension host owns every bit of state and sends it whole; this script
 * renders it and reports what the user did. Kept here: the unsent draft (through
 * `setState`, so a reload does not lose a sentence) and which rows the user
 * opened or closed.
 *
 * The look follows the Claude Code and Codex panels, read from their shipped
 * stylesheets — see "The AI Browser chat" in CLAUDE.md for which part came from
 * which. Two layout rules carry most of it: the conversation is anchored to the
 * bottom (a growing spacer above the first turn), and each turn's prompt is
 * `position: sticky` inside its turn, so the prompt being answered stays at the
 * top while its reply scrolls under it.
 *
 * **Nothing from a model or a page is ever parsed as HTML.** Replies are
 * rendered by a small Markdown reader below that builds DOM nodes and sets
 * `textContent`; there is no `innerHTML` anywhere in this file.
 */

import type {
	AgentUsage, AttachmentKind, ChatEntry, ChatStats, ChatSummary, ChatViewState, HostToView, ToolEntry, ViewToHost,
} from '../src/chat/chatProtocol';

interface VsCodeApi {
	postMessage(message: ViewToHost): void;
	getState(): { draft?: string } | undefined;
	setState(state: { draft?: string }): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const post = (message: ViewToHost) => vscode.postMessage(message);

/* ---------------------------------------------------------------- dom */

type Child = Node | string | undefined | false;

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: { class?: string; text?: string; title?: string } = {},
	...children: Child[]
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (props.class) {
		node.className = props.class;
	}
	if (props.text !== undefined) {
		node.textContent = props.text;
	}
	if (props.title) {
		node.title = props.title;
	}
	for (const child of children) {
		if (child !== undefined && child !== false) {
			node.append(child);
		}
	}
	return node;
}

function icon(name: string, extra = ''): HTMLElement {
	return el('i', { class: `codicon codicon-${name} ${extra}`.trim() });
}

function button(content: Child[], props: { class?: string; title?: string } = {}): HTMLButtonElement {
	const b = el('button', props, ...content);
	b.type = 'button';
	if (props.title) {
		b.setAttribute('aria-label', props.title);
	}
	return b;
}

function copyButton(text: () => string, title = 'Copy'): HTMLButtonElement {
	const b = button([icon('copy')], { class: 'copy-button', title });
	b.addEventListener('click', event => {
		event.stopPropagation();
		post({ type: 'copy', text: text() });
		b.replaceChildren(icon('check'));
		setTimeout(() => b.replaceChildren(icon('copy')), 1200);
	});
	return b;
}

/* ---------------------------------------------------------------- layout */

const app = document.getElementById('app')!;

const thread = el('div', { class: 'thread' });
const threadInner = el('div', { class: 'thread-inner' });
thread.append(threadInner);
const blocked = el('div', { class: 'blocked' });

const attachmentsRow = el('div', { class: 'attachments' });
const input = el('textarea', { class: 'input' });
input.rows = 1;
input.placeholder = 'Ask about this page, or anything…';

const plusButton = button([icon('add')], { class: 'ghost round', title: 'Attach…' });
const agentPill = button([], { class: 'pill', title: 'Agent' });
const modelPill = button([], { class: 'pill', title: 'Model' });
const effortRange = el('input', { class: 'effort-range' });
effortRange.type = 'range';
effortRange.min = '0';
effortRange.step = '1';
const effortLabel = el('span', { class: 'effort-label' });
const effortBox = el('label', { class: 'effort', title: 'Effort' }, effortRange, effortLabel);
const usageButton = button([el('span', { text: 'U' })], { class: 'ghost round usage-button', title: 'Usage' });
const sendButton = button([icon('arrow-up')], { class: 'send', title: 'Send' });

// The two right-hand buttons are one group pushed to the end, so a narrow side
// bar wraps them together onto the next line, still at the right.
const toolbar = el('div', { class: 'toolbar' },
	plusButton, agentPill, modelPill, effortBox, el('span', { class: 'toolbar-end' }, usageButton, sendButton));
const composer = el('div', { class: 'composer' }, attachmentsRow, input, toolbar);
const footer = el('div', { class: 'footer' }, composer);

const menu = el('div', { class: 'popup menu' });
const usagePopup = el('div', { class: 'popup usage-popup' });
const historyPanel = el('div', { class: 'history-panel' });

app.append(thread, blocked, footer, menu, usagePopup, historyPanel);

/* ---------------------------------------------------------------- state */

let state: ChatViewState | undefined;

/** Rows the user opened or closed by hand, by key; everything else uses its default. */
const toggled = new Map<string, boolean>();

input.value = vscode.getState()?.draft ?? '';

window.addEventListener('message', (event: MessageEvent<HostToView>) => {
	const message = event.data;
	switch (message.type) {
		case 'state':
			state = message.state;
			render();
			return;
		case 'history':
			if (message.refresh) {
				// A delete changed the list: update a panel that is open, and leave
				// a closed one closed — the user may have shut it in between.
				if (historyPanel.classList.contains('open')) {
					fillHistory(message.chats);
				}
			} else {
				toggleHistory(message.chats);
			}
			return;
		case 'usage':
			renderUsage(message.usage, message.stats, message.loading);
			return;
		case 'focusInput':
			input.focus();
			return;
	}
});

function render(): void {
	if (!state) {
		return;
	}
	app.classList.toggle('is-blocked', !!state.blocked);
	blocked.textContent = state.blocked ?? '';
	renderThread(state);
	renderAttachments(state);
	renderSelectors(state);
	renderSend();
}

/* ---------------------------------------------------------------- thread */

interface Turn {
	/** Index of the user entry, or -1 for what came before the first message. */
	readonly prompt: number;
	readonly rows: number[];
}

function turnsOf(entries: readonly ChatEntry[]): Turn[] {
	const turns: Turn[] = [];
	let current: Turn | undefined;
	entries.forEach((entry, i) => {
		if (entry.kind === 'user') {
			current = { prompt: i, rows: [] };
			turns.push(current);
		} else {
			if (!current) {
				current = { prompt: -1, rows: [] };
				turns.push(current);
			}
			current.rows.push(i);
		}
	});
	return turns;
}

/**
 * Rendering is keyed: each entry's DOM is rebuilt only when the entry (or the
 * user's open/closed choice for it) changed. A streaming reply changes its last
 * row many times a second, and rebuilding the whole thread on every post would
 * lose the selection and the scroll position under the reader.
 */
let renderedChat = '';
let rendered: { sig: string; node: HTMLElement }[] = [];
let turnNodes: { root: HTMLElement; rows: HTMLElement; tail: HTMLElement }[] = [];
const spacer = el('div', { class: 'spacer' });
let workingNode: HTMLElement | undefined;

function renderThread(s: ChatViewState): void {
	const stick = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60;

	if (s.chatId !== renderedChat || s.entries.length < rendered.length) {
		// Open/closed choices are keyed by position, so they belong to one chat:
		// carried over, the next chat opened its own rows at the same indices.
		if (s.chatId !== renderedChat) {
			toggled.clear();
		}
		renderedChat = s.chatId;
		rendered = [];
		turnNodes = [];
		workingNode = undefined;
		threadInner.replaceChildren(spacer);
	}

	if (!s.entries.length) {
		threadInner.replaceChildren(spacer, welcome(s));
		rendered = [];
		turnNodes = [];
		return;
	}
	threadInner.querySelector('.welcome')?.remove();

	const turns = turnsOf(s.entries);
	const lastTurn = turns.length - 1;
	turns.forEach((turn, t) => {
		let nodes = turnNodes[t];
		if (!nodes) {
			const root = el('section', { class: 'turn' });
			const rows = el('div', { class: 'rows' });
			const tail = el('div', { class: 'turn-tail' });
			root.append(rows, tail);
			threadInner.append(root);
			nodes = turnNodes[t] = { root, rows, tail };
		}
		const indices = turn.prompt >= 0 ? [turn.prompt, ...turn.rows] : turn.rows;
		for (const i of indices) {
			const entry = s.entries[i];
			const sig = signature(entry, i);
			if (rendered[i]?.sig === sig) {
				continue;
			}
			const node = entryNode(entry, i);
			if (rendered[i]) {
				rendered[i].node.replaceWith(node);
			} else if (entry.kind === 'user') {
				nodes.root.prepend(node);
			} else {
				nodes.rows.append(node);
			}
			rendered[i] = { sig, node };
		}
		renderTail(nodes.tail, s, turn, t === lastTurn);
	});

	if (stick) {
		thread.scrollTop = thread.scrollHeight;
	}
}

/**
 * What decides whether a row is rebuilt. A prompt's open state is left out: the
 * bubble toggles its own class, and rebuilding it on the next post (every 40 ms
 * while a reply streams) took the reader's selection with it.
 */
function signature(entry: ChatEntry, i: number): string {
	return entry.kind === 'user' ? JSON.stringify(entry) : `${JSON.stringify(entry)}|${toggled.get(keyOf(entry, i)) ?? ''}`;
}

function keyOf(entry: ChatEntry, i: number): string {
	return entry.kind === 'tool' ? `tool:${entry.id}` : `${entry.kind}:${i}`;
}

/** The line under a turn: the live "Working…" while it runs, "Worked for …" once it is done. */
function renderTail(tail: HTMLElement, s: ChatViewState, turn: Turn, last: boolean): void {
	const prompt = turn.prompt >= 0 ? s.entries[turn.prompt] : undefined;
	if (last && s.running) {
		if (!workingNode || workingNode.parentElement !== tail) {
			workingNode = el('div', { class: 'working' });
			tail.replaceChildren(workingNode);
			delete tail.dataset.sig;
		}
		const startedAt = prompt?.kind === 'user' ? prompt.at : undefined;
		workingNode.dataset.since = startedAt ? String(startedAt) : '';
		tickWorking();
		return;
	}
	if (workingNode?.parentElement === tail) {
		workingNode = undefined;
	}
	const p = prompt?.kind === 'user' ? prompt : undefined;
	const worked = p?.workedMs;
	const text = worked !== undefined ? `${workedPhrase(p?.at)} for ${duration(worked)}` : '';
	// Tokens only when the agent reported them for this turn: ↑ sent, ↓ received.
	const tokens = p?.tokensIn !== undefined ? `↑ ${compact(p.tokensIn)}  ↓ ${compact(p.tokensOut ?? 0)}` : '';
	const sig = `${text}|${tokens}`;
	if (tail.dataset.sig !== sig) {
		tail.dataset.sig = sig;
		// A square where the working star was: the same slot, so the line does
		// not shift when the turn ends.
		tail.replaceChildren(text
			? el('div', { class: 'worked' },
				el('span', { class: 'working-glyph done', text: '■' }),
				el('span', { class: 'worked-text', text }),
				tokens ? el('span', {
					class: 'worked-tokens', text: tokens,
					title: `${(p?.tokensIn ?? 0).toLocaleString()} tokens sent${p?.tokensCached ? `, ${p.tokensCached.toLocaleString()} of them from the cache` : ''}; ${(p?.tokensOut ?? 0).toLocaleString()} received`,
				}) : undefined)
			: '');
	}
}

/**
 * Thirty ways to say "working", each with its past form for the line left
 * behind when the turn ends ("Browsing…" → "Browsed for 42s"). While a turn
 * runs, a random one is shown and replaced by another every eight seconds, so
 * a long turn does not sit on one word. The past form is chosen from the
 * turn's start time, so it stays the same through every re-render and reload.
 */
const phrases: readonly (readonly [string, string])[] = [
	['Working', 'Worked'], ['Thinking', 'Thought'], ['Browsing', 'Browsed'], ['Exploring', 'Explored'],
	['Reading', 'Read'], ['Pondering', 'Pondered'], ['Digging in', 'Dug in'], ['Reasoning', 'Reasoned'],
	['Investigating', 'Investigated'], ['Untangling', 'Untangled'], ['Piecing it together', 'Pieced it together'],
	['Weighing options', 'Weighed options'], ['Connecting the dots', 'Connected the dots'], ['Sketching', 'Sketched'],
	['Tinkering', 'Tinkered'], ['Considering', 'Considered'], ['Mulling it over', 'Mulled it over'],
	['Looking closer', 'Looked closer'], ['Scanning', 'Scanned'], ['Inspecting', 'Inspected'], ['Puzzling', 'Puzzled'],
	['Brewing', 'Brewed'], ['Crafting', 'Crafted'], ['Figuring it out', 'Figured it out'],
	['Charting a course', 'Charted a course'], ['Following the thread', 'Followed the thread'],
	['Sorting it out', 'Sorted it out'], ['Assembling', 'Assembled'], ['Polishing', 'Polished'],
	['Cross-checking', 'Cross-checked'],
];
const phraseEveryMs = 8000;
let phraseAt = Math.floor(Math.random() * phrases.length);
let phraseSince = Date.now();

function workingPhrase(): string {
	if (Date.now() - phraseSince >= phraseEveryMs) {
		// Another one, never the same twice in a row.
		phraseAt = (phraseAt + 1 + Math.floor(Math.random() * (phrases.length - 1))) % phrases.length;
		phraseSince = Date.now();
	}
	return phrases[phraseAt][0];
}

function workedPhrase(seed: number | undefined): string {
	return phrases[Math.abs(Math.floor((seed ?? 0) / 1000)) % phrases.length][1];
}

function tickWorking(): void {
	if (!workingNode) {
		return;
	}
	const since = Number(workingNode.dataset.since);
	const phrase = workingPhrase();
	const label = since ? `${phrase}… ${duration(Date.now() - since)}` : `${phrase}…`;
	const text = workingNode.querySelector('.working-text');
	if (text?.textContent !== label) {
		workingNode.replaceChildren(el('span', { class: 'working-glyph', text: glyphs[glyphAt] }), el('span', { class: 'shimmer working-text', text: label }));
	}
}
setInterval(tickWorking, 1000);

/**
 * The mark in front of "Working…": a star that changes shape, there and back,
 * every 120 ms. A glyph rather than a spinner icon, because a turning circle
 * reads as "loading" and this is the agent working, which can take minutes.
 * Under reduced motion it stays on one shape.
 */
const glyphs = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
let glyphAt = 0;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
setInterval(() => {
	if (!workingNode || reducedMotion.matches) {
		return;
	}
	glyphAt = (glyphAt + 1) % glyphs.length;
	const glyph = workingNode.querySelector('.working-glyph');
	if (glyph) {
		glyph.textContent = glyphs[glyphAt];
	}
}, 120);

function welcome(s: ChatViewState): HTMLElement {
	const available = s.agents.filter(a => a.available);
	const box = el('div', { class: 'welcome' },
		icon('globe', 'welcome-icon'),
		el('div', { class: 'welcome-title', text: 'AI Browser' }),
		el('div', { class: 'welcome-text', text: available.length
			? `Chat with ${available.map(a => a.name).join(' or ')} about the pages you have open. Use + to attach a screenshot, an element or the page address.`
			: s.detecting ? 'Looking for Claude Code and Codex…' : 'No agent is available yet.' }));
	for (const agent of s.agents.filter(a => !a.available && a.problem)) {
		box.append(el('div', { class: 'welcome-problem', text: `${agent.name}: ${agent.problem}` }));
	}
	return box;
}

function entryNode(entry: ChatEntry, i: number): HTMLElement {
	switch (entry.kind) {
		case 'user':
			return promptNode(entry, i);
		case 'assistant':
			return el('div', { class: 'row assistant markdown' }, renderMarkdown(entry.text));
		case 'thinking':
			return thinkingNode(entry, i);
		case 'tool':
			return toolNode(entry);
		case 'notice':
			return el('div', { class: 'row notice' }, icon('info'), el('span', { text: entry.text }));
		case 'error':
			return el('div', { class: 'row error' }, icon('error'), el('span', { text: entry.text }));
	}
}

/**
 * A turn's prompt. Sticky inside its turn: while its reply scrolls, it stays at
 * the top, and the next turn's prompt pushes it away — the Claude Code panel's
 * `.message.stickyHeader`. Long prompts are clamped; a click shows all of it.
 */
function promptNode(entry: Extract<ChatEntry, { kind: 'user' }>, i: number): HTMLElement {
	const key = keyOf(entry, i);
	const bubble = el('div', { class: 'bubble' });
	if (entry.attachments.length) {
		bubble.append(el('div', { class: 'bubble-attachments' },
			...entry.attachments.map(label => el('span', { class: 'chip small', text: label }))));
	}
	if (entry.text) {
		bubble.append(el('div', { class: 'bubble-text', text: entry.text }));
	}
	bubble.classList.toggle('expanded', toggled.get(key) === true);
	bubble.addEventListener('click', () => {
		// A drag that selected text ends in a click too; it is a selection, not
		// a request to fold the prompt.
		if (window.getSelection()?.toString()) {
			return;
		}
		toggled.set(key, !bubble.classList.contains('expanded'));
		bubble.classList.toggle('expanded');
	});
	return el('div', { class: 'prompt' }, bubble);
}

function thinkingNode(entry: Extract<ChatEntry, { kind: 'thinking' }>, i: number): HTMLElement {
	const key = keyOf(entry, i);
	const active = entry.endedAt === undefined;
	const open = toggled.get(key) ?? false;
	const label = active ? 'Thinking' : `Thought for ${duration((entry.endedAt ?? entry.startedAt) - entry.startedAt)}`;
	const head = button([
		el('span', { class: active ? 'shimmer' : '', text: label }),
		icon('chevron-right', 'chevron'),
	], { class: 'activity-head' });
	const node = el('div', { class: `row thinking${open ? ' open' : ''}` }, head);
	if (open) {
		const body = el('div', { class: 'thinking-body markdown' }, renderMarkdown(entry.text));
		node.append(body);
		if (active) {
			requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
		}
	}
	head.addEventListener('click', () => {
		toggled.set(key, !open);
		render();
	});
	return node;
}

/* ---------------------------------------------------------------- tools */

const toolIcons: Record<ToolEntry['tool'], string> = {
	command: 'terminal', read: 'file', edit: 'edit', search: 'search', web: 'globe', agent: 'hubot', mcp: 'plug', other: 'tools',
};

function basename(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** "Ran `npm test`", "Read a.txt", "Edited app.ts +3 −1" — the Codex panel's activity rows. */
function toolTitle(t: ToolEntry): Child[] {
	const running = t.status === 'running';
	const verb = (now: string, past: string) => el('span', { class: 'verb', text: running ? now : past });
	const mono = (text: string, title?: string) => el('span', { class: 'mono', text, title });
	const plain = (text: string, title?: string) => el('span', { class: 'subject', text, title });
	switch (t.tool) {
		case 'command': {
			const command = (t.input ?? '').split('\n')[0];
			return [verb('Running', 'Ran'), mono(command || t.detail || t.name, t.input)];
		}
		case 'read':
			return [verb('Reading', 'Read'), plain(t.detail ? basename(t.detail) : t.name, t.detail)];
		case 'edit':
			return [
				verb('Editing', 'Edited'), plain(t.detail ? basename(t.detail) : t.name, t.detail),
				t.added !== undefined && el('span', { class: 'added', text: `+${t.added}` }),
				t.removed !== undefined && el('span', { class: 'removed', text: `−${t.removed}` }),
			];
		case 'search':
			return [verb('Searching', 'Searched'), plain(t.detail ?? t.name, t.detail)];
		case 'web':
			return [verb('Browsing', t.name === 'WebSearch' || t.name === 'Web search' ? 'Searched the web' : 'Fetched'), t.detail ? plain(t.detail, t.detail) : undefined];
		case 'agent':
			return [verb('Delegating', 'Delegated'), plain(t.detail ?? t.name, t.detail)];
		case 'mcp':
		case 'other':
			return [verb('Calling', 'Called'), plain(t.name), t.detail ? el('span', { class: 'faint', text: t.detail }) : undefined];
	}
}

/** Commands and edits open by default — the command and its answer are the point of the row. */
function openByDefault(t: ToolEntry): boolean {
	return t.tool === 'command' || (t.tool === 'edit' && !!t.input);
}

function toolNode(t: ToolEntry): HTMLElement {
	const key = `tool:${t.id}`;
	const hasBody = !!(t.input || t.output) && t.tool !== 'read';
	const open = hasBody && (toggled.get(key) ?? openByDefault(t));
	const status = t.status === 'failed' ? 'failed' : t.status === 'running' ? 'running' : 'done';

	const head = button([
		el('span', { class: `status-dot ${status}` }),
		icon(toolIcons[t.tool], 'tool-icon'),
		el('span', { class: 'activity-title' }, ...toolTitle(t)),
		hasBody && icon('chevron-right', 'chevron'),
	], { class: 'activity-head', title: t.detail && t.tool === 'command' ? t.detail : '' });
	head.disabled = !hasBody;
	head.addEventListener('click', () => {
		toggled.set(key, !open);
		render();
	});

	const node = el('div', { class: `row tool ${status}${open ? ' open' : ''}` }, head);
	if (open) {
		node.append(t.tool === 'command' ? execCard(t) : t.tool === 'edit' && t.input ? diffCard(t) : outputCard(t));
	}
	return node;
}

/** The command and its output — the Codex panel's shell block: `$ command`, output pinned to its newest line, a status footer. */
function execCard(t: ToolEntry): HTMLElement {
	const command = el('div', { class: 'exec-command' },
		el('span', { class: 'exec-prompt', text: '$' }), el('span', { text: t.input ?? '' }),
		copyButton(() => t.input ?? '', 'Copy command'));
	const card = el('div', { class: 'card exec' }, command);
	if (t.output) {
		const pre = el('pre', { text: t.output.replace(/\n+$/, '') });
		card.append(el('div', { class: 'exec-output' }, pre, copyButton(() => t.output ?? '', 'Copy output')));
		requestAnimationFrame(() => { pre.scrollTop = pre.scrollHeight; });
	}
	const footerText = t.status === 'running'
		? el('span', { class: 'shimmer', text: 'Running…' })
		: t.status === 'failed'
			? el('span', { class: 'exit failed', text: t.exitCode !== undefined ? `Exit code ${t.exitCode}` : 'Failed' })
			: el('span', { class: 'exit ok' }, icon('check'), el('span', { text: t.output ? 'Success' : 'No output' }));
	card.append(el('div', { class: 'exec-footer' },
		t.detail ? el('span', { class: 'faint ellipsis', text: t.detail }) : undefined,
		el('span', { class: 'end' }, footerText)));
	return card;
}

function diffCard(t: ToolEntry): HTMLElement {
	const lines = (t.input ?? '').split('\n');
	const pre = el('pre', {}, ...lines.map(line => {
		const cls = line.startsWith('+') && !line.startsWith('+++') ? 'line add'
			: line.startsWith('-') && !line.startsWith('---') ? 'line del'
				: line.startsWith('@@') ? 'line hunk' : 'line';
		return el('span', { class: cls, text: line + '\n' });
	}));
	const head = el('div', { class: 'card-head' },
		el('span', { class: 'ellipsis', text: t.detail ?? 'Changes', title: t.detail }),
		el('span', { class: 'end' },
			t.added !== undefined && el('span', { class: 'added', text: `+${t.added}` }),
			t.removed !== undefined && el('span', { class: 'removed', text: `−${t.removed}` })));
	return el('div', { class: 'card diff' }, head, el('div', { class: 'card-body' }, pre));
}

function outputCard(t: ToolEntry): HTMLElement {
	const card = el('div', { class: 'card io' });
	if (t.input) {
		card.append(el('div', { class: 'io-row' }, el('span', { class: 'io-label', text: 'IN' }), el('pre', { text: t.input })));
	}
	if (t.output) {
		card.append(el('div', { class: 'io-row' }, el('span', { class: 'io-label', text: 'OUT' }), el('pre', { text: t.output }),
			copyButton(() => t.output ?? '')));
	}
	return card;
}

/** 812, 34.6k, 1.2M */
function compact(n: number): string {
	if (n < 1000) {
		return String(n);
	}
	if (n < 1_000_000) {
		return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
	}
	return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

function duration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) {
		return `${s}s`;
	}
	const m = Math.floor(s / 60);
	return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/* ---------------------------------------------------------------- markdown */

/**
 * As much Markdown as a chat reply needs: fenced code (an unclosed fence, as a
 * streaming reply has, runs to the end), headings, bullet and numbered lists,
 * block quotes, tables, rules, paragraphs, and inline code, bold, italics and
 * links. Every piece of text goes in through `textContent`.
 */
function renderMarkdown(text: string): DocumentFragment {
	const out = document.createDocumentFragment();
	const lines = text.split('\n');
	let paragraph: string[] = [];
	let list: HTMLElement | undefined;
	/** A list indented under the last item of `list`, which keeps its own numbering. */
	let sub: HTMLElement | undefined;

	const flush = () => {
		if (paragraph.length) {
			const p = el('p');
			paragraph.forEach((line, i) => {
				if (i) {
					p.append(el('br'));
				}
				inline(p, line);
			});
			out.append(p);
			paragraph = [];
		}
		list = undefined;
		sub = undefined;
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(line);
		if (fence) {
			flush();
			const code: string[] = [];
			for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) {
				code.push(lines[i]);
			}
			out.append(codeBlock(code.join('\n'), fence[2]));
			continue;
		}
		if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
			flush();
			// The header, the separator, then every following line with a pipe:
			// the separator and body rows may leave out their outer pipes.
			const rows: string[] = [line, lines[i + 1]];
			for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) {
				rows.push(lines[i]);
			}
			i--;
			out.append(table(rows));
			continue;
		}
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			flush();
			const h = el('div', { class: `heading h${Math.min(heading[1].length, 4)}` });
			inline(h, heading[2]);
			out.append(h);
			continue;
		}
		if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
			flush();
			out.append(el('hr'));
			continue;
		}
		const quote = /^\s*>\s?(.*)$/.exec(line);
		if (quote) {
			flush();
			const q = el('blockquote');
			inline(q, quote[1]);
			out.append(q);
			continue;
		}
		const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
		if (bullet) {
			const ordered = /\d/.test(bullet[2]);
			if (paragraph.length) {
				flush();
			}
			const li = el('li');
			inline(li, bullet[3]);
			// An indented item belongs to a list of its own inside the item above
			// it. Appended to the outer list, "1. First / 1. sub / 2. sub /
			// 2. Second" numbered the outer items on through the sub-items, so
			// "Second" read as 4.
			const parentItem = list?.lastElementChild;
			if (bullet[1].length >= 2 && parentItem) {
				if (!sub || (sub.tagName === 'OL') !== ordered || sub.parentElement !== parentItem) {
					sub = newList(ordered, bullet[2]);
					parentItem.append(sub);
				}
				sub.append(li);
				continue;
			}
			sub = undefined;
			if (!list || (list.tagName === 'OL') !== ordered) {
				list = newList(ordered, bullet[2]);
				out.append(list);
			}
			list.append(li);
			continue;
		}
		if (!line.trim()) {
			flush();
			continue;
		}
		list = undefined;
		paragraph.push(line);
	}
	flush();
	return out;
}

/**
 * A list starting at the number the model wrote, not at 1: a blank line or an
 * indented paragraph between items starts a new list here, and "1. … 2. … 3."
 * with text between them rendered as 1, 1, 1.
 */
function newList(ordered: boolean, marker: string): HTMLElement {
	const list = el(ordered ? 'ol' : 'ul');
	const start = parseInt(marker, 10);
	if (ordered && start > 1 && list instanceof HTMLOListElement) {
		list.start = start;
	}
	return list;
}

/** `|---|:--:|`, `---|---`, `|---|` — every cell dashes, with optional colons. Linear, unlike the pattern it replaced. */
function isTableSeparator(line: string): boolean {
	if (!line.includes('|') || !line.includes('-')) {
		return false;
	}
	const cells = tableCells(line);
	return cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c));
}

/**
 * A table row's cells. A pipe inside inline code, or escaped as `\|`, is text,
 * not a column: split blindly, `` `a|b` `` became two cells.
 */
function tableCells(row: string): string[] {
	let text = row.trim();
	if (text.startsWith('|')) {
		text = text.slice(1);
	}
	if (text.endsWith('|') && !text.endsWith('\\|')) {
		text = text.slice(0, -1);
	}
	const cells: string[] = [];
	let cell = '';
	let code = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '\\' && text[i + 1] === '|') {
			cell += '|';
			i++;
		} else if (c === '`') {
			code = !code;
			cell += c;
		} else if (c === '|' && !code) {
			cells.push(cell.trim());
			cell = '';
		} else {
			cell += c;
		}
	}
	cells.push(cell.trim());
	return cells;
}

function codeBlock(code: string, lang: string): HTMLElement {
	return el('div', { class: 'code-block' },
		el('div', { class: 'code-head' }, el('span', { text: lang || 'text' }), copyButton(() => code)),
		el('pre', {}, el('code', { text: code })));
}

function table(rows: string[]): HTMLElement {
	const cells = tableCells;
	const t = el('table');
	const head = el('tr');
	for (const c of cells(rows[0])) {
		const th = el('th');
		inline(th, c);
		head.append(th);
	}
	t.append(el('thead', {}, head));
	const body = el('tbody');
	for (const row of rows.slice(2)) {
		const tr = el('tr');
		for (const c of cells(row)) {
			const td = el('td');
			inline(td, c);
			tr.append(td);
		}
		body.append(tr);
	}
	t.append(body);
	return el('div', { class: 'table-wrap' }, t);
}

/**
 * Lines longer than this are shown as plain text. The inline pattern backtracks
 * on long runs of backticks or `[` — measured at 0.5–0.9 s for 40 000 of them —
 * and a streaming reply is re-rendered every 40 ms, so one odd line (a model
 * echoing page text) would stall the view on every post.
 */
const inlineLimit = 4000;

function inline(parent: HTMLElement, text: string): void {
	if (text.length > inlineLimit) {
		parent.append(text);
		return;
	}
	const pattern = /(`+)([^`]+?)\1|\*\*([^*]+)\*\*|(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
	let at = 0;
	for (const match of text.matchAll(pattern)) {
		if (match.index > at) {
			parent.append(text.slice(at, match.index));
		}
		if (match[2] !== undefined) {
			parent.append(el('code', { text: match[2] }));
		} else if (match[3] !== undefined) {
			// Formatted recursively: `**\`npm test\`**` is how replies name
			// files, and as plain text it showed the backticks.
			const strong = el('strong');
			inline(strong, match[3]);
			parent.append(strong);
		} else if (match[4] !== undefined) {
			const em = el('em');
			inline(em, match[4]);
			parent.append(em);
		} else {
			// A link's address is shown, never followed: a click in a webview
			// would navigate the view itself.
			const link = el('span', { class: 'link', title: match[6] });
			inline(link, match[5]);
			parent.append(link);
		}
		at = match.index + match[0].length;
	}
	if (at < text.length) {
		parent.append(text.slice(at));
	}
}

/* ---------------------------------------------------------------- composer */

function renderAttachments(s: ChatViewState): void {
	attachmentsRow.replaceChildren(...s.attachments.map(chip => {
		const remove = button([icon('close')], { class: 'chip-remove', title: 'Remove' });
		remove.addEventListener('click', () => post({ type: 'removeAttachment', id: chip.id }));
		let thumb: HTMLElement = icon(attachmentIcon(chip.kind));
		if (chip.thumbnail) {
			const img = el('img', { class: 'thumb' });
			img.src = chip.thumbnail;
			img.alt = '';
			thumb = img;
		}
		return el('span', { class: 'chip', title: chip.label }, thumb, el('span', { class: 'chip-label', text: chip.label }), remove);
	}));
	attachmentsRow.hidden = !s.attachments.length;
}

function attachmentIcon(kind: AttachmentKind): string {
	switch (kind) {
		case 'screenshot': return 'device-camera';
		case 'element': return 'inspect';
		case 'page': return 'link';
		case 'file': return 'file';
	}
}

function pillContent(label: string): Node[] {
	return [el('span', { class: 'pill-label', text: label }), icon('chevron-down', 'pill-chevron')];
}

function renderSelectors(s: ChatViewState): void {
	const agent = s.agents.find(a => a.id === s.selection.agent);
	agentPill.replaceChildren(...pillContent(agent?.name ?? (s.detecting ? 'Looking…' : 'No agent')));
	agentPill.disabled = !s.agents.some(a => a.available);
	agentPill.title = agent?.detail ? `${agent.name} ${agent.detail}` : 'Agent';

	const model = agent?.models.find(m => m.id === s.selection.model);
	modelPill.replaceChildren(...pillContent(model?.label ?? 'Model'));
	modelPill.disabled = !agent?.models.length;
	modelPill.title = model?.description ?? 'Model';

	const efforts = model?.efforts ?? [];
	effortBox.hidden = !efforts.length;
	if (efforts.length) {
		effortRange.max = String(efforts.length - 1);
		effortRange.value = String(Math.max(0, efforts.indexOf(s.selection.effort ?? '')));
		effortLabel.textContent = labelOf(s.selection.effort ?? efforts[0]);
		effortBox.title = `Effort: ${efforts.map(labelOf).join(' · ')}`;
		effortBox.classList.toggle('max', effortRange.value === effortRange.max);
	}
}

function labelOf(effort: string): string {
	return effort === 'xhigh' ? 'X-High' : effort.charAt(0).toUpperCase() + effort.slice(1);
}

/**
 * Whether a message can go anywhere. While detection runs the host waits for it,
 * so sending is allowed; once it is over with no agent, the draft stays in the
 * box — the send button used to clear it into a refusal.
 */
function canSend(): boolean {
	return !!state && (state.detecting || state.agents.some(a => a.available));
}

function renderSend(): void {
	const running = state?.running ?? false;
	const hasContent = !!input.value.trim() || !!state?.attachments.length;
	const stop = running && !hasContent;
	sendButton.replaceChildren(icon(stop ? 'debug-stop' : 'arrow-up'));
	sendButton.title = stop ? 'Stop' : !canSend() ? 'No agent is available' : running ? 'Send (added to the running turn)' : 'Send';
	sendButton.setAttribute('aria-label', stop ? 'Stop' : 'Send');
	sendButton.classList.toggle('stop', stop);
	sendButton.disabled = !stop && (!hasContent || !canSend());
}

effortRange.addEventListener('input', () => {
	const s = state?.selection ?? {};
	const agent = state?.agents.find(a => a.id === s.agent);
	const efforts = agent?.models.find(m => m.id === s.model)?.efforts ?? [];
	const effort = efforts[Number(effortRange.value)];
	if (effort) {
		effortLabel.textContent = labelOf(effort);
		effortBox.classList.toggle('max', effortRange.value === effortRange.max);
		post({ type: 'select', selection: { agent: s.agent, model: s.model, effort } });
	}
});

function autosize(): void {
	input.style.height = 'auto';
	input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}

input.addEventListener('input', () => {
	vscode.setState({ draft: input.value });
	autosize();
	renderSend();
});

input.addEventListener('keydown', event => {
	if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
		event.preventDefault();
		send();
	}
});

sendButton.addEventListener('click', () => {
	if (sendButton.classList.contains('stop')) {
		post({ type: 'stop' });
	} else {
		send();
	}
});

function send(): void {
	const text = input.value;
	if ((!text.trim() && !state?.attachments.length) || !canSend()) {
		return;
	}
	post({ type: 'send', text });
	input.value = '';
	vscode.setState({ draft: '' });
	autosize();
	renderSend();
	// A sent message always brings the thread down to it.
	requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });
}

composer.addEventListener('mousedown', event => {
	if (event.target === composer || event.target === toolbar) {
		event.preventDefault();
		input.focus();
	}
});

/* ---------------------------------------------------------------- popups */

function closePopups(except?: HTMLElement): void {
	for (const popup of [menu, usagePopup, historyPanel]) {
		if (popup !== except) {
			popup.classList.remove('open');
		}
	}
	for (const pill of [agentPill, modelPill, plusButton, usageButton]) {
		pill.classList.remove('active');
	}
}

function openAbove(popup: HTMLElement, anchor: HTMLElement, align: 'left' | 'right'): void {
	closePopups(popup);
	anchor.classList.add('active');
	// Relative to the view, not the window: the popup is positioned inside
	// `#app`, and the two only coincide when nothing else is laid out around it.
	const box = app.getBoundingClientRect();
	const rect = anchor.getBoundingClientRect();
	popup.style.bottom = `${box.bottom - rect.top + 6}px`;
	if (align === 'left') {
		popup.style.left = `${Math.max(8, rect.left - box.left)}px`;
		popup.style.right = '';
	} else {
		popup.style.right = `${Math.max(8, box.right - rect.right)}px`;
		popup.style.left = '';
	}
	popup.classList.add('open');
}

document.addEventListener('mousedown', event => {
	const target = event.target as Node;
	if (![menu, usagePopup, historyPanel, plusButton, usageButton, agentPill, modelPill].some(n => n.contains(target))) {
		closePopups();
	}
});

document.addEventListener('keydown', event => {
	if (event.key === 'Escape') {
		closePopups();
	}
});

interface MenuItem {
	readonly icon?: string;
	readonly label: string;
	readonly description?: string;
	readonly checked?: boolean;
	readonly disabled?: boolean;
	readonly run: () => void;
}

function openMenu(anchor: HTMLElement, items: MenuItem[], heading?: string): void {
	if (menu.classList.contains('open') && anchor.classList.contains('active')) {
		closePopups();
		return;
	}
	menu.replaceChildren(
		heading ? el('div', { class: 'menu-heading', text: heading }) : '',
		...items.map(item => {
			const b = button([
				item.icon ? icon(item.icon, 'menu-icon') : el('span', { class: 'menu-icon' }),
				el('span', { class: 'menu-text' },
					el('span', { class: 'menu-label', text: item.label }),
					item.description ? el('span', { class: 'menu-description', text: item.description }) : undefined),
				item.checked ? icon('check', 'menu-check') : el('span', { class: 'menu-check' }),
			], { class: 'menu-item' });
			b.disabled = !!item.disabled;
			b.addEventListener('click', () => {
				closePopups();
				item.run();
			});
			return b;
		}));
	openAbove(menu, anchor, 'left');
}

agentPill.addEventListener('click', () => {
	const s = state;
	if (!s) {
		return;
	}
	openMenu(agentPill, s.agents.map(a => ({
		icon: a.id === 'claude' ? 'sparkle' : 'hubot',
		label: a.name,
		description: a.available ? a.detail?.split(':')[0] : a.problem,
		checked: a.id === s.selection.agent,
		disabled: !a.available,
		run: () => post({ type: 'select', selection: { agent: a.id } }),
	})), 'Agent');
});

modelPill.addEventListener('click', () => {
	const s = state;
	const agent = s?.agents.find(a => a.id === s.selection.agent);
	if (!s || !agent) {
		return;
	}
	openMenu(modelPill, agent.models.map(m => ({
		label: m.label,
		description: m.description,
		checked: m.id === s.selection.model,
		run: () => post({ type: 'select', selection: { agent: agent.id, model: m.id } }),
	})), `${agent.name} models`);
});

/* "+" */

const attachItems: { kind: AttachmentKind; icon: string; label: string; needsTab: boolean }[] = [
	{ kind: 'screenshot', icon: 'device-camera', label: 'Screenshot of the page', needsTab: true },
	{ kind: 'element', icon: 'inspect', label: 'Element from the page…', needsTab: true },
	{ kind: 'page', icon: 'link', label: 'Page address', needsTab: true },
	{ kind: 'file', icon: 'file', label: 'File…', needsTab: false },
];

plusButton.addEventListener('click', () => {
	// Without the grant no tab can be seen at all, so "open a page" would send
	// the user the wrong way (Recipe, step 3: two guards, two messages).
	const pageProblem = !state?.browserApi
		? 'Browser API not enabled — use "Enable Browser API" in the status bar'
		: !state.hasBrowserTab ? 'Open a page in the browser first' : undefined;
	openMenu(plusButton, attachItems.map(item => ({
		icon: item.icon,
		label: item.label,
		description: item.needsTab ? pageProblem : undefined,
		disabled: item.needsTab && !!pageProblem,
		run: () => post({ type: 'attach', kind: item.kind }),
	})), 'Attach');
});

/* "U" */

usageButton.addEventListener('click', () => {
	if (usagePopup.classList.contains('open')) {
		closePopups();
		return;
	}
	renderUsage([], undefined, true);
	openAbove(usagePopup, usageButton, 'right');
	post({ type: 'usage' });
});

function renderUsage(usage: readonly AgentUsage[], stats: ChatStats | undefined, loading: boolean): void {
	const sections: HTMLElement[] = [];
	if (loading) {
		sections.push(el('div', { class: 'usage-loading' }, el('span', { class: 'shimmer', text: 'Asking the agents…' })));
	}
	for (const u of usage) {
		const name = state?.agents.find(a => a.id === u.agent)?.name ?? u.agent;
		const section = el('div', { class: 'usage-section' },
			el('div', { class: 'usage-head' },
				el('span', { class: 'usage-agent', text: name }),
				u.plan ? el('span', { class: 'usage-plan', text: u.plan }) : undefined));
		for (const w of u.windows) {
			const used = Math.max(0, Math.min(100, w.usedPercent));
			const fill = el('div', { class: 'bar-fill' });
			fill.style.width = `${used}%`;
			const bar = el('div', { class: `bar${used >= 80 ? ' high' : ''}` }, fill);
			section.append(el('div', { class: 'usage-window' },
				el('div', { class: 'usage-row' },
					el('span', { text: w.label }),
					el('span', { class: 'usage-value', text: `${Math.round(used)}%` })),
				bar,
				w.resetsAt ? el('div', { class: 'usage-reset', text: `Resets ${resetText(w.resetsAt)}` }) : undefined));
		}
		for (const note of u.notes) {
			section.append(el('div', { class: 'usage-note', text: note }));
		}
		if (u.error) {
			section.append(el('div', { class: 'usage-error', text: u.error }));
		}
		sections.push(section);
	}
	if (!loading && !usage.length) {
		sections.push(el('div', { class: 'usage-note', text: 'No agent is available.' }));
	}
	if (stats && stats.turns) {
		const rows: [string, string][] = [
			['Messages', String(stats.turns)],
			['Input tokens', stats.inputTokens.toLocaleString()],
			['Cached', stats.cachedTokens.toLocaleString()],
			['Output tokens', stats.outputTokens.toLocaleString()],
		];
		if (stats.costUsd !== undefined) {
			rows.push(['Cost (API prices)', `$${stats.costUsd.toFixed(stats.costUsd < 1 ? 4 : 2)}`]);
		}
		sections.push(el('div', { class: 'usage-section' },
			el('div', { class: 'usage-head' }, el('span', { class: 'usage-agent', text: 'This chat' })),
			...rows.map(([k, v]) => el('div', { class: 'usage-row' }, el('span', { text: k }), el('span', { class: 'usage-value', text: v })))));
	}
	usagePopup.replaceChildren(...sections);
}

function resetText(at: number): string {
	const minutes = Math.round((at - Date.now()) / 60000);
	if (minutes <= 0) {
		return 'now';
	}
	if (minutes < 60) {
		return `in ${minutes} min`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 48) {
		return `in ${hours} h ${minutes % 60} min`;
	}
	return `on ${new Date(at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}`;
}

/* history */

function toggleHistory(chats: readonly ChatSummary[]): void {
	if (historyPanel.classList.contains('open')) {
		closePopups();
		return;
	}
	fillHistory(chats);
	closePopups(historyPanel);
	historyPanel.classList.add('open');
}

function fillHistory(chats: readonly ChatSummary[]): void {
	const close = button([icon('close')], { class: 'ghost round', title: 'Close' });
	close.addEventListener('click', () => closePopups());
	const header = el('div', { class: 'history-head' }, el('span', { text: 'History' }), close);

	const list = el('div', { class: 'history-list' });
	if (!chats.length) {
		list.append(el('div', { class: 'history-empty', text: 'No chats yet.' }));
	}
	for (const chat of chats) {
		const open = button([
			el('span', { class: 'history-title', text: chat.title }),
			el('span', { class: 'history-meta', text: `${state?.agents.find(a => a.id === chat.agent)?.name ?? chat.agent} · ${ago(chat.updatedAt)}` }),
		], { class: 'history-item', title: chat.title });
		open.classList.toggle('current', chat.id === state?.chatId);
		open.addEventListener('click', () => {
			closePopups();
			post({ type: 'openChat', id: chat.id });
		});
		const remove = button([icon('trash')], { class: 'ghost round history-delete', title: 'Delete' });
		remove.addEventListener('click', () => post({ type: 'deleteChat', id: chat.id }));
		list.append(el('div', { class: 'history-row' }, open, remove));
	}
	historyPanel.replaceChildren(header, list);
}

function ago(at: number): string {
	const minutes = Math.round((Date.now() - at) / 60000);
	if (minutes < 1) {
		return 'just now';
	}
	if (minutes < 60) {
		return `${minutes} min ago`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `${hours} h ago`;
	}
	return new Date(at).toLocaleDateString();
}

autosize();
post({ type: 'ready' });
