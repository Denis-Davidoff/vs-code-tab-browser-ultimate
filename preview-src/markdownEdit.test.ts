import * as assert from 'node:assert';
import { test } from 'node:test';
import { codeBlock, link, placeholderNames, splitPlaceholders, toggleInline, toggleLines, type TextEdit } from './markdownEdit.ts';

function apply(value: string, edit: TextEdit): { value: string; selected: string } {
	const next = value.slice(0, edit.start) + edit.text + value.slice(edit.end);
	return { value: next, selected: next.slice(edit.selectionStart, edit.selectionEnd) };
}

test('bold wraps the selection and selects the words inside', () => {
	const r = apply('make it bold now', toggleInline('make it bold now', 8, 12, '**', 'bold text'));
	assert.deepStrictEqual(r, { value: 'make it **bold** now', selected: 'bold' });
});

test('bold with nothing selected inserts a placeholder, selected', () => {
	const r = apply('ab', toggleInline('ab', 1, 1, '**', 'bold text'));
	assert.deepStrictEqual(r, { value: 'a**bold text**b', selected: 'bold text' });
});

test('bold again unwraps, whether the markers are outside or inside the selection', () => {
	const outside = apply('a **b** c', toggleInline('a **b** c', 4, 5, '**', 'x'));
	assert.deepStrictEqual(outside, { value: 'a b c', selected: 'b' });
	const inside = apply('a **b** c', toggleInline('a **b** c', 2, 7, '**', 'x'));
	assert.deepStrictEqual(inside, { value: 'a b c', selected: 'b' });
});

test('spaces at the edges of the selection stay outside the markers', () => {
	const r = apply('a bold b', toggleInline('a bold b', 1, 7, '_', 'x'));
	assert.deepStrictEqual(r, { value: 'a _bold_ b', selected: 'bold' });
});

test('a bullet list over several lines, and off again', () => {
	const text = 'one\ntwo\n\nthree';
	const on = apply(text, toggleLines(text, 0, text.length, 'bullet'));
	assert.strictEqual(on.value, '- one\n- two\n\n- three');
	const off = apply(on.value, toggleLines(on.value, 0, on.value.length, 'bullet'));
	assert.strictEqual(off.value, text);
});

test('numbered lines count from one and replace a bullet', () => {
	const text = '- a\n- b';
	assert.strictEqual(apply(text, toggleLines(text, 0, text.length, 'number')).value, '1. a\n2. b');
});

test('a task list item is not read as a plain bullet', () => {
	const text = '- [ ] a';
	assert.strictEqual(apply(text, toggleLines(text, 0, 0, 'bullet')).value, '- a');
	assert.strictEqual(apply(text, toggleLines(text, 0, 0, 'task')).value, 'a');
});

test('a heading on the caret line keeps the caret in its text', () => {
	const text = 'intro\ntitle\nend';
	const edit = toggleLines(text, 8, 8, 'heading');
	const r = apply(text, edit);
	assert.strictEqual(r.value, 'intro\n## title\nend');
	assert.strictEqual(edit.selectionStart, 11);
});

test('a quote on an empty line leaves the caret after the marker', () => {
	const edit = toggleLines('a\n\nb', 2, 2, 'quote');
	assert.deepStrictEqual(apply('a\n\nb', edit).value, 'a\n> \nb');
	assert.strictEqual(edit.selectionStart, 4);
});

test('a selection ending at a line break does not take in the next line', () => {
	const text = 'a\nb\nc';
	assert.strictEqual(apply(text, toggleLines(text, 0, 2, 'bullet')).value, '- a\nb\nc');
});

test('a code block fences the lines, longer than any run inside', () => {
	const text = 'x\nuse ``` here\ny';
	const r = apply(text, codeBlock(text, 3, 5));
	assert.strictEqual(r.value, 'x\n````\nuse ``` here\n````\ny');
	assert.strictEqual(r.selected, 'use ``` here');
});

test('an empty code block on its own lines, the caret inside', () => {
	const edit = codeBlock('ab', 1, 1);
	assert.strictEqual(apply('ab', edit).value, 'a\n```\n\n```\nb');
	assert.strictEqual(edit.selectionStart, 6);
});

test('a link selects what is left to type', () => {
	assert.deepStrictEqual(apply('see docs', link('see docs', 4, 8)), { value: 'see [docs](url)', selected: 'url' });
	assert.deepStrictEqual(apply('https://a.b', link('https://a.b', 0, 11)), { value: '[text](https://a.b)', selected: 'text' });
	assert.deepStrictEqual(apply('', link('', 0, 0)), { value: '[text](url)', selected: 'text' });
});

test('placeholders are named once each, by the rule the host fills them by', () => {
	assert.deepStrictEqual(placeholderNames('Review {{pr}} on {{ branch }}', 'again {{pr}} {{9bad}} {{a-b}}'), ['pr', 'branch', 'a-b']);
	assert.deepStrictEqual(splitPlaceholders('a {{x}} b'), [{ text: 'a ' }, { param: 'x', raw: '{{x}}' }, { text: ' b' }]);
});
