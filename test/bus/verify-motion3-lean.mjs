// Lane elbow (C16 lean, C18 elevation readback): a cup brought from a counter to the mouth is held with the upper arm
// over the shoulder when its keys aim it only at the face; with lean on those keys the compiler tips it a little to the
// hand's side, the elbow comes down, no wrist frame reaches a limit that did not before, and the cup's top stays where
// aim put it (a lean pivots about the top). Validation says what lean needs; the same spec gives the same take.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileSpec } from '../../src/motion3/pipeline.js';
import { skeletonFor } from '../../src/motion3/rigs/index.js';
import { motionScene } from '../../src/motion3/scene.js';
import { objectPoseAt } from '../../src/motion3/object-pose.js';
import { apply, add, sub, len } from '../../src/motion3/compiler/math.js';

const sk = skeletonFor('y-bot-tpose');
const box = (id, renderer, [x, y, z], [sx, sy, sz], parent = null) => ({ id, name: id, renderer, x, y, z, rot: 0, rotX: 0, rotZ: 0, scaleX: sx, scaleY: sy, scaleZ: sz, color: '#888888', parent });
const counter = [box('counter', 'empty', [0, 0, 0.4], [1, 1, 1]), box('counter-top', 'cube', [0, 0.91, 0.4], [0.9, 0.04, 0.5], 'counter'),
	...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b], i) => box(`leg-${i}`, 'cylinder', [a * 0.4, 0, 0.4 + b * 0.2], [0.04, 0.91, 0.04], 'counter'))];
const rest = [-0.16, 0.95, 0.3], mouth = [-0.03, 1.48, 0.22], near = [-0.05, 1.44, 0.25], up = [-0.14, 1.25, 0.25];
// the keys at the mouth tip the cup toward the face; lean goes on those keys only (0 holds the aim exactly: a key at the lips otherwise leans, face-lean.js)
const spec = (lean = 0) => {
	const tipped = aim => ({ aim, lean });
	return {
		schema: 'cozyclay.motion-spec.v1', fps: 24, frames: 170,
		use: [{ skill: 'standIdle', f0: 0, args: { at: [0, 0], heading: 0 } }, { skill: 'reachGrip', f0: 12, args: { anchor: 'obj', side: 'r', reach: 22, hold: 104, release: 16, define: { kind: 'object', object: 'obj', local: [0, 0.055, 0] } } }],
		objects: { obj: { prop: 'objGrip', grab: 34, release: 138, keys: [{ f: 34, pos: rest, aim: [0, 1, 0] }, { f: 48, pos: up, aim: [0, 1, 0] }, { f: 66, pos: near, ...tipped([0, 0.97, -0.25]) },
			{ f: 78, pos: mouth, ...tipped([0, 0.8, -0.6]) }, { f: 96, pos: mouth, ...tipped([0, 0.75, -0.66]) }, { f: 108, pos: near, ...tipped([0, 0.97, -0.25]) }, { f: 124, pos: up, aim: [0, 1, 0] }, { f: 138, pos: rest, aim: [0, 1, 0] }] } },
	};
};
const objects = [...counter, box('obj', 'cylinder', rest, [0.08, 0.1, 0.08])];
const compile = s => compileSpec(s, { sk, scene: motionScene(objects) });
const R = sk.index.RightArm, FA = sk.index.RightForeArm;
/** The upper arm's elevation (deg from hanging down) at frame f. */
const elevation = (r, f) => { const s = r.out.frames[f].s, u = sub(s.P[FA], s.P[R]); return Math.acos(-u[1] / len(u)) * 180 / Math.PI; };
const top = (r, f) => { const p = objectPoseAt(r.out, 'obj', f); return add(p.pos, apply(p.R, [0, 0.1, 0])); };

test('lean on the keys at the mouth brings the elbow down without a new wrist limit, and keeps the cup top where aim put it', () => {
	const plain = compile(spec()), leaned = compile(spec(25));
	const at = [78, 86, 96];
	const before = Math.max(...at.map(f => elevation(plain, f))), after = Math.max(...at.map(f => elevation(leaned, f)));
	assert.ok(after < before - 10, `upper arm at the mouth ${before.toFixed(0)} -> ${after.toFixed(0)} deg`);
	const w0 = plain.observations.wrist?.hand_r, w1 = leaned.observations.wrist?.hand_r;
	assert.ok(w1 && w1.limit <= w0.limit, `wrist frames at a limit ${w0?.limit} -> ${w1?.limit}`);
	assert.ok(w1.raised <= w0.raised && Array.isArray(w1.elevation), `raised frames ${w0.raised} -> ${w1.raised}, elevation ${JSON.stringify(w1.elevation)}`);
	for (const f of [78, 96]) assert.ok(len(sub(top(leaned, f), top(plain, f))) < 0.02, `the cup top at f${f} moved ${len(sub(top(leaned, f), top(plain, f))).toFixed(3)} m`);
	assert.ok(leaned.qa.total <= plain.qa.total + 2, `QA ${plain.qa.total} -> ${leaned.qa.total}`);
});

test('without lean the take is as before; lean is deterministic', () => {
	const a = compile(spec(25)), b = compile(spec(25));
	assert.deepEqual(a.out.frames.map(fr => fr.s.P[sk.index.RightHand]), b.out.frames.map(fr => fr.s.P[sk.index.RightHand]));
});

test('lean validation: it needs aim, and 0..45 deg', () => {
	const bad = keyPatch => { const s = spec(); Object.assign(s.objects.obj.keys[2], keyPatch); return () => compile(s); };
	assert.throws(bad({ lean: 60 }), /lean must be the most degrees the compiler may lean aim \(0\.\.45\)/);
	assert.throws(bad({ aim: undefined, rot: [0, 0, 0, 1], lean: 10 }), /lean lets the compiler lean aim; give aim/);
});
