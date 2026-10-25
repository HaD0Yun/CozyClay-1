#!/usr/bin/env node
// QA BALANCE (opted in by checks.limits.balance) measures the mass-weighted centre of mass
// against the support polygon of the feet on the ground (qa/com.js): a straight stance is clean,
// the hips pushed 0.2 m past the toes are a BALANCE whose subject says how far and which way,
// and the hint's fix moves the root back toward the polygon's nearest edge.
import { compileSpec } from "../../src/motion3/pipeline.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { bakeTake } from "../../src/motion3/take.js";
import { centerOfMass, bodyCentre, supportMargin, SEGMENT_FRACTIONS } from "../../src/motion3/qa/com.js";
import { takeHash } from "./fixtures/take-hash.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const json = JSON.stringify;
const sk = skeletonFor("x-bot-tpose"), I = sk.index, P = sk.restWorldPos, empty = { objects: {} };
const hipY = P[I.Hips][1] - 0.01;
const compile = spec => compileSpec(spec, { sk, scene: empty });
const stand = (extra = {}) => ({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 40, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0] } }], checks: { limits: { balance: 0.08 } }, ...extra });
const balance = r => r.qa.groups.filter(g => g.kind === "BALANCE");

// the table: Dempster's fractions sum to 1
expect("segment mass fractions sum to 1", Math.abs(SEGMENT_FRACTIONS.reduce((a, s) => a + s.mass, 0) - 1) < 1e-9);

// (a) a straight stance: no BALANCE, the centre of mass inside the support polygon
const still = compile(stand());
expect("a straight stance with balance opted in has no BALANCE and a positive balance margin", balance(still).length === 0 && still.observations.balance.min?.[0] > 0,
	json({ groups: still.qa.groups.map(g => g.subject), balance: still.observations.balance }));

// (b) bent far forward over planted feet (hips 0.22 m forward, trunk pitched 90 deg, arms reaching
// ahead): BALANCE with a distance, a direction and a frame. The hips 0.2 m forward alone keep the
// mass-weighted centre of mass over the toes (margin 0.05 m): the legs and feet stay behind.
const bend = { root: [0, hipY, 0.22], spine_pitch: 90, head_pitch: 40, armw_l: 1, armw_r: 1, hand_l: [0.2, 1, 0.8], hand_r: [-0.2, 1, 0.8] };
const ahead = stand({ fix: { reach: false }, keys: [{ f: 0, set: bend }, { f: 39, set: bend }] });
const leant = compile(ahead), bal = balance(leant);
const m = /^centre of mass (\d+\.\d\d) m ahead of the feet \(toward \+Z\), f(\d+)$/.exec(bal[0]?.subject ?? "");
expect("bent far forward: one BALANCE group, its subject names metres, ahead, +Z and the frame", bal.length === 1 && m && Math.abs(Number(m[1]) - bal[0].worst) < 0.006 && Number(m[2]) === bal[0].worstFrame,
	json(leant.qa.groups.map(g => [g.kind, g.subject, g.worst, g.worstFrame])));
expect("the worst BALANCE value is past the 0.08 m limit and under 0.2 m", bal[0]?.worst > 0.08 && bal[0]?.worst < 0.2, json(bal[0]));
const fix = bal[0]?.fix;
expect("the hint moves the root back (-Z) and says why in numbers", fix?.channel === "root" && fix.delta[2] < -0.01 && Math.abs(fix.delta[0]) < 0.01 && fix.delta[1] === 0
	&& /root: move \[.*\] m at f\d+ \(centre of mass \d+\.\d\d m ahead of the feet \(toward \+Z\)/.test(bal[0].hint), json({ hint: bal[0]?.hint, fix }));
expect("the fix leaves the centre of mass 1 cm inside the limit: delta = worst - (limit - 0.01)", Math.abs(-fix.delta[2] - (bal[0].worst - 0.07)) < 0.005, json({ fix, worst: bal[0].worst }));

// (c) the mass-weighted centre of mass is not the 4-point average: the head carries 8.1% of the body, not a quarter
const rest = { P: P.map(p => [...p]) };
const avg4 = s => [0, 1, 2].map(k => ["Hips", "Spine1", "Spine2", "Head"].reduce((a, j) => a + s.P[I[j]][k], 0) / 4);
const nod = { P: rest.P.map((p, i) => (i === I.Head ? [p[0], p[1], p[2] + 0.3] : p)) };
const shift = (fn, s) => fn(sk, s)?.[2] - fn(sk, rest)[2];
expect("the head 0.3 m forward: the 4-point average moves 7.5 cm, the mass-weighted centre of mass 1.2 cm",
	Math.abs((avg4(nod)[2] - avg4(rest)[2]) - 0.075) < 1e-9 && Math.abs(shift(centerOfMass, nod) - 0.081 * 0.3 / 2) < 1e-9, json({ avg: avg4(nod)[2] - avg4(rest)[2], com: shift(centerOfMass, nod) }));
const noNeck = { ...sk, index: Object.fromEntries(Object.entries(I).filter(([j]) => j !== "Neck")) };
expect("a skeleton missing a segment bone: centerOfMass is null and bodyCentre falls back to the 4-point average",
	centerOfMass(noNeck, rest) === null && json(bodyCentre(noNeck, rest)) === json(avg4(rest)));

// the support polygon is the convex hull, not the box: a corner of the box outside the triangle is outside
const tri = [[0, 0], [1, 0], [0, 1]];
const inner = supportMargin([0.2, 0.2], tri), corner = supportMargin([0.9, 0.9], tri);
expect("support polygon: inside is the distance to the nearest edge, the box corner off the hull is outside by its distance",
	Math.abs(inner.margin - 0.2) < 1e-9 && Math.abs(corner.margin + 0.8 / Math.SQRT2) < 1e-9 && Math.abs(corner.near[0] - 0.5) < 1e-9 && Math.abs(corner.near[1] - 0.5) < 1e-9,
	json({ inner, corner }));
expect("support polygon of one foot's collinear points: no inside, the margin is minus the distance", supportMargin([0, 0], [[1, 0], [1, 1], [1, 2]]).margin === -1);

// (d) the same spec twice: the same take and the same QA
const again = compile(ahead);
expect("deterministic: the same take and the same qa and observations", takeHash(bakeTake(sk, again.out)) === takeHash(bakeTake(sk, leant.out))
	&& json(again.qa) === json(leant.qa) && json(again.observations.balance) === json(leant.observations.balance));

if (failures) { console.error(`${failures} motion3 balance check(s) failed`); process.exit(1); }
console.log("motion3 balance: all checks passed");
