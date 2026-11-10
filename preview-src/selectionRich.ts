/**
 * A chat selection as Markdown and as HTML, for the clipboard.
 *
 * Two halves. `selectionTree` reads the live DOM under a Range into a small
 * tree — clipped to the range, hidden and decorative nodes (buttons, icon
 * glyphs, a badge's hidden `@N`) left out, a fully selected sent attachment
 * badge reduced to one `badge` node. `treeMarkdown` / `treeHtml` turn that tree
 * into text and need no DOM, so `npm test` covers them.
 *
 * The tree mirrors what `renderMarkdown` in chat.ts draws: `p`, `div.heading
 * level-N`, `div.code-block` (a `.code-lang` span and a `pre > code`), lists,
 * `blockquote`, `div.table-wrap > table`, `hr`, and inline `code`, `strong`,
 * `em`, `span.link[data-href]`, `br`.
 */

export type RichNode =
	| { kind: 'text'; text: string }
	| { kind: 'badge'; id: string; label: string }
	| { kind: 'el'; tag: string; cls: string[]; attrs: Record<string, string>; children: RichNode[] };

export interface RichTree {
	/** `block`: whole blocks; `inline`: part of one paragraph, item or cell; `plain`: inside code. */
	mode: 'block' | 'inline' | 'plain';
	nodes: RichNode[];
}

const blockTags = new Set(['p', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'thead', 'tbody', 'tr', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

function isBlock(node: RichNode): boolean {
	return node.kind === 'el' && (blockTags.has(node.tag) || node.tag === 'div' || node.children.some(isBlock));
}

function headingLevel(node: Extract<RichNode, { kind: 'el' }>): number | undefined {
	if (/^h[1-6]$/.test(node.tag)) { return Number(node.tag[1]); }
	if (!node.cls.includes('heading')) { return undefined; }
	const level = node.cls.map(c => /^level-([1-6])$/.exec(c)).find(Boolean);
	return level ? Number(level[1]) : 2;
}

function textOf(node: RichNode): string {
	if (node.kind === 'text') { return node.text; }
	if (node.kind === 'badge') { return node.label; }
	return node.children.map(textOf).join('');
}

function find(node: RichNode, test: (n: Extract<RichNode, { kind: 'el' }>) => boolean): Extract<RichNode, { kind: 'el' }> | undefined {
	if (node.kind !== 'el') { return undefined; }
	if (test(node)) { return node; }
	for (const child of node.children) {
		const found = find(child, test);
		if (found) { return found; }
	}
	return undefined;
}

function codeBlockParts(node: Extract<RichNode, { kind: 'el' }>): { lang: string; code: string } {
	const lang = find(node, n => n.cls.includes('code-lang'));
	const code = find(node, n => n.tag === 'pre') ?? find(node, n => n.tag === 'code') ?? node;
	const name = lang ? textOf(lang).trim() : '';
	return { lang: name === 'text' ? '' : name, code: textOf(code) };
}

/* ------------------------------------------------------------ Markdown */

export interface MarkdownOptions {
	/** How a sent attachment badge is written: the portable `[att:…|label]` tag. */
	badge: (id: string, label: string) => string;
}

function backticks(text: string, min: number): string {
	const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(m => m[0].length));
	return '`'.repeat(Math.max(min, longest + 1));
}

function inlineMd(nodes: RichNode[], o: MarkdownOptions): string {
	return nodes.map(n => inlineNodeMd(n, o)).join('');
}

function inlineNodeMd(node: RichNode, o: MarkdownOptions): string {
	if (node.kind === 'text') { return node.text; }
	if (node.kind === 'badge') { return o.badge(node.id, node.label); }
	switch (node.tag) {
		case 'br': return '\n';
		case 'code': {
			const text = textOf(node);
			if (!text) { return ''; }
			const fence = backticks(text, 1);
			const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
			return `${fence}${pad}${text}${pad}${fence}`;
		}
		case 'strong': case 'b': {
			const inner = inlineMd(node.children, o);
			return inner.trim() ? `**${inner}**` : inner;
		}
		case 'em': case 'i': {
			const inner = inlineMd(node.children, o);
			return inner.trim() ? `*${inner}*` : inner;
		}
	}
	const href = node.attrs['data-href'];
	if (href) {
		const text = inlineMd(node.children, o);
		return !text || text === href ? href : `[${text}](${/[\s()]/.test(href) ? `<${href}>` : href})`;
	}
	return inlineMd(node.children, o);
}

function blocksMd(nodes: RichNode[], o: MarkdownOptions): string[] {
	const out: string[] = [];
	let run: RichNode[] = [];
	const flush = () => {
		const text = inlineMd(run, o).replace(/^\n+|\n+$/g, '');
		if (text.trim()) { out.push(text); }
		run = [];
	};
	for (const node of nodes) {
		if (!isBlock(node)) { run.push(node); continue; }
		flush();
		const block = blockMd(node as Extract<RichNode, { kind: 'el' }>, o);
		if (block.trim()) { out.push(block); }
	}
	flush();
	return out;
}

function blockMd(node: Extract<RichNode, { kind: 'el' }>, o: MarkdownOptions): string {
	const level = headingLevel(node);
	if (level) { return `${'#'.repeat(level)} ${inlineMd(node.children, o).replace(/\n/g, ' ').trim()}`; }
	if (node.cls.includes('code-block') || node.tag === 'pre') {
		const { lang, code } = node.tag === 'pre' ? { lang: '', code: textOf(node) } : codeBlockParts(node);
		const fence = backticks(code, 3);
		return `${fence}${lang}\n${code.replace(/\n$/, '')}\n${fence}`;
	}
	switch (node.tag) {
		case 'p': return inlineMd(node.children, o).trim();
		case 'hr': return '---';
		case 'ul': case 'ol': return listMd(node, o);
		case 'li': return listMd({ ...node, tag: 'ul', children: [node] }, o);
		case 'blockquote':
			return blocksMd(node.children, o).join('\n\n').split('\n').map(line => line ? `> ${line}` : '>').join('\n');
		case 'table': return tableMd(node, o);
	}
	return blocksMd(node.children, o).join('\n\n');
}

function listMd(list: Extract<RichNode, { kind: 'el' }>, o: MarkdownOptions): string {
	const ordered = list.tag === 'ol';
	let number = Number(list.attrs.start) || 1;
	const lines: string[] = [];
	for (const item of list.children) {
		if (item.kind !== 'el' || item.tag !== 'li') {
			const text = inlineNodeMd(item, o).trim();
			if (text) { lines.push(text); }
			continue;
		}
		const marker = ordered ? `${number++}. ` : '- ';
		const indent = ' '.repeat(marker.length);
		const inline = item.children.filter(c => !isBlock(c));
		const nested = item.children.filter(isBlock);
		const head = inlineMd(inline, o).trim().split('\n').join(`\n${indent}`);
		lines.push(marker + head);
		for (const block of nested) {
			lines.push(blockMd(block as Extract<RichNode, { kind: 'el' }>, o).split('\n').map(line => line ? indent + line : line).join('\n'));
		}
	}
	return lines.join('\n');
}

function tableRows(table: RichNode): Extract<RichNode, { kind: 'el' }>[] {
	const rows: Extract<RichNode, { kind: 'el' }>[] = [];
	const walk = (node: RichNode) => {
		if (node.kind !== 'el') { return; }
		if (node.tag === 'tr') { rows.push(node); return; }
		node.children.forEach(walk);
	};
	walk(table);
	return rows;
}

function tableMd(node: Extract<RichNode, { kind: 'el' }>, o: MarkdownOptions): string {
	const rows = tableRows(node).map(row => row.children
		.filter((c): c is Extract<RichNode, { kind: 'el' }> => c.kind === 'el' && (c.tag === 'td' || c.tag === 'th'))
		.map(cell => inlineMd(cell.children, o).replace(/\n/g, ' ').replace(/\|/g, '\\|').trim()));
	if (!rows.length) { return ''; }
	const width = Math.max(...rows.map(r => r.length));
	const line = (cells: string[]) => `| ${[...cells, ...Array(width - cells.length).fill('')].join(' | ')} |`;
	return [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n');
}

export function treeMarkdown(tree: RichTree, o: MarkdownOptions): string {
	if (tree.mode === 'plain') { return tree.nodes.map(textOf).join(''); }
	if (tree.mode === 'inline') { return inlineMd(tree.nodes, o); }
	return blocksMd(tree.nodes, o).join('\n\n');
}

/* ---------------------------------------------------------------- HTML */

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Only addresses a click could open anyway; never `javascript:` or `command:`. */
function safeHref(href: string): string | undefined {
	return /^(https?|file):/i.test(href) ? href : undefined;
}

function nodeHtml(node: RichNode): string {
	if (node.kind === 'text') { return escapeHtml(node.text); }
	if (node.kind === 'badge') { return `<code>${escapeHtml(node.label)}</code>`; }
	const inner = () => node.children.map(nodeHtml).join('');
	const level = headingLevel(node);
	if (level) { return `<h${level}>${inner()}</h${level}>`; }
	if (node.cls.includes('code-block') || node.tag === 'pre') {
		const { lang, code } = node.tag === 'pre' ? { lang: '', code: textOf(node) } : codeBlockParts(node);
		const cls = /^[\w+#.-]+$/.test(lang) ? ` class="language-${escapeHtml(lang)}"` : '';
		return `<pre><code${cls}>${escapeHtml(code)}</code></pre>`;
	}
	const href = node.attrs['data-href'];
	if (href) {
		const safe = safeHref(href);
		return safe ? `<a href="${escapeHtml(safe)}">${inner()}</a>` : inner();
	}
	switch (node.tag) {
		case 'br': case 'hr': return `<${node.tag}>`;
		case 'p': case 'ul': case 'li': case 'blockquote': case 'code': case 'strong': case 'em':
		case 'table': case 'thead': case 'tbody': case 'tr': case 'th': case 'td':
			return `<${node.tag}>${inner()}</${node.tag}>`;
		case 'b': return `<strong>${inner()}</strong>`;
		case 'i': return `<em>${inner()}</em>`;
		case 'ol': {
			const start = Number(node.attrs.start);
			return `<ol${start > 1 ? ` start="${start}"` : ''}>${inner()}</ol>`;
		}
	}
	// Our own wrappers (rows, turns, spans) carry no meaning outside the chat.
	return node.children.some(isBlock) ? `<div>${inner()}</div>` : inner();
}

export function treeHtml(tree: RichTree): string {
	if (tree.mode === 'plain') { return `<pre><code>${escapeHtml(tree.nodes.map(textOf).join(''))}</code></pre>`; }
	return tree.nodes.map(nodeHtml).join('');
}

/** Did the selection carry anything Markdown says differently from the plain text? */
export function treeHasMarkup(tree: RichTree): boolean {
	const walk = (node: RichNode): boolean => node.kind === 'badge' || (node.kind === 'el' && (
		['code', 'strong', 'b', 'em', 'i', 'ul', 'ol', 'blockquote', 'pre', 'table', 'hr'].includes(node.tag) ||
		!!headingLevel(node) || node.cls.includes('code-block') || !!node.attrs['data-href'] || node.children.some(walk)));
	return tree.mode !== 'plain' && tree.nodes.some(walk);
}

/* ------------------------------------------------------------ the DOM half */

/** Never part of the text: controls, icon glyphs, a badge's hidden `@N` and brackets. */
const skipped = 'button, input, textarea, select, svg, canvas, iframe, .codicon, .theme-file-icon, .att-token-hide, .copy-button, .corner-copy, .message-copy, [aria-hidden="true"]';
const keptAttrs = ['start', 'data-href'];

/**
 * The selection under `range` as a tree. `null` when it is not inside `root`.
 * A sent badge whose label is wholly selected becomes one `badge` node; its id
 * is reported so the caller can ask the host to keep that attachment.
 */
export function selectionTree(range: Range, root: HTMLElement): { tree: RichTree; badgeIds: string[] } | undefined {
	const common = range.commonAncestorContainer;
	const commonEl = common.nodeType === 1 ? common as Element : common.parentElement;
	if (!commonEl || !root.contains(commonEl)) { return undefined; }
	// Wholly inside one sent badge (its title selected, say): no tree, so the caller's
	// `selectedAttachmentMarkers` decides whether the badge is copied as its marker.
	if (commonEl.closest('.sent-attachment[data-attachment-id]')) { return undefined; }
	const doc = root.ownerDocument;
	const badgeIds: string[] = [];

	// `display: contents` has no box of its own (a notice's body), yet its children are shown.
	const visible = (el: Element) => el.tagName === 'BR' || el.getClientRects().length > 0
		|| doc.defaultView?.getComputedStyle(el).display === 'contents';
	const walk = (node: Node): RichNode[] => {
		if (node.nodeType === 3) {
			if (!range.intersectsNode(node)) { return []; }
			let text = node.textContent ?? '';
			if (node === range.endContainer) { text = text.slice(0, range.endOffset); }
			if (node === range.startContainer) { text = text.slice(range.startOffset); }
			return text ? [{ kind: 'text', text }] : [];
		}
		if (node.nodeType !== 1) { return []; }
		const el = node as HTMLElement;
		if (!range.intersectsNode(el) || el.matches(skipped) || !visible(el)) { return []; }
		if (el.matches('.sent-attachment[data-attachment-id]')) {
			const label = doc.createRange();
			label.selectNodeContents(el.querySelector('.att-token-label') ?? el);
			if (range.compareBoundaryPoints(Range.START_TO_START, label) <= 0 && range.compareBoundaryPoints(Range.END_TO_END, label) >= 0) {
				badgeIds.push(el.dataset.attachmentId!);
				return [{ kind: 'badge', id: el.dataset.attachmentId!, label: el.dataset.attachmentLabel ?? label.toString() }];
			}
		}
		const attrs: Record<string, string> = {};
		for (const name of keptAttrs) {
			const value = el.getAttribute(name);
			if (value !== null) { attrs[name] = value; }
		}
		const children = [...el.childNodes].flatMap(walk);
		return [{ kind: 'el', tag: el.tagName.toLowerCase(), cls: [...el.classList], attrs, children }];
	};

	// Inside code, the selection is code: no fences, no backticks.
	if (commonEl.closest('pre, .code-block, code')) {
		return { tree: { mode: 'plain', nodes: [{ kind: 'text', text: range.toString() }] }, badgeIds };
	}
	// Part of one paragraph, heading, item or cell: inline formatting only.
	// Not when the selection spans blocks inside it (two items of a list nested in an item).
	const leaf = commonEl.closest('p, li, td, th, .heading, h1, h2, h3, h4, h5, h6');
	const container = commonEl.closest('ul, ol, table, tbody, thead, tr, blockquote, div');
	// Nor when it reaches into a block inside the item (from an item's text into its nested list).
	const spansBlock = !!leaf && [...leaf.querySelectorAll('ul, ol, p, pre, blockquote, table, div')].some(block => range.intersectsNode(block));
	if (leaf && root.contains(leaf) && !spansBlock && !(container && container !== leaf && leaf.contains(container))) {
		const start = doc.createRange();
		start.selectNodeContents(leaf);
		const whole = range.compareBoundaryPoints(Range.START_TO_START, start) <= 0 && range.compareBoundaryPoints(Range.END_TO_END, start) >= 0;
		if (!whole) {
			return { tree: { mode: 'inline', nodes: [...commonEl.childNodes].flatMap(walk) }, badgeIds };
		}
		return { tree: { mode: 'block', nodes: walk(leaf) }, badgeIds };
	}
	return { tree: { mode: 'block', nodes: commonEl === root ? [...root.childNodes].flatMap(walk) : walk(commonEl) }, badgeIds };
}
