/**
 * The scatter shape's recipe half (registered in sculpt-shapes.js): `count`
 * small copies of one item, drawn as ONE instanced mesh by sculpt-scatter.js.
 * A grass field built from hundreds of cone parts still looked sparse; as one
 * scatter part it is thousands of blades and counts once toward maxParts
 * (the whole recipe's items are capped by SCULPT_LIMITS.maxScatterItems).
 *
 *   item     blade | tuft | flower stand up; leaf | pebble | twig lie down
 *   count    1..SCATTER_MAX_COUNT items
 *   seed     picks another layout of the same items (default 0)
 *   spread   "ground" (default): items stand on the bottom face of the size
 *            box, anywhere in its x/z rectangle. Standing items are up to
 *            size[1] tall; lying items are sized so `count` of them cover
 *            the rectangle.
 *            "shell": items sit on the ellipsoid inscribed in the size box,
 *            facing outward (leaves on a tree crown, flowers on a bush),
 *            sized so `count` of them cover it.
 *
 * Every item is fitted inside the size box. A mirrored copy draws its
 * source's layout reflected (sculpt-scatter.js), so no `mirror` hook is needed.
 * Pure: no three.js.
 */

import { readChoice, readInteger, readSeed } from "./sculpt-recipe-read.js";

export const SCATTER_ITEMS = Object.freeze(["blade", "tuft", "flower", "leaf", "pebble", "twig"]);
const SCATTER_SPREADS = ["ground", "shell"];
const SCATTER_MAX_COUNT = 4000;

/** Ground: the box the items fill. Shell: the ellipsoid they cover, as rings. */
function scatterSamples(part) {
	const [sx, sy, sz] = part.size.map((value) => value / 2);
	const points = [];
	if (part.spread === "ground") {
		for (const x of [-sx, sx]) for (const y of [-sy, sy]) for (const z of [-sz, sz]) points.push([x, y, z]);
		return [points];
	}
	for (let i = 0; i <= 16; i += 1) {
		const polar = (i / 16) * Math.PI;
		for (let j = 0; j < 24; j += 1) {
			const t = (j / 24) * 2 * Math.PI;
			points.push([Math.sin(polar) * Math.cos(t) * sx, Math.cos(polar) * sy, Math.sin(polar) * Math.sin(t) * sz]);
		}
	}
	return [points];
}

export const SCATTER_SHAPE = {
	keys: ["item", "count", "seed", "spread"],
	read(raw, part, where) {
		part.item = readChoice(raw.item, `${where}.item`, undefined, SCATTER_ITEMS);
		part.count = readInteger(raw.count, `${where}.count`, undefined, 1, SCATTER_MAX_COUNT);
		part.seed = readSeed(raw.seed, `${where}.seed`);
		part.spread = readChoice(raw.spread, `${where}.spread`, "ground", SCATTER_SPREADS);
	},
	samples: scatterSamples,
};
