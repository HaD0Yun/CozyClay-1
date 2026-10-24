/**
 * Seeded randomness for sculpt surfaces and scatters. The same recipe always
 * draws the same lumps and the same blades (nothing here reads Math.random),
 * and a mirrored copy is seeded by its source part's id, so it draws the
 * source's pattern reflected instead of a new one. Pure: no three.js.
 */

import { SCULPT_MIRROR_SUFFIX } from "./sculpt-recipe.js";

/** Whether a drawn part is the reflected copy of a `mirror: true` part. */
export const isMirrorCopy = (part) => part.id.endsWith(SCULPT_MIRROR_SUFFIX);

function mix(value) {
	let h = Math.imul(value ^ (value >>> 16), 0x7feb352d);
	h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
	return (h ^ (h >>> 16)) >>> 0;
}

/** A 32-bit seed from the part's source id (FNV-1a) and a recipe seed. */
export function partSeed(part, seed) {
	const id = isMirrorCopy(part) ? part.id.slice(0, -SCULPT_MIRROR_SUFFIX.length) : part.id;
	let hash = 0x811c9dc5;
	for (let i = 0; i < id.length; i += 1) hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193);
	return mix(hash ^ Math.imul(seed + 1, 0x9e3779b1));
}

/** mulberry32: a uniform [0, 1) stream from a 32-bit seed. */
export function seededRandom(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = Math.imul(state ^ (state >>> 15), state | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const GRADIENTS = [1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1];
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

/** Gradient (Perlin) noise, about −1..1, zero on the integer lattice. */
function noise3(x, y, z, seed) {
	const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
	const fx = x - ix, fy = y - iy, fz = z - iz;
	const corner = (dx, dy, dz) => {
		const g = (mix(Math.imul(ix + dx, 0x8da6b343) ^ Math.imul(iy + dy, 0xd8163841) ^ Math.imul(iz + dz, 0xcb1ab31f) ^ seed) % 12) * 3;
		return GRADIENTS[g] * (fx - dx) + GRADIENTS[g + 1] * (fy - dy) + GRADIENTS[g + 2] * (fz - dz);
	};
	const u = fade(fx), v = fade(fy), w = fade(fz);
	return lerp(
		lerp(lerp(corner(0, 0, 0), corner(1, 0, 0), u), lerp(corner(0, 1, 0), corner(1, 1, 0), u), v),
		lerp(lerp(corner(0, 0, 1), corner(1, 0, 1), u), lerp(corner(0, 1, 1), corner(1, 1, 1), u), v),
		w,
	);
}

/** Four octaves of noise3: broad lumps with smaller lumps on them, about −1..1. */
export function fbm3(x, y, z, seed) {
	let sum = 0;
	for (let octave = 0, amplitude = 1, frequency = 1; octave < 4; octave += 1, amplitude /= 2, frequency *= 2) {
		sum += amplitude * noise3(x * frequency, y * frequency, z * frequency, seed + octave);
	}
	return sum / 1.875;
}
