#!/usr/bin/env node
// #452: verification measures installed takes, not a private install candidate.
// Generation/repair/cancel/history contracts are exercised by test/bus/motion*.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { primeBindPose } from '../src/poses.js';
import { createIkState } from '../src/motion/ik.js';
import { compileTakeSource } from '../src/domains/motion/take-source.js';
import { skeletonFor } from '../src/motion3/rigs/index.js';
import { createSceneObject } from '../src/scene-objects.js';
import { verifyInstalledTake } from '../src/studio-agent-motion.js';
import { createCharacterEntry, PROXY_FIGURE_MODEL } from '../src/scenes.js';

function rigFixture() {
  const bytes = readFileSync(new URL('../public/models/y-bot-tpose.fbx', import.meta.url));
  const rig = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  rig.scale.setScalar(.01); primeBindPose(rig); rig.updateMatrixWorld(true); return rig;
}
// A compiled take v3 (Y Bot): standing, optionally lifted off the floor or
// sliding along +Z over the take.
function clipFixture({ frames = 48, hover = 0, travel = 0 } = {}) {
  const sk = skeletonFor('y-bot-tpose'), I = sk.index, P = sk.restWorldPos, ank = P[I.LeftFoot][1], hips = P[I.Hips][1] - .01;
  const at = z => ({ root: [0, hips + hover, z], yaw: 0, foot_l: [.09, ank + hover, z - .03], foot_r: [-.09, ank + hover, z + .03] });
  const spec = { schema: 'cozyclay.motion-spec.v1', fps: 24, frames, keys: [{ f: 0, set: at(0) }, { f: frames - 1, set: at(travel) }] };
  return compileTakeSource({ schema: 'cozyclay.take.v3', rig: 'y-bot-tpose', spec, placement: { position: [0, 0, 0], yaw: 0 }, scene: { objects: {} } });
}
const bones = rig => { const rows = []; rig.traverse(n => { if (n.isBone) rows.push([...n.position.toArray(), ...n.quaternion.toArray(), ...n.scale.toArray()]); }); return rows; };
function fixture(options = {}) {
  const target = { character: { id: 'actor', x: 0, y: 0, z: 0, rot: 0, scale: 1 }, rig: rigFixture(), motion: clipFixture(options), ikState: createIkState() };
  // One capsule figure stands in the set: it has no rig, so verification must
  // skip it rather than count it as missing cast coverage.
  const proxy = { character: createCharacterEntry({ id: 'proxy', model: PROXY_FIGURE_MODEL, x: 3, z: 0 }), rig: null, motion: null, ikState: createIkState() };
  const environment = { host: { workspaceId: 'w', documentEpoch: 'd', sceneId: 's', sceneEpoch: 'e' }, physicsRevision: 1, floor: { model: 'flat', y: 0 }, objects: [], cast: [proxy], frameCount: target.motion.frames };
  const verify = extra => verifyInstalledTake({ target, environment, yieldTask: () => Promise.resolve(), ...extra });
  return { target, environment, verify };
}
for (const hover of [0, .4]) test(`installed take: full/ranged verification preserves visible rig and authored keys (hover ${hover})`, async () => {
  const f = fixture({ hover }), before = bones(f.target.rig), keys = structuredClone(f.target.ikState.keys);
  const whole = await f.verify();
  assert.equal(whole.status, hover ? 'unverified' : 'verified');
  assert.equal(whole.evaluatedFrames, 48); assert.equal(whole.characterId, 'actor');
  assert.equal(whole.surfaceMeasured, true); assert.equal(whole.unsupportedFrames, hover ? 48 : 0);
  assert.equal(whole.profile, 'studio-motion-v1'); assert.equal(whole.semanticStatus, 'unavailable');
  const part = await f.verify({ range: { startFrame: 12, endFrameExclusive: 36 } });
  assert.deepEqual(part.range, { startFrame: 12, endFrameExclusive: 36 }); assert.equal(part.evaluatedFrames, 24);
  assert.equal(part.unsupportedFrames, hover ? 24 : 0); assert.notEqual(part.id, whole.id);
  assert.deepEqual(bones(f.target.rig), before); assert.deepEqual(f.target.ikState.keys, keys);
  assert(Object.isFrozen(whole));
  assert(!whole.limitations.includes('other-cast-evaluation-incomplete'));
});
test('installed take: missing skin and unsupported support cannot be certified', async () => {
  const f = fixture(), meshes = [];
  f.target.rig.traverse(n => { if (n.isSkinnedMesh) meshes.push(n); });
  for (const mesh of meshes) mesh.removeFromParent();
  const v = await f.verify(); assert.equal(v.status, 'unverified'); assert.equal(v.surfaceMeasured, false);
  const platform = fixture(); platform.target.character.y = .5; platform.target.rig.position.y = .5;
  platform.environment.objects = [{ ...createSceneObject('cube'), scaleX: 3, scaleY: .5, scaleZ: 3 }];
  assert.equal((await platform.verify()).status, 'unverified');
});
test('installed take: every verification measures current floor inputs, independent of key order', async () => {
  const f = fixture(); assert.equal((await f.verify()).status, 'verified');
  f.environment.floor = { y: .3, model: 'flat' }; f.environment.physicsRevision++;
  const changed = await f.verify(); assert.equal(changed.physicsRevision, 2); assert(changed.maxFloorPenetrationM > .2);
  f.environment.floor = { model: 'flat', y: .3 };
  const { id, ...again } = await f.verify(), { id: previous, ...expected } = changed;
  assert.notEqual(id, previous); assert.deepEqual(again, expected);
});
test('installed take: moving props and other cast are sampled off the playhead without posing visible rigs', async () => {
  const f = fixture();
  // The take stands with its arms down, so the moving prop sweeps through the shins.
  f.environment.objects = [{ ...createSceneObject('cube'), scaleX: .2, scaleY: .3, scaleZ: .2, y: .3,
    path: { points: [{ x: .1, y: .3, z: -2 }, { x: .1, y: .3, z: 2 }], speed: 0, faceTravel: false, loop: false, extend: false, timing: null } }];
  assert.equal((await f.verify({ range: { startFrame: 0, endFrameExclusive: 1 } })).supportedCollisionFrames, 0);
  assert((await f.verify()).supportedCollisionFrames > 0);
  f.environment.objects = [];
  const other = rigFixture(); other.position.z = -2; other.updateMatrixWorld(true); const before = bones(other);
  f.environment.cast = [{ character: { id: 'other', hidden: false }, rig: other, motion: clipFixture({ travel: 4 }), ikState: createIkState() }];
  assert((await f.verify()).supportedCollisionFrames > 0); assert.deepEqual(bones(other), before);
  f.environment.cast[0].rig = null; assert.equal((await f.verify()).status, 'unverified');
});
test('installed take: objects the take animates are measured where the take puts them (#868)', async () => {
  // A free-object track (take.v3 objects[id], world space) holding the cube at `x` every frame.
  const tracked = (f, x) => {
    const F = f.target.motion.frames, pos = new Float32Array(F * 3), quat = new Float32Array(F * 4);
    for (let i = 0; i < F; i++) { pos[i * 3] = x; quat[i * 4 + 3] = 1; }
    f.target.motion = { ...f.target.motion, objects: { cube: { pos, quat } } };
  };
  const into = fixture(); into.environment.objects = [{ ...createSceneObject('cube'), id: 'cube', x: 3 }]; tracked(into, 0);
  const hit = await into.verify();
  assert(hit.supportedCollisionFrames > 0); assert.equal(hit.status, 'unverified');
  const away = fixture(); away.environment.objects = [{ ...createSceneObject('cube'), id: 'cube', x: 0 }]; tracked(away, 3);
  const clear = await away.verify();
  assert.equal(clear.supportedCollisionFrames, 0); assert.equal(clear.status, 'verified');
});
test('installed take: authored IK continuity and protected poses remain verification inputs', async () => {
  const f = fixture(), before = bones(f.target.rig);
  f.target.ikState.keys.set(23, new Map([['hips', { p: new THREE.Vector3(0, 160, 0), q: [new THREE.Quaternion()] }]]));
  f.target.ikState.tracked.add('hips'); f.target.protectedFrames = [24];
  const v = await f.verify(); assert.equal(v.status, 'unverified');
  assert.deepEqual(bones(f.target.rig), before); assert(f.target.ikState.keys.has(23));
});
test('installed take: missing take/rig, invalid range and evaluation deadline refuse without mutation', async () => {
  const f = fixture(), before = bones(f.target.rig);
  await assert.rejects(f.verify({ target: { ...f.target, motion: null } }), { code: 'TARGET_NOT_READY' });
  await assert.rejects(f.verify({ target: { ...f.target, rig: null } }), { code: 'TARGET_NOT_READY' });
  await assert.rejects(f.verify({ range: { startFrame: 48, endFrameExclusive: 60 } }), { code: 'INVALID_RANGE' });
  let now = 0;
  await assert.rejects(f.verify({ now: () => now, verificationMs: 1, yieldTask: async () => { now = 3; } }), { code: 'VERIFICATION_FAILED' });
  assert.deepEqual(bones(f.target.rig), before);
  const long = fixture({ frames: 240 }); let clock = 0;
  assert.equal((await long.verify({ now: () => clock, verificationMs: 1, yieldTask: async () => { clock = 5; } })).evaluatedFrames, 240);
});
