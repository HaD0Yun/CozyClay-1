#!/usr/bin/env node
// observations.life (src/motion3/qa/motion-life.js): how mechanical a take reads, on synthetic frames. Every
// part starting on one frame reads synchronous, staggered parts do not; keys on an even grid are flagged,
// irregular ones are not; arms that bend alike on the same frames twin, arms out of phase do not; a seam in a
// path is a jerk spike, a smooth path is not; a body frozen for a second is dead, a swaying one is not. Then a
// compile answers it in observations, warnings only (qa.ok is untouched), cheaply.
import { observeLife } from "../../src/motion3/qa/motion-life.js";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { motionScene } from "../../src/motion3/scene.js";
import { rz, mul, add } from "../../src/motion3/compiler/math.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const sk = skeletonFor("y-bot-tpose"), I = sk.index, json = JSON.stringify;
const CHAINS = ["Hips", "Spine", "Spine2", "Head", "LeftArm", "RightArm", "LeftForeArm", "RightForeArm", "LeftHand", "RightHand",
	"LeftUpLeg", "RightUpLeg", "LeftLeg", "RightLeg", "LeftFoot", "RightFoot"];
const ss = x => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };

/**
 * n frames of the rest pose; at(f) -> { turn: { joint: deg }, at: { joint: world point }, shift: [x, y, z] }. A part turns
 * about z by its own deg on top of its ancestors' (so its local turn is exactly its own), at places a joint, shift moves all.
 */
function take(n, at = () => ({}), spec = {}) {
	const frames = Array.from({ length: n }, (_, f) => {
		const { turn = {}, at: place = {}, shift = [0, 0, 0] } = at(f), sum = new Array(sk.names.length).fill(0);
		sk.names.forEach((name, j) => { sum[j] = (sk.parent[j] >= 0 ? sum[sk.parent[j]] : 0) + (turn[name] ?? 0); });
		const R = sk.names.map((_, j) => mul(rz(sum[j]), sk.restWorldRot[j])), P = sk.names.map((name, j) => add(place[name] ?? sk.restWorldPos[j], shift));
		return { s: { P, R } };
	});
	return { frames, fps: 24, ctx: { spec } };
}
// two moves, out (f20) and back (f70): each part turns 30 deg over 20 frames, starting at f20 + lag(part)
const moving = lag => take(120, f => ({ turn: Object.fromEntries(CHAINS.map((j, i) => [j, 30 * (ss((f - 20 - lag(i)) / 20) - ss((f - 70 - lag(i)) / 20))])) }));
const together = observeLife(sk, moving(() => 0), []), staggered = observeLife(sk, moving(i => 3 * i), []);
console.log(`  sync: together ${json(together.sync)}, staggered ${json(staggered.sync)}`);
expect("every part starting and stopping on one frame is synchronous and warned", together.sync[0] === 1 && together.flags?.[0] === "sync" && /start or stop together f/.test(together.warn), json(together));
expect("parts staggered 3 frames apart are not", staggered.sync[0] === 0 && !staggered.flags?.includes("sync"), json(staggered));

const still = take(60, f => ({ shift: [0.01 * Math.sin(f / 5), 0, 0] }));
const grid = observeLife(sk, still, [0, 12, 24, 36, 48].map(f => ({ f, set: { root: [0, 0.9, 0], yaw: f } })));
const loose = observeLife(sk, still, [0, 7, 19, 24, 41, 50].map(f => ({ f, set: { root: [0, 0.9, 0], yaw: f } })));
console.log(`  keys: grid ${json(grid.keys)}, irregular ${json(loose.keys)}`);
expect("keys every half second are flagged (cv 0, every channel even, all on half seconds)", json(grid.keys) === "[0,2,1]" && grid.flags?.includes("keys"), json(grid));
expect("irregular keys are not", loose.keys[0] > 0.3 && loose.keys[1] === 0 && !loose.flags?.includes("keys"), json(loose));

// arms: the elbow bends 0-60 deg and back every 48 frames; mirrored on both sides, or the right a quarter period behind
const arms = shift => take(160, f => {
	const at = {};
	for (const [S, sx, d] of [["Left", 1, 0], ["Right", -1, shift]]) {
		const a = sk.restWorldPos[I[`${S}Arm`]], e = add(a, [0, -0.28, 0]), phi = (Math.PI / 3) * (1 - Math.cos((2 * Math.PI * (f - d)) / 48)) / 2;
		Object.assign(at, { [`${S}ForeArm`]: e, [`${S}Hand`]: add(e, [sx * 0.25 * Math.sin(phi), -0.25 * Math.cos(phi), 0]) });
	}
	return { at };
});
const twin = observeLife(sk, arms(0), []), apart = observeLife(sk, arms(12), []);
console.log(`  arms: mirrored ${json(twin.arms)}, a quarter apart ${json(apart.arms)}`);
expect("arms that bend alike on the same frames twin and are warned", twin.arms[0] === 1 && twin.flags?.[0] === "arms" && /arms mirror f/.test(twin.warn), json(twin));
expect("arms a quarter period apart do not", apart.arms[0] === 0 && !apart.flags?.includes("arms"), json(apart));

// the hips travel 1.2 m over 60 frames: eased throughout, or at constant speed with a dead stop (a seam)
const smooth = observeLife(sk, take(96, f => ({ shift: [1.2 * ss(f / 60), 0, 0.02 * Math.sin(f / 7)] })), []);
const seam = observeLife(sk, take(96, f => ({ shift: [1.2 * Math.min(1, f / 60), 0, 0.02 * Math.sin(f / 7)] })), []);
console.log(`  jerk: eased ${json(smooth.jerk)}, a seam ${json(seam.jerk)}`);
expect("a dead stop at constant speed is a jerk spike at the seam", seam.jerk[2] > 0 && seam.flags?.includes("jerk") && Math.abs(+seam.warn.match(/at f(\d+)/)[1] - 61) <= 2, json(seam));
expect("an eased path has none", smooth.jerk[2] === 0 && !smooth.flags?.includes("jerk"), json(smooth.jerk));

const frozen = observeLife(sk, take(72, f => ({ shift: [f < 24 ? 0.01 * f : 0.24, 0, 0] }), { idle: false }), []);
const swaying = observeLife(sk, take(72, f => ({ shift: [0.01 * Math.sin(f / 4), 0, 0] })), []);
expect("a body frozen 2 s is dead and warned (naming idle false)", frozen.dead[0] > 1.9 && frozen.dead[1] === 25 && frozen.flags?.includes("dead") && /dead still f25-71 \(idle false\)/.test(frozen.warn), json(frozen));
expect("a swaying body is not dead", swaying.dead[0] === 0 && !swaying.flags?.includes("dead"), json(swaying.dead));

// through the pipeline: observations.life rides every compile, as warnings; QA and its verdict are unchanged
const scene = motionScene([]), spec = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 1508, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }],
	keys: Array.from({ length: 63 }, (_, i) => ({ f: 24 * i, set: { spine_yaw: i % 2 ? 15 : -15, aswing_l: i % 2 ? 20 : -20, aswing_r: i % 2 ? 20 : -20 } })) };
const r = compileSpec(spec, { sk, scene }), t0 = performance.now(), again = observeLife(sk, r.out, spec.keys), ms = performance.now() - t0;
console.log(`  pipeline, 1508 frames: life ${json(r.observations.life).length} B in ${ms.toFixed(1)} ms; ${json(r.observations.life)}`);
expect("a compile answers observations.life with its units", r.observations.life && r.observations.units.includes("life (") && json(again) === json(r.observations.life), json(r.observations.life));
expect("one-second keys on both arms at once are flagged (keys, arms), and QA is untouched", r.qa.ok && r.qa.groups.every(g => !/life/i.test(g.kind))
	&& ["keys", "arms"].every(m => r.observations.life.flags?.includes(m)), json([r.qa.groups.map(g => g.kind), r.observations.life]));
expect("the critic is cheap: 1508 frames in under 250 ms and the answer under 400 B", ms < 250 && json(r.observations.life).length < 400, `${ms} ms`);

console.log(failures ? `${failures} motion3 life check(s) failed` : "motion3 life: all checks passed");
process.exit(failures ? 1 : 0);
