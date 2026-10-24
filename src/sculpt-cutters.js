/**
 * Sculpt cutters: a part with `op` is never drawn. It cuts its `parent` part,
 * which is how a recipe gets windows, doors and arches in a wall, a hollow
 * bowl or cup, or a notch in a plank (subtract), and a half-dome or a sliced
 * fruit (intersect). This module is the pure half: it reads `op` and refuses
 * the recipes a cutter cannot serve. sculpt-csg.js runs the boolean on the
 * parent's geometry. Pure: no three.js.
 *
 * Several cutters on one parent apply in recipe order, and a mirrored cutter
 * cuts both sides. A cutter's colour is never seen: the cut faces wear the
 * parent's look. Each rule below is refused with its path, never bent into a
 * different shape:
 *  - a cutter needs a parent, because a cutter at the object level would have
 *    nothing to cut;
 *  - a cutter carries no parts. A drawn child would ride a frame nobody sees,
 *    and a cutter that cuts another cutter is not supported, so two cutters
 *    that build one opening (an arched door) both cut the wall.
 */
import { RecipeError } from "./sculpt-recipe-read.js";

const SCULPT_OPS = ["subtract", "intersect"];

export const SCULPT_OP_FIELD = Object.freeze({
	key: "op",
	read(raw, part, where) {
		if (!SCULPT_OPS.includes(raw.op)) throw new RecipeError(`${where}.op`, `must be "subtract" or "intersect", got ${JSON.stringify(raw.op)}`);
		if (part.parent === undefined) throw new RecipeError(`${where}.op`, "a cutter needs a parent: the part it cuts");
		part.op = raw.op;
	},
});

/** Refuses any part that names a cutter as its parent. Run it once parents resolve. */
export function checkSculptCutters(parts) {
	const byId = new Map(parts.map((part) => [part.id, part]));
	for (const part of parts) {
		const parent = byId.get(part.parent);
		if (part.op && parent?.shape === "scatter") throw new RecipeError(`parts[${part.id}].op`, `"${parent.id}" is a scatter, which is drawn as instances and cannot be cut`);
		if (!parent?.op) continue;
		throw new RecipeError(`parts[${part.id}].parent`, part.op
			? `"${parent.id}" is a cutter, and a cutter only cuts drawn parts; give this one parent "${parent.parent}" so both cut it`
			: `"${parent.id}" is a cutter (op), which is not drawn and cannot carry parts; use parent "${parent.parent}" instead`);
	}
}
