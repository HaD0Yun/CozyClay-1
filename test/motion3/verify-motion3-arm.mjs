#!/usr/bin/env node
// Lane arm: a cup at the lips leans by default (src/motion3/face-lean.js) and QA warns about an awkward working arm
// (src/motion3/qa/arm-checks.js). A key at the mouth without lean takes FACE_LEAN, one with lean or roll or away from
// the face keeps its own; an IK arm with its elbow pole up, over the head or flared out with the hand at the chest is
// warned with the frames, the side and the elbow_<side> pole that fixes it, and that pole clears the warning; a lift
// over the head and the default pole are not warned. Then the bench S8 sip compiles: the default lean holds the elbow
// below the shoulder where lean 0 (the aim held exactly) lifts it over, and lean 0 is warned with the keys and the lean
// that fix it; warnings never fail a take, and the output budget keeps them after every group (report.js).
import { readFileSync } from "node:fs";
import { faceLeaned, FACE_LEAN } from "../../src/motion3/face-lean.js";
import { armPose, armWarnings } from "../../src/motion3/qa/arm-checks.js";
import { pose } from "../../src/motion3/compiler/pose.js";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { motionScene } from "../../src/motion3/scene.js";
import { fitOutput } from "../../src/motion3/report.js";
import { cupSip } from "./fixtures/cup-sip.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const sk = skeletonFor("y-bot-tpose"), I = sk.index, json = JSON.stringify;

// ---- faceLeaned: which keys lean ------------------------------------------------------------
const mouth = [0, 1.6, 0.12], entry = { prop: "cupGrip", keys: [
	{ f: 0, pos: [-0.15, 0.76, 0.5], aim: [0, 1, 0] }, { f: 10, pos: [0, 1.5, 0.2], aim: [0, 0.8, -0.6] },
	{ f: 20, pos: [0, 1.5, 0.2], aim: [0, 0.8, -0.6], lean: 10 }, { f: 30, pos: [0, 1.5, 0.2], aim: [0, 0.8, -0.6], roll: 0 }, { f: 40, pos: [0, 1.5, 0.2], rot: [0, 0, 0, 1] }] };
const leaned = faceLeaned(entry, 0.1, () => mouth);
expect("a mouth key without lean or roll takes FACE_LEAN and says so", leaned.keys[1].lean === FACE_LEAN && leaned.keys[1].leaned === true, json(leaned.keys[1]));
expect("a key away from the face, one with lean or roll, and a rot key keep their own", [0, 2, 3, 4].every(i => leaned.keys[i] === entry.keys[i]), json(leaned.keys));
expect("an entry with no mouth key comes back as itself", faceLeaned(entry, 0.1, () => [5, 5, 5]) === entry);

// ---- armWarnings on IK arms ------------------------------------------------------------------
/** n frames of the right arm on its IK to hand_r with elbow pole `elbow` (body frame), as a compile solves them. */
function arm(hand, elbow, n = 8) {
	const c = { armw_r: 1, hand_r: hand, ...(elbow ? { elbow_r: elbow } : {}) };
	const frames = Array.from({ length: n }, () => { const { s, diag } = pose(sk, c, { handTarget: k => c[`hand_${k}`] }); return { s, diag, c }; });
	return { frames, fps: 24, ctx: { spec: {} } };
}
const lips = [-0.06, 1.52, 0.16], chest = [-0.1, 1.35, 0.06];
const down = arm(lips), up = arm(lips, [-0.2, 1, -0.3]), wing = arm(chest, [-1, 0.6, -0.3]), lift = arm([-0.2, 2.05, 0.05], [-0.5, 1, 0]);
const warnsUp = armWarnings(sk, up), warnsWing = armWarnings(sk, wing);
console.log(`  up: ${warnsUp[0]}\n  wing: ${warnsWing[0]}`);
expect("the default pole with the hand at the lips is not warned", armWarnings(sk, down).length === 0, json(armWarnings(sk, down)));
expect("an elbow keyed up with the hand at the lips is warned on that side and frames", /^ARM arm_r (elbow over the shoulder|upper arm wraps over the head) f0-f7 /.test(warnsUp[0] ?? ""), json(warnsUp));
const pole = /key elbow_r \[([^\]]+)\]/.exec(warnsUp[0] ?? "")?.[1]?.split(", ").map(Number);
expect("its fix keys elbow_r down, a little out and in front of the chest", pole?.[0] < 0 && pole?.[1] === -1 && pole?.[2] > 0, json(pole));
expect("that pole clears the warning", pole && armWarnings(sk, arm(lips, pole)).length === 0, json(pole && armWarnings(sk, arm(lips, pole))));
const inward = /key elbow_r \[([^\]]+)\]/.exec(warnsWing[0] ?? "")?.[1]?.split(", ").map(Number);
expect("an elbow flared out with the hand at the chest is a wing", /^ARM arm_r elbow flared out to the side f0-f7 /.test(warnsWing[0] ?? "") && inward?.[1] === -1, json(warnsWing));
expect("its pole clears it", inward && armWarnings(sk, arm(chest, inward)).length === 0, json(inward && armWarnings(sk, arm(chest, inward))));
expect("a lift over the head is not warned", armWarnings(sk, lift).length === 0 && armPose(sk, lift.frames[0], "r") === null, json(armWarnings(sk, lift)));
expect("an FK arm is not read", armPose(sk, { ...up.frames[0], c: { armw_r: 0 } }, "r") === null);

// ---- the bench S8 sip compiled ---------------------------------------------------------------
const scene = motionScene(JSON.parse(readFileSync(new URL("../fixtures/bench/S8.cozyclay.json", import.meta.url))).scenes.scenes[0].objects);
const elevation = r => {
	const el = r.out.frames.slice(66, 91).map(({ s }) => { const v = s.P[I.RightForeArm].map((x, j) => x - s.P[I.RightArm][j]); return Math.acos(-v[1] / Math.hypot(...v)) * 180 / Math.PI; });
	return { max: Math.max(...el), mean: el.reduce((a, b) => a + b) / el.length };
};
const t0 = performance.now(), byDefault = compileSpec(cupSip(), { sk, scene }), exact = compileSpec(cupSip(0), { sk, scene }), asked = compileSpec(cupSip(FACE_LEAN), { sk, scene });
const ms = performance.now() - t0, eD = elevation(byDefault), e0 = elevation(exact), eA = elevation(asked);
console.log(`  upper arm at the lips, deg from hanging: default ${eD.mean.toFixed(0)} (max ${eD.max.toFixed(0)}), lean 0 ${e0.mean.toFixed(0)} (max ${e0.max.toFixed(0)}); 3 compiles ${ms.toFixed(0)} ms`);
console.log(`  lean 0 warns: ${json(exact.qa.warnings)}`);
const held = byDefault.observations.held?.cup ?? [];
expect("the mouth keys lean FACE_LEAN by default, and observations.held says so", held[2]?.lean === FACE_LEAN && held[3]?.lean === FACE_LEAN && held[1]?.lean === undefined, json(held.slice(1, 4)));
expect("the default holds the elbow below the shoulder at the lips", eD.max < 90 && !(byDefault.qa.warnings ?? []).length, `${json(eD)} ${json(byDefault.qa.warnings)}`);
expect("lean 0 holds the aim exactly and lifts the elbow over the shoulder", e0.mean > 105 && held.length && (exact.observations.held?.cup?.[2]?.lean === undefined), json(e0));
expect("the default is the lean asked", Math.abs(eD.mean - eA.mean) < 1e-9, `${eD.mean} vs ${eA.mean}`);
expect("lean 0 is warned with the mouth keys and the lean that fixes it", /^ARM arm_r (elbow over the shoulder|upper arm wraps over the head) f\d+-f\d+ .*objects\.cup\.keys\[2\] \(f66\), objects\.cup\.keys\[3\] \(f90\) lean 45/.test(exact.qa.warnings?.[0] ?? ""), json(exact.qa.warnings));
expect("warnings never fail a take", exact.qa.ok === (exact.qa.total === 0) && exact.qa.groups.every(g => g.kind !== "ARM"), json(exact.qa.groups.map(g => g.kind)));

// ---- the output budget keeps warnings after every group ---------------------------------------
const group = i => ({ kind: "BODY", subject: `hand_r into torso_hi ${i}`, count: 3, severity: 4, first: i, last: i + 2, worst: 0.03, limit: 0.015, hint: "h".repeat(300) });
const full = n => ({ frames: 100, specId: "spec-0", qa: { ok: false, total: n, groups: Array.from({ length: n }, (_, i) => group(i)), warnings: ["w".repeat(400), "v".repeat(400)] } });
const roomy = fitOutput(full(6), 4000), tight = fitOutput(full(40), 4000);
expect("with room, the warnings stay", roomy.qa.warnings?.length === 2, json(roomy.qa.warnings?.length));
expect("without room, the groups keep it and the warnings go", !tight.qa.warnings && tight.qa.groups.length > 6, `${tight.qa.groups.length} groups, warnings ${json(tight.qa.warnings?.length)}`);

console.log(failures ? `\n${failures} failure(s)` : "\nall arm checks passed");
process.exit(failures ? 1 : 0);
