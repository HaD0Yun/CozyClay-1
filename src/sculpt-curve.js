/**
 * Curve and outline math for the sculpt shapes that follow points (lathe,
 * tube, extrude). Pure: no three.js. The recipe reader, the silhouette compare
 * and the geometry builder all sample through here, so the drawn shape and the
 * scored shape cannot drift apart.
 */

const EPSILON = 1e-9;

/** Fritsch–Butland slope at a knot: zero where the axis turns, otherwise the
 * harmonic mean of the two secants, which is never more than twice either. */
function knotSlope(before, after) {
	if (before === null) return after;
	if (after === null) return before;
	return before * after <= 0 ? 0 : (2 * before * after) / (before + after);
}

/**
 * A smooth curve through `points` (arrays of any length), `steps` samples per
 * segment. Each axis is a monotone cubic: it passes through every point and,
 * between two points, never leaves the box they span. So a profile with r <= 1
 * stays <= 1 and a path inside its box stays inside, with no clamping. A
 * Catmull-Rom spline overshoots instead. `closed` joins the last point back to
 * the first and returns no repeated end sample.
 */
export function monotoneCurve(points, steps, closed = false) {
	const n = points.length;
	const at = (i) => points[closed ? (i + n) % n : i];
	const tangents = points.map((point, k) => point.map((value, axis) => knotSlope(
		closed || k > 0 ? value - at(k - 1)[axis] : null,
		closed || k < n - 1 ? at(k + 1)[axis] - value : null,
	)));
	const out = [];
	for (let segment = 0; segment < (closed ? n : n - 1); segment += 1) {
		const a = at(segment), b = at(segment + 1), ta = tangents[segment], tb = tangents[(segment + 1) % n];
		for (let i = 0; i < steps; i += 1) {
			const t = i / steps, t2 = t * t, t3 = t2 * t;
			const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = 3 * t2 - 2 * t3, h11 = t3 - t2;
			out.push(a.map((value, axis) => h00 * value + h10 * ta[axis] + h01 * b[axis] + h11 * tb[axis]));
		}
	}
	if (!closed) out.push([...points[n - 1]]);
	return out;
}

/** Signed area: positive when the loop runs counter-clockwise. */
export function signedArea(loop) {
	let sum = 0;
	for (let i = 0, j = loop.length - 1; i < loop.length; j = i, i += 1) sum += loop[j][0] * loop[i][1] - loop[i][0] * loop[j][1];
	return sum / 2;
}

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const side = (o, a, b) => {
	const value = cross(o, a, b);
	return Math.abs(value) <= EPSILON ? 0 : Math.sign(value);
};
const within = (a, b, p) => Math.min(a[0], b[0]) - EPSILON <= p[0] && p[0] <= Math.max(a[0], b[0]) + EPSILON
	&& Math.min(a[1], b[1]) - EPSILON <= p[1] && p[1] <= Math.max(a[1], b[1]) + EPSILON;

function segmentsTouch(a, b, c, d) {
	const o1 = side(a, b, c), o2 = side(a, b, d), o3 = side(c, d, a), o4 = side(c, d, b);
	if (o1 !== o2 && o3 !== o4) return true;
	return (o1 === 0 && within(a, b, c)) || (o2 === 0 && within(a, b, d)) || (o3 === 0 && within(c, d, a)) || (o4 === 0 && within(c, d, b));
}

/**
 * The first two edges that touch or cross, across every loop, as
 * `{ a: { loop, edge }, b: { loop, edge } }`, or null when the loops are simple
 * and apart. Neighbouring edges of one loop share a point by design; they only
 * count when the second folds back along the first.
 */
export function loopCrossing(loops) {
	const edges = loops.flatMap((loop, index) => loop.map((p, edge) => ({ loop: index, edge, n: loop.length, a: p, b: loop[(edge + 1) % loop.length] })));
	for (let i = 0; i < edges.length; i += 1) {
		for (let j = i + 1; j < edges.length; j += 1) {
			const e = edges[i], f = edges[j];
			const follows = e.loop === f.loop && (e.edge + 1) % e.n === f.edge;
			const precedes = e.loop === f.loop && (f.edge + 1) % f.n === e.edge;
			let touch;
			if (follows || precedes) {
				const [shared, p, q] = follows ? [e.b, e.a, f.b] : [e.a, e.b, f.a];
				touch = side(shared, p, q) === 0 && (p[0] - shared[0]) * (q[0] - shared[0]) + (p[1] - shared[1]) * (q[1] - shared[1]) > 0;
			} else touch = segmentsTouch(e.a, e.b, f.a, f.b);
			if (touch) return { a: { loop: e.loop, edge: e.edge }, b: { loop: f.loop, edge: f.edge } };
		}
	}
	return null;
}

/** Even-odd test of a point against a closed loop. */
export function insideLoop([x, y], loop) {
	let inside = false;
	for (let i = 0, j = loop.length - 1; i < loop.length; j = i, i += 1) {
		const [xi, yi] = loop[i], [xj, yj] = loop[j];
		if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

/**
 * Ear clipping: index triples covering a simple loop of either winding. n is
 * at most 64, so the quadratic search is cheap. A loop left with only
 * collinear corners is clipped anyway, so the loop always ends.
 */
export function earClip(loop) {
	const ring = loop.map((_, index) => index);
	if (signedArea(loop) < 0) ring.reverse();
	const triangles = [];
	while (ring.length > 3) {
		const corner = (i) => [ring[(i + ring.length - 1) % ring.length], ring[i], ring[(i + 1) % ring.length]];
		let cut = ring.findIndex((_, i) => {
			const [a, b, c] = corner(i).map((k) => loop[k]);
			if (cross(a, b, c) <= EPSILON) return false;
			return !ring.some((k) => !corner(i).includes(k) && cross(a, b, loop[k]) >= 0 && cross(b, c, loop[k]) >= 0 && cross(c, a, loop[k]) >= 0);
		});
		if (cut < 0) cut = 0;
		triangles.push(corner(cut));
		ring.splice(cut, 1);
	}
	triangles.push(ring);
	return triangles;
}
