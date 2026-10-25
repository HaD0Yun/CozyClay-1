import * as THREE from "three";
import { createContactProjector } from "../../src/motion/contact-project.js";

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

// 5. cost: 2 probes x 2 blockers x 4 passes per event, in node
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
