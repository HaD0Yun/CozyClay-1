// Measured, not judged (output.observations.spring): a carried spring object swings about its base
// (compiler/spring.js), so a base far from the hand puts the pivot out there and every arm swing and
// wrist turn shakes it harder (a bag carried by its far end: the drive about 1.9x). One line per carry
// whose base sits PIVOT_FAR m or more from its prop origin (the hand socket), measured mid-carry.
import { isCarried, propOrigin } from "../carried.js";
import { basePoseAt, frameAt, spanOf } from "../object-pose.js";
import { dist } from "../compiler/math.js";

/** How far from the hand a spring object's base may sit before the observation, m. */
const PIVOT_FAR = 0.15;

/** observations.spring: ["SPRING_PIVOT <id>: base is 0.30 m from the hand; ..."], or null when every spring carry pivots at the hand. */
export function springPivots(out) {
	const { sk, spec } = out.ctx, lines = [];
	for (const [id, o] of Object.entries(spec.objects ?? {})) {
		if (!o?.spring || !isCarried(o) || !spec.props?.[o.prop]) continue;
		const [grab, release] = spanOf(out, o), f = Math.round((grab + release) / 2), base = basePoseAt(out, id, f);
		if (!base) continue;
		const d = dist(base.pos, propOrigin(sk, spec, frameAt(out, f).s, o));
		if (d >= PIVOT_FAR) lines.push(`SPRING_PIVOT ${id}: base is ${d.toFixed(2)} m from the hand; the swing pivots there, so put the base at the hand with at/along`);
	}
	return lines.length ? lines : null;
}
