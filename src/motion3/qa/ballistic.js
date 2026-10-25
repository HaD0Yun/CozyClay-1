// The ballistic arc a FLOAT run should follow (qa/style.js floatChecks reads the run, this file
// says how to fix it). Off the ground the hips ride a gravity parabola: anchored at the frame
// just before takeoff (A = a - 1) and the frame just after landing (B = b + 1), with gravity
// fixed (g = 9.81 / fps^2 m per frame^2), the launch speed v0 is the one closed form that makes
// the parabola pass through both anchors:
//   y(f) = yA + v0 (f - A) - g/2 (f - A)^2,   v0 = (yB - yA) / T + g T / 2,   T = B - A.
// The fix is that parabola minus the hips height, per frame, vertical only. No anchor (the run
// touches either end of the take) or a correction past MAX_FIX (the run is too long for the
// height it has: the arc would throw the body half a metre or more) means no fix; past MAX_FIX
// arcPrescription gives the apex the run needs, or the run the hips' own apex fits.
// Pure: numbers in, numbers out.

/** A correction past this (m) is not a fix: the run needs fewer frames, not a higher arc. */
export const MAX_FIX = 0.5;

/**
 * ballisticArc(y, a, b, g) -> { from, to, v0, delta, worst } | null
 * @param {ArrayLike<number>} y  hips height per frame (index = frame of the same take)
 * @param {number} a  first airborne frame (index into y)
 * @param {number} b  last airborne frame (index into y)
 * @param {number} g  gravity in m per frame^2 (9.81 / fps^2)
 * @returns delta[i] = fitted - actual height at frame a + i; worst = the frame (index into y)
 *   of the largest |delta|; from/to = the anchor frames; v0 = the launch speed (m per frame)
 */
export function ballisticArc(y, a, b, g, maxFix = MAX_FIX) {
	if (!Number.isInteger(a) || !Number.isInteger(b) || b < a || !(g > 0)) return null;
	const A = a - 1, B = b + 1;
	if (A < 0 || B > y.length - 1) return null;
	const yA = y[A], yB = y[B], T = B - A;
	if (!Number.isFinite(yA) || !Number.isFinite(yB)) return null;
	const v0 = (yB - yA) / T + g * T / 2, delta = [];
	let worst = a;
	for (let f = a; f <= b; f++) {
		if (!Number.isFinite(y[f])) return null;
		const t = f - A, d = yA + v0 * t - g / 2 * t * t - y[f];
		delta.push(d);
		if (Math.abs(d) > Math.abs(delta[worst - a])) worst = f;
	}
	if (Math.abs(delta[worst - a]) > maxFix) return null;
	return { from: A, to: B, v0, delta, worst };
}

/**
 * The frames (indexes into y) at 1/4, 1/2 and 3/4 of the way between the anchors, each once,
 * inside the run [a, b] of arc.
 */
export function arcFrames(arc) {
	const { from: A, to: B } = arc, a = A + 1, b = B - 1, out = [];
	for (const q of [0.25, 0.5, 0.75]) {
		const f = Math.min(b, Math.max(a, Math.round(A + (B - A) * q)));
		if (!out.includes(f)) out.push(f);
	}
	return out;
}

/**
 * arcPrescription(y, a, b, g) -> { off, frames, apex, height, fits } | null: for an arc past MAX_FIX, the numbers that
 * fix the run instead. A flight of N frames (anchor to anchor) peaks g N^2 / 8 above takeoff (apex, g per frame^2:
 * 9.81 (N / fps)^2 / 8); the hips' own apex h above takeoff fits N = sqrt(8 h / g) frames (fits, rounded; 0 when the
 * hips never rise). off = the arc minus the hips at the worst frame. Null when there is no anchor or the arc fits.
 */
export function arcPrescription(y, a, b, g) {
	const arc = ballisticArc(y, a, b, g, Infinity);
	if (!arc || Math.abs(arc.delta[arc.worst - a]) <= MAX_FIX) return null;
	const frames = arc.to - arc.from, height = Math.max(...Array.from(arc.delta, (_, i) => y[a + i])) - y[arc.from];
	return { off: arc.delta[arc.worst - a], frames, apex: g * frames * frames / 8, height, fits: height > 0 ? Math.round(Math.sqrt(8 * height / g)) : 0 };
}
