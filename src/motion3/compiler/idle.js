// The idle layer: a body that holds its place is never a statue. Wherever the take holds a pose (no
// keyed channel changes: not a hand, a door or a finger) with its hands free (no arm on IK, no hand
// target or fit weight, nothing carried), it breathes (the chest lifts and settles:
// spine_pitch), lets its head drift a little (head_yaw, head_pitch) and, standing, shifts its weight
// from foot to foot (the hips sway over the planted feet, the pelvis lists toward the unloaded side and
// the spine rights it: root, roll, spine_roll). The layer only adds to channels that carry no contact:
// the feet, hand targets, anchors and objects are left as keyed, so a planted foot stays put and a hand
// on a target stays on it. It fades in RAMP s after the take starts or the body stops, out before it
// moves again, and stays off across the span of a `still` goal. Deterministic: its phases come from where the character
// first stands, so a recompile bakes the same take. spec.idle: false turns it off. The offsets ride on
// the solved pose only (compile.js solveFrame): out.baked keeps the keyed values, so QA's causes and
// patches still name the keys.
const BREATH = { period: 3.8, deg: 0.8 }, HEAD = { yaw: 0.9, pitch: 0.6 }, SWAY = { period: 5.6, m: 0.012, list: 1.4 };
const RAMP = 0.5, MOVE = 1e-4, TAU = 2 * Math.PI;
const smoothstep = x => x * x * (3 - 2 * x);
const differs = (a, b) => (Array.isArray(a) ? a.some((v, i) => Math.abs(v - b[i]) > MOVE)
	: a && typeof a === "object" ? Object.keys({ ...a, ...b }).some(k => Math.abs((a[k] ?? 0) - (b?.[k] ?? 0)) > 1e-3) : Math.abs((a ?? 0) - (b ?? 0)) > 0.01);

/** Phases in [0, TAU) from a text (FNV-1a hash, then mulberry32). */
function phases(text, n) {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
	let a = h >>> 0;
	return Array.from({ length: n }, () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), a | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * TAU;
	});
}

/** The weight of the layer per frame: 0 while anything keyed moves, a hand works or a still goal holds the body, easing to 1 RAMP s into a hold. */
function holdWeights(baked, spec, frameCount, fps) {
	// the take's first frame is its keyed pose: the layer fades in from there
	const moving = new Array(frameCount).fill(false), watch = Object.keys(baked);
	moving[0] = true;
	for (let f = 1; f < frameCount; f++) if (watch.some(ch => differs(baked[ch][f], baked[ch][f - 1]))) moving[f] = moving[f - 1] = true;
	// a working hand: an arm on IK, a hand target or fit weight, or an object carried from its grab on
	const hands = watch.filter(ch => /^(armw_[lr]|w_.+_[lr])$/.test(ch));
	for (let f = 0; f < frameCount; f++) if (hands.some(ch => baked[ch][f] > 1e-3)) moving[f] = true;
	for (const o of Object.values(spec.objects ?? {})) {
		if (!Number.isFinite(o?.grab)) continue;
		for (let f = Math.max(0, o.grab); f < Math.min(frameCount, Number.isFinite(o.release) ? o.release : frameCount); f++) moving[f] = true;
	}
	for (const g of spec.goals ?? []) {
		const at = Array.isArray(g?.at) ? g.at : null;
		if (g?.still === undefined || !at?.length) continue;
		for (let f = Math.max(0, Math.round(at[0])); f <= Math.min(frameCount - 1, Math.round(at[at.length - 1])); f++) moving[f] = true;
	}
	const ramp = Math.max(1, Math.round(RAMP * fps)), d = new Array(frameCount).fill(Infinity);
	for (let f = 0, last = -Infinity; f < frameCount; f++) { if (moving[f]) last = f; d[f] = f - last; }
	for (let f = frameCount - 1, next = Infinity; f >= 0; f--) { if (moving[f]) next = f; d[f] = Math.min(d[f], next - f); }
	return d.map(x => smoothstep(Math.min(1, x / ramp)));
}

/**
 * Per hand, how much it works at each frame: 1 while its arm is on IK, a hand target or fit weight of that hand is
 * on, or it carries an object from its grab on; easing to 0 over RAMP s away from that. pose.js keeps a working
 * hand's forearm on its slant (arm_hang), eased so the arm does not jump as it goes onto IK. null for an idle hand.
 */
export function busyHands(baked, spec, frameCount, fps) {
	const out = {}, ramp = Math.max(1, Math.round(RAMP * fps));
	for (const k of ["l", "r"]) {
		const own = Object.keys(baked).filter(ch => ch === `armw_${k}` || new RegExp(`^w_.+_${k}$`).test(ch));
		const busy = Array.from({ length: frameCount }, (_, f) => own.some(ch => baked[ch][f] > 1e-3));
		for (const o of Object.values(spec.objects ?? {})) {
			if (!Number.isFinite(o?.grab) || spec.props?.[o.prop]?.hand !== k) continue;
			for (let f = Math.max(0, o.grab); f < Math.min(frameCount, Number.isFinite(o.release) ? o.release : frameCount); f++) busy[f] = true;
		}
		if (!busy.some(Boolean)) { out[k] = null; continue; }
		const d = new Array(frameCount).fill(Infinity);
		for (let f = 0, last = -Infinity; f < frameCount; f++) { if (busy[f]) last = f; d[f] = f - last; }
		for (let f = frameCount - 1, next = Infinity; f >= 0; f--) { if (busy[f]) next = f; d[f] = Math.min(d[f], next - f); }
		out[k] = d.map(x => 1 - smoothstep(Math.min(1, x / ramp)));
	}
	return out;
}

/** The idle offsets per frame ({ channel: delta }, root a world [dx, 0, dz]) for the baked channels, or null (compile.js rebake). */
export function idleLayer(baked, { spec, sk, frameCount }) {
	if (spec.idle === false || !baked.root || !baked.foot_l || !baked.foot_r) return null;
	const fps = spec.fps ?? 30, w = holdWeights(baked, spec, frameCount, fps);
	if (!w.some(x => x > 0)) return null;
	const P = sk.restWorldPos, standY = P[sk.index.Hips][1], ankY = P[sk.index.LeftFoot][1];
	const [pb, py, pp, ps, py2] = phases(JSON.stringify([baked.root[0].map(v => v.toFixed(3)), (baked.yaw?.[0] ?? 0).toFixed(1)]), 5);
	const out = new Array(frameCount).fill(null);
	for (let f = 0; f < frameCount; f++) {
		if (!(w[f] > 0)) continue;
		const t = f / fps, k = w[f];
		// breathing in lifts the chest (spine_pitch + bends forward)
		const d = out[f] = { spine_pitch: -k * BREATH.deg * Math.sin((TAU * t) / BREATH.period + pb),
			head_yaw: k * HEAD.yaw * (0.6 * Math.sin((TAU * t) / 7.3 + py) + 0.4 * Math.sin((TAU * t) / 11.9 + py2)),
			head_pitch: k * HEAD.pitch * Math.sin((TAU * t) / 9.1 + pp) };
		// the weight shift: standing only (both feet flat on the floor, the hips at standing height)
		const feet = ["l", "r"].every(s => baked[`foot_${s}`][f][1] < ankY + 0.03 && Math.abs(baked[`fpitch_${s}`]?.[f] ?? 0) < 2);
		if (!feet || baked.root[f][1] < standY - 0.15) continue;
		const s = k * Math.sin((TAU * t) / SWAY.period + ps), yaw = ((baked.yaw?.[f] ?? 0) * Math.PI) / 180;
		d.root = [Math.cos(yaw) * SWAY.m * s, 0, -Math.sin(yaw) * SWAY.m * s];
		// the hips over the left foot drop the right side (roll +), the spine stays upright
		d.roll = SWAY.list * s;
		d.spine_roll = -SWAY.list * s;
	}
	return out;
}

/** Frame f's channels with the idle offsets added (a new object; c itself is left alone). */
export function withIdle(c, layer, f) {
	const d = layer?.[f];
	if (!d) return c;
	const out = { ...c };
	for (const [ch, v] of Object.entries(d)) out[ch] = Array.isArray(v) ? (Array.isArray(c[ch]) ? c[ch].map((x, i) => x + v[i]) : c[ch]) : (Number(c[ch]) || 0) + v;
	// the top spine bone's own share (chest_*, channels.js overlap) breathes and sways with the rest of the spine
	for (const ch of ["chest_pitch", "chest_roll"]) if (c[ch] !== undefined && d[ch.replace("chest", "spine")] !== undefined) out[ch] = c[ch] + d[ch.replace("chest", "spine")];
	return out;
}
