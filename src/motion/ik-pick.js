/** Which IK control a viewport press grabs (posestudio IkHandles). */

/** The pick a press takes, from raycast hits sorted near to far. An exposed
 * control beats one hidden behind the body, so a far-side joint never steals
 * a press; a hidden one still answers when nothing exposed is under the
 * pointer, since it is drawn. A visible part (sphere, arrow, ring) beats an
 * arrow's invisible forgiving volume, so a ring is not lost to an arrow
 * crossing it. Distance breaks ties. */
export function pickIkHit(hits, picks, handles) {
	const pickOf = (hit) => picks.find((p) => p.mesh === hit.object);
	const rank = (hit) => {
		const pick = pickOf(hit);
		if (!pick) return Infinity;
		const hidden = handles[pick.track.id]?.userData.ikExposed === false;
		return (hidden ? 2 : 0) + (/^hit-/.test(pick.part ?? "") ? 1 : 0);
	};
	let best = null;
	let bestRank = Infinity;
	for (const hit of hits) {
		const value = rank(hit);
		if (value < bestRank) [best, bestRank] = [hit, value];
	}
	return best ? pickOf(best) : null;
}
