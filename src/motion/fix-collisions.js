import * as THREE from "three";
import {
	findBone,
	measureContactRadii,
	hasBindPose,
	bindWorldPosition,
	restWorldPosition,
} from "./ik.js";

/**
 * Body-collision DETECTION: capsule proxies per body segment (bone → child
 * bone axis, radius measured from the bind-pose skinned mesh by
 * measureContactRadii) and the penetrations between them and external
 * blockers. Read-only: motion verification (studio-agent-motion.js) and the
 * collision blockers build on it. The 2.x solver that pushed limbs apart was
 * removed with ARDY; motion3 QA (src/motion3/qa) reports collisions for
 * compiled takes.
 *
 * Torso/head capsules are static; limb capsules name the IK chain they ride.
 */

/**
 * Body capsules. `movable.chain`/`movable.joint` name the IK chain and the
 * joint of that chain to drive ("mid" = elbow/knee, "effector" = wrist/
 * ankle). Torso, chest and head have no chain: they are blockers the limbs
 * get pushed out of. `radiusJoint` keys into the measured contact radii.
 *
 * `endOptional` marks an end bone the rig is allowed not to have: the hands
 * span wrist → middle-finger base so a fingertip driven into a thigh is
 * judged at the FINGERS, not at the wrist a palm's length behind them (a
 * wrist-only sphere reads that pose as clean). Rigs exported without finger
 * bones simply fall back to the wrist sphere instead of disqualifying the
 * whole tool.
 */
// `maxRadius` caps the measured radius where the mesh extent is not a
// thickness: the head measurement runs crown-to-chin (a length), the foot
// measurement follows the toe (also a length). Uncapped, those fat capsules
// flag permanent false contacts with the torso and with the other foot at
// any normal stance.
const CAPSULE_DEFS = [
	{ id: "torso", start: "mixamorigHips", end: "mixamorigSpine1", radiusJoint: "Spine", maxRadius: 0.17, movable: null },
	{ id: "chest", start: "mixamorigSpine1", end: "mixamorigSpine2", radiusJoint: "Spine", maxRadius: 0.16, movable: null },
	{ id: "head", start: "mixamorigNeck", end: "mixamorigHead", radiusJoint: "Head", maxRadius: 0.11, movable: null },
	{ id: "leftUpperArm", start: "mixamorigLeftArm", end: "mixamorigLeftForeArm", radiusJoint: "LeftArm", movable: { chain: "leftHand", joint: "mid" }, priority: 2 },
	{ id: "leftForeArm", start: "mixamorigLeftForeArm", end: "mixamorigLeftHand", radiusJoint: "LeftForeArm", movable: { chain: "leftHand", joint: "effector" }, priority: 2 },
	{ id: "leftHand", start: "mixamorigLeftHand", end: "mixamorigLeftHandMiddle1", endOptional: true, radiusJoint: "LeftHand", maxRadius: 0.06, movable: { chain: "leftHand", joint: "effector" }, priority: 2 },
	{ id: "rightUpperArm", start: "mixamorigRightArm", end: "mixamorigRightForeArm", radiusJoint: "RightArm", movable: { chain: "rightHand", joint: "mid" }, priority: 2 },
	{ id: "rightForeArm", start: "mixamorigRightForeArm", end: "mixamorigRightHand", radiusJoint: "RightForeArm", movable: { chain: "rightHand", joint: "effector" }, priority: 2 },
	{ id: "rightHand", start: "mixamorigRightHand", end: "mixamorigRightHandMiddle1", endOptional: true, radiusJoint: "RightHand", maxRadius: 0.06, movable: { chain: "rightHand", joint: "effector" }, priority: 2 },
	{ id: "leftThigh", start: "mixamorigLeftUpLeg", end: "mixamorigLeftLeg", radiusJoint: "LeftUpLeg", movable: { chain: "leftFoot", joint: "mid" }, priority: 1 },
	{ id: "leftShin", start: "mixamorigLeftLeg", end: "mixamorigLeftFoot", radiusJoint: "LeftLeg", movable: { chain: "leftFoot", joint: "effector" }, priority: 1 },
	{ id: "leftFoot", start: "mixamorigLeftFoot", end: "mixamorigLeftToeBase", radiusJoint: "LeftFoot", maxRadius: 0.07, movable: { chain: "leftFoot", joint: "effector" }, priority: 1 },
	{ id: "rightThigh", start: "mixamorigRightUpLeg", end: "mixamorigRightLeg", radiusJoint: "RightUpLeg", movable: { chain: "rightFoot", joint: "mid" }, priority: 1 },
	{ id: "rightShin", start: "mixamorigRightLeg", end: "mixamorigRightFoot", radiusJoint: "RightLeg", movable: { chain: "rightFoot", joint: "effector" }, priority: 1 },
	{ id: "rightFoot", start: "mixamorigRightFoot", end: "mixamorigRightToeBase", radiusJoint: "RightFoot", maxRadius: 0.07, movable: { chain: "rightFoot", joint: "effector" }, priority: 1 },
];

/**
 * FINGER CAPSULES. The hand capsule spans wrist → middle-finger base, which is
 * a palm: it still reads a pose where the FINGERS are buried in a thigh and the
 * palm is not as clean, because the fingers stick out another 8 cm past its end
 * cap. Mixamo hands carry mixamorig{Side}Hand{Finger}1..4, so each finger gets
 * its own thin capsule from the base joint to the tip.
 *
 * OPTIONAL, ONE FINGER AT A TIME. Game rigs ship every mixture of these bones:
 * all four joints, three, a thumb only, none at all. A finger falls back from
 * 1→4 to 1→3 and, failing both, is simply left out — `optional` means a MISSING
 * finger is not a missing capsule but a missing entry, so a fingerless rig is
 * still fully supported (supportsCollisionCleanup ignores optional defs) and
 * every other proxy is built exactly as before.
 *
 * RADIUS is a constant. measureContactRadii's CONTACT_JOINTS carry no finger
 * entries — there is nothing to look up — and a finger is the one body part
 * whose thickness barely varies between characters.
 */
export const FINGER_RADIUS = 0.011;

const FINGER_NAMES = ["Thumb", "Index", "Middle", "Ring", "Pinky"];

for (const side of ["Left", "Right"]) {
	const lower = side === "Left" ? "left" : "right";
	for (const finger of FINGER_NAMES) {
		CAPSULE_DEFS.push({
			id: `${lower}Hand${finger}`,
			start: `mixamorig${side}Hand${finger}1`,
			// First spelling that resolves wins: the tip, else the last knuckle.
			ends: [`mixamorig${side}Hand${finger}4`, `mixamorig${side}Hand${finger}3`],
			optional: true,
			fixedRadius: FINGER_RADIUS,
			// The two ids a finger must never be tested against beyond its own
			// kind — see pairExcluded.
			handId: `${lower}Hand`,
			foreArmId: `${lower}ForeArm`,
			movable: { chain: `${lower}Hand`, joint: "effector" },
			priority: 2,
		});
	}
}

/** Fallback radius when no measurement exists (matches ik.js's floor). */
const RADIUS_FALLBACK = 0.01;

/** Soft-tissue compression allowance, as a fraction of the thinner capsule.
 * See detectPenetrations for why this is 0.25 and not something roomier. */
export const DEFAULT_SLACK_FACTOR = 0.25;

/** How much closer than its BIND pose a pair must come before the extra
 * closeness counts as a collision. See restPairOverlaps. 5 mm is under the
 * amplitude of the proxy error itself and far under any visible interpenetration. */
export const PAIR_TOLERANCE = 0.005;

/**
 * REPORTING FLOOR. A capsule proxy is a coarse stand-in for a specific mesh, and
 * its agreement with that mesh is worth a few millimetres at best; the pushes it
 * takes to resolve one are not small (a 0.2 mm thigh × thigh reading during a
 * normal walk stride moved the pose 16 mm and keyed the frame). So a pair under
 * this depth is not reported at all — not by detection, not to the fixer, not to
 * the readout — and the tool spends its passes on contact a viewer can actually
 * see.
 */
export const MIN_DEPTH = 0.004;

/**
 * True when the rig carries every bone the capsule table REQUIRES — the
 * cheap pre-flight the UI runs to decide whether to offer the tool at all.
 * Bone lookups only: no mesh measurement, so it is safe to call per render.
 * Optional ends (the finger bones) never count against a rig.
 */
export function supportsCollisionCleanup(rig) {
	if (!rig) return false;
	for (const def of CAPSULE_DEFS) {
		// An OPTIONAL capsule (the fingers) is an extra proxy, never a
		// requirement: a rig without them is described just as well without them.
		if (def.optional) continue;
		if (!findBone(rig, def.start)) return false;
		if (def.end && !def.endOptional && !findBone(rig, def.end)) return false;
	}
	return true;
}

/** The capsule table against an arbitrary source of bone positions — the
 * current pose for detection, the bind pose for calibration. Returns null when
 * a REQUIRED bone is missing. */
function buildCapsules(rig, radiiMap, positionOf) {
	const capsules = new Map();
	for (const def of CAPSULE_DEFS) {
		const start = findBone(rig, def.start);
		// An OPTIONAL capsule the rig has no bones for is left out, not fatal.
		if (!start) {
			if (def.optional) continue;
			return null;
		}
		let end = null;
		if (def.ends) {
			for (const name of def.ends) {
				end = findBone(rig, name);
				if (end) break;
			}
			// A finger with a base joint but no further joint has no segment worth
			// testing: skip it rather than park a knuckle-sized sphere on the hand.
			if (!end) continue;
		} else if (def.end) {
			end = findBone(rig, def.end);
			// A missing OPTIONAL end degrades to the wrist sphere; a missing
			// required end means this is not a rig we can build proxies for.
			if (!end && !def.endOptional) return null;
		}
		const a = positionOf(start);
		const b = end ? positionOf(end) : a.clone();
		const measured = Math.max(RADIUS_FALLBACK, radiiMap[def.radiusJoint] ?? RADIUS_FALLBACK);
		const radius = def.fixedRadius ?? (def.maxRadius ? Math.min(measured, def.maxRadius) : measured);
		capsules.set(def.id, {
			def,
			bones: end ? [start, end] : [start],
			a,
			b,
			radius,
		});
	}
	return capsules;
}

/**
 * Build world-space capsules for the rig's CURRENT pose. Cheap (a bone
 * lookup + two world positions per entry), so callers rebuild per frame.
 * `radii` overrides the measured map (tests, or rigs without skin weights).
 * Returns null when a REQUIRED bone is missing — a non-Mixamo rig the tool
 * cannot describe, same policy as resolveIkRig. Callers must tell that apart
 * from "found no collision".
 */
export function buildCollisionCapsules(rig, radii = null) {
	if (!rig) return null;
	rig.updateMatrixWorld(true);
	const radiiMap = radii ?? measureContactRadii(rig);
	const capsules = buildCapsules(rig, radiiMap, (bone) => bone.getWorldPosition(new THREE.Vector3()));
	// Ride the pair calibration along on the map so detectPenetrations gets it
	// for free — it is a property of the RIG, which detection alone cannot see.
	if (capsules) capsules.pairAllowances = restPairOverlaps(rig, radiiMap);
	return capsules;
}

/** Stable key for an unordered capsule pair. */
function pairKey(idA, idB) {
	return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
}

// rig → (radii object identity → pair overlap map). The reference poses never
// change, so this is measured once per character.
const restOverlapCache = new WeakMap();

/** Every testable pair's overlap in one reference pose, positive entries only,
 * merged into `into` by taking the larger of the two. Measured through the SAME
 * pairGeometry detection uses, so a trimmed (hinged) pair is calibrated on the
 * portions it will actually be judged on — the natural fold a character rests
 * in is a legitimate overlap there exactly as it is anywhere else. */
function collectPairOverlaps(rig, radiiMap, positionOf, into) {
	const capsules = buildCapsules(rig, radiiMap, positionOf);
	if (!capsules) return into;
	const list = [...capsules.values()];
	const pa = new THREE.Vector3();
	const pb = new THREE.Vector3();
	for (let i = 0; i < list.length; i += 1) {
		for (let j = i + 1; j < list.length; j += 1) {
			const geo = pairGeometry(list[i], list[j]);
			if (!geo) continue;
			closestPointsSegmentSegment(geo.a0, geo.a1, geo.b0, geo.b1, pa, pb);
			const overlap = list[i].radius + list[j].radius - pa.distanceTo(pb);
			if (overlap <= 0) continue;
			const key = pairKey(list[i].def.id, list[j].def.id);
			if (overlap > (into.get(key) ?? 0)) into.set(key, overlap);
		}
	}
	return into;
}

/**
 * How much each non-adjacent capsule pair ALREADY overlaps in a pose the
 * character legitimately holds, in metres (positive entries only; a pair that is
 * clear in every reference pose has no entry). Returns null on a rig with no
 * bind snapshot to compose from.
 *
 * Capsules are a coarse proxy for a specific mesh, and on real characters the
 * proxy error is not small: on the shipped default rig the REST pose reports
 * torso × upper arm at 9.2 mm of "penetration" (torso 0.17 + upper arm 0.05447
 * + offset 0.002 against a 0.19547 axis distance, minus a 21.8 mm slack
 * allowance). One press of Fix collisions on a brand-new project baked a phantom
 * key and moved the rig 13.7 mm. Slack cannot fix this: the rig would need
 * slackFactor ≥ 0.569 to read clean, and a global allowance that loose re-masks
 * every real contact on every other pair.
 *
 * So the pair's own reference overlap becomes its zero point — the same
 * clip-relative-ground move auto-physics made for the floor.
 *
 * TWO REFERENCE POSES, and the second is the one that matters. `poseBind` is a
 * T-POSE: arms straight out, nowhere near the torso (LeftForeArm at x = 0.4616).
 * The pose the app actually shows is DEFAULT_POSE — arms hanging at the sides,
 * the same forearm at x = 0.1876 — and that is where the arm capsules graze the
 * torso. Calibrating against bind alone therefore recorded only leftThigh ×
 * rightThigh and left torso × upper arm at zero allowance, which is exactly the
 * pair that false-positives. Both poses are measured and the LARGER allowance
 * wins, so a T-posed character and a standing one both read clean, while a pair
 * that overlaps in neither (a hand driven into a thigh) still fires at full
 * sensitivity. Both are composed virtually through ik.js, so measuring never
 * disturbs — or depends on — the pose currently on screen.
 *
 * The cost, stated plainly: contact that the rest pose already has is invisible
 * here. An arm pressed flat against the ribs cannot be distinguished from an arm
 * hanging beside them, because the capsule proxies genuinely cannot tell those
 * apart. Excluding those pairs outright (the alternative) would lose the deep
 * hits too; this keeps them.
 */
function restPairOverlaps(rig, radii = null) {
	if (!rig || !hasBindPose(rig)) return null;
	const radiiMap = radii ?? measureContactRadii(rig);
	let perRadii = restOverlapCache.get(rig);
	if (!perRadii) restOverlapCache.set(rig, (perRadii = new Map()));
	const cached = perRadii.get(radiiMap);
	if (cached) return cached;
	rig.updateMatrixWorld(true);
	const overlaps = new Map();
	collectPairOverlaps(rig, radiiMap, (bone) => bindWorldPosition(rig, bone, new THREE.Vector3()), overlaps);
	collectPairOverlaps(rig, radiiMap, (bone) => restWorldPosition(rig, bone, new THREE.Vector3()), overlaps);
	perRadii.set(radiiMap, overlaps);
	return overlaps;
}

/** Closest points between two segments (Ericson, Real-Time Collision
 * Detection — the textbook segment/segment distance). Writes into outA/outB
 * and returns the squared distance. */
export function closestPointsSegmentSegment(p1, q1, p2, q2, outA, outB) {
	const d1 = q1.clone().sub(p1);
	const d2 = q2.clone().sub(p2);
	const r = p1.clone().sub(p2);
	const a = d1.dot(d1);
	const e = d2.dot(d2);
	const f = d2.dot(r);
	let s;
	let t;
	if (a <= 1e-12 && e <= 1e-12) {
		outA.copy(p1); outB.copy(p2);
		return r.dot(r);
	}
	if (a <= 1e-12) {
		s = 0;
		t = Math.max(0, Math.min(1, f / e));
	} else {
		const c = d1.dot(r);
		if (e <= 1e-12) {
			t = 0;
			s = Math.max(0, Math.min(1, -c / a));
		} else {
			const b = d1.dot(d2);
			const denom = a * e - b * b;
			s = denom > 1e-12 ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0;
			t = (b * s + f) / e;
			if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
			else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
		}
	}
	outA.copy(p1).addScaledVector(d1, s);
	outB.copy(p2).addScaledVector(d2, t);
	return outA.distanceToSquared(outB);
}

/** Ancestor hop count between two bones, or Infinity when neither is an
 * ancestor of the other within `limit` hops. */
const HOP_SEARCH = 8;
function boneHops(b0, b1, limit = HOP_SEARCH) {
	let hops = 0;
	for (let node = b0; node && hops <= limit; node = node.parent, hops += 1) {
		if (node === b1) return hops;
	}
	hops = 0;
	for (let node = b1; node && hops <= limit; node = node.parent, hops += 1) {
		if (node === b0) return hops;
	}
	return Infinity;
}

/** Capsules whose endpoints sit within HOP_LIMIT hops on the skeleton are
 * NEIGHBOURS (upper arm against chest at the shoulder, thigh against the
 * pelvis, forearm against upper arm at the elbow): they always overlap AT the
 * joint they share, so they get the trimmed test below rather than the plain
 * one. */
const HOP_LIMIT = 2;
function bonesRelated(b0, b1) {
	return boneHops(b0, b1, HOP_LIMIT) <= HOP_LIMIT;
}

function capsulesAdjacent(ca, cb) {
	return ca.bones.some((ba) => cb.bones.some((bb) => bonesRelated(ba, bb)));
}

/**
 * HINGED PAIRS. A blanket "skip everything within HOP_LIMIT" made whole classes
 * of real interpenetration invisible: a knee driven into the belly is
 * thigh × torso, an arm folded past its own elbow is forearm × upper arm, and
 * neither pair was ever tested. The skip existed for a good reason — the two
 * capsules MEET at the joint they share, so an untrimmed test reports a
 * permanent collision at every pose and pins the fixer forever — but that
 * reason only covers the part of each capsule NEXT TO the joint.
 *
 * So the pair is tested on the portions FAR from the shared joint: TRIM_FRACTION
 * of each segment is cut away from the joint side, and the segment-segment test
 * runs on what is left. A normally bent elbow keeps its far portions well apart;
 * a fully folded one lays them on top of each other, which is exactly the pose
 * that has to be caught.
 *
 * The joint side is the endpoint CLOSER to the other capsule in the hierarchy
 * (fewest ancestor hops), so the trim always eats the shared end and never the
 * free one.
 */
export const TRIM_FRACTION = 0.45;

/**
 * Compression allowance for a pair that SHARES a bone — the two segments of one
 * hinge (elbow, knee, ankle, wrist, waist). Flesh-to-flesh contact is the normal
 * state of a deep fold there, and the capsule proxies overlap by construction
 * long before the pose is wrong, so the thin-capsule slack rule is the wrong
 * ruler: this one is a fraction of the COMBINED radii, and only a fold that puts
 * the far end of one segment inside the body of the other clears it.
 */
export const HINGE_SLACK_FACTOR = 0.65;

/** Which end of `ca` faces `cb` on the skeleton: true = the START endpoint. */
function jointSideIsStart(ca, cb) {
	const hopsOf = (bone) => Math.min(...cb.bones.map((other) => boneHops(bone, other)));
	const first = hopsOf(ca.bones[0]);
	const last = ca.bones.length > 1 ? hopsOf(ca.bones[ca.bones.length - 1]) : first;
	return first <= last;
}

/** `ca` with the joint-side TRIM_FRACTION cut off, written into out0/out1. */
function trimTowardJoint(ca, cb, out0, out1) {
	if (jointSideIsStart(ca, cb)) {
		out0.copy(ca.a).lerp(ca.b, TRIM_FRACTION);
		out1.copy(ca.b);
	} else {
		out0.copy(ca.a);
		out1.copy(ca.b).lerp(ca.a, TRIM_FRACTION);
	}
}

/** How many bones the two capsules have in common (0, 1 or 2). */
function sharedBoneCount(ca, cb) {
	return ca.bones.filter((bone) => cb.bones.includes(bone)).length;
}

/**
 * Pairs that must never be tested, whatever the pose.
 *
 * Adjacency already covers most of the finger cases (a finger base is one hop
 * from the hand, two from the forearm), but the trimmed test above means
 * "adjacent" no longer means "skipped", so the finger rules are spelled out
 * rather than inherited: a finger against its own hand, its own forearm, or any
 * other finger is a pose the proxies cannot judge — fingers touch each other and
 * lie against the palm constantly — while a finger against a thigh, a shin, the
 * torso, the chest, the head or the opposite arm is exactly what the finger
 * capsules were added to catch.
 */
function pairExcluded(ca, cb) {
	const fa = ca.def.handId;
	const fb = cb.def.handId;
	if (fa && fb) return true; // finger × finger, either hand
	if (fa && (cb.def.id === fa || cb.def.id === ca.def.foreArmId)) return true;
	if (fb && (ca.def.id === fb || ca.def.id === cb.def.foreArmId)) return true;
	// SAME CHAIN, no shared joint: a hand against its own upper arm, a foot
	// against its own thigh, a finger against its own forearm. Two things are
	// true of every such pair and neither is true of a hinge: the pose is
	// legitimate (a hand rests on its own shoulder, a heel touches its own
	// thigh) and the fixer could not separate them anyway, because ONE solver
	// drives both sides and each push undoes the other — measured as a fold
	// that oscillated to maxIterations without converging. The fold that IS
	// impossible — the segments either side of the elbow or the knee — shares a
	// bone, and stays tested (trimmed) by the rule above.
	const chainA = ca.def.movable?.chain;
	const chainB = cb.def.movable?.chain;
	if (chainA && chainA === chainB && sharedBoneCount(ca, cb) === 0) return true;
	return false;
}

/** Scratch segments for the pair geometry below. One pair is measured at a time
 * (detection is a plain double loop), so these can be module-level. */
const geoA0 = new THREE.Vector3();
const geoA1 = new THREE.Vector3();
const geoB0 = new THREE.Vector3();
const geoB1 = new THREE.Vector3();
const geometry = { a0: geoA0, a1: geoA1, b0: geoB0, b1: geoB1, hinge: false };

/**
 * The segments to test for one capsule pair, or null when the pair is not
 * testable at all. Unrelated capsules are tested whole; neighbours are tested
 * on their trimmed portions (see HINGED PAIRS). The returned object is REUSED
 * between calls — read it before the next call.
 */
function pairGeometry(ca, cb) {
	if (pairExcluded(ca, cb)) return null;
	if (!capsulesAdjacent(ca, cb)) {
		geoA0.copy(ca.a); geoA1.copy(ca.b);
		geoB0.copy(cb.a); geoB1.copy(cb.b);
		geometry.hinge = false;
		return geometry;
	}
	// Same segment, or two capsules over the same two bones: there is no "far
	// portion" to compare and nothing a fixer could do about it either way.
	const shared = sharedBoneCount(ca, cb);
	if (shared >= 2 || ca.bones.length === 0 || cb.bones.length === 0) return null;
	// Two static blockers meeting at the spine (torso × chest, chest × head) are
	// permanent by construction and unfixable by anything: no limb chain drives
	// them, so reporting them would only add noise.
	if (!ca.def.movable && !cb.def.movable) return null;
	trimTowardJoint(ca, cb, geoA0, geoA1);
	trimTowardJoint(cb, ca, geoB0, geoB1);
	geometry.hinge = shared === 1;
	return geometry;
}

/**
 * EXTERNAL BLOCKERS. Everything above is the character against itself; a hand
 * swinging through a chair is the same problem against the SET. Callers pass
 * `blockers`: world-space static shapes, already posed for the frame being
 * solved (the caller owns their animation — this owns the push).
 *
 *   capsule: { id, kind: "capsule", a: Vector3, b: Vector3, radius }
 *   box:     { id, kind: "box", center: Vector3, halfExtents: Vector3, yaw }
 *
 * `yaw` is radians about world +Y, the only rotation a prop standing on a floor
 * normally needs and the only one the closest-point test below has to invert.
 *
 * They behave exactly like torso and head: never movable, never adjacent to
 * anything, and never rest-calibrated — a character's rest pose says nothing
 * about where the furniture is. The full slack rule applies, with one wrinkle: a
 * box has no radius to take the min against, so the movable capsule's own slack
 * is used (a box is a surface, not a soft body).
 *
 * A blocker's records carry its id VERBATIM, so the existing pair readouts
 * ("leftHand×obj:chair") identify which prop was hit without any caller change.
 * The id is the caller's to namespace — collision-blockers.js already ships
 * "obj:cube" and "char:char-2:torso" — and a prefix added here would only double
 * it up ("obj:obj:cube", as QA read out).
 */
function blockerEntry(shape) {
	if (!shape || typeof shape.id !== "string") return null;
	const point = (value) => (value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)
		? new THREE.Vector3(value.x, value.y, value.z)
		: null);
	const def = { id: shape.id, movable: null, blocker: true };
	if (shape.kind === "capsule") {
		const a = point(shape.a);
		const b = point(shape.b);
		if (!a || !b || !Number.isFinite(shape.radius) || shape.radius < 0) return null;
		return { def, kind: "capsule", bones: [], a, b, radius: shape.radius };
	}
	if (shape.kind === "box") {
		const center = point(shape.center);
		const halfExtents = point(shape.halfExtents);
		if (!center || !halfExtents) return null;
		halfExtents.set(Math.abs(halfExtents.x), Math.abs(halfExtents.y), Math.abs(halfExtents.z));
		return {
			def,
			kind: "box",
			bones: [],
			center,
			halfExtents,
			yaw: Number.isFinite(shape.yaw) ? shape.yaw : 0,
			// The slack rule reads `radius`; a box surface has none.
			radius: 0,
		};
	}
	return null;
}

/** The capsule whose START is a chain's root joint (shoulder / hip) — the
 * anchor a box escape aims back toward. */
const CHAIN_ROOT_CAPSULE = {
	leftHand: "leftUpperArm",
	rightHand: "rightUpperArm",
	leftFoot: "leftThigh",
	rightFoot: "rightThigh",
};

function normalizeBlockers(blockers) {
	if (!Array.isArray(blockers) || blockers.length === 0) return [];
	const out = [];
	for (const shape of blockers) {
		const entry = blockerEntry(shape);
		if (entry) out.push(entry);
	}
	return out;
}

/**
 * Signed distance from `point` to an oriented box: positive outside, NEGATIVE
 * inside (the depth to the nearest face). Writes the closest SURFACE point into
 * `outSurface` and the outward surface normal there into `outNormal`.
 *
 * The box is axis-aligned once the yaw is undone, so the whole thing is a clamp
 * in box space plus a rotation back.
 */
const boxLocal = new THREE.Vector3();
const boxClamped = new THREE.Vector3();
const boxPrefer = new THREE.Vector3();
function boxSignedDistance(box, point, outSurface, outNormal, prefer = null) {
	const cos = Math.cos(box.yaw);
	const sin = Math.sin(box.yaw);
	const dx = point.x - box.center.x;
	const dy = point.y - box.center.y;
	const dz = point.z - box.center.z;
	// world → box: rotate by −yaw about Y.
	boxLocal.set(cos * dx - sin * dz, dy, sin * dx + cos * dz);
	const h = box.halfExtents;
	const outward = (local) => {
		// box → world.
		outSurface.set(cos * local.x + sin * local.z, local.y, -sin * local.x + cos * local.z).add(box.center);
	};
	const outsideX = Math.abs(boxLocal.x) - h.x;
	const outsideY = Math.abs(boxLocal.y) - h.y;
	const outsideZ = Math.abs(boxLocal.z) - h.z;
	if (outsideX > 0 || outsideY > 0 || outsideZ > 0) {
		boxClamped.set(
			Math.max(-h.x, Math.min(h.x, boxLocal.x)),
			Math.max(-h.y, Math.min(h.y, boxLocal.y)),
			Math.max(-h.z, Math.min(h.z, boxLocal.z)),
		);
		const distance = boxLocal.distanceTo(boxClamped);
		outward(boxClamped);
		if (distance > 1e-9) {
			const nx = (boxLocal.x - boxClamped.x) / distance;
			const ny = (boxLocal.y - boxClamped.y) / distance;
			const nz = (boxLocal.z - boxClamped.z) / distance;
			outNormal.set(cos * nx + sin * nz, ny, -sin * nx + cos * nz).normalize();
		} else {
			// Exactly ON the surface: fall through to the face normal.
			const gaps = [h.x - Math.abs(boxLocal.x), h.y - Math.abs(boxLocal.y), h.z - Math.abs(boxLocal.z)];
			const axis = gaps.indexOf(Math.min(...gaps));
			const sign = [boxLocal.x, boxLocal.y, boxLocal.z][axis] < 0 ? -1 : 1;
			const local = [0, 0, 0];
			local[axis] = sign;
			outNormal.set(cos * local[0] + sin * local[2], local[1], -sin * local[0] + cos * local[2]).normalize();
		}
		return distance;
	}
	// Inside: THE EXIT FACE, which is not always the nearest one.
	//
	// A limb buried in a crate is nearest to whichever face it happened to sink
	// past, and for a deep hit that is regularly the FAR one — a push out through
	// it drags the whole arm through the box (QA measured 16 bones inside after a
	// "fix"). So of the six faces the exit prefers one the limb's own ROOT is on:
	// the shallowest whose outward normal points back toward the shoulder or hip.
	// With no root hint — or with the root itself inside the box — the nearest
	// face is still the answer, which is the plain signed distance.
	//
	// `prefer` therefore changes the DIRECTION and the depth of the escape, never
	// the geometry: the plain nearest-face value is what the segment search below
	// minimises (a max of linear functions, so convex, which is what makes the
	// ternary search exact), and the preference is applied once, to the point that
	// search returns.
	const components = [boxLocal.x, boxLocal.y, boxLocal.z];
	const extents = [h.x, h.y, h.z];
	let bestAxis = 0;
	let bestSign = 1;
	let bestExit = Infinity;
	let bestAligned = false;
	for (let axis = 0; axis < 3; axis += 1) {
		for (const sign of [-1, 1]) {
			const exit = extents[axis] - sign * components[axis];
			let aligned = false;
			if (prefer) {
				boxPrefer.set(
					cos * (axis === 0 ? sign : 0) + sin * (axis === 2 ? sign : 0),
					axis === 1 ? sign : 0,
					-sin * (axis === 0 ? sign : 0) + cos * (axis === 2 ? sign : 0),
				);
				aligned = boxPrefer.dot(prefer) > 0;
			}
			// An aligned face beats an unaligned one outright; within a class the
			// shallower exit wins.
			if ((aligned && !bestAligned) || (aligned === bestAligned && exit < bestExit)) {
				bestAxis = axis;
				bestSign = sign;
				bestExit = exit;
				bestAligned = aligned;
			}
		}
	}
	boxClamped.copy(boxLocal);
	if (bestAxis === 0) boxClamped.x = bestSign * h.x;
	else if (bestAxis === 1) boxClamped.y = bestSign * h.y;
	else boxClamped.z = bestSign * h.z;
	outward(boxClamped);
	outNormal.set(
		cos * (bestAxis === 0 ? bestSign : 0) + sin * (bestAxis === 2 ? bestSign : 0),
		bestAxis === 1 ? bestSign : 0,
		-sin * (bestAxis === 0 ? bestSign : 0) + cos * (bestAxis === 2 ? bestSign : 0),
	).normalize();
	return -bestExit;
}

/** How many ternary-search steps the segment/box solve takes. Each step keeps
 * 2/3 of the interval, so 48 of them pin the parameter to ~1e-8 of the segment
 * — far under the millimetre the depths are reported in. */
const BOX_SEARCH_STEPS = 48;

/**
 * Closest approach between a segment and an oriented box. The distance from a
 * point to a convex set is convex along a line, and the SIGNED distance of a
 * convex set is convex too (which is what makes the inside case work), so a
 * ternary search on the parameter finds the minimum without any case analysis of
 * edges, faces and corners.
 *
 * Writes the segment point into `outA` and the box's surface point into `outB`,
 * with the outward surface normal in `outNormal`, and returns the SIGNED
 * distance (negative when the segment runs through the box).
 */
const boxProbe = new THREE.Vector3();
const boxSurface = new THREE.Vector3();
const boxNormal = new THREE.Vector3();
function closestSegmentBox(p, q, box, outA, outB, outNormal, prefer = null) {
	const at = (t) => {
		boxProbe.copy(p).lerp(q, t);
		return boxSignedDistance(box, boxProbe, boxSurface, boxNormal);
	};
	let lo = 0;
	let hi = 1;
	for (let step = 0; step < BOX_SEARCH_STEPS; step += 1) {
		const third = (hi - lo) / 3;
		const m1 = lo + third;
		const m2 = hi - third;
		if (at(m1) < at(m2)) hi = m2;
		else lo = m1;
	}
	const t = (lo + hi) / 2;
	let distance = at(t);
	if (distance < 0 && prefer) {
		// Deepest point found; now pick the face it leaves by.
		boxProbe.copy(p).lerp(q, t);
		distance = boxSignedDistance(box, boxProbe, boxSurface, boxNormal, prefer);
	}
	outA.copy(p).lerp(q, t);
	outB.copy(boxSurface);
	outNormal.copy(boxNormal);
	return distance;
}

/**
 * One capsule against one blocker. Returns { gap, normal, pointA, pointB } with
 * `gap` the signed distance from the capsule's AXIS to the blocker's SURFACE and
 * `normal` pointing from the blocker toward the capsule — the same b → a
 * convention detectPenetrations uses everywhere else.
 */
const blockNormal = new THREE.Vector3();
const blockPrefer = new THREE.Vector3();
function blockerContact(capsule, blocker, outA, outB, rootAnchor = null) {
	if (blocker.kind === "box") {
		// The way OUT of a box is the way the limb came in, and the limb's root is
		// the only anchor that knows which way that was.
		let prefer = null;
		if (rootAnchor) {
			blockPrefer.copy(rootAnchor).sub(capsule.a.clone().lerp(capsule.b, 0.5));
			if (blockPrefer.lengthSq() > 1e-12) prefer = blockPrefer.normalize();
		}
		const gap = closestSegmentBox(capsule.a, capsule.b, blocker, outA, outB, blockNormal, prefer);
		return { gap, normal: blockNormal.clone() };
	}
	closestPointsSegmentSegment(capsule.a, capsule.b, blocker.a, blocker.b, outA, outB);
	const axisGap = outA.distanceTo(outB);
	const normal = outA.clone().sub(outB);
	if (normal.lengthSq() < 1e-12) {
		normal.set(0, 0, 1).cross(capsule.b.clone().sub(capsule.a));
		if (normal.lengthSq() < 1e-12) normal.set(0, 1, 0);
	}
	normal.normalize();
	// Report the contact ON the blocker's surface, not on its axis.
	outB.addScaledVector(normal, blocker.radius);
	return { gap: axisGap - blocker.radius, normal };
}

/**
 * Find every penetrating capsule pair in the current pose. Returns records
 * { a, b, depth, normal, pointA, pointB } sorted deepest-first. `normal`
 * points from b toward a. `offset` inflates the contact distance HERE, in
 * the test itself — a pair counts as penetrating once it is closer than
 * rA + rB + offset — so the same gap the fixer pushes out to is the gap it
 * checks for. Honouring offset only in the push distance would make the
 * fixer chase a target detection never asked for, and the very gap it just
 * opened would read as clean at exactly the surface-grazing pose it exists
 * to avoid.
 *
 * SLACK: capsules are rigid proxies for soft tissue — an upper arm resting
 * against the torso, or thighs touching, legitimately overlaps the proxies.
 * A pair only counts once it penetrates past `slackFactor × min(radius)`,
 * the soft-tissue compression allowance; `depth` is the amount PAST that
 * allowance, which is also the distance the fixer pushes.
 *
 * The default is 0.25, and it used to be 0.4. The looser value was doing two
 * jobs: covering genuine soft-tissue compression AND covering the overlaps a
 * character legitimately holds at rest, which the proxies cannot tell from a
 * real hit. The rest/bind calibration below now does the second job precisely,
 * per pair, so the global allowance no longer has to be blunt enough for the
 * worst pair on the rig — and at 0.4 it hid a centimetre and a half of forearm
 * inside a thigh. (Loosening it further was never an option either: at 0.6 a
 * hand sunk most of the way into a thigh still fit inside the allowance and the
 * tool answered "no collisions".)
 *
 * HINGED PAIRS use their own, wider allowance instead — see HINGE_SLACK_FACTOR —
 * because two segments meeting at a joint are in flesh-to-flesh contact at any
 * deep fold. BLOCKERS use the plain rule, with a box's missing radius standing
 * in as the movable capsule's own.
 *
 * BIND CALIBRATION: on top of the global slack, a pair that already overlaps in
 * the rig's bind pose gets that overlap plus PAIR_TOLERANCE as its own
 * allowance (see restPairOverlaps), so a rest or bind pose can never report a
 * collision. `pairAllowances` overrides the map buildCollisionCapsules attached;
 * pass null to measure a pose against nothing but the slack rule.
 *
 * `blockers` adds the world-space static shapes described under EXTERNAL
 * BLOCKERS; they are tested against every MOVABLE capsule and named `obj:<id>`
 * in the records.
 */
export function detectPenetrations(capsules, {
	offset = 0.002,
	slackFactor = DEFAULT_SLACK_FACTOR,
	pairAllowances,
	blockers = null,
} = {}) {
	if (!capsules) return [];
	const calibration = pairAllowances === undefined ? (capsules.pairAllowances ?? null) : pairAllowances;
	const list = [...capsules.values()];
	const out = [];
	const pa = new THREE.Vector3();
	const pb = new THREE.Vector3();
	for (let i = 0; i < list.length; i += 1) {
		for (let j = i + 1; j < list.length; j += 1) {
			const ca = list[i];
			const cb = list[j];
			const geo = pairGeometry(ca, cb);
			if (!geo) continue;
			const hinge = geo.hinge;
			closestPointsSegmentSegment(geo.a0, geo.a1, geo.b0, geo.b1, pa, pb);
			const overlap = ca.radius + cb.radius + offset - pa.distanceTo(pb);
			const slack = hinge
				? HINGE_SLACK_FACTOR * (ca.radius + cb.radius)
				: slackFactor * Math.min(ca.radius, cb.radius);
			const bindOverlap = calibration?.get(pairKey(ca.def.id, cb.def.id)) ?? 0;
			const allowance = Math.max(slack, bindOverlap > 0 ? bindOverlap + PAIR_TOLERANCE : 0);
			const depth = overlap - allowance;
			// MIN_DEPTH, not epsilon: see the constant. A pair under it is not a
			// contact anyone can see and not one worth moving a limb for.
			if (depth < MIN_DEPTH) continue;
			const normal = pa.clone().sub(pb);
			if (normal.lengthSq() < 1e-12) {
				// Coincident axes: any perpendicular direction separates them.
				normal.set(0, 0, 1).cross(ca.b.clone().sub(ca.a));
				if (normal.lengthSq() < 1e-12) normal.set(0, 1, 0);
			}
			normal.normalize();
			out.push({ a: ca, b: cb, depth, normal, pointA: pa.clone(), pointB: pb.clone() });
		}
	}
	// External blockers: only MOVABLE capsules are worth testing — a blocker
	// against the torso is two immovable things touching, which no pass can fix.
	const shapes = normalizeBlockers(blockers);
	for (const blocker of shapes) {
		for (const capsule of list) {
			if (!capsule.def.movable) continue;
			const rootId = CHAIN_ROOT_CAPSULE[capsule.def.movable.chain];
			const rootAnchor = rootId ? capsules.get(rootId)?.a ?? null : null;
			const contact = blockerContact(capsule, blocker, pa, pb, rootAnchor);
			const overlap = capsule.radius + offset - contact.gap;
			// A box has no radius to take the min against, so the limb's own
			// slack is the whole allowance. No rest calibration: the character's
			// reference poses say nothing about where the set dressing is.
			const slack = slackFactor * (blocker.kind === "box"
				? capsule.radius
				: Math.min(capsule.radius, blocker.radius));
			const depth = overlap - slack;
			if (depth < MIN_DEPTH) continue;
			out.push({
				a: capsule,
				b: blocker,
				depth,
				normal: contact.normal.clone(),
				pointA: pa.clone(),
				pointB: pb.clone(),
			});
		}
	}
	out.sort((x, y) => y.depth - x.depth);
	return out;
}
