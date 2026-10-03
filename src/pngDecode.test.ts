/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import * as zlib from 'node:zlib';
import { decodePng, rowsOf } from './pngDecode.ts';

/** A PNG whose rows cycle through all five filters, the way an encoder may mix them. */
function samplePng(width: number, height: number, channels = 4): { png: Buffer; raw: Buffer } {
	const bpp = channels;
	const stride = width * bpp;
	const raw = Buffer.alloc(height * stride);
	for (let i = 0; i < raw.length; i++) {
		raw[i] = (i * 31 + Math.floor(i / stride) * 17 + (i % 7) * 5) & 0xff;
	}
	const filtered = Buffer.alloc(height * (stride + 1));
	for (let y = 0; y < height; y++) {
		const type = y % 5;
		filtered[y * (stride + 1)] = type;
		for (let x = 0; x < stride; x++) {
			const v = raw[y * stride + x];
			const a = x >= bpp ? raw[y * stride + x - bpp] : 0;
			const b = y > 0 ? raw[(y - 1) * stride + x] : 0;
			const c = x >= bpp && y > 0 ? raw[(y - 1) * stride + x - bpp] : 0;
			const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
			const predictor = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][type];
			filtered[y * (stride + 1) + 1 + x] = (v - predictor) & 0xff;
		}
	}
	const chunk = (type: string, body: Buffer) => {
		const head = Buffer.alloc(8);
		head.writeUInt32BE(body.length, 0);
		head.write(type, 4, 'latin1');
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), body])), 0);
		return Buffer.concat([head, body, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = channels === 4 ? 6 : 2;
	const data = zlib.deflateSync(filtered);
	// Split across two IDAT chunks, which a reader has to concatenate.
	const half = Math.floor(data.length / 2);
	const png = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr), chunk('IDAT', data.subarray(0, half)), chunk('IDAT', data.subarray(half)), chunk('IEND', Buffer.alloc(0)),
	]);
	return { png, raw };
}

suite('decodePng', () => {

	for (const channels of [3, 4]) {
		test(`undoes every row filter (${channels} channels)`, async () => {
			const { png, raw } = samplePng(13, 37, channels);
			const image = await decodePng(png);
			assert.deepStrictEqual([image.width, image.height, image.channels, image.bitDepth], [13, 37, channels, 8]);
			assert.deepStrictEqual(image.data, raw);
		});
	}

	test('an image large enough to yield part-way decodes the same', async () => {
		const { png, raw } = samplePng(700, 1600);
		assert.deepStrictEqual((await decodePng(png)).data, raw);
	});

	test('something that is not a PNG is refused', async () => {
		await assert.rejects(decodePng(Buffer.from('not a png at all, just some text here')), /not a PNG/);
	});
});

suite('rowsOf', () => {

	test('bands are the rows they name, with nothing copied', async () => {
		const { png, raw } = samplePng(5, 20);
		const image = await decodePng(png);
		const band = rowsOf(image, 7, 6);
		assert.strictEqual(band.height, 6);
		assert.deepStrictEqual(band.data, raw.subarray(7 * 20, 13 * 20));
		assert.strictEqual(band.data.buffer, image.data.buffer);
	});

	test('a band running past the image is clipped to it', async () => {
		const image = await decodePng(samplePng(4, 10).png);
		assert.strictEqual(rowsOf(image, 6, 9).height, 4);
	});

	test('a band wholly outside the image is refused, not returned empty', async () => {
		const image = await decodePng(samplePng(4, 10).png);
		assert.throws(() => rowsOf(image, 10, 5), /outside/);
	});
});
