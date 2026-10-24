// QA of held-object keys (C14, ../object-keys.js). From the first to the last key the object
// leads the hand; the object is drawn in the hand, so what the arm or the wrist could not reach
// leaves the object off the pose its keys ask for. That residual is measured on the object, as the
// farthest corner of its part boxes from where the keys put it:
//   REACH  "<id>: 6.2 cm off its keys", value metres, limit checks.limits.reach (default 0.01)
// The hint names the key and why the hand fell short (diag.hold_<side>, compiler/hold.js): the
// arm out of reach, the grip nearer the shoulder than the elbow folds (compiler/limbs.js), or a
// wrist turn past its limit after the elbow swung and the forearm turned (lane K8: the whole arm
// follows the object, compiler/arm-orient.js).
// Measured, not judged (C16, output.observations.held): every key as drawn, so the agent sees how
// far each one is from what the hand can hold without a probe.
import { keyedEntries, curveIn, keyedPose } from "../object-keys.js";
import { rootPoseAt, partsOf } from "../object-pose.js";
import { relative } from "../carried.js";
import { groupsOf } from "../scene.js";
import { WRIST_LIMITS } from "../compiler/arm-orient.js";
import { ELBOW_FOLD, ELBOW_STOP } from "../compiler/limbs.js";
import { add, apply, dist, norm, angle, matFromQuat } from "../compiler/math.js";

const SUBJECT = /^(.+): [\d.]+ cm off its keys$/;
const WRIST_WORDS = { twist: "twist about the forearm", flex: "flex", dev: "deviation (+ toward the thumb)" };

/** The corners of id's part boxes in its root frame (the box spans y 0..2 half on its base pivot). */
function cornersOf(scene, id) {
	const root = scene.objects[id] ?? groupsOf(scene)[id];
	return partsOf(scene, id).flatMap(p => {
		const box = scene.objects[p], rel = relative(root, box), [x, y, z] = box.half;
		return [-x, x].flatMap(a => [0, 2 * y].flatMap(b => [-z, z].map(c => add(rel.pos, apply(rel.R, [a, b, c])))));
	});
}

/** REACH issues of every keyed carry, frames as out.frames indexes. */
export function keyIssues(out, L, push) {
	const { scene } = out.ctx, f0 = out.f0 ?? 0;
	for (const [id] of keyedEntries(out.ctx.spec)) {
		const curve = curveIn(out, id), corners = cornersOf(scene, id);
		if (!corners.length) continue;
		for (let f = Math.max(f0, Math.ceil(curve.t[0])); f <= Math.min(f0 + out.frames.length - 1, Math.floor(curve.t[curve.t.length - 1])); f++) {
			const want = keyedPose(curve, f), got = rootPoseAt(out, id, f);
			const off = Math.max(...corners.map(c => dist(add(want.pos, apply(want.R, c)), add(got.pos, apply(got.R, c)))));
			if (off > L.reach) push("REACH", `${id}: ${(off * 100).toFixed(1)} cm off its keys`, f - f0, off, L.reach);
		}
	}
}

/** REACH for a keyed object ("<id>: 6.2 cm off its keys") -> { cause, hint }, else null. */
export function keyHint(X, g) {
	const id = SUBJECT.exec(g.subject)?.[1], o = X.spec?.objects?.[id];
	if (!o?.keys?.length) return null;
	const f = g.worstFrame, k = X.spec.props?.[o.prop]?.hand, h = X.fr(f).diag[`hold_${k}`] ?? {};
	const near = o.keys.reduce((best, key, i) => (Math.abs(key.f - f) < Math.abs(o.keys[best].f - f) ? i : best), 0);
	const wrist = Object.entries(WRIST_LIMITS).filter(([n, [lo, hi]]) => h[n] < lo || h[n] > hi).map(([n, [lo, hi]]) => `the wrist ${WRIST_WORDS[n]} needs ${Math.round(h[n])}deg (limit ${lo}..${hi})`);
	// the arm already swung the elbow and turned the forearm (compiler/arm-orient.js): say so with what the wrist still needs
	if (wrist.length) wrist[wrist.length - 1] += ` after the elbow swung ${Math.round(h.swivel ?? 0)}deg and the forearm turned`;
	// the grip nearer the shoulder than the elbow folds (h.fold, the flexion it asked): out from the shoulder, not nearer the hand
	const fold = h.miss > 0.005 && h.fold, short = fold ? `the grip is ${(h.miss * 100).toFixed(1)} cm inside the forearm's reach (the elbow would fold ${Math.round(h.fold)}deg; it bends to ${ELBOW_FOLD}deg and stops at ${ELBOW_STOP}deg)` : `the arm is ${(h.miss * 100).toFixed(1)} cm short`;
	const why = [...(h.miss > 0.005 ? [short] : []), ...wrist];
	const roll = o.keys[near].aim && o.keys[near].roll === undefined ? "" : "; an aim key without roll takes the roll the arm holds most easily";
	return { cause: `objects.${id}.keys[${near}] f${o.keys[near].f}`,
		hint: `${id} at f${f}: ${why.length ? why.join(", ") : "the hand cannot hold it there"}; ${fold ? "key a pose farther from the shoulder, or turn or move the body away from it" : "key a pose nearer the hand, or bring the body to it"} (root, yaw, spine_yaw)${roll}` };
}

const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
/** observations.held units: what a row of a keyed object says. */
export const HELD_UNITS = "held: per key, deg = the drawn +Y off the asked one (aim, or rot's +Y), cm = the drawn base off pos, got = the drawn +Y (when 1 deg off or more), rot = what an aim key used, lean = the lean a mouth key took by default (give lean 0 to hold aim exactly)";

/**
 * Every key of every keyed carry as drawn: { <id>: [{ f, deg, cm, got?, rot? }] } in key order
 * (frames as the spec writes them), or null when nothing is keyed.
 */
export function heldReadings(out) {
	const held = keyedEntries(out.ctx.spec);
	if (!held.length) return null;
	return Object.fromEntries(held.map(([id, o]) => {
		// the keys as the compile holds them: a mouth key the compile leaned says so (object-keys.js faceLeaned)
		const curve = curveIn(out, id), keys = [...(out.ctx.hold?.entry?.(id) ?? o).keys].sort((a, b) => a.f - b.f);
		return [id, keys.map((k, i) => {
			const got = rootPoseAt(out, id, Math.round(curve.t[i])), y = [got.R[0][1], got.R[1][1], got.R[2][1]];
			const want = k.aim ? norm(k.aim) : apply(matFromQuat(curve.q[i]), [0, 1, 0]), deg = r1(angle(want, y));
			return { f: k.f, deg, cm: r1(dist(k.pos, got.pos) * 100), ...(deg >= 1 ? { got: y.map(r2) } : {}), ...(k.aim ? { rot: curve.rots[i] } : {}), ...(k.leaned ? { lean: k.lean } : {}) };
		})];
	}));
}
