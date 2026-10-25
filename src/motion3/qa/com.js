// Balance measurements on one frame's pose: the mass-weighted centre of mass of the body and the
// support polygon of the feet on the ground. QA's BALANCE check and observations.balance
// (style.js) and the BALANCE hint (hints-contact.js) all read them from here, so the issue, the
// observation and the fix agree on the same point and the same polygon.
//   centre of mass   the segment-mass-weighted average of the segment midpoints (SEGMENT_FRACTIONS),
//                    from the frame's joint positions; a skeleton missing a segment bone falls back
//                    to the average of the hips, the spine and the head.
//   support polygon  the 2D convex hull (x, z) of the sole points (heel, ball, tip) of the feet on
//                    the ground (ground.js): one foot's points when only one is down. While the hips
//                    travel every foot counts (a step is about to land).
//   margin           how far the centre of mass's ground projection sits inside the polygon (m, the
//                    distance to its nearest edge), < 0 outside it (minus the distance to it).
import { groundSole } from "./ground.js";

/**
 * Segment mass fractions of total body mass (Dempster, WADC TR 55-159, 1955, as tabulated by
 * Winter, "Biomechanics and Motor Control of Human Movement"). The trunk (0.497) is split into
 * pelvis (0.142) and thorax+abdomen (0.355); the hand rides on the forearm and the foot on the
 * shank. Each entry's fraction sits at the midpoint of its two joints (bone names without a rig
 * prefix). The fractions sum to 1. src/motion/center-of-mass.js reads the same table.
 */
export const SEGMENT_FRACTIONS = [
	{ id: "pelvis", start: "Hips", end: "Spine1", mass: 0.142 },
	{ id: "torso", start: "Spine1", end: "Neck", mass: 0.355 },
	{ id: "head", start: "Neck", end: "Head", mass: 0.081 },
	{ id: "leftUpperArm", start: "LeftArm", end: "LeftForeArm", mass: 0.028 },
	{ id: "leftForeArmHand", start: "LeftForeArm", end: "LeftHand", mass: 0.022 },
	{ id: "rightUpperArm", start: "RightArm", end: "RightForeArm", mass: 0.028 },
	{ id: "rightForeArmHand", start: "RightForeArm", end: "RightHand", mass: 0.022 },
	{ id: "leftThigh", start: "LeftUpLeg", end: "LeftLeg", mass: 0.100 },
	{ id: "leftShankFoot", start: "LeftLeg", end: "LeftFoot", mass: 0.061 },
	{ id: "rightThigh", start: "RightUpLeg", end: "RightLeg", mass: 0.100 },
	{ id: "rightShankFoot", start: "RightLeg", end: "RightFoot", mass: 0.061 },
];

/** The joints whose plain average stands in for the centre of mass on a skeleton missing a segment bone. */
const TRUNK = ["Hips", "Spine1", "Spine2", "Head"];

/** Mass-weighted centre of mass [x, y, z] of pose s (world joint positions s.P), or null when sk lacks a segment bone. */
export function centerOfMass(sk, s) {
	const I = sk.index, c = [0, 0, 0];
	let total = 0;
	for (const { start, end, mass } of SEGMENT_FRACTIONS) {
		const a = s.P[I[start]], b = s.P[I[end]];
		if (I[start] === undefined || I[end] === undefined || !a || !b) return null;
		for (let k = 0; k < 3; k++) c[k] += mass * (a[k] + b[k]) / 2;
		total += mass;
	}
	return c.map(v => v / total);
}

/** centerOfMass, or the average of the hips, the spine and the head where the skeleton cannot give it. */
export function bodyCentre(sk, s) {
	const com = centerOfMass(sk, s);
	if (com) return com;
	const js = TRUNK.filter(j => sk.index[j] !== undefined);
	return [0, 1, 2].map(k => js.reduce((acc, j) => acc + s.P[sk.index[j]][k], 0) / js.length);
}

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Convex hull of 2D points [x, z], counter-clockwise in (x, z), collinear points dropped (monotone chain). */
function convexHull(points) {
	const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	if (p.length < 3) return p;
	const half = list => {
		const h = [];
		for (const q of list) {
			while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 1e-12) h.pop();
			h.push(q);
		}
		h.pop();
		return h;
	};
	return [...half(p), ...half([...p].reverse())];
}

/** Nearest point to c on segment a-b (2D). */
function onSegment(c, a, b) {
	const d = [b[0] - a[0], b[1] - a[1]], l2 = d[0] * d[0] + d[1] * d[1];
	const t = l2 > 0 ? Math.max(0, Math.min(1, ((c[0] - a[0]) * d[0] + (c[1] - a[1]) * d[1]) / l2)) : 0;
	return [a[0] + t * d[0], a[1] + t * d[1]];
}

/**
 * Where 2D point c ([x, z]) sits against the convex polygon of points: { margin, near }. near is
 * the nearest point of the polygon's boundary; margin is the distance to it, > 0 inside the
 * polygon, < 0 outside (a polygon of one or two points has no inside).
 */
export function supportMargin(c, points) {
	const H = convexHull(points);
	let near = H[0], best = Infinity;
	for (let i = 0; i < (H.length > 1 ? H.length : 1); i++) {
		const q = H.length > 1 ? onSegment(c, H[i], H[(i + 1) % H.length]) : H[0];
		const d = Math.hypot(q[0] - c[0], q[1] - c[1]);
		if (d < best) { best = d; near = q; }
	}
	const inside = H.length >= 3 && H.every((a, i) => cross(a, H[(i + 1) % H.length], c) >= 0);
	return { margin: inside ? best : -best, near };
}

/**
 * Balance at frame index i of out (out.frames[i]): "air" with no foot on the ground, else
 * { margin, com, near, feet }: the centre of mass (bodyCentre), its margin against the support
 * polygon (supportMargin of its ground projection) and the polygon's nearest point near ([x, z]).
 * feet: the sole points [x, z] that made the polygon. Declared supports are style.js's.
 */
export function balanceAt(out, i) {
	const F = out.frames, P = F[i].s.P, I = out.ctx.sk.index;
	const moving = i > 0 && i < F.length - 1 && Math.hypot(F[i + 1].s.P[I.Hips][0] - F[i - 1].s.P[I.Hips][0], F[i + 1].s.P[I.Hips][2] - F[i - 1].s.P[I.Hips][2]) / 2 > 0.006;
	const feet = [];
	for (const S of ["Left", "Right"]) {
		const sp = groundSole(out, i, S);
		if (moving || Math.min(sp.heel[1], sp.ball[1]) < 0.02) feet.push(...[sp.heel, sp.ball, sp.tip].map(p => [p[0], p[2]]));
	}
	if (!feet.length) return "air";
	const com = bodyCentre(out.ctx.sk, F[i].s), { margin, near } = supportMargin([com[0], com[2]], feet);
	return { margin, com, near, feet, facing: facing(P, I) };
}

/** The body's horizontal forward [x, z] from the hip axis (left hip minus right hip, turned a quarter about up). */
function facing(P, I) {
	const sx = P[I.LeftUpLeg][0] - P[I.RightUpLeg][0], sz = P[I.LeftUpLeg][2] - P[I.RightUpLeg][2], l = Math.hypot(sx, sz) || 1;
	return [-sz / l, sx / l];
}

/**
 * Words for where the centre of mass is off the support polygon: "0.12 m ahead of the feet
 * (toward +Z)". b = balanceAt (outside: margin < 0). Ahead, behind, left and right are the
 * body's (its hips); the axis in brackets is the world's.
 */
export function offsetWords(b) {
	const o = [b.com[0] - b.near[0], b.com[2] - b.near[1]], [fx, fz] = b.facing;
	const ahead = o[0] * fx + o[1] * fz, left = o[0] * fz - o[1] * fx;
	const side = Math.abs(ahead) >= Math.abs(left) ? (ahead >= 0 ? "ahead of" : "behind") : (left >= 0 ? "left of" : "right of");
	const axis = Math.abs(o[0]) >= Math.abs(o[1]) ? `${o[0] >= 0 ? "+" : "-"}X` : `${o[1] >= 0 ? "+" : "-"}Z`;
	return `${(-b.margin).toFixed(2)} m ${side} the feet (toward ${axis})`;
}
