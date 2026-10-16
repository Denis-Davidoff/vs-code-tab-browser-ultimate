/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A baseline JPEG encoder, for the frames of a full-page screenshot. Leaf module, under test.
 *
 * Why it exists: a full page is captured once, as PNG, and cut into frames
 * here (see `pngDecode.ts`). Handed on as PNG the frames were tiny for an
 * interface and enormous for photographs — measured at about 3.2 MB a frame on
 * the worst case, 25 MB of base64 for one full page, most of the 32 MB a whole
 * conversation may carry. JPEG bounds that, and there is no dependency to do it
 * with, so this is the standard algorithm written out.
 *
 * It does what Chromium's own encoder does, because that is the size the
 * viewport capture next to it already produces: JFIF, **4:2:0** chroma (four
 * luma blocks and one block each of Cb and Cr per 16 × 16 MCU), the quantisation
 * tables of ITU T.81 Annex K scaled the way libjpeg scales them, the AAN forward
 * DCT, and **Huffman tables built for the image** in a second pass, by libjpeg's
 * `jpeg_gen_optimal_table`. The first version used 4:4:4 and the Annex K example
 * Huffman tables, and came out 1.4–2.7 times the size of Chromium's JPEG at the
 * same quality — measured on text, a photograph and noise.
 *
 * Alpha is ignored: a screenshot is opaque. Grey is widened to RGB, and a
 * 16-bit sample is read by its high byte.
 */
export function encodeJpeg(image: {
	width: number;
	height: number;
	/** 1 grey, 2 grey + alpha, 3 RGB, 4 RGBA — the slice of `pngDecode.RawImage` this reads. */
	channels: number;
	bitDepth: number;
	data: Uint8Array;
}, quality: number): Buffer {
	const { width, height, channels, bitDepth, data } = image;
	if (width < 1 || height < 1 || width > 0xffff || height > 0xffff) {
		throw new Error('A JPEG frame must be between 1 and 65535 pixels on each side');
	}
	const quant = quantTables(quality);

	// Pass one: every block transformed and quantised, kept in scan order, and
	// the symbols they will need counted.
	const mcusX = Math.ceil(width / 16), mcusY = Math.ceil(height / 16);
	const coefficients = new Int16Array(mcusX * mcusY * 6 * 64);
	const step = (channels * bitDepth) / 8;
	const byte = bitDepth === 16 ? 2 : 1;
	const stride = width * step;
	const grey = channels < 3;
	const Y = new Float32Array(256), U = new Float32Array(256), V = new Float32Array(256);
	const block = new Float32Array(64);
	let at = 0;
	for (let my = 0; my < mcusY; my++) {
		for (let mx = 0; mx < mcusX; mx++) {
			for (let row = 0; row < 16; row++) {
				// Past the right or bottom edge the last pixel repeats, which is
				// what a decoder discards anyway and compresses best.
				const y = Math.min(my * 16 + row, height - 1);
				for (let col = 0; col < 16; col++) {
					const o = y * stride + Math.min(mx * 16 + col, width - 1) * step;
					const r = data[o];
					const g = grey ? r : data[o + byte];
					const b = grey ? r : data[o + 2 * byte];
					const k = row * 16 + col;
					Y[k] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
					U[k] = -0.16874 * r - 0.33126 * g + 0.5 * b;
					V[k] = 0.5 * r - 0.41869 * g - 0.08131 * b;
				}
			}
			for (const [ox, oy] of [[0, 0], [8, 0], [0, 8], [8, 8]]) {
				for (let k = 0; k < 64; k++) {
					block[k] = Y[(oy + (k >> 3)) * 16 + ox + (k & 7)];
				}
				quantise(block, quant.fdtblY, coefficients, at);
				at += 64;
			}
			for (const plane of [U, V]) {
				for (let k = 0; k < 64; k++) {
					const o = (k >> 3) * 32 + (k & 7) * 2;
					block[k] = (plane[o] + plane[o + 1] + plane[o + 16] + plane[o + 17]) / 4;
				}
				quantise(block, quant.fdtblUV, coefficients, at);
				at += 64;
			}
		}
	}

	const freq = [0, 1, 2, 3].map(() => new Float64Array(257));
	entropyCode(coefficients, (table, symbol) => { freq[table][symbol]++; }, () => undefined);
	const [dcY, acY, dcUV, acUV] = freq.map(optimalTable);

	// Pass two: the same symbols, now written.
	const out = new ByteWriter(Math.max(4096, coefficients.length >> 2));
	writeHeaders(out, width, height, quant, [dcY, acY, dcUV, acUV]);
	const bits = new BitWriter(out);
	const codes = [dcY, acY, dcUV, acUV].map(t => huffman(t.counts, t.symbols));
	entropyCode(coefficients,
		(table, symbol) => bits.write(codes[table].code[symbol], codes[table].length[symbol]),
		(value, length) => bits.write(value, length));
	bits.flush();
	out.word(0xffd9); // EOI
	return out.result();
}

// --- Tables -------------------------------------------------------------------------------

/** Natural (row-major) index → position in the zigzag scan. */
const zigzag = [
	0, 1, 5, 6, 14, 15, 27, 28, 2, 4, 7, 13, 16, 26, 29, 42,
	3, 8, 12, 17, 25, 30, 41, 43, 9, 11, 18, 24, 31, 40, 44, 53,
	10, 19, 23, 32, 39, 45, 52, 54, 20, 22, 33, 38, 46, 51, 55, 60,
	21, 34, 37, 47, 50, 56, 59, 61, 35, 36, 48, 49, 57, 58, 62, 63,
];

/** Annex K.1, natural order. */
const lumaQuant = [
	16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
	14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
	18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
	49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const chromaQuant = [
	17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99,
	24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
	99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
	99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

/** AAN DCT scale factors. */
const aan = [1, 1.387039845, 1.306562965, 1.175875602, 1, 0.785694958, 0.5411961, 0.275899379];

/** Codes from code counts per length 1–16 and the symbols in code order (ITU T.81 Annex C). */
function huffman(counts: number[], symbols: number[]): { code: Uint16Array; length: Uint8Array } {
	const code = new Uint16Array(256), length = new Uint8Array(256);
	let value = 0, at = 0;
	for (let bits = 1; bits <= 16; bits++) {
		for (let n = 0; n < counts[bits - 1]; n++) {
			code[symbols[at]] = value;
			length[symbols[at]] = bits;
			at++;
			value++;
		}
		value <<= 1;
	}
	return { code, length };
}

interface Quant {
	/** Quantisers in zigzag order, as written to DQT. */
	qY: Uint8Array; qUV: Uint8Array;
	/** Reciprocals folding the AAN scaling into quantisation, natural order. */
	fdtblY: Float32Array; fdtblUV: Float32Array;
}

/** libjpeg's quality scaling: 50 is the Annex K table, 100 all ones. */
function quantTables(quality: number): Quant {
	const q = Math.max(1, Math.min(100, Math.round(quality)));
	const scale = q < 50 ? 5000 / q : 200 - q * 2;
	const zigzagged = (base: number[]) => {
		const zz = new Uint8Array(64);
		for (let i = 0; i < 64; i++) {
			zz[zigzag[i]] = Math.max(1, Math.min(255, Math.floor((base[i] * scale + 50) / 100)));
		}
		return zz;
	};
	const reciprocal = (zz: Uint8Array) => {
		const t = new Float32Array(64);
		for (let row = 0; row < 8; row++) {
			for (let col = 0; col < 8; col++) {
				const k = row * 8 + col;
				t[k] = 1 / (zz[zigzag[k]] * aan[row] * aan[col] * 8);
			}
		}
		return t;
	};
	const qY = zigzagged(lumaQuant), qUV = zigzagged(chromaQuant);
	return { qY, qUV, fdtblY: reciprocal(qY), fdtblUV: reciprocal(qUV) };
}

/**
 * Code lengths for symbol frequencies, limited to 16 bits — libjpeg's
 * `jpeg_gen_optimal_table` (ITU T.81 Annex K.2), including its reserved
 * symbol 256, which keeps any code from being all ones.
 */
export function optimalTable(input: Float64Array): { counts: number[]; symbols: number[] } {
	const freq = Float64Array.from(input);
	freq[256] = 1;
	const size = new Int32Array(257);
	const others = new Int32Array(257).fill(-1);
	for (;;) {
		let c1 = -1, c2 = -1, v = Infinity;
		for (let i = 0; i <= 256; i++) {
			if (freq[i] && freq[i] <= v) { v = freq[i]; c1 = i; }
		}
		v = Infinity;
		for (let i = 0; i <= 256; i++) {
			if (freq[i] && freq[i] <= v && i !== c1) { v = freq[i]; c2 = i; }
		}
		if (c2 < 0) {
			break;
		}
		freq[c1] += freq[c2];
		freq[c2] = 0;
		size[c1]++;
		while (others[c1] >= 0) { c1 = others[c1]; size[c1]++; }
		others[c1] = c2;
		size[c2]++;
		while (others[c2] >= 0) { c2 = others[c2]; size[c2]++; }
	}
	// Sized for the deepest tree 257 symbols can build, not for 32: libjpeg
	// stops at 32 with JERR_HUFF_CLEN_OVERFLOW, and a smaller array here would
	// drop a longer code silently and write DHT counts that disagree with the
	// symbols — a corrupt file with no error, on a skewed enough distribution.
	const bits = new Int32Array(258);
	for (let i = 0; i <= 256; i++) {
		if (size[i]) {
			bits[size[i]]++;
		}
	}
	for (let i = bits.length - 1; i > 16; i--) {
		while (bits[i] > 0) {
			let j = i - 2;
			while (bits[j] === 0) { j--; }
			bits[i] -= 2;
			bits[i - 1]++;
			bits[j + 1] += 2;
			bits[j]--;
		}
	}
	let longest = 16;
	while (bits[longest] === 0) { longest--; }
	bits[longest]--; // the reserved symbol
	const symbols: number[] = [];
	for (let length = 1; length < bits.length; length++) {
		for (let s = 0; s < 256; s++) {
			if (size[s] === length) {
				symbols.push(s);
			}
		}
	}
	return { counts: Array.from(bits.subarray(1, 17)), symbols };
}

// --- Encoding ---------------------------------------------------------------------------

/** Forward DCT and quantisation of one block, written in zigzag order at `at`. */
function quantise(d: Float32Array, fdtbl: Float32Array, out: Int16Array, at: number): void {
	for (let o = 0; o < 64; o += 8) {
		dct8(d, o, 1);
	}
	for (let o = 0; o < 8; o++) {
		dct8(d, o, 8);
	}
	for (let i = 0; i < 64; i++) {
		const v = d[i] * fdtbl[i];
		out[at + zigzag[i]] = v > 0 ? (v + 0.5) | 0 : (v - 0.5) | 0;
	}
}

/**
 * Walks the quantised blocks in scan order — four luma, Cb, Cr per MCU — and
 * reports each Huffman symbol (table 0 DC luma, 1 AC luma, 2 DC chroma, 3 AC
 * chroma) and each run of extra bits. Pass one counts, pass two writes; one walk
 * for both is what keeps the two from disagreeing about a symbol.
 */
function entropyCode(
	blocks: Int16Array,
	symbol: (table: number, symbol: number) => void,
	extra: (value: number, length: number) => void,
): void {
	const dc = [0, 0, 0];
	for (let at = 0, n = 0; at < blocks.length; at += 64, n++) {
		const which = n % 6;
		const component = which < 4 ? 0 : which - 3;
		const tables = component === 0 ? 0 : 2;

		const diff = blocks[at] - dc[component];
		dc[component] = blocks[at];
		const dcSize = magnitude(diff);
		symbol(tables, dcSize);
		if (dcSize) {
			extra(diff < 0 ? diff + (1 << dcSize) - 1 : diff, dcSize);
		}

		let last = 63;
		while (last > 0 && blocks[at + last] === 0) {
			last--;
		}
		let run = 0;
		for (let i = 1; i <= last; i++) {
			const v = blocks[at + i];
			if (v === 0) {
				run++;
				continue;
			}
			while (run >= 16) {
				symbol(tables + 1, 0xf0); // ZRL
				run -= 16;
			}
			const size = magnitude(v);
			symbol(tables + 1, (run << 4) | size);
			extra(v < 0 ? v + (1 << size) - 1 : v, size);
			run = 0;
		}
		if (last < 63) {
			symbol(tables + 1, 0x00); // EOB
		}
	}
}

/** Bits needed for |v|: the JPEG "category". */
function magnitude(v: number): number {
	return v === 0 ? 0 : 32 - Math.clz32(Math.abs(v));
}

/** The AAN 8-point forward DCT, in place, on eight values `stride` apart from `o`. */
function dct8(d: Float32Array, o: number, stride: number): void {
	const s = stride;
	const t0 = d[o] + d[o + 7 * s], t7 = d[o] - d[o + 7 * s];
	const t1 = d[o + s] + d[o + 6 * s], t6 = d[o + s] - d[o + 6 * s];
	const t2 = d[o + 2 * s] + d[o + 5 * s], t5 = d[o + 2 * s] - d[o + 5 * s];
	const t3 = d[o + 3 * s] + d[o + 4 * s], t4 = d[o + 3 * s] - d[o + 4 * s];

	let t10 = t0 + t3;
	const t13 = t0 - t3;
	let t11 = t1 + t2;
	let t12 = t1 - t2;
	d[o] = t10 + t11;
	d[o + 4 * s] = t10 - t11;
	const z1 = (t12 + t13) * 0.707106781;
	d[o + 2 * s] = t13 + z1;
	d[o + 6 * s] = t13 - z1;

	t10 = t4 + t5;
	t11 = t5 + t6;
	t12 = t6 + t7;
	const z5 = (t10 - t12) * 0.382683433;
	const z2 = 0.5411961 * t10 + z5;
	const z4 = 1.306562965 * t12 + z5;
	const z3 = t11 * 0.707106781;
	const z11 = t7 + z3, z13 = t7 - z3;
	d[o + 5 * s] = z13 + z2;
	d[o + 3 * s] = z13 - z2;
	d[o + s] = z11 + z4;
	d[o + 7 * s] = z11 - z4;
}

function writeHeaders(
	out: ByteWriter, width: number, height: number, q: Quant,
	huffmanTables: { counts: number[]; symbols: number[] }[],
): void {
	out.word(0xffd8); // SOI

	out.word(0xffe0); // APP0, JFIF 1.1, no density
	out.word(16);
	out.bytes([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);

	out.word(0xffdb); // DQT, both tables
	out.word(132);
	out.byte(0);
	out.bytes(q.qY);
	out.byte(1);
	out.bytes(q.qUV);

	out.word(0xffc0); // SOF0, 8-bit, three components, luma 2 × 2, chroma 1 × 1
	out.word(17);
	out.byte(8);
	out.word(height);
	out.word(width);
	out.byte(3);
	out.bytes([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);

	out.word(0xffc4); // DHT, all four tables
	out.word(2 + huffmanTables.reduce((sum, t) => sum + 17 + t.symbols.length, 0));
	const ids = [0x00, 0x10, 0x01, 0x11];
	for (const [i, t] of huffmanTables.entries()) {
		out.byte(ids[i]);
		out.bytes(t.counts);
		out.bytes(t.symbols);
	}

	out.word(0xffda); // SOS
	out.word(12);
	out.byte(3);
	out.bytes([1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);
}

class ByteWriter {
	private _buf: Uint8Array;
	private _at = 0;

	constructor(capacity: number) {
		this._buf = new Uint8Array(Math.max(1024, capacity));
	}

	byte(v: number): void {
		if (this._at === this._buf.length) {
			const next = new Uint8Array(this._buf.length * 2);
			next.set(this._buf);
			this._buf = next;
		}
		this._buf[this._at++] = v;
	}

	word(v: number): void {
		this.byte((v >> 8) & 0xff);
		this.byte(v & 0xff);
	}

	bytes(values: ArrayLike<number>): void {
		for (let i = 0; i < values.length; i++) {
			this.byte(values[i]);
		}
	}

	result(): Buffer {
		return Buffer.from(this._buf.buffer, 0, this._at);
	}
}

/** Entropy-coded output: most significant bit first, a 0x00 stuffed after every 0xFF. */
class BitWriter {
	private _acc = 0;
	private _count = 0;
	// A plain field: a parameter property fails to load under `npm test` (breaks-silently #49).
	private readonly _out: ByteWriter;

	constructor(out: ByteWriter) {
		this._out = out;
	}

	write(value: number, length: number): void {
		for (let bit = length - 1; bit >= 0; bit--) {
			this._acc = (this._acc << 1) | ((value >> bit) & 1);
			if (++this._count === 8) {
				this._emit();
			}
		}
	}

	/** Pads the last byte with ones, as the standard asks. */
	flush(): void {
		while (this._count !== 0) {
			this._acc = (this._acc << 1) | 1;
			if (++this._count === 8) {
				this._emit();
			}
		}
	}

	private _emit(): void {
		this._out.byte(this._acc);
		if (this._acc === 0xff) {
			this._out.byte(0);
		}
		this._acc = 0;
		this._count = 0;
	}
}
