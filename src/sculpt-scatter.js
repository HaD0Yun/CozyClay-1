/**
 * Scatter geometry: `count` copies of one small item (sculpt-scatter-items.js)
 * as ONE InstancedMesh, laid out from the part's seed. The contract is in
 * sculpt-scatter-shape.js.
 *
 * - Ground items take a low-discrepancy (R2) spread with a little jitter, so
 *   a field is even without looking planted in rows.
 * - Shell items take an area-uniform spread over the ellipsoid, leaning
 *   further off its normal than ground items so a crown looks leafy, not scaly.
 * - Every item is fitted inside the size box by its turned vertices: one that
 *   would poke out is pulled in, one larger than the box is shrunk. The
 *   record's measured box trusts size, so it holds.
 * - A mirrored copy is seeded like its source and reflects each item's place
 *   and turn (position x and the quaternion's y, z), so the pair is symmetric.
 */

import * as THREE from "three";
import { scatterItem } from "./sculpt-scatter-items.js";
import { isMirrorCopy, partSeed, seededRandom } from "./sculpt-noise.js";

const UP = new THREE.Vector3(0, 1, 0);
const SIDE = new THREE.Vector3(1, 0, 0);
const DEG = Math.PI / 180;
/** Extra lean on a shell, in degrees. */
const SHELL_LEAN = 25;
/** The R2 sequence's steps (1/g, 1/g² for the plastic number g). */
const R2 = [0.7548776662466927, 0.5698402909980532];

/** Surface area of an ellipsoid (Knud Thomsen, within about 1%). */
function ellipsoidArea(a, b, c) {
	const p = 1.6075;
	return 4 * Math.PI * (((a * b) ** p + (a * c) ** p + (b * c) ** p) / 3) ** (1 / p);
}

/** A point on the ellipsoid with semi-axes `axes`, area-uniform, and its outward normal. */
function shellPoint(axes, random, point, normal) {
	const [a, b, c] = axes, least = Math.min(a, b, c);
	for (let tries = 0; ; tries += 1) {
		const y = random() * 2 - 1, angle = random() * 2 * Math.PI, r = Math.sqrt(1 - y * y);
		const dx = r * Math.cos(angle), dz = r * Math.sin(angle);
		normal.set(dx / a, y / b, dz / c);
		// Stretching a sphere into an ellipsoid stretches area by |normal| · abc; keep points in proportion.
		if (random() <= normal.length() * least || tries >= 32) {
			point.set(dx * a, y * b, dz * c);
			normal.normalize();
			return;
		}
	}
}

/** The box (low, high per axis) of `points` turned by `q` and scaled, around the item's origin. */
function turnedExtent(points, q, scale, low, high) {
	low.fill(Infinity);
	high.fill(-Infinity);
	// Quaternion rotation written out: this runs for every vertex of every item.
	const { x: qx, y: qy, z: qz, w: qw } = q;
	for (let i = 0; i < points.length; i += 3) {
		const x = points[i], y = points[i + 1], z = points[i + 2];
		const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
		const rx = (x + qw * tx + qy * tz - qz * ty) * scale, ry = (y + qw * ty + qz * tx - qx * tz) * scale, rz = (z + qw * tz + qx * ty - qy * tx) * scale;
		if (rx < low[0]) low[0] = rx;
		if (rx > high[0]) high[0] = rx;
		if (ry < low[1]) low[1] = ry;
		if (ry > high[1]) high[1] = ry;
		if (rz < low[2]) low[2] = rz;
		if (rz > high[2]) high[2] = rz;
	}
}

export function scatterMesh(part, material) {
	const item = scatterItem(part.item);
	const mesh = new THREE.InstancedMesh(item.geometry.clone(), material, part.count);
	const half = part.size.map((value) => value / 2);
	const random = seededRandom(partSeed(part, part.seed));
	const shell = part.spread === "shell";
	const { min, max } = item.geometry.boundingBox;
	const height = max.y - min.y, length = Math.max(max.x - min.x, max.z - min.z);
	const points = item.points;
	const spacing = Math.sqrt((shell ? ellipsoidArea(...half) : part.size[0] * part.size[2]) / part.count);
	const nominal = !shell && item.stand ? part.size[1] / height : (item.cover * spacing) / (item.stand ? height : length);
	const lean = (item.tilt + (shell ? SHELL_LEAN : 0)) * DEG;
	// Shell anchors sit inside the ellipsoid by about an item's outward reach, so the items end near its surface.
	const outward = nominal * (item.stand ? height : height + 0.5 * length * Math.sin(lean)) * 0.85;
	const axes = half.map((h) => Math.max(h - outward, h * 0.35));
	const start = [random(), random()], jitter = 0.35 / Math.sqrt(part.count);
	const point = new THREE.Vector3(), up = new THREE.Vector3();
	const tilt = new THREE.Quaternion(), spin = new THREE.Quaternion(), turn = new THREE.Quaternion();
	const matrix = new THREE.Matrix4(), scaled = new THREE.Vector3();
	const low = [0, 0, 0], high = [0, 0, 0], bounds = new THREE.Box3();
	for (let i = 0; i < part.count; i += 1) {
		if (shell) shellPoint(axes, random, point, up);
		else {
			const u = (start[0] + i * R2[0]) % 1 + (random() - 0.5) * jitter, v = (start[1] + i * R2[1]) % 1 + (random() - 0.5) * jitter;
			point.set((u - 0.5) * part.size[0], -half[1], (v - 0.5) * part.size[2]);
			up.copy(UP);
		}
		let scale = nominal * (0.6 + 0.4 * random());
		spin.setFromAxisAngle(UP, random() * 2 * Math.PI);
		tilt.setFromAxisAngle(SIDE, random() * lean);
		turn.setFromUnitVectors(UP, up).multiply(tilt).multiply(spin);
		turnedExtent(points, turn, scale, low, high);
		const fit = Math.min(1, ...half.map((h, axis) => (2 * h * 0.999) / (high[axis] - low[axis])));
		scale *= fit;
		for (let axis = 0; axis < 3; axis += 1) {
			const lo = low[axis] * fit, hi = high[axis] * fit;
			// Ground items stand on the bottom face; everything else is pulled inside the box.
			const value = !shell && axis === 1 ? -half[1] - lo : THREE.MathUtils.clamp(point.getComponent(axis), -half[axis] - lo, half[axis] - hi);
			point.setComponent(axis, value);
			bounds.min.setComponent(axis, Math.min(bounds.min.getComponent(axis), value + lo));
			bounds.max.setComponent(axis, Math.max(bounds.max.getComponent(axis), value + hi));
		}
		if (isMirrorCopy(part)) {
			point.x = -point.x;
			turn.set(turn.x, -turn.y, -turn.z, turn.w);
		}
		mesh.setMatrixAt(i, matrix.compose(point, turn, scaled.setScalar(scale)));
	}
	mesh.instanceMatrix.needsUpdate = true;
	// The fitted outline, not three's box-of-boxes (which turns each item's box and overshoots size).
	if (isMirrorCopy(part)) [bounds.min.x, bounds.max.x] = [-bounds.max.x, -bounds.min.x];
	mesh.boundingBox = bounds;
	mesh.boundingSphere = bounds.getBoundingSphere(new THREE.Sphere());
	return mesh;
}
