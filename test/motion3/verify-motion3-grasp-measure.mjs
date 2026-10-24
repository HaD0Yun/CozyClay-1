#!/usr/bin/env node
// Lane anchor (grasp round 2): a grasp anchor's IK target, QA REACH, the reachGrip contact and a goal's near all read
// one measure. Session 7f15b4ae ("make a cup and grab it"): the spec below, a power grasp on a 4 cm cup, read REACH
// 0.845 m and CONTACT 13.3 cm while its goal measured 6 cm; from a stance in reach the goal passed (0.000 m) and QA
// still read REACH 0.371 m and CONTACT 6.4 cm. Causes: the fit's passes wound the wrist target past an arm at full
// reach (compile.js solveFrame), the grasp asked the fingers 2 cm into a body thicker than that (anchors.js
// anchorSocket), and the contact measured one point where the grasp turns the fingers round the part (spec-checks.js).
import assert from "node:assert/strict";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";

const check = (name, fn) => { fn(); console.log(`ok - ${name}`); };
const rec = ([id, name, renderer, x, y, z, sx, sy, sz]) => ({ id, name, renderer, x, y, z, rot: 0, rotX: 0, rotZ: 0, scaleX: sx, scaleY: sy, scaleZ: sz, footprint: { width: 1, depth: 1 }, height: 1 });
// the session's table and cup after its second arrange_objects call
const scene = motionScene([["cube", "Table", "cube", -0.1, 0, 0.62, 0.7, 0.75, 0.5], ["cylinder", "Cup", "cylinder", -0.2, 0.75, 0.43, 0.08, 0.1, 0.08]].map(rec));
const spec = at => ({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: "auto", label: "grab cup", anchors: { cup: { kind: "object", object: "cylinder", grasp: "power" } },
	use: [{ skill: "standIdle", args: { at, heading: 0 }, f0: 0 }, { skill: "reachGrip", args: { anchor: "cup", side: "r", reach: 22, hold: 30, release: 14 }, f0: 10 }],
	goals: [{ name: "fingers on cup", near: ["joint:RightHandMiddle2", "object:cylinder"], tol: 0.03, at: [34, 58] }] });
const sk = skeletonFor("y-bot-tpose"), worst = (r, kind) => r.qa.groups.find(g => g.kind === kind)?.worst ?? 0;
// the session's stance ([0, 0]) is now reached by a lean (fix.reach, fix/reach-body.js); 40 cm further back is past it
const session = compileSpec(spec([0, 0]), { sk, scene }), far = compileSpec(spec([0, -0.4]), { sk, scene }), near = compileSpec(spec([-0.04, 0.12]), { sk, scene });

check("the session's stance: the compiler leans the body to the cup and the goal holds (fixed.reachBody)", () => {
	assert.ok(session.qa.goals[0].ok && session.fixed.reachBody?.runs?.[0]?.side === "r", JSON.stringify({ goal: session.qa.goals[0], fixed: session.fixed.reachBody }));
});

check("out of reach, REACH and the contact say what the goal measures (40 cm behind the session's stance)", () => {
	const goal = far.qa.goals[0].value, reach = worst(far, "REACH"), contact = worst(far, "CONTACT");
	assert.ok(!far.qa.goals[0].ok && goal > 0.03, `goal ${goal}`);
	assert.ok(reach > 0 && Math.abs(reach - goal) < 0.05, `REACH ${reach} vs goal ${goal}`);
	assert.ok(Math.abs(contact - goal) < 0.03, `CONTACT ${contact} vs goal ${goal}`);
});
check("in reach, a passing goal leaves no REACH and no contact problem", () => {
	assert.ok(near.qa.goals[0].ok, JSON.stringify(near.qa.goals[0]));
	assert.deepEqual(near.qa.groups.filter(g => /^(REACH|CONTACT)$/.test(g.kind)).map(g => `${g.kind}:${g.subject}`), []);
});
// the miss itself, not a bound: overlap (compiler/overlap.js) times the arm a little differently, so the far stance misses by
// 0.136-0.148 m depending on it; a wound-up target read 0.37-0.85 m
check("the hint's distance is the miss, not a wound-up target", () => {
	const g = far.qa.groups.find(x => x.kind === "REACH"), m = /out of reach by ([\d.]+) m/.exec(g.hint ?? "");
	assert.ok(m && Math.abs(+m[1] - far.qa.goals[0].value) < 0.03, `${g.hint} (goal ${far.qa.goals[0].value})`);
});
