// Basic skills: stand, walk, reach-and-grip. Each reads the channel state the earlier keys
// leave at its f0 and returns keys plus whatever anchors, props, fits and checks it needs.
import { add, apply, ry } from "../compiler/math.js";
import { walk } from "../compiler/walk.js";
import { keyBook, skillError } from "./book.js";
import { walkEnd } from "./info.js";
import { fitTo, walkEndAt, r2, xzText, REACH_TOL } from "./walk-fit.js";
import { GRASP_FINGERS, GRASP_POINTS } from "../compiler/vocab.js";
import { clearStance, reachStance } from "./stance.js";
import { CLOSE, GAZE, gazeAt, headKeyed, earlyTransport, holdsOpen, transportKeys } from "./reach-human.js";

/** The fingers' point a reachGrip fits onto its anchor: the finger middles, or where a grasp holds the thing (the palm is -n on the right hand). */
const graspPoint = (grasp, k) => (GRASP_POINTS[grasp] ? GRASP_POINTS[grasp].map((v, i) => (i === 2 && k === "r" ? -v : v)) : [0, 0, 0]);

/**
 * standIdle({ at: [x, z], heading = 0, until }): a neutral standing pose, arms down (FK). Without `at` (and no root
 * keyed) before a reachGrip it stands within that hand's reach of the anchor, facing it; a stance in a scene body
 * slides out of it (stance.js). Either says so in `placed`.
 */
export function standIdle(ctx) {
	const { sk, args, state } = ctx, I = sk.index, P = sk.restWorldPos, ank = P[I.LeftFoot][1];
	let h = args.heading ?? state.yaw ?? 0, base = args.at ?? (state.root ? [state.root[0], state.root[2]] : null), placed = null;
	if (!base) {
		const auto = reachStance(ctx);
		if (!auto) skillError(ctx.tag, "needs args.at: [x, z] (no root is keyed before f0), or a reachGrip after it to stand within reach of");
		({ at: base, heading: h } = auto);
		placed = { at: base, heading: h, why: `within reach of anchor ${auto.anchor}` };
	} else if (args.at && ctx.place !== false) {
		const out = clearStance(sk, ctx.scene, [base[0], base[base.length - 1]], h);
		if (out) { base = out.at; placed = { at: base, heading: h, why: `moved ${out.moved} m out of a scene body` }; }
	}
	const c = [base[0], 0, base[base.length - 1]], R = ry(h), foot = v => { const p = add(c, apply(R, v)); p[1] = ank; return p; };
	const set = { root: [c[0], P[I.Hips][1] - 0.01, c[2]], yaw: h, pitch: 0, roll: 0, spine_yaw: 0, spine_pitch: 0, spine_roll: 0, head_yaw: 0, head_pitch: 0,
		foot_l: foot([0.09, 0, -0.03]), foot_r: foot([-0.09, 0, 0.03]), fyaw_l: h, fyaw_r: h, fpitch_l: 0, fpitch_r: 0, knee_l: [0.05, 0, 1], knee_r: [-0.05, 0, 1],
		armw_l: 0, armw_r: 0, aswing_l: 0, aswing_r: 0, abend_l: 0, abend_r: 0, arm_hang: 1 };
	const keys = [{ f: ctx.f0, set }];
	if (args.until !== undefined) keys.push({ f: args.until, set: structuredClone(set) });
	return { keys, end: args.until ?? ctx.f0, ...(placed ? { placed } : {}) };
}

/**
 * walkTo({ to: [x, z] } | { heading: h | [h0, h1] }, steps, step = 0.5, turnDistance, ...): the
 * walk generator from the pose at f0. With `to` the heading turns toward the point and the step
 * count covers the distance; with steps as well the stride is fitted so they end there (fitTo). Ends
 * 16 + steps * period + 18 frames after f0, feet together; a take that ends after the last step holds
 * that pose to its end. A walk with `to` that ends more than 0.1 m from it says where in `placed`. The
 * steps keep a natural rhythm (compiler/gait-rhythm.js); vary: 0 makes every step the same.
 */
export function walkTo(ctx) {
	const { args, state } = ctx;
	if (!state.foot_l || !state.foot_r || !state.root) skillError(ctx.tag, "needs a standing pose keyed before f0 (use standIdle or another skill first)");
	let gen = { type: "walk", f0: ctx.f0, ...args }, adjust, c0, h1;
	delete gen.to; delete gen.arrive;
	const h0 = state.yaw ?? 0, step = args.step ?? 0.5, first = args.firstStep ?? 0.4;
	if (args.to) {
		c0 = [(state.foot_l[0] + state.foot_r[0]) / 2, (state.foot_l[2] + state.foot_r[2]) / 2];
		const dx = args.to[0] - c0[0], dz = args.to[args.to.length - 1] - c0[1], d = Math.hypot(dx, dz);
		h1 = Math.atan2(dx, dz) * 180 / Math.PI;
		while (h1 - h0 > 180) h1 -= 360;
		while (h1 - h0 < -180) h1 += 360;
		gen.heading = args.heading ?? [h0, h1];
		gen.steps = args.steps ?? Math.max(2, 2 + Math.round((d - first) / step));
		if (typeof gen.heading === "number") gen.heading = [h0, gen.heading];
		if (ctx.fit && d > REACH_TOL) ({ gen, adjust } = fitTo(ctx, gen, c0, d, h1));
	}
	if (typeof gen.heading === "number") gen.heading = [h0, gen.heading];
	const keys = walk(gen, ctx.keys, ctx.sk, ctx.tag), end = walkEnd(gen), last = ctx.frames - 1;
	const at = args.to && walkEndAt(keys), miss = at ? Math.hypot(at[0] - args.to[0], at[1] - args.to[args.to.length - 1]) : 0;
	const placed = miss > REACH_TOL ? { placed: { at: at.map(r2), heading: Math.round(gen.heading?.[1] ?? h0), why: `ends ${r2(miss)} m from to ${xzText(args.to)}` } } : {};
	const more = { ...placed, ...(adjust ? { adjust } : {}) };
	// the settle after the last step only holds the pose: a take that ends in it ends the walk there
	if (end > last && Math.max(...keys.filter(k => k.f < end).map(k => k.f)) <= last) return { keys: keys.filter(k => k.f <= last), end: last, cut: `settle cut at f${last} (hold to the end)`, ...more };
	return { keys, end, ...more };
}

/** base when `props` has no other prop of that name (the same one again is fine), else base_<side>, base_<side>2, ... */
function freeName(props = {}, base, k, mine) {
	const taken = n => props[n] && JSON.stringify(props[n]) !== JSON.stringify(mine);
	if (!taken(base)) return base;
	let name = `${base}_${k}`;
	for (let i = 2; taken(name); i++) name = `${base}_${k}${i}`;
	return name;
}

/** What a hand on `obj` may touch: the object, or for a group (an Empty, no body of its own) every part under it. */
const touchable = (scene, obj) => {
	const objects = scene?.objects ?? {};
	if (!obj || objects[obj] || obj.startsWith("person:")) return obj ? [obj] : [];
	const parts = Object.keys(objects).filter(k => objects[k].ancestors?.includes(obj));
	return parts.length ? parts : [obj];
};

/**
 * reachGrip({ anchor, side, reach = 20, hold = 22, release = 12, elbow, fingers = "grip",
 * define, orient = true }): the hand goes to the anchor (defined elsewhere, or by `define`) over
 * `reach` frames with the fingers closing, holds, and lets go. Adds a fit of the fingertips on the
 * anchor (on a body it also turns the hand into a grip, compiler/grip.js; orient: false leaves the
 * hand's turn alone) and a contact check. A take that ends during the release holds the grip to its end.
 */
export function reachGrip(ctx) {
	const { args, state } = ctx, k = args.side, name = args.anchor;
	if (k !== "l" && k !== "r") skillError(ctx.tag, `args.side must be "l" or "r", got ${JSON.stringify(k)}`);
	if (typeof name !== "string" || /_[lr]$/.test(name)) skillError(ctx.tag, "args.anchor must name an anchor (not ending in _l/_r)");
	const reach = args.reach ?? 20, hold = args.hold ?? 22, release = args.release ?? 12;
	// an anchor that takes a grasp closes the hand to that grasp's fingers (../sockets.js)
	const grasp = (args.define ?? ctx.anchors?.[name])?.grasp, preset = args.fingers ?? GRASP_FINGERS[grasp] ?? "grip";
	const w = `w_${name}_${k}`, fg = `fingers_${k}`, armw = `armw_${k}`, el = `elbow_${k}`, wasFk = !(state[armw] > 0.5);
	// a take that ends before the hand lets go cuts the hold or the release: the grip holds to the last frame (a hold
	// asked past the end was refused, session 7f15b4ae: "needs 92 frames from f10 (to f102), past the last frame f85")
	const last = ctx.frames - 1, cut = ctx.f0 + reach <= last && ctx.f0 + reach + hold + release > last;
	const held = Math.min(reach + hold, last - ctx.f0);
	for (const [c, v] of [[w, 0], [fg, { [preset]: 0 }], [armw, 0]]) if (state[c] === undefined) state[c] = v;
	// the head looks at what the hand goes for unless the keys already move it (reach-human.js); read before the keys move state
	// the reach's own view: a thing that spec.objects moves before the hand gets there is not at rest (reach-human.js)
	const end = reach + hold + release, rc = { ...ctx, until: ctx.f0 + reach };
	const look = !headKeyed(ctx.keys ?? [], ctx.f0, ctx.f0 + end) && gazeAt(rc, args.define ?? ctx.anchors?.[name], state);
	const head = look ? { head_yaw: state.head_yaw ?? 0, head_pitch: state.head_pitch ?? 0 } : null;
	const b = keyBook(state, ctx.f0);
	b.hold(0, w, fg, armw, el, ...(look ? ["head_yaw", "head_pitch"] : []));
	// the transport's early-peaked bell; on a thing the open hand clears, the fingers stay open to CLOSE of the reach, then close
	// (a reach for a moving point, or below the knees, keeps the plain ease: reach-human.js earlyTransport)
	const target = args.define ?? ctx.anchors?.[name], w0 = state[w], a0 = state[armw], lerp = (a, z, t) => a + (z - a) * t;
	if (earlyTransport(rc, target)) for (const [f, t, ta] of transportKeys(reach)) b.at(f, { [w]: lerp(w0, 1, t), [armw]: lerp(a0, 1, ta) });
	const close = Math.round(CLOSE * reach);
	if (close > 0 && close < reach && holdsOpen(rc, target, state)) b.hold(close, fg);
	if (look) b.at(Math.max(1, Math.round(GAZE * reach)), look);
	b.at(reach, { [w]: 1, [fg]: { ...state[fg], [preset]: 1 }, [armw]: 1, ...(args.elbow ? { [el]: args.elbow } : {}) });
	b.hold(held, w, fg, armw, el, ...(look ? ["head_yaw", "head_pitch"] : []));
	if (!cut) b.at(end, { [w]: 0, [fg]: { ...state[fg], [preset]: 0 }, ...(wasFk ? { [armw]: 0 } : {}), ...(head ?? {}) });
	// the fingers' prop is <anchor>Grip, unless the spec (or another skill) has a prop of that name of its own: its points
	// would replace these (session 7f15b4ae: props.ballGrip for a carry broke reachGrip on anchor "ball")
	const S = k === "l" ? "Left" : "Right", fingersProp = { hand: k, origin: [`${S}HandIndex2`, `${S}HandMiddle2`], points: { fingers: graspPoint(grasp, k) } };
	const prop = freeName(ctx.props, `${name}Grip`, k, fingersProp);
	const def = args.define ? { [name]: args.define } : {};
	// the hand may touch what it grips: an object, or the other person (people.js) whose joint the anchor is on
	const a = args.define ?? ctx.anchors?.[name], obj = a?.kind === "object" ? a.object : a?.kind === "person" ? `person:${a.person}` : null;
	return {
		keys: b.keys, end: cut ? last : ctx.f0 + reach + hold + release, ...(cut ? { cut: `${held < reach + hold ? "hold" : "release"} cut at f${last} (hold to the end)` } : {}), anchors: def,
		props: { [prop]: fingersProp },
		fits: [{ side: k, anchor: name, effector: { prop, point: "fingers" }, ...(args.orient === false ? { orient: false } : {}) }],
		checks: { contacts: [{ name: `fingers on ${name}`, point: `prop:${prop}.fingers`, target: `anchor:${name}`, tol: 0.04, when: w }],
			allow: touchable(ctx.scene, obj).map(object => ({ part: "hand", object, depth: 0.04 })) },
	};
}
