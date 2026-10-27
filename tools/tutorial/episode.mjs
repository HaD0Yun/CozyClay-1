// Episode schema, step timing and the srt writer for the tutorial recorder.
// Pure functions, so test/verify-tutorial-recorder.mjs checks them without a
// browser.
//
// A step is { id, narration?: { ko, en }, <one action>, until? }:
//   click: "<css>" or ["<css>", ...]    eased cursor move, then a real click on each
//   type:  "text" | { into: "<css>", text }  typed into the focused element, or
//                                        into `into` after clicking it and selecting its value
//   key:   "Mod+B" | "Space" | ...       one chord; Mod is Cmd on macOS, Ctrl elsewhere
//   drag:  { from, to }                  from: "<css>" or { js: "<expression giving { x, y }>" };
//                                        to: "<css>" or { dx, dy } from the start
//   wait:  "<css>" | ms                  until the element shows, or a pause
//   hold:  ms                            keep the frame still
//   eval:  "<js>"                        run in the page and awaited (setup the viewer does not see)
// `until` is a selector the step waits for after its action. A step without
// narration joins the cue of the narrated step before it. `speech: { ko?, en? }`
// replaces what the voice reads (tools/tutorial/voice.mjs), not the caption.

const ACTIONS = ["click", "type", "key", "drag", "wait", "hold", "eval"];
const LANGUAGES = ["ko", "en"];
const isText = (value) => typeof value === "string" && value.trim().length > 0;
const isMs = (value) => Number.isFinite(value) && value >= 0;

function actionError(name, value) {
	if (name === "click") return (isText(value) || (Array.isArray(value) && value.length > 0 && value.every(isText))) ? null : "click needs a selector or a non-empty selector list";
	if (name === "type") return isText(value) || (isText(value?.into) && isText(value?.text)) ? null : "type needs text, or { into, text }";
	if (name === "key") return isText(value) ? null : "key needs a chord such as Mod+B";
	if (name === "drag") return (isText(value?.from) || isText(value?.from?.js)) && (isText(value?.to) || (Number.isFinite(value?.to?.dx) && Number.isFinite(value?.to?.dy))) ? null : "drag needs from (selector or { js }) and to (selector or { dx, dy })";
	if (name === "eval") return isText(value) ? null : "eval needs a page expression";
	if (name === "wait") return isText(value) || isMs(value) ? null : "wait needs a selector or milliseconds";
	return isMs(value) ? null : "hold needs milliseconds";
}

/** Every problem in an episode, as "step <id>: <problem>" lines; empty when valid. */
export function validateEpisode(steps) {
	if (!Array.isArray(steps) || steps.length === 0) return ["an episode is a non-empty array of steps"];
	const errors = steps[0]?.narration ? [] : ["the first step needs narration"];
	const seen = new Set();
	steps.forEach((step, index) => {
		const label = `step ${step?.id ?? `#${index + 1}`}`;
		if (!isText(step?.id)) errors.push(`${label}: id must be a non-empty string`);
		else if (seen.has(step.id)) errors.push(`${label}: duplicate id`);
		seen.add(step?.id);
		if (step && Object.hasOwn(step, "narration")) for (const language of LANGUAGES) if (!isText(step.narration?.[language])) errors.push(`${label}: narration.${language} is missing`);
		const actions = ACTIONS.filter((name) => Object.hasOwn(step ?? {}, name));
		if (actions.length !== 1) errors.push(`${label}: needs exactly one action of ${ACTIONS.join(", ")} (found ${actions.length})`);
		else {
			const problem = actionError(actions[0], step[actions[0]]);
			if (problem) errors.push(`${label}: ${problem}`);
		}
		if (step && Object.hasOwn(step, "until") && !isText(step.until)) errors.push(`${label}: until must be a selector`);
		if (step && Object.hasOwn(step, "speech")) {
			if (!step.narration) errors.push(`${label}: speech needs narration`);
			for (const [language, text] of Object.entries(step.speech ?? {})) if (!LANGUAGES.includes(language) || !isText(text)) errors.push(`${label}: speech.${language} must be ko or en text`);
		}
		const unknown = Object.keys(step ?? {}).filter((key) => !["id", "narration", "speech", "until", ...ACTIONS].includes(key));
		if (unknown.length) errors.push(`${label}: unknown field ${unknown.join(", ")}`);
	});
	return errors;
}

export const actionOf = (step) => ACTIONS.find((name) => Object.hasOwn(step, name));

/** Words per second when a cue has no voice clip; Korean `say` measures 1.7-1.9, so 1.6 leaves room. */
export const DEFAULT_WPS = { ko: 1.6, en: 2.2 };

/** One second to take in the new screen, then the slower language at its own words per second. */
export function narrationMs(narration, wps) {
	const words = (text) => text.trim().split(/\s+/).filter(Boolean).length;
	return 1000 + Math.max(...LANGUAGES.map((language) => words(narration[language]) / wps[language])) * 1000;
}

/**
 * How long a cue stays on screen: its clip plus a 0.4 s breath when there is
 * voice, the narration estimate otherwise, and never less than its actions.
 * The epsilon keeps float noise (4.66 * 1000 = 4660.000000000001) from adding a millisecond.
 */
export const stepHoldMs = (actionMs, narration, wps, audioS = null) => Math.max(actionMs, audioS === null ? narrationMs(narration, wps) : Math.ceil(audioS * 1000 - 1e-6) + 400);

export function srtTime(ms) {
	const total = Math.max(0, Math.round(ms));
	const pad = (value, width = 2) => String(value).padStart(width, "0");
	const hours = Math.floor(total / 3600000);
	const minutes = Math.floor(total / 60000) % 60;
	const seconds = Math.floor(total / 1000) % 60;
	return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(total % 1000, 3)}`;
}

/** One srt track from [{ startMs, endMs, narration }] in the given language. */
export function toSrt(cues, language) {
	return cues.map((cue, index) => `${index + 1}\n${srtTime(cue.startMs)} --> ${srtTime(cue.endMs)}\n${cue.narration[language]}\n`).join("\n");
}
