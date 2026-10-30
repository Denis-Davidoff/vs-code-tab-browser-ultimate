import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { composerLinks, composerListEdit, composerListStarter } from './composerFormatting.ts';

function apply(value: string, key: 'Enter' | 'Tab', shift = false, start = value.length, end = start) {
	const edit = composerListEdit(value, start, end, key, shift);
	assert.ok(edit);
	return { value: value.slice(0, edit.start) + edit.text + value.slice(edit.end), start: edit.selectionStart, end: edit.selectionEnd };
}

test('Enter continues bullets and increments ordered lists while preserving nesting and delimiters', () => {
	for (const marker of ['-', '*', '+']) {
		assert.equal(apply(`${marker} item`, 'Enter').value, `${marker} item\n${marker} `);
		assert.equal(apply(`  ${marker} item`, 'Enter').value, `  ${marker} item\n  ${marker} `);
	}
	assert.equal(apply('1. item', 'Enter').value, '1. item\n2. ');
	assert.equal(apply('  9) item', 'Enter').value, '  9) item\n  10) ');
	assert.equal(apply('\t1. item', 'Enter').value, '\t1. item\n\t2. ');
	assert.equal(apply('- before after', 'Enter', false, 8).value, '- before\n- after');
});

test('bare 1 starts a list, ordinary numbers and decimal values stay prose', () => {
	assert.equal(apply('1', 'Enter').value, '1. ');
	assert.equal(composerListStarter('1 ', 2)?.text, '. ');
	assert.equal(composerListStarter('  1 ', 4)?.selectionStart, 5);
	for (const value of ['2026 ', '10 ', '1.5 ', 'version 1 ', '1. ']) {
		assert.equal(composerListStarter(value, value.length), undefined);
	}
	assert.equal(composerListEdit('ordinary text', 13, 13, 'Enter'), undefined);
});

test('empty list items exit or outdent instead of sending the message', () => {
	assert.equal(apply('- ', 'Enter').value, '');
	assert.equal(apply('2. ', 'Enter').value, '');
	assert.equal(apply('  - ', 'Enter').value, '- ');
	assert.equal(apply('    3. ', 'Enter').value, '  3. ');
	assert.equal(apply('1. parent\n  1. child\n  2. ', 'Enter').value, '1. parent\n  1. child\n2. ');
	assert.equal(apply('- parent\n  1. ', 'Enter').value, '- parent\n- ');
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
		const starter = `${fence}\n1 `;
		assert.equal(composerListStarter(starter, starter.length), undefined);
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
