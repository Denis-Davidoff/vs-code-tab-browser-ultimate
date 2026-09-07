/*---------------------------------------------------------------------------------------------
 *  Carries out what the extension host asks of the page on behalf of an mcp client.
 *
 *  Everything here runs in the page's own world, so it sees the dom as it is now — after the
 *  framework has rendered it — which is the whole point of asking the page rather than fetching
 *  the url.
 *--------------------------------------------------------------------------------------------*/

import { PageRequest } from '../shared/protocol';
import { consoleSnapshot } from './consoleCapture';
import { cssPath, describeElement } from './selectors';

const defaultMaxLength = 20000;

export function handlePageRequest(
	request: PageRequest,
	documentUrl: string,
): unknown | Promise<unknown> {
	switch (request.type) {
		case 'snapshot':
			return snapshot(request.maxNodes ?? 200);

		case 'waitFor':
			return waitFor(request.selector, request.timeout ?? 10000);

		case 'console': {
			const snapshot = consoleSnapshot();
			const entries = request.level
				? snapshot.entries.filter(entry => entry.level === request.level)
				: snapshot.entries;
			const limit = Math.max(1, Math.min(request.limit ?? 100, 1000));
			return {
				entries: entries.slice(-limit),
				dropped: snapshot.dropped,
				documentUrl,
			};
		}

		case 'inspect':
			return describeElement(find(request.selector), [], documentUrl);

		case 'html': {
			const target = request.selector ? find(request.selector) : document.documentElement;
			return clamp(target.outerHTML ?? '', request.maxLength);
		}

		case 'text': {
			const target = request.selector ? find(request.selector) : document.body;
			const text = (target as HTMLElement).innerText ?? target.textContent ?? '';
			return clamp(text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), request.maxLength);
		}

		case 'click': {
			const target = find(request.selector) as HTMLElement;
			target.scrollIntoView({ block: 'center', inline: 'center' });
			target.click();
			return { clicked: describe(target) };
		}

		case 'fill': {
			const target = find(request.selector) as HTMLInputElement;
			if (!('value' in target)) {
				throw new Error(`${describe(target)} has no value to fill`);
			}
			target.focus();
			setValue(target, request.value);
			return { filled: describe(target), value: target.value };
		}
	}
}

/** Selectors of the things a page is operated through, in the order they appear. */
const interactiveSelector = 'a[href], button, input, select, textarea, summary, [role], '
	+ 'h1, h2, h3, [contenteditable="true"], [onclick], [tabindex]:not([tabindex="-1"])';

/**
 * A compact list of what is on the page and what can be done to it. An mcp client needs this
 * before it can act: it cannot see the screen, and the full html is both too long and mostly
 * markup that says nothing about what the page offers.
 */
function snapshot(maxNodes: number): unknown {
	const nodes: Record<string, string>[] = [];
	const seen = new Set<Element>();

	for (const element of Array.prototype.slice.call(
		document.querySelectorAll(interactiveSelector)) as Element[]) {
		if (nodes.length >= maxNodes) {
			break;
		}
		if (seen.has(element) || !isVisible(element)) {
			continue;
		}
		seen.add(element);

		const node: Record<string, string> = {
			role: roleOf(element),
			name: accessibleName(element),
			selector: cssPath(element, []),
		};
		const value = (element as HTMLInputElement).value;
		if (typeof value === 'string' && value && node.role !== 'button') {
			node.value = value.slice(0, 80);
		}
		if ((element as HTMLInputElement).disabled) {
			node.disabled = 'true';
		}
		nodes.push(node);
	}

	return {
		url: location.href,
		title: document.title,
		nodes,
		truncated: nodes.length >= maxNodes,
	};
}

function isVisible(element: Element): boolean {
	const rect = element.getBoundingClientRect();
	if (rect.width === 0 && rect.height === 0) {
		return false;
	}
	const style = getComputedStyle(element);
	return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
}

function roleOf(element: Element): string {
	const explicit = element.getAttribute('role');
	if (explicit) {
		return explicit;
	}
	const tag = element.tagName.toLowerCase();
	if (tag === 'a') {
		return 'link';
	}
	if (tag === 'input') {
		return `input:${(element as HTMLInputElement).type || 'text'}`;
	}
	return tag;
}

/** What a person would call this thing, in the order a screen reader would look for it. */
function accessibleName(element: Element): string {
	const labelled = element.getAttribute('aria-labelledby');
	const byId = labelled ? document.getElementById(labelled.split(/\s+/)[0]) : undefined;

	const candidates = [
		element.getAttribute('aria-label'),
		byId?.textContent,
		(element as HTMLInputElement).labels?.[0]?.textContent,
		element.getAttribute('placeholder'),
		element.getAttribute('title'),
		element.getAttribute('alt'),
		(element as HTMLElement).innerText ?? element.textContent,
		element.getAttribute('name'),
	];

	for (const candidate of candidates) {
		const name = candidate?.replace(/\s+/g, ' ').trim();
		if (name) {
			return name.slice(0, 120);
		}
	}
	return '';
}

/** Frameworks render when they get round to it, so a client has to be able to wait. */
function waitFor(selector: string, timeout: number): Promise<unknown> {
	const deadline = Date.now() + Math.max(0, Math.min(timeout, 30000));

	return new Promise((resolve, reject) => {
		const attempt = () => {
			let match: Element | null = null;
			try {
				match = document.querySelector(selector);
			} catch {
				reject(new Error(`Not a valid css selector: ${selector}`));
				return;
			}
			if (match) {
				resolve({ found: describe(match), selector: cssPath(match, []) });
				return;
			}
			if (Date.now() >= deadline) {
				reject(new Error(`Nothing matched ${selector} within ${timeout}ms`));
				return;
			}
			setTimeout(attempt, 100);
		};
		attempt();
	});
}

function find(selector: string): Element {
	let element: Element | null;
	try {
		element = document.querySelector(selector);
	} catch {
		throw new Error(`Not a valid css selector: ${selector}`);
	}
	if (!element) {
		throw new Error(`Nothing matches ${selector} on this page`);
	}
	return element;
}

function describe(element: Element): string {
	const id = element.id ? `#${element.id}` : '';
	return `${element.tagName.toLowerCase()}${id}`;
}

/**
 * Frameworks listen for the events a person typing would raise, and React goes further: it
 * tracks the last value it wrote, so setting `value` alone leaves its state untouched.
 */
function setValue(target: HTMLInputElement, value: string): void {
	const prototype = target instanceof HTMLTextAreaElement
		? HTMLTextAreaElement.prototype
		: HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

	if (setter) {
		setter.call(target, value);
	} else {
		target.value = value;
	}

	target.dispatchEvent(new Event('input', { bubbles: true }));
	target.dispatchEvent(new Event('change', { bubbles: true }));
}

function clamp(value: string, maxLength = defaultMaxLength): string {
	const limit = Math.max(1, Math.min(maxLength, 200000));
	return value.length > limit ? `${value.slice(0, limit)}\n… ${value.length - limit} more characters` : value;
}
