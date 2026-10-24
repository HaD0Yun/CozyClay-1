#!/usr/bin/env node
// Goals (C8, lane G): near / above / moved pass and fail, all and any, a single-frame at, GOAL
// groups first with qa.ok false, issue frames against a windowed out, the GOAL hint and its
// hand fix, the exact validation messages, and a { range } search that converges onto a goal.
import { SCENE_OBJECTS, CHARACTER, CUP } from "./fixtures/cup-scene.mjs";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { refPoint, refDistance } from "../../src/motion3/refs.js";
import { goalChecks } from "../../src/motion3/qa/goals.js";
import { goalHints } from "../../src/motion3/qa/hints-goal.js";
import { add, len, sub } from "../../src/motion3/compiler/math.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const refusal = run => { try { run(); return ""; } catch (error) { return error.message; } };
const close = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;

// A Y Bot at the origin facing +Z, the table 0.85..1.15 m ahead. The left hand (IK, hand_l is the
// world wrist target) rises from 0.95 m to 1.2 m over 48 frames. The cup body tips over its +x
// base edge on a hinge (channel "tip", 0 -> -90 degrees over f24..f47), and spec.anchors.spot is
// 0.1 m ahead of the hand's f47 target.
const sk = skeletonFor(CHARACTER.model), scene = motionScene(SCENE_OBJECTS);
const HAND0 = [0.2, 0.95, 0.25], HAND1 = [0.2, 1.2, 0.3];
const base = (extra = {}) => ({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 48,
	use: [{ skill: "standIdle", args: { at: [0, 0], heading: 0 }, f0: 0 }],
	keys: [{ f: 0, set: { armw_l: 1, hand_l: HAND0, tip: 0 } }, { f: 24, set: { tip: 0 } }, { f: 47, set: { hand_l: HAND1, tip: -90 } }],
	objects: { cylinder: { pivot: [0.24, 0.75, 0.85], axis: [0, 0, 1], channel: "tip" } },
	props: { grip: { hand: "l", origin: ["LeftHandIndex2", "LeftHandMiddle2"], points: { tip: [0.02, 0, 0] } } },
	anchors: { spot: { kind: "world", p: [0.2, 1.2, 0.4] } }, ...extra });
const run = (goals, extra = {}) => compileSpec(base({ goals, ...extra }), { sk, scene });
const plain = run(undefined), out = plain.out;
expect("the base take is clean, and qa.goals is absent without spec.goals", plain.qa.ok && !("goals" in plain.qa), JSON.stringify(plain.qa.groups.map(g => g.subject)));

// 1. near: the left hand reaches spot at f47 (about 0.1 m short of it), not at f0
const dEnd = refDistance(out, 47, "joint:LeftHand", "anchor:spot"), d0 = refDistance(out, 0, "joint:LeftHand", "anchor:spot");
let r = run([{ name: "reach spot", near: ["joint:LeftHand", "anchor:spot"], tol: dEnd + 0.01, at: 47 }]);
let res = r.qa.goals?.[0];
expect("near passes at a single frame: value is the distance, at the frame, need the tol", r.qa.ok && res.ok && res.kind === "near" && close(res.value, dEnd) && res.at === 47 && res.need === dEnd + 0.01, JSON.stringify(res));
r = run([{ name: "reach spot", near: ["joint:LeftHand", "anchor:spot"], tol: dEnd + 0.01, at: 0 }]);
res = r.qa.goals[0];
let g = r.qa.groups[0];
expect("near fails at f0: qa.ok false, one GOAL group, worst = the shortfall, limit 0", !r.qa.ok && !res.ok && close(res.value, d0) && g.kind === "GOAL" && g.count === 1
	&& close(g.worst, d0 - dEnd - 0.01) && g.limit === 0 && g.worstFrame === 0, JSON.stringify(g));
expect("the GOAL subject reads name: value m at f (needs <= tol)", g.subject === `reach spot: ${Math.round(d0 * 1000) / 1000} m at f0 (needs <= ${dEnd + 0.01})`, g.subject);

// 2. above: the hand over the table top by 0.3 m holds at f47 (y 1.2 vs 0.75), not at f0
const height = f => refPoint(out, f, "joint:LeftHand")[1] - refPoint(out, f, "object:cube.top")[1];
r = run([{ name: "hand over table", above: ["joint:LeftHand", "object:cube.top"], by: 0.3, at: 47 }]);
expect("above passes at f47", r.qa.ok && r.qa.goals[0].ok && close(r.qa.goals[0].value, height(47)), JSON.stringify(r.qa.goals));
r = run([{ name: "hand over table", above: ["joint:LeftHand", "object:cube.top"], by: 0.3, at: 0 }]);
g = r.qa.groups[0];
expect("above fails at f0 with the shortfall by - (a.y - b.y)", !r.qa.ok && !r.qa.goals[0].ok && g.kind === "GOAL" && close(g.worst, 0.3 - height(0))
	&& g.subject === `hand over table: ${Math.round(height(0) * 1000) / 1000} m above at f0 (needs >= 0.3)`, JSON.stringify(g));
r = run([{ name: "default by 0", above: ["joint:LeftHand", "object:cube.top"], at: 0 }]);
expect("above without by needs a.y >= b.y", r.qa.ok && r.qa.goals[0].need === 0, JSON.stringify(r.qa.goals));

// 3. moved: the hinged cup body tips over from f24 on; the group of the cup handle stays put
const travel = f => len(sub(refPoint(out, f, "object:cylinder.base"), [0.2, 0.75, 0.85]));
r = run([{ name: "cup tipped", moved: "object:cylinder", by: 0.02, at: 47 }]);
expect("moved passes when the base left its scene pose by >= by", r.qa.ok && r.qa.goals[0].ok && close(r.qa.goals[0].value, travel(47)) && travel(47) > 0.02, JSON.stringify(r.qa.goals));
r = run([{ name: "cup tipped", moved: "object:cylinder", at: [10, 20] }]);
g = r.qa.groups[0];
expect("moved fails before the hinge turns (default by 0.05), one issue per failing frame", !r.qa.ok && r.qa.goals[0].need === 0.05 && r.qa.goals[0].value === 0 && g.count === 11 && g.first === 10 && g.last === 20
	&& g.subject.startsWith("cup tipped: moved 0 m at f") && close(g.worst, 0.05), JSON.stringify(g));
// qa.total counts those frame-level issues; qa.problems counts groups, what a person reads (src/qa-label.js)
expect("a goal missed on 11 frames is 11 frame issues but one problem", r.qa.total === 11 && r.qa.problems === 1 && r.qa.problems === r.qa.groups.length, JSON.stringify({ total: r.qa.total, problems: r.qa.problems }));
r = run([{ name: "handle moved", moved: `object:${CUP.group}`, at: 47 }]);
const groupTravel = len(sub(refPoint(out, 47, `object:${CUP.group}.base`), refPoint(out, 0, `object:${CUP.group}.base`)));
expect("a group (object:<group>) is measured as a whole: the cylinder tipping moves the base of its parts' AABB",
	groupTravel > 0.05 && r.qa.goals[0].ok && close(r.qa.goals[0].value, groupTravel), JSON.stringify({ groupTravel, goals: r.qa.goals }));

// 3b. landmarks: object .top is the top-face centre of the world bounding box; .rim is the opening (the top face of the
//     highest part in its own axes), so a tipped cup's rim leaves its .top. A near goal of a round body's .top and the
//     mouth measures the rim nearest the mouth, and a failing near goal on a .top says which point it read.
const rimAt = f => refPoint(out, f, "object:cylinder.rim"), topAt = f => refPoint(out, f, "object:cylinder.top");
expect("rim: upright, the opening is the .top", len(sub(rimAt(0), topAt(0))) < 1e-6 && close(rimAt(0)[1], 0.85), JSON.stringify([rimAt(0), topAt(0)]));
expect("rim: tipped 90 deg, the opening has left the bounding-box top (> 5 cm)", len(sub(rimAt(47), topAt(47))) > 0.05, JSON.stringify([rimAt(47), topAt(47)]));
const mouthD = refDistance(out, 47, `object:${CUP.group}.rim`, "landmark:mouth"), centreD = len(sub(refPoint(out, 47, `object:${CUP.group}.rim`), refPoint(out, 47, "landmark:mouth")));
expect("rim: against a point, the edge of the opening nearest it (closer than the opening's centre, by at most its radius)", mouthD < centreD && centreD - mouthD <= 0.04 + 1e-6, JSON.stringify({ mouthD, centreD }));
r = run([{ name: "cup at mouth", near: [`object:${CUP.group}.top`, "landmark:mouth"], tol: 0.01, at: 47 }]);
g = r.qa.groups.find(x => x.kind === "GOAL");
expect("a round body's .top at the mouth is measured at its rim, and the message says so", close(r.qa.goals[0].value, mouthD) && g.subject.endsWith(`(measured at ${CUP.group}'s rim nearest the mouth, object:${CUP.group}.rim; its .top is its bounding box's top)`), JSON.stringify({ goal: r.qa.goals[0], subject: g?.subject }));
r = run([{ name: "hand at the top", near: ["joint:LeftHand", "object:cube.top"], tol: 0.01, at: 47 }]);
expect("any other .top in a failing near goal says it is the bounding box's top-face centre", r.qa.groups[0].subject.endsWith("(object:cube.top is the top-face centre of its world bounding box; object:cube.rim is its opening, which tilts with it)"), r.qa.groups[0].subject);

// 4. all / any over a range: the hand comes within spot's tol only near the end
const tol = refDistance(out, 44, "joint:LeftHand", "anchor:spot");
r = run([{ name: "all", near: ["joint:LeftHand", "anchor:spot"], tol, at: [30, 47] }, { name: "any", near: ["joint:LeftHand", "anchor:spot"], tol, at: [30, 47], mode: "any" }]);
const [all, any] = r.qa.goals;
const allGroup = r.qa.groups.find(x => x.subject.startsWith("all:"));
expect("mode all fails: the result is the worst frame, one issue per failing frame", !all.ok && all.at === 30 && allGroup.first === 30 && allGroup.count >= 10 && allGroup.last < 47, JSON.stringify({ all, allGroup }));
expect("mode any passes on its best frame", any.ok && any.at > 44 && any.value <= tol, JSON.stringify(any));
r = run([{ name: "any", near: ["joint:LeftHand", "anchor:spot"], tol: 0.01, at: [30, 47], mode: "any" }]);
g = r.qa.groups[0];
expect("mode any fails with one issue at its best frame", !r.qa.ok && g.count === 1 && g.worstFrame === r.qa.goals[0].at && g.subject.includes(", the best of f30-f47 (needs <= 0.01)"), JSON.stringify(g));

// 5. GOAL groups come first, ahead of a more severe group (the cup tipped into the table top);
//    issue frames index a windowed out
r = run([{ name: "reach spot", near: ["joint:LeftHand", "anchor:spot"], tol: 0.001, at: 47 }], { keys: base().keys.map(k => (k.f === 47 ? { ...k, set: { ...k.set, tip: 90 } } : k)) });
expect("a GOAL group is first even when another group is more severe", r.qa.groups[0].kind === "GOAL" && r.qa.groups.length > 1 && r.qa.groups.slice(1).some(x => x.severity > r.qa.groups[0].severity), JSON.stringify(r.qa.groups.map(x => [x.kind, x.severity])));
const windowed = { ...out, f0: 20, frames: out.frames.slice(20) };
const wc = goalChecks(windowed, [{ name: "w", near: ["joint:LeftHand", "anchor:spot"], tol: 0.001, at: [10, 30] }]);
expect("issue frames index out.frames (f - out.f0); results stay absolute; frames outside the window are skipped", wc.issues.length === 11 && wc.issues[0].frame === 0 && wc.results[0].at >= 20 && wc.results[0].at <= 30, JSON.stringify(wc.results));
expect("a goal the window does not reach answers nothing", goalChecks(windowed, [{ near: ["joint:LeftHand", "anchor:spot"], at: 5 }]).results.length === 0);
const unnamed = goalChecks(out, [{ near: ["joint:LeftHand", "anchor:spot"], tol: 0.001, at: 0 }, { near: ["joint:RightHand", "anchor:spot"], tol: 0.001, at: 0 }]);
expect("an unnamed goal is named goals[i]", unnamed.results.map(x => x.name).join() === "goals[0],goals[1]" && unnamed.issues[1].msg.startsWith("goals[1]: "), JSON.stringify(unnamed.results));

// 6. the hint: move the hand target by the shortfall toward the target; the fix is a hand_l delta
r = run([{ name: "reach spot", near: ["joint:LeftHand", "anchor:spot"], tol: 0.01, at: 47 }]);
g = r.qa.groups[0];
const fix = g.fix;
expect("the GOAL hint moves hand_l at the worst frame, and its fix is { channel: hand_l, f, delta }", fix?.channel === "hand_l" && fix.f === 47 && close(len(fix.delta), g.worst + 0.003)
	&& /^hand_l: move \[.+\] m at f47 \(goal "reach spot" is [\d.]+ m short; needs <= 0.01\)$/.test(g.hint) && /keys\[2\] f47 hand_l/.test(g.cause) && !("fix" in JSON.parse(JSON.stringify(g))), JSON.stringify({ g, fix }));
const keys = base().keys.map(k => (k.f === 47 ? { ...k, set: { ...k.set, hand_l: add(HAND1, fix.delta) } } : k));
const fixed = run([{ name: "reach spot", near: ["joint:LeftHand", "anchor:spot"], tol: 0.01, at: 47 }], { keys });
expect("applying the fix's delta to the key meets the goal", fixed.qa.goals[0].ok, JSON.stringify(fixed.qa.goals));
r = run([{ name: "lift", above: ["object:cube.top", "prop:grip.tip"], by: 0.1, at: 47 }]);
expect("above with the hand on the b side moves the hand down", r.qa.groups[0].fix?.channel === "hand_l" && r.qa.groups[0].fix.delta[1] < 0, JSON.stringify(r.qa.groups[0]));
r = run([{ name: "carried", moved: "object:cylinder", by: 3, at: 47 }], { objects: { cylinder: { prop: "grip" } }, channels: ["tip"] });
expect("moved on an object in hand moves the hand that holds it", r.qa.groups[0].fix?.channel === "hand_l" && /^hand_l: move/.test(r.qa.groups[0].hint), JSON.stringify(r.qa.groups[0]));
r = run([{ name: "still", moved: `object:${CUP.group}`, at: 10 }]);
expect("moved on an object nothing holds says so, without a fix", r.qa.groups[0].hint === `${CUP.group} is not in a hand at f10, so nothing moves it: carry it (objects.${CUP.group} = { prop, grab }) or hinge it` && !r.qa.groups[0].fix, r.qa.groups[0].hint);
expect("the hint without spec goals still answers { cause, hint }", typeof goalHints.GOAL({}, { subject: "x: 1 m", worstFrame: 3 }).hint === "string");

// 7. validation: exact messages
const invalid = goals => refusal(() => run(goals)).replace(/^MOTION_SPEC_INVALID: /, "").split("\n");
const cases = [
	[[{ near: ["joint:LeftHand", "anchor:spot"], above: ["joint:LeftHand", "object:cube.top"], at: 3 }], ["goals[0] names near and above; a goal takes exactly one of near, above, moved, still, speed (split it into 2 goals)"]],
	[[{ at: 3 }], ["goals[0] needs one predicate: near, above, moved, still, speed"]],
	[[{ near: ["joint:LeftHnad", "anchor:spot"], at: 3 }], ['goals[0].near[0] "joint:LeftHnad": unknown bone; did you mean "LeftHand"?']],
	[[{ near: ["joint:LeftHand", "object:empty-3"], at: 3 }], ['goals[0].near[1] "object:empty-3" names object "empty-3", which is not in the scene; did you mean "empty-2"?']],
	[[{ moved: "joint:Hips", at: 3 }], ['goals[0].moved "joint:Hips" measures how far the point gets from where it is at at[0], so at must be [f0, f1] with f0 < f1, got 3']],
	[[{ near: ["joint:LeftHand"], at: 3 }], ['goals[0].near must be [ref, ref] (two point refs), got ["joint:LeftHand"]']],
	// a window wholly past the clip (one that only runs past the end is cut to it, C19)
	[[{ moved: "object:cylinder", at: [50, 60] }], ["goals[0].at = [50,60] is outside 0..47 (spec.frames 48); set frames >= 61"]],
	[[{ moved: "object:cylinder", at: -1 }], ["goals[0].at = -1 is outside 0..47 (spec.frames 48)"]],
	[[{ moved: "object:cylinder", at: [20, 10] }], ["goals[0].at must be an integer frame or [f0, f1] with f0 <= f1, got [20,10]"]],
	[[{ moved: "object:cylinder" }], ["goals[0] needs at: a frame or [f0, f1] (absolute frames within 0..47)"]],
	[[{ moved: "object:cylinder", at: 3, mode: "some" }], ['goals[0].mode must be "all" or "any", got "some"']],
	[[{ near: ["joint:LeftHand", "anchor:spot"], tol: -1, at: 3 }], ["goals[0].tol must be a number >= 0 (metres), got -1"]],
	// tol on above/moved names the by that replaces it (the live sessions 1e3d1adc and c100b90c sent tol 0.05 and 0.02 on above)
	[[{ above: ["joint:LeftHand", "anchor:spot"], tol: 0.1, at: 3 }], ["goals[0].tol applies to near and still; above takes by (a.y - b.y >= by, default 0): use by: 0.1 for a at least 0.1 m above b, or by: -0.1 to let a sit up to 0.1 m below b, not tol"]],
	[[{ above: ["joint:LeftKnee", "joint:Hips"], tol: 0.02, at: 3 }], ["goals[0].tol applies to near and still; above takes by (a.y - b.y >= by, default 0): use by: 0.02 for a at least 0.02 m above b, or by: -0.02 to let a sit up to 0.02 m below b, not tol"]],
	[[{ moved: "object:cylinder", tol: 0.03, at: 3 }], ["goals[0].tol applies to near and still; moved takes by (the object moves >= by, default 0.05): use by: 0.03 (metres), not tol"]],
	[[{ above: ["joint:LeftHand", "anchor:spot"], tol: "x", at: 3 }], ["goals[0].tol applies to near and still; above takes by (a.y - b.y >= by, default 0): use by: 0.05 for a at least 0.05 m above b, or by: -0.05 to let a sit up to 0.05 m below b, not tol"]],
	[[{ near: ["joint:LeftHand", "anchor:spot"], by: 0.1, at: 3 }], ["goals[0].by applies to above, moved and speed; near takes tol"]],
	[[{ moved: "object:cylinder", by: -0.1, at: 3 }], ["goals[0].by must be a number >= 0 (metres), got -0.1"]],
	[[{ moved: "object:cylinder", at: 3, mdoe: "any" }], ['goals[0] has unknown field "mdoe"; did you mean "mode"? (fields: name, near, above, moved, still, speed, tol, by, at, mode, after, before)']],
	[[{ name: "a", moved: "object:cylinder", at: 3 }, { name: "a", moved: "object:cylinder", at: 4 }], ['goals[1].name "a" is already used by goals[0]; goal names must differ']],
	[{ near: [] }, ['spec.goals must be an array of goals { name?, near | above | moved | still | speed, tol?, by?, at, mode?, after?, before? }, got {"near":[]}']],
	[["x"], ['goals[0] must be { name?, near | above | moved | still | speed, tol?, by?, at, mode?, after?, before? }, got "x"']],
];
for (const [goals, want] of cases) {
	const got = invalid(goals);
	expect(`validation: ${want[0].slice(0, 70)}`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
}
expect("a valid goal of each kind passes validation, with every ref kind", refusal(() => run([{ name: "n", near: ["prop:grip.tip", "landmark:mouth"], tol: 0.5, at: [0, 47] },
	{ name: "a", above: ["bone:LeftHand", `object:${CUP.group}.top`], at: 47, mode: "any" }, { name: "m", moved: `object:${CUP.group}.center`, by: 0, at: 0 }])) === "");
// a bare moved id is taken as object:<id> (lane H3a; moved on other point refs: lane M2); refs in fields that
// take any kind stay strict, and a bare name is refused with the prefixed forms it could mean
r = run([{ name: "bare", moved: "cylinder", by: 0.02, at: 47 }, { name: "bare group", moved: `${CUP.group}.top`, at: 47 }]);
const prefixedRun = run([{ name: "bare", moved: "object:cylinder", by: 0.02, at: 47 }, { name: "bare group", moved: `object:${CUP.group}.top`, at: 47 }]);
expect("a bare moved id is the object: ref (the same result; the filled-in spec holds object:<id>)", JSON.stringify(r.qa.goals) === JSON.stringify(prefixedRun.qa.goals)
	&& r.qa.goals[0].ok && r.spec.goals[0].moved === "object:cylinder" && r.spec.goals[1].moved === `object:${CUP.group}.top`, JSON.stringify([r.qa.goals, r.spec.goals]));
const ALL = "joint:<Bone>, bone:<Bone>, prop:<prop>.<point>, anchor:<name>, landmark:mouth, object:<id>[.center|.top|.base|.rim], person:<id>.<Bone>";
const bareCases = [
	[[{ moved: "nope", at: 3 }], ['goals[0].moved "object:nope" names object "nope", which is not in the scene; did you mean "cube"?']],
	[[{ moved: 3, at: 3 }], ['goals[0].moved must be an object id or a point ref (object:<id>[.center|.top|.base], prop:<prop>.<point>, joint:<Bone>, landmark:mouth, anchor:<name>), got 3']],
	[[{ near: ["mouth", "zzz"], at: 3 }], [`goals[0].near[1] "zzz" must be ${ALL}`, '(adjusted before these checks: corrected: goals[0].near[0] "mouth" -> "landmark:mouth")']],
];
for (const [goals, want] of bareCases) {
	const got = invalid(goals);
	expect(`bare refs: ${want[0].slice(0, 70)}`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
}
// a bare near / above name with exactly one reading is that ref (C21, lenient.js), named in notes; the compile goes on
const bareOne = run([{ name: "b1", near: ["LeftHand", CUP.group], at: 3 }, { name: "b2", above: ["grip.tip", "spot"], at: 3 }]);
expect("a bare name with one reading is corrected to its ref and named", JSON.stringify(bareOne.notes) === JSON.stringify(['corrected: goals[0].near[0] "LeftHand" -> "joint:LeftHand"',
	`corrected: goals[0].near[1] "${CUP.group}" -> "object:${CUP.group}"`, 'corrected: goals[1].above[0] "grip.tip" -> "prop:grip.tip"', 'corrected: goals[1].above[1] "spot" -> "anchor:spot"']), JSON.stringify(bareOne.notes));
const lenient = compileSpec(base({ goals: [{ moved: "object:cylinder", by: 0.02, at: 47, extra: 1 }] }), { sk, scene }, { lenient: true });
expect("lenient ignores an unknown goal field", lenient.qa.goals[0].ok, JSON.stringify(lenient.qa.goals));

// 8. search: an open hand height converges onto an above goal (the midpoint 1.1 m is too low)
const open = { f: 47, set: { hand_l: [0.2, { range: [0.9, 1.3] }, 0.3], tip: -90 } };
r = run([{ name: "high hand", above: ["joint:LeftHand", "object:cube.top"], by: 0.4, at: 47 }], { keys: [base().keys[0], base().keys[1], open] });
const y = r.search?.values["keys[2].set.hand_l[1]"];
console.log(`  search ${JSON.stringify(r.search)}; goal ${JSON.stringify(r.qa.goals)}`);
expect("the { range } search finds a hand height that meets the goal, with QA 0", r.qa.ok && r.qa.goals[0].ok && y >= 1.15 && r.search.cost === 0, JSON.stringify(r.search));
r = run(undefined, { keys: [base().keys[0], base().keys[1], open] });
expect("without the goal the search keeps the midpoint", r.search.values["keys[2].set.hand_l[1]"] === 1.1 && r.search.evals === 1, JSON.stringify(r.search));

// --- lane H3b: the GOAL hint when moving the hand target cannot help ---------------------------
// (a) another anchor weight of the hand ramps through the goal frame: key it 0 there;
// (b) the arm is at full reach: move the body (fixtures/reach-press.mjs, an empty scene).
{
	const { press } = await import("./fixtures/reach-press.mjs");
	const spot = { kind: "world", p: [0.2, 1.1, 0.35] }, far = { kind: "world", p: [0.5, 1.4, 0.2] };
	const leaky = run([{ name: "on spot", near: ["prop:grip.tip", "anchor:spot"], tol: 0.01, at: [30, 34] }], {
		anchors: { spot, far }, fits: [{ side: "l", anchor: "spot", effector: { prop: "grip", point: "tip" } }],
		keys: [{ f: 0, set: { armw_l: 1, hand_l: HAND0, w_spot_l: 0, w_far_l: 0, tip: 0 } }, { f: 24, set: { w_spot_l: 1, tip: 0 } }, { f: 47, set: { w_spot_l: 1, w_far_l: 1, tip: 0 } }] });
	const lg = leaky.qa.groups.find(x => x.kind === "GOAL");
	console.log(`  leak: ${lg?.hint} ${JSON.stringify(lg?.patch)}`);
	expect("H3b leak: the hint names the ramping weight and its share, the fix keys it 0 at f34", /^w_far_l is [\d.]+ at f\d+, so anchor far takes \d+% of the hand target from anchor spot: key w_far_l 0 at f34 \(goal "on spot"/.test(lg?.hint ?? "")
		&& lg.fix?.channel === "w_far_l" && lg.fix.f === 34 && lg.fix.value === 0 && /w_far_l between keys\[0\] f0 and keys\[2\] f47/.test(lg.cause), JSON.stringify(lg));
	const sealed = run([{ name: "on spot", near: ["prop:grip.tip", "anchor:spot"], tol: 0.01, at: [30, 34] }], {
		anchors: { spot, far }, fits: [{ side: "l", anchor: "spot", effector: { prop: "grip", point: "tip" } }],
		keys: [{ f: 0, set: { armw_l: 1, hand_l: HAND0, w_spot_l: 0, w_far_l: 0, tip: 0 } }, { f: 24, set: { w_spot_l: 1, tip: 0 } }, { f: 47, set: { w_spot_l: 1, w_far_l: 1, tip: 0 } }, { f: 34, set: { w_far_l: 0 } }] });
	expect("H3b leak: keying it as the fix says meets the goal", sealed.qa.goals[0].ok, JSON.stringify(sealed.qa.goals));
	// 0.7 m ahead the compiler brings the body itself (fix.reach, fix/reach-body.js); 0.9 m is past what it may lean and shift
	const near = compileSpec(press("stand", 0.7), { sk, scene: { objects: {} } });
	expect("H3b reach: a button the straight arm misses, but a lean reaches, is met by the compiler (fixed.reachBody says what moved)", near.qa.goals[0].ok && near.fixed.reachBody?.runs?.[0]?.side === "l" && near.fixed.reachBody.runs[0].lean > 0, JSON.stringify({ goals: near.qa.goals, fixed: near.fixed.reachBody }));
	const pressed = compileSpec(press("stand", 0.9), { sk, scene: { objects: {} } }), pg = pressed.qa.groups.find(x => x.kind === "GOAL"), fr = pressed.out.frames[pg.worstFrame];
	console.log(`  reach: ${pg.hint} ${JSON.stringify(pg.patch)}`);
	expect("H3b reach: at full reach the hint moves the body toward the target, the fix is a hold root move, the patch the standIdle at",
		/^body: move \[[+-][\d.]+, 0, \+[\d.]+\] m toward the target at f\d+, root held since use\[0\] standIdle f0 \(arm l is at full reach\) \(goal "finger on the button"/.test(pg.hint)
		&& (fr.diag.reach_over_l > 0 || fr.diag.arm_miss_l > 0.002) && pg.fix?.channel === "root" && pg.fix.hold === true && pg.fix.delta[1] === 0 && pg.fix.delta[2] > 0
		&& pg.patch?.[0]?.path === "/use/0/args/at" && pg.patch[0].value[1] > 0, JSON.stringify(pg));
	const reach = pressed.qa.groups.find(x => x.kind === "REACH");
	expect("H3b reach: REACH on an anchor a goal names moves the body too", reach?.fix?.hold === true && /^body: move .* \(out of reach by [\d.]+ m\), or anchor button: move/.test(reach.hint), JSON.stringify(reach));
}

if (failures) {
	console.error(`verify-motion3-goals: ${failures} failure(s)`);
	process.exit(1);
}
console.log("verify-motion3-goals: all checks passed");
