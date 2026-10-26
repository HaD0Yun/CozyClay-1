// What the physics overlay draws (src/physics-overlay.js), frame by frame, measured by QA's own functions on the
// installed take (physics-frames.js takeOut), so the overlay's colours are QA's verdicts:
//   comAt      the mass-weighted centre of mass (qa/com.js) and its state: "outside" when it sits farther outside
//              the support polygon than the balance limit (checks.limits.balance, else QA_LIMITS.balance: what
//              BALANCE reports), "inside" otherwise, "air" with no foot on the ground, "supported" where a declared
//              support carries the body (qa/style.js balanceFrames)
//   supportAt  the convex hull of the sole points on the ground (qa/com.js balanceAt feet), each corner on
//              the ground QA measured that sole point from (balanceAt ground)
//   airArcs    per air run of 4 frames or more (qa/style.js airRuns, the runs floatChecks judges): the hips path
//              from the frame before takeoff to the frame after landing, and the gravity parabola through the same
//              two anchors (qa/ballistic.js); float marks the runs QA calls FLOAT
// Positions are world metres where the take was compiled (take.placement). Pure and cached per take.
import { takeOut } from "./physics-frames.js";
import { balanceFrames, airRuns, floatChecks } from "./qa/style.js";
import { balanceAt, bodyCentre, convexHull } from "./qa/com.js";
import { groundY } from "./qa/ground.js";
import { ballisticArc } from "./qa/ballistic.js";
import { QA_LIMITS } from "./qa/checks.js";

/** floatChecks judges runs of this many frames or more. */
const MIN_RUN = 4;
const views = new WeakMap();

/** The overlay's view of take v3 `take` over the authored records `objects`, or null when it has none. */
export function physicsView(take, objects = []) {
	const out = takeOut(take, objects);
	if (!out) return null;
	if (!views.has(out)) {
		const checks = out.ctx.spec.checks ?? {};
		views.set(out, { take, out, checks, limit: checks.limits?.balance ?? QA_LIMITS.balance, balance: null, arcs: null });
	}
	return views.get(out);
}

/** The take frame shown at timeline frame `frame` (clamped to the take). */
const viewFrame = (view, frame) => Math.max(0, Math.min(view.out.frames.length - 1, Math.round(frame) || 0));

const balanceOf = view => (view.balance ??= balanceFrames(view.out, view.checks.supports));

/** { frame, p: [x, y, z], ground: the ground height under p, state, margin (m, null off the ground) } at `frame`. */
export function comAt(view, frame) {
	const f = viewFrame(view, frame), b = balanceOf(view)[f], measured = b && b !== "air";
	const p = measured ? b.com : bodyCentre(view.out.ctx.sk, view.out.frames[f].s);
	const state = b === null ? "supported" : b === "air" ? "air" : -b.margin > view.limit ? "outside" : "inside";
	return { frame: f, p, ground: groundY(view.out, f, p), state, margin: measured ? b.margin : null };
}

/**
 * The support polygon at `frame`: its corners [x, y, z] counter-clockwise in (x, z), y the ground QA measured that
 * sole point from (balanceAt ground); [] with no foot down. convexHull keeps the feet's own points, so each corner
 * finds its ground by identity.
 */
export function supportAt(view, frame) {
	const f = viewFrame(view, frame), b = balanceOf(view)[f] ?? balanceAt(view.out, f);
	if (b === "air") return [];
	return convexHull(b.feet).map(p => [p[0], b.ground[b.feet.indexOf(p)], p[1]]);
}

/**
 * [{ a, b, from, to, float, path, fit, worst }]: per air run [a, b], the hips path from anchor `from` (a - 1) to `to`
 * (b + 1) and the parabola `fit` over the same frames (the hips' x and z, the arc's height); worst = the largest
 * fit - actual height (m). A run that touches either end of the take has no anchor and no arc.
 */
export function airArcs(view) {
	if (view.arcs) return view.arcs;
	const { out, checks } = view, I = out.ctx.sk.index, hips = out.frames.map(fr => fr.s.P[I.Hips]), y = hips.map(p => p[1]);
	const floats = new Set(floatChecks(out, checks).map(issue => issue.frame)), g = 9.81 / out.fps ** 2;
	view.arcs = [];
	for (const [a, b] of airRuns(out, checks.supports)) {
		const arc = b - a + 1 >= MIN_RUN ? ballisticArc(y, a, b, g, Infinity) : null;
		if (!arc) continue;
		const path = hips.slice(arc.from, arc.to + 1).map(p => [...p]);
		const fit = path.map((p, i) => (i === 0 || i === path.length - 1 ? [...p] : [p[0], p[1] + arc.delta[i - 1], p[2]]));
		let float = true;
		for (let f = a; f <= b; f++) float &&= floats.has(f);
		view.arcs.push({ a, b, from: arc.from, to: arc.to, float, path, fit, worst: arc.delta[arc.worst - a] });
	}
	return view.arcs;
}
