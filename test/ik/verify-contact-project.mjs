import * as THREE from "three";
import { createContactProjector } from "../../src/motion/contact-project.js";
import { clampDragTarget, solveDragTarget } from "../../src/motion/ik-drag.js";
import { resolveIkRig, solveIk } from "../../src/motion/ik.js";
import { buildCollisionCapsules, closestPointsSegmentSegment } from "../../src/motion/fix-collisions.js";
import { characterBlockers } from "../../src/motion/collision-blockers.js";

/* The Studio drag's contact projection (src/motion/contact-project.js): a hand
 * dragged into another character's torso stops on the surface, on the side it
 * came from, at an allowed depth when the touch is intended, and the same input
 * always gives the same output. Fixture: the research poke scene reduced to
 * capsules (other body's torso axis at z = 2.0, the hand arriving from z < 2). */

let failures = 0;
function check(name, cond, detail = "") {
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
	if (!cond) failures += 1;
}
const v = (x, y, z) => new THREE.Vector3(x, y, z);
const mm = (m) => `${(m * 1000).toFixed(2)}mm`;

const TORSO = { id: "char:char-b:torso", a: v(0, 0.95, 2.0), b: v(0, 1.4, 2.0), radius: 0.15 };
const HEAD = { id: "char:char-b:head", a: v(0, 1.5, 2.0), b: v(0, 1.62, 2.0), radius: 0.11 };
const blockers = [TORSO, HEAD];
const HAND_R = 0.05, REACH = TORSO.radius + HAND_R, MARGIN = 0.004;
// the dragged limb: a hand sphere at the handle and a forearm back toward a shoulder at z = 1.5
const probe = (candidate) => [
	{ id: "rightForeArm", a: v(-0.2, 1.35, 1.5), b: candidate.clone(), radius: 0.03 },
	{ id: "rightHand", a: candidate.clone(), b: candidate.clone(), radius: HAND_R },
];
const axisDistance = (p) => Math.hypot(p.x - 0, p.z - 2.0);
const FRONT = v(0, 1.2, 1.6);

const projector = createContactProjector({ blockers });

/* Synthetic Mixamo-spelled rig in a T-pose (test/ik/verify-ik.mjs layout):
 * arms along ±X, legs along -Y, toes +Z, scaled 0.01 (cm -> m). */
function makeRig() {
	const rig = new THREE.Object3D();
	rig.scale.setScalar(0.01);
	const mk = (name, parent, x, y, z) => { const b = new THREE.Bone(); b.name = name; b.position.set(x, y, z); parent.add(b); return b; };
	const hips = mk("mixamorigHips", rig, 0, 100, 0), spine = mk("mixamorigSpine", hips, 0, 15, 0), chest = mk("mixamorigSpine1", spine, 0, 15, 0);
	mk("mixamorigSpine2", chest, 0, 15, 0);
	const neck = mk("mixamorigNeck", chest, 0, 30, 0), head = mk("mixamorigHead", neck, 0, 15, 0);
	mk("mixamorigHeadTop_End", head, 0, 20, 0);
	for (const [side, s] of [["Left", 1], ["Right", -1]]) {
		const shoulder = mk(`mixamorig${side}Shoulder`, chest, 10 * s, 25, 0), arm = mk(`mixamorig${side}Arm`, shoulder, 10 * s, -10, 0);
		mk(`mixamorig${side}Hand`, mk(`mixamorig${side}ForeArm`, arm, 30 * s, 0, 0), 30 * s, 0, 0);
		const up = mk(`mixamorig${side}UpLeg`, hips, 10 * s, 0, 0), leg = mk(`mixamorig${side}Leg`, up, 0, -45, 0);
		mk(`mixamorig${side}ToeBase`, mk(`mixamorig${side}Foot`, leg, 0, -45, 0), 0, -5, 12);
	}
	rig.updateMatrixWorld(true);
	return rig;
}
// the right arm's capsules as the drag probe reads them (same filter, same order)
const armCapsules = (rig) => [...buildCollisionCapsules(rig).values()]
	.filter((c) => c.def.movable?.chain === "rightHand" && !c.def.handId && !c.def.optional)
	.map((c) => ({ a: c.a.clone(), b: c.b.clone(), radius: c.radius }));
// deepest overlap of `mine` into `theirs` (m); <= 0 means clear
function overlap(mine, theirs) {
	const p = v(0, 0, 0), q = v(0, 0, 0);
	let worst = -Infinity;
	for (const m of mine) for (const t of theirs) worst = Math.max(worst, m.radius + t.radius - Math.sqrt(closestPointsSegmentSegment(m.a, m.b, t.a, t.b, p, q)));
	return worst;
}

// 1. surface stop: a target 5 cm inside the front lands on the surface (+ margin)
{
	const target = v(0, 1.2, 1.85);
	const { target: out, contact, depth } = projector.project(target, probe, FRONT);
	const d = axisDistance(out);
	check("a hand pushed into the torso is projected", contact && depth === 0, JSON.stringify({ contact, depth }));
	check("it stops on the surface: reach <= distance <= reach + margin", d >= REACH - 1e-9 && d <= REACH + MARGIN + 1e-6, `distance ${mm(d)}, reach ${mm(REACH)}`);
	check("the input target is not mutated", target.z === 1.85);
	const free = projector.project(v(0, 1.2, 1.7), probe, FRONT);
	check("a target outside the body passes unchanged", !free.contact && free.target.equals(v(0, 1.2, 1.7)));
}

// 2. keep the side: a target past the torso axis stays in front; the closest-point rule would tunnel
{
	for (const z of [1.93, 2.0, 2.04, 2.1]) {
		const { target: out } = projector.project(v(0, 1.2, z), probe, FRONT);
		check(`target z ${z.toFixed(2)} stays on the front (z < 2.0)`, out.z < 2.0 && axisDistance(out) >= REACH - 1e-9, `out z ${out.z.toFixed(4)}`);
	}
	const tunnel = projector.project(v(0, 1.2, 2.04), probe, null);
	check("negative control: with no side to keep the nearest normal exits the back", tunnel.target.z > 2.0, `out z ${tunnel.target.z.toFixed(4)}`);
	// a drag sweeping straight through, feeding back each clean result as lastGood
	let lastGood = FRONT.clone(), worstZ = -Infinity;
	for (let i = 0; i <= 60; i++) {
		const { target: out, depth } = projector.project(v(0, 1.2, 1.6 + i * 0.01), probe, lastGood);
		if (depth === 0) lastGood = out.clone();
		worstZ = Math.max(worstZ, out.z);
	}
	check("a drag sweeping through the body never reaches its back", worstZ < 2.0 - REACH + MARGIN + 1e-6, `furthest z ${worstZ.toFixed(4)}`);
}

// 3. allow depth: an intended touch may go that deep (spec.checks.allow person entries)
{
	const allowDepth = 0.05;
	const allowed = createContactProjector({ blockers, allow: (part, blocker) => (blocker.startsWith("char:char-b:") ? allowDepth : null) });
	const within = allowed.project(v(0, 1.2, 1.84), probe, FRONT);
	check("a touch within the allowed depth is left alone", !within.contact && within.target.equals(v(0, 1.2, 1.84)));
	const past = allowed.project(v(0, 1.2, 1.95), probe, FRONT);
	const d = axisDistance(past.target);
	check("past the allowance it stops at reach - allow", d >= REACH - allowDepth - 1e-9 && d <= REACH - allowDepth + MARGIN + 1e-6, `distance ${mm(d)}, expected ${mm(REACH - allowDepth)}`);
	const flat = createContactProjector({ blockers, allow: allowDepth }).project(v(0, 1.2, 1.95), probe, FRONT);
	check("a numeric allowance works the same", flat.target.equals(past.target));
	// the allowance is per part: a hand allowed in still keeps its forearm (reach 0.18) out
	const handOnly = createContactProjector({ blockers, allow: (part) => (part === "rightHand" ? allowDepth : null) }).project(v(0, 1.2, 1.95), probe, FRONT);
	const dh = axisDistance(handOnly.target);
	check("an allowance names its part: the forearm still stops at its own reach", dh >= 0.18 - 1e-9 && dh <= 0.18 + MARGIN + 1e-6, `distance ${mm(dh)}`);
}

// 4. determinism: same input, same output, bit for bit
{
	const inputs = [v(0.03, 1.25, 1.9), v(-0.02, 1.45, 1.98), v(0.01, 1.1, 2.06)];
	const run = () => inputs.map((t) => projector.project(t, probe, FRONT).target.toArray());
	const first = run(), second = run(), fresh = inputs.map((t) => createContactProjector({ blockers }).project(t, probe, FRONT).target.toArray());
	const same = (a, b) => a.every((p, i) => p.every((x, k) => Object.is(x, b[i][k])));
	check("same input twice gives the same output", same(first, second), JSON.stringify({ first, second }));
	check("a new projector over the same blockers gives the same output", same(first, fresh));
	check("blockers are never moved", TORSO.a.equals(v(0, 0.95, 2.0)) && TORSO.b.equals(v(0, 1.4, 2.0)) && HEAD.a.equals(v(0, 1.5, 2.0)));
}

// 5. the probe checks the pose the drag DISPLAYS (review finding: the probe ran
// an exactHinge solve, the drag a plain one; from a bent arm they put the elbow
// and hand centimetres apart, so a target the probe passed could leave the
// displayed limb inside the other body). Synthetic Mixamo rigs (verify-ik.mjs
// layout, 1 cm proxy radii): A's right arm bent, B placed so its left forearm
// runs through where the plain solve puts A's hand, clear of the exact-hinge arm.
{
	const rigA = makeRig(), chain = resolveIkRig(rigA).chains.get("rightHand");
	chain.bones[0].quaternion.setFromAxisAngle(v(0, 0, 1), 0.9);
	chain.bones[1].quaternion.setFromAxisAngle(v(0, 1, 0), -1.1);
	rigA.updateMatrixWorld(true);
	const start = chain.bones.map((b) => b.quaternion.clone());
	const reset = () => { chain.bones.forEach((b, i) => b.quaternion.copy(start[i])); chain.bones[0].updateMatrixWorld(true); };
	const at = (bone) => bone.getWorldPosition(v(0, 0, 0));
	const target = at(chain.bones[2]).add(v(0.1, -0.1, 0.25));
	solveIk(chain, target, { exactHinge: true });
	const exactHand = at(chain.bones[2]);
	const exactArm = armCapsules(rigA);
	reset();
	solveDragTarget("chain", chain, target);
	const plainHand = at(chain.bones[2]);
	reset();
	const rigB = makeRig();
	const forearm = buildCollisionCapsules(rigB).get("leftForeArm");
	rigB.position.copy(plainHand).sub(forearm.a.clone().add(forearm.b).multiplyScalar(0.5));
	rigB.updateMatrixWorld(true);
	const rigs = { a: rigA, b: rigB };
	const theirs = characterBlockers(rigs, "a");
	check("fixture: the exact-hinge and the plain solve put the hand > 5 cm apart", exactHand.distanceTo(plainHand) > 0.05, mm(exactHand.distanceTo(plainHand)));
	check("fixture: the exact-hinge arm at the target is clear of B (the old probe accepted it)", overlap(exactArm, theirs) <= 0, mm(overlap(exactArm, theirs)));
	solveDragTarget("chain", chain, target);
	check("fixture: the displayed (plain-solve) arm at the raw target is inside B", overlap(armCapsules(rigA), theirs) > 0.005, mm(overlap(armCapsules(rigA), theirs)));
	reset();

	const record = { frame: 0, ids: new Set() };
	const drag = () => clampDragTarget({ kind: "chain", trackId: "rightHand", targetWorld: target, bodyContact: false, chains: new Map([["rightHand", chain]]), record, open: () => ({ rigs, activeId: "a" }) });
	const out = drag();
	const probed = record.contact.probe(out).map((r) => [r.a.clone(), r.b.clone()]);
	reset();
	solveDragTarget("chain", chain, out); // what ikSolve displays
	const shown = armCapsules(rigA);
	const gap = Math.max(...probed.map(([a, b], i) => Math.max(a.distanceTo(shown[i].a), b.distanceTo(shown[i].b))));
	check("the probe's pose and the displayed pose agree within 1e-6 m", gap < 1e-6, `gap ${gap}`);
	check("the drag stopped short of the raw target", out.distanceTo(target) > 0.01, mm(out.distanceTo(target)));
	check("the displayed arm after the drag is clear of B", overlap(shown, theirs) <= 1e-9, mm(overlap(shown, theirs)));
	reset();
	check("the same drag from the same pose gives the same target", (() => { record.contact = undefined; return drag().equals(out); })());
}

// 6. cost: 2 probes x 2 blockers x 4 passes per event, in node
{
	const target = v(0, 1.2, 1.95), n = 20000;
	for (let i = 0; i < 2000; i++) projector.project(target, probe, FRONT);
	const t0 = performance.now();
	for (let i = 0; i < n; i++) projector.project(target, probe, FRONT);
	console.log(`projection cost (node, 2 probes x 2 blockers): ${(((performance.now() - t0) / n) * 1000).toFixed(2)} us/event`);
}

if (failures) {
	console.log(`${failures} contact projection check(s) FAILED`);
	process.exit(1);
}
console.log("all contact projection checks PASS");
