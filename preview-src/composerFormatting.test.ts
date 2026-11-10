import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { composerLinks, composerListChecker, composerListContinues, composerListEdit, composerListItem } from './composerFormatting.ts';

function apply(value: string, key: 'Enter' | 'Tab', shift = false, start = value.length, end = start) {
	const edit = composerListEdit(value, start, end, key, shift);
	assert.ok(edit);
	return { value: value.slice(0, edit.start) + edit.text + value.slice(edit.end), start: edit.selectionStart, end: edit.selectionEnd };
}

test('Enter continues bullets and increments ordered lists while preserving delimiters', () => {
	for (const marker of ['-', '*', '+']) {
		assert.equal(apply(`${marker} item`, 'Enter').value, `${marker} item\n${marker} `);
	}
	assert.equal(apply('1. item', 'Enter').value, '1. item\n2. ');
	assert.equal(apply('1) a\n9) item', 'Enter').value, '1) a\n9) item\n10) ');
	assert.equal(apply('- before after', 'Enter', false, 8).value, '- before\n- after');
});

test('bare markers, prose, and indented lines do not trigger list editing on Enter', () => {
	for (const value of ['1', '1 ', '1 text', 'a', 'a ', 'a text', '2026 ', '10 ', '1.5 ', 'version 1 ', 'ordinary text',
		' 1. item', ' 1) item', ' a. item', ' a) item', '\t1. item', '  - item', '  2. ']) {
		assert.equal(composerListEdit(value, value.length, value.length, 'Enter'), undefined, value);
	}
});

test('empty list items exit instead of sending the message', () => {
	assert.equal(apply('- ', 'Enter').value, '');
	assert.equal(apply('1. a\n2. ', 'Enter').value, '1. a\n');
	assert.equal(composerListEdit('- item', 6, 6, 'Enter', true), undefined);
});

test('Tab and Shift+Tab change list nesting for one line or a selection without altering badges', () => {
	const value = '- [@1 file.ts]\n- next';
	const indented = apply(value, 'Tab', false, 0, value.length);
	assert.equal(indented.value, '  - [@1 file.ts]\n  - next');
	const restored = apply(indented.value, 'Tab', true, indented.start, indented.end);
	assert.equal(restored.value, value);
	assert.equal(apply('- item', 'Tab').value, '  - item');
	assert.equal(apply('- item', 'Tab', true).value, '- item');
	assert.equal(composerListEdit('text', 4, 4, 'Tab'), undefined);
});

test('list automation leaves fenced code blocks untouched', () => {
	for (const fence of ['```', '~~~']) {
		const value = `${fence}\n- flag`;
		assert.equal(composerListEdit(value, value.length, value.length, 'Enter'), undefined);
		assert.equal(composerListEdit(value, value.length, value.length, 'Tab'), undefined);
		const outside = `${fence}\ncode\n${fence}\n- item`;
		assert.equal(apply(outside, 'Enter').value, `${outside}\n- `);
	}
});

test('link detection keeps visible text and positions while normalizing single-slash and www addresses', () => {
	const text = 'See https:/google.com and www.example.com/path plus http://localhost:3000/test.';
	const links = composerLinks(text);
	assert.deepEqual(links.map(link => link.url), ['https://google.com/', 'https://www.example.com/path', 'http://localhost:3000/test']);
	for (const link of links) { assert.equal(text.slice(link.start, link.end), link.text); }
});

test('links exclude prose punctuation and unmatched brackets while keeping balanced URL characters', () => {
	const links = composerLinks('(https://example.com/a(b)). [https://example.com?q=[a]], https://example.com/end!');
	assert.deepEqual(links.map(link => link.text), ['https://example.com/a(b)', 'https://example.com?q=[a]', 'https://example.com/end']);
	assert.deepEqual(composerLinks('javascript:alert(1) file:///tmp/a https://'), []);
});

test('letter lists continue with the next letter and keep their case', () => {
	const v = 'a. one';
	assert.equal(composerListEdit(v, v.length, v.length, 'Enter')?.text, '\nb. ');
	const u = 'A) one\nB) two';
	assert.equal(composerListEdit(u, u.length, u.length, 'Enter')?.text, '\nC) ');
	assert.equal(composerListItem('a.b'), undefined);
});

test('nested items made by Tab keep continuing; a line typed with leading space does not start a list', () => {
	const nested = '1. a\n  - b';
	assert.equal(composerListEdit(nested, nested.length, nested.length, 'Enter')?.text, '\n  - ');
	const deep = '- a\n  - b\n    1. c';
	assert.equal(composerListEdit(deep, deep.length, deep.length, 'Enter')?.text, '\n    2. ');
	for (const v of ['  - b', 'text\n  - b', ' 1. x', 'a\n\n  a) y']) {
		assert.equal(composerListEdit(v, v.length, v.length, 'Enter'), undefined, v);
	}
});

test('an ordered list starts only at 1 or a; later numbers and letters only continue a list', () => {
	for (const value of ['2. item', '3) item', 'b. item', 'C) item', 'text\n2. item', '1. a\n- b\n2. c', '1. a\nb. c', '1. a\n2) b',
		'a. x\nB. y', '- a\n  2. b', '3. x\n4. y']) {
		assert.equal(composerListEdit(value, value.length, value.length, 'Enter'), undefined, value);
	}
	assert.equal(apply('1. a\n\n2. b', 'Enter').value, '1. a\n\n2. b\n3. ');
	assert.equal(apply('1. a\n  - x\n  - y\n2. b', 'Enter').value, '1. a\n  - x\n  - y\n2. b\n3. ');
	assert.equal(apply('a. one\nb. two', 'Enter').value, 'a. one\nb. two\nc. ');
	assert.equal(composerListContinues([], composerListItem('1. x')!), true);
	assert.equal(composerListContinues([], composerListItem('a) x')!), true);
	assert.equal(composerListContinues(['1. x'], composerListItem('2. y')!), true);
	assert.equal(composerListContinues([], composerListItem('2. y')!), false);
});

test('the shared checker answers as composerListContinues does, and a long list stays linear', () => {
	const samples = ['1. a', '2. b', '  a) x', '  b) y', '', '3. c', 'text', '4. d', '2. e', '  1. n', '  3. m', '5. f', '- dot', '6. g'];
	const check = composerListChecker(samples);
	samples.forEach((line, index) => {
		const item = composerListItem(line);
		if (item) { assert.equal(check(index, item), composerListContinues(samples.slice(0, index), item), line); }
	});
	const long = Array.from({ length: 5000 }, (_, i) => `${i + 1}. item`);
	const started = Date.now();
	const checkLong = composerListChecker(long);
	long.forEach((line, index) => assert.equal(checkLong(index, composerListItem(line)!), true));
	assert.ok(Date.now() - started < 500, 'a 5 000-item list is checked in well under a second');
	assert.equal(composerListContinues(long.slice(0, -1), composerListItem(long[long.length - 1])!), true);
});

test('Tab renumbers a moved ordered item: a nested list restarts, an outdented item continues its list', () => {
	const nested = apply('1. a\n2. b', 'Tab');
	assert.equal(nested.value, '1. a\n  1. b');
	assert.equal(nested.start, nested.value.length);
	assert.equal(apply(nested.value, 'Enter').value, '1. a\n  1. b\n  2. ');
	assert.equal(apply('1. a\n  1. x\n2. b', 'Tab').value, '1. a\n  1. x\n  2. b');
	assert.equal(apply('1. a\n2. b\n  1. c', 'Tab', true).value, '1. a\n2. b\n3. c');
	assert.equal(apply('a) one\nb) two', 'Tab').value, 'a) one\n  a) two');
	assert.equal(apply('- a\n- b', 'Tab').value, '- a\n  - b');
});
