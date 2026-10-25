#!/usr/bin/env node
// Spring secondary motion (spec.objects[id].spring, compiler/spring.js): a carried or free object swings a beat behind
// its anchor's acceleration and settles. A still anchor never swings and a spec without spring bakes as before; a stop
// rings a swing that decays under 1 degree; more damping settles sooner; the same spec bakes the same take twice; a
// stiffness past the stable range and a spring on a hinge are refused; every allowed setting stays finite and settles;
// a free spring's obstacle box tilts as drawn; a free spring that lands stops swinging, every corner on the floor; a keyed carry swings without a false REACH; the solver uses no
// transcendental functions. Defaults: a length without stiffness is k = 9.81 / L, damping 0.5; the research's V2 bag
// swings within its targets, and a base far from the hand is a SPRING_PIVOT observation.
import { readFileSync } from "node:fs";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { buildKit } from "../../src/kits/index.js";
import { bakeTake } from "../../src/motion3/take.js";
import { validateSpec } from "../../src/motion3/compiler/validate.js";
import { springAngles, springOpts, SPRING } from "../../src/motion3/compiler/spring.js";
import { mul, T } from "../../src/motion3/compiler/math.js";
import { takeHash } from "./fixtures/take-hash.mjs";
import { rootPoseAt, basePoseAt } from "../../src/motion3/object-pose.js";
import { corners, fallPlans } from "../../src/motion3/free-motion.js";
import { SCENE_OBJECTS as BAT_SCENE, SWING_SPEC, SWING_KEYS, BAT } from "./fixtures/bat-swing.mjs";

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
const freeCtxOf = out => ({ spec: out.ctx.spec, scene: out.ctx.scene, timeMap: out.timeMap });
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

// stability over the allowed range: a 1 mm anchor move at frame 2, then still for 1000 frames. Every point stays finite
// and its 50-frame swing peaks never grow; a damped spring (stiffness and damping above 0) settles under 0.01 deg.
// (stiffness 0 has nothing to swing back; damping 0 rings on undamped, so they are only held bounded.)
{
	const bad = [];
	for (const stiffness of [0, 80, SPRING.stiffness.max]) for (const damping of [0, 0.5, 1]) for (const fps of [24, 30, 60]) {
		const anchors = Array.from({ length: 1000 }, (_, f) => [f >= 2 ? 0.001 : 0, 1, 0]);
		const th = springAngles({ anchors, fps, stiffness, damping, length: 0.2 }).map(([a]) => Math.abs(a) * DEG);
		const peaks = Array.from({ length: 20 }, (_, i) => Math.max(...th.slice(i * 50, i * 50 + 50)));
		const finite = th.every(Number.isFinite), shrinking = peaks.slice(1).every((v, i) => v <= peaks[i] * (damping ? 1 : 1.01) + 1e-12);
		const settled = !(stiffness && damping) || th.at(-1) < 0.01;
		if (!(finite && shrinking && settled)) bad.push(`k ${stiffness} d ${damping} fps ${fps}: last ${th.at(-1)} peaks ${peaks.slice(0, 4).map(v => v.toFixed(3))}`);
	}
	expect(`(g) a 1 mm nudge stays finite, never rings up and settles over stiffness {0, 80, ${SPRING.stiffness.max}} x damping {0, 0.5, 1} x fps {24, 30, 60}`, bad.length === 0, bad.join("; "));
	const big = springAngles({ anchors: Array.from({ length: 1000 }, (_, f) => [f >= 2 ? 0.001 : 0, 1, 0]), fps: 24, stiffness: 2000, damping: 0.3, length: 0.2 });
	expect("the implicit damping keeps even stiffness 2000, damping 0.3 at 24 fps finite and settled (it diverged before)", big.every(([a]) => Number.isFinite(a)) && Math.abs(big.at(-1)[0]) * DEG < 0.01, String(big.at(-1)));
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

// a tall keyed box with spring {} stopped dead: the obstacle box QA and fixes read (out.objectsAt) tilts as drawn
{
	const scene = motionScene([{ id: "post", name: "post", renderer: "cube", x: 1.5, y: 0, z: 1.5, rot: 0, rotX: 0, rotZ: 0, scaleX: 0.2, scaleY: 1.2, scaleZ: 0.2, footprint: { width: 1, depth: 1 }, height: 1 }]);
	const keys = [{ f: 4, pos: [1.5, 0, 1.5] }, { f: 12, pos: [2.5, 0, 1.5] }];
	const { out } = compileSpec(spec(60, { post: { keys, spring: {} } }), { sk, scene });
	const tilt = Array.from({ length: 60 }, (_, f) => turnDeg(out.objectsAt(f).post.R, scene.objects.post.R)), drawn = Array.from({ length: 60 }, (_, f) => turnDeg(rootPoseAt(out, "post", f).R, scene.objects.post.R));
	const off = Math.max(...tilt.map((v, f) => Math.abs(v - drawn[f]))), peak = Math.max(...tilt.slice(12));
	console.log(`  free box obstacle: peak tilt ${peak.toFixed(2)} deg after the stop, largest gap to the drawn pose ${off.toExponential(1)} deg`);
	expect("the obstacle box of a free spring object tilts as drawn (out.objectsAt R = rootPoseAt R, peak > 1 deg)", peak > 1 && off < 1e-6, `${peak} ${off}`);
}

// a 1 m box keyed across 1 m and stopped, still swinging when it falls 1 m (fall at 9, bounce 0, tumble false): landed,
// it hangs from nothing, so the swing stops and no corner of the drawn pose or the obstacle box goes into the floor
{
	const scene = motionScene([{ id: "box", name: "box", renderer: "cube", x: 0, y: 1, z: 0, rot: 0, rotX: 0, rotZ: 0, scaleX: 0.3, scaleY: 1, scaleZ: 0.3, footprint: { width: 1, depth: 1 }, height: 1 }]);
	const box = { keys: [{ f: 0, pos: [0, 1, 0] }, { f: 8, pos: [1, 1, 0] }], fall: { at: 9, bounce: 0, tumble: false }, spring: {} }, sp = spec(72, { box });
	const a = compileSpec(sp, { sk, scene }).out, b = compileSpec(sp, { sk, scene }).out, half = scene.objects.box.half;
	const land = Math.ceil(fallPlans(freeCtxOf(a), "box")[0].land), low = p => Math.min(...corners({ ...p, half }).map(c => c[1]));
	const after = Array.from({ length: 72 - land }, (_, i) => Math.min(low(rootPoseAt(a, "box", land + i)), low(a.objectsAt(land + i).box)));
	const swungBefore = turnDeg(rootPoseAt(a, "box", land - 1).R, scene.objects.box.R), lowest = Math.min(...after);
	console.log(`  falling spring box: swing ${swungBefore.toFixed(2)} deg the frame before landing (f${land}), lowest corner after ${lowest.toFixed(4)} m`);
	expect("a free spring box that lands still swinging keeps every corner on the floor (>= -1 mm on every frame after landing)", swungBefore > 1 && lowest >= -0.001, `${swungBefore} ${lowest}`);
	const place = { position: [0, 0, 0], yaw: 0 }, h1 = takeHash(bakeTake(sk, a, place));
	expect(`the falling spring box bakes the same take twice (${h1})`, h1 === takeHash(bakeTake(sk, b, place)));
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

// a keyed carry with a spring: the bat swing keyed at four frames (fix.self off, as verify-motion3-carried). The hand
// follows the keys and the swing rides on top, so REACH (measured before the swing) finds the bat on its keys
{
	const bscene = motionScene(BAT_SCENE), sp = structuredClone(SWING_SPEC);
	Object.assign(sp.objects[BAT], { keys: SWING_KEYS, spring: {} });
	sp.fix = { ...(sp.fix ?? {}), self: false };
	const { out, qa } = compileSpec(sp, { sk, scene: bscene }), off = qa.groups.filter(g => g.kind === "REACH" && /off its keys/.test(g.subject));
	const sw = Array.from({ length: sp.frames }, (_, f) => turnDeg(rootPoseAt(out, BAT, f).R, basePoseAt(out, BAT, f).R));
	// the stop: the bat's base is fastest through the zone, then brakes hard; a pendulum peaks after it
	const speed = Array.from({ length: sp.frames }, (_, f) => (f ? Math.hypot(...[0, 2].map(i => basePoseAt(out, BAT, f).pos[i] - basePoseAt(out, BAT, f - 1).pos[i])) : 0));
	const peakAt = sw.indexOf(Math.max(...sw)), stop = speed.indexOf(Math.max(...speed));
	console.log(`  keyed bat: ${off.length} REACH off its keys, swing peak ${sw[peakAt].toFixed(2)} deg at f${peakAt}, the base fastest at f${stop} (keys f${SWING_KEYS[0].f}..f${SWING_KEYS.at(-1).f})`);
	expect("a spring on a keyed carry: REACH finds no key missed (0 'off its keys')", off.length === 0, off.map(g => `${g.subject} (${g.count})`).join("; "));
	expect("the keyed bat swings (peak > 1 deg), peaking after it stops (its base's fastest frame, then braking)", sw[peakAt] > 1 && peakAt > stop, `${sw[peakAt]} at f${peakAt}, fastest f${stop}`);
}

// defaults (follow-up 3): length given and stiffness left out is a pendulum of that length, k = 9.81 / L; damping 0.5
{
	const anchors = Array.from({ length: 12 + 72 }, (_, f) => [Math.min(f, 12) * 1.5 / FPS, 1, 0]), same = (a, b) => a.every(([x, z], i) => x === b[i][0] && z === b[i][1]);
	const lone = springAngles({ anchors, fps: FPS, length: 0.5 });
	expect("(a) length 0.5 without stiffness swings as stiffness 19.62 (9.81 / 0.5), bit for bit", same(lone, springAngles({ anchors, fps: FPS, length: 0.5, stiffness: 19.62, damping: 0.5 })) && !same(lone, springAngles({ anchors, fps: FPS, length: 0.5, stiffness: 80, damping: 0.5 })));
	expect("(b) damping defaults to 0.5 (SPRING.damping.default, and the solver with damping left out)", SPRING.damping.default === 0.5 && same(springAngles({ anchors, fps: FPS, length: 0.5, stiffness: 30 }), springAngles({ anchors, fps: FPS, length: 0.5, stiffness: 30, damping: 0.5 })));
	expect("springOpts: a given stiffness and damping are kept, the length falls back to the object's", JSON.stringify(springOpts({ stiffness: 60, damping: 0.2 }, 24, 0.13)) === JSON.stringify({ fps: 24, stiffness: 60, damping: 0.2, length: 0.13 }));
}

// (c) the research's V2 bag (logs demo-redo A.2b): a 0.26 m box carried by its base at the hand (at [0.04, 0, 0] along
// [1, 0, 0]), walkTo armSwing 0, spring { length: 0.5, damping: 0.5 }: under 15 deg while walking, a 15..30 deg swing
// after the stop that stays under 5 deg within 1.2 s. The same bag carried by its far end (at [0.3, 0, 0]) is SPRING_PIVOT.
{
	const xsk = skeletonFor("x-bot-tpose"), scene = motionScene([{ id: "cube", name: "Bag", renderer: "cube", x: 1.5, y: 0, z: 1.5, rot: 0, rotX: 0, rotZ: 0, scaleX: 0.1, scaleY: 0.26, scaleZ: 0.1, footprint: { width: 1, depth: 1 }, height: 1 }]);
	const bag = (obj, walk) => ({ schema: "cozyclay.motion-spec.v1", fps: FPS, frames: 148, props: { bagGrip: { hand: "r", origin: ["RightHandIndex2", "RightHandMiddle2"], points: {} } },
		use: [{ skill: "standIdle", f0: 0, args: { at: [0, -1.6], heading: 0 } }, { skill: "walkTo", f0: 6, args: { to: [0, 0], period: 12, step: 0.6, ...walk } }],
		objects: { cube: { prop: "bagGrip", ...obj, spring: { length: 0.5, damping: 0.5 } } } });
	const { out, observations } = compileSpec(bag({ at: [0.04, 0, 0], along: [1, 0, 0] }, { armSwing: 0 }), { sk: xsk, scene });
	const sw = out.frames.map((_, f) => turnDeg(rootPoseAt(out, "cube", f).R, basePoseAt(out, "cube", f).R));
	const hips = out.frames.map(fr => fr.s.P[xsk.index.Hips]), speed = hips.map((p, f) => (f ? Math.hypot(p[0] - hips[f - 1][0], p[2] - hips[f - 1][2]) * FPS : 0));
	const start = speed.findIndex(v => v > 0.5), stop = speed.findLastIndex(v => v > 0.5), walking = Math.max(...sw.slice(start, stop + 1)), after = sw.slice(stop + 1);
	const peak = Math.max(...after), settle = (after.findLastIndex(v => v >= 5) + 1) / FPS;
	console.log(`  V2 bag: walking f${start}..f${stop} max ${walking.toFixed(2)} deg, peak after the stop ${peak.toFixed(2)} deg, under 5 deg after ${settle.toFixed(2)} s`);
	expect("(c) V2: under 15 deg while walking, 15..30 deg after the stop, settled under 5 deg within 1.2 s", walking < 15 && peak >= 15 && peak <= 30 && settle < 1.2, `${walking} ${peak} ${settle}`);
	expect("V2: a base at the hand is no SPRING_PIVOT", !observations.spring, JSON.stringify(observations.spring));
	const far = compileSpec(bag({ at: [0.3, 0, 0], along: [-1, 0, 0] }, {}), { sk: xsk, scene }).observations.spring ?? [];
	console.log(`  far end: ${far.join("; ")}`);
	expect("a base 0.30 m from the hand is a SPRING_PIVOT observation", far.length === 1 && /^SPRING_PIVOT cube: base is 0\.30 m from the hand; the swing pivots there, so put the base at the hand with at\/along$/.test(far[0]), far.join());
}

// validation: the stable range, unknown fields, hinges
{
	const kit = buildKit("ball", [], { position: { x: 0.5, y: 1.0, z: 0.5 } }), id = kit.rootId, scene = motionScene(kit.records);
	const refused = objects => { try { validateSpec(spec(24, objects), { sk, scene }); return ""; } catch (error) { return error.message; } };
	const keys = [{ f: 0, pos: [0.5, 1, 0.5], rot: [0, 0, 0, 1] }];
	const stiff = refused({ [id]: { keys, spring: { stiffness: 5000 } } });
	expect("(e) stiffness 5000 is refused with its range", /spring\.stiffness must be 0\.\.500/.test(stiff), stiff);
	expect("damping 1.5 is refused", /spring\.damping must be 0\.\.1/.test(refused({ [id]: { keys, spring: { damping: 1.5 } } })));
	expect("length 3 is refused with its range (0.05..2 m)", /spring\.length must be 0\.05\.\.2/.test(refused({ [id]: { keys, spring: { length: 3 } } })));
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
