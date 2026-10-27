import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
	cellAt, dragRows, keyBarVisible, parseFontPref, parseKeyBarPref, parseKeyboardPref, pinchFontSize, selectionSpan, visibleFrame, wordRange,
} from './terminalTouch.ts';

const rect = { left: 10, top: 20, width: 800, height: 400 };

test('the cell under a finger is a cols-th of the width and a rows-th of the height', () => {
	// 80 columns of 10 px, 20 rows of 20 px.
	assert.deepEqual(cellAt(rect, 80, 20, 10, 20), { col: 0, row: 0 });
	assert.deepEqual(cellAt(rect, 80, 20, 19, 39), { col: 0, row: 0 });
	assert.deepEqual(cellAt(rect, 80, 20, 20, 40), { col: 1, row: 1 });
	assert.deepEqual(cellAt(rect, 80, 20, 409, 219), { col: 39, row: 9 });
});

test('a finger past the edge names the edge cell, and an empty screen names the origin', () => {
	assert.deepEqual(cellAt(rect, 80, 20, -50, -50), { col: 0, row: 0 });
	assert.deepEqual(cellAt(rect, 80, 20, 5000, 5000), { col: 79, row: 19 });
	assert.deepEqual(cellAt({ left: 0, top: 0, width: 0, height: 0 }, 80, 20, 5, 5), { col: 0, row: 0 });
	assert.deepEqual(cellAt(rect, 0, 0, 100, 100), { col: 0, row: 0 });
});

test('a word is the run of non-space characters, without the punctuation around it', () => {
	const line = 'cd ./src/chat/chatView.ts, then (see "foo(bar)") now.';
	assert.deepEqual(wordRange(line, 0), [0, 2]);
	assert.deepEqual(wordRange(line, 4), [3, 22], 'a path stays whole; the comma is not part of it');
	assert.equal(line.slice(3, 25), './src/chat/chatView.ts');
	const open = line.indexOf('(see');
	assert.deepEqual(wordRange(line, open + 2), [open + 1, 3], 'the opening bracket is trimmed');
	const quoted = line.indexOf('"foo');
	const range = wordRange(line, quoted + 3)!;
	assert.equal(line.slice(range[0], range[0] + range[1]), 'foo(bar)', 'a balanced bracket pair stays');
	const last = line.indexOf('now.');
	const lastRange = wordRange(line, last + 3)!;
	assert.equal(line.slice(lastRange[0], lastRange[0] + lastRange[1]), 'now');
});

test('a space, or a column past the line, is no word; a URL is one', () => {
	assert.equal(wordRange('a b', 1), undefined);
	assert.equal(wordRange('a b', 5), undefined);
	assert.equal(wordRange('a b', -1), undefined);
	assert.equal(wordRange('("")', 1), undefined, 'nothing but punctuation');
	const line = 'open https://example.com/a?b=1&c=2#x now';
	const range = wordRange(line, 12)!;
	assert.equal(line.slice(range[0], range[0] + range[1]), 'https://example.com/a?b=1&c=2#x');
});

test('a selection between two cells counts cells across rows, whichever end came first', () => {
	assert.deepEqual(selectionSpan({ col: 5, row: 2 }, { col: 9, row: 2 }, 80, 100), { col: 5, row: 102, length: 5 });
	assert.deepEqual(selectionSpan({ col: 9, row: 2 }, { col: 5, row: 2 }, 80, 100), { col: 5, row: 102, length: 5 }, 'dragged backwards');
	assert.deepEqual(selectionSpan({ col: 70, row: 1 }, { col: 4, row: 3 }, 80, 0), { col: 70, row: 1, length: 2 * 80 + (4 - 70) + 1 });
	assert.deepEqual(selectionSpan({ col: 4, row: 3 }, { col: 70, row: 1 }, 80, 0), { col: 70, row: 1, length: 2 * 80 + (4 - 70) + 1 }, 'the same span from the other end');
	assert.equal(selectionSpan({ col: 3, row: 0 }, { col: 3, row: 0 }, 80, 0).length, 1, 'one cell');
});

test('pinching scales the font size and keeps it in range', () => {
	assert.equal(pinchFontSize(14, 100, 100), 14);
	assert.equal(pinchFontSize(14, 100, 150), 21);
	assert.equal(pinchFontSize(14, 100, 50), 8, 'at the floor');
	assert.equal(pinchFontSize(14, 100, 1000), 28, 'at the ceiling');
	assert.equal(pinchFontSize(14, 100, 120), 17, 'rounded');
	assert.equal(pinchFontSize(14, 0, 120), 14, 'no start distance, no change');
	assert.equal(pinchFontSize(40, 0, 120), 28, 'a base out of range is brought in');
	assert.equal(pinchFontSize(14, 100, 200, 10, 20), 20, 'the range is a parameter');
});

test('a vertical drag is whole rows with the rest carried', () => {
	assert.deepEqual(dragRows(25, 10, 0), { rows: 2, carry: 5 });
	assert.deepEqual(dragRows(7, 10, 5), { rows: 1, carry: 2 });
	assert.deepEqual(dragRows(-25, 10, 0), { rows: -2, carry: -5 });
	assert.deepEqual(dragRows(3, 10, 0), { rows: 0, carry: 3 });
	assert.deepEqual(dragRows(-3, 10, 8), { rows: 0, carry: 5 });
	assert.deepEqual(dragRows(100, 0, 4), { rows: 0, carry: 4 }, 'no cell height, no rows');
	// Summed over many small moves, nothing is lost.
	let carry = 0;
	let total = 0;
	for (let i = 0; i < 100; i++) { const r = dragRows(3, 10, carry); carry = r.carry; total += r.rows; }
	assert.equal(total, 30);
	assert.ok(Math.abs(carry) < 1e-9);
});

test('the visible frame is the visual viewport, whole pixels, never negative', () => {
	assert.deepEqual(visibleFrame({ offsetLeft: 0, offsetTop: 0, width: 390, height: 500.4 }), { top: 0, left: 0, width: 390, height: 500 });
	assert.deepEqual(visibleFrame({ offsetLeft: 3.6, offsetTop: 120.2, width: 389.5, height: 380 }), { top: 120, left: 4, width: 390, height: 380 });
	assert.deepEqual(visibleFrame({ offsetLeft: -2, offsetTop: -8, width: 100, height: 100 }), { top: 0, left: 0, width: 100, height: 100 });
});

test('stored preferences are read strictly and fall back to a default', () => {
	assert.equal(parseKeyBarPref('on'), 'on');
	assert.equal(parseKeyBarPref('off'), 'off');
	assert.equal(parseKeyBarPref('auto'), 'auto');
	assert.equal(parseKeyBarPref('yes'), 'auto');
	assert.equal(parseKeyBarPref(null), 'auto');
	assert.equal(parseFontPref('16'), 16);
	assert.equal(parseFontPref('16.4'), 16);
	assert.equal(parseFontPref('7'), undefined, 'below the range');
	assert.equal(parseFontPref('29'), undefined, 'above the range');
	assert.equal(parseFontPref('abc'), undefined);
	assert.equal(parseFontPref('1e1'), undefined);
	assert.equal(parseFontPref('-14'), undefined);
	assert.equal(parseFontPref(null), undefined);
	assert.equal(parseKeyboardPref('hidden'), false);
	assert.equal(parseKeyboardPref('shown'), true);
	assert.equal(parseKeyboardPref(null), true);
});

test('the key bar shows on a coarse pointer or when forced, only in front and only where input is allowed', () => {
	assert.equal(keyBarVisible('auto', true, true, true), true);
	assert.equal(keyBarVisible('auto', false, true, true), false, 'a narrow desktop window has a keyboard');
	assert.equal(keyBarVisible('on', false, true, true), true);
	assert.equal(keyBarVisible('off', true, true, true), false);
	assert.equal(keyBarVisible('on', true, false, true), false, 'no input, no bar');
	assert.equal(keyBarVisible('on', true, true, false), false, 'no terminal in front');
});
