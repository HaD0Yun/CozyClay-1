import { sampleAt } from "../sample-at.js";

export function usePlaybackSubjectPosition({ motion, subjectCarry, scene, frame }) {
	if (!motion && !subjectCarry) return null;
	const subject = sampleAt(scene, null, frame).subject;
	return subjectCarry ? subjectCarry(subject, frame) : subject;
}
