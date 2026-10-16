/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { encodeJpeg, optimalTable } from './jpegEncode.ts';

// Pixel accuracy is checked end to end against Chrome's decoder (see CLAUDE.md,
// "Copy Screenshot"); there is no JPEG decoder here to check it with. These pin
// the container, which is where a hand-written encoder breaks first.

function image(width: number, height: number, channels: number, fill: (x: number, y: number, c: number) => number) {
	const data = new Uint8Array(width * height * channels);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			for (let c = 0; c < channels; c++) {
				data[(y * width + x) * channels + c] = fill(x, y, c);
			}
		}
	}
	return { width, height, channels, bitDepth: 8, data };
}

/** Marker segments up to SOS, then the entropy-coded data and what ends it. */
function parse(jpeg: Buffer) {
	assert.strictEqual(jpeg.readUInt16BE(0), 0xffd8, 'starts with SOI');
	const markers: number[] = [];
	let at = 2, sof: { height: number; width: number; components: number } | undefined;
	for (;;) {
		const marker = jpeg.readUInt16BE(at);
		const length = jpeg.readUInt16BE(at + 2);
		markers.push(marker);
		if (marker === 0xffc0) {
			sof = { height: jpeg.readUInt16BE(at + 5), width: jpeg.readUInt16BE(at + 7), components: jpeg[at + 9] };
		}
		at += 2 + length;
		if (marker === 0xffda) {
			break;
		}
	}
	return { markers, sof, entropy: jpeg.subarray(at, jpeg.length - 2), end: jpeg.readUInt16BE(jpeg.length - 2) };
}

suite('encodeJpeg', () => {

	test('the container is baseline JFIF with the image size', () => {
		const { markers, sof, end } = parse(encodeJpeg(image(37, 21, 4, (x, y, c) => (x * 7 + y * 3 + c * 50) & 0xff), 100));
		assert.deepStrictEqual(markers, [0xffe0, 0xffdb, 0xffc0, 0xffc4, 0xffda]);
		assert.deepStrictEqual(sof, { height: 21, width: 37, components: 3 });
		assert.strictEqual(end, 0xffd9, 'ends with EOI');
	});

	test('every 0xFF in the entropy data is stuffed, so no marker appears inside it', () => {
		const { entropy } = parse(encodeJpeg(image(64, 64, 3, () => Math.random() * 256), 100));
		for (let i = 0; i < entropy.length; i++) {
			if (entropy[i] === 0xff) {
				assert.strictEqual(entropy[i + 1], 0x00, `0xFF at ${i} is followed by ${entropy[i + 1]}`);
			}
		}
	});

	test('it is deterministic, and quality only trades bytes', () => {
		const picture = image(48, 48, 3, (x, y, c) => ((x ^ y) * (c + 1) * 9) & 0xff);
		assert.deepStrictEqual(encodeJpeg(picture, 100), encodeJpeg(picture, 100));
		assert.ok(encodeJpeg(picture, 50).length < encodeJpeg(picture, 100).length);
	});

	test('a flat image is tiny, and grey or 16-bit input is accepted', () => {
		// 1024 MCUs of a zero DC difference and an end-of-block each: about 14 bits apiece.
		assert.ok(encodeJpeg(image(256, 256, 3, () => 200), 100).length < 3000);
		assert.ok(encodeJpeg(image(9, 9, 1, (x) => x * 20), 100).length > 0);
		assert.ok(encodeJpeg({ ...image(9, 9, 6, (x) => x * 20), channels: 3, bitDepth: 16 }, 100).length > 0);
	});

	test('a size JPEG cannot hold is refused', () => {
		assert.throws(() => encodeJpeg({ width: 0, height: 5, channels: 3, bitDepth: 8, data: new Uint8Array(0) }, 90), /65535/);
	});
});

suite('optimalTable', () => {

	/**
	 * Kraft: below 1, so the lengths make a prefix code with the all-ones code
	 * of the longest length left unused — the reserved symbol's slot, whatever
	 * length it landed at.
	 */
	function check(freq: Float64Array) {
		const { counts, symbols } = optimalTable(freq);
		assert.strictEqual(counts.length, 16, 'never longer than 16 bits');
		assert.strictEqual(counts.reduce((a, b) => a + b, 0), symbols.length, 'counts agree with symbols');
		const used = Array.from(freq.keys()).filter(i => i < 256 && freq[i] > 0).sort((a, b) => a - b);
		assert.deepStrictEqual([...symbols].sort((a, b) => a - b), used, 'every used symbol has a code');
		const kraft = counts.reduce((sum, n, i) => sum + n * 2 ** -(i + 1), 0);
		const longest = counts.reduce((deepest, n, i) => (n > 0 ? i + 1 : deepest), 0);
		assert.ok(kraft < 1, `kraft ${kraft}`);
		assert.strictEqual(kraft + 2 ** -longest <= 1, true, 'the all-ones code is free');
	}

	test('an ordinary distribution', () => {
		const freq = new Float64Array(257);
		for (let i = 0; i < 162; i++) {
			freq[i] = 1 + ((i * 37) % 101);
		}
		check(freq);
	});

	test('a Fibonacci distribution, whose natural tree is far deeper than 32', () => {
		const freq = new Float64Array(257);
		let a = 1, b = 1;
		for (let i = 0; i < 60; i++) {
			freq[i] = a;
			[a, b] = [b, a + b];
		}
		check(freq);
	});

	test('a single symbol', () => {
		const freq = new Float64Array(257);
		freq[0] = 1000;
		check(freq);
	});
});
