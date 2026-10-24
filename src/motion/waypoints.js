import { ko } from "../locale.js";

// Root path pins: the limits keep an authored path a person could walk, and a
// capsule figure that rides the path moves at a believable pace.
const PATH_LIMITS = Object.freeze({
	speedMinMps: 0.5, // below this, "walking" cannot cycle a gait — feet slide
	speedMaxMps: 3.0, // above this is out of the locomotion band entirely
	holdEpsM: 0.05, // a displacement this small is a deliberate hold, any duration
	minPinGapFrames: 8, // authored pins closer than this over-rail the root
	speedRatioWarn: 2, // adjacent legs differing more than 2x force a gait change
	turnRateWarnDegPerS: 120, // sharper turns need wider arcs than the path gives
});

const NATURAL_WALK_MPS = 1.4;

/**
 * Judge the segment a candidate pin would create after `last`. Returns
 * { ok, error?, warnings: [] } — `error` blocks the placement and always
 * names the fix (a workable frame or distance), `warnings` accompany a
 * placement that is legal but will read oddly.
 * @param {{frame:number,x:number,z:number}} last      the previous pin (or the frame-0 start)
 * @param {{frame:number,x:number,z:number}} candidate the pin being authored
 * @param {number} fps
 * @param {{frame:number,x:number,z:number}|null} prev the pin before `last`, for ratio/turn warnings
 */
export function judgeNextWaypoint(last, candidate, fps, prev = null) {
	const gap = candidate.frame - last.frame;
	if (gap < PATH_LIMITS.minPinGapFrames) {
		return {
			ok: false,
			error: ko(`pins need at least ${PATH_LIMITS.minPinGapFrames} frames between them (${(PATH_LIMITS.minPinGapFrames / fps).toFixed(1)} s) — scrub past frame ${last.frame + PATH_LIMITS.minPinGapFrames}`, `핀 사이에는 최소 ${PATH_LIMITS.minPinGapFrames}프레임(${(PATH_LIMITS.minPinGapFrames / fps).toFixed(1)}초)이 필요해요 — ${last.frame + PATH_LIMITS.minPinGapFrames}프레임 이후로 이동해 주세요`, `路径点之间至少需要 ${PATH_LIMITS.minPinGapFrames} 帧（${(PATH_LIMITS.minPinGapFrames / fps).toFixed(1)} 秒）— 请移动到第 ${last.frame + PATH_LIMITS.minPinGapFrames} 帧之后`),
			warnings: [],
		};
	}
	const dist = Math.hypot(candidate.x - last.x, candidate.z - last.z);
	if (dist <= PATH_LIMITS.holdEpsM) return { ok: true, warnings: [] }; // a hold: legal at any length
	const dt = gap / fps;
	const speed = dist / dt;
	if (speed > PATH_LIMITS.speedMaxMps) {
		const neededFrames = Math.ceil((dist / PATH_LIMITS.speedMaxMps) * fps);
		return {
			ok: false,
			error: ko(`${speed.toFixed(1)} m/s is faster than anyone moves (max ${PATH_LIMITS.speedMaxMps}) — pin frame ${last.frame + neededFrames} or later, or click closer`, `${speed.toFixed(1)} m/s는 사람이 움직이기엔 너무 빨라요(최대 ${PATH_LIMITS.speedMaxMps}) — ${last.frame + neededFrames}프레임 이후에 핀을 찍거나 더 가까운 곳을 눌러 주세요`, `${speed.toFixed(1)} m/s 比人体移动速度快（上限 ${PATH_LIMITS.speedMaxMps}）— 请在第 ${last.frame + neededFrames} 帧或之后打点，或点击更近的位置`),
			warnings: [],
		};
	}
	if (speed < PATH_LIMITS.speedMinMps) {
		const walkFrame = last.frame + Math.max(PATH_LIMITS.minPinGapFrames, Math.round((dist / NATURAL_WALK_MPS) * fps));
		const neededDist = (PATH_LIMITS.speedMinMps * dt).toFixed(1);
		return {
			ok: false,
			error: ko(`${speed.toFixed(2)} m/s is below a sustainable walk (min ${PATH_LIMITS.speedMinMps}) — pin frame ~${walkFrame} instead, or click at least ${neededDist} m away`, `${speed.toFixed(2)} m/s는 자연스럽게 걷기엔 너무 느려요(최소 ${PATH_LIMITS.speedMinMps}) — 대신 약 ${walkFrame}프레임에 핀을 찍거나 최소 ${neededDist} m 이상 떨어진 곳을 눌러 주세요`, `${speed.toFixed(2)} m/s 低于可持续步行速度（下限 ${PATH_LIMITS.speedMinMps}）— 请改为在第 ${walkFrame} 帧附近打点，或点击至少 ${neededDist} m 外的位置`),
			warnings: [],
		};
	}
	const warnings = [];
	if (prev) {
		const prevDist = Math.hypot(last.x - prev.x, last.z - prev.z);
		if (prevDist > PATH_LIMITS.holdEpsM) {
			const prevSpeed = prevDist / ((last.frame - prev.frame) / fps);
			const ratio = Math.max(speed, prevSpeed) / Math.max(Math.min(speed, prevSpeed), 1e-6);
			if (ratio > PATH_LIMITS.speedRatioWarn) {
				warnings.push(ko(`${ratio.toFixed(1)}x speed change from the previous leg — expect a visible gait shift`, `이전 구간보다 속도가 ${ratio.toFixed(1)}배 달라요 — 걸음 변화가 눈에 보일 수 있어요`, `与前一段相比速度变化 ${ratio.toFixed(1)} 倍 — 步态变化可能很明显`));
			}
			const before = Math.atan2(last.x - prev.x, last.z - prev.z);
			const after = Math.atan2(candidate.x - last.x, candidate.z - last.z);
			let turn = Math.abs(after - before);
			if (turn > Math.PI) turn = 2 * Math.PI - turn;
			const turnRate = (turn * 180) / Math.PI / dt;
			if (turnRate > PATH_LIMITS.turnRateWarnDegPerS) {
				warnings.push(ko(`${Math.round((turn * 180) / Math.PI)}° turn in ${dt.toFixed(1)} s is sharper than a walking arc — give it more frames or distance`, `${dt.toFixed(1)}초 동안 ${Math.round((turn * 180) / Math.PI)}° 회전은 걷는 동선치고 너무 급해요 — 프레임이나 거리를 더 주세요`, `${dt.toFixed(1)} 秒内转向 ${Math.round((turn * 180) / Math.PI)}° 比步行弧线更急 — 请增加帧数或距离`));
			}
		}
	}
	return { ok: true, warnings };
}
