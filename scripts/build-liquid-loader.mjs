// Builds media/liquid-loader.css: the "soft nut" spinner shared by the extension's chat, the
// Chrome side panel and the Exchange website. A 30 s loop: a circle at 0 s, a rounded hexagon
// (core and shell alike) at 12.6 s, a fluid six-rayed shape in between, held at neither.
//
// A star or a hexagon cannot be drawn with border-radius, so the shapes are an SVG animated with
// SMIL and set as a data: background. Every surface keeps its plain <span class="liquid-loader">
// and needs no extra file to copy; reduced motion gets the first frame, a still circle.
//
//   node ./scripts/build-liquid-loader.mjs
import { writeFileSync } from 'node:fs';

const FRAMES = 120, POINTS = 64, SCALE = 10; // viewBox -500..500, integer coordinates
const v = { k: 6, A: .16, p: .6, w: .08, ck: 6, ca: .07, TH: .42, HW: .34, rot: 30, round: .25, core: 720, shell: -720 };
const SHELL_A = v.A * .45;
// The loop stays 30 s with one circle and one hexagon; the motion between them (deformation,
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

function core(cycle, R) {
	const t = cycle / (2 * Math.PI), m = fluid(t), h = hexW(t);
	const th = SPEED * cycle; // the flow between the two shapes runs SPEED times per loop
	// the core breathes larger and smaller on top of its deformation; 1 at the circle
	const size = 1 - .14 * (1 - Math.cos(th)) / 2 + .1 * Math.sin(2 * th) + .08 * Math.sin(3 * th);
	return ring(phi => {
		const lean = .2 * Math.sin(th + phi) / v.ck;
		const r = R * size * (1 + m * (.14 * Math.cos(2 * phi + th + v.k) + .07 * Math.cos(3 * phi - 2 * th)
			+ v.ca * (1 + .4 * Math.sin(th + phi)) * Math.cos(v.ck * (phi + lean) - th)));
		return (1 - h) * r + h * R * .9 * hexR(phi, v.core, v.rot);
	});
}

function ring(radius) {
	let d = '';
	for (let i = 0; i < POINTS; i++) {
		const phi = 2 * Math.PI * i / POINTS, r = radius(phi) * SCALE;
		d += (i ? ' ' : 'M') + Math.round(r * Math.cos(phi)) + ' ' + Math.round(r * Math.sin(phi));
	}
	return d + 'Z';
}

const frames = draw => Array.from({ length: FRAMES + 1 }, (_, i) => draw(2 * Math.PI * i / FRAMES)).join(';');
const spin = deg => `<animateTransform attributeName="transform" type="rotate" from="0" to="${deg}" dur="30s" repeatCount="indefinite"/>`;
const grad = '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ac9aff"/><stop offset="1" stop-color="#71e2e1"/></linearGradient></defs>';

function svg({ withShell, animated }) {
	const shape = (d, draw) => animated ? `<path d="${d}"><animate attributeName="d" dur="30s" repeatCount="indefinite" values="${frames(draw)}"/></path>` : `<path d="${d}"/>`;
	const coreG = `<g fill="url(#g)">${animated ? spin(v.core) : ''}${shape(core(0, CORE_R), th => core(th, CORE_R))}</g>`;
	// 1 px of a 16 px loader, as the border it replaces; non-scaling keeps it 1 px at 48 px too
	const shellG = withShell ? `<g fill="none" stroke="#ac9aff" stroke-opacity=".65" stroke-width="1" vector-effect="non-scaling-stroke">${animated ? spin(v.shell) : ''}${shape(shell(0, SHELL_R), th => shell(th, SHELL_R))}</g>`.replace('<path', '<path vector-effect="non-scaling-stroke"') : '';
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-500 -500 1000 1000">${grad}${coreG}${shellG}</svg>`;
}
const url = s => `url("data:image/svg+xml,${s.replace(/%/g, '%25').replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/"/g, "'")}")`;

const css = `/* AI Browser liquid loader, shared by the extension, Chrome and the Exchange website.
 * Generated by scripts/build-liquid-loader.mjs — edit that, not this file.
 * A 30 s loop: circle, then a fluid six-rayed shape, a rounded hexagon at 12.6 s, and back,
 * held at neither. The SVG is a data: URL, so no surface has an extra file to copy. */
:root {
	--liquid-loader-image: ${url(svg({ withShell: true, animated: true }))};
	/* The small status dots draw the core alone. */
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
		for (const [x, y] of d.slice(1, -1).split(' ').reduce((a, n, j) => (j % 2 ? a[a.length - 1].push(+n) : a.push([+n]), a), []))
			reach = Math.max(reach, Math.hypot(x, y));
}
if (reach > 480) throw new Error(`liquid loader reaches ${reach} of 500 units: lower CORE_R or SHELL_R`);
console.log(`farthest point: ${Math.round(reach)} of 500 units`);
writeFileSync(new URL('../media/liquid-loader.css', import.meta.url), css);
console.log(`media/liquid-loader.css: ${(css.length / 1024).toFixed(0)} KB`);
