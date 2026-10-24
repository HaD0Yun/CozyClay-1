// Overlap (spec.flow.overlap, on by default): a body does not start or stop all at once. A change breaks
// along the chains one link after another: the lower spine, then the chest, then the head; the upper arm,
// then the forearm, then the hand; each link starts later and settles later than the one it hangs from.
// The agent keys five channels on one frame and both arms on the same frames (the user's tutorial take:
// 7 of 7 parts within +-1 frame, observations.life sync 0.81), and a constant trail per family moves the
// whole curve of a family at once, so every link of it still starts on one frame. Here each link takes its
// own delay at each of its keys (LINK frames at 24 fps, less for a short move: LINK * h / FULL for a move
// of h frames, so a quick flick is not smeared and a key pose is reached long before the next key), one
// side of the body trails the other by SIDE frames chosen per key frame (a hash of the spec's label and the
// key frame, so the same spec bakes the same take and both arms keyed on one frame part on different ones),
// and the arm's swing and bend, the distal swing, overshoot a little where they stop and settle back
// (SETTLE: a bounded hump, then exactly the keyed value, so a hold stays flat after it). Only the body's
// own swing moves: the channels that place it (feet, root, yaw, hand targets and weights, poles, fingers,
// objects) are untouched, so every contact lands as keyed; an arm on its IK loses it with the rest of
// flow (channels.js), and a skill that times its own motion (a walk's rhythm, a flip, a hit) keeps its keys
// on time: the delay is for the agent's keys (and standIdle's pose), easing in and out around the rest.
// frames for a FULL-frame move; the arm's swing and bend also trail the body by flow.lag.arms (3), the wrist (no flow of
// its own) here: after the forearm
// its own) here: after the forearm. A free IK hand (hand target, IK weight and pole together: hand) takes no delay of its
// own, only its side's trail, so both hands keyed on one frame part
const LINK = { spine: 1, chest: 2.5, head: 3.5, aswing: 3, abend: 5, wrist: 9.5, hand: 0 };
/** A hand keeps its keyed time within CONTACT frames of a contact: an anchor or fit weight on, a carry, a hand goal (handBusy). */
const CONTACT = 6, SNAP = 6;
const FULL = 24, SIDE = [1.5, 3];
/** How fast a delay may change, frames a frame: under 1 time still runs forward; it also runs out this fast before an arm's IK. */
export const OVERLAP_SLOPE = 0.5;
const MOVE_SLOPE = 0.2, TRAIL_SLOPE = 0.15;
const SETTLE = { frames: 8, min: 6, frac: 0.08, max: 3 };
const SETTLES = /^(aswing|abend|wflex)_[lr]$/;
// a skill times its own motion (a flip, a hit, a walk: walk.js tags its steps); standIdle only sets the pose the agent's keys start from
const OWN_TIMING = /^use\[\d+\] (?!standIdle$)|\bwalk(To)? (start|step \d+|end)$/;

const ownTiming = p => OWN_TIMING.test(p?.src ?? "");

/** The chain link a channel moves, or null (a placement channel, or one overlap leaves alone). */
function linkOf(ch) {
	const m = /^(spine|chest|head)_(yaw|pitch|roll)$|^(aswing|abend|wflex|wtwist)_[lr]$|^(hand|armw|elbow)_[lr]$/.exec(ch);
	if (!m) return null;
	return m[1] ?? (m[4] ? "hand" : m[3] === "wflex" || m[3] === "wtwist" ? "wrist" : m[3]);
}

/** text -> a number in [-1, 1) (FNV-1a hash, then one mulberry32 step; gait-rhythm.js noiseOf). */
function unit(text) {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
	let t = Math.imul((h >>> 0) ^ ((h >>> 0) >>> 15), (h >>> 0) | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
}

/** A delay a key at a time, eased between keys: { max, at(q) }, or null when it is 0 throughout. */
function delayCurve(x, lam, slope) {
	const n = x.length;
	for (let i = 1; i < n; i++) lam[i] = Math.min(lam[i], lam[i - 1] + slope(i - 1));
	for (let i = n - 2; i >= 0; i--) lam[i] = Math.min(lam[i], lam[i + 1] + slope(i));
	if (!lam.some(v => v > 0)) return null;
	return {
		max: Math.max(...lam),
		at(q) {
			if (q <= x[0]) return lam[0];
			if (q >= x[n - 1]) return lam[n - 1];
			let i = 0;
			while (q > x[i + 1]) i++;
			return lam[i] + ((lam[i + 1] - lam[i]) * (q - x[i])) / (x[i + 1] - x[i]);
		},
	};
}

/**
 * The delay (frames) of a link, on top of its side's trail (sideTrail), at each frame, or null. pts: the channel's
 * keys ({ f, value, src }); scale: flow.overlap (1 the default). A delay is set at each key (the move that leaves it:
 * LINK for a FULL-frame move, less for a shorter one), 0 at (and into) a skill's own keys and at keys next to an arm's
 * IK (gap: frames to the nearest IK frame per frame, ikGap), and eased between keys no steeper than OVERLAP_SLOPE
 * frames a frame on a hold and MOVE_SLOPE across a move, so time still runs forward and a hold keeps its length.
 */
export function overlapDelay(ch, pts, scale, seed, gap = null) {
	const link = linkOf(ch);
	if (!link || !LINK[link] || !(scale > 0) || pts.length < 2) return null;
	const x = pts.map(p => p.f), n = x.length;
	const lam = x.map((f, i) => {
		// a move on, into or out of an arm's IK keeps its keyed time (gap: frames to its IK, ikGap); the delay comes and goes on the holds around it
		if (ownTiming(pts[i]) || ownTiming(pts[i + 1]) || (gap && [x[i - 1], f, x[i + 1]].some(g => g !== undefined && gap[g] < 2))) return 0;
		return LINK[link] * Math.min(1, (i < n - 1 ? x[i + 1] - f : FULL) / FULL) * scale;
	});
	// a delay changes on a hold, where nothing shows it; across a move only by MOVE_SLOPE (its speed within about 20%)
	return delayCurve(x, lam, i => (pts[i].value === pts[i + 1].value ? OVERLAP_SLOPE : MOVE_SLOPE) * (x[i + 1] - x[i]));
}

/**
 * One side's trail: the whole arm of that side (its swing, bend and wrist, and as a free IK hand its target, IK weight
 * and pole) runs this many frames late, so both arms keyed on one frame part, and the arm's FK and IK stay in step
 * while it blends between them. keys: the keys of that arm's channels ({ f, src }). At each key frame the side
 * that trails (a hash of seed and frame: both sides agree) takes SIDE[0]..SIDE[1] frames, no more than a third of the
 * moves either side of the key; none at a snap (moves under SNAP frames: a trail changing across one bends it), at a
 * skill's own keys, or within CONTACT frames of the hand's contacts (gap: contactGap). channels: each of the arm's
 * channels' keys ({ f, value, src }), the IK weight's list marked weight: true.
 */
export function sideTrail(channels, side, scale, seed, gap = null) {
	// one point a frame, a skill's own if any key on it is; the spans where some channel of the arm moves
	const byFrame = new Map(), moves = [], same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
	for (const list of channels) {
		for (const p of list) if (!byFrame.has(p.f) || ownTiming(p)) byFrame.set(p.f, p);
		for (let i = 1; i < list.length; i++) if (!same(list[i - 1].value, list[i].value)) moves.push([list[i - 1].f, list[i].f, list.weight]);
	}
	const keyFrames = [...byFrame.values()].sort((a, b) => a.f - b.f);
	if (!(scale > 0) || keyFrames.length < 2) return null;
	const x = keyFrames.map(p => p.f), n = x.length;
	const lam = x.map((f, i) => {
		// the take starts on its keys
		if (f === 0 || ownTiming(keyFrames[i]) || ownTiming(keyFrames[i + 1]) || (gap && [x[i - 1], f, x[i + 1]].some(g => g !== undefined && gap[g] < 2))) return 0;
		const u = unit(`${seed}|${f}`), short = Math.min(i < n - 1 ? x[i + 1] - f : FULL, i > 0 ? f - x[i - 1] : FULL);
		if ((u < 0 ? "l" : "r") !== side || short < SNAP) return 0;
		return Math.min(SIDE[0] + (SIDE[1] - SIDE[0]) * Math.abs(u), short / 3) * Math.min(1, scale);
	});
	// the trail changes freely while the whole arm holds; across a move by TRAIL_SLOPE (its speed within about 15%), and
	// never across a change of the IK weight: the blend of FK and IK there turns a changing trail into a pop of the hand
	const across = i => moves.filter(([a, b]) => a < x[i + 1] && b > x[i]), h = i => x[i + 1] - x[i];
	return delayCurve(x, lam, i => (!across(i).length ? OVERLAP_SLOPE : across(i).some(m => m[2]) ? 0 : TRAIL_SLOPE) * h(i));
}

const hump = u => (u <= 0 || u >= 1 ? 0 : 64 * (u * (1 - u)) ** 3);

/**
 * The distal swing's follow-through (the arm's swing and bend, the wrist's flex): a bump (degrees, by curve time) added where a move stops (a key whose
 * next key holds its value, or the last key): it peaks SETTLE.frac of the move (SETTLE.max deg at most) past
 * the key a quarter of the way in and is gone SETTLE.frames later (less, and smaller, for a short move or hold;
 * none under SETTLE.min frames), with no
 * step in speed or acceleration at either end, and never past the take's end frame. abend never goes past
 * straight; a skill's own stop has none; clear(a, b) false leaves a bump over frames a..b out (an arm going onto its IK). null when there is none.
 */
export function settleBump(ch, pts, y, scale, end, clear = () => true) {
	if (!SETTLES.test(ch) || !(scale > 0)) return null;
	const bumps = [], x = pts.map(p => p.f);
	for (let i = 1; i < x.length; i++) {
		const d = y[i] - y[i - 1], next = x[i + 1];
		if (Math.abs(d) < 1 || ownTiming(pts[i]) || ownTiming(pts[i - 1]) || (next !== undefined && y[i + 1] !== y[i])) continue;
		const S = Math.min(SETTLE.frames, 0.5 * (x[i] - x[i - 1]), next === undefined ? Infinity : 0.5 * (next - x[i]));
		// a shorter settle is a smaller one: its acceleration goes as A / S^2
		let A = Math.sign(d) * Math.min(SETTLE.max * (S / SETTLE.frames) ** 2, SETTLE.frac * Math.abs(d)) * Math.min(1, scale);
		if (/^abend/.test(ch) && y[i] + A < 0) A = Math.min(0, -y[i]);
		// the take ends on its last value: a bump that would run past the end is left out
		if (S >= SETTLE.min && Math.abs(A) > 1e-3 && x[i] + 0.75 * S <= end && clear(x[i] - S / 4, x[i] + 0.75 * S)) bumps.push([x[i] - S / 4, S, A]);
	}
	if (!bumps.length) return null;
	return t => { let v = 0; for (const [a, S, A] of bumps) v += A * hump((t - a) / S); return v; };
}

/** Per frame, how many frames away the nearest frame is on which any of these IK weights is on (Infinity: none). */
export function ikGap(weights, frameCount) {
	const gap = new Array(frameCount).fill(Infinity);
	for (let f = 0, last = -Infinity; f < frameCount; f++) { if (weights.some(w => w[f] > 1e-3)) last = f; gap[f] = f - last; }
	for (let f = frameCount - 1, next = Infinity; f >= 0; f--) { if (weights.some(w => w[f] > 1e-3)) next = f; gap[f] = Math.min(gap[f], next - f); }
	return gap;
}

/**
 * Per side, the frames its hand works on something (a carry from its grab to its release, a near, above or still goal
 * that names a hand over its frames), from the spec; channels.js adds the frames an anchor or fit weight of that hand is on. { l, r }: [[a, b]].
 */
export function handBusy(spec) {
	const out = { l: [], r: [] }, end = Math.round(spec?.frames ?? 0);
	for (const o of Object.values(spec?.objects ?? {})) {
		const k = spec.props?.[o?.prop]?.hand;
		if (Number.isFinite(o?.grab) && out[k]) out[k].push([o.grab, Number.isFinite(o.release) ? o.release : end]);
	}
	for (const g of spec?.goals ?? []) {
		const at = Array.isArray(g?.at) ? g.at : null;
		// a goal that puts a hand somewhere (near, above, still), not one that only measures it (speed, moved)
		if (at?.length && ["near", "above", "still"].some(k => g[k] !== undefined) && /hand/i.test(JSON.stringify(g))) for (const k of ["l", "r"]) out[k].push([at[0], at[at.length - 1]]);
	}
	return out;
}

/** Per frame, how far a hand is from its contacts (handBusy spans and its own anchor weights), less margin (CONTACT): under 2 holds the keyed time. */
export function contactGap(spans, weights, frameCount, margin = CONTACT) {
	const busy = new Uint8Array(frameCount);
	for (const [a, b] of spans) for (let f = Math.max(0, Math.floor(a)); f <= Math.min(frameCount - 1, Math.ceil(b)); f++) busy[f] = 1;
	for (const w of weights) for (let f = 0; f < frameCount; f++) if (w[f] > 1e-3) busy[f] = 1;
	return ikGap([busy], frameCount).map(g => Math.max(0, g - margin));
}
