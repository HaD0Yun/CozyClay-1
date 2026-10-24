// A held object brought to the face leans by default (lane arm). An aim key at the lips without lean or roll (a cup
// tipped to the mouth) is held as the aim asks only with the elbow out to the side and over the shoulder: the grip the
// reach took on the table turns the hand with the cup, and the wrist cannot take the rest (the agents' first compiles of
// bench S6 and S8: the upper arm past 110 deg from hanging on 31 of 56, the elbow over the head on 17). Leaning the aim
// toward the hand's side lets the elbow stay down (key-aim.js lean); the agent wrote lean on few of those keys and
// re-keyed the elbows after QA had passed. So such a key leans FACE_LEAN deg (the most lean takes) unless it gives lean
// or roll: its top (the rim) within FACE_NEAR m of the mouth at its frame, on the pose without the keys, on a body at
// most SIP m tall (a cup, a can, a bottle: a bat's knob at the shoulder in a batting stance is not a sip, and a group's
// height is unknown here); the rim stays where aim put it (leanPos). On the 84 first compiles of bench S6, S8 and S10 the agents wrote, the frames of BODY went
// from 7231 to 5526, of FACE from 1102 to 839 and of WRIST from 1212 to 1007, and the takes with an elbow over the
// shoulder (qa/arm-checks.js) from 39 to 31; the mouth goals missed on 694 frames instead of 623 (lean 35 within 0.2 m
// saved fewer BODY and FACE frames and lost 46 mouth frames).
import { add, scale, norm, dist } from "./compiler/math.js";

export const FACE_LEAN = 45;
const FACE_NEAR = 0.25, SIP = 0.3;
/**
 * Entry o of a body `top` m tall (0: a group) with FACE_LEAN on its aim keys (no lean, no roll) whose top (`top` m up
 * the aim from pos) is within FACE_NEAR of the mouth at their frame; mouthAt(f) the mouth on the pose without the
 * keys. o itself when none is, or the body is no sip (SIP).
 */
export function faceLeaned(o, top, mouthAt) {
	if (!(top > 0 && top <= SIP)) return o;
	let any = false;
	const keys = o.keys.map(k => {
		if (!k.aim || k.lean !== undefined || k.roll !== undefined || !(dist(add(k.pos, scale(norm(k.aim), top)), mouthAt(k.f)) < FACE_NEAR)) return k;
		any = true;
		return { ...k, lean: FACE_LEAN, leaned: true };
	});
	return any ? { ...o, keys } : o;
}
