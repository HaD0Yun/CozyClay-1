/**
 * A primitive's surface preset (object.material / object.finish) as the
 * material props.jsx hangs on its mesh, and the polygon offset every prop
 * material takes for its depth rank.
 */

import { useEffect, useMemo } from "react";
import { lookMaterial } from "./material-look.js";

// Parts of an assembly can share a plane with an earlier part (hood top and
// grille top). The depth test can't order them and the winner flips as the
// camera moves, so a ranked part is pulled toward the camera by `rank` steps
// (negative = nearer). Rank 0 gets nothing: those materials stay untouched.
export function depthRankProps(rank) {
	return rank > 0 ? { polygonOffset: true, polygonOffsetFactor: -rank, polygonOffsetUnits: -rank } : null;
}

/** Each primitive's extent in its mesh frame at scale 1 (props.jsx builds
 * them); the rest are unit sized. The shader multiplies the record's scale in. */
const PRIMITIVE_SIZE = { capsule: [0.7, 1.4, 0.7], plane: [2, 2, 0.01] };

/**
 * The preset material for a primitive record, or null when the record keeps
 * the plain clay look (no material and no finish) or auto-colour paints it
 * flat: the caller then draws exactly what it drew before presets. Rebuilt
 * when the look, the colour or the rank changes; the program and the pattern
 * textures are shared, so a rebuild is cheap.
 */
export function usePrimitiveLook(object, kind, side, depthRank) {
	const { material, finish, color, autoColor } = object;
	const active = !autoColor && Boolean(material || finish);
	const look = useMemo(
		() => (active ? lookMaterial({ material, finish, color, side, size: PRIMITIVE_SIZE[kind] }, depthRankProps(depthRank)) : null),
		[active, material, finish, color, side, kind, depthRank],
	);
	useEffect(() => () => look?.dispose(), [look]);
	return look;
}
