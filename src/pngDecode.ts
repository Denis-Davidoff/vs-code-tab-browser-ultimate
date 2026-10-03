/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promisify } from 'node:util';
import * as zlib from 'node:zlib';

const inflate = promisify(zlib.inflate);

/**
 * Decodes the PNG `Page.captureScreenshot` returns into raw rows. Leaf module, under test.
 *
 * It exists so a full page can be captured **once** and cut into frames here:
 * capturing each frame separately made the page lay itself out again per frame,
 * and a page that moves between captures came back as frames from different
 * moments. PNG is the format captured because it is the only one that can be
 * decoded without a dependency — `zlib` is in Node; the frames themselves go
 * out as JPEG (`jpegEncode.ts`).
 *
 * Only what Chromium writes is read: 8- or 16-bit greyscale, RGB, or either
 * with alpha, not interlaced. Anything else throws rather than guessing.
 *
 * **Asynchronous, and it yields.** A full-page capture is tens of megabytes
 * once inflated, and this runs on the extension host's only thread, where
 * every other tool call, the status bar and the other extensions in that host
 * wait behind it. `inflate` goes to the threadpool, and unfiltering hands the
 * thread back every few megabytes.
 */
export interface RawImage {
	width: number;
	height: number;
	/** Samples per pixel: 1 grey, 2 grey + alpha, 3 RGB, 4 RGBA. */
	channels: number;
	/** 8 or 16; a 16-bit sample is stored big-endian. */
	bitDepth: number;
	/** Rows top to bottom, `width * channels * bitDepth / 8` bytes each. */
	data: Buffer;
}

export async function decodePng(png: Buffer): Promise<RawImage> {
	if (png.length < 33 || !png.subarray(0, 8).equals(signature)) {
		throw new Error('The screenshot is not a PNG');
	}
	let width = 0, height = 0, bitDepth = 0, colorType = -1;
	const idat: Buffer[] = [];
	for (let at = 8; at + 8 <= png.length;) {
		const length = png.readUInt32BE(at);
		const type = png.toString('latin1', at + 4, at + 8);
		const body = png.subarray(at + 8, at + 8 + length);
		if (type === 'IHDR') {
			width = body.readUInt32BE(0);
			height = body.readUInt32BE(4);
			bitDepth = body[8];
			colorType = body[9];
			if (body[12] !== 0) {
				throw new Error('An interlaced screenshot PNG is not supported');
			}
		} else if (type === 'IDAT') {
			idat.push(body);
		} else if (type === 'IEND') {
			break;
		}
		at += 12 + length;
	}
	const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number | undefined>)[colorType];
	if (!width || !height || (bitDepth !== 8 && bitDepth !== 16) || !channels) {
		throw new Error('The screenshot PNG has a shape this does not read');
	}
	const bpp = (channels * bitDepth) / 8;
	const stride = width * bpp;
	const filtered = await inflate(Buffer.concat(idat));
	if (filtered.length < height * (stride + 1)) {
		throw new Error('The screenshot PNG is shorter than its header says');
	}
	return { width, height, channels, bitDepth, data: await unfilter(filtered, height, stride, bpp) };
}

/** The rows `top` to `top + height` of an image, as an image of their own. No copy. */
export function rowsOf(image: RawImage, top: number, height: number): RawImage {
	const stride = (image.width * image.channels * image.bitDepth) / 8;
	const from = Math.max(0, Math.min(image.height, Math.round(top)));
	const to = Math.max(from, Math.min(image.height, Math.round(top + height)));
	if (to === from) {
		throw new Error('A screenshot frame fell outside the captured image');
	}
	return { ...image, height: to - from, data: image.data.subarray(from * stride, to * stride) };
}

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Bytes unfiltered between yields of the thread. */
const yieldEveryBytes = 4 << 20;

/** The five PNG row filters, undone — the filter chosen once per row, not per byte. */
async function unfilter(filtered: Buffer, height: number, stride: number, bpp: number): Promise<Buffer> {
	const raw = Buffer.alloc(height * stride);
	let sinceYield = 0;
	for (let y = 0; y < height; y++) {
		const type = filtered[y * (stride + 1)];
		const src = y * (stride + 1) + 1;
		const row = y * stride;
		const up = row - stride;
		switch (type) {
			case 0:
				filtered.copy(raw, row, src, src + stride);
				break;
			case 1:
				for (let x = 0; x < stride; x++) {
					raw[row + x] = (filtered[src + x] + (x >= bpp ? raw[row + x - bpp] : 0)) & 0xff;
				}
				break;
			case 2:
				for (let x = 0; x < stride; x++) {
					raw[row + x] = (filtered[src + x] + (y > 0 ? raw[up + x] : 0)) & 0xff;
				}
				break;
			case 3:
				for (let x = 0; x < stride; x++) {
					const a = x >= bpp ? raw[row + x - bpp] : 0;
					const b = y > 0 ? raw[up + x] : 0;
					raw[row + x] = (filtered[src + x] + ((a + b) >> 1)) & 0xff;
				}
				break;
			case 4:
				for (let x = 0; x < stride; x++) {
					const a = x >= bpp ? raw[row + x - bpp] : 0;
					const b = y > 0 ? raw[up + x] : 0;
					const c = x >= bpp && y > 0 ? raw[up + x - bpp] : 0;
					const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
					raw[row + x] = (filtered[src + x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
				}
				break;
			default:
				throw new Error('The screenshot PNG uses an unknown row filter');
		}
		sinceYield += stride;
		if (sinceYield >= yieldEveryBytes) {
			sinceYield = 0;
			await new Promise(resolve => setImmediate(resolve));
		}
	}
	return raw;
}
