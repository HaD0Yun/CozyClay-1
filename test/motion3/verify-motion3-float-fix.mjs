#!/usr/bin/env node
// FLOAT fix: a run off the ground in which the hips do not fall gets a root patch along the ballistic arc
// (qa/ballistic.js: a gravity parabola anchored at the frames just before takeoff and just after landing).
// The arc itself (zero on a true parabola, the closed-form apex on a held run, refused without anchors or past
// 0.5 m); on a compiled hop held flat the hint names the amount, the patch lifts the root keys by the arc, the
// patched spec has no FLOAT and repair keeps it; the same spec gives the same hint and take; a run that touches
// the end of the take gets the hint's words and no patch.
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { applyPatch } from "../../src/motion3/json-patch.js";
import { repairSpec } from "../../src/motion3/repair.js";
import { bakeTake } from "../../src/motion3/take.js";
import { ballisticArc, arcFrames, MAX_FIX } from "../../src/motion3/qa/ballistic.js";
import { takeHash } from "./fixtures/take-hash.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const G = 9.81 / 24 ** 2, near = (a, b, tol) => Math.abs(a - b) <= tol;

// 1. the arc
const parabola = Array.from({ length: 14 }, (_, f) => 1 + 0.12 * f - G / 2 * f * f);
const onArc = ballisticArc(parabola, 1, 12, G);
expect("a hop that already rides a gravity parabola needs no correction", onArc && onArc.delta.every(d => Math.abs(d) < 1e-9) && near(onArc.v0, 0.12, 1e-9), JSON.stringify(onArc));
const flat = Array(14).fill(1), held = ballisticArc(flat, 1, 12, G);
expect("hips held flat over 12 frames: the arc lifts them g T^2 / 8 at the middle, from f0 to f13", held && held.from === 0 && held.to === 13 && near(Math.max(...held.delta), G * 13 * 13 / 8, 0.01) && held.delta.every(d => d > 0),
	JSON.stringify(held));
expect("three keys at 1/4, 1/2 and 3/4 of the way between the anchors", JSON.stringify(arcFrames(held)) === JSON.stringify([3, 7, 10]), JSON.stringify(arcFrames(held)));
expect("no anchor (the run starts at the first frame or ends at the last) means no arc", ballisticArc(flat, 0, 12, G) === null && ballisticArc(flat, 1, 13, G) === null);
expect(`a correction past ${MAX_FIX} m is refused (the run needs fewer frames, not a higher arc)`, ballisticArc(Array(30).fill(1), 1, 28, G) === null);

// 2. a compiled hop held flat: the feet tuck 0.3 m for 8 frames, the hips never move
const SPEC = "cozyclay.motion-spec.v1", stand = { skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } };
const up = (v, dy) => [v[0], v[1] + dy, v[2]];
for (const model of ["x-bot-tpose", "y-bot-tpose"]) {
	const sk = skeletonFor(model), scene = motionScene([]), compile = s => compileSpec(s, { sk, scene });
	const c = compile({ schema: SPEC, fps: 24, frames: 10, use: [stand] }).out.frames[0].c, { root, foot_l: fl, foot_r: fr } = c;
	const hop = (frames = 60) => ({ schema: SPEC, fps: 24, frames, use: [stand], keys: [
		{ f: 20, set: { root, foot_l: fl, foot_r: fr } }, { f: 22, set: { root, foot_l: fl, foot_r: fr } },
		{ f: 26, set: { root, foot_l: up(fl, 0.3), foot_r: up(fr, 0.3) } }, { f: 30, set: { root, foot_l: up(fl, 0.3), foot_r: up(fr, 0.3) } },
		...(frames > 34 ? [{ f: 34, set: { root, foot_l: fl, foot_r: fr } }, { f: 40, set: { root, foot_l: fl, foot_r: fr } }] : [])] });
	const r = compile(hop()), g = r.qa.groups.find(x => x.kind === "FLOAT");
	const m = /hips should be (\d+) cm higher at f(\d+) \(ballistic arc from f(\d+) to f(\d+)\)/.exec(g?.hint ?? "");
	expect(`${model}: the held hop is FLOAT and its hint gives the arc's amount and frames`, g && m && +m[3] === g.first - 1 && +m[4] === g.last + 1, JSON.stringify(g));
	const T = g.last - g.first + 2, apex = G * T * T / 8;
	expect(`${model}: the hint lifts the hips ${Math.round(apex * 100)} cm (g T^2 / 8 for T = ${T}) at the middle of the run`, m && near(+m[1] / 100, apex, 0.011) && near(+m[2], (g.first + g.last) / 2, 0.5), g?.hint);
	const roots = (g?.patch ?? []).map(o => o.value?.set?.root ?? o.value);
	expect(`${model}: the patch moves the root keys inside the run up, along the arc, never sideways`, g?.patch?.length >= 1 && roots.every(v => v[1] > root[1] + 0.2 && v[1] <= root[1] + apex + 1e-3 && v[0] === Math.round(root[0] * 1e4) / 1e4 && v[2] === Math.round(root[2] * 1e4) / 1e4),
		JSON.stringify(g?.patch));
	const after = compile(applyPatch(hop(), g.patch)), g2 = after.qa.groups.find(x => x.kind === "FLOAT");
	expect(`${model}: the patched hop rides the arc: no FLOAT (or a smaller one), no more problems`, (!g2 || g2.worst < g.worst) && after.qa.problems <= r.qa.problems, JSON.stringify(after.qa.groups.map(x => `${x.kind} ${x.subject}`)));
	const fixed = repairSpec(hop(), { rounds: 4 }, compile);
	expect(`${model}: repair keeps the ballistic patch`, fixed.repair.applied.some(a => a.kind === "FLOAT") && !fixed.result.qa.groups.some(x => x.kind === "FLOAT"), JSON.stringify(fixed.repair));
	// 3. deterministic
	const again = compile(hop()), g3 = again.qa.groups.find(x => x.kind === "FLOAT");
	expect(`${model}: the same spec gives the same hint, patch and take`, g3?.hint === g.hint && JSON.stringify(g3?.patch) === JSON.stringify(g.patch) && takeHash(bakeTake(sk, again.out)) === takeHash(bakeTake(sk, r.out)));
	// 4. a run that touches the end of the take: no landing anchor, the words only
	const cut = compile(hop(32)), g4 = cut.qa.groups.find(x => x.kind === "FLOAT");
	expect(`${model}: a run to the last frame keeps the hint's words, no arc and no patch`, g4 && g4.last === 31 && /lower the root/.test(g4.hint) && !/ballistic arc/.test(g4.hint) && !g4.patch && !g4.fix, JSON.stringify(g4));
}

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log("\nall float-fix checks passed");
