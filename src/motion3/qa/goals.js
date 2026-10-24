// Goals (C8): what the motion must achieve, measured on the compiled frames. A goal names one
// predicate and the frames it must hold on (at: an absolute frame or [f0, f1]):
//   near:  [a, b]  refDistance(a, b) <= tol (default 0.05 m); a round body's .top and the mouth measure its rim
//                  (nearRefs), and a failing near goal on a .top says which point it read
//   above: [a, b]  a.y - b.y >= by (default 0 m)
//   moved: ref     an object's point (default its base) is at least by (default 0.05 m) from
//                  where the scene put it; any other point ref (prop:, joint:, landmark:, anchor:)
//                  gets at least by from where it was at at[0]: one value, its farthest frame
//   still: ref     the point stays within tol (default 0.01 m) of the same home moved measures
//                  from (an object: where the scene put it; any other point: where it is at at[0])
//   speed: ref     the point's speed (central difference, m/s) is at least by (no default)
// mode "all" (every frame of at; the default, except speed) or "any" (one frame; speed's default).
// after / before: "<goal name>" cut at to the frames after (before) the first frame the named goal
// holds, so an event the agent did not place on a frame can still order two goals ("the can moves
// after the kick"). A named goal that never holds, or holds too late, leaves no frames: the goal
// fails with value and at null and one GOAL issue (value 0.01) at at[0]; the named goal's own GOAL
// group carries the measure. Each goal answers one result { name, kind, ok, value, at, need }: for
// "all" the frame closest to failing (or the worst failure), for "any" the best frame. A failed goal
// adds GOAL issues (value = the shortfall, limit 0): "all" one per failing frame, so the group's
// count and first..last show how much of at fails and the search (search.js) sees progress; "any"
// one, at the best frame. Issue frames index out.frames (out.f0 + i); goals[].at and every frame in
// a message are absolute.
import { refPoint, refDistance, openingOf } from "../refs.js";
import { partsOf } from "../object-pose.js";
import { add, apply, len, sub } from "../compiler/math.js";
import { m3 } from "./fmt.js";

/** The goal predicates, one per goal. */
export const GOAL_KINDS = ["near", "above", "moved", "still", "speed"];
const DEFAULT_NEED = { near: 0.05, above: 0, moved: 0.05, still: 0.01 };
/** Predicates met at value <= need (tol); the others are met at value >= need (by). */
const AT_MOST = new Set(["near", "still"]);
/** Predicates on one point ref (the others take [ref, ref]). */
export const ONE_REF = new Set(["moved", "still", "speed"]);

/** The predicates goal g names (validation wants exactly one). */
export const goalKinds = g => GOAL_KINDS.filter(k => g?.[k] !== undefined);
/** A goal's name: its own, else its place in spec.goals ("goals[1]", which groupKey keeps apart). */
export const goalName = (g, i) => g.name ?? `goals[${i}]`;
/** The bound: tol for near and still, by for above, moved and speed. */
export const goalNeed = (g, kind) => (AT_MOST.has(kind) ? g.tol : g.by) ?? DEFAULT_NEED[kind];
/** "all" or "any": the goal's own, else any for speed (a speed is reached) and all for the rest. */
const goalMode = (g, kind) => g.mode ?? (kind === "speed" ? "any" : "all");

/** moved and still measure the named point of an object ref (its base when none is named), any other ref as it is. */
export const movedRef = ref => (!ref.startsWith("object:") || /\.(center|top|base|rim)$/.test(ref) ? ref : `${ref}.base`);

/** Where the scene put the point of a moved object ref: the same AABB point refs.js answers, from the scene boxes. */
function scenePoint(scene, ref) {
	const [, id, which] = /^object:(.+)\.(center|top|base|rim)$/s.exec(movedRef(ref)) ?? [];
	const boxes = partsOf(scene, id).map(p => scene.objects[p]);
	if (!boxes.length) return null;
	if (which === "rim") return openingOf(boxes).o;
	const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
	for (const b of boxes) for (const x of [-1, 1]) for (const y of [0, 2]) for (const z of [-1, 1]) {
		const p = add(b.pos, apply(b.R, [x * b.half[0], y * b.half[1], z * b.half[2]]));
		for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
	}
	const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
	return which === "top" ? [c[0], hi[1], c[2]] : which === "base" ? [c[0], lo[1], c[2]] : c;
}

/** The point ref of a moved or still goal. */
const homeRef = g => g.moved ?? g.still;

/** Where a moved or still goal measures from: an object's point where the scene put it, any other point where it is at `from` (default at[0]). */
export const movedHome = (out, g, from = Array.isArray(g.at) ? g.at[0] : g.at) => (homeRef(g).startsWith("object:") ? scenePoint(out.ctx.scene, homeRef(g)) : refPoint(out, from, homeRef(g)));

/** The speed of point ref at absolute frame f (m/s): central difference, one-sided at the window's edges; null when unknown. */
function speedAt(out, ref, f) {
	const p = refPoint(out, f, ref), fps = out.fps ?? 24;
	if (!p) return null;
	const a = refPoint(out, f - 1, ref), b = refPoint(out, f + 1, ref);
	if (a && b) return (len(sub(b, a)) * fps) / 2;
	const q = a ?? b;
	return q ? len(sub(p, q)) * fps : null;
}

const MOUTH = "landmark:mouth", TOP = /^object:(.+)\.top$/s;

/**
 * A near goal of an object's .top and the mouth, on a body whose highest part is round (a cylinder: a cup, a can, a
 * bottle), measures its opening's rim nearest the mouth (refs.js .rim): .top is the top-face centre of its world
 * bounding box, which a tilted cup lifts off the rim it is drunk from (a session read 8 failures in a row off it).
 * -> the refs measured, as given when nothing changes.
 */
export function nearRefs(scene, g) {
	const [a, b] = g.near, top = [a, b].map(r => TOP.exec(r)?.[1]), i = top[0] && b === MOUTH ? 0 : top[1] && a === MOUTH ? 1 : -1;
	if (i < 0) return g.near;
	const parts = partsOf(scene, top[i]).map(p => scene.objects[p]).filter(p => p?.half && p.pos && p.R);
	const high = parts.length ? parts.reduce((p, q) => (q.pos[1] + 2 * q.half[1] > p.pos[1] + 2 * p.half[1] ? q : p)) : null;
	if (high?.renderer !== "cylinder") return g.near;
	return g.near.map((r, j) => (j === i ? `object:${top[i]}.rim` : r));
}

/** What a near goal's .top measured, said in its message (refs.js): the rim it was read at, or the bounding-box top it is. */
function topNote(scene, g) {
	const ref = g.near.find(r => TOP.test(r));
	if (!ref) return "";
	const id = TOP.exec(ref)[1];
	return nearRefs(scene, g) !== g.near ? ` (measured at ${id}'s rim nearest the mouth, object:${id}.rim; its .top is its bounding box's top)`
		: ` (${ref} is the top-face centre of its world bounding box; object:${id}.rim is its opening, which tilts with it)`;
}

/** The measured value of goal g at absolute frame f (metres, m/s for speed), or null when a ref is unknown there. */
function measure(out, g, kind, f, home) {
	if (kind === "near") { const [a, b] = nearRefs(out.ctx.scene, g); return refDistance(out, f, a, b); }
	if (kind === "above") {
		const a = refPoint(out, f, g.above[0]), b = refPoint(out, f, g.above[1]);
		return a && b ? a[1] - b[1] : null;
	}
	if (kind === "speed") return speedAt(out, g.speed, f);
	const p = home && refPoint(out, f, movedRef(homeRef(g)));
	return p ? len(sub(p, home)) : null;
}

/** How far value v is from meeting the bound (> 0 fails). */
const shortOf = (kind, v, need) => (AT_MOST.has(kind) ? v - need : need - v);
const round4 = x => Math.max(1e-4, Math.round(x * 1e4) / 1e4);

/** The measured frames of goal g over [a, b]: [{ f, v, short }], and the frame its point is measured from (a point's moved or still). */
function rowsOf(X, g, kind, a, b) {
	const need = goalNeed(g, kind), point = (kind === "moved" || kind === "still") && !homeRef(g).startsWith("object:");
	// a point is measured from where it is at the window's first frame (outside a windowed trial compile: unknown, so nothing is measured)
	const home = kind === "moved" || kind === "still" ? movedHome(X.out, g, a) : null, rows = [];
	for (let f = Math.max(a, X.f0); f <= Math.min(b, X.last); f++) {
		const v = measure(X.out, g, kind, f, home);
		if (v !== null) rows.push({ f, v, short: shortOf(kind, v, need) });
	}
	return { rows, from: point ? a : undefined };
}

/**
 * The first frame goal j holds (its own window, cut by its own after/before): a frame, null when
 * it never holds there (or sits in an after/before loop), undefined when no frame of it is measured
 * (a windowed trial compile that does not reach it).
 */
function eventOf(X, j) {
	if (X.events.has(j)) return X.events.get(j);
	if (X.visiting.has(j)) return null;
	X.visiting.add(j);
	const g = X.goals[j], kind = goalKinds(g)[0], w = kind && windowOf(X, j);
	let e;
	if (w && !w.wait) {
		const { rows } = rowsOf(X, g, kind, w.a, w.b);
		e = rows.length ? (rows.find(r => r.short <= 0)?.f ?? null) : undefined;
	} else e = w?.wait ? null : undefined;
	X.visiting.delete(j);
	X.events.set(j, e);
	return e;
}

/** The frames goal i measures: at cut by after and before ({ a, b }), or { wait } when that leaves none, or { skip } when unknown here. */
function windowOf(X, i) {
	const g = X.goals[i];
	let [a, b] = Array.isArray(g.at) ? g.at : [g.at, g.at];
	for (const side of ["after", "before"]) {
		if (g[side] === undefined) continue;
		const j = X.names.get(g[side]);
		if (j === undefined || j === i) return { wait: `${side} "${g[side]}" names no other goal` };
		const e = eventOf(X, j);
		if (e === undefined) return { skip: true };
		if (e === null) return { wait: `waits for "${g[side]}" (${side}), which never holds` };
		if (side === "after") a = Math.max(a, e + 1); else b = Math.min(b, e - 1);
		if (a > b) return { wait: `no frames left ${side} "${g[side]}" (it holds first at f${e}; at is f${Array.isArray(g.at) ? `${g.at[0]}-f${g.at[1]}` : g.at})` };
	}
	return { a, b };
}

function message(name, kind, row, need, any, from, note = "") {
	const where = any ? `f${row.f}, the best of f${any[0]}-f${any[1]}` : `f${row.f}`;
	if (kind === "near") return `${name}: ${m3(row.v)} m at ${where} (needs <= ${need})${note}`;
	if (kind === "above") return `${name}: ${m3(row.v)} m above at ${where} (needs >= ${need})`;
	if (kind === "speed") return `${name}: ${m3(row.v)} m/s at ${where} (needs >= ${need})`;
	if (kind === "still") return `${name}: ${m3(row.v)} m from ${from === undefined ? "its scene pose" : `f${from}`} at ${where} (needs <= ${need})`;
	return `${name}: moved ${m3(row.v)} m${from === undefined ? "" : ` from f${from}`} at ${where} (needs >= ${need})`;
}

/** The frames goal i measures in compile result out (after/before applied): { a, b } | { wait } | { skip } (hints-goal.js). */
export function goalWindow(out, goals, i) {
	const f0 = out.f0 ?? 0, names = new Map(goals.map((g, j) => [goalName(g, j), j]));
	return windowOf({ out, goals, names, f0, last: f0 + (out.frames?.length ?? 0) - 1, events: new Map(), visiting: new Set() }, i);
}

/**
 * goalChecks(out, goals) -> { issues, results }
 * @param {object} out  compileMotion result (refs.js reads it)
 * @param {object[]} goals  spec.goals
 * @returns {{ issues: object[], results: { name: string, kind: string, ok: boolean, value: number|null, at: number|null, need: number }[] }}
 */
export function goalChecks(out, goals) {
	const issues = [], results = [], f0 = out.f0 ?? 0;
	const X = { out, goals, names: new Map(goals.map((g, j) => [goalName(g, j), j])), f0, last: f0 + (out.frames?.length ?? 0) - 1, events: new Map(), visiting: new Set() };
	goals.forEach((g, i) => {
		const kind = goalKinds(g)[0];
		if (!kind) return;
		const name = goalName(g, i), need = goalNeed(g, kind), w = windowOf(X, i), at0 = Array.isArray(g.at) ? g.at[0] : g.at;
		if (w.skip) return;
		if (w.wait) {
			results.push({ name, kind, ok: false, value: null, at: null, need });
			if (at0 >= f0 && at0 <= X.last) issues.push({ kind: "GOAL", msg: `${name}: ${w.wait}`, frame: at0 - f0, value: 0.01, limit: 0 });
			return;
		}
		let { rows, from } = rowsOf(X, g, kind, w.a, w.b);
		// a windowed trial compile (search.js) may not reach at; those frames cannot change there
		if (!rows.length) return;
		// a point's moved is one value: the farthest it gets from where it was at at[0]
		if (kind === "moved" && from !== undefined) rows = [rows.reduce((p, r) => (r.v > p.v ? r : p))];
		const any = goalMode(g, kind) === "any", cut = Array.isArray(g.at) ? w.a !== w.b : false;
		const pick = rows.reduce((p, r) => ((any ? r.short < p.short : r.short > p.short) ? r : p));
		const ok = pick.short <= 0;
		results.push({ name, kind, ok, value: m3(pick.v), at: pick.f, need });
		if (ok) return;
		const note = kind === "near" ? topNote(out.ctx.scene, g) : "";
		for (const r of any ? [pick] : rows.filter(r => r.short > 0)) {
			issues.push({ kind: "GOAL", msg: message(name, kind, r, need, any && cut ? [w.a, w.b] : null, from, kind === "near" ? note : ""), frame: r.f - f0, value: round4(r.short), limit: 0 });
		}
	});
	return { issues, results };
}
