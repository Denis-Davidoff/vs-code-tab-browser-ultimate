/*---------------------------------------------------------------------------------------------
 *  Records the page's console output so the toolbar can copy it.
 *
 *  The webview cannot read the console of a cross-origin frame, so the only way to get at it
 *  is to patch `console` inside the page itself. This runs before any page script, because the
 *  proxy injects it right after `<head>`.
 *--------------------------------------------------------------------------------------------*/

import { ConsoleEntry, ConsoleLevel } from '../shared/protocol';

/** Entries kept before the oldest ones start falling off. */
const maxEntries = 1000;
/** Per-entry cap, so one dump of a huge object cannot fill the buffer. */
const maxEntryLength = 4000;
/** How deep object arguments are serialised. */
const maxDepth = 4;

const patchedLevels: readonly ConsoleLevel[] = ['log', 'info', 'warn', 'error', 'debug', 'trace'];

const entries: ConsoleEntry[] = [];
let dropped = 0;
let installed = false;

export function installConsoleCapture(): void {
	if (installed) {
		return;
	}
	installed = true;

	for (const level of patchedLevels) {
		const original = (console as unknown as Record<string, unknown>)[level];
		if (typeof original !== 'function') {
			continue;
		}
		const forward = original as (...args: unknown[]) => void;
		(console as unknown as Record<string, unknown>)[level] = function (this: unknown, ...args: unknown[]) {
			record(level, formatArguments(args));
			return forward.apply(this, args);
		};
	}

	const originalClear = console.clear;
	if (typeof originalClear === 'function') {
		console.clear = function (this: unknown, ...args: unknown[]) {
			entries.length = 0;
			dropped = 0;
			return (originalClear as (...a: unknown[]) => void).apply(this, args);
		};
	}

	// Uncaught failures never reach `console` as a call, but they are exactly what someone
	// copying the console is usually after.
	window.addEventListener('error', event => {
		const target = event.target as (Element & { src?: string; href?: string }) | null;
		if (target && target !== (window as unknown as Element) && target.tagName) {
			const url = target.src || target.href;
			record('error', `Failed to load ${target.tagName.toLowerCase()}${url ? `: ${url}` : ''}`);
			return;
		}
		const error = event.error;
		record(
			'error',
			event.message || String(error ?? 'Script error'),
			error instanceof Error ? error.stack : undefined);
	}, true);

	window.addEventListener('unhandledrejection', event => {
		const reason = (event as PromiseRejectionEvent).reason;
		record(
			'error',
			`Unhandled rejection: ${reason instanceof Error ? `${reason.name}: ${reason.message}` : formatValue(reason, 0)}`,
			reason instanceof Error ? reason.stack : undefined);
	});
}

function record(level: ConsoleLevel, text: string, stack?: string): void {
	entries.push({
		level,
		time: Date.now(),
		text: text.length > maxEntryLength ? `${text.slice(0, maxEntryLength)}… (truncated)` : text,
		stack,
	});
	while (entries.length > maxEntries) {
		entries.shift();
		dropped++;
	}
}

export function consoleSnapshot(): { readonly entries: readonly ConsoleEntry[]; readonly dropped: number } {
	return { entries: entries.slice(), dropped };
}

// -- formatting ------------------------------------------------------------------------------

/** Applies `%s`-style substitution the way devtools does, then joins the rest with spaces. */
function formatArguments(args: readonly unknown[]): string {
	if (!args.length) {
		return '';
	}

	const parts: string[] = [];
	let rest = args.slice(1);

	if (typeof args[0] === 'string' && /%[sdifoOjc%]/.test(args[0])) {
		let consumed = 0;
		const formatted = args[0].replace(/%([sdifoOjc%])/g, (match, kind: string) => {
			if (kind === '%') {
				return '%';
			}
			if (consumed >= rest.length) {
				return match;
			}
			const value = rest[consumed++];
			switch (kind) {
				case 'c':
					// A css directive; devtools styles the output, plain text drops it.
					return '';
				case 's':
					return typeof value === 'string' ? value : formatValue(value, 1);
				case 'd':
				case 'i':
					return String(typeof value === 'bigint' ? value : Math.trunc(Number(value)));
				case 'f':
					return String(Number(value));
				default:
					return formatValue(value, 1);
			}
		});
		parts.push(formatted);
		rest = rest.slice(consumed);
	} else {
		parts.push(formatValue(args[0], 0));
	}

	for (const value of rest) {
		parts.push(formatValue(value, 0));
	}

	return parts.join(' ');
}

function formatValue(value: unknown, depth: number, seen: Set<object> = new Set()): string {
	if (typeof value === 'string') {
		return depth === 0 ? value : JSON.stringify(value);
	}
	if (value === null) {
		return 'null';
	}
	if (value === undefined) {
		return 'undefined';
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	if (typeof value === 'bigint') {
		return `${value}n`;
	}
	if (typeof value === 'symbol') {
		return value.toString();
	}
	if (typeof value === 'function') {
		return `[Function: ${value.name || 'anonymous'}]`;
	}
	if (value instanceof Error) {
		return value.stack || `${value.name}: ${value.message}`;
	}
	if (typeof Node !== 'undefined' && value instanceof Node) {
		return formatNode(value);
	}

	const object = value as object;
	if (seen.has(object)) {
		return '[Circular]';
	}
	if (depth >= maxDepth) {
		return Array.isArray(value) ? '[Array]' : '[Object]';
	}

	seen.add(object);
	try {
		if (Array.isArray(value)) {
			const items = value.slice(0, 100).map(item => formatValue(item, depth + 1, seen));
			if (value.length > 100) {
				items.push(`… ${value.length - 100} more`);
			}
			return `[${items.join(', ')}]`;
		}
		if (value instanceof Map) {
			const items = Array.from(value.entries()).slice(0, 50)
				.map(([key, item]) => `${formatValue(key, depth + 1, seen)} => ${formatValue(item, depth + 1, seen)}`);
			return `Map(${value.size}) {${items.join(', ')}}`;
		}
		if (value instanceof Set) {
			const items = Array.from(value.values()).slice(0, 50)
				.map(item => formatValue(item, depth + 1, seen));
			return `Set(${value.size}) {${items.join(', ')}}`;
		}

		const name = object.constructor && object.constructor.name !== 'Object'
			? `${object.constructor.name} `
			: '';
		const keys = Object.keys(object).slice(0, 50);
		const items = keys.map(key =>
			`${key}: ${formatValue((object as Record<string, unknown>)[key], depth + 1, seen)}`);
		if (Object.keys(object).length > keys.length) {
			items.push('…');
		}
		return `${name}{${items.join(', ')}}`;
	} catch {
		return '[Unserializable]';
	} finally {
		seen.delete(object);
	}
}

function formatNode(node: Node): string {
	if (node instanceof Element) {
		const html = node.outerHTML ?? '';
		return html.length > 200 ? `${html.slice(0, 200)}…` : html;
	}
	return `${node.nodeName}(${(node.nodeValue ?? '').slice(0, 80)})`;
}
