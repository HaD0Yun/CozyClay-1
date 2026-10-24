/**
 * Surface fields any part takes (registered in sculpt-part-fields.js):
 *
 *   detail    { amount: 0..1, scale?: 1..12, seed? } lumps a smooth part into
 *             a cloud, bush, rock, hay bale or loaf. `amount` is the bump
 *             height (1 = DETAIL_RELIEF of the part's smallest half-extent),
 *             `scale` about how many bumps fit across its longest side.
 *   gradient  { color, axis?: y|x|z, from?: 0..1, to?: 0..1 } blends the
 *             part's colour (at `from`) into `color` (at `to`) along a local
 *             axis, 0 at its low end and 1 at its high end: a sky-lit cloud,
 *             a ripening fruit, a sunset wall. On a scatter it colours whole
 *             items by where they sit.
 *
 * The geometry halves are sculpt-detail.js and sculpt-colours.js. Pure: no three.js.
 */

import { RecipeError, readChoice, readHexColor, readSeed, readUnit } from "./sculpt-recipe-read.js";

/** Bump height at amount 1, as a fraction of the part's smallest half-extent:
 * past this a rock reads as a crumpled ball. sculpt-detail.js draws the same. */
export const DETAIL_RELIEF = 0.35;
const DETAIL_SCALE = { fallback: 4, min: 1, max: 12 };
const GRADIENT_AXES = ["y", "x", "z"];

function readFields(value, path, keys) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new RecipeError(path, `must be an object { ${keys.join(", ")} }, got ${JSON.stringify(value)}`);
	}
	for (const key of Object.keys(value)) {
		if (!keys.includes(key)) throw new RecipeError(`${path}.${key}`, `unknown key (allowed: ${keys.join(", ")})`);
	}
	return value;
}

const DETAIL_FIELD = {
	key: "detail",
	read(raw, part, where) {
		const at = `${where}.detail`;
		if (part.shape === "scatter") throw new RecipeError(at, "does not apply to a scatter: its items are already small; lump the part under it instead");
		const detail = readFields(raw.detail, at, ["amount", "scale", "seed"]);
		if (detail.amount === undefined) throw new RecipeError(`${at}.amount`, "is required: the bump height from 0 (smooth) to 1 (very lumpy)");
		part.detail = {
			amount: readUnit(detail.amount, `${at}.amount`, 0, 0, 1),
			scale: readUnit(detail.scale, `${at}.scale`, DETAIL_SCALE.fallback, DETAIL_SCALE.min, DETAIL_SCALE.max),
			seed: readSeed(detail.seed, `${at}.seed`),
		};
	},
};

const GRADIENT_FIELD = {
	key: "gradient",
	read(raw, part, where) {
		const at = `${where}.gradient`;
		const gradient = readFields(raw.gradient, at, ["color", "axis", "from", "to"]);
		if (gradient.color === undefined) throw new RecipeError(`${at}.color`, "is required: the #rrggbb colour the part blends into");
		part.gradient = {
			color: readHexColor(gradient.color, `${at}.color`),
			axis: readChoice(gradient.axis, `${at}.axis`, "y", GRADIENT_AXES),
			from: readUnit(gradient.from, `${at}.from`, 0, 0, 1),
			to: readUnit(gradient.to, `${at}.to`, 1, 0, 1),
		};
	},
};

export const SURFACE_FIELDS = [DETAIL_FIELD, GRADIENT_FIELD];
