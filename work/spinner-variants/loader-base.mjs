const DUR = 40; // seconds per loop
const FRAMES = 160, POINTS = 64, SCALE = 10; // viewBox -500..500, integer coordinates
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

// After the hexagon the core shrinks to a round droplet at 35% of its initial radius.
// The envelope touches 0 at the minimum droplet and immediately rises again.
const MIN_CORE = .35;
const COLLAPSE = { from: .6, gone: .7, back: .7, to: .96 };
const ease = x => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, x)))) / 2;
const collapse = t => t < COLLAPSE.gone ? 1 - ease((t - COLLAPSE.from) / (COLLAPSE.gone - COLLAPSE.from))
	: t < COLLAPSE.back ? 0 : ease((t - COLLAPSE.back) / (COLLAPSE.to - COLLAPSE.back));
// The dot the core shrinks to: a zero-length stroke with round caps, non-scaling, so it is 2 px
// across (twice the shell's 1 px line) at every loader size. Solid, as a gradient needs a box.
const DOT = '<path d="M0 0L0 0" stroke="#8fbef0" stroke-width="2" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';

function core(cycle, R) {
	const t = cycle / (2 * Math.PI), m = fluid(t), h = hexW(t);
	const th = SPEED * cycle; // the flow between the two shapes runs SPEED times per loop
	// the core breathes larger and smaller on top of its deformation; 1 at the circle
	const size = 1 - .14 * (1 - Math.cos(th)) / 2 + .1 * Math.sin(2 * th) + .08 * Math.sin(3 * th);
	const z = collapse(t);
	return ring(phi => {
		// Broad travelling waves form rounded lobes; their different speeds keep the
		// liquid flowing instead of repeatedly opening into a six-pointed star.
		const flow = .22 * Math.sin(2 * phi + 3 * th + .5 * Math.sin(th))
			+ .13 * Math.sin(3 * phi - 4 * th)
			+ .04 * Math.cos(4 * phi + 5 * th);
		const r = R * size * (1 + m * flow);
		return (1 - z) * R * MIN_CORE + z * ((1 - h) * r + h * R * .9 * hexR(phi, v.core, v.rot));
	}, true);
}

function ring(radius, smooth = false) {
	if (smooth) {
		const points = Array.from({ length: POINTS }, (_, i) => {
			const phi = 2 * Math.PI * i / POINTS, r = radius(phi) * SCALE;
			return [r * Math.cos(phi), r * Math.sin(phi)];
		});
		const point = i => points[(i + POINTS) % POINTS];
		const xy = p => p.map(n => +n.toFixed(1)).join(' ');
		let d = 'M' + xy(points[0]);
		// Periodic Catmull–Rom tangents keep every join, including the seam, smooth.
		for (let i = 0; i < POINTS; i++) {
			const a = point(i - 1), b = point(i), c = point(i + 1), e = point(i + 2);
			d += 'C' + xy(b.map((n, j) => n + (c[j] - a[j]) / 6)) + ' '
				+ xy(c.map((n, j) => n - (e[j] - b[j]) / 6)) + ' ' + xy(c);
		}
		return d + 'Z';
	}
	let d = '';
	for (let i = 0; i < POINTS; i++) {
		const phi = 2 * Math.PI * i / POINTS, r = radius(phi) * SCALE;
		d += (i ? ' ' : 'M') + Math.round(r * Math.cos(phi)) + ' ' + Math.round(r * Math.sin(phi));
	}
	return d + 'Z';
}


export { shell, ring, hexW, collapse };
