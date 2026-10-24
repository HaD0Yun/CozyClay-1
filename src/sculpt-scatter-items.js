/**
 * The scatter items (sculpt-scatter-shape.js names them): small closed clay
 * shapes, each built once and cached; a scatter part draws a clone of one as
 * an InstancedMesh. Standing items (blade, tuft, flower) are about one unit
 * tall from y = 0; lying items (leaf, pebble, twig) are about one unit long
 * and lie on y = 0. All are centred on x = 0, so a reflected copy fits the
 * same box. Each carries a grey `color` ramp that darkens its foot, so a
 * field reads with depth (it multiplies the per-item colour in the shaded
 * look; flat display modes ignore it).
 *
 *   stand   true: sized by the part's height on the ground
 *   tilt    the most an item leans from its surface's normal, in degrees
 *   cover   size against the spacing `count` leaves (lying items, shells)
 */

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { fbm3, seededRandom } from "./sculpt-noise.js";

/** `sides` points around (cx, y, cz), ordered so a loft's faces point outward. */
function ring(sides, rx, rz, y, cx = 0, cz = 0, twist = 0) {
	const points = [];
	for (let i = 0; i < sides; i += 1) {
		const angle = twist + (i / sides) * 2 * Math.PI;
		points.push([cx + rx * Math.cos(angle), y, cz - rz * Math.sin(angle)]);
	}
	return points;
}

/** A closed tube up through `rings` (bottom capped; a one-point last ring is
 * a tip), shaded grey by `shade(0 bottom .. 1 top)`. */
function loft(rings, shade) {
	const positions = [], colours = [], index = [], starts = [];
	rings.forEach((points, k) => {
		starts.push(positions.length / 3);
		const grey = shade(k / (rings.length - 1));
		for (const point of points) {
			positions.push(...point);
			colours.push(grey, grey, grey);
		}
	});
	for (let k = 0; k + 1 < rings.length; k += 1) {
		const a = starts[k], b = starts[k + 1], n = rings[k].length;
		for (let i = 0; i < n; i += 1) {
			const j = (i + 1) % n;
			if (rings[k + 1].length === 1) index.push(a + i, a + j, b);
			else index.push(a + i, a + j, b + j, a + i, b + j, b + i);
		}
	}
	for (let i = 1; i + 1 < rings[0].length; i += 1) index.push(starts[0], starts[0] + i + 1, starts[0] + i);
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
	geometry.setAttribute("color", new THREE.Float32BufferAttribute(colours, 3));
	geometry.setIndex(index);
	return geometry;
}

const footShade = (t) => 0.5 + 0.5 * Math.min(1, t * 1.4);

/** A blade of grass: a flat three-sided spike curving toward +z. */
function blade() {
	const rings = [];
	for (let k = 0; k < 4; k += 1) {
		const t = k / 4, width = 0.04 * (1 - t) ** 0.7;
		rings.push(ring(3, width, width * 0.4, t, 0, 0.18 * t * t, Math.PI / 2));
	}
	rings.push([[0, 1, 0.18]]);
	return loft(rings, footShade);
}

/** Six blades fanned out from one root. */
function tuft() {
	const random = seededRandom(0x7a1f);
	const blades = [];
	for (let i = 0; i < 6; i += 1) {
		const one = blade();
		one.scale(1.3, 0.7 + 0.3 * random(), 1.3);
		one.rotateX(0.2 + 0.35 * random());
		one.rotateY((i / 6) * 2 * Math.PI + random() * 0.6);
		blades.push(one);
	}
	return mergeGeometries(blades);
}

/** A stem with a five-petal head facing +y. */
function flower() {
	const stem = loft([ring(4, 0.02, 0.02, 0), ring(4, 0.018, 0.018, 0.45, 0.01, 0.02), ring(4, 0.016, 0.016, 0.8, 0, 0.03)], () => 0.55);
	const petals = [];
	for (let i = 0; i < 15; i += 1) {
		const angle = (i / 15) * 2 * Math.PI, r = 0.24 * (0.7 + 0.3 * Math.cos(5 * angle));
		petals.push([r * Math.cos(angle), 0.86, 0.03 - r * Math.sin(angle)]);
	}
	const head = loft([ring(15, 0.05, 0.05, 0.78, 0, 0.03), petals, ring(15, 0.09, 0.09, 0.93, 0, 0.03), [[0, 0.97, 0.03]]], () => 1);
	return mergeGeometries([stem, head]);
}

/** A leaf lying on y = 0: a thin arched lens one unit long along z. */
function leaf() {
	const rings = [];
	for (let k = 0; k < 6; k += 1) {
		const t = k / 6, half = Math.max(0.015, 0.21 * Math.sin(Math.PI * Math.min(1, 0.15 + t)) ** 0.8);
		rings.push(ring(6, half, 0.02, t, 0, -0.07 * Math.sin(Math.PI * t)));
	}
	rings.push([[0, 1, 0]]);
	const geometry = loft(rings, (t) => 0.8 + 0.2 * t);
	geometry.rotateX(Math.PI / 2);
	return geometry;
}

/** A flattened, faceted stone; the facets read as gravel. */
function pebble() {
	const geometry = new THREE.IcosahedronGeometry(0.5, 1);
	const position = geometry.getAttribute("position");
	for (let i = 0; i < position.count; i += 1) {
		const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
		const k = 1 + 0.2 * fbm3(x * 2.4 + 3.1, y * 2.4 + 1.7, z * 2.4 + 5.3, 11);
		position.setXYZ(i, x * k, y * k * 0.5, z * k * 0.8);
	}
	geometry.deleteAttribute("uv");
	geometry.setAttribute("color", new THREE.Float32BufferAttribute(new Array(position.count * 3).fill(1), 3));
	return geometry;
}

/** A crooked stick with one side branch, lying along x. */
function twig() {
	const stick = (length, radius) => loft(Array.from({ length: 6 }, (_, k) => {
		const t = k / 5;
		return ring(5, radius * (1 - 0.5 * t), radius * (1 - 0.5 * t), t * length, 0.04 * Math.sin(t * 7.3), 0.03 * Math.sin(t * 4.1 + 1));
	}), () => 0.85);
	const branch = stick(0.35, 0.018);
	branch.rotateX(-0.7);
	branch.translate(0, 0.45, 0);
	const geometry = mergeGeometries([stick(1, 0.03), branch]);
	geometry.rotateZ(-Math.PI / 2);
	return geometry;
}

const ITEMS = {
	blade: { build: blade, stand: true, tilt: 16, cover: 2.2 },
	tuft: { build: tuft, stand: true, tilt: 6, cover: 1.4 },
	flower: { build: flower, stand: true, tilt: 10, cover: 1.4 },
	leaf: { build: leaf, stand: false, tilt: 18, cover: 1.6 },
	pebble: { build: pebble, stand: false, tilt: 20, cover: 1 },
	twig: { build: twig, stand: false, tilt: 5, cover: 2 },
};

const built = new Map();

/** The item's distinct vertices plus their reflections across x = 0, flat
 * [x, y, z, ...]: what an item's fit is measured on, so a turned item fits by
 * its real outline (not its looser box) and its mirrored twin fits too. */
function outline(geometry) {
	const position = geometry.getAttribute("position");
	const seen = new Set(), points = [];
	for (let i = 0; i < position.count; i += 1) {
		const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
		for (const sx of [x, -x]) {
			const key = `${sx},${y},${z}`;
			if (!seen.has(key)) {
				seen.add(key);
				points.push(sx, y, z);
			}
		}
	}
	return Float64Array.from(points);
}

/** The item's cached template ({ geometry, points, stand, tilt, cover });
 * clone the geometry before handing it to a mesh, which will dispose its own. */
export function scatterItem(name) {
	if (!built.has(name)) {
		const geometry = ITEMS[name].build();
		geometry.computeBoundingBox();
		const { min, max } = geometry.boundingBox;
		// Centred on x, standing on y = 0, a lying item centred on z too.
		geometry.translate(-(min.x + max.x) / 2, -min.y, ITEMS[name].stand ? 0 : -(min.z + max.z) / 2);
		geometry.computeVertexNormals();
		geometry.computeBoundingBox();
		geometry.computeBoundingSphere();
		built.set(name, { ...ITEMS[name], geometry, points: outline(geometry) });
	}
	return built.get(name);
}
