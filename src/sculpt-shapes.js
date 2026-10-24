/**
 * Per-shape rules for sculpt recipes: the keys a shape takes and how they are
 * read, how a mirrored copy reflects the shape's own data, and the local
 * points the silhouette compare hulls. Pure: no three.js.
 *
 * A new shape is one entry here plus a builder in sculpt-geometry.js (a
 * geometry builder, or a mesh builder for an instanced shape like scatter).
 * The shapes that follow points (lathe, tube, extrude) live in sculpt-shapes-curved.js.
 *
 *   keys     shape-only part keys; any other shape refuses them
 *   read     (raw, part, where) fills the normalized part's shape fields
 *   mirror   (copy) optional: reflect shape data across the part's own x = 0,
 *            for shapes that are not symmetric about their own x
 *   samples  (part) local sample points, as groups; each group is hulled
 *            separately, so a bent shape can stay concave in silhouette
 *   hole     (part) optional: the local front-face outline of a see-through hole
 */

import { RecipeError, isFiniteNumber, readUnit, tidy } from "./sculpt-recipe-read.js";
import { LOFT_CONVEX_SPECS } from "./sculpt-shapes-loft-convex.js";
import { CURVED_SHAPE_SPECS } from "./sculpt-shapes-curved.js";
import { SCATTER_SHAPE } from "./sculpt-scatter-shape.js";

/** How far a full taper narrows a blob's end; sculpt-geometry.js draws the same. */
export const BLOB_TAPER = 0.6;

const half = (part) => part.size.map((value) => value / 2);

/** Sample rings from bottom (v = −1) to top (v = 1), `point(v, t)` per ring. */
function rings(point) {
	const points = [];
	for (let i = 0; i <= 16; i += 1) {
		const v = -1 + (2 * i) / 16;
		for (let j = 0; j < 24; j += 1) points.push(...point(v, (j / 24) * 2 * Math.PI));
	}
	return points;
}

function blobSamples(part) {
	const [sx, sy, sz] = half(part);
	const p = 2 + 6 * part.roundness;
	const taper = part.taper;
	return [rings((v, t) => {
		const k = taper > 0 ? 1 - taper * BLOB_TAPER * ((v + 1) / 2) : taper < 0 ? 1 + taper * BLOB_TAPER * ((1 - v) / 2) : 1;
		const ring = Math.max(0, 1 - Math.abs(v) ** p) ** (1 / p);
		const c = Math.cos(t), s = Math.sin(t);
		const norm = (Math.abs(c) ** p + Math.abs(s) ** p) ** (1 / p);
		return [[(c / norm) * sx * ring * k, v * sy, (s / norm) * sz * ring * k]];
	})];
}

function boxSamples(part) {
	const [sx, sy, sz] = half(part);
	const points = [];
	for (const x of [-sx, sx]) for (const y of [-sy, sy]) for (const z of [-sz, sz]) points.push([x, y, z]);
	return [points];
}

function cylinderSamples(part) {
	const [sx, sy, sz] = half(part);
	return [rings((v, t) => {
		const r = 1 - Math.max(0, part.taper) * ((v + 1) / 2) - Math.max(0, -part.taper) * ((1 - v) / 2);
		return [[Math.cos(t) * sx * r, v * sy, Math.sin(t) * sz * r]];
	})];
}

function ringSamples(part) {
	const [sx, sy, sz] = half(part);
	return [rings((v, t) => {
		const points = [[Math.cos(t) * sx, Math.sin(t) * sy, v * sz]];
		if (part.shape === "frame") points.push([Math.sign(Math.cos(t)) * sx, Math.sign(Math.sin(t)) * sy, v * sz]);
		return points;
	})];
}

/** The opening of a torus or frame, as the four corners of its front face. */
function ringHole(part) {
	const inset = part.shape === "frame" ? part.border : part.size[2];
	const ix = part.size[0] / 2 - inset, iy = part.size[1] / 2 - inset;
	if (ix <= 0 || iy <= 0) return null;
	const z = -part.size[2] / 2;
	return [[-ix, -iy, z], [ix, -iy, z], [ix, iy, z], [-ix, iy, z]];
}

export const SCULPT_SHAPE_SPECS = Object.freeze({
	blob: {
		keys: ["roundness", "taper"],
		read(raw, part, where) {
			part.roundness = readUnit(raw.roundness, `${where}.roundness`, 0.5, 0, 1);
			part.taper = readUnit(raw.taper, `${where}.taper`, 0, -1, 1);
		},
		samples: blobSamples,
	},
	box: {
		keys: ["roundness"],
		read(raw, part, where) {
			part.roundness = readUnit(raw.roundness, `${where}.roundness`, 0.1, 0, 1);
		},
		samples: boxSamples,
	},
	cylinder: {
		keys: ["taper"],
		read(raw, part, where) {
			part.taper = readUnit(raw.taper, `${where}.taper`, 0, -1, 1);
		},
		samples: cylinderSamples,
	},
	torus: {
		keys: [],
		read(raw, part, where) {
			if (part.size[2] >= Math.min(part.size[0], part.size[1])) {
				throw new RecipeError(`${where}.size`, "a torus's tube (size[2]) must be thinner than its outer diameter");
			}
		},
		samples: ringSamples,
		hole: ringHole,
	},
	frame: {
		keys: ["border"],
		read(raw, part, where) {
			const limit = Math.min(part.size[0], part.size[1]) / 2;
			const border = raw.border === undefined ? tidy(Math.min(part.size[0], part.size[1]) * 0.15) : raw.border;
			if (!isFiniteNumber(border) || border <= 0 || border >= limit) {
				throw new RecipeError(`${where}.border`, `must be above 0 and below half the frame's smaller side (${tidy(limit)} m), got ${JSON.stringify(raw.border)}`);
			}
			part.border = tidy(border);
		},
		samples: ringSamples,
		hole: ringHole,
	},
	...CURVED_SHAPE_SPECS,
	...LOFT_CONVEX_SPECS,
	scatter: SCATTER_SHAPE,
});

export const SCULPT_SHAPES = Object.freeze(Object.keys(SCULPT_SHAPE_SPECS));
/** Every shape-only key, in first-seen order. */
export const SCULPT_SHAPE_KEYS = Object.freeze([...new Set(Object.values(SCULPT_SHAPE_SPECS).flatMap((spec) => spec.keys))]);
