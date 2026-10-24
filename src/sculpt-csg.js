/**
 * Sculpt booleans: the cutters a recipe declares (`op`, sculpt-cutters.js) run
 * on their parent part's geometry with three-bvh-csg.
 *
 * The cut happens in the parent's own frame. The cutter's geometry is moved by
 * inverse(parent) × cutter, both object-frame matrices from expandSculptParts,
 * so the result drops straight back into the parent's mesh, and the mesh keeps
 * its transform, name, shadows and material. A cut only removes (subtract) or
 * keeps less (intersect), so the stored standing box stays an honest bound.
 *
 * A boolean that throws, yields non-finite points or leaves nothing is skipped
 * with a warning. The part is then drawn as it was before that cut instead of
 * vanishing or breaking the build, and the same recipe always skips the same
 * cut.
 */
import * as THREE from "three";
import { Brush, Evaluator, HalfEdgeMap, INTERSECTION, SUBTRACTION } from "three-bvh-csg";
import { MeshBVH } from "three-mesh-bvh";

const OPERATIONS = { subtract: SUBTRACTION, intersect: INTERSECTION };
/** Carried through a cut when both sides have them at the same item size. The
 * evaluator throws on an attribute one side lacks, so the rest are dropped. */
const CARRIED = ["position", "normal", "uv", "color"];

/**
 * three-bvh-csg 0.0.18 prepares a brush with the BVH option `maxLeafSize`, and
 * three-mesh-bvh 0.9 warns about it on every build: two warnings per cut that
 * would bury a real one. This is the same preparation with the current option.
 * A sculpt brush is prepared once and evaluated synchronously, so it also
 * skips the SharedArrayBuffer copy that only the worker path needs.
 */
class SculptBrush extends Brush {
	prepareGeometry() {
		const { geometry } = this;
		geometry.boundsTree = new MeshBVH(geometry, { targetLeafSize: 3, indirect: true });
		geometry.halfEdges = new HalfEdgeMap();
		geometry.halfEdges.updateFrom(geometry);
		// Every triangle in group 0: the evaluator runs with useGroups off.
		geometry.groupIndices = new Uint16Array((geometry.index ?? geometry.getAttribute("position")).count / 3);
	}
}

/** A parent with vertex colours (a gradient look) would lose them against a
 * cutter without any, so the cutter borrows their mean. The parent keeps its
 * colours, and the cut faces take its average tone. */
function lendColours(geometry, cutter) {
	const colour = geometry.getAttribute("color");
	if (!colour || cutter.hasAttribute("color")) return;
	const { count, itemSize } = colour;
	const mean = Array.from({ length: itemSize }, (_, k) => {
		let sum = 0;
		for (let i = 0; i < count; i += 1) sum += colour.getComponent(i, k);
		return sum / count;
	});
	const lent = new THREE.BufferAttribute(new colour.array.constructor(cutter.getAttribute("position").count * itemSize), itemSize, colour.normalized);
	for (let i = 0; i < lent.count; i += 1) for (let k = 0; k < itemSize; k += 1) lent.setComponent(i, k, mean[k]);
	cutter.setAttribute("color", lent);
}

/** `geometry` cut by `cutter` (already in the same frame), as a new geometry. Throws when the cut fails. */
function evaluate(geometry, cutter, operation) {
	lendColours(geometry, cutter);
	const evaluator = new Evaluator();
	evaluator.useGroups = false;
	// Constrained Delaunay clipping leaves far fewer T-junctions than the legacy
	// splitter and handles coplanar faces, such as a cutter exactly as deep as its wall.
	evaluator.useCDTClipping = true;
	evaluator.attributes = CARRIED.filter((name) => geometry.hasAttribute(name) && geometry.getAttribute(name).itemSize === cutter.getAttribute(name)?.itemSize);
	const a = new SculptBrush(geometry), b = new SculptBrush(cutter);
	try {
		a.updateMatrixWorld();
		b.updateMatrixWorld();
		const result = evaluator.evaluate(a, b, operation).geometry;
		const points = result.getAttribute("position")?.array ?? [];
		const reason = result.drawRange.count < 3 ? "it leaves nothing" : points.every(Number.isFinite) ? null : "it yields non-finite points";
		if (reason) {
			result.dispose();
			throw new Error(reason);
		}
		if (!result.hasAttribute("normal")) result.computeVertexNormals();
		return result;
	} finally {
		a.disposeCacheData();
		b.disposeCacheData();
	}
}

/**
 * `geometry` (built for `part`, in its own frame) cut by every cutter whose
 * parent is `part`, in recipe order. `parts` is expandSculptParts' list and
 * `build(cutter)` makes a cutter's geometry. Whatever the cuts replace is
 * disposed here; the geometry returned belongs to the caller.
 */
export function cutSculptGeometry(geometry, part, parts, build) {
	let cut = geometry;
	let parentInverse = null;
	for (const cutter of parts) {
		if (!cutter.op || cutter.parent !== part.id) continue;
		parentInverse ??= new THREE.Matrix4().fromArray(part.matrix).invert();
		const tool = build(cutter).applyMatrix4(new THREE.Matrix4().fromArray(cutter.matrix).premultiply(parentInverse));
		try {
			const next = evaluate(cut, tool, OPERATIONS[cutter.op]);
			cut.dispose();
			cut = next;
		} catch (error) {
			console.warn(`sculpt: skipped ${cutter.op} "${cutter.id}" on "${part.id}" (${error.message}); the part is drawn without that cut`);
		} finally {
			tool.dispose();
		}
	}
	return cut;
}
