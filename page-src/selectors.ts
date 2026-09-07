/*---------------------------------------------------------------------------------------------
 *  Building readable, rebuild-proof paths for an element of the previewed page.
 *--------------------------------------------------------------------------------------------*/

import { PickedElement } from '../shared/protocol';
import { collectStyles, describeNode, elementRect, htmlPath, outerHtml } from './elementContext';

function escapeIdentifier(value: string): string {
	return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
		? CSS.escape(value)
		: value.replace(/[^\w-]/g, ch => `\\${ch}`);
}

function escapeAttributeValue(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function isPlainIdentifier(value: string): boolean {
	return /^[A-Za-z_][\w-]*$/.test(value);
}

/**
 * Filters out framework generated names such as `css-1a2b3c` or `Button_root__2Xk9f`,
 * which change on every build and make a selector useless.
 */
function looksGenerated(value: string): boolean {
	return value.length > 40
		|| /\d{5,}/.test(value)
		|| /(^|[-_])(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{5,}$/i.test(value);
}

function isUnique(root: Document | Element, selector: string): boolean {
	try {
		return root.querySelectorAll(selector).length === 1;
	} catch {
		return false;
	}
}

function stableClasses(element: Element): string[] {
	const result: string[] = [];
	for (const className of Array.prototype.slice.call(element.classList) as string[]) {
		if (isPlainIdentifier(className) && !looksGenerated(className)) {
			result.push(className);
		}
		if (result.length === 3) {
			break;
		}
	}
	return result;
}

/** Builds the selector for a single step of the path. */
function stepSelector(element: Element, preferredAttributes: readonly string[]): string {
	const tag = element.tagName.toLowerCase();

	for (const attribute of preferredAttributes) {
		const value = element.getAttribute(attribute);
		if (value) {
			const selector = `[${attribute}="${escapeAttributeValue(value)}"]`;
			if (isUnique(document, selector)) {
				return selector;
			}
			if (isUnique(document, tag + selector)) {
				return tag + selector;
			}
		}
	}

	const id = element.getAttribute('id');
	if (id && isPlainIdentifier(id) && !looksGenerated(id) && isUnique(document, `#${escapeIdentifier(id)}`)) {
		return `#${escapeIdentifier(id)}`;
	}

	const parent = element.parentElement;
	if (!parent) {
		return tag;
	}

	const sameTag = (Array.prototype.slice.call(parent.children) as Element[])
		.filter(child => child.tagName === element.tagName);
	if (sameTag.length === 1) {
		return tag;
	}

	const classes = stableClasses(element);
	if (classes.length) {
		const withClasses = tag + classes.map(name => `.${escapeIdentifier(name)}`).join('');
		const matching = sameTag.filter(child => classes.every(name => child.classList.contains(name)));
		if (matching.length === 1) {
			return withClasses;
		}
	}

	return `${tag}:nth-of-type(${sameTag.indexOf(element) + 1})`;
}

export function cssPath(element: Element, preferredAttributes: readonly string[]): string {
	const parts: string[] = [];
	let node: Element | null = element;

	while (node) {
		const step = stepSelector(node, preferredAttributes);
		parts.unshift(step);

		// An id or attribute selector is already an absolute anchor.
		if (step.startsWith('#') || step.includes('[')) {
			break;
		}
		if (isUnique(document, parts.join(' > '))) {
			break;
		}
		node = node.parentElement;
	}

	return parts.join(' > ');
}

export function xPath(element: Element): string {
	const parts: string[] = [];
	let node: Element | null = element;

	while (node) {
		const tag = node.tagName.toLowerCase();
		const id = node.getAttribute('id');
		if (id && !looksGenerated(id) && isUnique(document, `[id="${escapeAttributeValue(id)}"]`)) {
			parts.unshift(`*[@id="${id}"]`);
			return `//${parts.join('/')}`;
		}

		let index = 1;
		let siblings = 0;
		let sibling: Element | null = node.parentElement?.firstElementChild ?? null;
		for (; sibling; sibling = sibling.nextElementSibling) {
			if (sibling.tagName !== node.tagName) {
				continue;
			}
			siblings++;
			if (sibling === node) {
				index = siblings;
			}
		}

		parts.unshift(siblings > 1 ? `${tag}[${index}]` : tag);
		node = node.parentElement;
	}

	return `/${parts.join('/')}`;
}

export function describeElement(
	element: Element,
	preferredAttributes: readonly string[],
	documentUrl: string,
): PickedElement {
	const attributes: Record<string, string> = {};
	for (const name of ['id', 'name', 'type', 'role', 'href', 'aria-label', ...preferredAttributes]) {
		const value = element.getAttribute(name);
		if (value !== null) {
			attributes[name] = value;
		}
	}

	const text = (element as HTMLElement).innerText ?? element.textContent ?? '';
	const trimmed = text.replace(/\s+/g, ' ').trim();

	return {
		selector: cssPath(element, preferredAttributes),
		xpath: xPath(element),
		tagName: element.tagName.toLowerCase(),
		id: element.id || undefined,
		classes: Array.prototype.slice.call(element.classList),
		attributes,
		text: trimmed ? trimmed.slice(0, 120) : undefined,
		framePath: [],
		documentUrl,
		descriptor: describeNode(element),
		htmlPath: htmlPath(element),
		outerHtml: outerHtml(element),
		rect: elementRect(element),
		styles: collectStyles(element),
	};
}
