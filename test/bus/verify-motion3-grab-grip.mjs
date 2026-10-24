// The carrying hand's own grip (compiler/grip.js ownGrip): a keyed carry of a body that is not thin takes the
// grip on the reach and on its grab frame, so the grab offset the carry keeps is a grip; a thin body (a cup) takes
// the grip chosen over its keyed path instead (grip-choice.js). Two agent takes of the interaction bench
// (pred-r1 S10 and S8) compiled with the grip on and with orient: false on every reachGrip.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { compileSpec } from '../../src/motion3/pipeline.js';
import { skeletonFor } from '../../src/motion3/rigs/index.js';
import { motionScene } from '../../src/motion3/scene.js';

const sk = skeletonFor('y-bot-tpose');
const load = name => JSON.parse(readFileSync(new URL(`../fixtures/grab-grip/${name}.json`, import.meta.url), 'utf8'));
const withoutGrip = spec => ({ ...spec, use: spec.use.map(u => (u.skill === 'reachGrip' ? { ...u, args: { ...u.args, orient: false } } : u)) });
const compile = ({ spec, objects }) => compileSpec({ fps: 24, ...spec }, { sk, scene: motionScene(objects) });

test('a two-hand box carry: the carrying hand grips at the grab and its wrist stays comfortable on more frames', () => {
	const fx = load('box-two-hands'), on = compile(fx), off = compile({ ...fx, spec: withoutGrip(fx.spec) });
	const w = r => r.observations.wrist?.hand_r ?? { past: 0, limit: 0 };
	assert.ok(w(on).past < w(off).past, `past-comfort frames ${w(off).past} -> ${w(on).past}`);
	assert.ok(w(on).limit <= w(off).limit, `at-limit frames ${w(off).limit} -> ${w(on).limit}`);
	assert.ok(on.qa.total <= off.qa.total + 1, `QA ${off.qa.total} -> ${on.qa.total}`);
	// the reach and the grab frame turn the hand; the box, keyed from the grab, follows that grip
	const grab = fx.spec.objects.box.grab, I = sk.index.RightHand;
	const turn = (a, b) => Math.max(...a.out.frames[grab].s.R[I].flat().map((v, i) => Math.abs(v - b.out.frames[grab].s.R[I].flat()[i])));
	assert.ok(turn(on, off) > 0.05, 'the grab frame takes the grip');
});

// lean 0 on the aim keys holds them exactly: a key at the lips otherwise leans (face-lean.js), and the grip needs no choosing
const exactly = spec => ({ ...spec, objects: Object.fromEntries(Object.entries(spec.objects).map(([id, o]) => [id, { ...o, keys: o.keys.map(k => (k.aim ? { lean: 0, ...k } : k)) }])) });
test('a thin carry (a cup to the mouth) keeps the grip chosen over its keyed path (grip-choice.js), not the neutral grab offset', () => {
	const cup = load('cup-to-mouth'), fx = { ...cup, spec: exactly(cup.spec) }, on = compile(fx), off = compile({ ...fx, spec: withoutGrip(fx.spec) });
	const w = r => r.observations.wrist?.hand_r ?? { past: 0, limit: 0 };
	assert.ok(w(on).past < w(off).past, `past-comfort frames ${w(off).past} -> ${w(on).past}`);
	assert.ok(on.qa.total <= off.qa.total, `QA ${off.qa.total} -> ${on.qa.total}`);
	assert.notEqual(w(on).grip?.chose ?? 'today', 'today', JSON.stringify(w(on).grip));
});
