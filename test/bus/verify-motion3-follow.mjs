#!/usr/bin/env node
// C16 follow entries (docs/motion-api-v3.1.md): spec.objects[id] = { follow: <ref>, offset?, aim?,
// visible?, level? } puts any record on a point of the body every frame. It validates with exact
// messages; the take bakes a world-space track that matches the ref (and the aim) at every frame;
// object-travel.js draws the record (and the parts of a following group) on it; an exhale emitter
// that follows the mouth births its puffs at the mouth while the head moves; a follow entry is no
// obstacle (no COLLIDE from a body that follows the chest); smokeCigarette args.kit.exhale binds the
// exhale kit with a follow entry (QA 0, the squat of session da8760fa); motion.keyObject refuses it.
import { compileSpec } from "../motion3/fixtures/legacy-compile.mjs";
import { validateSpec } from "../../src/motion3/compiler/validate.js";
import { bakeTake } from "../../src/motion3/take.js";
import { objectTracksOf } from "../../src/motion3/object-tracks.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { refPoint } from "../../src/motion3/refs.js";
import { carried } from "../../src/motion3/compiler/limbs.js";
import { keyObject } from "../../src/motion3/key-edit.js";
import { sceneObjectTravelMatrixAt } from "../../src/object-travel.js";
import { evaluateEffects } from "../../src/effects/simulate.js";
import { normalizeEffect } from "../../src/effects/effect-record.js";
import { buildKit } from "../../src/kits/index.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const refusal = run => { try { run(); return ""; } catch (error) { return error.message; } };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const norm = v => { const l = Math.hypot(...v); return v.map(x => x / l); };
const deg = (a, b) => Math.acos(Math.min(1, Math.max(-1, norm(a).reduce((s, x, i) => s + x * norm(b)[i], 0)))) * 180 / Math.PI;
const upOf = (q, i) => { const [x, y, z, w] = q.subarray(i * 4, i * 4 + 4); return [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)]; };

// A puff emitter (an effect, no box), a lamp, a glowing bead (a body) and a group with a body, a Y Bot at the origin.
const rec = (id, renderer, x, y, z, s, extra = {}) => ({ id, name: id, renderer, x, y, z, rot: 0, rotX: 0, rotZ: 0, scaleX: s[0], scaleY: s[1], scaleZ: s[2], footprint: { width: 1, depth: 1 }, height: 1, ...extra });
const box0 = { footprint: { width: 0, depth: 0 }, height: 0 };
const RECORDS = [
	rec("puff", "effect", 0, 1.5, 0.3, [1, 1, 1], { ...box0, effect: normalizeEffect({ preset: "exhale" }) }),
	rec("lamp", "light", 1, 2, 0, [1, 1, 1], box0),
	rec("bead", "sphere", 0.8, 0, 0.8, [0.12, 0.12, 0.12]),
	rec("crate", "empty", -1, 0, 1, [1, 1, 1], box0), rec("lid", "cube", -1, 0, 1, [0.3, 0.3, 0.3], { parent: "crate" }),
];
const sk = skeletonFor("y-bot-tpose"), scene = motionScene(RECORDS);
// standing, then the head turns and nods and the body sways (a moving mouth)
const head = [{ f: 10, set: { head_yaw: 0, head_pitch: 0, puff_vis: 0 } }, { f: 30, set: { head_yaw: 35, head_pitch: -15, puff_vis: 1 }, step: ["puff_vis"] },
	{ f: 50, set: { head_yaw: -30, head_pitch: 10, spine_pitch: 12 } }, { f: 70, set: { head_yaw: 10, head_pitch: -5, spine_pitch: 0, puff_vis: 0 }, step: ["puff_vis"] }];
const base = (objects, keys = head) => ({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 80, objects, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }], keys });
const plain = objects => { const { use: _use, ...rest } = base(objects, []); return rest; };
const bad = objects => refusal(() => validateSpec(plain(objects), { sk, scene }));

// 1. validation (exact messages)
expect("a follow on a box-less record and on a body validates (refs, a direction, a ref aim, offset)",
	bad({ puff: { follow: "landmark:mouth", aim: "face", offset: [0, 0.01, 0], visible: "puff_vis" }, lamp: { follow: "joint:Head", aim: [0, -1, 0.2] }, bead: { follow: "bone:righthand", aim: "landmark:mouth" } }) === "",
	bad({ puff: { follow: "landmark:mouth" } }));
const unknownBone = bad({ puff: { follow: "joint:Haed" } }), bare = bad({ puff: { follow: "mouth" } });
expect("an unknown bone and a bare name are refused by the ref grammar", unknownBone.includes('objects.puff.follow "joint:Haed": unknown bone; did you mean "Head"?')
	&& bare.includes('objects.puff.follow "mouth" must be joint:<Bone>, bone:<Bone>, prop:<prop>.<point>, anchor:<name>, landmark:mouth, object:<id>[.center|.top|.base|.rim], person:<id>.<Bone>; did you mean "landmark:mouth"?'), `${unknownBone}\n${bare}`);
expect("a bad offset and a bad aim are refused by name", bad({ puff: { follow: "landmark:mouth", offset: [0, 1] } }).includes("objects.puff.offset must be [x, y, z], metres along the record's own axes after aim (+Y along aim), got [0,1]")
	&& bad({ puff: { follow: "landmark:mouth", aim: "forward" } }).includes('objects.puff.aim must be "face", "up", a world direction [x, y, z] or a point ref (toward it), where the record\'s +Y points; got "forward"')
	&& bad({ puff: { follow: "landmark:mouth", aim: [0, 0, 0] } }).includes("objects.puff.aim must be a non-zero world direction [x, y, z], got [0,0,0]"), bad({ puff: { follow: "landmark:mouth", aim: "forward" } }));
expect("an unknown follow field names the follow fields", bad({ puff: { follow: "landmark:mouth", ofset: [0, 0, 0] } }).includes('objects.puff (follow) has unknown field "ofset"; did you mean "offset"?; fields: follow, offset, aim, visible, level'));
expect("a follow of an object a follow entry moves is refused (it would follow itself)",
	bad({ bead: { follow: "object:lid.top" }, crate: { follow: "joint:Head" } }).includes('objects.bead.follow "object:lid.top": "lid" moves with the follow entry objects.crate; a follow entry rides a joint, landmark, prop or anchor point, or an object no follow entry moves'),
	bad({ bead: { follow: "object:lid.top" }, crate: { follow: "joint:Head" } }));
expect("prop makes it a carry, where follow is an unknown field", bad({ bead: { prop: "nope", follow: "joint:Head" } }).includes('objects.bead (carry) has unknown field "follow"'));
expect("an unknown id is refused with the box-less records among the suggestions", bad({ puf: { follow: "landmark:mouth" } }).includes('objects.puf names object "puf", which is not in the scene; did you mean "puff"?'));

// 2. the take: a world-space track on the ref at every frame (+Y along aim), hold on every frame, vis from its channel
const objects = { puff: { follow: "landmark:mouth", aim: "face", visible: "puff_vis" }, lamp: { follow: "joint:Head", offset: [0, 0.3, 0] },
	crate: { follow: "joint:RightHand", aim: "landmark:mouth" }, bead: { follow: "joint:Spine2" } };
const r = compileSpec(base(objects), { sk, scene }), take = bakeTake(sk, r.out), T = take.objects;
let onMouth = 0, faceOff = 0, lampOff = 0, aimOff = 0, moved = 0;
for (let f = 0; f < 80; f++) {
	const mouth = refPoint(r.out, f, "landmark:mouth"), hd = refPoint(r.out, f, "joint:Head"), hand = refPoint(r.out, f, "joint:RightHand");
	const face = carried(sk, r.out.frames[f].s, sk.index.Head, [0, 0, 1]);
	onMouth = Math.max(onMouth, dist(T.puff.pos.subarray(f * 3, f * 3 + 3), mouth));
	faceOff = Math.max(faceOff, deg(upOf(T.puff.quat, f), face));
	lampOff = Math.max(lampOff, dist(T.lamp.pos.subarray(f * 3, f * 3 + 3), [hd[0], hd[1] + 0.3, hd[2]]));
	aimOff = Math.max(aimOff, deg(upOf(T.crate.quat, f), mouth.map((v, i) => v - hand[i])));
	if (f) moved = Math.max(moved, dist(mouth, refPoint(r.out, f - 1, "landmark:mouth")));
}
console.log(`  follow: puff ${(onMouth * 1000).toFixed(3)} mm off the mouth, +Y ${faceOff.toFixed(3)} deg off the face; lamp ${(lampOff * 1000).toFixed(3)} mm; crate +Y ${aimOff.toFixed(3)} deg off hand->mouth; the mouth moves up to ${(moved * 1000).toFixed(1)} mm/frame`);
expect("the follow track is on its ref at every frame (<= 0.01 mm) while the mouth moves", onMouth < 1e-5 && lampOff < 1e-5 && moved > 0.004, `${onMouth} ${lampOff} ${moved}`);
expect("aim: face points +Y along the face, a ref aim toward that point (<= 0.01 deg)", faceOff < 0.01 && aimOff < 0.01, `${faceOff} ${aimOff}`);
expect("the track is world space throughout (hold on every frame) and shows by its channel",
	T.puff.hold.every(v => v === 1) && T.puff.vis[29] === 0 && T.puff.vis[30] === 1 && T.puff.vis[70] === 0 && !T.lamp.vis && T.crate.quat && !T.puff.lvl);
expect("the timeline shows and hides the follow by its channel", ["30 puff show", "70 puff hide"].every(e => r.timeline.flatMap(b => b.events).map(x => `${x.f} ${x.object} ${x.event}`).includes(e)));

// 3. object-travel and the effects see the moving path
const tracks = objectTracksOf({ motionFor: () => take }, [{ id: "c" }]), tk = { frameCount: 80, fps: 24, objectTracks: tracks }, lookup = new Map(RECORDS.map(o => [o.id, o]));
const at = (id, f) => { const e = sceneObjectTravelMatrixAt(lookup, id, f, tk).elements; return [e[12], e[13], e[14]]; };
const lidOff = Math.max(...[20, 40, 60].map(f => dist(at("lid", f), refPoint(r.out, f, "joint:RightHand"))));
expect("the renderer draws the record on the track, and a part of a following group rides its root", dist(at("puff", 45), refPoint(r.out, 45, "landmark:mouth")) < 1e-5 && lidOff < 1e-5, `${lidOff}`);
const births = (records, frame) => {
	const rows = [];
	evaluateEffects(records, { lookup: new Map(records.map(o => [o.id, o])), take: tk, hidden: new Set() }, frame, { particle: p => rows.push({ s: p.s, u: p.u, b: [p.bx, p.by, p.bz] }) });
	return rows;
};
const mouthAt = (s, u) => { const a = refPoint(r.out, s, "landmark:mouth"), b = refPoint(r.out, Math.max(0, s - 1), "landmark:mouth"); return a.map((v, i) => v + (b[i] - v) * u); };
const offMouth = rows => Math.max(0, ...rows.map(p => dist(p.b, mouthAt(p.s, p.u))));
const exact = RECORDS.map(o => (o.id === "puff" ? { ...o, effect: normalizeEffect({ preset: "exhale", area: { x: 0, y: 0, z: 0 } }) } : o));
const sampled = [36, 48, 60, 72].map(f => births(exact, f)), real = [36, 48, 60, 72].map(f => births(RECORDS, f));
const firstS = Math.min(...sampled.flat().map(p => p.s)), lastS = Math.max(...sampled.flat().map(p => p.s));
console.log(`  exhale births: ${sampled.flat().length} particles born f${firstS}..f${lastS}, ${(offMouth(sampled.flat()) * 1000).toFixed(3)} mm from the mouth at their birth (preset area: ${(offMouth(real.flat()) * 1000).toFixed(1)} mm)`);
expect("an exhale emitter that follows the mouth births every puff at the mouth at its birth frame (<= 0.01 mm; the preset's 1 cm birth area: <= 7.1 mm), only while shown",
	sampled.flat().length > 100 && offMouth(sampled.flat()) < 1e-5 && offMouth(real.flat()) <= 0.0071 && firstS >= 30 && lastS <= 69, `${offMouth(sampled.flat())} ${offMouth(real.flat())} f${firstS}..f${lastS}`);

// 4. no obstacle: a body that follows the chest does not collide with the body that carries it
const chest = compileSpec(base({ bead: { follow: "joint:Spine2" } }, []), { sk, scene });
expect("a follow body is no obstacle: no COLLIDE or OBJECT issue names it (a 12 cm bead inside the chest)", !chest.qa.groups.some(g => /bead/.test(g.subject)), chest.qa.groups.map(g => `${g.kind} ${g.subject}`).join(" | "));
expect("motion.keyObject refuses a follow entry", refusal(() => keyObject(base(objects), scene, { objectId: "puff", frame: 40, pos: [0, 1, 0], rot: [0, 0, 0, 1] }))
	.includes('"puff" follows landmark:mouth (spec.objects.puff); it has no keys: change its follow, offset or aim'));

// 5. smokeCigarette args.kit.exhale: the exhale kit follows the mouth (the squat of session da8760fa), QA 0
const cig = buildKit("cigarette", [], { position: { x: 0.6, z: 0.6 } }), lit = buildKit("lighter", cig.records, { position: { x: 0.75, z: 0.6 } });
const ex = buildKit("exhale", [...cig.records, ...lit.records]), kitRecords = [...cig.records, ...lit.records, ...ex.records], kitScene = motionScene(kitRecords);
expect("the exhale kit: an Empty root whose bind is the follow entry, an exhale effect part on it", JSON.stringify(ex.bind) === JSON.stringify({ [ex.rootId]: { follow: "landmark:mouth", aim: "face", visible: "exhale" } })
	&& kitRecords.find(o => o.id === ex.parts.puff)?.effect?.preset === "exhale", JSON.stringify(ex.bind));
const SQUAT = { root: [0, 0.5, -0.08], foot_l: [0.17, 0.087, 0.12], foot_r: [-0.17, 0.087, 0.12], knee_l: [0.5, 0.2, 1], knee_r: [-0.5, 0.2, 1], fyaw_l: 15, fyaw_r: -15, fpitch_l: 10, fpitch_r: 10,
	pitch: 28, spine_pitch: 5, head_pitch: -18, yaw: 0 };
// the session's spec after its repair round (fix.retime)
const smoke = compileSpec({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 265, fix: { retime: true }, keys: [{ f: 0, set: SQUAT }],
	use: [{ skill: "smokeCigarette", f0: 0, args: { kit: { cig: cig.rootId, lighter: lit.rootId, exhale: ex.rootId } } }] }, { sk, scene: kitScene });
expect("args.kit.exhale adds { follow: landmark:mouth, aim: face, visible: exhale } for the exhale kit, and the squat stays at QA 0",
	JSON.stringify(smoke.expanded.objects[ex.rootId]) === JSON.stringify({ follow: "landmark:mouth", aim: "face", visible: "exhale" }) && smoke.qa.ok, JSON.stringify([smoke.expanded.objects[ex.rootId], smoke.qa.groups.slice(0, 2)]));
const st = bakeTake(sk, smoke.out), stk = { frameCount: 265, fps: 24, objectTracks: objectTracksOf({ motionFor: () => st }, [{ id: "c" }]) };
const kitLookup = new Map(kitRecords.map(o => [o.id, o])), puffs = [];
for (const f of [125, 133, 247, 255]) evaluateEffects(kitRecords, { lookup: kitLookup, take: stk, hidden: new Set() }, f, { only: ex.parts.puff, particle: (p, em) => em.id === ex.parts.puff && puffs.push({ s: p.s, u: p.u, b: [p.bx, p.by, p.bz] }) });
const kitMouth = (s, u) => { const a = refPoint(smoke.out, s, "landmark:mouth"), b = refPoint(smoke.out, s - 1, "landmark:mouth"); return a.map((v, i) => v + (b[i] - v) * u); };
const kitOff = puffs.map(p => dist(p.b, kitMouth(p.s, p.u))), face = carried(sk, smoke.out.frames[126].s, sk.index.Head, [0, 0, 1]), shown = st.objects[ex.rootId].vis;
console.log(`  squat smoke: ${puffs.length} exhale puffs, birth to mouth max ${(Math.max(...kitOff) * 1000).toFixed(1)} mm, mean ${(kitOff.reduce((a, b) => a + b, 0) / kitOff.length * 1000).toFixed(1)} mm; the face points [${face.map(v => v.toFixed(2))}] at f126`);
expect("the squat's exhale puffs are born at the mouth (<= 7.1 mm, the preset's birth area), only on frames the exhale channel shows it",
	puffs.length > 100 && Math.max(...kitOff) <= 0.0071 && puffs.every(p => shown[p.s] === 1), `${puffs.length} ${Math.max(...kitOff)}`);

if (failures) { console.error(`${failures} motion3 follow check(s) failed`); process.exit(1); }
console.log("motion3 follow entries: all checks passed");
