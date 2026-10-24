#!/usr/bin/env node
// Lane B (C4): output.timeline. The car-exit scene built from skills gives one beat per skill
// with the frames expandUse reports, the end pose at each beat's last frame, the planted foot
// spans (the walk's run to its end) and the cigarette/lighter show/hide events; a walk
// generator and loose keys are beats of their own; grab/release come from inHandAt; at most 12. Then
// observations.asked and output.brief on a walk to a cup.
import { SCENE_OBJECTS } from "./fixtures/exitcar-scene.mjs";
import { SCENE_OBJECTS as CUP_OBJECTS } from "./fixtures/cup-scene.mjs";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { dist } from "../../src/motion3/compiler/math.js";
import { refPoint } from "../../src/motion3/refs.js";
import { fitOutput, briefOf, MOTION_OUTPUT_BUDGET } from "../../src/motion3/report.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const json = v => JSON.stringify(v);

// 1. The car exit from four skills.
const sk = skeletonFor("x-bot-tpose"), I = sk.index;
const spec = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 730, use: [
	{ skill: "sitInSeat", f0: 0, args: { car: "Car", offset: [-0.06, 0.17, 0.023] } },
	{ skill: "exitCar", f0: 0, args: { car: "Car", side: "l" } },
	{ skill: "walkTo", f0: 246, args: { heading: [125, 150], steps: 8, step: 0.5, halfWidth: 0.1, lift: 0.08, turnDistance: 0.4, firstStep: 0.4 } },
	{ skill: "smokeCigarette", f0: 440 }] };
const r = compileSpec(spec, { sk, scene: motionScene(SCENE_OBJECTS) }), tl = r.timeline;
console.log(`  timeline: ${tl.length} beats, ${json(tl).length} bytes`);
expect("one beat per skill, in use order", json(tl.map(b => [b.beat, b.src])) === json(r.used.map((u, i) => [u.skill, `use[${i}]`])), json(tl.map(b => b.src)));
expect("each beat's f is [f0, end] of used", tl.every((b, i) => b.f[0] === r.used[i].f0 && b.f[1] === r.used[i].end), json(tl.map(b => b.f)));
const rootErr = Math.max(...tl.map(b => dist(b.end.root, r.out.frames[b.f[1]].s.P[I.Hips])));
expect("end.root is the Hips joint at f[1] within 1 mm", rootErr <= 0.001, rootErr);
const handErr = Math.max(...tl.flatMap(b => [dist(b.end.hand_l, r.out.frames[b.f[1]].s.P[I.LeftHand]), dist(b.end.hand_r, r.out.frames[b.f[1]].s.P[I.RightHand])]));
expect("end.hand_l / hand_r are the wrists within 1 mm", handErr <= 0.001, handErr);
expect("end.yaw is the yaw channel (1 decimal)", tl.every(b => Math.abs(b.end.yaw - (r.out.frames[b.f[1]].c.yaw ?? 0)) <= 0.05), json(tl.map(b => b.end.yaw)));
const walk = tl.find(b => b.beat === "walkTo");
expect("walkTo's planted spans run to the end of the walk", ["l", "r"].every(k => walk.planted[k].at(-1)?.[1] === walk.f[1]), json(walk.planted));
expect("at most 4 planted spans per foot, each 3+ frames inside the beat", tl.every(b => ["l", "r"].every(k => b.planted[k].length <= 4
	&& b.planted[k].every(([a, z]) => z - a >= 2 && a >= b.f[0] && z <= b.f[1]))), json(tl.map(b => b.planted)));
const planted = walk.planted.l[0], sole = f => r.out.frames[f].s.P[I.LeftToeBase][1];
expect("a planted span really has the foot down", sole(planted[0]) < 0.03 && sole(planted[1]) < 0.03, [sole(planted[0]), sole(planted[1])]);
const smoke = tl.find(b => b.beat === "smokeCigarette"), ev = smoke.events.map(e => `${e.f} ${e.object} ${e.event}`);
expect("the cigarette and lighter show/hide events appear", ["468 cig_vis show", "475 lit_vis show", "542 lit_vis hide"].every(e => ev.includes(e)), json(ev));
expect("events stay inside their beat, ascending", tl.every(b => b.events.every((e, i) => e.f >= b.f[0] && e.f <= b.f[1] && (i === 0 || e.f >= b.events[i - 1].f))));
expect("the right hand ends on the hold anchor while smoking", smoke.end.on_r === "anchor:hold" && smoke.end.on_l === null, json(smoke.end));

// 2. A walk generator and loose keys.
const P = sk.restWorldPos, ank = P[I.LeftFoot][1];
const stand = { root: [0, P[I.Hips][1] - 0.01, 0], yaw: 0, foot_l: [0.09, ank, -0.03], foot_r: [-0.09, ank, 0.03], fyaw_l: 0, fyaw_r: 0 };
const g = compileSpec({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 220, keys: [{ f: 0, set: stand }, { f: 180, set: { head_yaw: 20 } }, { f: 200, set: { head_yaw: 0 } }],
	generators: [{ type: "walk", f0: 8, steps: 4, heading: [0, 0] }] }, { sk, scene: { objects: {} } });
expect("keys and a walk generator are beats", json(g.timeline.map(b => [b.beat, b.src, b.f])) === json([["keys", "keys", [0, 0]], ["walk", "generators[0]", [8, 122]], ["keys", "keys", [180, 200]]]), json(g.timeline.map(b => [b.beat, b.src, b.f])));
expect("the walk ends planted on both feet", ["l", "r"].every(k => g.timeline[1].planted[k].at(-1)?.[1] === 122), json(g.timeline[1].planted));

// 3. At most 12 beats.
const many = compileSpec({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 200, use: Array.from({ length: 14 }, (_, i) => ({ skill: "standIdle", f0: i * 10, args: { at: [0, 0], until: i * 10 + 5 } })) },
	{ sk, scene: { objects: {} } });
expect("at most 12 beats, ordered by f[0]", many.timeline.length === 12 && many.timeline.every((b, i) => i === 0 || b.f[0] >= many.timeline[i - 1].f[0]), many.timeline.length);

// 4. grab/release (object-pose.js inHandAt) and on_l = the held object.
const ysk = skeletonFor("y-bot-tpose"), YI = ysk.index, YP = ysk.restWorldPos, yank = YP[YI.LeftFoot][1];
const cup = compileSpec({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 60, keys: [
	{ f: 0, set: { root: [0, YP[YI.Hips][1] - 0.01, 0], yaw: 0, foot_l: [0.09, yank, -0.03], foot_r: [-0.09, yank, 0.03], fyaw_l: 0, fyaw_r: 0 } }, { f: 59, set: { head_yaw: 0 } }],
	props: { grip: { hand: "l", origin: ["LeftHandIndex2", "LeftHandMiddle2"], points: {} } }, objects: { cylinder: { prop: "grip", grab: 20, release: 40 } } },
{ sk: ysk, scene: motionScene(CUP_OBJECTS) }, { checks: {} });
const kb = cup.timeline[0], cev = kb.events.map(e => `${e.f} ${e.object} ${e.event}`);
expect("grab and release are events at their frames", json(cev) === json(["20 cylinder grab", "40 cylinder release"]), json(cev));
const mid = compileSpec({ ...cup.spec, keys: [cup.spec.keys[0], { f: 30, set: { head_yaw: 0 } }], frames: 60 }, { sk: ysk, scene: motionScene(CUP_OBJECTS) }, { checks: {} });
expect("a hand holding an object at f[1] is on that object", mid.timeline[0].end.on_l === "object:cylinder" && mid.timeline[0].end.on_r === null, json(mid.timeline[0].end));
expect("no hand is on anything after release", kb.end.on_l === null, json(kb.end));

// 5. observations.asked (qa/asked.js) and output.brief (report.js): per skill where the feet end against its args, per
// contact its frames and gap, per goal its points; the brief's fixed lines; both inside the answer budget.
const cupScene = motionScene(CUP_OBJECTS), point = (f, ref) => refPoint(walkCup.out, f, ref);
const walkCup = compileSpec({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 160,
	use: [{ skill: "standIdle", args: { at: [0.15, -0.6], heading: 0 }, f0: 0 }, { skill: "walkTo", args: { to: [0.15, 0.3], steps: 3 }, f0: 4 },
		{ skill: "reachGrip", args: { anchor: "cup", side: "l", define: { kind: "object", object: "cube-6", local: [0, 0.03, 0] } }, f0: 100 }],
	objects: { "empty-2": { prop: "cupGrip", grab: 120, release: 140 } },
	checks: { contacts: [{ name: "never touched", point: "joint:RightHand", target: "anchor:cup", when: "w_cup_r" }] },
	goals: [{ name: "cup lifted", moved: "object:empty-2", by: 0.05, at: [125, 135] }, { name: "fingers at cup top", near: ["joint:LeftHandIndex3", "object:empty-2.top"], tol: 0.05, at: [115, 125] }] },
{ sk: ysk, scene: cupScene });
const asked = walkCup.observations.asked ?? [], line = re => asked.find(l => re.test(l)) ?? "", nums = l => (l.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
console.log(`  asked: ${json(asked)}`);
const walkLine = line(/^use\[1\] walkTo/), [, wa, wb] = /f(\d+)-(\d+)/.exec(walkLine) ?? [], wend = walkCup.out.frames[+wb]?.s.P;
const feet = wend ? [(wend[YI.LeftFoot][0] + wend[YI.RightFoot][0]) / 2, (wend[YI.LeftFoot][2] + wend[YI.RightFoot][2]) / 2] : [NaN, NaN];
const at = nums(/at \[([^\]]+)\]/.exec(walkLine)?.[1] ?? "");
expect("a skill line names its frames (used f0..end) and where the feet end (1 mm)", +wa === walkCup.used[1].f0 && +wb === walkCup.used[1].end
	&& Math.hypot(at[0] - feet[0], at[1] - feet[1]) <= 0.001, walkLine);
expect("a walkTo whose steps are given says how far it lands from to and why", /; to \[0\.15, 0\.3\]: [\d.]+ m (short|past), args\.steps set the distance/.test(walkLine), walkLine);
expect("the yaw is the heading channel at the skill's end", nums(/yaw (-?\d+)/.exec(walkLine)?.[1] ?? "")[0] === Math.round(walkCup.out.frames[+wb].c.yaw ?? 0), walkLine);
const on = walkCup.out.frames.map((fr, f) => ((fr.c.w_cup_l ?? 0) > 0.99 ? f : null)).filter(f => f !== null), grip = line(/^fingers on cup f/);
expect("a contact line spans the frames its when holds, with its closest and farthest gap", grip.startsWith(`fingers on cup f${on[0]}-${on.at(-1)}: gap `) && /cm f\d+ \.\. [\d.]+ cm f\d+ \(tol 4\)$/.test(grip), `${grip} ${on[0]}-${on.at(-1)}`);
expect("a contact that never holds says so", line(/^never touched/) === "never touched: never on (w_cup_r never > 0.99)", json(asked));
const top = line(/^goal fingers at cup top/), res = walkCup.qa.goals.find(g => g.name === "fingers at cup top"), pts = [...top.matchAll(/\[([^\]]+)\]/g)].map(m => nums(m[1]));
expect("a goal line gives its points on the answered frame and what an object point is", top.startsWith(`goal fingers at cup top f${res.at}: joint:LeftHandIndex3 [`) && top.includes("object:empty-2.top (box top) [")
	&& pts.length === 2 && dist(pts[0], point(res.at, "joint:LeftHandIndex3")) <= 0.001 && dist(pts[1], point(res.at, "object:empty-2.top")) <= 0.001, top);
const best = nums(/; best ([\d.]+) f(\d+)/.exec(top)?.slice(1).join(" ") ?? "");
expect("a near goal held on every frame names its closest frame", best.length === 2 && best[0] <= res.value && best[1] >= 115 && best[1] <= 125, top);
expect("a moved goal names the object's base", /^goal cup lifted f\d+: object:empty-2\.base \(box base\) \[/.test(line(/^goal cup lifted/)), json(asked));
const full = { frames: walkCup.out.frameCount, fps: 24, installed: false, specId: "spec-000000000000", qa: walkCup.qa, observations: walkCup.observations, timeline: walkCup.timeline, fixed: walkCup.fixed, skills: walkCup.used, ms: walkCup.ms };
const fitted = fitOutput(full), brief = fitted.brief ?? [];
console.log(`  brief: ${json(brief)}; answer ${json(fitted).length} B`);
expect("the brief is first: the qa line, the goals line with each miss, then groups past GOAL", Object.keys(fitted)[0] === "brief"
	&& brief[0] === `spec-000000000000 qa ${walkCup.qa.problems} problems (${walkCup.qa.total} issues), not installed`
	&& /^goals 0\/2; MISS cup lifted [\d.]+ f\d+ \(>= 0\.05\); MISS fingers at cup top [\d.]+ f\d+ \(<= 0\.05\)$/.test(brief[1])
	&& brief.length === 4 && brief.slice(2).every(l => /^[A-Z]+ .+ x\d+ f\d+-\d+$/.test(l) && !l.startsWith("GOAL")), json(brief));
expect("brief and asked stay inside the answer budget", json(fitted).length <= MOTION_OUTPUT_BUDGET && json(fitted.observations.asked) === json(asked), json(fitted).length);
const heavy = { ...full, delta: { base: "spec-000000000001" }, qa: { ...walkCup.qa, groups: walkCup.qa.groups.map(g => ({ ...g, hint: `${g.hint ?? ""} ${"x".repeat(700)}` })) } };
const tight = fitOutput(heavy), kept = tight.observations.asked ?? [];
expect("a base + patch answer that does not fit names the units by reference, cuts asked goal lines before full groups and fits",
	tight.observations.units === "as in the base's answer" && json(tight).length <= MOTION_OUTPUT_BUDGET && kept.every((l, i) => l === asked[i])
	&& kept.filter(l => l.startsWith("use[")).length === 3 && (kept.length < asked.length || tight.qa.groups.slice(0, 4).every(g => "hint" in g)), `${json(tight).length} B ${json(kept)}`);
expect("a clean answer's brief is one line", json(briefOf({ specId: "spec-1", installed: true, qa: { ok: true, total: 0, problems: 0, groups: [] } })) === json(["spec-1 qa ok, installed"]));

if (failures) { console.error(`${failures} motion3 timeline check(s) failed`); process.exit(1); }
console.log("motion3 timeline: all checks passed");
