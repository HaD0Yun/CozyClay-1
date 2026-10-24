/**
 * Geometry for the `loft` and `convex` sculpt shapes. The points come from the
 * pure modules (sculpt-loft-rings.js, sculpt-shapes-loft-convex.js), so the
 * silhouette compare hulls exactly what is drawn; three.js only skins them.
 */

import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import { LoftGeometry } from "three/examples/jsm/geometries/LoftGeometry.js";
import { loftRings } from "./sculpt-loft-rings.js";
import { convexPoints } from "./sculpt-shapes-loft-convex.js";

/** An unsmoothed loft keeps edges sharper than this crisp; a rounded corner's
 * small steps still shade as one curve. */
const LOFT_CREASE = (40 * Math.PI) / 180;

/**
 * Normals for a non-indexed mesh: each corner averages the area-weighted
 * normals of the faces that share its exact position and turn less than
 * `crease` from its own face. (BufferGeometryUtils.toCreasedNormals hashes
 * positions to 1 cm, which merges the corners of a small gem.)
 */
function creaseNormals(geometry, crease) {
	const position = geometry.getAttribute("position");
	const key = (i) => `${position.getX(i)},${position.getY(i)},${position.getZ(i)}`;
	const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
	const faceNormals = [];
	const facesAt = new Map();
	for (let f = 0; f < position.count / 3; f += 1) {
		a.fromBufferAttribute(position, 3 * f);
		b.fromBufferAttribute(position, 3 * f + 1);
		c.fromBufferAttribute(position, 3 * f + 2);
		faceNormals.push(new THREE.Vector3().subVectors(c, b).cross(a.sub(b)));
		for (let k = 0; k < 3; k += 1) {
			const at = key(3 * f + k);
			if (!facesAt.has(at)) facesAt.set(at, []);
			facesAt.get(at).push(f);
		}
	}
	const limit = Math.cos(crease);
	const previous = geometry.getAttribute("normal");
	const normals = new Float32Array(position.count * 3);
	const own = new THREE.Vector3(), other = new THREE.Vector3(), sum = new THREE.Vector3();
	for (let i = 0; i < position.count; i += 1) {
		own.copy(faceNormals[Math.floor(i / 3)]).normalize();
		sum.set(0, 0, 0);
		for (const f of facesAt.get(key(i))) if (other.copy(faceNormals[f]).normalize().dot(own) >= limit) sum.add(faceNormals[f]);
		// A zero-area face has no direction of its own: it keeps the one it had.
		if (sum.lengthSq() === 0) sum.fromBufferAttribute(previous, i);
		sum.normalize().toArray(normals, 3 * i);
	}
	geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
}

/** Box-projected uvs per triangle: each facet maps the two axes it faces
 * most squarely, scaled by size, so a facet's texture is never smeared. */
function boxUvs(geometry, size) {
	const position = geometry.getAttribute("position");
	const uvs = new Float32Array(position.count * 2);
	const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
	for (let f = 0; f < position.count / 3; f += 1) {
		a.fromBufferAttribute(position, 3 * f);
		b.fromBufferAttribute(position, 3 * f + 1);
		c.fromBufferAttribute(position, 3 * f + 2);
		const n = c.sub(b).cross(a.sub(b));
		const facing = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)];
		const axis = facing.indexOf(Math.max(...facing));
		const [u, v] = [[2, 1], [0, 2], [0, 1]][axis];
		for (let k = 0; k < 3; k += 1) {
			uvs[(3 * f + k) * 2] = position.getComponent(3 * f + k, u) / size[u] + 0.5;
			uvs[(3 * f + k) * 2 + 1] = position.getComponent(3 * f + k, v) / size[v] + 0.5;
		}
	}
	geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
}

function loftGeometry(part) {
	const sections = loftRings(part).rings.map((ring) => ring.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
	const geometry = new LoftGeometry(sections, { capStart: true, capEnd: true });
	// The caps come last, one vertex per ring point each, and are level (every
	// section is horizontal). Earcut leaves zero-area slivers between collinear
	// samples, whose computed normals can be zero, so the caps are set outright.
	const normal = geometry.getAttribute("normal"), first = normal.count - 2 * sections[0].length;
	for (let i = first; i < normal.count; i += 1) normal.setXYZ(i, 0, i < first + sections[0].length ? -1 : 1, 0);
	if (part.smooth) return geometry;
	const faceted = geometry.toNonIndexed();
	geometry.dispose();
	creaseNormals(faceted, LOFT_CREASE);
	return faceted;
}

/** ConvexGeometry gives flat facet normals; `facets: false` smooths them all. */
function convexGeometry(part) {
	const geometry = new ConvexGeometry(convexPoints(part).map(([x, y, z]) => new THREE.Vector3(x, y, z)));
	boxUvs(geometry, part.size);
	if (!part.facets) creaseNormals(geometry, Math.PI);
	return geometry;
}

export const LOFT_CONVEX_BUILDERS = Object.freeze({ loft: loftGeometry, convex: convexGeometry });
