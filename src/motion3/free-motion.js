// C17. Objects nobody holds (a can inside a machine, a box on a shelf) move by keys and fall.
// spec.objects[id] with no prop, follow or hinge field, for a body or a group (its root):
//   keys  [{ f, pos, rot | aim (+ roll) }]   the world pose of its root (a body's base pivot, a group's
//         origin) at frame f, on the curve held keys use (object-keys.js keyedPose, C14). aim turns the
//         scene pose's +Y onto aim, then roll degrees about it. Before the first key of a run it stays
//         where it was (its scene pose, or where it landed), after the last it holds the last key.
//   fall  { at, onto?, bounce?, tumble? } or a list   from where it is at frame `at` it falls under gravity
//         (G m/s^2) onto the top of the highest still body under the centre of its parts (onto: that object's
//         top; nothing below: the floor, y 0) and comes to rest on a stable face (settle.js): it lands on its
//         lowest point, turning at the spin it was let go with, rolls flat and over an edge onto a lower face
//         while the drop has the energy (a phone falls flat, a can lies down). tumble: false drops it straight
//         down as it was, bouncing at most once (bounce: the restitution 0..0.6, default 0.25, never higher
//         than BOUNCE_MAX m); one that lands on a stable face as it falls bounces the same way, and one that
//         rolls spends its landing on the roll and does not bounce (bounce is not read for it).
// Keys and falls chain in frame order: a fall starts from the pose the keys before it leave (a key on the
// fall's own frame comes first), keys after a fall take over at their first frame.
// A carry (C3) takes fall too: before its grab (the hand finds it where it landed) or from its release on.
// A free object moves like a hinged one (compiler/compile.js objectTracks): an obstacle at its pose that
// frame, read through object-pose.js by refs, goals, probes, observations.near and QA. Pure over the spec,
// the scene and the time map (a retime moves its keys and falls with the body's keys): the body never
// moves it, and nothing it lands on moves (bodies a spec.objects entry moves are no support).
import { isCarried, compose, relative, movesRecord } from "./carried.js";
import { groupsOf } from "./scene.js";
import { curveOf, keyedPose } from "./object-keys.js";
import { add, apply, sub, T, quatFromMat, I3 } from "./compiler/math.js";
import { shapeOf, airPath, settlePath, settledAt, spinOf, spinEnergy, TIP } from "./settle.js";
import { fallVelocity, moves, flightTime, drift, landingWith } from "./flight.js";
import { springRest, springStep, swingOf, swungPose, springLength, SPRING } from "./compiler/spring.js";

/** Gravity, m/s^2. */
export const G = 9.8;
/** The highest a bounce goes, metres. */
export const BOUNCE_MAX = 0.03;
const BOUNCE = 0.25;
/** A support's top may sit this far above the lowest point of what rests on it (m). */
export const TOUCH = 0.005;
const HELD_OR_HINGED = ["prop", "follow", "pivot", "axis", "channel"];

/** A free entry (C17): no prop, follow or hinge field, and keys or fall. */
export const isFree = o => !!o && typeof o === "object" && !Array.isArray(o) && HELD_OR_HINGED.every(k => o[k] === undefined) && (o.keys !== undefined || o.fall !== undefined);
/** The falls of an entry (fall is one or a list), as given. */
const fallsOf = o => (o?.fall === undefined ? [] : Array.isArray(o.fall) ? o.fall : [o.fall]);

const restOf = (scene, id) => scene?.objects?.[id] ?? groupsOf(scene)[id] ?? null;
const partsIn = (scene, id) => Object.keys(scene?.objects ?? {}).filter(k => k === id || scene.objects[k].ancestors?.includes(id));

/** The 8 corners of a base-pivot box { pos, R, half }. */
export function corners(box) {
	const out = [];
	for (const x of [-1, 1]) for (const y of [0, 2]) for (const z of [-1, 1]) out.push(add(box.pos, apply(box.R, [x * box.half[0], y * box.half[1], z * box.half[2]])));
	return out;
}
export const topOf = box => Math.max(...corners(box).map(p => p[1]));
/** True when the vertical through x/z point p crosses the footprint of box. */
export const under = (box, p) => { const q = apply(T(box.R), sub([p[0], box.pos[1] + box.half[1], p[2]], box.pos)); return Math.abs(q[0]) <= box.half[0] && Math.abs(q[2]) <= box.half[2]; };

/** Bodies a spec.objects entry moves (itself or a group above it): they hold nothing up. */
function moversIn(spec, scene) {
	const out = new Set();
	for (const [id, o] of Object.entries(scene?.objects ?? {})) if ([id, ...(o.ancestors ?? [])].some(k => movesRecord(spec.objects?.[k]))) out.add(id);
	return out;
}

/** The part boxes of `id` with its root at world pose `root`. */
function boxesAtRoot(scene, id, root) {
	const rest = restOf(scene, id);
	return partsIn(scene, id).map(p => ({ id: p, ...compose(root, relative(rest, scene.objects[p])), half: scene.objects[p].half }));
}

/** What `id` lands on from pose `start`: { support (a body id, or null for the floor), top, h (the drop, m) }. */
export function landingOf(spec, scene, id, start, onto = null) {
	const boxes = boxesAtRoot(scene, id, start), own = new Set(boxes.map(b => b.id)), movers = moversIn(spec, scene);
	if (!boxes.length) return { support: null, top: 0, h: 0 };
	const low = Math.min(...boxes.flatMap(b => corners(b).map(p => p[1])));
	const c = boxes.flatMap(corners).reduce((s, p) => add(s, p), [0, 0, 0]).map(v => v / (boxes.length * 8));
	const pool = (onto ? partsIn(scene, onto) : Object.keys(scene.objects)).filter(k => !own.has(k) && !movers.has(k));
	let best = null;
	for (const k of pool) {
		const box = scene.objects[k], top = topOf(box);
		if (under(box, c) && top <= low + TOUCH && (!best || top > best.top)) best = { support: k, top };
	}
	// onto an object that is not right below: its highest top, the agent placed it
	if (!best && onto) for (const k of pool) { const top = topOf(scene.objects[k]); if (top <= low + TOUCH && (!best || top > best.top)) best = { support: k, top }; }
	best ??= { support: null, top: 0 };
	return { ...best, h: Math.max(0, low - best.top) };
}

const shapes = new WeakMap();
/** The shape of `id` in its root frame (settle.js), once per scene. */
function shapeIn(scene, id) {
	if (!shapes.has(scene)) shapes.set(scene, new Map());
	const cache = shapes.get(scene);
	if (!cache.has(id)) cache.set(id, shapeOf(boxesAtRoot(scene, id, { pos: [0, 0, 0], R: I3() })));
	return cache.get(id);
}

/**
 * A fall from root pose `start` at (mapped) frame t0: its timing, its pose at a frame, where it rests. `before` is its pose
 * a frame earlier (a release from the hand), for the spin it is let go with.
 */
function fallPlan(spec, scene, id, start, t0, fall, fps, before = null) {
	// a throw (fall.v, flight.js) lands where it comes down
	const v0 = fallVelocity(fall, start, before, fps), thrown = moves(v0), landAt = pose => landingOf(spec, scene, id, pose, fall.onto ?? null);
	const land = thrown ? landingWith(landAt, start, v0, G, Object.values(scene.objects).map(topOf)) : landAt(start), shape = fall.tumble === false ? null : shapeIn(scene, id);
	if (shape) {
		const spin = before ? spinOf(before.R, start.R, fps) : [0, 0, 0], air = airPath(shape, start, spin, land.top, fps, v0);
		// a spin tips it the way its top moves (spin x up); a spin about the vertical tips nothing
		const path = settlePath(shape, air.at(air.tl), land.top, TIP * land.h + spinEnergy(shape, spin), [-spin[2], 0, spin[0]]);
		if (path.steps.length || spin.some(v => v) || thrown) {
			const at = f => { const t = (f - t0) / fps; return t <= 0 ? start : t <= air.tl ? air.at(t) : settledAt(path, t - air.tl); };
			return { t0, land: t0 + air.tl * fps, end: t0 + (air.tl + path.time) * fps, h: land.h, support: land.support, top: land.top, at, rest: path.rest };
		}
	}
	const h = land.h, tl = thrown ? flightTime(h, v0[1], G) : Math.sqrt(2 * h / G), off = drift(v0, Infinity, tl);
	const e = Math.min(0.6, Math.max(0, fall.bounce ?? BOUNCE)), vb = Math.min(e * G * tl, Math.sqrt(2 * G * BOUNCE_MAX)), tb = 2 * vb / G;
	const rest = { pos: [start.pos[0] + off[0], start.pos[1] - h, start.pos[2] + off[2]], R: start.R };
	const at = f => {
		const t = (f - t0) / fps;
		if (t <= 0) return start;
		const dy = t <= tl ? (thrown ? v0[1] * t : 0) - 0.5 * G * t * t : t <= tl + tb ? -h + vb * (t - tl) - 0.5 * G * (t - tl) ** 2 : -h, d = drift(v0, t, tl);
		return { pos: [start.pos[0] + d[0], start.pos[1] + (thrown ? dy : Math.min(0, dy)), start.pos[2] + d[2]], R: start.R };
	};
	return { t0, land: t0 + tl * fps, end: t0 + (tl + tb) * fps, h, support: land.support, top: land.top, at, rest };
}

/** The events of an entry's falls and key runs in frame order (keys split into runs by the falls between them). */
function eventsOf(o, map, from = -Infinity, to = Infinity) {
	// a carry's keys pose it in hand (C14); only its falls are free
	const keys = isCarried(o) ? [] : [...(o.keys ?? [])].sort((a, b) => a.f - b.f);
	const falls = fallsOf(o).map(fl => ({ ...fl, t: map(fl.at) })).filter(fl => fl.t >= from && fl.t < to).sort((a, b) => a.t - b.t);
	const events = [];
	let run = [], i = 0;
	for (const k of keys) {
		while (i < falls.length && falls[i].t < map(k.f)) { if (run.length) events.push({ run }); run = []; events.push({ fall: falls[i++] }); }
		run.push(k);
	}
	if (run.length) events.push({ run });
	while (i < falls.length) events.push({ fall: falls[i++] });
	return events;
}

/** The pose events give at mapped frame f, starting from pose `start`; `keep` caches each fall's plan on its event. */
function walk(events, f, start, plan, keep = true) {
	let pose = start;
	for (const e of events) {
		if (e.run) {
			const { t } = e.curve;
			if (f < t[0]) return pose;
			if (f <= t[t.length - 1]) return keyedPose(e.curve, f);
			pose = keyedPose(e.curve, t[t.length - 1]);
		} else {
			if (f < e.fall.t) return pose;
			const p = keep ? (e.plan ??= plan(pose, e.fall)) : plan(pose, e.fall);
			if (f < p.end) return p.at(f);
			pose = p.rest;
		}
	}
	return pose;
}

const timelines = new WeakMap();
/** The events of entry o under time map `map`, cached per scene, entry and span (key curves built once). */
function timelineOf(ctx, id, o, map, part) {
	if (!timelines.has(ctx.scene)) timelines.set(ctx.scene, new Map());
	const cache = timelines.get(ctx.scene), key = `${id}|${part}|${ctx.grab}|${ctx.release}`, had = cache.get(key);
	if (had && had.map === map && had.o === o && had.spec === ctx.spec) return had.events;
	const rest = restOf(ctx.scene, id), m = map ?? (f => f), [from, to] = part === "before" ? [-Infinity, ctx.grab] : part === "after" ? [ctx.release, Infinity] : [-Infinity, Infinity];
	const events = eventsOf(o, m, from, to);
	for (const e of events) if (e.run) e.curve = curveOf({ keys: e.run }, m, () => quatFromMat(rest.R), null);
	cache.set(key, { map, o, spec: ctx.spec, events });
	return events;
}

const planner = (ctx, id) => (start, fall) => fallPlan(ctx.spec, ctx.scene, id, start, fall.t, fall, ctx.spec.fps ?? 30);

/**
 * World pose { pos, R } of the root of free entry `id` at absolute frame f (ctx = { spec, scene,
 * timeMap }): keys and falls (C17) from its scene pose. null for an id the scene does not know.
 */
export function freePoseAt(ctx, id, f) {
	const rest = restOf(ctx.scene, id), o = ctx.spec.objects?.[id];
	if (!rest || !o) return null;
	return walk(timelineOf(ctx, id, o, ctx.timeMap, "all"), f, { pos: rest.pos, R: rest.R }, planner(ctx, id));
}

const swings = new WeakMap();
/**
 * freePoseAt turned by the entry's spring (spec.objects[id].spring, compiler/spring.js), else freePoseAt: the pendulum
 * walks frames 0..f of the unswung pose, cached per spec, entry and time map. The one swing of a free entry: the take and
 * refs (object-pose.js rootPoseAt) and the obstacle boxes QA and fixes read (compiler/compile.js objectTracks).
 */
export function freeSwungAt(ctx, id, f) {
	const pose = freePoseAt(ctx, id, f), o = ctx.spec.objects?.[id];
	if (!pose || !o?.spring) return pose;
	if (!swings.has(ctx.spec)) swings.set(ctx.spec, new Map());
	const cache = swings.get(ctx.spec);
	let c = cache.get(id);
	if (!c || c.map !== ctx.timeMap || c.o !== o) cache.set(id, c = { map: ctx.timeMap, o, states: [], length: springLength(partsIn(ctx.scene, id).flatMap(p => corners(ctx.scene.objects[p]))) });
	const opts = { fps: ctx.spec.fps ?? 30, stiffness: o.spring.stiffness ?? SPRING.stiffness.default, damping: o.spring.damping ?? SPRING.damping.default, length: c.length };
	for (let k = c.states.length; k <= f; k++) c.states[k] = springStep(k ? c.states[k - 1] : springRest(), (k === f ? pose : freePoseAt(ctx, id, k)).pos, opts);
	return swungPose(pose, swingOf(c.states[f]));
}

/** Where carry `id` (entry o) is before its grab at absolute f: its scene pose, or where a fall before grab left it. */
export function beforeGrab(ctx, id, o, f, grab) {
	const rest = restOf(ctx.scene, id);
	if (!rest || !fallsOf(o).length) return rest && { pos: rest.pos, R: rest.R };
	return walk(timelineOf({ ...ctx, grab }, id, o, ctx.timeMap, "before"), f, { pos: rest.pos, R: rest.R }, planner(ctx, id));
}

/**
 * Where carry `id` (entry o) is at absolute f after its release, from its release pose; null without a fall from the release on.
 * `beforePose` (a frame before the release) gives the spin it is let go with to a fall that starts right at the release.
 */
export function afterRelease(ctx, id, o, f, release, releasePose, beforePose = null) {
	const events = fallsOf(o).length ? timelineOf({ ...ctx, release }, id, o, ctx.timeMap, "after") : [];
	// the release pose comes from the solved body, which a rebake changes: plan these falls afresh
	const plan = (start, fall) => fallPlan(ctx.spec, ctx.scene, id, start, fall.t, fall, ctx.spec.fps ?? 30, fall.t <= release + 1 ? beforePose : null);
	return events.length ? walk(events, f, releasePose, plan, false) : null;
}

/** True when carry entry o falls at or after its release (absolute frame; afterRelease then moves it). */
export function fallsAfter(ctx, o, release) {
	const map = ctx.timeMap ?? (f => f);
	return fallsOf(o).some(fl => map(fl.at) >= release);
}

/** The falls of entry `id` as planned under the current time map, for readers (timeline, tests): [{ t0, land, end, h, support, top }]. */
export function fallPlans(ctx, id) {
	const o = ctx.spec.objects?.[id];
	if (!isFree(o)) return [];
	freePoseAt(ctx, id, Infinity);
	return timelineOf(ctx, id, o, ctx.timeMap, "all").filter(e => e.plan).map(({ plan: { t0, land, end, h, support, top } }) => ({ t0, land, end, h, support, top }));
}
