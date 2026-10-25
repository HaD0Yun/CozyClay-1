#!/usr/bin/env node
// Spring secondary motion (spec.objects[id].spring, compiler/spring.js): a carried or free object swings a beat behind
// its anchor's acceleration and settles. A still anchor never swings and a spec without spring bakes as before; a stop
// rings a swing that decays under 1 degree; more damping settles sooner; the same spec bakes the same take twice; a
// stiffness past the stable range and a spring on a hinge are refused; the solver uses no transcendental functions.
import { readFileSync } from "node:fs";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { buildKit } from "../../src/kits/index.js";
import { bakeTake } from "../../src/motion3/take.js";
import { validateSpec } from "../../src/motion3/compiler/validate.js";
import { springAngles } from "../../src/motion3/compiler/spring.js";
import { mul, T } from "../../src/motion3/compiler/math.js";
import { takeHash } from "./fixtures/take-hash.mjs";
import { rootPoseAt } from "../../src/motion3/object-pose.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` - ${detail}`}`);
	if (!condition) failures += 1;
}
const DEG = 180 / Math.PI, FPS = 24;
const sk = skeletonFor("y-bot-tpose");
const STAND = { skill: "standIdle", args: { at: [0, 0], heading: 0 }, f0: 0 };
const spec = (frames, objects, extra = {}) => ({ schema: "cozyclay.motion-spec.v1", fps: FPS, frames, use: [STAND], objects, ...extra });
const turnDeg = (A, B) => Math.acos(Math.max(-1, Math.min(1, (mul(A, T(B)).reduce((s, row, i) => s + row[i], 0) - 1) / 2))) * DEG;
const swings = (with_, without, id, frames) => Array.from({ length: frames }, (_, f) => turnDeg(rootPoseAt(with_, id, f).R, rootPoseAt(without, id, f).R));

// the solver alone: a still anchor, a stop, damping
{
	const still = springAngles({ anchors: Array.from({ length: 48 }, () => [0.3, 1, 0.2]), fps: FPS, stiffness: 80, damping: 0.3, length: 0.2 });
	expect("(a) a still anchor never swings (every frame exactly 0)", still.every(([a, b]) => a === 0 && b === 0), JSON.stringify(still.slice(0, 3)));
	// moving at 1.5 m/s along +X for 12 frames, then stopped dead for 3 s
	const anchors = Array.from({ length: 12 + 72 }, (_, f) => [Math.min(f, 12) * 1.5 / FPS, 1, 0]);
	const run = d => springAngles({ anchors, fps: FPS, stiffness: 80, damping: d, length: 0.2 }).map(([a]) => a * DEG);
	const th = run(0.3), after = th.slice(13), peak = Math.max(...after.map(Math.abs)), last = Math.abs(th.at(-1));
	console.log(`  stop: peak ${peak.toFixed(2)} deg after the stop, last frame ${last.toFixed(4)} deg`);
	expect("(b) a sudden stop rings a swing (peak > 5 deg) that decays under 1 deg by the last frame", peak > 5 && last < 1, `${peak} ${last}`);
	const tail = a => Math.max(...a.slice(13 + 24).map(Math.abs)), lo = tail(run(0.1)), hi = tail(run(0.9));
	expect("(c) damping 0.9 settles sooner than 0.1 (largest swing 1 s after the stop)", hi < lo, `${hi} vs ${lo}`);
	expect("the swing is clamped to 60 deg", springAngles({ anchors: anchors.map(p => [p[0] * 40, 1, 0]), fps: FPS, stiffness: 10, damping: 0, length: 0.05 }).every(([a]) => Math.abs(a) <= Math.PI / 3 + 1e-12));
}

// a free ball keyed on every frame: still to frame 6, across 1 m at 2 m/s by frame 18, then still for 3 s
{
	const kit = buildKit("ball", [], { position: { x: 0.5, y: 1.0, z: 0.5 } }), id = kit.rootId, scene = motionScene(kit.records), R = [0, 0, 0, 1];
	const keys = Array.from({ length: 96 }, (_, f) => ({ f, pos: [0.5 + Math.max(0, Math.min(12, f - 6)) / 12, 1, 0.5], rot: R }));
	const base = spec(96, { [id]: { keys } }), sprung = spec(96, { [id]: { keys, spring: { stiffness: 80, damping: 0.3 } } });
	const a = compileSpec(base, { sk, scene }), b = compileSpec(sprung, { sk, scene }), c = compileSpec(sprung, { sk, scene });
	const sw = swings(b.out, a.out, id, 96), peak = Math.max(...sw.slice(18)), last = sw.at(-1);
	console.log(`  free keys: peak ${peak.toFixed(2)} deg after the stop, last frame ${last.toFixed(4)} deg`);
	expect("(a) before the ball moves it does not swing", sw.slice(0, 7).every(v => v === 0), sw.slice(0, 7).join());
	expect("(b) a keyed free object swings after its keys stop (peak > 1 deg) and settles under 1 deg", peak > 1 && last < 1, `${peak} ${last}`);
	const pos = f => [rootPoseAt(a.out, id, f).pos, rootPoseAt(b.out, id, f).pos];
	expect("the spring never moves the object, only turns it", Array.from({ length: 96 }, (_, f) => pos(f)).every(([p, q]) => p.every((v, i) => v === q[i])));
	const place = { position: [0, 0, 0], yaw: 0 }, h1 = takeHash(bakeTake(sk, b.out, place)), h2 = takeHash(bakeTake(sk, c.out, place));
	expect(`(d) the same spec bakes the same take twice (${h1})`, h1 === h2, `${h1} vs ${h2}`);
	expect("a spring changes the take", h1 !== takeHash(bakeTake(sk, a.out, place)));
	const scrub = [95, 40, 20].map(f => rootPoseAt(b.out, id, f).R), fresh = compileSpec(sprung, { sk, scene }).out;
	expect("frames read out of order (a scrub) give the frames read in order", [95, 40, 20].every((f, i) => turnDeg(scrub[i], rootPoseAt(fresh, id, f).R) === 0 || turnDeg(scrub[i], rootPoseAt(fresh, id, f).R) < 1e-9));
}

// a carried ball: the hand still (standIdle) leaves it flat and the take as without spring; the hand moving makes it swing
{
	const props = { ballGrip: { hand: "r", origin: ["RightHandIndex2", "RightHandMiddle2"], points: {} } };
	const kit = buildKit("ball", [], { position: { x: 2, y: 1, z: 2 } }), id = kit.rootId, scene = motionScene(kit.records), place = { position: [0, 0, 0], yaw: 0 };
	const carry = extra => ({ prop: "ballGrip", at: [0, 0, -0.035], along: [0, 1, 0], ...extra });
	// idle false: a held pose that does not breathe, so the hand is still
	const still = compileSpec(spec(48, { [id]: carry() }, { props, idle: false }), { sk, scene }), stillSpring = compileSpec(spec(48, { [id]: carry({ spring: {} }) }, { props, idle: false }), { sk, scene });
	const sw = swings(stillSpring.out, still.out, id, 48);
	console.log(`  carried, still hand: largest swing ${Math.max(...sw).toFixed(4)} deg`);
	expect("(a) a carry on a still hand does not swing (under 0.01 deg on every frame)", Math.max(...sw) < 0.01, sw.join());
	const plain = takeHash(bakeTake(sk, still.out, place));
	// pinned from the tree before spring (3.1.6)
	expect("(a) the same carry without spring bakes as before (take hash 63875903baf607b9)", plain === "63875903baf607b9", plain);
	const move = s => ({ ...s, keys: [{ f: 10, set: { armw_r: 1, hand_r: [-0.2, 1.2, 0.35] } }, { f: 16, set: { hand_r: [0.25, 1.2, 0.35] } }] });
	const m0 = compileSpec(move(spec(96, { [id]: carry() }, { props })), { sk, scene }), m1 = compileSpec(move(spec(96, { [id]: carry({ spring: { stiffness: 80, damping: 0.3 } }) }, { props })), { sk, scene });
	const ms = swings(m1.out, m0.out, id, 96), peak = Math.max(...ms);
	console.log(`  carried, hand swept and stopped: peak ${peak.toFixed(2)} deg, last frame ${ms.at(-1).toFixed(4)} deg`);
	expect("(b) a carry swept by the hand swings (peak > 1 deg) and settles under 1 deg", peak > 1 && ms.at(-1) < 1, `${peak} ${ms.at(-1)}`);
	const h = takeHash(bakeTake(sk, m1.out, place));
	expect("(d) the carried spring bakes the same take twice", h === takeHash(bakeTake(sk, compileSpec(move(spec(96, { [id]: carry({ spring: { stiffness: 80, damping: 0.3 } }) }, { props })), { sk, scene }).out, place)));
}

// validation: the stable range, unknown fields, hinges
{
	const kit = buildKit("ball", [], { position: { x: 0.5, y: 1.0, z: 0.5 } }), id = kit.rootId, scene = motionScene(kit.records);
	const refused = objects => { try { validateSpec(spec(24, objects), { sk, scene }); return ""; } catch (error) { return error.message; } };
	const keys = [{ f: 0, pos: [0.5, 1, 0.5], rot: [0, 0, 0, 1] }];
	const stiff = refused({ [id]: { keys, spring: { stiffness: 5000 } } });
	expect("(e) stiffness 5000 is refused with its range", /spring\.stiffness must be 0\.\.2000/.test(stiff), stiff);
	expect("damping 1.5 is refused", /spring\.damping must be 0\.\.1/.test(refused({ [id]: { keys, spring: { damping: 1.5 } } })));
	expect("an unknown spring field is refused by name", /spring has unknown field "stifness"/.test(refused({ [id]: { keys, spring: { stifness: 50 } } })));
	const hinge = refused({ [id]: { pivot: [0, 0, 0], channel: "door", spring: { stiffness: 50 } } });
	expect("a spring on a hinge is refused (spring is not for hinged objects)", /spring is not for hinged objects/.test(hinge), hinge);
	expect("a valid spring passes", refused({ [id]: { keys, spring: { stiffness: 60, damping: 0.2 } } }) === "");
}

// (f) the solver file uses only + - * / and Math.sqrt
{
	const src = readFileSync(new URL("../../src/motion3/compiler/spring.js", import.meta.url), "utf8");
	expect("(f) compiler/spring.js has no Math.exp / sin / cos / pow / atan", !/Math\.(exp|sin|cos|pow|atan)/.test(src));
}

if (failures) { console.error(`${failures} spring check(s) failed`); process.exit(1); }
console.log("motion3 spring: all checks passed");
