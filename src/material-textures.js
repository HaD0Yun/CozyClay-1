/**
 * Procedural surface detail for the material presets: one small seamless tile
 * per pattern, from integer hashes, so every machine draws the same pixels.
 * Pure arithmetic, no three.js and no DOM; material-look.js wraps the bytes in
 * a DataTexture the first time a preset is drawn, and never in Node.
 *
 * Channels, each 0..255: R albedo detail (128 is the authored colour), G
 * height (0..255 spans the preset's bump depth), B roughness offset (128 is
 * none), A where a second colour shows (brick mortar). Each pattern is drawn
 * in tile coordinates u (across) and v (along the grain, or up), both 0..1;
 * R and B are re-centred on their mean afterwards, so a preset never shifts
 * the colour the author picked.
 */

export const PATTERN_SIZE = 256;

function hash(x, y, seed) {
	let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
	h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
	h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const wrap = (i, n) => ((i % n) + n) % n;
const smooth = (t) => t * t * (3 - 2 * t);
const step = (a, b, x) => smooth(Math.min(1, Math.max(0, (x - a) / (b - a))));

/** Value noise on a px by py lattice over the tile, seamless at its edges. */
function noise(u, v, px, py, seed) {
	const x = u * px, y = v * py, ix = Math.floor(x), iy = Math.floor(y);
	const fx = smooth(x - ix), fy = smooth(y - iy);
	const x0 = wrap(ix, px), x1 = wrap(ix + 1, px), y0 = wrap(iy, py), y1 = wrap(iy + 1, py);
	const a = hash(x0, y0, seed), b = hash(x1, y0, seed), c = hash(x0, y1, seed), d = hash(x1, y1, seed);
	return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

function fbm(u, v, px, py, octaves, seed) {
	let sum = 0, amp = 0.5, total = 0;
	for (let o = 0; o < octaves; o += 1) {
		sum += amp * noise(u, v, px << o, py << o, seed + o);
		total += amp;
		amp /= 2;
	}
	return sum / total;
}

/** Worley cells on an n by n jittered grid, seamless: the nearest and second
 * nearest feature distances (tile units) and the nearest cell's hash. */
function cells(u, v, n, seed) {
	const x = u * n, y = v * n, ix = Math.floor(x), iy = Math.floor(y);
	let f1 = 9, f2 = 9, id = 0;
	for (let dy = -1; dy <= 1; dy += 1) {
		for (let dx = -1; dx <= 1; dx += 1) {
			const cx = ix + dx, cy = iy + dy, wx = wrap(cx, n), wy = wrap(cy, n);
			const d = Math.hypot(cx + hash(wx, wy, seed) - x, cy + hash(wx, wy, seed + 1) - y) / n;
			if (d < f1) {
				f2 = f1;
				f1 = d;
				id = hash(wx, wy, seed + 2);
			} else if (d < f2) f2 = d;
		}
	}
	return { f1, f2, id };
}

/** Each pattern: (u, v) to [albedo, height, roughness, mask]. */
const PATTERNS = {
	// Ten rings across the tile, wandering along it, over fine fibres.
	wood(u, v) {
		const late = (0.5 + 0.5 * Math.sin(2 * Math.PI * (u * 10 + fbm(u, v, 2, 1, 3, 11) * 2.2))) ** 6;
		const fibre = noise(u, v, 128, 4, 12), fleck = fbm(u, v, 16, 2, 2, 13);
		return [0.5 - 0.45 * late + 0.25 * fibre + 0.2 * fleck, 0.6 * fibre - 0.5 * late, 0.5 + 0.4 * late - 0.2 * fibre, 0];
	},
	// Four overlapping courses of strands; each course is thickest at its ragged
	// lower edge and shaded just under the edge of the course above.
	straw(u, v) {
		const strand = 0.6 * noise(u, v, 192, 3, 21) + 0.4 * noise(u, v, 96, 2, 22);
		const course = v * 4 + 0.12 * noise(u, v, 48, 1, 23), cv = course - Math.floor(course);
		const shade = step(0.55, 1, cv);
		return [0.5 * strand - 0.45 * shade + 0.1 * fbm(u, v, 6, 2, 2, 24), 0.7 * (1 - cv) + 0.3 * strand, 0.5 + 0.2 * shade, 0];
	},
	// Weathered fieldstone: lumpy noise, stones of their own tone, dark joints.
	stone(u, v) {
		const lump = fbm(u, v, 4, 4, 5, 31), cell = cells(u, v, 5, 32), grain = noise(u, v, 128, 128, 33);
		const edge = cell.f2 - cell.f1, crack = 1 - step(0, 0.012, edge);
		return [0.35 * lump + 0.25 * cell.id + 0.12 * grain - 0.35 * crack, 0.5 * lump + 0.35 * step(0, 0.08, edge) + 0.1 * grain, 0.25 * lump + 0.15 * crack, 0];
	},
	// Running bond: six 83 mm courses of two 250 mm bricks on the 0.5 m tile,
	// 10 mm recessed mortar joints (the mask), each brick its own tone.
	brick(u, v) {
		const row = Math.floor(v * 6), cv = v * 6 - row;
		const across = u * 2 + (row % 2 ? 0.5 : 0), col = Math.floor(across), cu = across - col;
		const gap = Math.min(Math.min(cu, 1 - cu) / 2, Math.min(cv, 1 - cv) / 6), joint = 0.01;
		const grit = noise(u, v, 96, 96, 42), mortar = 1 - step(joint * 0.6, joint, gap);
		return [0.35 * hash(wrap(col, 2), row, 41) + 0.15 * grit + 0.15 * fbm(u, v, 8, 8, 3, 43), 0.85 * step(joint * 0.6, joint * 2.2, gap) + 0.15 * grit, 0.1 * grit + 0.15 * mortar, mortar];
	},
	// Cast concrete: soft mottling, fine grit, scattered air pits.
	concrete(u, v) {
		const mottle = fbm(u, v, 3, 3, 5, 51), grit = noise(u, v, 160, 160, 52), pit = step(0.86, 0.95, noise(u, v, 48, 48, 53));
		return [0.3 * mottle + 0.1 * grit - 0.25 * pit, 0.4 * mottle + 0.25 * grit - 0.6 * pit, 0.2 * mottle, 0];
	},
	// Brushed metal: fine lines across the tile and faint smudges in the sheen.
	brushed(u, v) {
		const brush = 0.6 * noise(u, v, 3, 220, 61) + 0.4 * noise(u, v, 2, 110, 62), smudge = fbm(u, v, 3, 3, 4, 63);
		return [0.15 * brush + 0.1 * smudge, brush, 0.35 * brush + 0.4 * smudge, 0];
	},
	stipple(u, v) {
		const fine = noise(u, v, 128, 128, 71), wear = fbm(u, v, 6, 6, 3, 72);
		return [0.2 * wear + 0.1 * fine, fine, 0.3 * wear, 0];
	},
	// Plain weave: 32 threads each way, over and under, each thread its own tone.
	weave(u, v) {
		const x = u * 32, y = v * 32, i = Math.floor(x), j = Math.floor(y);
		const across = Math.sin(Math.PI * (x - i)), along = Math.sin(Math.PI * (y - j)), warp = (i + j) % 2 === 0;
		const height = warp ? across * (0.75 + 0.25 * along) : along * (0.75 + 0.25 * across);
		return [0.3 * height + 0.2 * (warp ? hash(i, 0, 81) : hash(0, j, 82)) + 0.1 * noise(u, v, 256, 256, 83), height, -0.2 * height, 0];
	},
	paper(u, v) {
		const pulp = fbm(u, v, 8, 8, 4, 91), fibre = noise(u, v, 64, 8, 92) * noise(u, v, 8, 64, 93);
		return [0.12 * pulp + 0.1 * fibre, pulp + 0.5 * fibre, 0.1 * pulp, 0];
	},
	// Two layers of leaf cells; the leaf nearer its own centre lies on top, and
	// where neither covers the surface a dark gap shows through.
	leaves(u, v) {
		const big = cells(u, v, 6, 101), small = cells(u, v, 9, 104);
		const domeBig = Math.max(0, 1 - big.f1 * 6 * 1.6), domeSmall = 0.9 * Math.max(0, 1 - small.f1 * 9 * 1.6);
		const top = domeBig >= domeSmall ? big : small, dome = Math.max(domeBig, domeSmall), gap = 1 - step(0, 0.15, dome);
		return [0.45 * top.id + 0.2 * dome - 0.5 * gap + 0.05 * noise(u, v, 64, 64, 107), dome, 0.3 * top.id + 0.3 * gap, 0];
	},
};

export const PATTERN_NAMES = Object.freeze(Object.keys(PATTERNS));

/** The RGBA bytes of one pattern's tile, PATTERN_SIZE square, row 0 at v = 0. */
export function patternPixels(name) {
	const draw = PATTERNS[name];
	if (!draw) throw new Error(`unknown material pattern "${name}"`);
	const count = PATTERN_SIZE * PATTERN_SIZE, raw = new Float32Array(count * 4);
	for (let y = 0; y < PATTERN_SIZE; y += 1) {
		for (let x = 0; x < PATTERN_SIZE; x += 1) raw.set(draw((x + 0.5) / PATTERN_SIZE, (y + 0.5) / PATTERN_SIZE), (y * PATTERN_SIZE + x) * 4);
	}
	let albedo = 0, rough = 0, low = Infinity, high = -Infinity;
	for (let i = 0; i < count; i += 1) {
		albedo += raw[i * 4] / count;
		rough += raw[i * 4 + 2] / count;
		low = Math.min(low, raw[i * 4 + 1]);
		high = Math.max(high, raw[i * 4 + 1]);
	}
	const span = high - low || 1, byte = (value) => Math.round(255 * Math.min(1, Math.max(0, value)));
	const out = new Uint8Array(count * 4);
	for (let i = 0; i < count; i += 1) {
		out[i * 4] = byte(raw[i * 4] - albedo + 0.5);
		out[i * 4 + 1] = byte((raw[i * 4 + 1] - low) / span);
		out[i * 4 + 2] = byte(raw[i * 4 + 2] - rough + 0.5);
		out[i * 4 + 3] = byte(raw[i * 4 + 3]);
	}
	return out;
}
