// The ground under a foot: the floor (y 0) or the top of a scene obstacle the sole stands on.
// Every ground measurement reads sole heights from here: QA's air runs, FLOAT and balance
// (style.js), SLIDE (checks.js), the timeline's planted runs, and the fixes that keep to QA's
// planted definition (fix/slide.js, fix/turn.js). A foot on a box top is then on the ground as one
// on the floor is. Session 68d305dc: a foot on a 0.7 m cube read as "no foot on the ground"
// (FLOAT n57), and naming the cube in checks.supports did not clear it (a support rests the hips).
// The obstacles are out.objectsAt(i): carried and follow objects are not ground, a hinge is at its
// turned pose. GROUND (a sole under the floor) and fix.ground stay on the floor.
import { T, apply, sub, len } from "../compiler/math.js";
import { solePoints } from "./geometry.js";

/** A top up to this far (m) above a sole point is still the ground under it: a sole sunk into a top stands on it. */
const SINK = 0.05;

const prepared = new WeakMap();

/** The obstacle boxes of one frame's map, with what the vertical-line test needs. */
function boxesOf(objs) {
	let list = prepared.get(objs);
	if (!list) {
		list = Object.values(objs).filter(box => box.half && !box.ignore).map(box => {
			const RT = T(box.R), c = [box.pos[0] + box.R[0][1] * box.half[1], box.pos[1] + box.R[1][1] * box.half[1], box.pos[2] + box.R[2][1] * box.half[1]];
			return { RT, c, half: box.half, up: [box.R[1][0], box.R[1][1], box.R[1][2]], r: len(box.half) };
		});
		prepared.set(objs, list);
	}
	return list;
}

/** Height of the box's top on the vertical line through p (any rotation), or null when the line misses it. */
function topOver(b, p) {
	if (Math.hypot(p[0] - b.c[0], p[2] - b.c[2]) > b.r) return null;
	const q = apply(b.RT, sub(p, b.c));
	let lo = -Infinity, hi = Infinity;
	for (let k = 0; k < 3; k++) {
		const d = b.up[k], h = b.half[k];
		if (Math.abs(d) < 1e-9) { if (Math.abs(q[k]) > h) return null; continue; }
		const t1 = (-h - q[k]) / d, t2 = (h - q[k]) / d;
		lo = Math.max(lo, Math.min(t1, t2));
		hi = Math.min(hi, Math.max(t1, t2));
	}
	return lo <= hi ? p[1] + hi : null;
}

/** World height of the ground under point p at frame index i of out (out.frames[i]). */
export function groundY(out, i, p) {
	let g = 0;
	for (const b of boxesOf(out.objectsAt(i))) {
		const top = topOver(b, p);
		if (top !== null && top <= p[1] + SINK && top > g) g = top;
	}
	return g;
}

/**
 * solePoints of frame index i with y the height above the ground under each point (x, z are world);
 * ground: { heel, ball, tip }, the ground heights those were measured from.
 */
export function groundSole(out, i, side) {
	const sp = solePoints(out.ctx.sk, out.frames[i].s, side), ground = {};
	for (const key of ["heel", "ball", "tip"]) {
		ground[key] = groundY(out, i, sp[key]);
		sp[key] = [sp[key][0], sp[key][1] - ground[key], sp[key][2]];
	}
	sp.ground = ground;
	return sp;
}
