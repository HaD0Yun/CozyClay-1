// QA ARM warnings (lane arm): an elbow that reads awkward while the hand works, though nothing collides or breaks.
// The agent saw these only in renders and re-keyed them after QA had passed (17% of the compiles in the hundred
// costliest motion turns: elbows too high, wrapped over the head, out to the side). A working arm (on its IK, or a
// hand a keyed carry leads, compiler/hold.js) is read on each frame in the chest's frame, the hand not overhead (the
// wrist below the top of the head plus OVERHEAD: a lift over the head needs the elbow up; a hand that tips a cup at the
// lips from above sits by the top of the head and is read):
//   over the head  the elbow above the head's centre: the upper arm wraps over the head
//   high           the upper arm more than HIGH deg from hanging (90 level): the elbow over the shoulder
//   wing           the upper arm more than WING deg out to the side in the chest's frontal plane with the hand
//                  within NEAR m of the trunk's axis: the elbow flared out while the hand works by the body
// Runs of at least MIN frames on a side (gaps of GAP at most) make one line, worst first, at most LINES of them in
// qa.warnings. They are warnings, not QA groups: they never fail a take (qa.ok), repair does not chase them, and the
// output budget keeps them after every group (report.js). Each says the frames, the side and the spec change that
// fixes it: on a keyed carry the object's keys there (lean FACE_LEAN, what a key at the lips takes by default,
// ../face-lean.js; with that, the pos lower and nearer the chest), on an IK arm the elbow pole (elbow_<side>, body
// frame: x out to the character's left, -y down, z forward).
import { sub, scale, dot, len, clamp } from "../compiler/math.js";
import { carried } from "../compiler/limbs.js";
import { bonePoint } from "../compiler/skeleton.js";
import { keyedEntries } from "../object-keys.js";
import { FACE_LEAN } from "../face-lean.js";

const HIGH = 105, WING = 75, NEAR = 0.3, OVERHEAD = 0.1, MIN = 4, GAP = 6, LINES = 2, WORKS = 0.5, DEG = 180 / Math.PI;
const SIDES = { l: "Left", r: "Right" }, ORDER = { "over the head": 0, high: 1, wing: 2 };

/** What the arm of side k reads like on solved frame { s, diag, c }: { kind, deg, held } or null (not working, or natural). */
export function armPose(sk, { s, diag, c }, k) {
	const held = (diag[`hold_${k}`]?.w ?? 0) > WORKS && !diag[`hold_${k}`].second;
	if (!held && !((c[`armw_${k}`] ?? 0) > WORKS)) return null;
	const I = sk.index, S = s.P[I[`${SIDES[k]}Arm`]], E = s.P[I[`${SIDES[k]}ForeArm`]], W = s.P[I[`${SIDES[k]}Hand`]], chest = I.Spine2 ?? I.Hips;
	const up = carried(sk, s, chest, [0, 1, 0]), out = scale(carried(sk, s, chest, [1, 0, 0]), k === "l" ? 1 : -1);
	const head = bonePoint(s, I.Head, sk.landmarks.headCentre);
	if (dot(sub(W, head), up) > sk.landmarks.headRadii[1] + OVERHEAD) return null;
	const v = sub(E, S), el = Math.acos(clamp(-dot(v, up) / len(v), -1, 1)) * DEG, flare = Math.atan2(dot(v, out), -dot(v, up)) * DEG;
	if (dot(sub(E, head), up) > 0) return { kind: "over the head", deg: el, held };
	if (el > HIGH) return { kind: "high", deg: el, held };
	const axis = sub(W, s.P[I.Spine]), across = len(sub(axis, scale(up, dot(axis, up))));
	if (flare > WING && across < NEAR) return { kind: "wing", deg: flare, held };
	return null;
}

/** The keyed carry hand k holds and its keys within timeline frames f0..f1, else the one nearest f: { id, picks: [[index, key]] } or null. */
function carryAt(out, k, f0, f1, f) {
	const spec = out.ctx.spec, map = t => (out.timeMap ? out.timeMap(t) : t);
	for (const [id, o] of keyedEntries(spec)) {
		if (spec.props?.[o.prop]?.hand !== k) continue;
		const keys = (out.ctx.hold?.entry?.(id) ?? o).keys, within = keys.map((key, i) => [i, key]).filter(([, key]) => map(key.f) >= f0 && map(key.f) <= f1);
		const near = keys.reduce((b, key, j) => (Math.abs(map(key.f) - f) < Math.abs(map(keys[b].f) - f) ? j : b), 0);
		return { id, picks: within.length ? within : [[near, keys[near]]] };
	}
	return null;
}

const r2 = v => Math.round(v * 100) / 100;
const listed = (id, picks) => picks.map(([i, key]) => `objects.${id}.keys[${i}] (f${key.f})`).join(", ");
/** The spec change that fixes run g (see the header). */
function fixFor(sk, out, g) {
	const k = g.k, sx = k === "l" ? 1 : -1, c = g.held && carryAt(out, k, g.first, g.last, g.worst);
	if (c) {
		const lean = c.picks.filter(([, key]) => key.aim && !(key.lean >= FACE_LEAN));
		if (lean.length) return `give ${listed(c.id, lean)} lean ${FACE_LEAN} (tips the aim to the hand's side, the elbow stays down)`;
		// lower, and nearer the chest across the ground, read on the frame of the run's worst key
		const fr = out.frames[Math.max(0, Math.min(out.frames.length - 1, Math.round(g.worst - (out.f0 ?? 0))))], P = c.picks[0][1].pos;
		const to = sub(fr.s.P[sk.index.Spine2 ?? sk.index.Hips], P), h = Math.hypot(to[0], to[2]) || 1;
		return `move ${listed(c.id, c.picks)} pos by [${r2((0.05 * to[0]) / h)}, -0.08, ${r2((0.05 * to[2]) / h)}] (lower, nearer the chest)`;
	}
	// the pole in the body frame: down, a little out, and for a hand by the face in front of the chest
	const pole = g.kind === "wing" ? [r2(0.1 * sx), -1, 0.2] : [r2(0.3 * sx), -1, g.mouth ? 0.35 : -0.2];
	return `key elbow_${k} [${pole.join(", ")}] from f${g.first} to f${g.last} (down${g.kind === "wing" ? " and in" : " and a little out"}${g.mouth ? ", in front of the chest" : ""})`;
}

const WORDS = { "over the head": "upper arm wraps over the head", high: "elbow over the shoulder", wing: "elbow flared out to the side" };
/**
 * ARM warning lines of a compile (out.frames solved; frames absolute with out.f0): the worst LINES runs, worst
 * first. A run is a side's awkward frames with gaps of at most GAP, all held or all on the IK, named by its worst
 * kind (ORDER) and that kind's worst frame. [] when every working arm reads natural.
 */
export function armWarnings(sk, out) {
	const runs = [], f0 = out.f0 ?? 0, mouthAt = s => bonePoint(s, sk.index.Head, sk.landmarks.mouth);
	for (const k of ["l", "r"]) {
		let run = null;
		const close = () => { if (run && run.n >= MIN) runs.push(run); run = null; };
		out.frames.forEach((fr, i) => {
			const a = armPose(sk, fr, k), f = i + f0;
			if (run && (f - run.last > GAP || (a && a.held !== run.held))) close();
			if (!a) return;
			const mouth = len(sub(fr.s.P[sk.index[`${SIDES[k]}Hand`]], mouthAt(fr.s))) < 0.25;
			run ??= { k, kind: a.kind, held: a.held, first: f, worst: f, deg: a.deg, n: 0, mouth: false };
			run.last = f; run.n++; run.mouth ||= mouth;
			if (ORDER[a.kind] < ORDER[run.kind] || (a.kind === run.kind && a.deg > run.deg)) Object.assign(run, { kind: a.kind, deg: a.deg, worst: f });
		});
		close();
	}
	runs.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || b.n - a.n);
	return runs.slice(0, LINES).map(g => `ARM arm_${g.k} ${WORDS[g.kind]} f${g.first}-f${g.last} (worst f${g.worst}, upper arm ${Math.round(g.deg)}deg ${g.kind === "wing" ? "out" : "up"}): ${fixFor(sk, out, g)}`);
}
