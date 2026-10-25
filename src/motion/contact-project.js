import * as THREE from "three";
import { closestPointsSegmentSegment } from "./fix-collisions.js";

/**
 * Contact projection for a Studio IK drag: the dragged target is moved out of
 * the OTHER characters' capsules before the chain solves toward it, so a hand
 * pushed into someone's chest stops on the chest instead of going through.
 *
 * One-sided by design: the blockers never move (the other character is never
 * pushed; what they do is their own take). Fixed pass count, fixed order
 * (probe capsules in the order given, blockers in the order given, the first
 * deepest pair wins a tie), no clock, no randomness: the same target, the same
 * blockers and the same `lastGood` give the same result.
 *
 * KEEP THE SIDE. The plain escape normal (probe point minus blocker point)
 * flips once a deep target crosses the blocker's axis and then pushes the hand
 * out of the BACK of the body. The escape keeps the side the hand came from:
 * when the normal points away from `lastGood` (the last clean target of this
 * drag), the push goes toward `lastGood` instead. Of the escape rules tried in
 * the research prototype this was the only one that never tunnelled.
 */

const EPS = 1e-9;

/** Push distance along unit `dir` that takes point `w` (relative to the
 * blocker point) to distance `reach` from it: the far root of |w + t dir| = reach. */
function exitDistance(w, dir, reach) {
	const along = w.dot(dir);
	const inside = w.lengthSq() - reach * reach;
	return -along + Math.sqrt(Math.max(0, along * along - inside));
}

/**
 * @param {object} options
 * @param {Array<{id:string,a:THREE.Vector3,b:THREE.Vector3,radius:number}>} options.blockers
 *   the other characters' capsules, built once per drag; never moved
 * @param {number|((probeId:string, blockerId:string) => number|null)} [options.allow]
 *   depth (m) a probe may go into a blocker: a number for every pair, or a
 *   lookup (null = 0) for an intended touch (spec.checks.allow person entries)
 * @param {number} [options.margin]  how far outside the surface a pushed target lands
 * @param {number} [options.passes] fixed number of probe/push passes
 * @param {number} [options.maxSteps] cap on the sweep's substeps per event
 */
export function createContactProjector({ blockers = [], allow = 0, margin = 0.004, passes = 4, maxSteps = 32 } = {}) {
	// sweep spacing: no substep longer than the thinnest blocker's radius
	const thinnest = Math.max(0.005, Math.min(...blockers.map((b) => b.radius)));
	const allowed = typeof allow === "function" ? (p, b) => Math.max(0, allow(p, b) ?? 0) : () => Math.max(0, allow ?? 0);
	const onProbe = new THREE.Vector3(), onBlocker = new THREE.Vector3(), w = new THREE.Vector3(), dir = new THREE.Vector3(), side = new THREE.Vector3();
	const best = { depth: 0, reach: 0, probe: new THREE.Vector3(), blocker: new THREE.Vector3() };

	/** The deepest probe/blocker pair past its allowance, written into `best`; false when none. */
	function deepest(capsules) {
		best.depth = 0;
		for (const capsule of capsules) {
			for (const blocker of blockers) {
				const reach = capsule.radius + blocker.radius - allowed(capsule.id, blocker.id);
				const dist = Math.sqrt(closestPointsSegmentSegment(capsule.a, capsule.b, blocker.a, blocker.b, onProbe, onBlocker));
				if (reach - dist <= best.depth) continue;
				best.depth = reach - dist;
				best.reach = reach;
				best.probe.copy(onProbe);
				best.blocker.copy(onBlocker);
			}
		}
		return best.depth > 0;
	}

	/**
	 * SWEEP. A clean endpoint is not enough: one pointer event can carry the
	 * limb clean across a thin blocker (a forearm, a hand). Walk from the
	 * handle as displayed (`from.at`) to the target in equal substeps no
	 * longer than the thinnest blocker's radius (at most `maxSteps`; a longer
	 * jump gets longer substeps) and stop at the first substep that touches
	 * after a clean one. Returns that substep (the keep-the-side push then runs
	 * there, with the clean substep before it as the side), `{ at: null }`
	 * when the target is clean and so was the way there, or null when the path
	 * never got clean (the limb as displayed is in contact, e.g. the drag
	 * opened touching, and a start in contact only stops once clean).
	 *
	 * The start is judged on the limb AS DISPLAYED (`from.capsules`), not by
	 * solving toward lastGood again: the drag's solve does not land its handle
	 * on the target in one call, so a second solve toward the same clean
	 * target moves the limb on, into the blocker it had stopped short of, and
	 * the whole crossing then read as a start in contact allowed to leave.
	 */
	function firstTouch(target, probe, from) {
		const steps = Math.min(maxSteps, Math.max(1, Math.ceil(from.at.distanceTo(target) / thinnest)));
		let wasClean = !deepest(from.capsules);
		const clean = from.at.clone();
		for (let k = 1; k <= steps; k++) {
			const at = k === steps ? target.clone() : from.at.clone().lerp(target, k / steps);
			if (!deepest(probe(at))) {
				wasClean = true;
				clean.copy(at);
			} else if (wasClean) return { at, clean };
		}
		return wasClean ? { at: null, clean } : null;
	}

	/**
	 * Move `target` out of the blockers.
	 * @param {THREE.Vector3} target  the dragged point (not mutated)
	 * @param {(candidate:THREE.Vector3) => Array<{id:string,a:THREE.Vector3,b:THREE.Vector3,radius:number}>} probe
	 *   the dragged limb's capsules when its handle sits at `candidate`
	 * @param {THREE.Vector3|null} lastGood  the last clean target of this drag (the side to keep)
	 * @param {{at:THREE.Vector3, capsules:Array}|null} [from]  the handle and the limb's
	 *   capsules as displayed when the event began: where the sweep starts
	 *   (default: lastGood, with the limb probed there)
	 * @returns {{ target: THREE.Vector3, contact: boolean, depth: number }}
	 *   `contact` = a push happened; `depth` = what is left after the last pass (0 = clean)
	 */
	function project(target, probe, lastGood = null, from = null) {
		let out = target.clone();
		let contact = false;
		if (!blockers.length) return { target: out, contact, depth: 0 };
		const hit = lastGood ? firstTouch(out, probe, from ?? { at: lastGood, capsules: probe(lastGood) }) : null;
		if (hit && !hit.at) return { target: out, contact, depth: 0 };
		if (hit) out = hit.at;
		const keep = hit?.clean ?? lastGood;
		for (let pass = 0; pass < passes; pass++) {
			if (!deepest(probe(out))) return { target: out, contact, depth: 0 };
			contact = true;
			w.subVectors(best.probe, best.blocker);
			dir.copy(w);
			if (keep) {
				side.subVectors(keep, best.blocker);
				// a normal pointing away from the side the hand came from is the
				// far side of the body: escape toward lastGood instead
				if (side.lengthSq() > EPS && (dir.lengthSq() <= EPS || dir.dot(side) < 0)) dir.copy(side);
			}
			if (dir.lengthSq() <= EPS) dir.set(0, 1, 0);
			dir.normalize();
			out.addScaledVector(dir, exitDistance(w, dir, best.reach + margin));
		}
		const left = deepest(probe(out)) ? best.depth : 0;
		// the passes did not get the probed (displayed) limb out: fall back to
		// the last clean substep of the sweep, on the near side
		if (left > 0 && hit) return { target: hit.clean.clone(), contact: true, depth: 0 };
		return { target: out, contact, depth: left };
	}

	return { project };
}
