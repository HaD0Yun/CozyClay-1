#!/usr/bin/env node
// Material presets: a sculpt part's and a primitive's surface look is a name in
// the record (material, finish), refused when unknown, drawn by one factory,
// and the pattern textures it shares are never freed by one owner's dispose.
import assert from "node:assert/strict";
import * as THREE from "three";
import { normalizeSculptRecipe, patchSculptRecipe, expandSculptParts } from "../src/sculpt-recipe.js";
import { buildSculptGroup, disposeSculptGroup } from "../src/sculpt-geometry.js";
import { FINISH_ROUGHNESS, MATERIAL_FINISHES, MATERIAL_LOOKS, MATERIAL_PRESETS, lookTint } from "../src/material-presets.js";
import { lookMaterial } from "../src/material-look.js";
import { PATTERN_NAMES, PATTERN_SIZE, patternPixels } from "../src/material-textures.js";
import { normalizeSceneObject, updateSceneObject, objectPatchFields, serializeScene, loadScene } from "../src/scene-objects.js";
import { elementByPath } from "../src/studio-elements.js";
import { elementReadback, elementSetSchema } from "../src/commands/elements.js";
import { validateStudioSchema } from "../src/studio-agent-protocol.js";
import "../src/commands/elements/object.js";

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
const part = (id, extra = {}) => ({ id, shape: "box", size: [1, 0.2, 0.5], ...extra });
const recipeOf = (...parts) => {
	const result = normalizeSculptRecipe({ parts });
	assert.equal(result.ok, true, result.error);
	return result.recipe;
};
/** What a WebGL renderer hands onBeforeCompile, from three's own shader sources. */
const compileShader = (material) => {
	const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
	material.onBeforeCompile(shader, null);
	return shader;
};
const cube = (extra = {}) => normalizeSceneObject({ id: "box-1", renderer: "cube", x: 0, z: 0, ...extra });

/* ------------------------------------------------------------ recipe ---- */

await check("a part takes a preset and a finish; a recipe without them is unchanged", () => {
	const plain = recipeOf(part("a"));
	assert.equal("material" in plain.parts[0], false);
	assert.equal("finish" in plain.parts[0], false);
	const looked = recipeOf(part("cart", { color: "#c24a3b", material: "wood", finish: "gloss" }));
	assert.deepEqual([looked.parts[0].material, looked.parts[0].finish, looked.parts[0].color], ["wood", "gloss", "#c24a3b"]);
	assert.deepEqual(recipeOf(...looked.parts), looked, "normalizing again changes nothing");
	for (const name of MATERIAL_PRESETS) assert.equal(recipeOf(part("p", { material: name })).parts[0].material, name);
});

await check("an unknown preset or finish is refused with its path and the allowed names", () => {
	const bad = normalizeSculptRecipe({ parts: [part("roof", { material: "thatch" })] });
	assert.equal(bad.ok, false);
	assert.equal(bad.path, "parts[roof].material");
	assert.match(bad.error, /must be one of clay, wood, straw, .*foliage; got "thatch"/);
	const finish = normalizeSculptRecipe({ parts: [part("roof", { finish: "shiny" })] });
	assert.equal(finish.path, "parts[roof].finish");
	assert.match(finish.error, /matte, satin, gloss/);
	assert.equal(normalizeSculptRecipe({ parts: [part("roof", { material: 3 })] }).ok, false);
});

await check("an edit sets or clears a preset, and a mirror keeps it", () => {
	const base = recipeOf(part("arm", { position: [0.6, 0, 0], mirror: true }));
	const set = patchSculptRecipe(base, [{ set: "arm", material: "metal", finish: "satin" }]);
	assert.equal(set.ok, true, set.error);
	assert.deepEqual(expandSculptParts(set.recipe).map((p) => [p.id, p.material, p.finish]), [["arm", "metal", "satin"], ["arm.mirror", "metal", "satin"]]);
	const cleared = patchSculptRecipe(set.recipe, [{ set: "arm", material: null, finish: null }]);
	assert.equal(cleared.ok, true, cleared.error);
	assert.deepEqual(cleared.recipe, base);
	assert.equal(patchSculptRecipe(base, [{ set: "arm", material: "chrome" }]).path, "parts[arm].material");
});

/* ------------------------------------------------------------ record ---- */

await check("a primitive keeps material and finish through normalize and a save round trip", () => {
	const object = cube({ material: "brick", finish: "matte" });
	assert.deepEqual([object.material, object.finish], ["brick", "matte"]);
	const loaded = loadScene(serializeScene([object]));
	assert.equal(loaded.status, "valid");
	assert.deepEqual(loaded.objects[0], object);
	const plain = cube();
	assert.equal("material" in plain || "finish" in plain, false, "a record without a preset stays as it was");
	const junk = cube({ material: "marble", finish: "wet" });
	assert.equal("material" in junk || "finish" in junk, false, "unknown names are dropped on load");
	const light = normalizeSceneObject({ id: "l", renderer: "light", material: "metal" });
	assert.equal("material" in light, false, "only primitives draw a preset");
});

await check("object.update sets, clears and ignores; its field list names the keys on primitives only", () => {
	const [made] = updateSceneObject([cube()], "box-1", { material: "glass", finish: "matte" });
	assert.deepEqual([made.material, made.finish], ["glass", "matte"]);
	const same = [made];
	assert.equal(updateSceneObject(same, "box-1", { material: "glass" }), same, "no change, same array");
	assert.equal(updateSceneObject(same, "box-1", { material: "marble" }), same, "unknown name ignored");
	const [cleared] = updateSceneObject(same, "box-1", { material: null });
	assert.equal(normalizeSceneObject(cleared).material, undefined);
	assert.ok(objectPatchFields(made).includes("material") && objectPatchFields(made).includes("finish"));
	assert.equal(objectPatchFields({ renderer: "light" }).includes("material"), false);
});

await check("object.set refuses an unknown preset with its path, reads a set one back; the declaration mirrors the table", () => {
	assert.throws(() => validateStudioSchema(elementSetSchema("object"), { id: "box-1", set: { material: "marble" } }), /\$\.set\.material: "marble" is not one of: clay, wood/);
	validateStudioSchema(elementSetSchema("object"), { id: "box-1", set: { material: "straw", finish: "satin" } });
	assert.deepEqual(elementReadback("object", cube({ material: "wood" })).filter((row) => /material|finish/.test(row.path)), [{ path: "object.material", text: "wood" }]);
	assert.equal(elementReadback("object", cube()).some((row) => /material|finish/.test(row.path)), false, "a plain object's receipt stays as short as before");
	assert.deepEqual(elementByPath("object.material").enum, [...MATERIAL_PRESETS]);
	assert.deepEqual(elementByPath("object.finish").enum, [...MATERIAL_FINISHES]);
});

/* ----------------------------------------------------------- factory ---- */

await check("the factory returns the right material class per preset, in Node, with no texture", () => {
	const clay = lookMaterial({ color: "#336699" });
	assert.equal(clay.type, "MeshStandardMaterial");
	assert.deepEqual([clay.roughness, clay.metalness, clay.color.getHexString()], [0.82, 0, "336699"], "clay is the look every prop wore before");
	assert.equal(clay.customProgramCacheKey(), new THREE.MeshStandardMaterial().customProgramCacheKey(), "clay is not patched");
	const glass = lookMaterial({ material: "glass", size: [1, 1.2, 0.01] });
	assert.equal(glass.type, "MeshPhysicalMaterial");
	assert.deepEqual([glass.transmission, glass.ior, glass.thickness], [1, 1.5, 0.005]);
	const metal = lookMaterial({ material: "metal" });
	assert.deepEqual([metal.type, metal.metalness], ["MeshStandardMaterial", 1]);
	assert.equal(lookMaterial({ material: "ceramic" }).clearcoat, 1);
	assert.equal(lookMaterial({ material: "ceramic", finish: "matte" }).clearcoat, 0);
	assert.ok(lookMaterial({ material: "fabric" }).sheen > 0 && lookMaterial({ material: "foliage" }).sheen > 0);
	assert.equal(lookMaterial({ material: "metal", finish: "gloss" }).roughness, FINISH_ROUGHNESS.gloss);
	assert.equal(lookMaterial({ material: "nope" }).type, "MeshStandardMaterial", "an unknown name draws clay");
	const wood = lookMaterial({ material: "wood" });
	assert.equal(wood.customProgramCacheKey(), lookMaterial({ material: "brick" }).customProgramCacheKey(), "every pattern shares one program");
	assert.equal(lookMaterial({ material: "wood", side: THREE.DoubleSide }, { polygonOffset: true }).polygonOffset, true);
	for (const name of MATERIAL_PRESETS) assert.ok(lookMaterial({ material: name }).isMaterial, name);
});

await check("a blockout-grey part takes the preset's own colour; an authored colour stays the tint", () => {
	assert.equal(lookTint("#c2c6c8", "brick"), MATERIAL_LOOKS.brick.color);
	assert.equal(lookTint("#C2C6C8", "wood"), MATERIAL_LOOKS.wood.color);
	assert.equal(lookTint("#c24a3b", "wood"), "#c24a3b");
	assert.equal(lookTint("#c2c6c8", "clay"), "#c2c6c8");
	assert.equal(lookMaterial({ material: "brick", color: "#c2c6c8" }).color.getHex(), new THREE.Color(MATERIAL_LOOKS.brick.color).getHex());
});

await check("the pattern patch lands in three's own shader sources and shares one texture per pattern", () => {
	const a = compileShader(lookMaterial({ material: "wood" }));
	const b = compileShader(lookMaterial({ material: "wood", color: "#ffffff" }));
	const c = compileShader(lookMaterial({ material: "brick" }));
	for (const name of ["vLookPos = lookP", "uniform float lookGrain"]) assert.ok(a.vertexShader.includes(name), name);
	for (const name of ["lookTriplanar( vLookPos, lookW )", "roughnessFactor = clamp( roughnessFactor + ( lookTex.b", "normal = lookPerturb("]) assert.ok(a.fragmentShader.includes(name), name);
	assert.ok(a.uniforms.lookMap.value.isDataTexture);
	assert.deepEqual([a.uniforms.lookMap.value.image.width, a.uniforms.lookMap.value.image.height], [PATTERN_SIZE, PATTERN_SIZE]);
	assert.equal(a.uniforms.lookMap.value, b.uniforms.lookMap.value, "one texture per pattern");
	assert.notEqual(a.uniforms.lookMap.value, c.uniforms.lookMap.value);
	assert.notEqual(a.uniforms.lookAmount, b.uniforms.lookAmount, "uniform values stay per material");
	for (const name of MATERIAL_PRESETS) {
		const pattern = MATERIAL_LOOKS[name].pattern;
		if (pattern) assert.ok(PATTERN_NAMES.includes(pattern), `${name} draws a known pattern`);
	}
	assert.deepEqual(patternPixels("straw"), patternPixels("straw"), "deterministic");
});

await check("disposing a sculpt frees its materials but never the shared pattern textures", () => {
	const recipe = recipeOf(part("plank", { material: "wood" }), part("post", { material: "wood", size: [0.1, 1, 0.1] }), part("pane", { material: "glass", size: [0.6, 0.6, 0.01] }));
	const group = buildSculptGroup(recipe);
	const meshes = group.children;
	assert.deepEqual(meshes.map((mesh) => mesh.material.type), ["MeshStandardMaterial", "MeshStandardMaterial", "MeshPhysicalMaterial"]);
	assert.deepEqual(meshes.map((mesh) => mesh.castShadow), [true, true, false], "glass casts no shadow");
	const textures = meshes.slice(0, 2).map((mesh) => compileShader(mesh.material).uniforms.lookMap.value);
	assert.equal(textures[0], textures[1]);
	let texturesFreed = 0, materialsFreed = 0;
	textures[0].addEventListener("dispose", () => { texturesFreed += 1; });
	for (const mesh of meshes) mesh.material.addEventListener("dispose", () => { materialsFreed += 1; });
	disposeSculptGroup(group);
	assert.equal(materialsFreed, 3);
	assert.equal(texturesFreed, 0);
	const again = compileShader(lookMaterial({ material: "wood" })).uniforms.lookMap.value;
	assert.equal(again, textures[0], "the next wooden part samples the same tile");
});

await check("reflective presets reflect the stage's own environment when it has one", () => {
	const metal = lookMaterial({ material: "metal" });
	const scene = new THREE.Scene();
	scene.environment = new THREE.Texture();
	metal.onBeforeRender(null, scene);
	assert.equal(metal.envMap, null);
	assert.equal(lookMaterial({ material: "wood" }).onBeforeRender, THREE.Material.prototype.onBeforeRender, "matte presets do not hook the draw");
});

if (failures) {
	console.log(`verify-material-presets: ${failures} failed`);
	process.exit(1);
}
console.log("verify-material-presets: all checks passed");
