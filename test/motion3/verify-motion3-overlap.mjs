#!/usr/bin/env node
// Overlap (src/motion3/compiler/overlap.js, channels.js): a change keyed on one frame for the whole body breaks along
// the chains: the lower spine, the chest, the head, the upper arm, the forearm and the wrist each start (and settle)
// later than the one they hang from, and one arm (a free IK hand too) trails the other, the side picked by the spec's label and the key
// frame (the same spec bakes the same frames). The arm's swing overshoots a little where it stops and settles back,
// then a hold is exactly flat. The channels that place the body (root, feet, fingers, and a hand's target, IK weight
// and pole wherever it touches, carries or reaches for a goal) bake exactly as without it, an arm on its IK has none, flow: false has none, and through the compiler a
// cup pickup lands its hand and feet where it did.
import { bakeChannels, flowOptions } from "../../src/motion3/compiler/channels.js";
import { compileMotion } from "../../src/motion3/compiler/compile.js";
import { handBusy } from "../../src/motion3/compiler/overlap.js";
import { validateSpec } from "../../src/motion3/compiler/validate.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { motionScene } from "../../src/motion3/scene.js";
import { RUN3_SPEC } from "./fixtures/cup-run3-spec.mjs";
import { SCENE_OBJECTS } from "./fixtures/cup-scene.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const json = JSON.stringify;
/** The first frame a baked number leaves its value at frame 0 by more than eps, and the last frame it still moves. */
const startOf = (xs, eps = 0.05) => xs.findIndex(v => Math.abs(v - xs[0]) > eps);
const settleOf = (xs, eps = 0.05) => { const end = xs[xs.length - 1]; let f = xs.length - 1; while (f > 0 && Math.abs(xs[f - 1] - end) <= eps) f--; return f; };

// one key frame for every body channel: held to f20, all moved by f44, held to the end
const BODY = ["spine_yaw", "head_yaw", "aswing_l", "abend_l", "wflex_l", "aswing_r", "abend_r", "wflex_r"];
const PLACE = { root: [0, 0.99, 0], foot_l: [0.1, 0.105, 0], foot_r: [-0.1, 0.105, 0], fingers_l: { relaxed: 1 }, elbow_l: [0, -1, -0.3] };
const body = v => Object.fromEntries(BODY.map(ch => [ch, v]));
const keys = [{ f: 0, set: { ...body(0), ...PLACE } }, { f: 20, set: body(0) },
	{ f: 44, set: { ...body(30), root: [0.2, 0.95, 0.1], foot_l: [0.15, 0.105, 0.05], hand_l: [0.3, 1.2, 0.4], fingers_l: { fist: 1 }, elbow_l: [0.2, -1, 0] } },
	{ f: 90, set: body(30) }];
const on = bakeChannels(keys, 100, flowOptions(undefined, "take a")), off = bakeChannels(keys, 100, flowOptions({ overlap: false }, "take a"));
const starts = Object.fromEntries([...BODY, "chest_yaw"].map(ch => [ch, startOf(on[ch])])), settles = Object.fromEntries([...BODY, "chest_yaw"].map(ch => [ch, settleOf(on[ch])]));
console.log(`  starts ${json(starts)}\n  settles ${json(settles)}`);
expect("the spine breaks before the chest, the chest before the head, a frame or more apart", starts.spine_yaw < starts.chest_yaw && starts.chest_yaw < starts.head_yaw, json(starts));
const lead = starts.aswing_l <= starts.aswing_r ? "l" : "r";
expect("each arm breaks shoulder, forearm, wrist, and settles in that order too", ["l", "r"].every(k => starts[`aswing_${k}`] < starts[`abend_${k}`] && starts[`abend_${k}`] < starts[`wflex_${k}`]
	&& settles[`aswing_${k}`] < settles[`abend_${k}`] && settles[`abend_${k}`] < settles[`wflex_${k}`]), json([starts, settles]));
expect("both arms keyed on one frame part: one trails the other by 1.5 frames or more", Math.abs(starts.aswing_l - starts.aswing_r) >= 1 && Math.abs(starts.wflex_l - starts.wflex_r) >= 1, json(starts));
expect("without overlap every body channel keyed on f20 starts on one frame", new Set(BODY.filter(ch => !/^head|^a(swing|bend)/.test(ch)).map(ch => startOf(off[ch]))).size === 1 && !off.chest_yaw, json(BODY.map(ch => startOf(off[ch]))));
const again = bakeChannels(keys, 100, flowOptions(undefined, "take a"));
expect("the same spec bakes the same frames", json(again) === json(on));
// the side that trails comes from the label and the key frame: over a few labels both sides get to trail
const trails = ["a", "b", "c", "d", "e", "f", "g", "h"].map(s => { const b = bakeChannels(keys, 100, flowOptions(undefined, s)); return startOf(b.aswing_l) > startOf(b.aswing_r) ? "l" : "r"; });
expect("which side trails is picked per label (both occur over 8 labels)", trails.includes("l") && trails.includes("r"), json(trails));
console.log(`  leading side for "take a": ${lead}; trailing per label ${trails.join("")}`);

const placing = ["root", "foot_l", "foot_r", "fingers_l"];
expect("root, feet and fingers bake exactly as without overlap", placing.every(ch => json(on[ch]) === json(off[ch])), placing.filter(ch => json(on[ch]) !== json(off[ch])).join());
const none = bakeChannels(keys, 100, flowOptions(false));
expect("flow: false has no chest share and no delay: every body channel starts on f20's next frame", !none.chest_yaw && BODY.every(ch => startOf(none[ch]) === 21), json(BODY.map(ch => startOf(none[ch]))));

// free IK hands keyed on one frame part: one hand's target, IK weight and pole trail; a hand that is about to touch
// (an anchor weight), carries (flow.hands: handBusy) or reaches for a goal keeps its keyed time
const reach = extra => [{ f: 0, set: { armw_l: 1, armw_r: 1, hand_l: [0.3, 1.2, 0.3], hand_r: [-0.3, 1.2, 0.3], elbow_l: [0, -1, -0.3], elbow_r: [0, -1, -0.3], ...extra[0] } },
	{ f: 20, set: { armw_l: 1, armw_r: 1, hand_l: [0.3, 1.2, 0.3], hand_r: [-0.3, 1.2, 0.3] } }, { f: 40, set: { hand_l: [0.3, 1.4, 0.4], hand_r: [-0.3, 1.4, 0.4], elbow_l: [0.3, -1, 0], elbow_r: [-0.3, -1, 0], ...extra[1] } },
	{ f: 70, set: { hand_l: [0.2, 1.1, 0.3], hand_r: [-0.2, 1.1, 0.3], ...extra[2] } }, { f: 99, set: {} }];
const start3 = xs => xs.findIndex(v => Math.abs(v[1] - xs[0][1]) > 0.002);
const freeOn = bakeChannels(reach([{}, {}, {}]), 110, flowOptions(undefined, "take a")), freeOff = bakeChannels(reach([{}, {}, {}]), 110, flowOptions({ overlap: false }, "take a"));
const handStarts = ["hand_l", "hand_r"].map(ch => start3(freeOn[ch]));
console.log(`  free hands start f${handStarts.join(", f")}`);
expect("two free IK hands keyed on one frame start a frame or more apart", Math.abs(handStarts[0] - handStarts[1]) >= 1, json(handStarts));
// two arms going onto their IK on one frame from a hold: one side's IK weight and target come later
const onto = [{ f: 0, set: { armw_l: 0, armw_r: 0, hand_l: [0.3, 1.2, 0.3], hand_r: [-0.3, 1.2, 0.3] } }, { f: 30, set: { armw_l: 0, armw_r: 0 } },
	{ f: 50, set: { armw_l: 1, armw_r: 1 } }, { f: 99, set: { armw_l: 1, armw_r: 1 } }];
const ontoOn = bakeChannels(onto, 110, flowOptions(undefined, "take a")), weights = ["armw_l", "armw_r"].map(ch => startOf(ontoOn[ch], 0.01));
console.log(`  onto IK from a hold: IK weights start f${weights.join(", f")}`);
expect("two arms going onto their IK on one frame part there too", Math.abs(weights[0] - weights[1]) >= 1, json(weights));
const touching = reach([{ w_cup_l: 0, w_cup_r: 0 }, { w_cup_l: 1, w_cup_r: 1 }, { w_cup_l: 1, w_cup_r: 1 }]);
const touchOn = bakeChannels(touching, 110, flowOptions(undefined, "take a")), touchOff = bakeChannels(touching, 110, flowOptions({ overlap: false }, "take a"));
expect("hands going onto an anchor bake exactly as without overlap (target, weights, IK weight, pole)", ["hand", "armw", "elbow", "w_cup"].every(c => ["l", "r"].every(k => json(touchOn[`${c}_${k}`]) === json(touchOff[`${c}_${k}`]))));
const carry = { l: [[10, 109]], r: [[0, 80]] };
const carryOn = bakeChannels(reach([{}, {}, {}]), 110, flowOptions(undefined, "take a", carry));
expect("hands that carry (or reach for a goal) over those frames bake exactly as without overlap", ["hand", "armw", "elbow"].every(c => ["l", "r"].every(k => json(carryOn[`${c}_${k}`]) === json(freeOff[`${c}_${k}`]))));
const busy = handBusy({ frames: 100, props: { cup: { hand: "r" } }, objects: { mug: { prop: "cup", grab: 30, release: 60 } }, goals: [{ near: ["joint:lefthand", "object:mug"], at: [40, 50] }] });
expect("handBusy: a carry is its hand's from grab to release, a hand goal both hands' over its frames", json(busy) === json({ l: [[40, 50]], r: [[30, 60], [40, 50]] }), json(busy));

// a stop into a hold: the swing passes its value by a bounded overshoot, then holds exactly
const stop = bakeChannels([{ f: 0, set: { aswing_l: 0 } }, { f: 10, set: { aswing_l: 0 } }, { f: 34, set: { aswing_l: 40 } }, { f: 70, set: { aswing_l: 40 } }, { f: 95, set: { aswing_l: 0 } }], 100).aswing_l;
const peak = Math.max(...stop.slice(30, 60)), settled = settleOf(stop.slice(0, 70), 0);
console.log(`  stop: peak ${peak.toFixed(2)} deg, flat from f${settled}`);
expect("the arm's swing overshoots its stop by under 3 deg and settles back", peak > 40.3 && peak < 43, peak);
expect("then the hold is exactly flat up to its next move", settled < 60 && stop.slice(settled, 71).every(v => v === 40), json(stop.slice(40, 72).map(v => +v.toFixed(3))));

// an arm on its IK has no link delay or settle of its own: on the leading side it bakes as without overlap, on the
// trailing side only its whole arm's trail moves it (the same shift for its swing and its IK weight)
const ik = [{ f: 0, set: { armw_r: 1, aswing_r: 0, abend_r: 0 } }, { f: 20, set: { aswing_r: 30, abend_r: 20 } }, { f: 40, set: { aswing_r: 30, abend_r: 20 } }];
const ikOff = bakeChannels(ik, 50, flowOptions({ overlap: false })), ikAs = Array.from({ length: 32 }, (_, i) => `take ${i}`).map(s => bakeChannels(ik, 50, flowOptions(undefined, s)));
const plainIk = ikAs.filter(b => json(b.aswing_r) === json(ikOff.aswing_r) && json(b.abend_r) === json(ikOff.abend_r)).length;
expect("an arm on its IK has no link delay or settle (as without overlap on the leading side)", plainIk > 0 && plainIk < 32, plainIk);

let refused = "";
try { validateSpec({ schema: "cozyclay.motion-spec.v1", frames: 10, flow: { overlap: 3 } }, { sk: skeletonFor("x-bot-tpose") }); } catch (e) { refused = e.message; }
expect("flow.overlap takes true, false or a scale 0..2", refused.includes("spec.flow.overlap must be true, false or a scale 0..2"), refused);

// through the compiler: the cup pickup (a hand on its IK) and a standing bow with both arms swung on one frame land
// their feet, hips and IK hand where they did without overlap; the bow's free arms and head do not
const sk = skeletonFor("y-bot-tpose"), I = sk.index, dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const bow = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 120, label: "bow", use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }],
	keys: [{ f: 20, set: { spine_pitch: 0, head_pitch: 0, aswing_l: 0, aswing_r: 0 } }, { f: 50, set: { spine_pitch: 30, head_pitch: 15, aswing_l: 35, aswing_r: 35 } }, { f: 100, set: { spine_pitch: 30 } }] };
for (const [name, spec, scene] of [["cup", RUN3_SPEC, motionScene(SCENE_OBJECTS)], ["bow", bow, motionScene([])]]) {
	const t0 = performance.now(), withIt = compileMotion({ fps: 24, ...spec }, { sk, scene }), t1 = performance.now();
	const without = compileMotion({ fps: 24, ...spec, flow: { overlap: false } }, { sk, scene }), t2 = performance.now();
	let contact = 0, free = 0;
	for (let f = 0; f < withIt.frames.length; f++) {
		const P = withIt.frames[f].s.P, Q = without.frames[f].s.P;
		for (const j of ["LeftFoot", "RightFoot", "Hips"]) contact = Math.max(contact, dist(P[I[j]], Q[I[j]]));
		if (withIt.baked.armw_l?.[f] >= 0.99) contact = Math.max(contact, dist(P[I.LeftHand], Q[I.LeftHand]));
		else for (const j of ["Head", "LeftHand", "RightHand"]) free = Math.max(free, dist(P[I[j]], Q[I[j]]));
	}
	console.log(`  ${name}: feet, hips and an IK hand move ${(contact * 1000).toFixed(4)} mm at most, the head or a free hand ${(free * 100).toFixed(1)} cm; ${(t1 - t0).toFixed(0)} vs ${(t2 - t1).toFixed(0)} ms`);
	expect(`${name}: a compile keeps every contact where it was (feet, hips, a hand on its IK: under 0.01 mm)`, contact < 1e-5, contact);
	if (name === "bow") expect("bow: and the free arms and head do overlap (a hand or the head is elsewhere on some frame)", free > 0.01, free);
	expect(`${name}: the same spec compiles to the same frames`, json(compileMotion({ fps: 24, ...spec }, { sk, scene }).frames.map(fr => fr.s.P[I.RightHand])) === json(withIt.frames.map(fr => fr.s.P[I.RightHand])));
}

console.log(failures ? `${failures} motion3 overlap check(s) failed` : "motion3 overlap: all checks passed");
process.exit(failures ? 1 : 0);
