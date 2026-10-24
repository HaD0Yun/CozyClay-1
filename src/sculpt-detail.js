/**
 * Surface detail: a part's `detail` (sculpt-surface-fields.js) turns a smooth
 * primitive into a lumpy cloud, bush, rock or loaf by pushing its surface out
 * along the normals with seeded, billowed fBm noise (|fBm|: rounded lumps with
 * creases between them, which reads as puffs or stone where plain fBm reads as
 * a dented ball). It is a post-process on any part's
 * BufferGeometry, so a shape added later gets it without a line of its own.
 *
 * - Bounds: the base is shrunk by the bump height first and no vertex then
 *   moves further than that, so the lumps end inside the declared size and
 *   the record's measured box (which trusts size) still holds.
 * - Seams: vertices are welded by position before anything moves, so both
 *   sides of a sphere's seam (or a box's edge) move together and never split.
 * - Tessellation: a box or a one-segment cylinder has too few vertices to
 *   show a bump, so long edges are halved until they are a fraction of a bump.
 *   The split test reads only the edge, so both triangles on an edge agree
 *   and no T-junction cracks open once the surface moves.
 */

import * as THREE from "three";
import { DETAIL_RELIEF } from "./sculpt-surface-fields.js";
import { fbm3, isMirrorCopy, partSeed, seededRandom } from "./sculpt-noise.js";

/** A detailed part stops splitting edges past this many triangles. */
const MAX_TRIANGLES = 40000;
/** Edges are split until a bump spans about this many of them. */
const EDGES_PER_BUMP = 5;
/** Faces meeting more sharply than this stay creased (a box edge); lumps shade smooth. */
const CREASE_COS = Math.cos((65 * Math.PI) / 180);

/** Vertex → id shared by every vertex at the same position (within `eps`), via
 * an open-addressed table on the quantized position. */
function weld(position, eps) {
	const count = position.length / 3;
	const ids = new Int32Array(count);
	let size = 1;
	while (size < count * 2) size <<= 1;
	const table = new Int32Array(size).fill(-1);
	const keys = new Int32Array(count * 3);
	let unique = 0;
	for (let i = 0; i < count; i += 1) {
		const qx = Math.round(position[3 * i] / eps), qy = Math.round(position[3 * i + 1] / eps), qz = Math.round(position[3 * i + 2] / eps);
		let slot = (Math.imul(qx, 73856093) ^ Math.imul(qy, 19349663) ^ Math.imul(qz, 83492791)) & (size - 1);
		for (;;) {
			const id = table[slot];
			if (id < 0) {
				table[slot] = unique;
				keys[3 * unique] = qx; keys[3 * unique + 1] = qy; keys[3 * unique + 2] = qz;
				ids[i] = unique++;
				break;
			}
			if (keys[3 * id] === qx && keys[3 * id + 1] === qy && keys[3 * id + 2] === qz) {
				ids[i] = id;
				break;
			}
			slot = (slot + 1) & (size - 1);
		}
	}
	return { ids, count: unique };
}

/** Local corners per split mask (bit 0 = edge ab, 1 = bc, 2 = ca); 3, 4, 5 are
 * the midpoints of ab, bc, ca. Every pattern keeps the source winding. */
const PATTERNS = [
	[0, 1, 2],
	[0, 3, 2, 3, 1, 2],
	[1, 4, 0, 4, 2, 0],
	[3, 1, 4, 0, 3, 4, 0, 4, 2],
	[2, 5, 1, 5, 0, 1],
	[5, 0, 3, 2, 5, 3, 2, 3, 1],
	[4, 2, 5, 1, 4, 5, 1, 5, 0],
	[0, 3, 5, 3, 1, 4, 5, 4, 2, 3, 4, 5],
];

/** Non-indexed attributes ([position, ...others]) with every edge longer
 * than `maxEdge` halved, pass by pass, within MAX_TRIANGLES. */
function subdivide(attributes, maxEdge) {
	const limit = maxEdge * maxEdge;
	for (let pass = 0; pass < 10; pass += 1) {
		const position = attributes[0].array;
		const triangles = position.length / 9;
		const masks = new Uint8Array(triangles);
		let next = 0;
		for (let t = 0; t < triangles; t += 1) {
			for (let e = 0; e < 3; e += 1) {
				const a = 9 * t + 3 * e, b = 9 * t + 3 * ((e + 1) % 3);
				const dx = position[a] - position[b], dy = position[a + 1] - position[b + 1], dz = position[a + 2] - position[b + 2];
				if (dx * dx + dy * dy + dz * dz > limit) masks[t] |= 1 << e;
			}
			next += PATTERNS[masks[t]].length / 3;
		}
		if (next === triangles || next > MAX_TRIANGLES) break;
		attributes = attributes.map(({ name, size, array }) => {
			const out = new Float64Array(next * 3 * size);
			let o = 0;
			for (let t = 0; t < triangles; t += 1) {
				const base = 3 * t * size;
				for (const corner of PATTERNS[masks[t]]) {
					// (a + b) / 2 is the same bits from either side, so neighbours share the midpoint exactly.
					const a = corner < 3 ? corner : corner - 3, b = corner < 3 ? corner : (corner - 2) % 3;
					for (let k = 0; k < size; k += 1) out[o++] = (array[base + a * size + k] + array[base + b * size + k]) / 2;
				}
			}
			return { name, size, array: out };
		});
	}
	return attributes;
}

/** Area-weighted (unnormalized) normal of every triangle. */
function faceNormals(position) {
	const normals = new Float64Array(position.length / 3);
	for (let f = 0; f < position.length; f += 9) {
		const ax = position[f + 3] - position[f], ay = position[f + 4] - position[f + 1], az = position[f + 5] - position[f + 2];
		const bx = position[f + 6] - position[f], by = position[f + 7] - position[f + 1], bz = position[f + 8] - position[f + 2];
		normals[f / 3] = ay * bz - az * by;
		normals[f / 3 + 1] = az * bx - ax * bz;
		normals[f / 3 + 2] = ax * by - ay * bx;
	}
	return normals;
}

/** Per-vertex normals: the faces around the welded vertex that meet the
 * vertex's own face within the crease angle, area-weighted. */
function creasedNormals(position, ids, count) {
	const faces = faceNormals(position);
	const unit = faces.map((value, i) => value / (Math.hypot(faces[i - (i % 3)], faces[i - (i % 3) + 1], faces[i - (i % 3) + 2]) || 1));
	const start = new Int32Array(count + 1);
	for (const id of ids) start[id + 1] += 1;
	for (let id = 0; id < count; id += 1) start[id + 1] += start[id];
	const fill = start.slice(0, count), around = new Int32Array(ids.length);
	ids.forEach((id, v) => { around[fill[id]++] = Math.floor(v / 3); });
	const normals = new Float32Array(position.length);
	for (let v = 0; v < ids.length; v += 1) {
		const own = 3 * Math.floor(v / 3);
		const flat = unit[own] === 0 && unit[own + 1] === 0 && unit[own + 2] === 0;
		let x = 0, y = 0, z = 0;
		for (let k = start[ids[v]]; k < start[ids[v] + 1]; k += 1) {
			const g = 3 * around[k];
			if (!flat && unit[g] * unit[own] + unit[g + 1] * unit[own + 1] + unit[g + 2] * unit[own + 2] < CREASE_COS) continue;
			x += faces[g]; y += faces[g + 1]; z += faces[g + 2];
		}
		const length = Math.hypot(x, y, z);
		if (length > 0) normals.set([x / length, y / length, z / length], 3 * v);
		else normals[3 * v + 1] = 1;
	}
	return normals;
}

/**
 * The part's geometry with its `detail` applied, or the geometry untouched
 * when the part has none. The result is non-indexed and keeps every other
 * attribute (uv, colour), interpolated where edges were split.
 */
export function applySculptDetail(geometry, part) {
	const amount = part.detail?.amount ?? 0;
	if (!(amount > 0)) return geometry;
	const half = part.size.map((value) => value / 2);
	const longest = Math.max(...part.size);
	const relief = amount * DETAIL_RELIEF * Math.min(...half);
	geometry.scale(...half.map((h) => (h - relief) / h));
	const source = geometry.index ? geometry.toNonIndexed() : geometry;
	const names = ["position", ...Object.keys(source.attributes).filter((name) => name !== "position" && name !== "normal")];
	let attributes = names.map((name) => ({ name, size: source.attributes[name].itemSize, array: Float64Array.from(source.attributes[name].array) }));
	geometry.dispose();
	source.dispose();
	// Snap every vertex onto its welded twin so split decisions and midpoints match bit for bit.
	const eps = longest * 1e-5;
	let { ids, count } = weld(attributes[0].array, eps);
	const first = new Int32Array(count).fill(-1);
	ids.forEach((id, v) => {
		if (first[id] < 0) first[id] = v;
		else for (let k = 0; k < 3; k += 1) attributes[0].array[3 * v + k] = attributes[0].array[3 * first[id] + k];
	});
	attributes = subdivide(attributes, longest / part.detail.scale / EDGES_PER_BUMP);
	const position = attributes[0].array;
	({ ids, count } = weld(position, eps));
	const faces = faceNormals(position);
	const normal = new Float64Array(count * 3);
	ids.forEach((id, v) => {
		const f = 3 * Math.floor(v / 3);
		for (let k = 0; k < 3; k += 1) normal[3 * id + k] += faces[f + k];
	});
	// Noise per welded vertex. A mirrored copy reads it at −x, so it lumps as its source's reflection.
	const seed = partSeed(part, part.detail.seed);
	const random = seededRandom(seed);
	const offset = [random() * 64, random() * 64, random() * 64];
	const frequency = part.detail.scale / longest, flip = isMirrorCopy(part) ? -1 : 1;
	const lift = new Float64Array(count).fill(NaN);
	ids.forEach((id, v) => {
		if (Number.isNaN(lift[id])) lift[id] = Math.abs(fbm3(flip * position[3 * v] * frequency + offset[0], position[3 * v + 1] * frequency + offset[1], position[3 * v + 2] * frequency + offset[2], seed));
	});
	let low = Infinity, high = -Infinity;
	for (const value of lift) { low = Math.min(low, value); high = Math.max(high, value); }
	// Rescaled to 0..1, so the highest lump reaches the declared size and the deepest stays on the shrunk base.
	const span = high - low || 1;
	ids.forEach((id, v) => {
		const n = 3 * id, length = Math.hypot(normal[n], normal[n + 1], normal[n + 2]);
		if (!(length > 0)) return;
		const push = (relief * (lift[id] - low)) / span / length;
		for (let k = 0; k < 3; k += 1) position[3 * v + k] += normal[n + k] * push;
	});
	const detailed = new THREE.BufferGeometry();
	for (const { name, size, array } of attributes) detailed.setAttribute(name, new THREE.BufferAttribute(Float32Array.from(array), size));
	detailed.setAttribute("normal", new THREE.BufferAttribute(creasedNormals(position, ids, count), 3));
	return detailed;
}
