#!/usr/bin/env node
// Sculpt loft and convex shapes: a skin through stacked sections, and the hull
// of a point cloud (or a seeded rock). Bad data is refused with its path, the
// geometry never leaves the declared size (spline overshoot included), a
// mirror is a true reflection, and the silhouette compare keeps a waist.
import assert from "node:assert/strict";
import * as THREE from "three";
import { expandSculptParts, normalizeSculptRecipe, patchSculptRecipe, sculptBounds } from "../src/sculpt-recipe.js";
import { buildSculptGroup, disposeSculptGroup, sculptPartGeometry } from "../src/sculpt-geometry.js";
import { SCULPT_SHAPE_SPECS } from "../src/sculpt-shapes.js";
import { sculptViewPolygons } from "../src/sculpt-compare.js";
import { loftRings } from "../src/sculpt-loft-rings.js";

let failures = 0;
async function check(name, fn) {
	try {
		await fn();
		console.log(`PASS ${name}`);
	} catch (error) {
		failures += 1;
		console.log(`FAIL ${name} - ${error.stack?.split("\n").slice(0, 3).join(" | ") ?? error.message}`);
	}
}
const accepted = (input) => {
	const result = normalizeSculptRecipe(input);
	assert.equal(result.ok, true, result.error);
	return result.recipe;
};
const refused = (part, pattern) => {
	const result = normalizeSculptRecipe({ parts: [part] });
	assert.equal(result.ok, false, `expected a refusal for ${JSON.stringify(part).slice(0, 160)}`);
	assert.match(result.error, pattern);
};
const loft = (extra = {}) => ({ id: "l", shape: "loft", size: [0.6, 1, 0.4], sections: [{ y: 0, w: 1, d: 1 }, { y: 1, w: 0.5, d: 0.5 }], ...extra });
const rock = (extra = {}) => ({ id: "r", shape: "convex", size: [1.2, 0.8, 1], seed: 7, ...extra });
const octahedron = [[0.5, 0, 0], [-0.5, 0, 0], [0, 0.5, 0], [0, -0.5, 0], [0, 0, 0.5], [0, 0, -0.5]];
const onePart = (part) => accepted({ parts: [part] }).parts[0];

/** Signed volume: positive when every face winds outward, caps included. */
function signedVolume(geometry) {
	const position = geometry.getAttribute("position"), index = geometry.index;
	const count = index ? index.count : position.count;
	const at = (i) => new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(i) : i);
	let volume = 0;
	for (let i = 0; i < count; i += 3) volume += at(i).dot(at(i + 1).cross(at(i + 2))) / 6;
	return volume;
}

/** Every vertex inside ±size/2, a unit normal and a finite uv on each, and an outward winding. */
function assertSound(part, label = part.id) {
	const geometry = sculptPartGeometry(part);
	const position = geometry.getAttribute("position"), normal = geometry.getAttribute("normal"), uv = geometry.getAttribute("uv");
	assert.ok(normal && uv, `${label}: normal and uv attributes`);
	for (let i = 0; i < position.count; i += 1) {
		for (let axis = 0; axis < 3; axis += 1) {
			const value = position.getComponent(i, axis), half = part.size[axis] / 2;
			assert.ok(Math.abs(value) <= half + 1e-6, `${label}: vertex ${i} ${"xyz"[axis]} ${value} outside ±${half}`);
		}
		const n = new THREE.Vector3().fromBufferAttribute(normal, i);
		assert.ok(Math.abs(n.length() - 1) < 1e-3, `${label}: normal ${i} is unit (${n.length()})`);
		assert.ok(Number.isFinite(uv.getX(i)) && Number.isFinite(uv.getY(i)), `${label}: uv ${i} is finite`);
	}
	assert.ok(signedVolume(geometry) > 0, `${label}: faces wind outward`);
	geometry.dispose();
}

function seeded(seed) {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

/* ----------------------------------------------------------- contract ---- */

await check("a loft and a convex normalize with their defaults, and normalizing again changes nothing", () => {
	const recipe = accepted({
		parts: [
			loft({ sections: [{ y: 0, points: [[-0.5, -0.5], [0.5, -0.5], [0, 0.5]] }, { y: 0.5, w: 0.8, d: 0.6, x: 0.1 }, { y: 1, w: 0.2, d: 0.2, roundness: 1 }] }),
			rock(),
			{ id: "gem", shape: "convex", size: [0.1, 0.2, 0.1], points: octahedron, facets: false },
		],
	});
	assert.deepEqual(accepted(recipe), recipe);
	const [l, r, gem] = recipe.parts;
	assert.equal(l.smooth, true);
	assert.deepEqual(l.sections[1], { y: 0.5, w: 0.8, d: 0.6, x: 0.1, z: 0, roundness: 0.25 });
	assert.deepEqual(l.sections[0], { y: 0, points: [[-0.5, -0.5], [0.5, -0.5], [0, 0.5]] });
	assert.deepEqual([r.seed, r.facetCount, r.facets, "points" in r], [7, 16, true, false]);
	assert.deepEqual([gem.facets, "seed" in gem, gem.points.length], [false, false, 6]);
});

await check("a loft that cannot be drawn is refused with the field's path", () => {
	refused(loft({ sections: undefined }), /parts\[l\]\.sections: must be 2-12 sections/);
	refused(loft({ sections: [{ y: 0, w: 1, d: 1 }] }), /sections: must be 2-12 sections, got 1/);
	refused(loft({ sections: Array.from({ length: 13 }, (_, k) => ({ y: k / 12, w: 1, d: 1 })) }), /must be 2-12 sections, got 13/);
	refused(loft({ sections: [{ y: 0, w: 1, d: 1 }, { y: 0.5, w: 1, d: 1 }, { y: 0.5, w: 1, d: 1 }, { y: 1, w: 1, d: 1 }] }), /sections\[2\]\.y: must be above the section before it/);
	refused(loft({ sections: [{ y: 0.1, w: 1, d: 1 }, { y: 1, w: 1, d: 1 }] }), /sections: the first section must sit at y 0 and the last at y 1/);
	refused(loft({ sections: [{ y: 0, w: 1, d: 1 }, { y: 0.9, w: 1, d: 1 }] }), /last at y 1/);
	refused(loft({ sections: [{ y: 0, w: 1, d: 1 }, { y: 1, points: [[0, 0], [0.6, 0], [0, 0.5]] }] }), /sections\[1\]\.points\[1\]\[0\]: must be a number from -0\.5 to 0\.5/);
	refused(loft({ sections: [{ y: 0, w: 1, d: 1 }, { y: 1, points: [[0, 0], [0.5, 0]] }] }), /sections\[1\]\.points: must be 3-24 \[x, z\] points, got 2/);
	refused(loft({ sections: [{ y: 0, w: 1, d: 1 }, { y: 1, points: [[0, 0], [0.5, 0], [0.5]] }] }), /points\[2\]: must be \[x, z\] fractions/);
	refused(loft({ sections: [{ y: 0, w: 1, d: 1 }, { y: 1, points: [[0, 0], [0.2, 0.2], [0.4, 0.4]] }] }), /points: the outline encloses no area/);
	refused(loft({ sections: [{ y: 0, w: 1, d: 1 }, { y: 1, points: [[-0.5, -0.5], [0.5, 0.5], [0.5, -0.5], [-0.5, 0.5]] }] }), /points: edges 0 and 2 cross/);
	refused(loft({ sections: [{ y: 0, w: 0.8, d: 1, x: 0.2 }, { y: 1, w: 1, d: 1 }] }), /sections\[0\]\.x: the section reaches past the part's side/);
	refused(loft({ sections: [{ y: 0, w: 1, d: 0.5, z: -0.3 }, { y: 1, w: 1, d: 1 }] }), /sections\[0\]\.z: the section reaches past/);
	refused(loft({ sections: [{ y: 0, w: 0, d: 1 }, { y: 1, w: 1, d: 1 }] }), /sections\[0\]\.w: must be a number from 0\.01 to 1/);
	refused(loft({ sections: [{ y: 0, w: 1, d: 1, points: [[0, 0], [0.5, 0], [0, 0.5]] }, { y: 1, w: 1, d: 1 }] }), /sections\[0\]\.w: unknown key/);
	refused(loft({ sections: [{ y: 0, w: 1, d: 1, roundness: 2 }, { y: 1, w: 1, d: 1 }] }), /sections\[0\]\.roundness: must be a number from 0 to 1/);
	refused(loft({ sections: [7, { y: 1, w: 1, d: 1 }] }), /sections\[0\]: must be \{ y, points \} or \{ y, w, d \}/);
	refused(loft({ smooth: "yes" }), /parts\[l\]\.smooth: must be true or false/);
	refused({ id: "b", shape: "blob", size: [1, 1, 1], sections: [] }, /parts\[b\]\.sections: does not apply to a blob/);
});

await check("a convex that cannot be drawn is refused with the field's path", () => {
	refused({ id: "r", shape: "convex", size: [1, 1, 1] }, /parts\[r\]\.points: give either points/);
	refused(rock({ points: octahedron }), /parts\[r\]\.points: give either points.* not both/);
	refused(rock({ seed: undefined, points: octahedron.slice(0, 3) }), /points: must be 4-48 \[x, y, z\] points, got 3/);
	refused(rock({ seed: undefined, points: Array.from({ length: 49 }, (_, i) => [0, 0, i / 100 - 0.25]) }), /got 49/);
	refused(rock({ seed: undefined, points: [[0, 0, 0], [0.5, 0, 0], [0, 0.5, 0], [0.5, 0.5, 0], [0.2, 0.1, 0.005]] }), /points: the points lie \(nearly\) on one line or plane/);
	refused(rock({ seed: undefined, points: [[0, 0, 0], [0.1, 0.1, 0.1], [0.2, 0.2, 0.2], [0.3, 0.3, 0.3]] }), /one line or plane/);
	refused(rock({ seed: undefined, points: [...octahedron.slice(1), [0.7, 0, 0]] }), /points\[5\]\[0\]: must be a number from -0\.5 to 0\.5/);
	refused(rock({ seed: undefined, points: octahedron, facetCount: 12 }), /facetCount: applies to a seeded rock/);
	for (const seed of [-1, 1.5, "7", 2 ** 31]) refused(rock({ seed }), /parts\[r\]\.seed: must be a whole number from 0 to 2147483647/);
	for (const facetCount of [5, 41, 6.5]) refused(rock({ facetCount }), /parts\[r\]\.facetCount: must be a whole number from 6 to 40/);
	refused(rock({ facets: 1 }), /parts\[r\]\.facets: must be true or false/);
	refused({ id: "b", shape: "box", size: [1, 1, 1], seed: 3 }, /parts\[b\]\.seed: does not apply to a box/);
});

/* ----------------------------------------------------------- geometry ---- */

await check("every loft and convex vertex stays inside its size, with unit normals, uvs and outward faces", () => {
	const random = seeded(12345);
	const between = (min, max) => min + (max - min) * random();
	for (let n = 0; n < 120; n += 1) {
		const count = 2 + Math.floor(random() * 5);
		const sections = Array.from({ length: count }, (_, k) => {
			const y = k / (count - 1);
			if (random() < 0.5) {
				const w = between(0.05, 1), d = between(0.05, 1);
				return { y, w, d, x: between(-1, 1) * (0.5 - w / 2), z: between(-1, 1) * (0.5 - d / 2), roundness: random() };
			}
			// a star-shaped outline that reaches the box's sides
			const corners = 3 + Math.floor(random() * 22);
			const points = Array.from({ length: corners }, (_, i) => {
				const angle = (i / corners) * 2 * Math.PI, radius = between(0.25, 0.75);
				return [Math.max(-0.5, Math.min(0.5, Math.cos(angle) * radius)), Math.max(-0.5, Math.min(0.5, Math.sin(angle) * radius))];
			});
			return { y, points: random() < 0.5 ? points : points.reverse() };
		});
		assertSound(onePart(loft({ size: [between(0.05, 3), between(0.05, 3), between(0.05, 3)], sections, smooth: random() < 0.7 })), `loft #${n}`);
	}
	for (let seed = 0; seed < 60; seed += 1) {
		assertSound(onePart(rock({ seed, facetCount: 6 + (seed % 35), facets: seed % 3 !== 0, size: [between(0.01, 2), between(0.01, 2), between(0.01, 2)] })), `rock #${seed}`);
		const points = Array.from({ length: 4 + (seed % 45) }, () => [between(-0.5, 0.5), between(-0.5, 0.5), between(-0.5, 0.5)]);
		assertSound(onePart(rock({ seed: undefined, points, facets: seed % 2 === 0 })), `points #${seed}`);
	}
});

await check("a smooth loft draws the extents it declares: the spline is fitted, not clipped", () => {
	const square = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
	const part = onePart(loft({ size: [0.6, 1, 0.4], sections: [{ y: 0, points: square }, { y: 0.5, w: 0.3, d: 0.3, roundness: 1 }, { y: 1, points: square }] }));
	const geometry = sculptPartGeometry(part);
	geometry.computeBoundingBox();
	const { min, max } = geometry.boundingBox;
	for (const [value, expected] of [[max.x, 0.3], [min.x, -0.3], [max.y, 0.5], [min.y, -0.5], [max.z, 0.2], [min.z, -0.2]]) {
		assert.ok(Math.abs(value - expected) < 1e-6, `${value} reaches ${expected}`);
	}
	// The waist between the wide ends is drawn narrow: the cubic in y does not bulge.
	const waist = loftRings(part).rings.filter((ring) => Math.abs(ring[0][1]) < 1e-9)[0];
	assert.ok(Math.max(...waist.map(([x]) => Math.abs(x))) <= 0.3 * 0.3 + 1e-9, "the waist ring is the 0.3-wide circle");
});

await check("sections with different counts and windings skin without a twist", () => {
	const circle = Array.from({ length: 24 }, (_, i) => [0.5 * Math.cos((i / 24) * 2 * Math.PI), 0.5 * Math.sin((i / 24) * 2 * Math.PI)]);
	const square = [[-0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0.5, -0.5]];
	for (const smooth of [true, false]) {
		const { rings } = loftRings(onePart(loft({ size: [1, 1, 1], smooth, sections: [{ y: 0, points: square }, { y: 0.5, w: 0.6, d: 0.6, roundness: 0 }, { y: 1, points: circle.slice().reverse() }] })));
		const angle = ([x, , z]) => Math.atan2(z, x);
		for (let k = 1; k < rings.length; k += 1) {
			assert.equal(rings[k].length, rings[0].length, "every ring has the same point count");
			rings[k].forEach((point, j) => {
				const turn = Math.abs(((angle(point) - angle(rings[0][j]) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
				assert.ok(turn < (20 * Math.PI) / 180, `smooth ${smooth}: column ${j} turns ${((turn * 180) / Math.PI).toFixed(1)} deg by ring ${k}`);
			});
		}
	}
});

await check("a square base meets a thin ridge side to side, so a wedge roof's gable is flat", () => {
	const ridge = [[-0.5, -0.02], [0.5, -0.02], [0.5, 0.02], [-0.5, 0.02]];
	const { rings } = loftRings(onePart(loft({ size: [0.9, 0.5, 0.7], smooth: false, sections: [{ y: 0, w: 1, d: 1, roundness: 0 }, { y: 1, points: ridge }] })));
	const onSide = rings[0].map(([x], j) => [j, x]).filter(([, x]) => Math.abs(x - 0.45) < 1e-9);
	assert.ok(onSide.length >= 8, `${onSide.length} base samples on the +x side`);
	for (const [j] of onSide) assert.ok(Math.abs(rings[1][j][0] - 0.45) < 1e-9, `column ${j} rises to the ridge's end, not its middle (x ${rings[1][j][0]})`);
});

await check("a seed is the same rock every time; the rock fills its box with about facetCount facets", () => {
	const positions = (part) => Array.from(sculptPartGeometry(onePart(part)).getAttribute("position").array);
	assert.deepEqual(positions(rock()), positions(rock()));
	assert.notDeepEqual(positions(rock()), positions(rock({ seed: 8 })));
	for (const facetCount of [6, 7, 16, 25, 40]) {
		const geometry = sculptPartGeometry(onePart(rock({ facetCount })));
		assert.equal(geometry.getAttribute("position").count / 3, facetCount - (facetCount % 2), `facetCount ${facetCount}`);
		geometry.computeBoundingBox();
		const { min, max } = geometry.boundingBox;
		assert.ok([max.x - 0.6, min.x + 0.6, max.y - 0.4, min.y + 0.4, max.z - 0.5, min.z + 0.5].every((gap) => Math.abs(gap) < 1e-6), `touches all six sides: ${JSON.stringify(geometry.boundingBox)}`);
	}
	const flat = sculptPartGeometry(onePart(rock()));
	const smooth = sculptPartGeometry(onePart(rock({ facets: false })));
	assert.deepEqual(Array.from(flat.getAttribute("position").array), Array.from(smooth.getAttribute("position").array));
	assert.notDeepEqual(Array.from(flat.getAttribute("normal").array), Array.from(smooth.getAttribute("normal").array), "facets: false smooths the normals");
});

/* -------------------------------------------------------------- mirror ---- */

await check("a mirrored loft and a mirrored rock are reflections, not copies", () => {
	const outline = [[0.1, -0.5], [0.5, -0.2], [0.4, 0.5], [-0.5, 0.3]];
	const recipe = accepted({
		parts: [
			loft({ position: [0.4, 0, 0], mirror: true, sections: [{ y: 0, points: outline }, { y: 1, w: 0.4, d: 0.6, x: 0.3, z: -0.1 }] }),
			rock({ position: [1, 0, 0], mirror: true }),
		],
	});
	const byId = new Map(expandSculptParts(recipe).map((part) => [part.id, part]));
	const vertexSet = (part, flip) => {
		const position = sculptPartGeometry(part).getAttribute("position");
		const keys = new Set();
		for (let i = 0; i < position.count; i += 1) keys.add([position.getX(i) * flip, position.getY(i), position.getZ(i)].map((v) => v.toFixed(4)).join(","));
		return keys;
	};
	for (const id of ["l", "r"]) {
		const original = byId.get(id), copy = byId.get(`${id}.mirror`);
		assertSound(copy);
		const a = sculptPartGeometry(original), b = sculptPartGeometry(copy);
		a.computeBoundingBox();
		b.computeBoundingBox();
		assert.ok(Math.abs(a.boundingBox.max.x + b.boundingBox.min.x) < 1e-3 && Math.abs(a.boundingBox.min.x + b.boundingBox.max.x) < 1e-3, `${id}: x range flips`);
		assert.ok(Math.abs(signedVolume(a) - signedVolume(b)) < 1e-3 * Math.abs(signedVolume(a)), `${id}: same volume`);
	}
	assert.deepEqual(vertexSet(byId.get("r.mirror"), 1), vertexSet(byId.get("r"), -1), "the rock's copy is its exact reflection");
	assert.equal("seed" in byId.get("r.mirror"), false);
	assert.deepEqual(byId.get("l.mirror").sections[1], { y: 1, w: 0.4, d: 0.6, x: -0.3, z: -0.1, roundness: 0.25 });
	assert.deepEqual(byId.get("l.mirror").sections[0].points, outline.map(([x, z]) => [-x || 0, z]).reverse());
	assert.deepEqual(recipe.parts[0].sections[0].points, outline, "the stored recipe is untouched");
});

/* ------------------------------------------------------------- compare ---- */

await check("compare samples: one hull per loft span keeps a waist; a convex hulls its points", () => {
	const hourglass = onePart(loft({ size: [1, 1, 1], sections: [{ y: 0, w: 1, d: 1 }, { y: 0.5, w: 0.2, d: 0.2 }, { y: 1, w: 1, d: 1 }] }));
	assert.equal(SCULPT_SHAPE_SPECS.loft.samples(hourglass).length, 2);
	assert.equal(SCULPT_SHAPE_SPECS.convex.samples(onePart(rock({ seed: undefined, points: octahedron })))[0].length, 6);
	const polygons = sculptViewPolygons(accepted({ parts: [{ ...hourglass, position: [0, 0.5, 0] }] }));
	const inside = (polygon, x, y) => {
		let hit = false;
		for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
			const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
			if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
		}
		return hit;
	};
	const covered = (x, y) => polygons.some(({ polygon }) => inside(polygon, x, y));
	assert.ok(covered(0.4, 0.05) && covered(0.4, 0.95), "the wide ends are in the silhouette");
	assert.ok(!covered(0.4, 0.5), "the waist is not filled in");
});

/* ------------------------------------------------------- patch + build ---- */

await check("a patch can swap a seeded rock for points, and a blob for a loft", () => {
	const base = accepted({ parts: [rock(), { id: "b", shape: "blob", size: [1, 1, 1] }] });
	const swapped = patchSculptRecipe(base, [{ set: "r", seed: null, points: octahedron }]);
	assert.equal(swapped.ok, true, swapped.error);
	assert.deepEqual(Object.keys(swapped.recipe.parts[0]).sort(), ["color", "facets", "id", "points", "position", "rotation", "shape", "size"]);
	const lofted = patchSculptRecipe(base, [{ set: "b", shape: "loft", sections: [{ y: 0, w: 1, d: 1 }, { y: 1, w: 0.4, d: 0.4 }] }]);
	assert.equal(lofted.ok, true, lofted.error);
	assert.equal("roundness" in lofted.recipe.parts[1], false, "the blob's roundness is dropped");
	assert.equal(patchSculptRecipe(base, [{ set: "b", shape: "loft" }]).path, "parts[b].sections");
});

await check("a built recipe of lofts and rocks fits its stored bounds", () => {
	const recipe = accepted({
		parts: [
			loft({ size: [0.8, 1.8, 0.6], position: [0, 0.3, 0], rotation: [-90, 0, 0], sections: [{ y: 0, w: 0.9, d: 0.45, z: -0.27 }, { y: 0.4, w: 0.85, d: 1 }, { y: 0.75, w: 0.85, d: 1 }, { y: 1, w: 0.9, d: 0.4, z: -0.3 }] }),
			rock({ position: [1, 0.4, 0.2], rotation: [10, 30, -20], mirror: true }),
		],
	});
	const group = buildSculptGroup(recipe);
	group.updateMatrixWorld(true);
	const drawn = new THREE.Box3().setFromObject(group);
	const { min, max } = sculptBounds(recipe);
	for (const [i, key] of ["x", "y", "z"].entries()) {
		assert.ok(drawn.min[key] >= min[i] - 1e-3 && drawn.max[key] <= max[i] + 1e-3, `${key}: drawn ${drawn.min[key]}..${drawn.max[key]} vs ${min[i]}..${max[i]}`);
	}
	assert.deepEqual(group.children.map((mesh) => mesh.name), ["l", "r", "r.mirror"]);
	disposeSculptGroup(group);
});

if (failures) {
	console.log(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall sculpt loft/convex checks passed");
