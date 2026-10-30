import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule, ScriptTarget } from 'typescript';

// Where a popup lands (above, below, height limit) is `anchoredOverlay`'s, tested in
// overlayPosition.test.ts. This checks what `openAbove` itself still decides.
function openWith(anchorInStrip: boolean, form?: string) {
	const source = readFileSync('preview-src/chat.ts', 'utf8');
	const body = /function openAbove\([\s\S]*?\n\}/.exec(source)![0];
	const classes = (): { list: Set<string>; add(c: string): void; remove(c: string): void } => {
		const list = new Set<string>();
		return { list, add: (c: string) => list.add(c), remove: (c: string) => list.delete(c) };
	};
	const popup = { classList: classes() };
	const anchor = { classList: classes() };
	const strip = { contains: (node: unknown) => anchorInStrip && node === anchor };
	const calls: { closed?: unknown[]; shown?: unknown[] } = {};
	const open = runInNewContext(transpileModule(`${body}\nopenAbove;`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, {
		selectorStrip: strip, paramsPopup: {}, paramsFormAnchor: undefined,
		closePopups: (...args: unknown[]) => { calls.closed = args; },
		showAnchoredOverlay: (...args: unknown[]) => { calls.shown = args; },
	});
	popup.classList.add('repo-form');
	open(popup, anchor, 'left', undefined, form);
	return { popup, anchor, strip, calls };
}

test('a popup is placed against its anchor and the anchor is marked active', () => {
	const { popup, anchor, calls } = openWith(false);
	assert.deepEqual(calls.shown, [popup, anchor, 'left']);
	assert.ok(anchor.classList.list.has('active'));
	assert.ok(!popup.classList.list.has('repo-form'), 'a form class from an earlier opening is cleared');
});

test('a popup opened from the selector strip keeps the strip open', () => {
	const { popup, strip, calls } = openWith(true);
	assert.deepEqual(calls.closed, [popup, strip]);
});

test('a form class is applied when asked for', () => {
	const { popup } = openWith(false, 'repo-form');
	assert.ok(popup.classList.list.has('repo-form'));
});
