/**
 * Sculpt colours for the shaded look, applied once per part by
 * buildSculptGroup after the part's material exists:
 *
 * - a `gradient` (sculpt-surface-fields.js) becomes a per-vertex `color`
 *   attribute blending the part's colour into the gradient's;
 * - a scatter's items each get a small seeded hue and brightness jitter (and
 *   the gradient, by where the item sits), so a field is not one flat swatch.
 *
 * The colour then lives in the vertex or instance colours, so the material's
 * own colour goes white and `vertexColors` turns on (a texture map still
 * multiplies in). A flat display mode (auto-colour, through materialFor)
 * skips this, so it ignores gradients and jitter.
 */

import * as THREE from "three";
import { isMirrorCopy, partSeed, seededRandom } from "./sculpt-noise.js";

const AXES = { x: 0, y: 1, z: 2 };
/** Item-to-item spread: hue ± this (of the wheel), brightness × 1 ± this. */
const JITTER_HUE = 0.025;
const JITTER_SHADE = 0.16;

/** How far a local point is along the gradient: 0 at `from` (part colour), 1 at `to`. */
function blend(part, x, y, z) {
	const { axis, from, to } = part.gradient;
	const i = AXES[axis];
	// A mirrored copy reads its x reversed, so an x gradient reflects with the part.
	const along = [isMirrorCopy(part) ? -x : x, y, z][i] / part.size[i] + 0.5;
	if (to === from) return along >= to ? 1 : 0;
	return THREE.MathUtils.clamp((along - from) / (to - from), 0, 1);
}

export function applySculptColours(mesh, part) {
	if (!part.gradient && !mesh.isInstancedMesh) return;
	const base = new THREE.Color(part.color);
	const end = part.gradient ? new THREE.Color(part.gradient.color) : null;
	const colour = new THREE.Color();
	if (mesh.isInstancedMesh) {
		const random = seededRandom(partSeed(part, part.seed + 1));
		const matrix = new THREE.Matrix4(), at = new THREE.Vector3();
		for (let i = 0; i < mesh.count; i += 1) {
			colour.copy(base);
			if (end) {
				at.setFromMatrixPosition(mesh.getMatrixAt(i, matrix));
				colour.lerp(end, blend(part, at.x, at.y, at.z));
			}
			colour.offsetHSL((random() * 2 - 1) * JITTER_HUE, 0, 0).multiplyScalar(1 + (random() * 2 - 1) * JITTER_SHADE);
			mesh.setColorAt(i, colour);
		}
		mesh.instanceColor.needsUpdate = true;
	} else {
		const position = mesh.geometry.getAttribute("position");
		const colours = new Float32Array(position.count * 3);
		for (let i = 0; i < position.count; i += 1) {
			colour.copy(base).lerp(end, blend(part, position.getX(i), position.getY(i), position.getZ(i))).toArray(colours, 3 * i);
		}
		mesh.geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
	}
	for (const material of [mesh.material].flat()) {
		material.color?.set(0xffffff);
		material.vertexColors = !!mesh.geometry.getAttribute("color");
		material.needsUpdate = true;
	}
}
