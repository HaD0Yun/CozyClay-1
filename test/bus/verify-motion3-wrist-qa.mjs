// QA WRIST (qa/wrist-checks.js): a holding wrist past its anatomical limit is a QA group, its hint moves the
// body, and repair's lean (repair-tune.js) frees it. The agent take of the interaction bench baseline-r1/S6:
// standing tall, the hand reaches low into the vending tray and the carried can bends the wrist 72 deg (limit 70).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { compileSpec } from '../../src/motion3/pipeline.js';
import { skeletonFor } from '../../src/motion3/rigs/index.js';
import { motionScene } from '../../src/motion3/scene.js';
import { tuneCandidates } from '../../src/motion3/repair-tune.js';
import { applyPatch } from '../../src/motion3/json-patch.js';

const sk = skeletonFor('y-bot-tpose');
const fx = JSON.parse(readFileSync(new URL('../fixtures/wrist-limit/vending-can.json', import.meta.url), 'utf8'));
// the take as the bench compiled it: the can held by its grab-frame offset (fix.grasp false; seated in the hand, #816,
// it bends the wrist 74 deg), so these pins measure the wrist rule and its repair, not where the can rests
// and its aim keys held exactly (lean 0: the key at the lips would lean, face-lean.js, and free the wrist)
const exactly = spec => ({ ...spec, objects: Object.fromEntries(Object.entries(spec.objects ?? {}).map(([id, o]) => [id, o.keys ? { ...o, keys: o.keys.map(k => (k.aim && k.roll === undefined ? { lean: 0, ...k } : k)) } : o])) });
const scene = motionScene(fx.objects), compile = spec => compileSpec({ fps: 24, ...exactly(spec), fix: { ...spec.fix, grasp: false } }, { sk, scene });
const wristOf = r => r.qa.groups.filter(g => g.kind === 'WRIST');
const before = compile(fx.spec);

test('the can lifted out of the tray: WRIST hand_r flex 72deg (limit 70) on 4 frames, a body-move hint, no patch', () => {
	const [g, ...more] = wristOf(before);
	assert.equal(more.length, 0);
	assert.equal(g.subject, 'hand_r flex 72deg (limit 70)');
	assert.ok(g.count === 4 && g.first === 89 && g.limit === 70, JSON.stringify(g));
	assert.equal(g.cause, 'objects.can.keys near f90');
	assert.match(g.hint, /lean the upper body over the hand \(spine_pitch 0 at f90: try 20\)/);
	assert.equal(g.patch, undefined);
	assert.equal(before.observations.wrist.hand_r.limit, 4);
});

test('repair\'s 20 deg lean at f90 frees the wrist on 3 of its 4 frames; QA drops by 3 and every goal holds', () => {
	const g = wristOf(before)[0], cands = tuneCandidates(g, fx.spec);
	const lean = cands.find(p => p.length === 1 && p[0].op === 'add' && p[0].value.f === 90 && p[0].value.set.spine_pitch === 20);
	assert.ok(lean, JSON.stringify(cands.slice(0, 4)));
	const after = compile(applyPatch(fx.spec, lean)), left = wristOf(after);
	assert.ok(left.length === 1 && left[0].count === 1 && left[0].first === 186, JSON.stringify(left));
	assert.equal(after.qa.total, before.qa.total - 3);
	assert.ok(after.qa.goals.every(r => r.ok));
	// past the comfortable range only stays an observation
	assert.ok(after.observations.wrist.hand_r.past > 0 && after.observations.wrist.hand_r.limit === 1, JSON.stringify(after.observations.wrist));
});

test('a wrist fix.self bent gets no lean to try: a lean does not undo the elbow turn', () => {
	assert.deepEqual(tuneCandidates({ kind: 'WRIST', cause: 'fix.self elbow turn -77deg at f630', worstFrame: 630, count: 88, worst: 57, limit: 20 }, fx.spec), []);
});
