import type { ChatEntry } from '../src/chat/chatProtocol';
import type { ResultBlock, JsonValue, ChatRelation, RichAction, CitationTarget, Citation } from '../src/chat/richProtocol';
import type { VisualizationSnapshot } from '../src/chat/visualizationProtocol';
import { updateVisualizationViews } from './visualizationViews';
import type { ArtifactActions } from './artifactViews';
import { searchField } from './searchField';

export interface RichViewActions extends ArtifactActions {
	copy(text: string): void;
	reveal(target: ChatRelation): void;
	cancel(id: string): void;
	citation(target: CitationTarget): void;
}
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] => {
	const element = document.createElement(tag); if (text !== undefined) { element.textContent = text; } if (className) { element.className = className; } return element;
};
const button = (label: string, action: () => void) => { const element = node('button', label); element.type = 'button'; element.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); action(); }); return element; };
const snapshotsOf = new WeakMap<HTMLElement, string>();
const blockSignatures = new WeakMap<HTMLElement, string>();
interface Clock { startedAt: number; endedAt?: number; node: HTMLElement }
const clocks = new Map<HTMLElement, Clock>();
let timer: ReturnType<typeof setInterval> | undefined;
function elapsed(container: HTMLElement, startedAt: number, endedAt?: number): HTMLElement {
	const label = node('span', '', 'rich-duration');
	clocks.set(container, { startedAt, endedAt, node: label });
	const tick = () => {
		for (const [container, clock] of clocks) {
			if (!container.isConnected) { clocks.delete(container); continue; }
			const seconds = Math.max(0, Math.floor(((clock.endedAt ?? Date.now()) - clock.startedAt) / 1000));
			clock.node.textContent = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
		}
		if (!clocks.size) { clearInterval(timer); timer = undefined; }
	};
	label.textContent = `${Math.max(0, Math.floor(((endedAt ?? Date.now()) - startedAt) / 1000))}s`;
	if (!timer) { timer = setInterval(tick, 1000); }
	return label;
}
function relationButton(target: ChatRelation | undefined, actions: RichViewActions): HTMLElement | undefined {
	return target ? button(target.toolId ? 'Related tool' : 'Related message', () => actions.reveal(target)) : undefined;
}
function actionButton(action: RichAction, actions: RichViewActions): HTMLButtonElement {
	return button(action.label, () => {
		if (action.kind === 'copy') { actions.copy(action.text); }
		else if (action.kind === 'reveal') { actions.reveal(action.target); }
		else { try { const url = new URL(action.url); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) { actions.openLink?.(url.href, false); } } catch { /* Invalid legacy data stays inert. */ } }
	});
}

export function updateRichEntry(element: HTMLElement, entry: Extract<ChatEntry, { kind: 'notice' | 'progress' | 'plan' | 'result' }>, actions: RichViewActions, snapshots: Readonly<Record<string, VisualizationSnapshot>>): void {
	element.className = `row rich-card rich-${entry.kind}`;
	copyActions.set(element, actions);
	if (entry.kind === 'notice') { element.classList.add(`notice-${entry.level ?? 'info'}`); element.setAttribute('role', entry.level === 'error' ? 'alert' : 'status'); }
	if (entry.id) { element.dataset.entryId = entry.id; }
	if (entry.kind === 'result') {
		let title = element.querySelector<HTMLElement>('.rich-title');
		if (!title) { title = node('h4', '', 'rich-title'); element.append(title, node('div', '', 'rich-results')); }
		title.textContent = entry.title;
		updateResultBlocks(element.querySelector<HTMLElement>('.rich-results')!, entry.blocks, actions, snapshots);
		return;
	}
	// Built in two parts, each replaced only when what it shows changes (#365):
	// a card updates while its buttons are pressed, and a replaced button loses
	// the click, the keyboard focus and any selection in the card.
	let body = element.querySelector<HTMLElement>(':scope > .rich-body'), controls = element.querySelector<HTMLElement>(':scope > .rich-actions');
	if (!body || !controls || element.firstElementChild !== body) { element.replaceChildren(); body = node('div', undefined, 'rich-body'); controls = node('div', undefined, 'rich-actions'); element.append(body, controls); }
	const bodyKey = JSON.stringify({ ...entry, cancel: undefined, cancelRequestedAt: undefined, actions: undefined, related: undefined, updatedAt: undefined });
	if (blockSignatures.get(body) !== bodyKey) { blockSignatures.set(body, bodyKey); clocks.delete(element); body.replaceChildren(...richBody(element, entry)); }
	else if (entry.kind === 'progress') { const clock = clocks.get(element); if (clock) { clock.endedAt = entry.endedAt; } }
	const controlsKey = JSON.stringify([entry.related, entry.kind === 'notice' ? entry.actions : undefined, entry.kind === 'progress' && entry.status === 'running' ? [entry.cancel, !!entry.cancelRequestedAt] : undefined]);
	if (blockSignatures.get(controls) !== controlsKey) {
		blockSignatures.set(controls, controlsKey);
		const buttons: HTMLElement[] = [];
		const related = relationButton(entry.related, actions); if (related) { buttons.push(related); }
		if (entry.kind === 'notice') { for (const action of entry.actions ?? []) { buttons.push(actionButton(action, actions)); } }
		if (entry.kind === 'progress' && entry.cancel && entry.status === 'running') { const id = entry.id; const cancel = button(entry.cancelRequestedAt ? 'Stopping…' : entry.cancel.agentId ? 'Stop agent' : 'Stop current turn', () => actions.cancel(id)); cancel.disabled = !!entry.cancelRequestedAt; buttons.push(cancel); }
		for (const control of buttons) { control.classList.add('soft-button'); }
		controls.replaceChildren(...buttons);
		controls.hidden = !buttons.length;
	}
}

/** A copy button shown on hover at the card's bottom right; copies through the host. */
function noticeCopyButton(text: string, card: HTMLElement): HTMLButtonElement {
	const copy = node('button', undefined, 'copy-button corner-copy');
	copy.type = 'button'; copy.title = 'Copy notice'; copy.setAttribute('aria-label', 'Copy notice');
	const glyph = (name: string) => node('span', undefined, `codicon codicon-${name}`);
	copy.append(glyph('copy'));
	copy.addEventListener('click', event => {
		event.preventDefault(); event.stopPropagation();
		const actions = copyActions.get(card); actions?.copy(text);
		copy.replaceChildren(glyph('check'));
		setTimeout(() => copy.replaceChildren(glyph('copy')), 1200);
	});
	return copy;
}
const copyActions = new WeakMap<HTMLElement, RichViewActions>();

function richBody(element: HTMLElement, entry: Extract<ChatEntry, { kind: 'notice' | 'progress' | 'plan' }>): HTMLElement[] {
	const parts: HTMLElement[] = [];
	if (entry.kind === 'notice') {
		parts.push(node('div', entry.text, 'rich-text'));
		if (entry.reason) { parts.push(node('p', entry.reason, 'rich-reason')); }
		// Only the notice's own words go to the clipboard — not its time or its buttons (asked for).
		parts.push(noticeCopyButton([entry.text, entry.reason].filter(Boolean).join('\n\n'), element));
		if (entry.at !== undefined) {
			const time = node('time', new Date(entry.at).toLocaleTimeString(), 'rich-notice-time');
			time.dateTime = new Date(entry.at).toISOString();
			parts.push(time);
		}
	} else if (entry.kind === 'progress') {
		const header = node('div', undefined, 'rich-header'); header.append(node('strong', entry.title), node('span', entry.status ?? 'running'), elapsed(element, entry.startedAt, entry.endedAt));
		parts.push(header);
		if (entry.stage) { parts.push(node('div', entry.stage, 'rich-stage')); }
		const progress = node('progress'); progress.max = 100; progress.setAttribute('aria-label', entry.title);
		if (typeof entry.percent === 'number') { progress.value = entry.percent; progress.setAttribute('aria-valuetext', `${entry.percent}%`); }
		if (entry.status === 'done') { progress.value = 100; }
		parts.push(progress);
		if (typeof entry.percent === 'number') { parts.push(node('span', `${entry.status === 'done' ? 100 : entry.percent}%`, 'rich-percent')); }
	} else {
		parts.push(node('h4', entry.title, 'rich-title'));
		const steps = node('ol', undefined, 'rich-plan-steps');
		for (const step of entry.steps) {
			const item = node('li', undefined, `plan-${step.status}`);
			if (step.status === 'inProgress') { item.setAttribute('aria-current', 'step'); }
			item.append(node('span', ({ pending: '○', inProgress: '◉', done: '✓', cancelled: '−' })[step.status], 'rich-step-status'), node('span', step.text), node('small', step.status));
			steps.append(item);
		}
		parts.push(steps);
	}
	return parts;
}

export function updateResultBlocks(container: HTMLElement, blocks: readonly ResultBlock[], actions: RichViewActions, snapshots: Readonly<Record<string, VisualizationSnapshot>>): void {
	const signature = JSON.stringify(blocks);
	if (snapshotsOf.get(container) !== signature) {
		snapshotsOf.set(container, signature);
		const previous = new Map(Array.from(container.children, child => [(child as HTMLElement).dataset.block, child as HTMLElement]));
		const ordered: HTMLElement[] = [];
		for (const [index, block] of blocks.entries()) {
			const blockSignature = JSON.stringify(block), existing = previous.get(String(index));
			if (existing && blockSignatures.get(existing) === blockSignature) { ordered.push(existing); continue; }
			const section = node('div', undefined, `rich-block rich-block-${block.type}`); section.dataset.block = String(index);
			blockSignatures.set(section, blockSignature);
			if (block.type === 'text') { section.append(node('pre', block.text)); }
			else if (block.type === 'json') { section.append(jsonView(block.value, actions.copy, block.title)); }
			else if (block.type === 'link' || block.type === 'file' && block.url) {
				const url = block.type === 'link' ? block.url : block.url!;
				const title = block.type === 'link' ? block.title : block.name;
				try {
					const parsed = new URL(url);
					if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) { const link = button(title || url, () => actions.openLink?.(parsed.href, false)); link.className = 'rich-link'; link.title = url; section.append(link, node('small', url)); }
					else { section.append(node('pre', url)); }
				} catch { section.append(node('pre', url)); }
			} else { section.classList.add('rich-block-attachment'); }
			ordered.push(section);
		}
		for (const [index, section] of ordered.entries()) { if (container.children[index] !== section) { container.insertBefore(section, container.children[index] ?? null); } }
		for (const child of Array.from(container.children)) { if (!ordered.includes(child as HTMLElement)) { child.remove(); } }
	}
	for (const [index, block] of blocks.entries()) {
		if ((block.type === 'image' || block.type === 'file') && block.ref) {
			const section = container.querySelector<HTMLElement>(`[data-block="${index}"]`)!;
			updateVisualizationViews(section, [block.ref], snapshots, actions);
		}
	}
}

const glyph = (name: string) => { const icon = node('span', undefined, `codicon codicon-${name}`); icon.setAttribute('aria-hidden', 'true'); return icon; };

/** A copy button that answers with a check for a moment; `label` is its tooltip and, unless `iconOnly`, its text. */
function copyButton(label: string, text: () => string, copy: (text: string) => void, className: string, iconOnly = false): HTMLButtonElement {
	const control = node('button', undefined, className);
	control.type = 'button'; control.title = label; control.setAttribute('aria-label', label);
	const icon = glyph('copy'); control.append(icon);
	if (!iconOnly) { control.append(node('span', label)); }
	let reset: ReturnType<typeof setTimeout> | undefined;
	control.addEventListener('click', event => {
		event.preventDefault(); event.stopPropagation(); copy(text());
		icon.className = 'codicon codicon-check'; control.classList.add('copied');
		clearTimeout(reset); reset = setTimeout(() => { icon.className = 'codicon codicon-copy'; control.classList.remove('copied'); }, 1200);
	});
	return control;
}

type JsonKind = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';
const jsonKind = (item: JsonValue): JsonKind => item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item as 'string' | 'number' | 'boolean' | 'object';
const jsonPreview = (item: JsonValue) => item === null ? 'null' : Array.isArray(item) ? `Array(${item.length})` : typeof item === 'object' ? `Object(${Object.keys(item).length})` : JSON.stringify(item);
const identifier = /^[A-Za-z_$][\w$]*$/;

/** Text with every case-insensitive occurrence of `query` wrapped in `<mark>`; never parsed as HTML. */
function highlighted(text: string, query: string, className: string): HTMLElement {
	const span = node('span', undefined, className);
	const lower = text.toLocaleLowerCase();
	// Lowering can change a string's length (İ), and offsets in it would then point elsewhere in the original.
	if (!query || lower.length !== text.length) { span.textContent = text; return span; }
	let at = 0;
	for (let found = lower.indexOf(query); found >= 0; found = lower.indexOf(query, at)) {
		span.append(text.slice(at, found), node('mark', text.slice(found, found + query.length)));
		at = found + query.length;
	}
	span.append(text.slice(at));
	return span;
}

/** Object children are built only when expanded; search traverses the bounded saved JSON value. */
export function jsonView(value: JsonValue, copy: (text: string) => void, title = 'JSON'): HTMLElement {
	const root = node('section', undefined, 'json-view');
	const head = node('div', undefined, 'rich-header json-header');
	head.append(node('strong', title, 'json-title'), copyButton('Copy JSON', () => JSON.stringify(value, null, 2), copy, 'json-copy-all'));
	const tree = node('div', undefined, 'json-tree'); const results = node('div', undefined, 'json-search-results'); results.hidden = true;
	const copyValue = (item: JsonValue) => copyButton('Copy value', () => JSON.stringify(item, null, 2), copy, 'json-copy', true);
	const keyNode = (key: string, index: boolean) => node('span', key, index ? 'json-key json-index' : 'json-key');
	const valueNode = (item: JsonValue) => node('span', jsonPreview(item), `json-value json-${jsonKind(item)}`);
	const branch = (key: string, item: JsonValue, depth: number, index: boolean): HTMLElement => {
		const row = node('div', undefined, 'json-node');
		if (item !== null && typeof item === 'object') {
			const details = node('details'); const summary = node('summary', undefined, 'json-line');
			summary.append(glyph('chevron-right'), keyNode(key, index), node('span', ':', 'json-colon'), valueNode(item), copyValue(item));
			const children = node('div', undefined, 'json-children'); let built = false;
			details.addEventListener('toggle', () => {
				if (!details.open || built) { return; } built = true;
				const array = Array.isArray(item);
				const entries = Object.entries(item); let offset = 0;
				const more = button('Load more', () => append()); more.className = 'soft-button json-more';
				const append = () => {
					more.remove();
					for (const [childKey, child] of entries.slice(offset, offset + 100)) { children.append(branch(childKey, child, depth + 1, array)); }
					offset += 100; if (offset < entries.length) { more.textContent = `Load more (${entries.length - offset} left)`; children.append(more); }
				};
				if (depth >= 50) { children.append(node('div', 'Nested too deep to show here — use Copy value to inspect it.', 'json-note')); } else { append(); }
			});
			details.append(summary, children); row.append(details);
		} else {
			const line = node('div', undefined, 'json-line');
			line.append(node('span', undefined, 'json-twistie'), keyNode(key, index), node('span', ':', 'json-colon'), valueNode(item), copyValue(item));
			row.append(line);
		}
		return row;
	};
	tree.append(branch('$', value, 0, false));
	const { field, input: search } = searchField('Search keys or values…', 'Search JSON', () => {
		const query = search.value.trim().toLocaleLowerCase(); results.replaceChildren(); results.hidden = !query; tree.hidden = !!query;
		if (!query) { return; }
		// Matched on a value's own key, not its path: every descendant of `nested` would otherwise match "nested".
		const stack: { path: string; key: string; value: JsonValue }[] = [{ path: '$', key: '$', value }]; let found = 0;
		const list = node('div', undefined, 'json-search-list');
		while (stack.length && found < 100) {
			const current = stack.pop()!;
			const leaf = current.value === null || typeof current.value !== 'object';
			if (current.key.toLocaleLowerCase().includes(query) || leaf && JSON.stringify(current.value).toLocaleLowerCase().includes(query)) {
				const item = node('div', undefined, 'json-line json-search-match');
				item.append(highlighted(current.path, query, 'json-key json-path'), node('span', ':', 'json-colon'), leaf ? highlighted(jsonPreview(current.value), query, `json-value json-${jsonKind(current.value)}`) : valueNode(current.value), copyValue(current.value));
				list.append(item); found++;
			}
			if (!leaf) {
				const array = Array.isArray(current.value);
				for (const [key, child] of Object.entries(current.value as object).reverse()) {
					const step = array ? `[${key}]` : identifier.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
					stack.push({ path: current.path + step, key, value: child as JsonValue });
				}
			}
		}
		const count = node('div', found === 100 ? 'Showing the first 100 matches' : found === 1 ? '1 match' : found ? `${found} matches` : 'No matches', 'json-search-count');
		count.setAttribute('role', 'status');
		results.append(count, list);
	});
	field.classList.add('json-search');
	root.append(head, field, tree, results); return root;
}

export function citationButton(citation: Citation, actions: RichViewActions): HTMLButtonElement {
	const control = button(`[${citation.label}]`, () => actions.citation(citation.target));
	control.className = 'citation-button'; control.title = citation.target.type === 'url' ? citation.target.url : citation.target.type === 'file' ? `${citation.target.path}${citation.target.line ? `:${citation.target.line}` : ''}` : `Message/tool ${citation.target.messageId ?? citation.target.toolId}`;
	control.setAttribute('aria-label', `Source ${citation.label}: ${control.title}`);
	return control;
}

/** Markers are inserted at validated source offsets before Markdown rendering, then become real controls. */
export function bindCitationMarkers(body: HTMLElement, citations: readonly Citation[], actions: RichViewActions): void {
	const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT); const texts: Text[] = [];
	while (walker.nextNode()) { if (walker.currentNode.textContent?.includes('\uE200citation:')) { texts.push(walker.currentNode as Text); } }
	for (const text of texts) {
		const fragment = document.createDocumentFragment(); let offset = 0;
		for (const match of text.data.matchAll(/\uE200citation:(\d+)\uE201/g)) {
			fragment.append(text.data.slice(offset, match.index));
			const citation = citations[Number(match[1])]; if (citation) { fragment.append(citationButton(citation, actions)); }
			offset = match.index! + match[0].length;
		}
		fragment.append(text.data.slice(offset)); text.replaceWith(fragment);
	}
}
