import * as THREE from "three";
import { findBone } from "./ik.js";
import { SEGMENT_FRACTIONS } from "../motion3/qa/com.js";

// Body segment masses and the centre of mass of a posed Mixamo rig. Read-only:
// motion verification and the support diagnostics measure with it.

/**
 * Segment mass fractions of total body mass (Dempster, via Winter), on Mixamo
 * bone names. The table itself lives with motion3 QA (motion3/qa/com.js
 * SEGMENT_FRACTIONS), which measures balance on the same segments.
 *
 * Each entry names the two Mixamo bones whose MIDPOINT carries the fraction.
 * Dempster's true centres of mass sit ~43% down each segment rather than at
 * 50%, but the difference is a couple of centimetres on a limb and cancels
 * almost exactly between the left and right sides — while the midpoint keeps
 * the table readable and needs no extra per-segment constant.
 *
 * The fractions sum to 1, so the weighted average below is a true CoM.
 */
export const SEGMENT_MASSES = SEGMENT_FRACTIONS.map(({ id, start, end, mass }) => ({ id, start: `mixamorig${start}`, end: `mixamorig${end}`, mass }));

/**
 * World-space centre of mass of the rig's CURRENT pose: the mass-weighted
 * average of every segment's midpoint. Returns null when any segment bone is
 * missing — a partial CoM would silently drift the correction toward
 * whichever half of the body did resolve, so the caller must instead hide the
 * tool (the same all-or-nothing policy resolveIkRig uses).
 */
export function computeCenterOfMass(rig) {
	if (!rig) return null;
	rig.updateMatrixWorld(true);
	const com = new THREE.Vector3();
	const start = new THREE.Vector3();
	const end = new THREE.Vector3();
	let total = 0;
	for (const segment of SEGMENT_MASSES) {
		const a = findBone(rig, segment.start);
		const b = findBone(rig, segment.end);
		if (!a || !b) return null;
		a.getWorldPosition(start);
		b.getWorldPosition(end);
		com.addScaledVector(start.add(end).multiplyScalar(0.5), segment.mass);
		total += segment.mass;
	}
	if (total <= 0) return null;
	return com.divideScalar(total);
}
