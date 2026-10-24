/**
 * The rings a `loft` sculpt part is skinned through. Pure: no three.js, so the
 * silhouette compare samples exactly the surface sculpt-geometry draws.
 *
 * A section (sculpt-shapes-loft-convex.js reads them) is either an outline,
 * { y, points: [[x, z]...] }, or a rounded rectangle, { y, w, d, x, z,
 * roundness }; all of it fractions of the part's size. Every section becomes a
 * ring of RING_POINTS samples that starts at its front, on the line through
 * its centroid, and runs the same way round, so sections with different point
 * counts skin without a twist.
 *
 * `smooth` turns an outline into a closed centripetal Catmull-Rom curve and
 * joins sections with a monotone cubic in y. The curve is fitted back into its
 * outline's own extents and the monotone cubic never leaves the range of the
 * sections it joins, so no vertex can overshoot the declared size.
 */

/** Samples per ring. */
const RING_POINTS = 48;
/** Rings per section-to-section span when smooth. */
const SPAN_STEPS = 6;
/** Curve samples per outline edge before resampling. */
const CURVE_STEPS = 8;
/** Segments per rounded corner of a rectangle section. */
const CORNER_STEPS = 6;
/** A corner that turns more than 30 degrees is kept as a sample (cosine). */
const SHARP_TURN = Math.cos(Math.PI / 6);

const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const distance = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Twice the signed area in (x, z): positive runs from +x toward +z. */
export function signedArea(ring) {
	let sum = 0;
	for (let i = 0; i < ring.length; i += 1) {
		const a = ring[i], b = ring[(i + 1) % ring.length];
		sum += a[0] * b[1] - b[0] * a[1];
	}
	return sum;
}

function centroid(ring) {
	let cx = 0, cz = 0;
	for (let i = 0; i < ring.length; i += 1) {
		const a = ring[i], b = ring[(i + 1) % ring.length];
		const cross = a[0] * b[1] - b[0] * a[1];
		cx += (a[0] + b[0]) * cross;
		cz += (a[1] + b[1]) * cross;
	}
	const area = signedArea(ring);
	return [cx / (3 * area), cz / (3 * area)];
}

/** Drops repeated points, including a last point that repeats the first. */
function dedupe(ring) {
	const out = ring.filter((point, i) => i === 0 || distance(point, ring[i - 1]) > 1e-9);
	while (out.length > 1 && distance(out[0], out.at(-1)) <= 1e-9) out.pop();
	return out;
}

/** w by d, centred on (x, z), corners rounded by roundness × half the short side. */
function roundedRect({ w, d, x, z, roundness }) {
	const hx = w / 2, hz = d / 2;
	const r = roundness * Math.min(hx, hz);
	const steps = r > 0 ? CORNER_STEPS : 0;
	const points = [];
	for (const [cx, cz, start] of [[hx - r, hz - r, 0], [r - hx, hz - r, 1], [r - hx, r - hz, 2], [hx - r, r - hz, 3]]) {
		for (let i = 0; i <= steps; i += 1) {
			const angle = (start + (steps ? i / steps : 0.5)) * (Math.PI / 2);
			points.push([x + cx + r * Math.cos(angle), z + cz + r * Math.sin(angle)]);
		}
	}
	return points;
}

/** A closed centripetal Catmull-Rom curve through `points` (three.js's formulation). */
function catmullRom(points) {
	const n = points.length;
	const out = [];
	for (let i = 0; i < n; i += 1) {
		const p0 = points[(i - 1 + n) % n], p1 = points[i], p2 = points[(i + 1) % n], p3 = points[(i + 2) % n];
		let dt1 = Math.sqrt(distance(p1, p2));
		let dt0 = Math.sqrt(distance(p0, p1));
		let dt2 = Math.sqrt(distance(p2, p3));
		if (dt1 < 1e-4) dt1 = 1;
		if (dt0 < 1e-4) dt0 = dt1;
		if (dt2 < 1e-4) dt2 = dt1;
		const axis = (k) => {
			const t1 = ((p1[k] - p0[k]) / dt0 - (p2[k] - p0[k]) / (dt0 + dt1) + (p2[k] - p1[k]) / dt1) * dt1;
			const t2 = ((p2[k] - p1[k]) / dt1 - (p3[k] - p1[k]) / (dt1 + dt2) + (p3[k] - p2[k]) / dt2) * dt1;
			return [p1[k], t1, -3 * p1[k] + 3 * p2[k] - 2 * t1 - t2, 2 * p1[k] - 2 * p2[k] + t1 + t2];
		};
		const cx = axis(0), cz = axis(1);
		for (let s = 0; s < CURVE_STEPS; s += 1) {
			const t = s / CURVE_STEPS;
			out.push([cx[0] + t * (cx[1] + t * (cx[2] + t * cx[3])), cz[0] + t * (cz[1] + t * (cz[2] + t * cz[3]))]);
		}
	}
	return out;
}

const extent = (ring, k) => [Math.min(...ring.map((p) => p[k])), Math.max(...ring.map((p) => p[k]))];

/** Maps the curve's box onto the outline's box. The curve passes through every
 * outline point, so this only ever shrinks it: the extents written are drawn. */
function fitInto(curve, outline) {
	const ranges = [0, 1].map((k) => [extent(curve, k), extent(outline, k)]);
	return curve.map((point) => point.map((value, k) => {
		const [[from0, from1], [to0, to1]] = ranges[k];
		return from1 - from0 > 1e-12 ? to0 + ((value - from0) * (to1 - to0)) / (from1 - from0) : value;
	}));
}

/** The ring rotated to start where the line x = centroid x leaves its front
 * (+z). The rule is its own mirror image, so a mirrored loft pairs the same
 * points across its sections and comes out as the exact reflection. */
function startAtFront(ring) {
	const cx = centroid(ring)[0];
	let best = null;
	for (let i = 0; i < ring.length; i += 1) {
		const a = ring[i], b = ring[(i + 1) % ring.length];
		if ((a[0] - cx) * (b[0] - cx) > 0) continue;
		const t = a[0] === b[0] ? 0 : (cx - a[0]) / (b[0] - a[0]);
		const z = a[1] + (b[1] - a[1]) * t;
		if (!best || z > best.z) best = { i, t, z };
	}
	if (!best) return ring;
	const start = lerp(ring[best.i], ring[(best.i + 1) % ring.length], best.t);
	return dedupe([start, ...ring.slice(best.i + 1), ...ring.slice(0, best.i + 1)]);
}

/** `count` samples spaced evenly by arc length, measured with the ring scaled
 * to a unit box: every rectangle then has its corners at the same fractions
 * whatever its aspect, so a square base meets a thin ridge side to side and
 * the gable stays flat. Each sharp corner then takes the place of its nearest
 * sample, so a box section keeps its edges. */
function resample(ring, count) {
	const n = ring.length;
	const span = [0, 1].map((k) => Math.max(1e-9, extent(ring, k)[1] - extent(ring, k)[0]));
	const lengths = ring.map((point, i) => Math.hypot((ring[(i + 1) % n][0] - point[0]) / span[0], (ring[(i + 1) % n][1] - point[1]) / span[1]));
	const total = lengths.reduce((sum, length) => sum + length, 0);
	const out = [];
	let edge = 0, walked = 0;
	for (let j = 0; j < count; j += 1) {
		const target = (j / count) * total;
		while (edge < n - 1 && walked + lengths[edge] < target) walked += lengths[edge++];
		out.push(lerp(ring[edge], ring[(edge + 1) % n], lengths[edge] > 0 ? Math.min(1, (target - walked) / lengths[edge]) : 0));
	}
	const taken = new Set();
	walked = 0;
	ring.forEach((point, i) => {
		const before = ring[(i - 1 + n) % n], after = ring[(i + 1) % n];
		const turn = ((point[0] - before[0]) * (after[0] - point[0]) + (point[1] - before[1]) * (after[1] - point[1])) / (distance(before, point) * distance(point, after));
		const k = Math.round((walked / total) * count) % count;
		if (turn < SHARP_TURN && !taken.has(k)) {
			taken.add(k);
			out[k] = point;
		}
		walked += lengths[i];
	});
	return out;
}

/** One section as RING_POINTS [x, z] fractions, wound the way LoftGeometry
 * faces outward (negative signed area in x, z). */
function sectionRing(section, smooth) {
	const outline = section.points ?? roundedRect(section);
	let ring = dedupe(section.points && smooth ? fitInto(catmullRom(outline), outline) : outline);
	if (signedArea(ring) > 0) ring = ring.slice().reverse();
	return resample(startAtFront(ring), RING_POINTS);
}

/** Fritsch-Carlson tangents: Catmull-Rom slopes, limited so each span stays
 * monotone and the curve never passes its two end values. */
function monotoneSlopes(ys, values) {
	const n = ys.length;
	const delta = values.slice(1).map((value, k) => (value - values[k]) / (ys[k + 1] - ys[k]));
	const slopes = values.map((_, k) => (k === 0 ? delta[0] : k === n - 1 ? delta[n - 2] : delta[k - 1] * delta[k] <= 0 ? 0 : (delta[k - 1] + delta[k]) / 2));
	delta.forEach((d, k) => {
		if (d === 0) {
			slopes[k] = 0;
			slopes[k + 1] = 0;
			return;
		}
		const a = slopes[k] / d, b = slopes[k + 1] / d, s = a * a + b * b;
		if (s > 9) {
			slopes[k] = (3 * a * d) / Math.sqrt(s);
			slopes[k + 1] = (3 * b * d) / Math.sqrt(s);
		}
	});
	return slopes;
}

function hermite(y0, y1, v0, v1, m0, m1, y) {
	const h = y1 - y0, t = (y - y0) / h, t2 = t * t, t3 = t2 * t;
	return (2 * t3 - 3 * t2 + 1) * v0 + (t3 - 2 * t2 + t) * h * m0 + (-2 * t3 + 3 * t2) * v1 + (t3 - t2) * h * m1;
}

/**
 * The loft's rings, bottom to top, as [x, y, z] metres in the part's frame,
 * plus `at`: the index of the ring each authored section became.
 */
export function loftRings(part) {
	const [sx, sy, sz] = part.size;
	const ys = part.sections.map((section) => section.y);
	const sections = part.sections.map((section) => sectionRing(section, part.smooth));
	const levels = [];
	const at = [];
	if (!part.smooth) {
		sections.forEach((ring, k) => { at.push(levels.length); levels.push({ y: ys[k], ring }); });
	} else {
		const slopes = sections[0].map((_, j) => [0, 1].map((axis) => monotoneSlopes(ys, sections.map((ring) => ring[j][axis]))));
		for (let k = 0; k < ys.length; k += 1) {
			at.push(levels.length);
			levels.push({ y: ys[k], ring: sections[k] });
			if (k === ys.length - 1) break;
			for (let s = 1; s < SPAN_STEPS; s += 1) {
				const y = ys[k] + ((ys[k + 1] - ys[k]) * s) / SPAN_STEPS;
				levels.push({ y, ring: sections[k].map((_, j) => [0, 1].map((axis) => hermite(ys[k], ys[k + 1], sections[k][j][axis], sections[k + 1][j][axis], slopes[j][axis][k], slopes[j][axis][k + 1], y))) });
			}
		}
	}
	const rings = levels.map(({ y, ring }) => ring.map(([x, z]) => [x * sx, (y - 0.5) * sy, z * sz]));
	return { rings, at };
}
