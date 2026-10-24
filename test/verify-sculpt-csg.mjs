#!/usr/bin/env node
// Sculpt cutters: a part with `op` is not drawn; it subtracts from or clips
// its parent's geometry (windows, doors, hollow bowls, half-domes). Bad data
// is refused with its path, the cut lands in the parent's own frame, the
// standing box never grows, and a failed boolean keeps the uncut part.
import assert from "node:assert/strict";
import * as THREE from "three";
import { SCULPT_LIMITS, normalizeSculptRecipe, patchSculptRecipe, sculptBounds, sculptStandingBox, expandSculptParts } from "../src/sculpt-recipe.js";
import { buildSculptGroup, disposeSculptGroup, sculptPartGeometry } from "../src/sculpt-geometry.js";
import { cutSculptGeometry } from "../src/sculpt-csg.js";
import { sculptViewPolygons } from "../src/sculpt-compare.js";

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
/** Runs `fn` with console.warn captured; returns [result, warnings]. */
function quietly(fn) {
	const warn = console.warn, warnings = [];
	console.warn = (...args) => warnings.push(args.join(" "));
	try { return [fn(), warnings]; } finally { console.warn = warn; }
}
const accepted = (parts) => {
	const result = normalizeSculptRecipe({ version: 1, parts });
	assert.equal(result.ok, true, result.error);
	return result.recipe;
};
const refused = (parts, path, pattern) => {
	const result = normalizeSculptRecipe({ version: 1, parts });
	assert.equal(result.ok, false, `expected a refusal for ${JSON.stringify(parts).slice(0, 160)}`);
	assert.equal(result.path, path);
	assert.match(result.error, pattern);
};
const wall = (extra = {}) => ({ id: "wall", shape: "box", size: [2, 2, 0.2], roundness: 0, position: [0, 1, 0], ...extra });
const windowCut = (extra = {}) => ({ id: "window", shape: "box", size: [0.5, 0.5, 0.4], roundness: 0, parent: "wall", position: [0.5, 0.3, 0], op: "subtract", ...extra });
const triangles = (geometry) => Math.min(geometry.drawRange.count, geometry.index.count) / 3;
/** Hits along the mesh's own -z axis through its local point (x, y). */
function hitsThrough(mesh, x, y) {
	mesh.updateWorldMatrix(true, false);
	const origin = new THREE.Vector3(x, y, 5).applyMatrix4(mesh.matrixWorld);
	const direction = new THREE.Vector3(0, 0, -1).transformDirection(mesh.matrixWorld);
	return new THREE.Raycaster(origin, direction).intersectObject(mesh).length;
}
function build(parts) {
	const [group, warnings] = quietly(() => buildSculptGroup(accepted(parts)));
	group.updateMatrixWorld(true);
	return { group, warnings, mesh: (name) => group.getObjectByName(name) };
}

/* ----------------------------------------------------------- contract ---- */

await check("op is read, kept by a second normalize, and the cutter still counts as a part", () => {
	const recipe = accepted([wall(), windowCut({ mirror: true }), windowCut({ id: "dome", op: "intersect" })]);
	assert.deepEqual(recipe.parts.map((part) => part.op), [undefined, "subtract", "intersect"]);
	assert.deepEqual(normalizeSculptRecipe(recipe).recipe, recipe);
	assert.deepEqual(expandSculptParts(recipe).map((part) => part.id), ["wall", "window", "window.mirror", "dome"]);
});

await check("bad op values and cutters without a parent are refused at the op", () => {
	refused([wall(), windowCut({ op: "union" })], "parts[window].op", /must be "subtract" or "intersect", got "union"/);
	refused([wall(), windowCut({ op: true })], "parts[window].op", /must be "subtract" or "intersect"/);
	refused([wall(), windowCut({ op: null })], "parts[window].op", /got null/);
	refused([wall({ op: "subtract" })], "parts[wall].op", /a cutter needs a parent/);
});

await check("a cutter carries no parts: no drawn child and no cutter of a cutter", () => {
	refused([wall(), windowCut(), { id: "sill", shape: "box", size: [0.5, 0.05, 0.1], parent: "window" }], "parts[sill].parent", /"window" is a cutter .* use parent "wall" instead/);
	refused([wall(), windowCut(), windowCut({ id: "notch", parent: "window" })], "parts[notch].parent", /only cuts drawn parts; give this one parent "wall"/);
});

await check("cutters count toward maxParts, mirrors included", () => {
	const cutters = (count) => Array.from({ length: count }, (_, i) => windowCut({ id: `w${i}`, size: [0.05, 0.05, 0.4], position: [0.1 + i * 0.03, 0, 0], mirror: true }));
	accepted([wall(), ...cutters((SCULPT_LIMITS.maxParts - 2) / 2), windowCut()]);
	const over = normalizeSculptRecipe({ parts: [wall(), ...cutters(SCULPT_LIMITS.maxParts / 2)] });
	assert.equal(over.ok, false);
	assert.match(over.error, /expands to 49 parts/);
});

await check("edits keep the cutter rules: clearing its parent or hanging a part on it is refused", () => {
	const recipe = accepted([wall(), windowCut()]);
	assert.match(patchSculptRecipe(recipe, [{ set: "window", parent: null }]).error, /parts\[window\]\.op: a cutter needs a parent/);
	assert.match(patchSculptRecipe(recipe, [{ add: { id: "sill", shape: "box", size: [0.5, 0.05, 0.1], parent: "window" } }]).error, /"window" is a cutter/);
	const moved = patchSculptRecipe(recipe, [{ set: "window", position: [-0.5, 0.3, 0] }]);
	assert.equal(moved.ok, true, moved.error);
	assert.deepEqual(moved.changed, ["window"]);
});

/* ------------------------------------------------------------ geometry ---- */

await check("a subtracted window: not drawn, the wall gains triangles, rays miss the opening and hit the wall", () => {
	const { group, warnings, mesh } = build([wall({ rotation: [0, 35, 10] }), windowCut()]);
	assert.deepEqual(warnings, []);
	assert.deepEqual(group.children.map((child) => child.name), ["wall"]);
	const cut = mesh("wall");
	assert.equal(cut.userData.sculptPart, "wall");
	assert.ok(cut.castShadow && cut.receiveShadow);
	assert.ok(triangles(cut.geometry) > 12, `${triangles(cut.geometry)} triangles vs a box's 12`);
	assert.equal(hitsThrough(cut, 0.5, 0.3), 0, "the window centre is open");
	assert.equal(hitsThrough(cut, 0.5 + 0.2, 0.3 - 0.2), 0, "near the window's corner is open too");
	assert.ok(hitsThrough(cut, -0.5, 0.3) > 0, "the wall beside it is solid");
	assert.ok(hitsThrough(cut, 0.5, -0.5) > 0, "the wall below it is solid");
	const hit = new THREE.Raycaster(new THREE.Vector3(-0.5, 1.3, 5), new THREE.Vector3(0, 0, -1)).intersectObject(group, true)[0];
	assert.equal(hit?.object.userData.sculptPart, "wall", "a pick still names the part");
	disposeSculptGroup(group);
});

await check("a cutter exactly as deep as its wall still cuts through (coplanar faces)", () => {
	const { mesh, warnings } = build([wall(), windowCut({ size: [0.5, 0.5, 0.2] })]);
	assert.deepEqual(warnings, []);
	assert.equal(hitsThrough(mesh("wall"), 0.5, 0.3), 0);
	assert.ok(hitsThrough(mesh("wall"), 0, -0.5) > 0);
});

await check("a mirrored cutter cuts both sides, and a mirrored parent takes its cutter along", () => {
	const { mesh } = build([wall(), windowCut({ mirror: true })]);
	assert.equal(hitsThrough(mesh("wall"), 0.5, 0.3), 0);
	assert.equal(hitsThrough(mesh("wall"), -0.5, 0.3), 0);
	assert.ok(hitsThrough(mesh("wall"), 0, 0.3) > 0, "between the windows is solid");
	const eyes = build([
		{ id: "eye", shape: "box", size: [0.4, 0.4, 0.2], roundness: 0, position: [0.4, 1, 0], mirror: true },
		{ id: "pupil", shape: "cylinder", size: [0.1, 0.4, 0.1], parent: "eye", rotation: [90, 0, 0], op: "subtract" },
	]);
	assert.deepEqual(eyes.group.children.map((child) => child.name), ["eye", "eye.mirror"]);
	for (const name of ["eye", "eye.mirror"]) {
		assert.equal(hitsThrough(eyes.mesh(name), 0, 0), 0, `${name} has its hole`);
		assert.ok(hitsThrough(eyes.mesh(name), 0.15, 0) > 0, `${name} is solid around it`);
	}
});

await check("several cutters apply in recipe order: an arched door is a box and a cylinder", () => {
	const { mesh, warnings } = build([
		wall(),
		{ id: "door", shape: "box", size: [0.6, 1.1, 0.4], roundness: 0, parent: "wall", position: [0, -0.5, 0], op: "subtract" },
		{ id: "arch", shape: "cylinder", size: [0.6, 0.4, 0.6], parent: "wall", position: [0, 0.05, 0], rotation: [90, 0, 0], op: "subtract" },
	]);
	assert.deepEqual(warnings, []);
	const door = mesh("wall");
	assert.equal(hitsThrough(door, 0, -0.8), 0, "the doorway");
	assert.equal(hitsThrough(door, 0, 0.25), 0, "under the arch");
	assert.ok(hitsThrough(door, 0.27, 0.3) > 0, "the arch's shoulder stays");
	assert.ok(hitsThrough(door, 0, 0.5) > 0, "above the arch");
});

await check("intersect clips: a sphere and a box above its centre make a half-dome", () => {
	const { mesh } = build([
		{ id: "dome", shape: "blob", size: [1, 1, 1], roundness: 0, position: [0, 0.5, 0] },
		{ id: "upper", shape: "box", size: [1.2, 0.6, 1.2], roundness: 0, parent: "dome", position: [0, 0.3, 0], op: "intersect" },
	]);
	const box = new THREE.Box3().setFromObject(mesh("dome"));
	assert.ok(Math.abs(box.min.y - 0.5) < 1e-3, `flat base at the centre (${box.min.y})`);
	assert.ok(Math.abs(box.max.y - 1) < 1e-3 && Math.abs(box.max.x - 0.5) < 2e-3, JSON.stringify(box));
	const up = new THREE.Raycaster(new THREE.Vector3(0.1, -1, 0.1), new THREE.Vector3(0, 1, 0)).intersectObject(mesh("dome"))[0];
	assert.ok(Math.abs(up.point.y - 0.5) < 1e-3, `a ray from below meets the flat base (${up?.point.y})`);
});

await check("a hollow bowl: a ray from above lands on the inner floor, not the top", () => {
	const { mesh } = build([
		{ id: "bowl", shape: "blob", size: [1, 0.5, 1], roundness: 0.3, position: [0, 0.25, 0] },
		{ id: "hollow", shape: "blob", size: [0.88, 0.5, 0.88], roundness: 0.3, parent: "bowl", position: [0, 0.07, 0], op: "subtract" },
	]);
	const first = new THREE.Raycaster(new THREE.Vector3(0.05, 3, 0.05), new THREE.Vector3(0, -1, 0)).intersectObject(mesh("bowl"))[0];
	assert.ok(first.point.y < 0.1 && first.point.y > 0.05, `inner floor at ${first.point.y}`);
});

await check("the standing box and the compare silhouette ignore cutters that poke out", () => {
	const cup = [
		{ id: "cup", shape: "cylinder", size: [0.4, 0.5, 0.4], position: [0, 0.25, 0] },
		{ id: "inside", shape: "cylinder", size: [0.34, 0.9, 0.34], parent: "cup", position: [0, 0.5, 0], op: "subtract" },
		{ id: "slice", shape: "box", size: [3, 3, 3], roundness: 0, parent: "cup", position: [1.6, 0, 0], op: "intersect" },
	];
	const alone = accepted([cup[0]]), cut = accepted(cup);
	assert.deepEqual(sculptBounds(cut), sculptBounds(alone));
	assert.deepEqual(sculptStandingBox(cut), sculptStandingBox(alone));
	assert.deepEqual(sculptViewPolygons(cut).map((row) => row.id), ["cup"]);
	const { group } = build(cup);
	const drawn = new THREE.Box3().setFromObject(group);
	const { min, max } = sculptBounds(cut);
	for (const [i, key] of ["x", "y", "z"].entries()) assert.ok(drawn.min[key] >= min[i] - 1e-3 && drawn.max[key] <= max[i] + 1e-3, `${key}: drawn ${drawn.min[key]}..${drawn.max[key]}`);
	assert.ok(Math.abs(drawn.min.x - 0.1) < 1e-3, `the slice keeps x >= 0.1 (${drawn.min.x})`);
});

/* ------------------------------------------------- failures and upkeep ---- */

await check("a cut that would leave nothing falls back to the uncut part, with a warning, every time", () => {
	const swallow = [wall(), windowCut({ size: [3, 3, 1], position: [0, 0, 0] })];
	const miss = [wall(), windowCut({ position: [5, 0, 0], op: "intersect" })];
	for (const parts of [swallow, miss]) {
		const first = build(parts), second = build(parts);
		assert.equal(first.warnings.length, 1);
		assert.match(first.warnings[0], /skipped (subtract|intersect) "window" on "wall" \(it leaves nothing\)/);
		assert.equal(triangles(first.mesh("wall").geometry), 12, "the uncut box");
		assert.ok(hitsThrough(first.mesh("wall"), 0.5, 0.3) > 0);
		assert.deepEqual(second.warnings, first.warnings);
	}
});

await check("a boolean that throws (degenerate cutter) keeps the geometry from before that cut", () => {
	const recipe = accepted([wall(), windowCut(), windowCut({ id: "low", position: [0, -0.5, 0] }), windowCut({ id: "broken", position: [-0.5, 0.3, 0] })]);
	const parts = expandSculptParts(recipe);
	const made = [];
	const make = (part) => {
		const geometry = part.id === "broken" ? new THREE.BufferGeometry() : sculptPartGeometry(part);
		made.push(geometry);
		return geometry;
	};
	const [cut, warnings] = quietly(() => cutSculptGeometry(sculptPartGeometry(parts[0]), parts[0], parts, make));
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /skipped subtract "broken" on "wall"/);
	const mesh = new THREE.Mesh(cut, new THREE.MeshBasicMaterial());
	assert.equal(hitsThrough(mesh, 0.5, 0.3), 0, "the cuts before it stay");
	assert.equal(hitsThrough(mesh, 0, -0.5), 0);
	assert.ok(hitsThrough(mesh, -0.5, 0.3) > 0, "the broken cutter cut nothing");
	assert.equal(cut.boundsTree ?? cut.halfEdges ?? null, null, "the kept geometry carries no CSG cache");
	assert.equal(made.length, 3);
});

await check("same recipe, same geometry", () => {
	const parts = [wall({ roundness: 0.2 }), windowCut({ mirror: true, roundness: 0.3 })];
	const a = build(parts).mesh("wall").geometry, b = build(parts).mesh("wall").geometry;
	assert.deepEqual(Array.from(a.getAttribute("position").array), Array.from(b.getAttribute("position").array));
	assert.deepEqual(Array.from(a.index.array), Array.from(b.index.array));
});

await check("everything a cut replaces is disposed, and disposeSculptGroup frees the result", () => {
	const recipe = accepted([wall(), windowCut(), windowCut({ id: "two", position: [-0.5, 0.3, 0] })]);
	const parts = expandSculptParts(recipe);
	const disposed = new Set();
	const watch = (geometry) => (geometry.addEventListener("dispose", () => disposed.add(geometry)), geometry);
	const cutters = [];
	const original = watch(sculptPartGeometry(parts[0]));
	const [cut] = quietly(() => cutSculptGeometry(original, parts[0], parts, (part) => {
		const geometry = watch(sculptPartGeometry(part));
		cutters.push(geometry);
		return geometry;
	}));
	assert.equal(cutters.length, 2);
	assert.ok(disposed.has(original), "the uncut wall");
	assert.ok(cutters.every((geometry) => disposed.has(geometry)), "each cutter");
	assert.ok(!disposed.has(cut), "not the result");
	const { group, mesh } = build([wall(), windowCut()]);
	let freed = false;
	mesh("wall").geometry.addEventListener("dispose", () => { freed = true; });
	disposeSculptGroup(group);
	assert.ok(freed);
});

await check("vertex colours on the parent survive a cut; the cut faces take their mean", () => {
	const [part, cutter] = expandSculptParts(accepted([wall(), windowCut()]));
	const geometry = sculptPartGeometry(part);
	const count = geometry.getAttribute("position").count;
	geometry.setAttribute("color", new THREE.Float32BufferAttribute(Array.from({ length: count * 3 }, (_, i) => (i % 3 === 0 ? (Math.floor(i / 3) % 2) : 0.5)), 3));
	const [cut, warnings] = quietly(() => cutSculptGeometry(geometry, part, [part, cutter], sculptPartGeometry));
	assert.deepEqual(warnings, []);
	const colour = cut.getAttribute("color");
	assert.ok(colour && colour.count === cut.getAttribute("position").count);
	assert.ok(Array.from(colour.array).every((value) => value >= 0 && value <= 1));
});

await check("no BVH deprecation noise from a cut", () => {
	const { warnings } = build([wall(), windowCut({ mirror: true })]);
	assert.deepEqual(warnings, []);
});

if (failures) {
	console.log(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nverify-sculpt-csg: all checks passed");
