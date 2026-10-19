// Builds media/ai-browser-icons.ttf: the keep-awake cup, empty and full, as glyphs of an icon
// font contributed through `contributes.icons`. A font glyph is coloured by the theme like a
// codicon; an SVG icon keeps its own fills. See "Keeping the computer awake" in CLAUDE.md.
//
// No dependency: a TrueType file is a handful of binary tables, and this writes the ten that
// Chromium's font sanitizer (OTS) asks for. Metrics follow codicon.ttf — 300 units per em, the
// glyph in the square 0..300 above the baseline — so the cup sits where a codicon would.
//
//   node ./scripts/build-icon-font.mjs
import { writeFileSync } from 'node:fs';

const upm = 300;
const scale = upm / 16; // drawn on the 16 px grid, y down, like the SVG it replaces

/** A point on the 16 px grid, y down, into font units, y up. */
const pt = (x, y, on = true) => ({ x: Math.round(x * scale), y: Math.round((16 - y) * scale), on });

/**
 * An arc as quadratic segments of at most 45°: on-curve points and the control point between
 * each pair, at r / cos(θ/2) on the middle angle. Angles in degrees, y down (90° is down).
 */
function arc(cx, cy, r, from, to) {
	const steps = Math.max(1, Math.ceil(Math.abs(to - from) / 45));
	const step = (to - from) / steps;
	const points = [];
	for (let i = 0; i <= steps; i++) {
		const a = (from + step * i) * Math.PI / 180;
		if (i > 0) {
			const m = (from + step * (i - 0.5)) * Math.PI / 180;
			const k = r / Math.cos(step * Math.PI / 360);
			points.push(pt(cx + k * Math.cos(m), cy + k * Math.sin(m), false));
		}
		points.push(pt(cx + r * Math.cos(a), cy + r * Math.sin(a)));
	}
	return points;
}

/**
 * A cup's body: a box open at the top with a rounded bottom. `outer` true walks it one way and
 * false the other, so a smaller copy inside cuts a hole (TrueType fills by winding direction).
 */
function bowl(left, right, top, bottom, outer) {
	const r = (right - left) / 2, cx = left + r, cy = bottom - r;
	// Walk: top-left, down the left side, round the bottom, up the right side, top-right.
	const pts = [pt(left, top), pt(left, cy), ...arc(cx, cy, r, 180, 0).slice(1), pt(right, top)];
	return outer ? pts.reverse() : pts; // reversed is clockwise once y points up
}

/** The handle: a ring opening into the body on its left. */
function handle(x, cy, r, outer) {
	const pts = [pt(x, cy - r), ...arc(x, cy, r, -90, 90), pt(x, cy + r)];
	return outer ? pts : pts.reverse();
}

const rect = (l, t, r, b) => [pt(l, t), pt(r, t), pt(r, b), pt(l, b)]; // clockwise once y is up

const wall = 1;
const body = { left: 2, right: 11, top: 3, bottom: 13 };
function cup(full) {
	// The hole starts above the rim, so the cup is open at the top.
	const inner = { left: body.left + wall, right: body.right - wall, top: body.top - 1, bottom: body.bottom - wall };
	const contours = [
		bowl(body.left, body.right, body.top, body.bottom, true),
		bowl(inner.left, inner.right, inner.top, inner.bottom, false),
		handle(body.right - 0.5, 6.5, 2.25, true),
		handle(body.right - 0.5, 6.5, 2.25 - wall, false),
		rect(0.5, 14, 13.5, 15), // the saucer
	];
	if (full) {
		// What is in it: a step in from the wall, so the two read apart at 16 px.
		contours.push(bowl(inner.left + 1, inner.right - 1, 6, inner.bottom - 1, true));
	}
	return contours;
}

/* ---------------------------------------------------------------- the file */

function glyphData(contours) {
	if (!contours.length) {
		return Buffer.alloc(0);
	}
	const points = contours.flat();
	const xs = points.map(p => p.x), ys = points.map(p => p.y);
	const head = Buffer.alloc(10 + 2 * contours.length + 2);
	head.writeInt16BE(contours.length, 0);
	head.writeInt16BE(Math.min(...xs), 2); head.writeInt16BE(Math.min(...ys), 4);
	head.writeInt16BE(Math.max(...xs), 6); head.writeInt16BE(Math.max(...ys), 8);
	let end = -1;
	contours.forEach((c, i) => { end += c.length; head.writeUInt16BE(end, 10 + 2 * i); });
	head.writeUInt16BE(0, 10 + 2 * contours.length); // no instructions
	const flags = Buffer.from(points.map(p => (p.on ? 1 : 0))); // 16-bit deltas for both axes
	const coords = Buffer.alloc(points.length * 4);
	let px = 0, py = 0;
	points.forEach((p, i) => { coords.writeInt16BE(p.x - px, 2 * i); px = p.x; });
	points.forEach((p, i) => { coords.writeInt16BE(p.y - py, 2 * (points.length + i)); py = p.y; });
	const data = Buffer.concat([head, flags, coords]);
	return Buffer.concat([data, Buffer.alloc((4 - data.length % 4) % 4)]);
}

const glyphs = [[], cup(false), cup(true)]; // .notdef, U+E001, U+E002
const firstChar = 0xE001;
const glyf = glyphs.map(glyphData);
const loca = Buffer.alloc((glyf.length + 1) * 4);
{
	let offset = 0;
	glyf.forEach((g, i) => { loca.writeUInt32BE(offset, 4 * i); offset += g.length; });
	loca.writeUInt32BE(offset, 4 * glyf.length);
}
const all = glyphs.flat(2);
const bbox = [Math.min(...all.map(p => p.x)), Math.min(...all.map(p => p.y)), Math.max(...all.map(p => p.x)), Math.max(...all.map(p => p.y))];
const maxPoints = Math.max(...glyphs.map(g => g.flat().length));
const maxContours = Math.max(...glyphs.map(g => g.length));

function table(size, fill) { const b = Buffer.alloc(size); fill(b); return b; }

const head = table(54, b => {
	b.writeUInt32BE(0x00010000, 0); b.writeUInt32BE(0x00010000, 4); // version, fontRevision
	b.writeUInt32BE(0x5F0F3CF5, 12); b.writeUInt16BE(0x000B, 16); b.writeUInt16BE(upm, 18);
	// created / modified left at 0: the file is deterministic, so a rebuild changes nothing
	b.writeInt16BE(bbox[0], 36); b.writeInt16BE(bbox[1], 38); b.writeInt16BE(bbox[2], 40); b.writeInt16BE(bbox[3], 42);
	b.writeUInt16BE(8, 46); // lowestRecPPEM
	b.writeInt16BE(2, 48); // fontDirectionHint
	b.writeInt16BE(1, 50); // long loca offsets
});
const hhea = table(36, b => {
	b.writeUInt32BE(0x00010000, 0); b.writeInt16BE(upm, 4); b.writeInt16BE(0, 6);
	b.writeUInt16BE(upm, 10); b.writeInt16BE(bbox[0], 12); b.writeInt16BE(upm - bbox[2], 14); b.writeInt16BE(bbox[2], 16);
	b.writeInt16BE(1, 18); b.writeUInt16BE(glyphs.length, 34);
});
const maxp = table(32, b => {
	b.writeUInt32BE(0x00010000, 0); b.writeUInt16BE(glyphs.length, 4); b.writeUInt16BE(maxPoints, 6); b.writeUInt16BE(maxContours, 8);
	b.writeUInt16BE(1, 14); // maxZones
});
const hmtx = table(4 * glyphs.length, b => glyphs.forEach((g, i) => {
	b.writeUInt16BE(upm, 4 * i);
	b.writeInt16BE(g.length ? Math.min(...g.flat().map(p => p.x)) : 0, 4 * i + 2);
}));
const cmap = table(4 + 8 + 32, b => {
	b.writeUInt16BE(0, 0); b.writeUInt16BE(1, 2); // version, one encoding record
	b.writeUInt16BE(3, 4); b.writeUInt16BE(1, 6); b.writeUInt32BE(12, 8); // Windows Unicode BMP
	const s = 12; // format 4, two segments: E001..E002 and the closing FFFF
	b.writeUInt16BE(4, s); b.writeUInt16BE(32, s + 2); b.writeUInt16BE(0, s + 4);
	b.writeUInt16BE(4, s + 6); b.writeUInt16BE(4, s + 8); b.writeUInt16BE(1, s + 10); b.writeUInt16BE(0, s + 12);
	b.writeUInt16BE(firstChar + 1, s + 14); b.writeUInt16BE(0xFFFF, s + 16); // endCode
	b.writeUInt16BE(0, s + 18); // reservedPad
	b.writeUInt16BE(firstChar, s + 20); b.writeUInt16BE(0xFFFF, s + 22); // startCode
	b.writeInt16BE((1 - firstChar) << 16 >> 16, s + 24); b.writeInt16BE(1, s + 26); // idDelta
	// idRangeOffset zeros
});
const names = [[1, 'AI Browser Icons'], [2, 'Regular'], [3, 'AI Browser Icons'], [4, 'AI Browser Icons'], [5, 'Version 1.0'], [6, 'AIBrowserIcons']];
const name = (() => {
	const strings = names.map(([, s]) => Buffer.from(s, 'utf16le').swap16());
	const header = Buffer.alloc(6 + 12 * names.length);
	header.writeUInt16BE(0, 0); header.writeUInt16BE(names.length, 2); header.writeUInt16BE(header.length, 4);
	let offset = 0;
	names.forEach(([id], i) => {
		const o = 6 + 12 * i;
		header.writeUInt16BE(3, o); header.writeUInt16BE(1, o + 2); header.writeUInt16BE(0x409, o + 4);
		header.writeUInt16BE(id, o + 6); header.writeUInt16BE(strings[i].length, o + 8); header.writeUInt16BE(offset, o + 10);
		offset += strings[i].length;
	});
	return Buffer.concat([header, ...strings]);
})();
const post = table(32, b => { b.writeUInt32BE(0x00030000, 0); }); // no glyph names
const os2 = table(96, b => {
	b.writeUInt16BE(4, 0); b.writeInt16BE(upm, 2); b.writeUInt16BE(400, 4); b.writeUInt16BE(5, 6);
	b.writeInt16BE(upm / 5, 10); b.writeInt16BE(upm / 5, 12); // subscript, superscript and strikeout sizes: unused
	b.writeInt16BE(upm / 5, 18); b.writeInt16BE(upm / 5, 20); b.writeInt16BE(upm / 20, 26); b.writeInt16BE(upm / 4, 28);
	b.write('AIBR', 58, 'latin1');
	b.writeUInt16BE(0x40, 62); // fsSelection REGULAR
	b.writeUInt16BE(firstChar, 64); b.writeUInt16BE(firstChar + 1, 66);
	b.writeInt16BE(upm, 68); b.writeInt16BE(0, 70); b.writeInt16BE(0, 72); // typo ascender, descender, gap
	b.writeUInt16BE(Math.max(upm, bbox[3]), 74); b.writeUInt16BE(Math.max(0, -bbox[1]), 76); // win ascent, descent
	b.writeUInt32BE(1, 78); // Latin-1 code page, as codicon.ttf declares
	b.writeInt16BE(0, 86); b.writeInt16BE(upm, 88); // xHeight, capHeight
	b.writeUInt16BE(0, 90); b.writeUInt16BE(firstChar, 92); b.writeUInt16BE(0, 94);
});

const tables = { 'OS/2': os2, cmap, glyf: Buffer.concat(glyf), head, hhea, hmtx, loca, maxp, name, post };
const tags = Object.keys(tables).sort();
const checksum = buf => {
	const padded = Buffer.concat([buf, Buffer.alloc((4 - buf.length % 4) % 4)]);
	let sum = 0;
	for (let i = 0; i < padded.length; i += 4) { sum = (sum + padded.readUInt32BE(i)) >>> 0; }
	return sum;
};
const dirSize = 12 + 16 * tags.length;
const dir = Buffer.alloc(dirSize);
const entrySelector = Math.floor(Math.log2(tags.length));
dir.writeUInt32BE(0x00010000, 0); dir.writeUInt16BE(tags.length, 4);
dir.writeUInt16BE(16 * 2 ** entrySelector, 6); dir.writeUInt16BE(entrySelector, 8); dir.writeUInt16BE(16 * tags.length - 16 * 2 ** entrySelector, 10);
let offset = dirSize;
const bodies = [];
tags.forEach((tag, i) => {
	const data = tables[tag];
	const o = 12 + 16 * i;
	dir.write(tag.padEnd(4), o, 'latin1');
	dir.writeUInt32BE(checksum(data), o + 4); dir.writeUInt32BE(offset, o + 8); dir.writeUInt32BE(data.length, o + 12);
	const padded = Buffer.concat([data, Buffer.alloc((4 - data.length % 4) % 4)]);
	bodies.push(padded);
	offset += padded.length;
});
const font = Buffer.concat([dir, ...bodies]);
const headAt = dir.readUInt32BE(12 + 16 * tags.indexOf('head') + 8);
font.writeUInt32BE((0xB1B0AFBA - checksum(font)) >>> 0, headAt + 8); // checkSumAdjustment
writeFileSync(new URL('../media/ai-browser-icons.ttf', import.meta.url), font);
console.log(`media/ai-browser-icons.ttf: ${font.length} bytes, ${glyphs.length} glyphs`);
