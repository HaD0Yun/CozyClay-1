#!/usr/bin/env node
// The physics overlay's numbers (motion3/physics-view.js, physics-trail.js) read from a baked take agree with QA on
// the compiled frames: the frames QA calls BALANCE (centre of mass outside the feet) are the red ones and a clean
// stance is green; the arcs are the FLOAT runs, with the path QA read and the parabola qa/ballistic.js fits; only a
// spring object has a tip trail. The same take gives the same numbers twice. motion.physicsOverlay sets the
// session-only setting.
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { bakeTake } from "../../src/motion3/take.js";
import { buildKit } from "../../src/kits/index.js";
import { styleChecks, floatChecks } from "../../src/motion3/qa/style.js";
import { QA_LIMITS } from "../../src/motion3/qa/checks.js";
import { ballisticArc } from "../../src/motion3/qa/ballistic.js";
import { physicsView, comAt, supportAt, airArcs } from "../../src/motion3/physics-view.js";
import { tipTrails, TRAIL_FRAMES } from "../../src/motion3/physics-trail.js";
import { createStudioAppActions } from "../../src/commands/index.js";
import { physicsOverlaySettings } from "../../src/physics-overlay-settings.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const json = JSON.stringify, SPEC = "cozyclay.motion-spec.v1", G = 9.81 / 24 ** 2;
const PLACE = { position: [0.4, 0, -0.3], yaw: 30 };
const range = n => Array.from({ length: n }, (_, f) => f);
/** Compile spec, bake it at PLACE as the editor installs it, and read the overlay's view of the take. */
function build(sk, spec, records = []) {
	const r = compileSpec(spec, { sk, scene: motionScene(records) });
	const take = bakeTake(sk, r.out, PLACE, { spec });
	return { r, take, view: physicsView(take, records) };
}
const everything = (view, take) => range(take.frameCount).map(f => ({ com: comAt(view, f), support: supportAt(view, f), trail: tipTrails(view, f) }));
const close = (a, b, tol) => a.length === b.length && a.every((p, i) => p.every((v, k) => Math.abs(v - b[i][k]) <= tol));

// 1. BALANCE: upright for 12 frames, then bent far forward over planted feet (verify-motion3-balance.mjs)
{
	const sk = skeletonFor("x-bot-tpose"), I = sk.index, hipY = sk.restWorldPos[I.Hips][1] - 0.01;
	const bend = { root: [0, hipY, 0.22], spine_pitch: 90, head_pitch: 40, armw_l: 1, armw_r: 1, hand_l: [0.2, 1, 0.8], hand_r: [-0.2, 1, 0.8] };
	const stand = extra => ({ schema: SPEC, fps: 24, frames: 40, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0] } }], checks: { limits: { balance: 0.08 } }, fix: { reach: false }, ...extra });
	const lean = stand({ keys: [{ f: 12, set: { root: [0, hipY, 0], spine_pitch: 0, head_pitch: 0 } }, { f: 24, set: bend }, { f: 39, set: bend }] });
	const { r, take, view } = build(sk, lean);
	const checks = r.expanded.checks ?? {}, L = { ...QA_LIMITS, ...checks.limits };
	const qa = new Set(styleChecks(sk, r.out, checks, L).filter(i => i.kind === "BALANCE" && i.msg === "centre of mass outside the feet").map(i => i.frame));
	const states = range(take.frameCount).map(f => comAt(view, f).state), red = new Set(states.flatMap((s, f) => (s === "outside" ? [f] : [])));
	expect("the frames QA calls BALANCE (centre of mass outside the feet) are exactly the red frames", qa.size > 0 && qa.size < take.frameCount && json([...qa].sort((a, b) => a - b)) === json([...red].sort((a, b) => a - b)),
		json({ qa: [...qa], red: [...red] }));
	expect("the upright frames before the bend are green", range(12).every(f => states[f] === "inside"), json(states.slice(0, 12)));
	const com = comAt(view, 30), I2 = r.out.ctx.sk.index;
	expect("the centre of mass is in world space where QA measured it (the take's placement undone)", com.p.every(v => Number.isFinite(v)) && Math.abs(com.p[2] - r.out.frames[30].s.P[I2.Hips][2]) < 0.3 && com.ground === 0, json(com));
	const poly = supportAt(view, 30);
	expect("the support polygon lies on the floor under the feet (3 corners or more)", poly.length >= 3 && poly.every(p => p[1] === 0), json(poly));
	expect("a standing take has no air arc", airArcs(view).length === 0, json(airArcs(view)));
	const clean = build(sk, stand({}));
	expect("a clean stance is green on every frame", range(clean.take.frameCount).every(f => comAt(clean.view, f).state === "inside"));
	const again = build(sk, lean);
	expect("determinism: the same spec baked again gives the same overlay on every frame", json(everything(view, take)) === json(everything(again.view, again.take)));
	expect("determinism: reading a frame twice gives the same answer", json(comAt(view, 17)) === json(comAt(view, 17)) && json(supportAt(view, 17)) === json(supportAt(view, 17)));
}

// 2. FLOAT: a hop whose feet tuck 0.3 m for 8 frames while the hips never move (verify-motion3-float-fix.mjs)
{
	const sk = skeletonFor("x-bot-tpose"), I = sk.index, stand = { skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } };
	const c = compileSpec({ schema: SPEC, fps: 24, frames: 10, use: [stand] }, { sk, scene: motionScene([]) }).out.frames[0].c, { root, foot_l: fl, foot_r: fr } = c;
	const up = v => [v[0], v[1] + 0.3, v[2]], flat = { root, foot_l: fl, foot_r: fr }, tuck = { root, foot_l: up(fl), foot_r: up(fr) };
	const hop = { schema: SPEC, fps: 24, frames: 60, use: [stand], keys: [{ f: 20, set: flat }, { f: 22, set: flat }, { f: 26, set: tuck }, { f: 30, set: tuck }, { f: 34, set: flat }, { f: 40, set: flat }] };
	const { r, view } = build(sk, hop), F = r.out.frames;
	const floats = floatChecks(r.out, r.expanded.checks ?? {}).map(i => i.frame), runs = [];
	for (const f of floats) if (runs.length && runs.at(-1)[1] === f - 1) runs.at(-1)[1] = f; else runs.push([f, f]);
	const arcs = airArcs(view);
	expect("QA calls the held hop FLOAT", runs.length === 1, json(runs));
	expect("the arcs are exactly the FLOAT runs, each marked float", json(arcs.map(a => [a.a, a.b])) === json(runs) && arcs.every(a => a.float), json(arcs.map(a => [a.a, a.b, a.float])));
	const y = F.map(fr => fr.s.P[I.Hips][1]), [a, b] = runs[0], arc = ballisticArc(y, a, b, G, Infinity);
	const want = range(arc.to - arc.from + 1).map(i => { const p = F[arc.from + i].s.P[I.Hips]; return [p[0], i === 0 || i === arc.to - arc.from ? p[1] : p[1] + arc.delta[i - 1], p[2]]; });
	expect("the white path is the hips QA read, anchor to anchor (take float rounding only)", arcs[0] && arcs[0].from === arc.from && arcs[0].to === arc.to && close(arcs[0].path, F.slice(arc.from, arc.to + 1).map(fr => fr.s.P[I.Hips]), 1e-5));
	expect("the orange parabola is qa/ballistic.js's arc on the frames QA read", arcs[0] && close(arcs[0].fit, want, 1e-5) && Math.abs(arcs[0].worst - arc.delta[arc.worst - a]) < 1e-5, json({ fit: arcs[0]?.fit.slice(0, 3), want: want.slice(0, 3) }));
	const mid = Math.round((a + b) / 2);
	expect("off the ground the centre of mass is grey (air) and there is no support polygon", comAt(view, mid).state === "air" && supportAt(view, mid).length === 0, json(comAt(view, mid)));
}

// 3. trails: a carried ball swept by the hand, with and without a spring (verify-motion3-spring.mjs), beside a still box
{
	const sk = skeletonFor("y-bot-tpose"), props = { ballGrip: { hand: "r", origin: ["RightHandIndex2", "RightHandMiddle2"], points: {} } };
	const kit = buildKit("ball", [], { position: { x: 2, y: 1, z: 2 } }), id = kit.rootId;
	const box = { id: "crate", name: "crate", renderer: "cube", x: -1.5, y: 0, z: 1.5, rot: 0, rotX: 0, rotZ: 0, scaleX: 0.4, scaleY: 0.4, scaleZ: 0.4, footprint: { width: 1, depth: 1 }, height: 1 };
	const records = [...kit.records, box];
	const spec = extra => ({ schema: SPEC, fps: 24, frames: 96, use: [{ skill: "standIdle", args: { at: [0, 0], heading: 0 }, f0: 0 }], props,
		objects: { [id]: { prop: "ballGrip", at: [0, 0, -0.035], along: [0, 1, 0], ...extra } }, keys: [{ f: 10, set: { armw_r: 1, hand_r: [-0.2, 1.2, 0.35] } }, { f: 16, set: { hand_r: [0.25, 1.2, 0.35] } }] });
	const sprung = build(sk, spec({ spring: { stiffness: 80, damping: 0.3 } }), records), plain = build(sk, spec({}), records);
	const trail = tipTrails(sprung.view, 40);
	expect(`a spring object has one trail of the last ${TRAIL_FRAMES} frames`, trail.length === 1 && trail[0].id === id && trail[0].points.length === TRAIL_FRAMES, json(trail.map(t => [t.id, t.points.length])));
	expect("near the take's start the trail holds the frames there are", tipTrails(sprung.view, 3)[0]?.points.length === 4);
	const moved = trail[0].points.some(p => Math.hypot(...p.map((v, k) => v - trail[0].points[0][k])) > 0.05);
	expect("the tip travels while the hand sweeps the ball", moved, json(trail[0].points.slice(0, 3)));
	expect("an object without a spring has no trail, nor does a still scene box", tipTrails(plain.view, 40).length === 0 && !trail.some(t => t.id === "crate"));
	expect("determinism: the trail of the same take read twice is the same", json(tipTrails(sprung.view, 60)) === json(tipTrails(build(sk, spec({ spring: { stiffness: 80, damping: 0.3 } }), records).view, 60)));
}

// 4. motion.physicsOverlay: off by default, all / named parts, session-only (no undo entry, no affected id)
{
	const registry = createStudioAppActions({ state: () => ({}) });
	expect("off by default", Object.values(physicsOverlaySettings()).every(v => v === false), json(physicsOverlaySettings()));
	const on = registry.run("motion.physicsOverlay", { all: true });
	expect("{ all: true } turns every part on and answers what is on", Object.values(physicsOverlaySettings()).every(Boolean) && /centre of mass, support polygon, air arcs, spring trails on/.test(on.summary) && on.affectedIds.length === 0, json(on));
	registry.run("motion.physicsOverlay", { arc: false });
	expect("a named part changes only that part", json(physicsOverlaySettings()) === json({ com: true, support: true, arc: false, trail: true }), json(physicsOverlaySettings()));
	const off = registry.run("motion.physicsOverlay", { all: false });
	expect("{ all: false } turns it off", Object.values(physicsOverlaySettings()).every(v => v === false) && off.summary === "Physics overlay off.", json(off));
	let refused = false;
	try { registry.run("motion.physicsOverlay", { colour: "red" }); } catch { refused = true; }
	expect("an unknown field is refused", refused);
}

if (failures) { console.error(`${failures} failed`); process.exit(1); }
console.log("PASS physics overlay");
