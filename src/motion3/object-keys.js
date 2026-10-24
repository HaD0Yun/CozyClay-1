// C14. Held-object keys: spec.objects[id].keys = [{ f, pos, rot }] on a carry entry. Each key is
// the world pose of the object's root (the group root for a group id, else the body: its base
// pivot, rot a quaternion [x, y, z, w]) at absolute frame f, grab <= f <= release.
//   between keys    a cubic Hermite on pos and the same in rotation-vector space on rot (squad
//                   like), Catmull-Rom tangents through inner keys, zero at the first and last key
//   around the span the hand blends from the plain carry into the keyed span over KEY_BLEND frames
//                   (inside grab..release; smoothstep), so nothing jumps; keys that start within KEY_BLEND frames
//                   of the grab with a grip off where the hand is turn the hand onto it before (holdHook approach)
//   the object leads the hand: compile.js asks holdHook for the palm frame the keys put the grip
//                   at, palm = key o attach^-1, and pose.js solves the hand to it (compiler/hold.js)
// The object itself is still drawn in the hand (object-pose.js): the residual is what the arm
// and the wrist could not reach, and QA reports it (qa/key-checks.js).
import { isCarried, carriedPose, compose, relative } from "./carried.js";
import { seatsInHand, seatOffset, settleAt, between as slide } from "./seat.js";
import { groupsOf } from "./scene.js";
import { restState, bonePoint } from "./compiler/skeleton.js";
import { add, scale, sub, apply, T, matFromQuat, quatFromMat } from "./compiler/math.js";
import { qmul, qconj, qlog, qexp, qrot, qdot, qnorm } from "./compiler/quat.js";
import { keyRots, leanPos } from "./key-aim.js";
import { faceLeaned } from "./face-lean.js";
import { holdCost } from "./compiler/hold.js";
import { polePlan, smoothPath, smoothed } from "./hold-plan.js";
import { secondGrip, secondHold, gripGate } from "./second-hand.js";
import { SIDES } from "./compiler/pose.js";
import { chooseGrip, between, thinBody } from "./grip-choice.js";
import { graspedBy } from "./compiler/socket-grip.js";

/** Frames over which the hand blends into and out of the keyed span. */
export const KEY_BLEND = 8;
// the frames a hand takes to turn into a chosen grip before its grab and out of it after its release (grip-choice.js)
const GRAB_EASE = 12;
// how far (m, deg) the grip keys put the hand on at the grab may be from where the reach brought it before the hand turns onto it first
const OFF_GRIP = { m: 0.01, deg: 5 };

const smooth = x => x * x * (3 - 2 * x);
/** [grab, release] in absolute frames of `out` (object-pose.js spanOf, kept here to stay out of its import cycle). */
const spanIn = (out, o) => { const map = f => (out.timeMap ? Math.round(out.timeMap(f)) : f); return [map(o.grab ?? 0), o.release === undefined ? out.frameCount - 1 : map(o.release)]; };
const invert = p => { const Rt = T(p.R); return { pos: scale(apply(Rt, p.pos), -1), R: Rt }; };

/** The keys of entry o as a curve: times (after a retime), positions, quaternions on one hemisphere (aim keys resolved: key-aim.js), tangents. */
export function curveOf(o, map, plain, strain, top = 0) {
	const keys = [...o.keys].sort((a, b) => a.f - b.f), t = keys.map(k => map(k.f)), q = [];
	const rots = keyRots(keys, i => plain(t[i]), strain && ((i, r) => strain(t[i], leanPos(keys[i], r, top), r, keys[i].lean ? { shoulder: true } : undefined)));
	const p = keys.map((k, i) => leanPos(k, qnorm(rots[i]), top).slice());
	for (const r of rots) { const n = qnorm(r); q.push(q.length && qdot(q[q.length - 1], n) < 0 ? n.map(v => -v) : n); }
	const last = keys.length - 1, rate = i => scale(qlog(qmul(qconj(q[i]), q[i + 1])), 1 / (t[i + 1] - t[i]));
	const tangent = (i, of) => (i === 0 || i === last ? [0, 0, 0] : scale(add(scale(of(i), t[i] - t[i - 1]), scale(of(i - 1), t[i + 1] - t[i])), 1 / (t[i + 1] - t[i - 1])));
	const m = p.map((_, i) => tangent(i, j => scale(sub(p[j + 1], p[j]), 1 / (t[j + 1] - t[j])))), w = q.map((_, i) => tangent(i, rate));
	return { t, p, q, m, w, rots };
}

const curves = new WeakMap();
/**
 * The key curve of spec.objects[id] in `out` (cached per compile result, time map and baked
 * channels: an aim key turns from the plain carry at its frame, and one without roll takes the
 * roll the arm holds there most easily).
 */
export function curveIn(out, id) {
	if (!curves.has(out)) curves.set(out, new Map());
	const cache = curves.get(out), map = out.timeMap, baked = out.baked, had = cache.get(id);
	if (!had || had.map !== map || had.baked !== baked) {
		const hold = out.ctx.hold, solved = new Map(), at = t => { const f = Math.round(t); if (!solved.has(f)) solved.set(f, hold.plainFrame(f).s); return solved.get(f); };
		const plain = t => quatFromMat(hold.carryOn(id, at(t)).R), strain = (t, pos, q, opts) => hold.strainOn(id, at(t), { pos, R: matFromQuat(q) }, opts);
		cache.set(id, { map, baked, curve: curveOf(hold.entry?.(id) ?? out.ctx.spec.objects[id], f => (map ? map(f) : f), plain, strain, 2 * (out.ctx.scene?.objects?.[id]?.half?.[1] ?? 0)) });
	}
	return cache.get(id).curve;
}

/** World pose { pos, R } the keys ask for at absolute frame f (held at the first / last key outside them). */
export function keyedPose({ t, p, q, m, w }, f) {
	const n = t.length;
	if (n === 1 || f <= t[0]) return { pos: p[0].slice(), R: matFromQuat(q[0]) };
	if (f >= t[n - 1]) return { pos: p[n - 1].slice(), R: matFromQuat(q[n - 1]) };
	let i = 0;
	while (f > t[i + 1]) i++;
	const h = t[i + 1] - t[i], u = (f - t[i]) / h, u2 = u * u, u3 = u2 * u;
	const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
	const pos = add(add(scale(p[i], h00), scale(m[i], h * h10)), add(scale(p[i + 1], h01), scale(m[i + 1], h * h11)));
	// rotation: q_i exp(v), v a Hermite in q_i's frame from 0 to the step to q_i+1 (the end tangent turned into that frame)
	const step = qmul(qconj(q[i]), q[i + 1]), d = qlog(step);
	const v = add(add(scale(d, h01), scale(w[i], h * h10)), scale(qrot(step, w[i + 1]), h * h11));
	return { pos, R: matFromQuat(qmul(q[i], qexp(v))) };
}

/**
 * 0..1: how much the keys lead the hand at absolute frame f (1 from the first to the last key).
 * After the last key the hand eases out over KEY_BLEND frames even when the release comes sooner:
 * the rest of the ease runs past the release (holdHook easeOut), so the arm does not snap.
 */
function leadWeight(curve, [grab, release], f) {
	const t0 = curve.t[0], t1 = curve.t[curve.t.length - 1];
	if (f < grab || f > release) return 0;
	if (f >= t0 && f <= t1) return 1;
	const b = f < t0 ? Math.min(KEY_BLEND, t0 - grab) : KEY_BLEND, gap = f < t0 ? t0 - f : f - t1;
	return b > 0 && gap < b ? smooth(1 - gap / b) : 0;
}

/** The keyed carry entries: [[id, entry]]. */
export const keyedEntries = spec => Object.entries(spec.objects ?? {}).filter(([, o]) => isCarried(o) && o.keys?.length);

/**
 * The hooks a compile needs when some carry has keys (else null): lead(k, f, s, c) -> { w,
 * palm, measure, pole? } | null for pose.js hooks.hold (the holding hand, or a left hand anchored
 * to the carry: second-hand.js), and attach(id) -> the object in the palm frame (the
 * plain carry's offset: at/along, or the grab-frame offset solved without the keys, so the keys
 * never feed back into it). For aim keys (key-aim.js): plainFrame(f) solves frame f without the
 * keys (solveLed(f) with them, the second hands left out: what a second hand's roll is planned
 * on), carryOn(id, s) is where the plain carry holds id on such a pose (where an aim key turns
 * from) and strainOn(id, s, pose) the arm's cost of holding id at world pose { pos, R } there
 * (compiler/hold.js holdCost, the roll of an aim key without one).
 */
export function holdHook(ctx, out, solvePlain, solveLed) {
	const { sk, spec, scene } = ctx, held = keyedEntries(spec);
	if (!held.length) return null;
	const seated = new Set(held.map(([id]) => id).filter(id => seatsInHand(spec, spec.objects[id], scene, id)).map(id => spec.objects[id]));
	// the entry as the compile holds it: mouth keys leaned (faceLeaned), read once per compile on the frames without keys
	const entries = new WeakMap(), mapped0 = f => (out.timeMap ? Math.round(out.timeMap(f)) : f);
	const entry = id => {
		if (!entries.has(out)) entries.set(out, new Map());
		const cache = entries.get(out);
		if (!cache.has(id)) {
			const top = 2 * (scene?.objects?.[id]?.half?.[1] ?? 0);
			cache.set(id, faceLeaned(spec.objects[id], top, f => bonePoint(solvePlain(mapped0(f)).s, sk.index.Head, sk.landmarks.mouth)));
		}
		return cache.get(id);
	};
	const palmOf = (o, s) => carriedPose(sk, spec, s, { prop: o.prop }, seated.has(o)), attached = new WeakMap(), attaching = new Set();
	const restAt = (id, f) => ctx.restingAt?.(id, f) ?? scene?.objects?.[id] ?? groupsOf(scene)[id];
	// a keyed carry of a thin body (a cup, a can, a bar) whose grip is free (no at/along, no orient: false, no grasp fit, no keyed
	// wrist at the grab) keeps the grip its keyed path holds most comfortably (grip-choice.js), solved on the plain frames with the
	// body read at rest; a box keeps the grip grip.js gives it at the grab
	const choices = new WeakMap(), mapped = f => (out.timeMap ? Math.round(out.timeMap(f)) : f);
	// chosen once per compile (the first bake): the fixes' rebakes move the body a little, the carry's keys not at all
	const chosen = id => {
		if (!choices.has(out)) choices.set(out, new Map());
		const cache = choices.get(out), o = spec.objects[id], k = spec.props?.[o.prop]?.hand, grab = spanIn(out, o)[0], b = out.baked ?? {};
		if (cache.has(id)) return cache.get(id);
		cache.set(id, null);
		const free = k && o.at === undefined && o.along === undefined && (o.grab !== undefined || !scene?.objects?.[id]) && thinBody(scene, id) && !(spec.fits ?? []).some(fit => fit.side === k && fit.orient === false) && !graspedBy(spec, scene, id, k)
			&& !["wtwist", "wflex"].some(ch => Math.abs(b[`${ch}_${k}`]?.[grab] ?? 0) > 1e-3)
			// keys that start after the grab: the body rides the hand from where it rests, which only today's grip meets exactly
			&& mapped(Math.min(...o.keys.map(key => key.f))) <= grab;
		if (!free) return null;
		attaching.add(id);
		try { cache.set(id, chooseGrip({ sk, o: entry(id), side: SIDES[k], grab, rest: restAt(id, grab), plain: f => solvePlain(f).s, palmOf: s => palmOf(o, s), map: mapped })); } finally { attaching.delete(id); }
		return cache.get(id);
	};
	const attach = id => {
		if (!attached.has(out.baked)) attached.set(out.baked, new Map());
		const cache = attached.get(out.baked), o = spec.objects[id];
		if (cache.has(id)) return cache.get(id);
		const picked = chosen(id);
		if (picked && picked.name !== "today") { const a = seated.has(o) ? seatOffset(sk, spec, scene, id, o, picked.offset) : picked.offset; cache.set(id, a); cache.set(`${id}|taken`, picked.offset); return a; }
		const rest = scene?.objects?.[id] ?? groupsOf(scene)[id], group = !scene?.objects?.[id] && !!rest;
		const keeps = o.at === undefined && o.along === undefined && (group || o.grab !== undefined);
		// the grab frame solved without the keys: a left hand anchored on id reads it there (object-pose.js), where this offset puts it
		attaching.add(id);
		let s;
		try { s = keeps ? solvePlain(spanIn(out, o)[0]).s : restState(sk); } finally { attaching.delete(id); }
		const taken = relative(palmOf(o, s), keeps ? ctx.restingAt?.(id, spanIn(out, o)[0]) ?? { pos: rest.pos, R: rest.R } : carriedPose(sk, spec, s, o));
		const a = keeps && seated.has(o) ? seatOffset(sk, spec, scene, id, o, taken) : taken;
		cache.set(id, a); cache.set(`${id}|taken`, taken);
		return a;
	};
	// on the grasp path a keyed carry's hand slides from where it took the object into its seat over the settle (seat.js)
	const attachAt = (id, f) => { const a = attach(id), t = attached.get(out.baked)?.get(`${id}|taken`); return t && t !== a && f !== undefined ? slide(t, a, settleAt(spanIn(out, spec.objects[id])[0], f)) : a; };
	const carryOn = (id, s) => compose(palmOf(spec.objects[id], s), attach(id));
	const strainOn = (id, s, pose, opts) => { const o = spec.objects[id]; return holdCost(sk, s, SIDES[spec.props[o.prop].hand], compose(pose, invert(attach(id))), palmOf(o, s), opts); };
	const heldAt = (id, o, f) => {
		const curve = curveIn(out, id), w = leadWeight(curve, spanIn(out, o), f);
		return w > 0 ? { w, palm: compose(keyedPose(curve, f), invert(attachAt(id, f))), measure: s => palmOf(o, s), comfort: entry(id).keys.some(k => k.lean > 0) } : null;
	};
	// the elbow's planned path over the frames the keys lead (hold-plan.js), once per baked channels and time map
	const plans = new WeakMap();
	const planOf = (id, o) => {
		if (!plans.has(out.baked)) plans.set(out.baked, new Map());
		const cache = plans.get(out.baked), had = cache.get(id);
		if (had && had.map === out.timeMap) return had.plan;
		const [grab, release] = spanIn(out, o), frames = [];
		for (let f = Math.max(0, grab); f <= Math.min(out.frameCount - 1, release); f++) if (leadWeight(curveIn(out, id), [grab, release], f) > 0) frames.push(f);
		const plan = polePlan(sk, SIDES[spec.props[o.prop].hand], frames, f => ({ s: solvePlain(f).s, held: heldAt(id, o, f) }));
		cache.set(id, { map: out.timeMap, plan });
		return plan;
	};
	// a left hand anchored to a carry the right hand holds grips it too (second-hand.js): its roll about the object, planned over the frames like the elbow
	let planning = false;
	const gripAt = (id, s, c) => { const R = carryOn(id, s).R; return secondGrip(sk, spec, id, s, c, [R[0][1], R[1][1], R[2][1]]); };
	const rollPlans = new WeakMap();
	const rollsOf = (id, o) => {
		if (!rollPlans.has(out.baked)) rollPlans.set(out.baked, new Map());
		const cache = rollPlans.get(out.baked), had = cache.get(id);
		if (had && had.map === out.timeMap) return had.plan;
		const [grab, release] = spanIn(out, o), plan = new Map();
		planning = true;
		let run = [];
		const flush = () => {
			const x = smoothPath((i, r) => run[i].grip.cost(r), (i, r) => run[i].grip.point(r), run.map(g => g.grip.softmin())), gate = smoothed(run.map((g, i) => gripGate(g.grip, x[i])));
			// then its elbow's path at those rolls, like the holding elbow's (hold-plan.js)
			const arm = i => run[i].grip.arm(x[i]), th = smoothPath((i, t) => arm(i).at(t).cost, (i, t) => arm(i).at(t).elbow, run.map((_, i) => arm(i).best.th));
			run.forEach((g, i) => plan.set(g.f, { roll: x[i], gate: gate[i], pole: arm(i).at(th[i]).pv }));
			run = [];
		};
		for (let f = Math.max(0, grab); f <= Math.min(out.frameCount - 1, release); f++) {
			const solved = leadWeight(curveIn(out, id), [grab, release], f) > 0 ? solveLed(f) : null, grip = solved && gripAt(id, solved.s, solved.c);
			if (grip) run.push({ f, grip }); else if (run.length) flush();
		}
		if (run.length) flush();
		planning = false;
		cache.set(id, { map: out.timeMap, plan });
		return plan;
	};
	// around its keys the hand holds a chosen grip: it turns into it over the GRAB_EASE frames before the grab, holds it from the
	// grab until the keys lead, keeps it on the body where the last key left it, and turns out of it over the GRAB_EASE frames
	// after the release (by time, not by a fit's weight, which an agent may key on in a frame), so nothing jumps
	const gripAround = (id, o, f) => {
		const pick = chosen(id);
		if (!pick || pick.name === "today") return null;
		const curve = curveIn(out, id), t0 = curve.t[0], t1 = curve.t[curve.t.length - 1], [grab, release] = spanIn(out, o);
		if (f >= t0 && f <= t1) return null;
		// the elbow takes the planned pole of the nearest keyed frame (hold-plan.js), so it does not swing at the span's ends
		// the grip on the body where the first key puts it (an aim key's roll is picked for this grip), so the reach meets the keys
		const on = keyedPose(curve, f < t0 ? t0 : t1), grip = compose(on, invert(pick.offset)), measure = s => palmOf(o, s), pole = planOf(id, o).get(Math.round(f < t0 ? t0 : t1));
		if (f < grab || f > release) { const w = smooth(Math.max(0, 1 - (f < grab ? grab - f : f - release) / GRAB_EASE)); return w > 1e-3 ? { w, palm: grip, measure, pole } : null; }
		const h = heldAt(id, o, f);
		return { w: 1, palm: h ? { pos: add(scale(grip.pos, 1 - h.w), scale(h.palm.pos, h.w)), R: between(grip.R, h.palm.R, h.w) } : grip, measure, pole };
	};
	// keys that lead from the grab frame, or from fewer than KEY_BLEND frames after it, put the hand on their grip at once (or
	// within those frames: palm = first key o attach^-1). Where that grip is not where the hand would be at the first key (an
	// at/along offset of the agent's choosing: bench session cb2503b5's cup, 13.6 cm in the grab frame; keys two frames after
	// the grab: 7146050f's box), the hand turns onto it over the GRAB_EASE frames up to the first key instead, as onto a chosen
	// grip (gripAround): before the grab with the object at rest, after it carrying the object there. A grip within OFF_GRIP
	// of where the hand would be changes nothing.
	const offGrips = new WeakMap();
	const offGrip = (id, o, grip) => {
		if (!offGrips.has(out.baked)) offGrips.set(out.baked, new Map());
		const cache = offGrips.get(out.baked), had = cache.get(id);
		if (had && had.map === out.timeMap) return had.off;
		attaching.add(id);
		let palm;
		try { palm = palmOf(o, solvePlain(Math.max(spanIn(out, o)[0], Math.round(curveIn(out, id).t[0]))).s); } finally { attaching.delete(id); }
		const turn = relative(palm, grip).R, deg = Math.acos(Math.min(1, Math.max(-1, (turn[0][0] + turn[1][1] + turn[2][2] - 1) / 2))) * 180 / Math.PI;
		const off = Math.hypot(...sub(grip.pos, palm.pos)) > OFF_GRIP.m || deg > OFF_GRIP.deg;
		cache.set(id, { map: out.timeMap, off });
		return off;
	};
	const approach = (id, o, f) => {
		const curve = curveIn(out, id), [grab, release] = spanIn(out, o), t0 = Math.max(grab, Math.round(curve.t[0]));
		if (!(f < t0 && f >= t0 - GRAB_EASE) || t0 - grab >= KEY_BLEND || t0 > release) return null;
		const grip = compose(keyedPose(curve, t0), invert(attach(id)));
		if (!offGrip(id, o, grip)) return null;
		const w = smooth(1 - (t0 - f) / GRAB_EASE);
		return w > 1e-3 ? { w, palm: grip, measure: s => palmOf(o, s), pole: planOf(id, o).get(t0) } : null;
	};
	// a release within KEY_BLEND frames of the last key: the hands finish easing out of the keys after it (weight from the last
	// key), the holding hand from the palm they gave it at the release (the object stays where it was let go), each hand with
	// the elbow pole (and the second hand the roll) planned for the release frame
	const pastRelease = (id, o, f) => {
		const curve = curveIn(out, id), t1 = curve.t[curve.t.length - 1], release = spanIn(out, o)[1];
		return f > release && f - t1 < KEY_BLEND ? { curve, release, w: smooth(1 - (f - t1) / KEY_BLEND) } : null;
	};
	const easeOut = (id, o, f) => {
		const e = pastRelease(id, o, f);
		return e && { w: e.w, palm: compose(keyedPose(e.curve, e.release), invert(attach(id))), measure: s => palmOf(o, s), pole: planOf(id, o).get(e.release) };
	};
	// the hand that holds a keyed carry follows its keys
	const lead = (k, f, s, c) => {
		for (const [id, o] of held) {
			const pre = spec.props?.[o.prop]?.hand === k ? gripAround(id, o, f) ?? approach(id, o, f) ?? easeOut(id, o, f) : null;
			if (pre) return pre;
			const h = spec.props?.[o.prop]?.hand === k ? heldAt(id, o, f) : null;
			if (h) return { ...h, pole: planOf(id, o).get(f) };
			const after = k === "l" && s && !planning ? pastRelease(id, o, f) : null;
			const w = k === "l" && s && !planning ? leadWeight(curveIn(out, id), spanIn(out, o), f) || (after?.w ?? 0) : 0, grip = w > 0 ? gripAt(id, s, c) : null;
			const planned = grip && rollsOf(id, o).get(after ? after.release : f), roll = planned?.roll ?? grip?.softmin();
			if (grip) return secondHold(grip, w, roll, planned?.gate ?? gripGate(grip, roll), planned?.pole ?? grip.arm(roll).best.pole);
		}
		return null;
	};
	// the grip (compiler/grip.js) reads where a keyed carry's span and keys begin, after a retime
	const firstKey = id => { const t = Math.min(...spec.objects[id].keys.map(k => k.f)); return out.timeMap ? Math.round(out.timeMap(t)) : t; };
	// the grips chosen for keyed carries (observations.wrist reads them): [{ id, hand, name, cost, today }]
	const grips = () => held.map(([id, o]) => { const p = chosen(id); return p && { id, hand: spec.props[o.prop].hand, name: p.name, cost: p.cost, today: p.today }; }).filter(Boolean);
	return { lead, attach, attachAt, attaching: id => attaching.has(id), plainFrame: solvePlain, entry, carryOn, strainOn, span: id => spanIn(out, spec.objects[id]), firstKey, grips };
}
