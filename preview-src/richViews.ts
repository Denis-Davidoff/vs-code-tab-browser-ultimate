import type { ChatEntry } from '../src/chat/chatProtocol';
import type { ResultBlock, JsonValue, ChatRelation, RichAction, CitationTarget, Citation } from '../src/chat/richProtocol';
import type { VisualizationSnapshot } from '../src/chat/visualizationProtocol';
import { updateVisualizationViews } from './visualizationViews';
import type { ArtifactActions } from './artifactViews';

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
		controls.replaceChildren(...buttons);
		controls.hidden = !buttons.length;
	}
}

function richBody(element: HTMLElement, entry: Extract<ChatEntry, { kind: 'notice' | 'progress' | 'plan' }>): HTMLElement[] {
	const parts: HTMLElement[] = [];
	if (entry.kind === 'notice') {
		if (entry.at !== undefined) {
			const header = node('div', undefined, 'rich-header');
			const time = node('time', new Date(entry.at).toLocaleTimeString()); time.dateTime = new Date(entry.at).toISOString(); header.append(time);
			parts.push(header);
		}
		parts.push(node('div', entry.text, 'rich-text'));
		if (entry.reason) { parts.push(node('p', entry.reason, 'rich-reason')); }
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
					if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) { section.append(button(title || url, () => actions.openLink?.(parsed.href, false)), node('small', url)); }
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

/** Object children are built only when expanded; search traverses the bounded saved JSON value. */
export function jsonView(value: JsonValue, copy: (text: string) => void, title = 'JSON'): HTMLElement {
	const root = node('section', undefined, 'json-view');
	const head = node('div', undefined, 'rich-header'); head.append(node('strong', title), button('Copy JSON', () => copy(JSON.stringify(value, null, 2))));
	const search = node('input'); search.type = 'search'; search.placeholder = 'Search keys or values…'; search.setAttribute('aria-label', 'Search JSON');
	const tree = node('div', undefined, 'json-tree'); const results = node('div', undefined, 'json-search-results'); results.hidden = true;
	const preview = (item: JsonValue) => item === null ? 'null' : Array.isArray(item) ? `Array(${item.length})` : typeof item === 'object' ? `Object(${Object.keys(item).length})` : JSON.stringify(item);
	const branch = (key: string, item: JsonValue, depth: number): HTMLElement => {
		const row = node('div', undefined, 'json-node');
		if (item !== null && typeof item === 'object') {
			const details = node('details'); const summary = node('summary'); summary.append(node('span', `${key}: `, 'json-key'), node('span', preview(item)));
			const children = node('div', undefined, 'json-children'); let built = false;
			details.addEventListener('toggle', () => {
				if (!details.open || built) { return; } built = true;
				const entries = Object.entries(item); let offset = 0;
				const more = button('Load more', () => append());
				const append = () => {
					more.remove();
					for (const [childKey, child] of entries.slice(offset, offset + 100)) { children.append(branch(childKey, child, depth + 1)); }
					offset += 100; if (offset < entries.length) { children.append(more); }
				};
				if (depth >= 50) { children.append(node('span', 'Expand this value with Copy value to inspect deeper nesting.')); } else { append(); }
			});
			row.append(details, button('Copy value', () => copy(JSON.stringify(item, null, 2)))); details.append(summary, children);
		} else {
			row.append(node('span', `${key}: `, 'json-key'), node('code', preview(item)), button('Copy value', () => copy(JSON.stringify(item, null, 2))));
		}
		return row;
	};
	tree.append(branch('$', value, 0));
	search.addEventListener('input', () => {
		const query = search.value.toLocaleLowerCase(); results.replaceChildren(); results.hidden = !query; tree.hidden = !!query;
		if (!query) { return; }
		const stack: { key: string; value: JsonValue }[] = [{ key: '$', value }]; let found = 0;
		while (stack.length && found < 100) {
			const current = stack.pop()!;
			if (current.key.toLocaleLowerCase().includes(query) || (current.value === null || typeof current.value !== 'object') && JSON.stringify(current.value).toLocaleLowerCase().includes(query)) {
				const item = node('div', undefined, 'json-search-match'); item.append(node('code', `${current.key}: ${preview(current.value)}`), button('Copy value', () => copy(JSON.stringify(current.value, null, 2)))); results.append(item); found++;
			}
			if (current.value !== null && typeof current.value === 'object') { for (const [key, value] of Object.entries(current.value).reverse()) { stack.push({ key: `${current.key}[${JSON.stringify(key)}]`, value }); } }
		}
		results.prepend(node('div', found === 100 ? 'First 100 matches' : `${found} matches`, 'json-search-count'));
	});
	root.append(head, search, tree, results); return root;
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
