// The grip a keyed carry of a thin body keeps (grip-choice.js, C18): chosen over the carry's keyed path, so a cup taken
// from a counter to the mouth and back is held with the wrist in its comfortable range on more frames than with the grab
// frame's neutral grip; the choice is reported in observations.wrist; the spec wins (along, orient: false); a box keeps
// its own grip (grip.js); the same spec chooses the same grip; the hand comes into and out of it without a pop.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileSpec } from '../../src/motion3/pipeline.js';
import { skeletonFor } from '../../src/motion3/rigs/index.js';
import { motionScene } from '../../src/motion3/scene.js';

const sk = skeletonFor('y-bot-tpose');
const box = (id, renderer, [x, y, z], [sx, sy, sz], parent = null) => ({ id, name: id, renderer, x, y, z, rot: 0, rotX: 0, rotZ: 0, scaleX: sx, scaleY: sy, scaleZ: sz, color: '#888888', parent });
const counter = [box('counter', 'empty', [0, 0, 0.4], [1, 1, 1]), box('counter-top', 'cube', [0, 0.91, 0.4], [0.9, 0.04, 0.5], 'counter'),
	...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b], i) => box(`leg-${i}`, 'cylinder', [a * 0.4, 0, 0.4 + b * 0.2], [0.04, 0.91, 0.04], 'counter'))];
const rest = [-0.16, 0.95, 0.3], mouth = [-0.03, 1.48, 0.22], near = [-0.05, 1.44, 0.25], up = [-0.14, 1.25, 0.25];
// lean 0 holds the keys at the lips exactly (they otherwise lean, face-lean.js): the grip is what is measured here
const spec = (cupArgs = {}, gripArgs = {}) => ({
	schema: 'cozyclay.motion-spec.v1', fps: 24, frames: 170,
	use: [{ skill: 'standIdle', f0: 0, args: { at: [0, 0], heading: 0 } }, { skill: 'reachGrip', f0: 12, args: { anchor: 'obj', side: 'r', reach: 22, hold: 104, release: 16, define: { kind: 'object', object: 'obj', local: [0, 0.055, 0] }, ...gripArgs } }],
	objects: { obj: { prop: 'objGrip', grab: 34, release: 138, keys: [{ f: 34, pos: rest, aim: [0, 1, 0] }, { f: 48, pos: up, aim: [0, 1, 0] }, { f: 66, pos: near, aim: [0, 0.97, -0.25], lean: 0 },
		{ f: 78, pos: mouth, aim: [0, 0.8, -0.6], lean: 0 }, { f: 96, pos: mouth, aim: [0, 0.75, -0.66], lean: 0 }, { f: 108, pos: near, aim: [0, 0.97, -0.25], lean: 0 }, { f: 124, pos: up, aim: [0, 1, 0] }, { f: 138, pos: rest, aim: [0, 1, 0] }], ...cupArgs } },
});
const cup = (shape = [0.08, 0.1, 0.08]) => [...counter, box('obj', 'cylinder', rest, shape)];
const compile = (s, objects = cup()) => compileSpec(s, { sk, scene: motionScene(objects) });
const wrist = r => r.observations.wrist?.hand_r ?? { past: 0, limit: 0 };

test('a cup to the mouth and back: the chosen grip keeps the wrist comfortable on more frames, QA no worse, the choice reported', () => {
	const on = compile(spec()), off = compile(spec({}, { orient: false }));
	assert.ok(wrist(on).past < wrist(off).past, `past-comfort frames ${wrist(off).past} -> ${wrist(on).past}`);
	assert.ok(on.qa.total <= off.qa.total, `QA ${off.qa.total} -> ${on.qa.total}`);
	const grip = wrist(on).grip;
	assert.equal(grip?.object, 'obj');
	assert.notEqual(grip.chose, 'today', JSON.stringify(grip));
	assert.ok(grip.cost[0] < grip.cost[1], 'the chosen grip costs less than the grab frame\'s');
	assert.ok(!on.qa.groups.some(g => g.kind === 'POP'), JSON.stringify(on.qa.groups.filter(g => g.kind === 'POP')));
});

test('the spec wins: along on the carry or orient: false on the fit keeps the grab offset as given', () => {
	assert.equal(wrist(compile(spec({ along: [0, 1, 0] }))).grip, undefined);
	assert.equal(wrist(compile(spec({}, { orient: false }))).grip, undefined);
});

test('a box (not thin) keeps the grip grip.js gives it at the grab: no path choice', () => {
	assert.equal(wrist(compile(spec(), cup([0.3, 0.2, 0.25]))).grip, undefined);
});

test('the same spec chooses the same grip', () => {
	const a = compile(spec()), b = compile(spec()), I = sk.index.RightHand;
	assert.deepEqual(wrist(a).grip, wrist(b).grip);
	assert.deepEqual(a.out.frames[80].s.R[I], b.out.frames[80].s.R[I]);
});
