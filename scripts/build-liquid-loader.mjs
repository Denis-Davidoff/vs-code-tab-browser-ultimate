// Builds media/liquid-loader.css: the "Whirlpool" liquid spinner shared by the extension's chat, the
// Chrome side panel and the Exchange website. A 40 s loop: a circle at 0 s, a rounded hexagon
// (core and shell alike) at 16.8 s, a fluid six-rayed shape in between, held at neither; then the
// core shrinks into a 4 px dot and immediately grows back into the circle. Around 0 s the core holds
// still as a circle for about 5 s and a smiley face is drawn on it: one eye, the other, then the
// smile stroke by stroke; it blinks once, then turns round faster and faster and fades out as it turns.
//
// A star or a hexagon cannot be drawn with border-radius, so the shapes are an SVG animated with
// SMIL and set as a data: background. Every surface keeps its plain <span class="liquid-loader">
// and needs no extra file to copy; reduced motion gets the first frame, a still circle.
//
//   node ./scripts/build-liquid-loader.mjs
import { writeFileSync } from 'node:fs';

const DUR = 40; // seconds per loop
const FRAMES = 320, POINTS = 64, SCALE = 10; // viewBox -500..500, integer coordinates
const v = { k: 6, A: .16, p: .6, w: .08, ck: 6, ca: .07, TH: .42, HW: .10, rot: 30, round: .25, core: 720, shell: -720 };
const SHELL_A = v.A * .45;
// The loop is DUR s with one circle and one hexagon; the motion between them (deformation,
// breathing, rotation) runs twice as fast. SPEED must be a whole number to keep the loop seamless.
const SPEED = 2;
// Radii in viewBox units (half-size 50): small enough that the shell's rays and the core's
// largest breath stay inside the box, measured by the check at the end of this script.
const CORE_R = 29, SHELL_R = 40;

const fluid = t => t < v.TH ? Math.sin(Math.PI * t / v.TH) : -Math.sin(Math.PI * (t - v.TH) / (1 - v.TH));
const hexW = t => { const x = (t - v.TH) / v.HW; return Math.abs(x) < .5 ? Math.cos(Math.PI * x) ** 2 : 0; };
// The layer spins `spin` degrees a loop, so the hexagon is turned back to sit at `rot` at TH.
const hexR = (phi, spin, rot) => {
	const S = Math.PI / 3, p = phi + (spin * v.TH - rot) * Math.PI / 180, a = ((p % S) + S) % S - S / 2;
	return (1 - v.round) * Math.cos(S / 2) / Math.cos(a) + v.round;
};

function shell(cycle, R) {
	const t = cycle / (2 * Math.PI), m = fluid(t), h = hexW(t);
	const th = SPEED * cycle; // the flow between the two shapes runs SPEED times per loop
	return ring(phi => {
		const twist = -.35 * Math.sin(th);
		const len = 1 + .45 * Math.sin(th + phi + v.k) + .25 * Math.sin(2 * th - 2 * phi);
		const lean = .22 * Math.sin(th + phi + 1.3) / v.k;
		let c = Math.cos(v.k * (phi + lean + twist * Math.sin(phi * 2)));
		c = Math.sign(c) * Math.abs(c) ** v.p;
		const wob = (v.w + .05) * (Math.sin(2 * th + phi * (v.k + 1)) + .6 * Math.sin(3 * th - phi * (v.k - 1)));
		const r = R * (1 + SHELL_A * m * c * len + wob * (SHELL_A / v.A) * m);
		return (1 - h) * r + h * R * hexR(phi, v.shell, 0);
	});
}

// After the hexagon the liquid collapses to the fixed-size dot and grows back immediately.
const COLLAPSE = { from: .6, gone: .7, back: .7, to: .96 };
const ease = x => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, x)))) / 2;
const collapse = t => t < COLLAPSE.gone ? 1 - ease((t - COLLAPSE.from) / (COLLAPSE.gone - COLLAPSE.from))
	: t < COLLAPSE.back ? 0 : ease((t - COLLAPSE.back) / (COLLAPSE.to - COLLAPSE.back));
// The dot the core shrinks to: a zero-length stroke with round caps, non-scaling, so it is 4 px
// across at every loader size. Solid, as a gradient needs a box.
const DOT = '<path d="M0 0L0 0" stroke="#8fbef0" stroke-width="4" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';

// The smiley's hold, as a signed distance from 0 s in loops (-0.5..0.5). The core keeps still a little
// longer than the face shows, so the face never sits on a tilting liquid.
const FACE = { from: -.045, to: .075, fade: .012, calm: .03 };
const near = t => t < .5 ? t : t - 1;
const still = t => {
	const d = near(t), lo = FACE.from - FACE.fade, hi = FACE.to + FACE.fade;
	return d < lo ? ease((d - lo + FACE.calm) / FACE.calm) : d > hi ? 1 - ease((d - hi) / FACE.calm) : 1;
};
// The face is drawn upright in the core's unrotated frame, as if by hand: the left eye pops in, then
// the right one, then the smile is drawn left to right; it blinks once, and the whole face fades out.
// Times are signed loop fractions from 0 s (see `near`); keyTimes are them wrapped into 0..1.
const FACE_STEPS = { leftEye: -.045, rightEye: -.032, smile: [-.018, .004], blink: .025 };
// After the blink the face starts to turn round the centre, the way the vessel turns, gathering
// speed, and fades out while it turns; it is gone when the hold ends.
const FACE_SPIN = { from: .035, fade: .045, turn: -540 };
function face() {
	const k = t => +((t + 1) % 1).toFixed(4);
	const anim = (attr, frames) => {
		const list = frames.map(([t, v]) => [k(t), v]).sort((a, b) => a[0] - b[0]);
		// A segment that crosses the loop's end is split at it, with the value it has there.
		const [first, last] = [list[0], list.at(-1)];
		const atSeam = +(last[1] + (first[1] - last[1]) * (1 - last[0]) / (1 - last[0] + first[0])).toFixed(3);
		if (first[0] !== 0) list.unshift([0, atSeam]);
		if (last[0] !== 1) list.push([1, atSeam]);
		return `<animate attributeName="${attr}" dur="${DUR}s" repeatCount="indefinite" calcMode="linear" keyTimes="${list.map(f => f[0]).join(';')}" values="${list.map(f => f[1]).join(';')}"/>`;
	};
	// Shown from before the first eye; faded out while it turns, and reset while nothing is drawn.
	const gone = FACE.to + FACE.fade;
	const opacity = anim('opacity', [[-.2, 1], [FACE_SPIN.fade, 1], [gone, 0], [.3, 0]]);
	// The turn speeds up and keeps going until the face is gone; it is put back while nothing is drawn.
	const turn = `<animateTransform attributeName="transform" type="rotate" dur="${DUR}s" repeatCount="indefinite" calcMode="spline" keyTimes="0;${FACE_SPIN.from};${gone};.3;.301;1" values="0;0;${FACE_SPIN.turn};${FACE_SPIN.turn};0;0" keySplines="0 0 1 1;.5 0 .9 .6;0 0 1 1;0 0 1 1;0 0 1 1"/>`;
	const POP = .006, RX = 46, RY = 52; // grows past its size and settles
	const pop = (start, size) => [[start - .001, 0], [start, 0], [start + POP, Math.round(size * 1.3)], [start + POP * 1.6, size], [FACE.to + FACE.fade, size], [FACE.to + FACE.fade + .001, 0]];
	const b = FACE_STEPS.blink;
	const eye = (x, start) => `<ellipse cx="${x}" cy="-65" rx="0" ry="0">${anim('rx', pop(start, RX))}`
		+ `${anim('ry', [...pop(start, RY).slice(0, 4), [b - .003, RY], [b, 8], [b + .003, RY], ...pop(start, RY).slice(4)])}</ellipse>`;
	// pathLength 1: the dash is the drawn part, and the offset slides it in from the path's start.
	const [s0, s1] = FACE_STEPS.smile;
	const draw = anim('stroke-dashoffset', [[s0 - .001, 1.05], [s0, 1], [s1, 0], [FACE.to + FACE.fade, 0], [FACE.to + FACE.fade + .001, 1.05]]);
	return `<g opacity="0">${opacity}${turn}<g fill="#241f4a">${eye(-130, FACE_STEPS.leftEye)}${eye(130, FACE_STEPS.rightEye)}</g>`
		+ `<path d="M-150 85Q0 205 150 85" pathLength="1" stroke-dasharray="1 2" stroke-dashoffset="1.05" fill="none" stroke="#241f4a" stroke-width="38" stroke-linecap="round">${draw}</path></g>`;
}

// The liquid is drawn in vessel coordinates, without a separate core rotation:
// its six travelling tilts must stay aligned with the rotating wall it wets.
// The shell's inner radius at an angle, in the core's (unrotated) frame.
function wall(cycle) {
	const TAU = 2 * Math.PI, spin = v.shell * Math.PI / 180 * cycle / TAU;
	const raw = shell(cycle, SHELL_R).match(/-?\d+(?:\.\d+)?/g).map(Number);
	const radii = Array.from({ length: POINTS }, (_, i) => Math.hypot(raw[2*i], raw[2*i+1]) / SCALE);
	return phi => {
		const f = ((phi - spin) / TAU % 1 + 1) % 1 * POINTS, i = Math.floor(f);
		return radii[i] + (radii[(i + 1) % POINTS] - radii[i]) * (f - i);
	};
}
// A rounded meniscus: a soft minimum of the liquid's radius and the wall's.
const cap = (r, wall) => -Math.log(Math.exp(-r / 1.1) + Math.exp(-wall / 1.1)) * 1.1;

function core(cycle, R) {
	const TAU = 2 * Math.PI, t = cycle / TAU;
	const boundary = wall(cycle);
	const q = cycle * 6, angle = q + .38 * Math.sin(q);
	const h = hexW(t), grow = collapse(t);
	const moving = (1 - Math.exp(-((Math.sin(Math.PI * t) / .1) ** 2))) * (1 - h) * (1 - still(t));
	const limits = [], desired = [];
	for (let i = 0; i < POINTS; i++) {
		const phi = i * TAU / POINTS, a = phi - angle;
		limits.push(boundary(phi) - 1.1);
		desired.push(R * (1 + moving * (.82 * Math.cos(a)
			+ .10 * Math.sin(2*a - q) + .055 * Math.sin(3*a + 2*q))));
	}
	// The meniscus spreads around the wall. Redistribute displaced liquid
	// to conserve its area during the tilt, rather than trimming it at the edge.
	let lo = .4, hi = 2.2;
	for (let step = 0; step < 18; step++) {
		const scale = (lo + hi) / 2;
		const area = desired.reduce((sum, r, i) => sum + cap(r * scale, limits[i]) ** 2, 0) / POINTS;
		if (area > R * R) hi = scale; else lo = scale;
	}
	const rr = desired.map((r, i) => {
		const liquid = cap(r * (lo + hi) / 2, limits[i]);
		return (liquid + (boundary(i * TAU / POINTS) * .74 - liquid) * h) * grow;
	});
	return ring(phi => rr[Math.round(phi / TAU * POINTS) % POINTS], true);
}

function smoothPath(points) {
	const P = points.length, point = i => points[(i + P) % P];
	const xy = p => p.map(n => Math.round(n)).join(' ');
	let d = 'M' + xy(points[0]);
	// Periodic Catmull–Rom tangents keep every join, including the seam, smooth.
	for (let i = 0; i < P; i++) {
		const a = point(i - 1), b = point(i), c = point(i + 1), e = point(i + 2);
		d += 'C' + xy(b.map((n, j) => n + (c[j] - a[j]) / 6)) + ' '
			+ xy(c.map((n, j) => n - (e[j] - b[j]) / 6)) + ' ' + xy(c);
	}
	return d + 'Z';
}

function ring(radius, smooth = false) {
	if (smooth) return smoothPath(Array.from({ length: POINTS }, (_, i) => {
		const phi = 2 * Math.PI * i / POINTS, r = radius(phi) * SCALE;
		return [r * Math.cos(phi), r * Math.sin(phi)];
	}));
	let d = '';
	for (let i = 0; i < POINTS; i++) {
		const phi = 2 * Math.PI * i / POINTS, r = radius(phi) * SCALE;
		d += (i ? ' ' : 'M') + Math.round(r * Math.cos(phi)) + ' ' + Math.round(r * Math.sin(phi));
	}
	return d + 'Z';
}

const frames = draw => Array.from({ length: FRAMES + 1 }, (_, i) => draw(2 * Math.PI * i / FRAMES)).join(';');
const spin = deg => `<animateTransform attributeName="transform" type="rotate" from="0" to="${deg}" dur="${DUR}s" repeatCount="indefinite"/>`;
const grad = '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ac9aff"/><stop offset="1" stop-color="#71e2e1"/></linearGradient></defs>';

function svg({ withShell, animated, withFace = false }) {
	const shape = (d, draw) => animated ? `<path d="${d}"><animate attributeName="d" dur="${DUR}s" repeatCount="indefinite" values="${frames(draw)}"/></path>` : `<path d="${d}"/>`;
	const coreG = `<g fill="url(#g)">${shape(core(0, CORE_R), th => core(th, CORE_R))}</g>`;
	// 1 px of a 16 px loader, as the border it replaces; non-scaling keeps it 1 px at 48 px too
	const shellG = withShell ? `<g fill="none" stroke="#ac9aff" stroke-opacity=".65" stroke-width="1" vector-effect="non-scaling-stroke">${animated ? spin(v.shell) : ''}${shape(shell(0, SHELL_R), th => shell(th, SHELL_R))}</g>`.replace('<path', '<path vector-effect="non-scaling-stroke"') : '';
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-500 -500 1000 1000">${grad}${DOT}${coreG}${withFace ? face() : ''}${shellG}</svg>`;
}
const url = s => `url("data:image/svg+xml,${s.replace(/%/g, '%25').replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/"/g, "'")}")`;

const css = `/* AI Browser liquid loader, shared by the extension, Chrome and the Exchange website.
 * Generated by scripts/build-liquid-loader.mjs — edit that, not this file.
 * Whirlpool: six circular tilts over 40 s, a brief rounded hexagon at 16.8 s, then the liquid
 * shrinks to a 4 px dot at 28 s and grows back into the circle, which smiles for ~5 s around 0 s. The SVG is a data: URL, so no surface has an extra file to copy. */
:root {
	--liquid-loader-image: ${url(svg({ withShell: true, animated: true, withFace: true }))};
	/* The small status dots draw the core alone, without the face: it would be noise at their size. */
	--liquid-core-image: ${url(svg({ withShell: false, animated: true }))};
}
@media (prefers-reduced-motion: reduce) {
	:root {
		--liquid-loader-image: ${url(svg({ withShell: true, animated: false }))};
		--liquid-core-image: ${url(svg({ withShell: false, animated: false }))};
	}
}
.liquid-loader {
	--liquid-size: 16px;
	display: inline-block;
	flex: none;
	width: var(--liquid-size);
	height: var(--liquid-size);
	vertical-align: middle;
	line-height: 1;
	background: var(--liquid-loader-image) center / contain no-repeat;
}
`;
// Every frame of both shapes must fit the 1000-unit box, or the loader is cut at its edges.
let reach = 0;
for (let i = 0; i <= FRAMES; i++) {
	const th = 2 * Math.PI * i / FRAMES;
	for (const d of [core(th, CORE_R), shell(th, SHELL_R)])
		for (const [x, y] of d.match(/-?\d+(?:\.\d+)?/g).reduce((a, n, j) => (j % 2 ? a[a.length - 1].push(+n) : a.push([+n]), a), []))
			reach = Math.max(reach, Math.hypot(x, y));
}
if (reach > 480) throw new Error(`liquid loader reaches ${reach} of 500 units: lower CORE_R or SHELL_R`);
console.log(`farthest point: ${Math.round(reach)} of 500 units`);
writeFileSync(new URL('../media/liquid-loader.css', import.meta.url), css);
console.log(`media/liquid-loader.css: ${(css.length / 1024).toFixed(0)} KB`);
