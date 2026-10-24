/**
 * Material presets as three.js materials (the table is material-presets.js),
 * one factory for sculpt parts and plain primitives. `lookMaterial(look)`
 * mints a material per call, which the caller owns and disposes; its detail
 * comes from pattern textures (material-textures.js) generated once per
 * pattern on first draw and shared by every material that uses it, so no one
 * owner may free them (material.dispose() leaves uniforms alone).
 *
 * Mapping is triplanar in the mesh's own frame, measured in metres (the
 * frame's scale is divided back out): the pattern rides with a moving prop,
 * keeps its size on a stretched cube and never reads a geometry's UVs, which
 * on a blob's remapped UV sphere would pinch at the poles. A directional
 * pattern (grain, thatch, brick courses) runs along the axis the vertex
 * shader picks from the part's size and its tilt in the world. The shader
 * text is the same for every preset (only uniforms differ), so all of them
 * share one compiled program per material class.
 *
 * Reflections: the studio stage look has no scene environment, and a metal
 * there would reflect black. While the scene has none, the reflective presets
 * take a RoomEnvironment prefiltered once per renderer; on a stage with an
 * environment they reflect that one, at its intensity, like everything else.
 */

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { FINISH_ROUGHNESS, MATERIAL_LOOKS, lookTint } from "./material-presets.js";
import { PATTERN_SIZE, patternPixels } from "./material-textures.js";

const VERTEX_HEAD = `
uniform vec3 lookExtent;
uniform float lookTile;
uniform float lookGrain;
varying vec3 vLookPos;
varying vec3 vLookNormal;`;

// lookGrain: 0 the part's own y, 1 its longest side, 2 its most upright side
// (a slab's thickness never counts). A downward axis is flipped so a thatch
// course's lower edge stays at the bottom.
const VERTEX_BODY = `
mat3 lookFrame = mat3( modelMatrix );
#ifdef USE_INSTANCING
	lookFrame = lookFrame * mat3( instanceMatrix );
#endif
vec3 lookSize = max( vec3( length( lookFrame[ 0 ] ), length( lookFrame[ 1 ] ), length( lookFrame[ 2 ] ) ), vec3( 1e-6 ) );
vec3 lookExt = lookExtent * lookSize;
vec3 lookUp = vec3( lookFrame[ 0 ].y, lookFrame[ 1 ].y, lookFrame[ 2 ].y ) / lookSize;
int lookAxis = 1;
if ( lookGrain > 1.5 ) {
	vec3 score = abs( lookUp );
	float thin = min( lookExt.x, min( lookExt.y, lookExt.z ) );
	float mid = lookExt.x + lookExt.y + lookExt.z - thin - max( lookExt.x, max( lookExt.y, lookExt.z ) );
	if ( thin < 0.35 * mid ) score -= 2.0 * vec3( equal( lookExt, vec3( thin ) ) );
	lookAxis = score.x >= score.y && score.x >= score.z ? 0 : ( score.y >= score.z ? 1 : 2 );
} else if ( lookGrain > 0.5 ) {
	lookAxis = lookExt.x >= lookExt.y && lookExt.x >= lookExt.z ? 0 : ( lookExt.y >= lookExt.z ? 1 : 2 );
}
vec3 lookP = transformed * lookSize / lookTile;
vec3 lookN = objectNormal / lookSize;
if ( lookAxis == 0 ) { lookP = lookP.yxz; lookN = lookN.yxz; }
else if ( lookAxis == 2 ) { lookP = lookP.xzy; lookN = lookN.xzy; }
if ( lookGrain > 1.5 && lookUp[ lookAxis ] < 0.0 ) { lookP.y = - lookP.y; lookN.y = - lookN.y; }
vLookPos = lookP;
vLookNormal = lookN;`;

// Bump is Mikkelsen's surface gradient with unnormalized screen derivatives,
// so `lookAmount.y` is a real relief depth in metres at any distance.
const FRAGMENT_HEAD = `
uniform sampler2D lookMap;
uniform vec4 lookAmount;
uniform vec3 lookMask;
varying vec3 vLookPos;
varying vec3 vLookNormal;
vec4 lookTriplanar( vec3 q, vec3 w ) {
	return texture2D( lookMap, q.zy ) * w.x + texture2D( lookMap, q.xz ) * w.y + texture2D( lookMap, q.xy ) * w.z;
}
vec3 lookPerturb( vec3 pos, vec3 n, vec2 dH, float face ) {
	vec3 sx = dFdx( pos ), sy = dFdy( pos );
	vec3 r1 = cross( sy, n ), r2 = cross( n, sx );
	float det = dot( sx, r1 ) * face;
	if ( abs( det ) < 1e-14 ) return n;
	return normalize( abs( det ) * n - sign( det ) * ( dH.x * r1 + dH.y * r2 ) );
}`;

const FRAGMENT_COLOR = `
vec3 lookW = pow( abs( normalize( vLookNormal ) ), vec3( 4.0 ) );
lookW /= lookW.x + lookW.y + lookW.z;
vec4 lookTex = lookTriplanar( vLookPos, lookW );
vec2 lookDH = lookAmount.y * ( vec2( lookTriplanar( vLookPos + dFdx( vLookPos ), lookW ).g, lookTriplanar( vLookPos + dFdy( vLookPos ), lookW ).g ) - lookTex.g );
diffuseColor.rgb *= max( 0.0, 1.0 + ( lookTex.r - 0.5 ) * 2.0 * lookAmount.x );
diffuseColor.rgb = mix( diffuseColor.rgb, lookMask, lookTex.a * lookAmount.w );`;

const FRAGMENT_ROUGHNESS = "\nroughnessFactor = clamp( roughnessFactor + ( lookTex.b - 0.5 ) * 2.0 * lookAmount.z, 0.03, 1.0 );";
const FRAGMENT_NORMAL = "\nnormal = lookPerturb( - vViewPosition, normal, lookDH, faceDirection );";

const after = (marker, code) => (source) => source.replace(marker, `${marker}${code}`);
const patchVertex = [after("#include <common>", VERTEX_HEAD), after("#include <begin_vertex>", VERTEX_BODY)];
const patchFragment = [after("#include <common>", FRAGMENT_HEAD), after("#include <color_fragment>", FRAGMENT_COLOR),
	after("#include <roughnessmap_fragment>", FRAGMENT_ROUGHNESS), after("#include <normal_fragment_maps>", FRAGMENT_NORMAL)];
const GRAIN = { up: 0, long: 1, hang: 2 };

const patternTextures = new Map();
/** The shared tile for a pattern, made on first use. Never disposed: every
 * material of the preset, now and later, samples the same one. */
function patternTexture(pattern) {
	let texture = patternTextures.get(pattern);
	if (!texture) {
		texture = new THREE.DataTexture(patternPixels(pattern), PATTERN_SIZE, PATTERN_SIZE);
		texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
		texture.magFilter = THREE.LinearFilter;
		texture.minFilter = THREE.LinearMipmapLinearFilter;
		texture.generateMipmaps = true;
		texture.anisotropy = 8;
		texture.needsUpdate = true;
		patternTextures.set(pattern, texture);
	}
	return texture;
}

/** Hooks the pattern into a material. The texture is fetched at compile time,
 * which only a renderer does, so Node never generates one. */
function addPattern(material, preset, size) {
	const uniforms = {
		lookMap: { value: null },
		lookTile: { value: preset.tile },
		lookExtent: { value: new THREE.Vector3(...size) },
		lookGrain: { value: GRAIN[preset.grain ?? "up"] },
		lookAmount: { value: new THREE.Vector4(preset.contrast ?? 0, preset.bump ?? 0, preset.roughVar ?? 0, preset.mask ? 0.9 : 0) },
		lookMask: { value: new THREE.Color(preset.mask ?? "#000000") },
	};
	material.onBeforeCompile = (shader) => {
		uniforms.lookMap.value ??= patternTexture(preset.pattern);
		Object.assign(shader.uniforms, uniforms);
		shader.vertexShader = patchVertex.reduce((source, patch) => patch(source), shader.vertexShader);
		shader.fragmentShader = patchFragment.reduce((source, patch) => patch(source), shader.fragmentShader);
	};
	material.customProgramCacheKey = () => "cozyclay-look-1";
}

const studioMaps = new WeakMap();
/** A neutral room to reflect, prefiltered once per renderer and kept. */
function studioReflections(renderer) {
	let map = studioMaps.get(renderer);
	if (!map) {
		const generator = new THREE.PMREMGenerator(renderer), room = new RoomEnvironment();
		map = generator.fromScene(room, 0.04).texture;
		room.dispose();
		generator.dispose();
		studioMaps.set(renderer, map);
	}
	return map;
}

/** Runs before each draw: the room while the scene has no environment, the
 * scene's own (envMap null) once it has one. three swaps the program itself. */
function reflectWhenBare(intensity) {
	return function onBeforeRender(renderer, scene) {
		const own = scene?.environment ? null : studioReflections(renderer);
		if (this.envMap === own) return;
		this.envMap = own;
		this.envMapIntensity = intensity;
	};
}

const WHITE = new THREE.Color("#ffffff");

/**
 * A material for `look` = { material, finish, color, size, side }: the preset
 * name (unknown or absent is clay), the finish, the authored colour, the
 * surface's extent in its mesh frame (metres; sizes the glass thickness and
 * steers the grain) and an optional side. `extra` is set last (polygon offset).
 */
export function lookMaterial(look, extra = null) {
	const name = Object.hasOwn(MATERIAL_LOOKS, look.material ?? "") ? look.material : "clay";
	const preset = MATERIAL_LOOKS[name], size = look.size ?? [1, 1, 1];
	const roughness = FINISH_ROUGHNESS[look.finish] ?? preset.roughness;
	const color = new THREE.Color(lookTint(look.color, name));
	const params = { color, roughness, metalness: preset.metalness ?? 0, ...(look.side === undefined ? {} : { side: look.side }), ...extra };
	let material;
	if (preset.physical) {
		const physical = { ...preset.physical };
		if (physical.transmission) physical.thickness = Math.min(0.5, Math.max(0.002, Math.min(...size) / 2));
		if (physical.sheen) physical.sheenColor = color.clone().lerp(WHITE, 0.25);
		if (physical.clearcoat && look.finish) Object.assign(physical, { clearcoat: look.finish === "matte" ? 0 : 1, clearcoatRoughness: roughness / 2 });
		material = new THREE.MeshPhysicalMaterial({ ...params, ...physical });
	} else material = new THREE.MeshStandardMaterial(params);
	if (preset.pattern) addPattern(material, preset, size);
	if (preset.env) material.onBeforeRender = reflectWhenBare(preset.env);
	return material;
}
