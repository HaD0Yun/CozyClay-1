#!/usr/bin/env node
// Lane B (C5 and loose bone names): probes measure this compile, installed or not; their values
// match a direct computation; bad probes get exact messages with a "did you mean"; at most 16
// probes and 16 rows; motion.sample and probes take loose bone names ("hips", "lefthand").
import { createStudioAppActions } from "../../src/commands/index.js";
import { SCENE_OBJECTS, CUP } from "./fixtures/cup-scene.mjs";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { runProbes } from "../../src/motion3/probes.js";
import { refPoint } from "../../src/motion3/refs.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { objectBoxesAt } from "../../src/motion3/object-pose.js";
import { sdBox } from "../../src/motion3/qa/geometry.js";
import { dist } from "../../src/motion3/compiler/math.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const json = v => JSON.stringify(v);

// A Y Bot at the origin walks toward the table (fixtures/cup-scene.mjs) and stops short of it.
const sk = skeletonFor("y-bot-tpose"), I = sk.index, P = sk.restWorldPos, ank = P[I.LeftFoot][1], scene = motionScene(SCENE_OBJECTS);
const spec = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 120,
	keys: [{ f: 0, set: { root: [0, P[I.Hips][1] - 0.01, -1], yaw: 0, foot_l: [0.09, ank, -1.03], foot_r: [-0.09, ank, -0.97], fyaw_l: 0, fyaw_r: 0 } }],
	generators: [{ type: "walk", f0: 4, steps: 4, heading: [0, 0] }] };
const probes = [
	{ name: "hands", distance: ["joint:LeftHand", "joint:RightHand"], frames: [0, 100] },
	{ name: "handToCup", distance: ["joint:LeftHand", `object:${CUP.group}`], frames: [10, 110], every: 4 },
	{ name: "hips", position: "joint:hips", frames: [0, 119] },
	{ name: "cupTop", position: `object:${CUP.group}.top`, frames: [100, 119], every: 5 },
	{ name: "loose", distance: ["bone:lefthand", "joint:mixamorig:RightHand"], frames: [0, 100] },
];
const r = compileSpec(spec, { sk, scene }, { probes }), out = r.out, res = r.probes;
console.log(`  probes: ${json(res).length} bytes`);

// 1. Values against a direct computation.
const direct = [];
for (let f = 0; f <= 100; f++) direct.push([f, dist(out.frames[f].s.P[I.LeftHand], out.frames[f].s.P[I.RightHand])]);
const min = direct.reduce((a, b) => (b[1] < a[1] ? b : a)), max = direct.reduce((a, b) => (b[1] > a[1] ? b : a)), mean = direct.reduce((a, [, v]) => a + v, 0) / direct.length;
const h = res.hands, d = Math.max(...[[h.min, min[1]], [h.max, max[1]], [h.mean, mean], [h.first, direct[0][1]], [h.last, direct[100][1]]].map(([a, b]) => Math.abs(a - b)));
expect("a distance probe matches the joints directly within 1e-6", d <= 1e-6 && h.minAt === min[0] && h.maxAt === max[0], json({ h, min, max, mean, d }));
const surf = [];
for (let f = 10; f <= 110; f += 4) surf.push(Math.max(0, Math.min(...objectBoxesAt(out, CUP.group, f).map(b => sdBox(out.frames[f].s.P[I.LeftHand], b)))));
expect("a joint-to-object probe measures to the part boxes' surface, every 4 frames", Math.abs(res.handToCup.min - Math.min(...surf)) <= 1e-6
	&& Math.abs(res.handToCup.last - surf.at(-1)) <= 1e-6 && (res.handToCup.minAt - 10) % 4 === 0, json({ got: res.handToCup, surf }));
expect("the hand ends closer to the cup than it starts", res.handToCup.last < res.handToCup.first, json(res.handToCup));
expect("a position probe over the whole take fits 16 rows", res.hips.at.length === 15 && res.hips.at[0].f === 0 && res.hips.at[1].f === 8, json(res.hips.at.map(x => x.f)));
expect("its rows are the Hips joint (4 decimals)", res.hips.at.every(({ f, p }) => dist(p, out.frames[f].s.P[I.Hips]) <= 1e-4), json(res.hips.at[3]));
const top = refPoint(out, 105, `object:${CUP.group}.top`);
expect("position with every: 5 answers f100, 105, 110, 115", json(res.cupTop.at.map(x => x.f)) === "[100,105,110,115]" && dist(res.cupTop.at[1].p, top) <= 1e-4, json(res.cupTop));
expect("loose bone names measure the same as exact ones", json(res.loose) === json(res.hands), json([res.loose, res.hands]));

// 2. Exact messages.
const refused = list => { try { runProbes(out, list, { spec: r.expanded, sk, scene }); return "accepted"; } catch (error) { return error.message; } };
const msg = refused([{ name: "a", distance: ["joint:LeftHnad", "joint:RightHand"] }]);
expect("an unknown bone is named with a did-you-mean", msg === 'MOTION_SPEC_INVALID: probes[0].distance[0] "joint:LeftHnad": unknown bone; did you mean "LeftHand"?', msg);
const several = refused([{ name: "a", position: "joint:Hips", distance: ["joint:Hips", "joint:Head"] }, { name: "a", position: "object:nope" }, { position: "joint:Hips", frames: [10, 500] },
	{ name: "b", position: "joint:Hips", every: 2 }, { name: "c", distance: ["joint:Hips"], zzz: 1 }]);
const lines = several.replace(/^MOTION_SPEC_INVALID: /, "").split("\n");
console.log(lines.map(l => `    ${l}`).join("\n"));
expect("every problem is listed at once, one per line", json(lines) === json([
	"probes[0] needs exactly one of distance: [refA, refB] or position: ref",
	"probes[1].name \"a\" is already used by probes[0]; probe names must differ",
	"probes[1].position \"object:nope\" names object \"nope\", which is not in the scene; did you mean \"cube\"?",
	"probes[4] has unknown field \"zzz\"; a probe is { name, distance: [refA, refB] | position: ref, frames: [f0, f1], every }",
	"probes[4].distance must be [refA, refB], two point refs, got [\"joint:Hips\"]"]), several);
// a window partly past the take is cut to it and a position probe's every grows to fit 16 rows, each with a note (lenient.js);
// a window wholly past the take is still refused
const notes = [], fixed = runProbes(out, [{ name: "late", position: "joint:Hips", frames: [100, 500] }, { name: "dense", position: "joint:Hips", every: 2 }], { spec: r.expanded, sk, scene, notes });
expect("a late window is cut to the take and a dense position probe thins to 16 rows, with notes", fixed.late.at.at(-1).f <= 119 && fixed.late.at[0].f === 100 && fixed.dense.at.length <= 16 && fixed.dense.at[1].f - fixed.dense.at[0].f === 8
	&& json(notes) === json(["probes[0].frames [100,500] -> [100,119]: the take is 0..119", "probes[1].every 2 -> 8: a position probe answers at most 16 rows"]), json({ notes, late: fixed.late.at.length, dense: fixed.dense.at.length }));
expect("a window wholly past the take is still refused", refused([{ position: "joint:Hips", frames: [130, 500] }]) === "MOTION_SPEC_INVALID: probes[0].frames must be [f0, f1], integer frames within 0..119 with f0 <= f1, got [130,500]");
const tooMany = refused(Array.from({ length: 17 }, (_, i) => ({ name: `p${i}`, position: "joint:Hips" })));
expect("more than 16 probes are refused", tooMany === "MOTION_SPEC_INVALID: probes has 17 entries; at most 16 per compile", tooMany);

// spec.probes (lane H3a): probes sent inside the spec are measured after the request's, and leave the spec
const inSpec = compileSpec({ ...spec, probes: [probes[2]] }, { sk, scene }, { probes: [probes[0]] });
expect("spec.probes join the request's probes and are not in the filled-in spec", json(Object.keys(inSpec.probes)) === '["hands","hips"]'
	&& json(inSpec.probes.hips) === json(res.hips) && !("probes" in inSpec.spec), json(Object.keys(inSpec.probes ?? {})));
const bareRef = refused([{ name: "a", distance: ["LeftHand", CUP.group] }]);
expect("a bare ref in a probe is refused with the prefixed forms it could mean", bareRef.endsWith(`probes[0].distance[1] "${CUP.group}" must be joint:<Bone>, bone:<Bone>, prop:<prop>.<point>, anchor:<name>, landmark:mouth, object:<id>[.center|.top|.base|.rim], person:<id>.<Bone>; did you mean "object:${CUP.group}"?`)
	&& bareRef.includes('did you mean "joint:LeftHand"?'), bareRef);

// 3. Through motion.compile and motion.sample.
const takes = new Map(), owner = { replace: (id, take) => takes.set(id, take), motionFor: id => takes.get(id) ?? null };
const character = { id: "char-a", model: "y-bot-tpose", subject: "Ada", x: 0, y: 0, z: 0, rot: 0, scale: 1 };
const registry = createStudioAppActions({ state: () => ({ characters: [character], objects: SCENE_OBJECTS, frameCount: 300 }), storeDomain: name => (name === "motion" ? owner : null) });
const run = (id, args) => (x => x?.output ?? x)(registry.run(id, args));
run("motion.compile", { characterId: "char-a", spec });
const installed = takes.get("char-a");
const dry = run("motion.compile", { characterId: "char-a", spec: { ...spec, frames: 100 }, install: false, probes: [{ name: "hands", distance: ["joint:LeftHand", "joint:RightHand"], frames: [0, 99] }] });
expect("install: false answers the probes and leaves the take untouched", dry.installed === false && dry.probes?.hands?.min > 0 && takes.get("char-a") === installed && installed.frames === 120, json(dry.probes));
let bad = null;
try { run("motion.compile", { characterId: "char-a", spec, install: false, probes: [{ name: "x", position: "joint:LeftHnad" }] }); } catch (error) { bad = error; }
expect("a bad probe is INVALID_ARGUMENT with the exact message", bad?.code === "INVALID_ARGUMENT" && bad.message.includes('probes[0].position "joint:LeftHnad": unknown bone; did you mean "LeftHand"?'), `${bad?.code} ${bad?.message}`);
const sample = run("motion.sample", { characterId: "char-a", frames: [0, 60], bones: ["hips", "lefthand", "Hips", "LeftHand"] }).frames;
expect("motion.sample takes \"hips\" and \"lefthand\"", sample.every(row => json(row.bones.hips) === json(row.bones.Hips) && json(row.bones.lefthand) === json(row.bones.LeftHand)), json(sample[1]));
let unknown = null;
try { run("motion.sample", { characterId: "char-a", frames: [0], bones: ["LeftHnad"] }); } catch (error) { unknown = error; }
expect("an unknown bone in motion.sample has a did-you-mean", unknown?.code === "INVALID_ARGUMENT" && unknown.message.includes('Unknown bone LeftHnad; did you mean "LeftHand"?'), `${unknown?.code} ${unknown?.message}`);

if (failures) { console.error(`${failures} motion3 probes check(s) failed`); process.exit(1); }
console.log("motion3 probes: all checks passed");
