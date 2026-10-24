// walkTo's fit (C21): to with steps walks where the steps walk, so the steps are fitted to end at to in a natural
// gait for the rig (skills/basic.js walkTo calls fitTo when correct.js fitWalks asks), or the walk is refused.
import { len, sub } from "../compiler/math.js";
import { walk, stateAt } from "../compiler/walk.js";
import { partsOf } from "../object-pose.js";
import { standClearance } from "./stance.js";

/** The feet's midpoint [x, z] once the walk's keys have played out. */
export function walkEndAt(keys) {
	const st = stateAt(keys, Infinity);
	return [(st.foot_l[0] + st.foot_r[0]) / 2, (st.foot_l[2] + st.foot_r[2]) / 2];
}
export const r2 = v => Math.round(v * 100) / 100, xzText = p => `[${p.map(r2).join(", ")}]`;
// A natural gait for the rig (fitTo): a step STEP of the leg (hip to ankle: 0.25..0.7 m on the Y Bot), the first of a
// two-step walk FIRST of it (a short shuffle is a natural reposition), CADENCE steps a second, and the step over the cadence
// within RATIO of WALK_RATIO legs x s: a person's walk ratio (about 6.5 mm per step a minute, 0.39 m x s on a 0.83 m leg)
// holds from a slow walk to a brisk one, so longer steps come with quicker ones. A stride fitted at a fixed cadence went to
// 0.87 m at 1.2 steps a second in the agent sessions (a lunge); the walk generator slides or pops in most cadences from a
// 0.75 m step, and pops above 1.8 steps a second (31 of 47 fitted walks at period 12-13, none at 14-18; a person's brisk walk
// reaches 2.1).
const STEP = [0.3, 0.85], FIRST = [0.18, 0.85], CADENCE = [1, 1.8], WALK_RATIO = 0.47, RATIO = [0.7, 1.4], CHANGE = 0.1, HEADING_TOL = 20;
export const REACH_TOL = 0.1;
// A walk whose to lies within CLEAR legs (0.41 m on the Y Bot) of a body ahead of it (inside it, or its nearest point within
// 60 deg of the way the walk goes) stops before the body instead: a low body (top under LOW legs: a box on the floor, a crate)
// CLEAR from its near side, the feet's midpoint to its footprint, room to bend over it; a higher one (a table, a counter, a
// wall) where the standing body (stance.js: legs, feet, hips, arms down) clears it by GAP. The bench replay (n=692): steps
// fitted onto a to the agent had set 0.22-0.30 m from a box it then picked up walked the body into it (COLLIDE frames +58%,
// first-compile passes 28 -> 10); the build before the fit had stopped those walks 0.40-0.56 m from the box. One clearance
// for every body (0.41 m from a table too) cut COLLIDE frames as far but cost 59 goals and 127 REACH groups (a cup on the table
// out of reach); this split keeps the goals the fit gained (996, as 582d0501) with COLLIDE frames 80,853 -> 63,350 and
// first-compile passes 10 -> 19. A body taller than HEAD m at its foot (a shelf overhead), lower than SUPPORT (a mat), carried
// during the walk or sat on next is not in the way.
const CLEAR = 0.5, SUPPORT = 0.12, HEAD = 1.7, AHEAD = Math.cos(Math.PI / 3), LOW = 0.65, GAP = 0.05;
const legOf = sk => { const P = sk.restWorldPos, I = sk.index; return len(sub(P[I.LeftLeg], P[I.LeftUpLeg])) + len(sub(P[I.LeftFoot], P[I.LeftLeg])); };
// the bodies a walk may end against, as the still scene has them: what a hand carries during the walk (spec.objects with
// a grab before its end, not released before it starts), the seat a later sitInSeat sits on, its back, the car, and
// every part of their groups
function passable(ctx, end) {
	const scene = ctx.scene, ids = new Set(), add = id => { const top = scene?.objects?.[id]?.ancestors?.at(-1) ?? id; for (const part of partsOf(scene, top)) ids.add(part); };
	for (const u of (ctx.use ?? []).filter((x, j) => j !== ctx.index && x?.f0 >= ctx.f0 && x?.skill === "sitInSeat"))
		for (const id of [u.args?.seat, u.args?.seatBack, u.args?.car].filter(x => typeof x === "string")) add(id);
	for (const [id, o] of Object.entries(ctx.objects ?? {})) if (Number.isFinite(o?.grab) && o.grab <= end && !(o.release < ctx.f0)) for (const part of partsOf(scene, id)) ids.add(part);
	return ids;
}
// the feet's midpoint p = [x, z] to body o's footprint: [distance, the nearest point]
function footprint(o, p) {
	const c = o.R, dx = p[0] - o.pos[0], dz = p[1] - o.pos[2], lx = c[0][0] * dx + c[2][0] * dz, lz = c[0][2] * dx + c[2][2] * dz;
	const qx = Math.max(-o.half[0], Math.min(o.half[0], lx)), qz = Math.max(-o.half[2], Math.min(o.half[2], lz));
	const q = [o.pos[0] + c[0][0] * qx + c[0][2] * qz, o.pos[2] + c[2][0] * qx + c[2][2] * qz];
	return [Math.hypot(p[0] - q[0], p[1] - q[1]), q];
}
// the point of the approach from c0 (unit u) where a walk toward a to (at d) stops clear of the bodies ahead: { t, at, near }, or null
function clearStop(ctx, c0, u, d, skip, clear, h) {
	const to = [c0[0] + u[0] * d, c0[1] + u[1] * d], leg = legOf(ctx.sk);
	const ahead = Object.entries(ctx.scene?.objects ?? {}).filter(([id, o]) => !skip.has(id) && o.half && o.pos && o.R && o.pos[1] < HEAD && o.pos[1] + 2 * o.half[1] * o.R[1][1] > SUPPORT)
		.map(([id, o]) => { const [dist, q] = footprint(o, to); return { id, o, dist, q, low: o.pos[1] + 2 * o.half[1] * o.R[1][1] < LOW * leg }; })
		.filter(b => b.dist < clear && (b.dist < 1e-6 || ((b.q[0] - to[0]) * u[0] + (b.q[1] - to[1]) * u[1]) >= AHEAD * b.dist)).sort((a, b) => a.dist - b.dist);
	if (!ahead.length) return null;
	const at = s => [c0[0] + u[0] * s, c0[1] + u[1] * s], high = new Set(Object.keys(ctx.scene.objects).filter(id => !ahead.some(b => b.id === id && !b.low)));
	const blocked = s => ahead.some(b => b.low && footprint(b.o, at(s))[0] < clear) || (ahead.some(b => !b.low) && standClearance(ctx.sk, ctx.scene, at(s), h, high) < GAP);
	if (!blocked(d)) return null;
	let t = d;
	while (t > 0 && blocked(t)) t -= 0.01;
	return t > REACH_TOL ? { t, at: at(t), near: ahead[0].id, gap: footprint(ahead[0].o, at(t))[0] } : null;
}
// the last frame a walk whose stepping ends at `from` may end at: the first later frame another skill starts at, a key of the
// spec (or an object key, grab or release: ctx.fit.busy) after its stepping, or the take's last frame (ctx.fit.last)
const roomAfter = (ctx, from) => Math.min(ctx.fit.last ?? Infinity, ...(ctx.use ?? []).filter((x, j) => j !== ctx.index && x?.f0 > ctx.f0).map(x => x.f0),
	...ctx.keys.filter(k => k.f > from && /^keys\[/.test(k.src ?? "")).map(k => k.f), ...(ctx.fit.busy ?? []).filter(f => f > from));

/**
 * to with steps (C21): the steps walk where they walk, and to only turns the heading, so a walk with both is fitted
 * when ctx.fit asks (correct.js fitWalks, before the spec is stored), in a natural gait (the bands above):
 *   the stride (steps >= 3, the first step keeping its share of it) or the first step (steps 2) that makes the steps end
 *   at to, when it stays in its band and in the walk ratio band at the walk's cadence;
 *   else the step count whose stride is nearest the walk ratio, its stride and cadence in their bands: in the walk's own
 *   stepping time (steps x period frames, the period the one that fits, never ending later; fewer steps stand at the end),
 *   or at the walk's own period when nothing comes after it in a frames "auto" spec (ctx.fit.stretch: it may end later);
 *   else more steps that end later, into frames nothing uses (roomAfter), at the walk's own cadence or a quicker natural one;
 *   else the walk's own steps at its band's edge when they still end within REACH_TOL of to (a walk that near is not fitted);
 *   else, or for a heading that points away from to, a line in ctx.fit.refusals with what the walk would do and needs.
 * The last two were refusals until the bench (S7, S10: 3 of 7 walkTo refusals in 30 merged runs, 4 walks): each had one in
 * the bands (step 0.7 m at 1.33-1.5 steps a second ending 0.05-0.07 m short, or 4 steps at 1.71 steps a second ending 2
 * frames later into free frames) whose whole take had no foot, knee or float problem in the walk the in-band walks lacked.
 * Deterministic: a walk at a candidate count is estimated (its end is linear in the stride) and the chosen one walked
 * once more to set its stride. -> { gen, adjust } with the fitted gen.
 */
export function fitTo(ctx, gen, c0, d, bearing) {
	const { args, tag, sk } = ctx, steps = gen.steps, h = Array.isArray(args.heading) ? args.heading[1] : args.heading;
	const off = h === undefined ? 0 : Math.abs(((h - bearing) % 360 + 540) % 360 - 180);
	if (off > HEADING_TOL) {
		ctx.fit.refusals.push(`${tag}: heading ${h} points ${Math.round(off)} deg away from to ${xzText(args.to)} (it lies at heading ${Math.round(bearing)}), so the walk would not go there; with to the walk turns toward it by itself: leave heading out, or give heading without to to walk that way`);
		return { gen };
	}
	const period = gen.period ?? 20, swing = gen.swing ?? 14, was = gen.step ?? 0.5, first = gen.firstStep ?? 0.4;
	if (args.steps === undefined || args.arrive !== undefined || !(steps >= 2) || ![steps, period, swing, was, first].every(Number.isFinite)) return { gen };
	const u = [Math.sin(bearing * Math.PI / 180), Math.cos(bearing * Math.PI / 180)];
	// to against a body: the steps end at the nearest point of the approach where the body stands clear of it; when no
	// natural gait ends there, the fit to to itself (and its refusal) as before
	// (ctx.fit.noStop: the walks correct.js fitWalks keeps on to, as a stop would make a later walk refuse; ctx.fit.stopped: the walks that stopped)
	const stop = !ctx.fit.noStop?.has(ctx.index) && clearStop(ctx, c0, u, d, passable(ctx, ctx.f0 + 16 + steps * period + 18), CLEAR * legOf(sk), bearing);
	let r = stop && fitSteps(ctx, gen, c0, u, stop.t, stop);
	if (r && !r.refuse) ctx.fit.stopped?.add(ctx.index);
	if (!r || r.refuse) r = fitSteps(ctx, gen, c0, u, d, null);
	if (r.refuse) ctx.fit.refusals.push(r.refuse);
	return { gen: r.gen, ...(r.adjust ? { adjust: r.adjust } : {}) };
}

/** fitTo's stride, step count and cadence for a walk ending d along u from c0 (stop: the clear point it ends at) -> { gen, adjust? } or { gen, refuse } */
function fitSteps(ctx, gen, c0, u, d, stop) {
	const { args, tag, sk } = ctx, steps = gen.steps, period = gen.period ?? 20, swing = gen.swing ?? 14, was = gen.step ?? 0.5, first = gen.firstStep ?? 0.4;
	const target = stop ? `${xzText(stop.at)}, ${r2(stop.gap)} m before ${stop.near} (to ${xzText(args.to)} is against it)` : `to ${xzText(args.to)}`;
	const reach = g => { const e = walkEndAt(walk(g, ctx.keys, sk, tag)); return { end: e, along: (e[0] - c0[0]) * u[0] + (e[1] - c0[1]) * u[1] }; };
	const { end, along } = reach(gen);
	if (Math.abs(d - along) <= REACH_TOL) return { gen };
	const fps = ctx.fps ?? 24, leg = legOf(sk), nat = WALK_RATIO * leg, span = steps * period;
	const band = n => (n >= 3 ? STEP : FIRST).map(x => r2(x * leg)), pLo = Math.ceil(fps / CADENCE[1]), pHi = Math.floor(fps / CADENCE[0]);
	const stretch = ctx.fit.stretch === true && !(ctx.use ?? []).some((x, j) => j !== ctx.index && x?.f0 > ctx.f0) && !ctx.keys.some(k => k.f > ctx.f0 && /^keys\[/.test(k.src ?? ""));
	// n steps: the period (its own, or the one that keeps the stepping time), the stride that ends them at to (the end moves
	// by the first step and a stride a middle step, rest the closing step's share; with steps 3 and up the first step keeps
	// its share of the stride unless args give it, as a person's first step is a little shorter), whether they stay in their bands
	const rest = along - first - (steps - 2) * was, share = args.firstStep === undefined ? first / was : 0;
	const at = (n, pAt) => {
		const p = pAt ?? (stretch || n === steps ? period : Math.min(Math.max(pHi, period), Math.floor(span / n))), name = n >= 3 ? "step" : "firstStep";
		const value = n >= 3 ? (d - rest - (share ? 0 : first)) / (share + n - 2) : d - rest, lead = n >= 3 && share ? share * value : first;
		const [lo, hi] = band(n), ratio = value * p / fps / nat, inBand = (x, [a, b]) => x >= a && x <= b;
		return { n, p, name, value, ratio, ok: inBand(value, [lo, hi]) && inBand(lead, band(2)) && (p === period || inBand(p, [pLo, pHi])) };
	};
	const own = at(steps), most = Math.min(60, Math.ceil(d / band(3)[0]) + 2);
	let pick = own.ok && own.ratio >= RATIO[0] && own.ratio <= RATIO[1] ? own : null, room, short;
	// nearest the walk ratio, a step count further from the one asked costing CHANGE of it a step
	const cost = c => Math.abs(Math.log(c.ratio)) + CHANGE * Math.abs(c.n - steps), nearest = list => list.filter(c => c.ok).sort((a, b) => cost(a) - cost(b) || a.n - b.n)[0];
	const counts = Array.from({ length: most - 1 }, (_, i) => i + 2);
	if (!pick) pick = nearest(counts.map(n => at(n)));
	if (!pick && !stretch) {
		// more steps, ending later into frames nothing uses: the walk's own period, or the slowest natural one that ends in time
		room = roomAfter(ctx, ctx.f0 + 16 + span);
		pick = nearest(counts.filter(n => n > steps).map(n => at(n, Math.min(period, Math.floor((room - ctx.f0 - 34) / n)))).filter(c => c.p >= pLo && c.n * c.p > span));
	}
	if (!pick) {
		// the walk's own steps at its band's edge, when they end within REACH_TOL of to
		const [lo, hi] = band(steps), value = Math.min(hi, Math.max(lo, own.value)), ratio = value * period / fps / nat, lead = steps >= 3 && share ? share * value : first;
		const g = { ...gen, [own.name]: r2(value), ...(steps >= 3 && share ? { firstStep: r2(lead) } : {}) };
		const left = ratio >= RATIO[0] && ratio <= RATIO[1] && lead >= band(2)[0] && lead <= band(2)[1] ? d - reach(g).along : Infinity;
		if (Math.abs(left) <= REACH_TOL) ({ pick, short } = { pick: { ...own, value: r2(value), ratio }, short: left });
	}
	const [sLo, sHi] = band(3), gait = `a natural gait (step ${sLo}..${sHi} m, ${CADENCE[0]}..${CADENCE[1]} steps a second: period ${pLo}..${pHi} at ${fps} fps`;
	const miss = `${r2(Math.abs(d - along))} m ${along < d ? "short of" : "past"} ${stop ? `the point ${xzText(stop.at)} clear of ${stop.near} before to ${xzText(args.to)}` : `to ${xzText(args.to)}`} (${r2(d)} m away)`;
	if (!pick) {
		// short: the fewest steps at the longest natural step, at the quickest natural cadence (the least stepping time that reaches)
		const n = 2 + Math.ceil((d - rest - first) / sHi - 1e-9), e = ctx.f0 + 16 + n * pLo + 18;
		return { gen, refuse: `${tag}: steps ${steps} at period ${period} (${span} frames of stepping) walk ${r2(along)} m and end at ${xzText(end)}, ${miss}; ${along < d
			? `in ${gait}) that takes ${n} steps and ${n * pLo} frames of stepping or more (the walk would end at f${e} or later, not f${ctx.f0 + 16 + span + 18}): leave steps${args.step === undefined ? "" : " and step"} out (walkTo picks the count), or give steps: ${n} and room for the walk before what follows`
			: `no natural step count ends there: leave steps out (walkTo picks the count)`}` };
	}
	const timed = pick.p === period ? {} : { period: pick.p, swing: Math.max(2, Math.min(pick.p - 1, Math.round(swing * pick.p / period))) };
	const lead = pick.n >= 3 && share > 0, strides = v => ({ [pick.name]: r2(v), ...(lead ? { firstStep: r2(share * v) } : {}) });
	let fitted = { ...gen, steps: pick.n, ...timed, ...strides(pick.value) };
	const left = short ?? d - reach(fitted).along;
	if (short === undefined && Math.abs(left) > 0.02) fitted = { ...fitted, ...strides(pick.value + left / (pick.n >= 3 ? share + pick.n - 2 : 1)) };
	const v = fitted[pick.name], dflt = pick.name === "step" ? was : first, e0 = ctx.f0 + 16 + span + 18, e1 = ctx.f0 + 16 + pick.n * pick.p + 18;
	const changes = [pick.n !== steps && `steps ${steps} -> ${pick.n}`, timed.period && `period ${period} -> ${timed.period} (swing ${swing} -> ${timed.swing})`, `${pick.name} ${dflt} -> ${v} m`,
		lead && fitted.firstStep !== first && `firstStep ${first} -> ${fitted.firstStep} m`].filter(Boolean).join(", ");
	const when = e1 === e0 ? "" : `; it ends f${e1}, not f${e0} (${stretch ? "nothing follows it" : e1 > e0 ? `nothing uses f${e0 + 1}-f${e1}` : `the pose holds to f${e0}`})`;
	const needs = `steps ${steps} would need a ${own.name} of ${r2(own.value)} m at ${r2(fps / period)} steps a second`;
	const why = short !== undefined ? ` (${gait}; ${needs})` : pick.n === steps && !timed.period ? ` (at ${pick.name} ${dflt} they walk ${r2(along)} of ${r2(d)} m)` : ` in ${gait}; ${needs})${when}`;
	const ends = short === undefined ? `end at ${target}` : `end ${r2(Math.abs(short))} m ${short > 0 ? "short of" : "past"} ${target}, the ${short > 0 ? "longest" : "shortest"} natural step`;
	const adjust = { args: { ...(pick.n === steps ? {} : { steps: pick.n }), ...timed, [pick.name]: v, ...(lead && fitted.firstStep !== first ? { firstStep: fitted.firstStep } : {}) }, note: `${tag}: ${changes}, so steps ${pick.n} ${ends}${why}` };
	return { gen: fitted, adjust };
}
