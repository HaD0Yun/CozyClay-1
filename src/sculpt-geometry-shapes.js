/**
 * Geometry for the sculpt shapes that follow points (sculpt-shapes-curved.js):
 * lathe, tube and extrude, each one indexed mesh with a uv in metres, so a
 * texture keeps one scale across parts of different sizes.
 *
 * Normals are welded per piece: inside a piece, every vertex at one position
 * shares one normal (a lathe's seam, a tube's round end); between pieces they
 * stay apart, so a pot's bottom edge and a sign's face edge stay crisp. Like
 * every sculpt shape, nothing is drawn outside the part's declared size.
 */

import * as THREE from "three";
import { signedArea } from "./sculpt-curve.js";
import { latheRows, tubeCentre, tubeRadii } from "./sculpt-shapes-curved.js";

const AROUND = 48;
const TUBE_SIDES = 20;
const CAP_ROWS = 6;
const BEVEL_ROWS = 4;
/** An outline corner that turns more than this keeps a hard edge on the side wall. */
const CREASE = (35 * Math.PI) / 180;

const sub = (a, b) => a.map((value, axis) => value - b[axis]);
const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => {
	const length = Math.hypot(...v);
	return length > 1e-12 ? v.map((value) => value / length) : null;
};
const clamp = (value, limit) => Math.min(limit, Math.max(-limit, value));

class Pieces {
	constructor() {
		this.position = [];
		this.uv = [];
		this.index = [];
		this.weld = [];
	}

	/** A rows × cols piece from `at(row, col)` → [x, y, z, u, v]. The column step
	 * crossed with the row step must point out of the solid. */
	grid(rows, cols, at) {
		const keys = new Map();
		const ids = [];
		for (let i = 0; i < rows; i += 1) for (let j = 0; j < cols; j += 1) ids.push(this.vertex(keys, at(i, j)));
		for (let i = 0; i + 1 < rows; i += 1) {
			for (let j = 0; j + 1 < cols; j += 1) {
				const a = ids[i * cols + j], b = ids[i * cols + j + 1], c = ids[(i + 1) * cols + j], d = ids[(i + 1) * cols + j + 1];
				this.index.push(a, b, c, b, d, c);
			}
		}
	}

	/** A flat piece: points [x, y, z, u, v] and triangles over them, wound outward. */
	fan(points, triangles) {
		const keys = new Map();
		const ids = points.map((point) => this.vertex(keys, point));
		for (const triangle of triangles) this.index.push(...triangle.map((k) => ids[k]));
	}

	vertex(keys, [x, y, z, u, v]) {
		const id = this.position.length / 3;
		const key = `${x},${y},${z}`;
		if (!keys.has(key)) keys.set(key, id);
		this.weld.push(keys.get(key));
		this.position.push(x, y, z);
		this.uv.push(u, v);
		return id;
	}

	/** Area-weighted face normals, summed on each welded position. */
	build() {
		const p = this.position, sum = new Float64Array(p.length);
		for (let t = 0; t < this.index.length; t += 3) {
			const [a, b, c] = [0, 1, 2].map((k) => this.index[t + k]);
			const corner = (k) => [p[k * 3], p[k * 3 + 1], p[k * 3 + 2]];
			const normal = cross(sub(corner(b), corner(a)), sub(corner(c), corner(a)));
			for (const k of [a, b, c]) for (let axis = 0; axis < 3; axis += 1) sum[this.weld[k] * 3 + axis] += normal[axis];
		}
		const normals = new Float32Array(p.length);
		this.weld.forEach((w, i) => {
			const n = unit([sum[w * 3], sum[w * 3 + 1], sum[w * 3 + 2]]) ?? [0, 1, 0];
			normals.set(n, i * 3);
		});
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
		geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
		geometry.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
		geometry.setIndex(this.index);
		return geometry;
	}
}

/** The profile turned round y with an elliptical section; caps close the ends
 * that stand off the axis, so a pot has a bottom. */
export function latheGeometry(part) {
	const [hx, , hz] = part.size.map((value) => value / 2);
	const rows = latheRows(part, Math.min(12, Math.ceil(120 / (part.profile.length - 1))));
	const arc = [0];
	for (let k = 1; k < rows.length; k += 1) arc.push(arc[k - 1] + Math.hypot(((rows[k][0] - rows[k - 1][0]) * (hx + hz)) / 2, rows[k][1] - rows[k - 1][1]));
	// `j % AROUND` makes the seam column the very same numbers as the first, so it welds.
	const ring = ([r, y], j) => {
		const angle = ((j % AROUND) / AROUND) * 2 * Math.PI;
		return [r * hx * Math.sin(angle), y, r * hz * Math.cos(angle)];
	};
	const mesh = new Pieces();
	const wall = (from, to) => mesh.grid(to - from + 1, AROUND + 1, (i, j) => [...ring(rows[from + i], j), (j / AROUND) * Math.PI * (hx + hz), arc[from + i]]);
	if (part.smooth) wall(0, rows.length - 1);
	else for (let k = 0; k + 1 < rows.length; k += 1) wall(k, k + 1);
	const cap = (rim, top) => {
		const order = top ? [rim, [0, rim[1]]] : [[0, rim[1]], rim];
		mesh.grid(2, AROUND + 1, (i, j) => {
			const point = ring(order[i], j);
			return [...point, point[0], point[2]];
		});
	};
	if (rows[0][0] > 0) cap(rows[0], false);
	if (rows.at(-1)[0] > 0) cap(rows.at(-1), true);
	return mesh.build();
}

/** Parallel-transport frames: the ring does not twist where the path bends. On
 * a loop the leftover twist is spread along it, so the seam meets itself. */
function tubeFrames(tangents, closed) {
	const across = (t) => unit(cross(t, Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
	let normal = across(tangents[0]);
	const frames = tangents.map((t) => {
		normal = unit(sub(normal, t.map((value) => value * dot(normal, t)))) ?? across(t);
		return [normal, cross(t, normal)];
	});
	if (!closed) return frames;
	const [n0, b0] = frames[0], t0 = tangents[0], last = frames.at(-1)[0];
	const end = unit(sub(last, t0.map((value) => value * dot(last, t0)))) ?? n0;
	const twist = Math.atan2(dot(end, b0), dot(end, n0));
	return frames.map(([n, b], k) => {
		const angle = (-twist * k) / frames.length;
		const turned = n.map((value, axis) => Math.cos(angle) * value + Math.sin(angle) * b[axis]);
		return [turned, cross(tangents[k], turned)];
	});
}

/** A round tube along the path; an open one ends in half-balls. */
export function tubeGeometry(part) {
	const segments = part.closed ? part.path.length : part.path.length - 1;
	const centre = tubeCentre(part, Math.min(24, Math.max(4, Math.ceil(128 / segments))));
	const radii = tubeRadii(part, centre);
	const n = centre.length;
	const near = (k) => centre[part.closed ? (k + n) % n : Math.min(n - 1, Math.max(0, k))];
	let previous = [0, 1, 0];
	const tangents = centre.map((_, k) => (previous = unit(sub(near(k + 1), near(k - 1))) ?? previous));
	const frames = tubeFrames(tangents, part.closed);
	const run = [0];
	for (let k = 1; k < n; k += 1) run.push(run[k - 1] + Math.hypot(...sub(centre[k], centre[k - 1])));
	const rows = centre.map((c, k) => ({ c, r: radii[k], frame: frames[k], u: run[k] }));
	if (part.closed) rows.push({ ...rows[0], u: run[n - 1] + Math.hypot(...sub(centre[0], centre[n - 1])) });
	else {
		// Rows of a half-ball from the pole to just short of the end ring.
		const cap = (k, sign) => Array.from({ length: CAP_ROWS }, (_, i) => {
			const angle = (((CAP_ROWS - i) / CAP_ROWS) * Math.PI) / 2;
			const reach = radii[k] * Math.sin(angle);
			return { c: centre[k].map((value, axis) => value + sign * tangents[k][axis] * reach), r: i ? radii[k] * Math.cos(angle) : 0, frame: frames[k], u: run[k] + sign * reach };
		});
		rows.unshift(...cap(0, -1));
		rows.push(...cap(n - 1, 1).reverse());
	}
	const mesh = new Pieces();
	mesh.grid(rows.length, TUBE_SIDES + 1, (i, j) => {
		const { c, r, frame: [normal, binormal], u } = rows[i];
		const angle = ((j % TUBE_SIDES) / TUBE_SIDES) * 2 * Math.PI;
		const cos = Math.cos(angle), sin = Math.sin(angle);
		return [...c.map((value, axis) => value + r * (cos * normal[axis] + sin * binormal[axis])), u, (j / TUBE_SIDES) * Math.PI * part.thickness];
	});
	return mesh.build();
}

/** Each corner's inward offset per metre of inset (a mitre, capped at 2× so a
 * spike cannot shoot far); the solid is on every loop's left. */
function mitres(loop) {
	const left = (a, b) => unit([a[1] - b[1], b[0] - a[0]]);
	return loop.map((p, i) => {
		const n1 = left(loop[(i + loop.length - 1) % loop.length], p), n2 = left(p, loop[(i + 1) % loop.length]);
		const m = unit([n1[0] + n2[0], n1[1] + n2[1]]) ?? n1;
		const scale = 1 / Math.max(0.5, dot(m, n1));
		return [m[0] * scale, m[1] * scale];
	});
}

/** The deepest inset before an edge of the loop turns round, which is where a
 * thin spike would fold through itself. */
function insetLimit(loop, offsets) {
	return loop.reduce((limit, p, i) => {
		const k = (i + 1) % loop.length, edge = sub(loop[k], p), shrink = dot(sub(offsets[k], offsets[i]), edge);
		return shrink < 0 ? Math.min(limit, -dot(edge, edge) / shrink) : limit;
	}, Infinity);
}

/** The outline pushed through size z, with an optional rounded bevel and holes. */
export function extrudeGeometry(part) {
	const [hx, hy, hz] = part.size.map((value) => value / 2);
	const metres = (loop, ccw) => {
		const points = loop.map(([x, y]) => [x * part.size[0], y * part.size[1]]);
		return signedArea(points) > 0 === ccw ? points : points.reverse();
	};
	const loops = [metres(part.outline, true), ...(part.holes ?? []).map((hole) => metres(hole, false))];
	const span = (axis) => Math.max(...loops[0].map((p) => p[axis])) - Math.min(...loops[0].map((p) => p[axis]));
	const bevel = (part.roundness * Math.min(part.size[2], span(0), span(1))) / 2;
	const offsets = loops.map(mitres);
	// Star points and thin arms take a shallower inset than the bevel's depth, so the face never folds.
	const inset = Math.min(bevel, 0.5 * Math.min(...loops.map((loop, l) => insetLimit(loop, offsets[l]))));
	// The side's section [inset, z] from the back face round to the front face.
	const quarter = Array.from({ length: bevel > 0 ? BEVEL_ROWS + 1 : 1 }, (_, i) => {
		const angle = (i / BEVEL_ROWS) * (Math.PI / 2);
		return [inset * (1 - Math.sin(angle)), hz - bevel * (1 - Math.cos(angle))];
	});
	const back = quarter.map(([offset, z]) => [offset, -z]), front = [...quarter].reverse();
	const section = back.at(-1)[1] === front[0][1] ? [...back, ...front.slice(1)] : [...back, ...front];
	// A deep bevel on a thin spike can push a mitre past the outline; the clamp keeps the box honest.
	const at = (l, i, depth) => [clamp(loops[l][i][0] + offsets[l][i][0] * depth, hx), clamp(loops[l][i][1] + offsets[l][i][1] * depth, hy)];
	const mesh = new Pieces();
	loops.forEach((loop, l) => {
		const n = loop.length;
		const along = [0];
		for (let i = 1; i <= n; i += 1) along.push(along[i - 1] + Math.hypot(...sub(loop[i % n], loop[i - 1])));
		const corners = loop.flatMap((p, i) => {
			const turn = Math.acos(Math.max(-1, Math.min(1, dot(unit(sub(p, loop[(i + n - 1) % n])), unit(sub(loop[(i + 1) % n], p))))));
			return turn > CREASE ? [i] : [];
		});
		const runs = corners.length ? corners.map((from, k) => [from, k + 1 < corners.length ? corners[k + 1] : corners[0] + n]) : [[0, n]];
		for (const [from, to] of runs) {
			mesh.grid(section.length, to - from + 1, (i, j) => {
				const k = from + j;
				return [...at(l, k % n, section[i][0]), section[i][1], along[k % n] + (k >= n ? along[n] : 0), section[i][1]];
			});
		}
	});
	const flat = loops.flatMap((loop, l) => loop.map((_, i) => [l, i]));
	const vectors = loops.map((loop) => loop.map(([x, y]) => new THREE.Vector2(x, y)));
	const faces = THREE.ShapeUtils.triangulateShape(vectors[0], vectors.slice(1)).map((face) => {
		const [a, b, c] = face.map((k) => loops[flat[k][0]][flat[k][1]]);
		return signedArea([a, b, c]) >= 0 ? face : [face[0], face[2], face[1]];
	});
	for (const sign of [1, -1]) {
		const points = flat.map(([l, i]) => {
			const [x, y] = at(l, i, inset);
			return [x, y, sign * hz, x, y];
		});
		mesh.fan(points, sign > 0 ? faces : faces.map(([a, b, c]) => [a, c, b]));
	}
	return mesh.build();
}
