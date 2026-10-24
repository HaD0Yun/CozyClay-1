import { rangePinTracks } from "../../motion/range-pin.js";
import { ko } from "../../locale.js";

export function ensureRangePinState(state) {
	if (!state) return state;
	if (!(state.pins instanceof Map)) state.pins = new Map();
	if (!(state.pinResiduals instanceof Map)) state.pinResiduals = new Map();
	return state;
}
export function rangePinConflictFrames(draft, state) {
	if (!Number.isInteger(draft?.startFrame) || !Number.isInteger(draft?.endFrame) || draft.endFrame < draft.startFrame) return [];
	const tracks = rangePinTracks(draft), conflicts = [];
	for (let frame = draft.startFrame; frame <= draft.endFrame; frame += 1) {
		if (tracks.some((track) => { const key = state.keys.get(frame)?.get(track); return key && key.pin !== draft.id; })) conflicts.push(frame);
	}
	return conflicts;
}
export function overlappingRangePin(draft, state) {
	return [...ensureRangePinState(state).pins.values()].find((pin) => pin.id !== draft.id && rangePinTracks(pin).some((track) => rangePinTracks(draft).includes(track)) && Math.max(pin.startFrame, draft.startFrame) <= Math.min(pin.endFrame, draft.endFrame));
}
export function rangePinOverlapMessage(pin) {
	return pin ? ko(`A required body or limb track already has an overlapping pin (${pin.startFrame}–${pin.endFrame}).`, `필요한 몸통 또는 팔다리 파츠에 겹치는 고정이 있어요 (${pin.startFrame}–${pin.endFrame}).`, `所需的身体或肢体轨道上已有重叠的固定（${pin.startFrame}–${pin.endFrame}）。`) : "";
}
