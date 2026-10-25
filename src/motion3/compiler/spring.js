// Spring secondary motion for a carried or free object (spec.objects[id].spring = { stiffness, damping }): a damped
// pendulum hung on the object's anchor lags the anchor's horizontal acceleration, swings and settles. Computed once at
// compile time (object-pose.js rootPoseAt); playback, scrub and export read the baked track only.
//
// Determinism: a fixed step dt = 1 / fps from frame 0 on, semi-implicit (symplectic) Euler, and the solver update uses
// only + - * / and Math.sqrt, so every engine computes the same bits. Only the last step, the swing angles to a turn,
// goes through the quaternion helpers (quat.js), as every other baked rotation does.
//
// State: two swing angles th = [tx, tz] (rad), how far the object's far end swings toward world +X and +Z, and their
// rates w. Per frame f: a = (p[f] - 2 p[f-1] + p[f-2]) * fps^2 (0 on frames 0 and 1), then
//   w += (-k th - 2 d sqrt(k) w - a_h / L) dt ;  th += w dt
// with k the stiffness (1/s^2), d the damping ratio (0..1, 1 critical) and L the pendulum length (m). Stable while
// sqrt(k) dt < 2: the schema caps k at SPRING.stiffness.max (2000), safe from 24 fps up.
import { qexp, qmul, qnorm } from "./quat.js";
import { quatFromMat, matFromQuat } from "./math.js";

/** The schema's ranges and defaults (schema/types.js reads them; validate-objects.js checks them). */
export const SPRING = { stiffness: { min: 0, max: 2000, default: 80 }, damping: { min: 0, max: 1, default: 0.3 } };
/** The largest swing drawn, rad (60 degrees). */
const SPRING_MAX = Math.PI / 3;
/** The shortest pendulum, m: a tiny prop swings as if it were this long. */
const SPRING_MIN_LENGTH = 0.05;

const clampSwing = v => (v > SPRING_MAX ? SPRING_MAX : v < -SPRING_MAX ? -SPRING_MAX : v);

/** The resting state: no swing, no anchor history. */
export const springRest = () => ({ th: [0, 0], w: [0, 0], p1: null, p2: null });

/**
 * One frame: the state after anchor position p (world [x, y, z]) is fed to `state` (the state after the frame before).
 * Pure: returns a new state. opts = { fps, stiffness, damping, length }.
 */
export function springStep(state, p, { fps, stiffness, damping, length }) {
	const dt = 1 / fps, k = stiffness, c = 2 * damping * Math.sqrt(stiffness), L = length > SPRING_MIN_LENGTH ? length : SPRING_MIN_LENGTH;
	let ax = 0, az = 0;
	if (state.p1 && state.p2) {
		const f2 = fps * fps;
		ax = (p[0] - 2 * state.p1[0] + state.p2[0]) * f2;
		az = (p[2] - 2 * state.p1[2] + state.p2[2]) * f2;
	}
	const wx = state.w[0] + (-k * state.th[0] - c * state.w[0] - ax / L) * dt;
	const wz = state.w[1] + (-k * state.th[1] - c * state.w[1] - az / L) * dt;
	return { th: [state.th[0] + wx * dt, state.th[1] + wz * dt], w: [wx, wz], p1: [p[0], p[1], p[2]], p2: state.p1 };
}

/**
 * The swing of every frame for anchor positions `anchors` (one world [x, y, z] per frame from frame 0):
 * [[tx, tz], ...] rad, each clamped to +-60 degrees. A still anchor gives 0 on every frame.
 */
export function springAngles({ anchors, fps, stiffness = SPRING.stiffness.default, damping = SPRING.damping.default, length = SPRING_MIN_LENGTH }) {
	const opts = { fps, stiffness, damping, length }, out = [];
	let state = springRest();
	for (const p of anchors) {
		state = springStep(state, p, opts);
		out.push([clampSwing(state.th[0]), clampSwing(state.th[1])]);
	}
	return out;
}

/** The clamped swing of a state. */
export const swingOf = state => [clampSwing(state.th[0]), clampSwing(state.th[1])];

/**
 * Pose { pos, R } turned by swing th = [tx, tz] about its own base (position unchanged): +tx swings what hangs below
 * toward +X (a turn about +Z), +tz toward +Z (a turn about -X). The turn is applied in world axes on top of R.
 */
export function swungPose(pose, th) {
	if (th[0] === 0 && th[1] === 0) return pose;
	const turn = qexp([-th[1], 0, th[0]]);
	return { ...pose, pos: pose.pos, R: matFromQuat(qnorm(qmul(turn, quatFromMat(pose.R)))) };
}

/** Pendulum length of a body or group from its boxes [{ pos, R, half }]'s corners: half the longest side of their bounding box, at least 5 cm. */
export function springLength(corners) {
	if (!corners.length) return SPRING_MIN_LENGTH;
	let longest = 0;
	for (let i = 0; i < 3; i++) {
		const vs = corners.map(c => c[i]);
		longest = Math.max(longest, Math.max(...vs) - Math.min(...vs));
	}
	return Math.max(SPRING_MIN_LENGTH, longest / 2);
}
