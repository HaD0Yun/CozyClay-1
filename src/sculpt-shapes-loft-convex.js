/**
 * Recipe rules for the `loft` and `convex` sculpt shapes (the contract is the
 * header of sculpt-shapes.js). Pure: no three.js.
 *
 * loft    a skin through 2-12 horizontal sections stacked up the part's own
 *         y, for things whose section changes along their length: a boat
 *         hull, a car body, a squared bottle, a loaf. Lay it on its side with
 *         rotation for a hull or a car. Rings: sculpt-loft-rings.js.
 * convex  the convex hull of 4-48 points, flat facets by default, for rocks,
 *         gems and crystals; or `seed` alone for a random rock that fills its
 *         size, so "a boulder" is one line.
 *
 * Every coordinate is a fraction of size (-0.5..0.5, loft y 0..1), so a part
 * never draws outside its declared box and resizing never rewrites points.
 */

import { RecipeError, isFiniteNumber, readUnit, tidy } from "./sculpt-recipe-read.js";
import { loftRings, signedArea } from "./sculpt-loft-rings.js";

const LOFT_SECTIONS = [2, 12];
const OUTLINE_POINTS = [3, 24];
const CONVEX_POINTS = [4, 48];
const FACET_COUNTS = [6, 40];
const DEFAULT_FACETS = 16;
const SECTION_ROUNDNESS = 0.25;
/** A hull thinner than this (as a fraction of size) in any direction is flat. */
const MIN_DEPTH = 0.02;
const MAX_SEED = 2147483647;

function readNumber(value, path, min, max) {
	if (!isFiniteNumber(value) || value < min || value > max) {
		throw new RecipeError(path, `must be a number from ${min} to ${max}, got ${JSON.stringify(value)}`);
	}
	return tidy(value);
}

function readBoolean(value, path, fallback) {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw new RecipeError(path, "must be true or false");
	return value;
}

function readList(value, path, [min, max], what) {
	if (!Array.isArray(value) || value.length < min || value.length > max) {
		throw new RecipeError(path, `must be ${min}-${max} ${what}, got ${Array.isArray(value) ? value.length : JSON.stringify(value)}`);
	}
	return value;
}

function readPoint(value, path, axes) {
	if (!Array.isArray(value) || value.length !== axes.length || !value.every(isFiniteNumber)) {
		throw new RecipeError(path, `must be [${axes.join(", ")}] fractions of size, got ${JSON.stringify(value)}`);
	}
	return value.map((component, k) => readNumber(component, `${path}[${k}]`, -0.5, 0.5));
}

const cross2 = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** An outline that crosses itself has no inside to skin. */
function crossingEdges(points) {
	const n = points.length;
	for (let i = 0; i < n; i += 1) {
		for (let j = i + 2; j < n; j += 1) {
			if (i === 0 && j === n - 1) continue;
			const [a, b, c, d] = [points[i], points[(i + 1) % n], points[j], points[(j + 1) % n]];
			if (cross2(a, b, c) * cross2(a, b, d) < 0 && cross2(c, d, a) * cross2(c, d, b) < 0) return [i, j];
		}
	}
	return null;
}

function readSection(raw, path) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RecipeError(path, "must be { y, points } or { y, w, d }");
	const outline = raw.points !== undefined;
	const allowed = outline ? ["y", "points"] : ["y", "w", "d", "x", "z", "roundness"];
	for (const key of Object.keys(raw)) {
		if (!allowed.includes(key)) throw new RecipeError(`${path}.${key}`, `unknown key (a section is { y, points } or { y, w, d, x, z, roundness })`);
	}
	const y = readNumber(raw.y, `${path}.y`, 0, 1);
	if (outline) {
		const points = readList(raw.points, `${path}.points`, OUTLINE_POINTS, "[x, z] points").map((point, i) => readPoint(point, `${path}.points[${i}]`, ["x", "z"]));
		const crossing = crossingEdges(points);
		if (crossing) throw new RecipeError(`${path}.points`, `edges ${crossing[0]} and ${crossing[1]} cross; list the outline in order around the section`);
		if (Math.abs(signedArea(points)) < 1e-6) throw new RecipeError(`${path}.points`, "the outline encloses no area");
		return { y, points };
	}
	const section = { y, w: readNumber(raw.w, `${path}.w`, 0.01, 1), d: readNumber(raw.d, `${path}.d`, 0.01, 1) };
	for (const [key, span] of [["x", "w"], ["z", "d"]]) {
		section[key] = readUnit(raw[key], `${path}.${key}`, 0, -0.5, 0.5);
		if (Math.abs(section[key]) + section[span] / 2 > 0.5 + 1e-9) {
			throw new RecipeError(`${path}.${key}`, `the section reaches past the part's side: |${key}| + ${span}/2 must be at most 0.5`);
		}
	}
	section.roundness = readUnit(raw.roundness, `${path}.roundness`, SECTION_ROUNDNESS, 0, 1);
	return section;
}

function readSections(value, where) {
	const path = `${where}.sections`;
	const sections = readList(value, path, LOFT_SECTIONS, "sections").map((section, k) => readSection(section, `${path}[${k}]`));
	sections.forEach((section, k) => {
		if (k > 0 && section.y <= sections[k - 1].y) throw new RecipeError(`${path}[${k}].y`, "must be above the section before it (sections run bottom to top)");
	});
	if (sections[0].y !== 0 || sections.at(-1).y !== 1) {
		throw new RecipeError(path, "the first section must sit at y 0 and the last at y 1 (size[1] is the loft's full height)");
	}
	return sections;
}

/** Points [x, y, z] that span no volume would hull into a flat, broken mesh. */
function hullDepth(points) {
	const sub = (a, b) => a.map((value, k) => value - b[k]);
	const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
	const length = (a) => Math.hypot(...a);
	const spread = (k) => Math.max(...points.map((p) => p[k])) - Math.min(...points.map((p) => p[k]));
	const axis = [1, 2].reduce((best, k) => (spread(k) > spread(best) ? k : best), 0);
	const a = points.reduce((best, p) => (p[axis] < best[axis] ? p : best));
	const b = points.reduce((best, p) => (p[axis] > best[axis] ? p : best));
	const line = sub(b, a);
	const off = (p) => length(cross(line, sub(p, a))) / (length(line) || 1);
	const c = points.reduce((best, p) => (off(p) > off(best) ? p : best));
	const normal = cross(line, sub(c, a));
	const plane = (p) => Math.abs(sub(p, a).reduce((sum, value, k) => sum + value * normal[k], 0)) / (length(normal) || 1);
	return Math.min(length(line), off(c), Math.max(...points.map(plane)));
}

/** mulberry32: a small seeded PRNG, so a seed is the same rock everywhere. */
function seededRandom(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = Math.imul(state ^ (state >>> 15), state | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * A rock of about `facetCount` triangles: a jittered Fibonacci sphere of
 * facetCount / 2 + 2 points (a hull of n points on a sphere has 2n - 4
 * triangles), tipped to a random pole, pulled in by up to 12%, then stretched
 * per axis so it touches all six sides of its box: size is the rock's extent.
 */
function rockPoints(seed, facetCount) {
	const random = seededRandom(seed);
	const count = Math.floor(facetCount / 2) + 2;
	const tilt = Math.acos(1 - 2 * random()), spin = 2 * Math.PI * random();
	const golden = Math.PI * (3 - Math.sqrt(5));
	const raw = [];
	for (let i = 0; i < count; i += 1) {
		const y = Math.max(-1, Math.min(1, 1 - (2 * (i + 0.5)) / count + (random() - 0.5) / count));
		const angle = i * golden + (random() - 0.5) * golden * 0.5;
		const ring = Math.sqrt(1 - y * y), radius = 0.88 + 0.12 * random();
		const [x0, y0, z0] = [Math.cos(angle) * ring, y, Math.sin(angle) * ring];
		const [y1, z1] = [y0 * Math.cos(tilt) - z0 * Math.sin(tilt), y0 * Math.sin(tilt) + z0 * Math.cos(tilt)];
		raw.push([(x0 * Math.cos(spin) + z1 * Math.sin(spin)) * radius, y1 * radius, (z1 * Math.cos(spin) - x0 * Math.sin(spin)) * radius]);
	}
	const ranges = [0, 1, 2].map((k) => [Math.min(...raw.map((p) => p[k])), Math.max(...raw.map((p) => p[k]))]);
	return raw.map((point) => point.map((value, k) => tidy((value - (ranges[k][0] + ranges[k][1]) / 2) / (ranges[k][1] - ranges[k][0]))));
}

const convexFractions = (part) => part.points ?? rockPoints(part.seed, part.facetCount);

/** The hull's points in metres, in the part's frame. */
export function convexPoints(part) {
	return convexFractions(part).map((point) => point.map((value, k) => value * part.size[k]));
}

export const LOFT_CONVEX_SPECS = Object.freeze({
	loft: {
		keys: ["sections", "smooth"],
		read(raw, part, where) {
			part.sections = readSections(raw.sections, where);
			part.smooth = readBoolean(raw.smooth, `${where}.smooth`, true);
		},
		// x flips, and an outline is listed backwards so it keeps its winding.
		mirror(copy) {
			copy.sections = copy.sections.map((section) => (section.points
				? { y: section.y, points: section.points.map(([x, z]) => [tidy(-x), z]).reverse() }
				: { ...section, x: tidy(-section.x) }));
		},
		// One hull per span, so a waist between two wide sections stays a waist.
		samples(part) {
			const { rings, at } = loftRings(part);
			return at.slice(1).map((end, k) => rings.slice(at[k], end + 1).flat());
		},
	},
	convex: {
		keys: ["points", "seed", "facetCount", "facets"],
		read(raw, part, where) {
			// null reads as absent, so an edit can swap a seeded rock for points;
			// seed: null also clears the facetCount that belonged to it.
			const has = (key) => raw[key] !== undefined && raw[key] !== null;
			if (has("points") === has("seed")) throw new RecipeError(`${where}.points`, "give either points: [[x, y, z]...] or seed (a random rock), not both");
			if (has("points")) {
				if (has("facetCount") && raw.seed !== null) throw new RecipeError(`${where}.facetCount`, "applies to a seeded rock; points already set the facets");
				part.points = readList(raw.points, `${where}.points`, CONVEX_POINTS, "[x, y, z] points").map((point, i) => readPoint(point, `${where}.points[${i}]`, ["x", "y", "z"]));
				if (hullDepth(part.points) < MIN_DEPTH) throw new RecipeError(`${where}.points`, "the points lie (nearly) on one line or plane; a hull needs depth in all three directions");
			} else {
				if (!Number.isInteger(raw.seed) || raw.seed < 0 || raw.seed > MAX_SEED) throw new RecipeError(`${where}.seed`, `must be a whole number from 0 to ${MAX_SEED}, got ${JSON.stringify(raw.seed)}`);
				part.seed = raw.seed;
				const facetCount = has("facetCount") ? raw.facetCount : DEFAULT_FACETS;
				if (!Number.isInteger(facetCount) || facetCount < FACET_COUNTS[0] || facetCount > FACET_COUNTS[1]) {
					throw new RecipeError(`${where}.facetCount`, `must be a whole number from ${FACET_COUNTS[0]} to ${FACET_COUNTS[1]}, got ${JSON.stringify(raw.facetCount)}`);
				}
				part.facetCount = facetCount;
			}
			part.facets = readBoolean(raw.facets, `${where}.facets`, true);
		},
		// A seeded rock is not symmetric either: its copy carries the reflected points.
		mirror(copy) {
			copy.points = convexFractions(copy).map(([x, y, z]) => [tidy(-x), y, z]);
			delete copy.seed;
			delete copy.facetCount;
		},
		samples: (part) => [convexPoints(part)],
	},
});
