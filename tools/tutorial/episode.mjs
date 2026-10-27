// Episode schema, step timing and the srt writer for the tutorial recorder.
// Pure functions, so test/verify-tutorial-recorder.mjs checks them without a
// browser.
//
// An episode is a flat array of steps, or { title, subtitle?, chapters: [{ id, title?, steps }] }.
// A step is { id, narration?: { ko, en }, <one action>, until? }:
//   click: "<css>" or ["<css>", ...]    eased cursor move, then a real click on each
//   type:  "text" | { into: "<css>", text }  typed into the focused element, or
//                                        into `into` after clicking it and selecting its value
//   key:   "Mod+B" | "Space" | ...       one chord; Mod is Cmd on macOS, Ctrl elsewhere
//   drag:  { from, to }                  from: "<css>" or { js: "<expression giving { x, y }>" };
//                                        to: "<css>" or { dx, dy } from the start
//   wait:  "<css>" | ms                  until the element shows, or a pause
//   hold:  ms                            keep the frame still (alone), or how long a
//                                        spotlight, card or terminal stays (beside it)
//   eval:  "<js>"                        run in the page and awaited (setup the viewer does not see)
//   spotlight: "<css>" | null, label: { ko, en }, note?: { ko, en }
//                                        dim the page around the element, name it in a callout; null clears
//   menu:  { open: "<css>", then: "<css>" }  click open, then click then (File > Export)
//   card:  "opening" | "closing" | { title: { ko, en }, subtitle?: { ko, en } }
//   terminal: { typed: "npx cozyclay", lines: [...] }  the install scene
//   studio: true                         open the Studio at its startup chooser
// `until` is a selector the step waits for after its action. A step without
// narration joins the cue of the narrated step before it. `speech: { ko?, en? }`
// replaces what the voice reads (tools/tutorial/voice.mjs), not the caption.

const ACTIONS = ["click", "type", "key", "drag", "wait", "eval", "spotlight", "menu", "card", "terminal", "studio"];
const HELD = ["spotlight", "card", "terminal"];
const LANGUAGES = ["ko", "en"];
const isText = (value) => typeof value === "string" && value.trim().length > 0;
const isMs = (value) => Number.isFinite(value) && value >= 0;
const isPair = (value) => LANGUAGES.every((language) => isText(value?.[language]));

function actionError(name, value, step) {
	if (name === "click") return (isText(value) || (Array.isArray(value) && value.length > 0 && value.every(isText))) ? null : "click needs a selector or a non-empty selector list";
	if (name === "type") return isText(value) || (isText(value?.into) && isText(value?.text)) ? null : "type needs text, or { into, text }";
	if (name === "key") return isText(value) ? null : "key needs a chord such as Mod+B";
	if (name === "drag") return (isText(value?.from) || isText(value?.from?.js)) && (isText(value?.to) || (Number.isFinite(value?.to?.dx) && Number.isFinite(value?.to?.dy))) ? null : "drag needs from (selector or { js }) and to (selector or { dx, dy })";
	if (name === "eval") return isText(value) ? null : "eval needs a page expression";
	if (name === "wait") return isText(value) || isMs(value) ? null : "wait needs a selector or milliseconds";
	if (name === "spotlight") return value === null || (isText(value) && isPair(step.label) && (step.note === undefined || isPair(step.note))) ? null : "spotlight needs a selector and label { ko, en } (note optional), or null";
	if (name === "menu") return isText(value?.open) && isText(value?.then) ? null : "menu needs { open, then } selectors";
	if (name === "card") return value === "opening" || value === "closing" || (isPair(value?.title) && (value.subtitle === undefined || isPair(value.subtitle))) ? null : "card needs \"opening\", \"closing\" or { title: { ko, en }, subtitle? }";
	if (name === "terminal") return isText(value?.typed) && Array.isArray(value?.lines) && value.lines.every((line) => typeof line === "string") ? null : "terminal needs { typed, lines: [] }";
	if (name === "studio") return value === true ? null : "studio must be true";
	return isMs(value) ? null : "hold needs milliseconds";
}

/** The action a step performs; `hold` only when nothing else is there. */
export const actionOf = (step) => ACTIONS.find((name) => Object.hasOwn(step, name)) ?? (Object.hasOwn(step, "hold") ? "hold" : undefined);

/** { title, subtitle, chaptered, chapters: [{ id, title, steps }] } from either episode shape. */
export function normalizeEpisode(episode) {
	if (Array.isArray(episode)) return { title: null, subtitle: null, chaptered: false, chapters: [{ id: "main", title: null, steps: episode }] };
	return { title: episode?.title ?? null, subtitle: episode?.subtitle ?? null, chaptered: true, chapters: episode?.chapters ?? [] };
}

function stepErrors(step, label) {
	const errors = [];
	if (step && Object.hasOwn(step, "narration") && !isPair(step.narration)) errors.push(`${label}: narration needs ko and en`);
	const actions = ACTIONS.filter((name) => Object.hasOwn(step ?? {}, name));
	const action = actionOf(step ?? {});
	if (actions.length > 1 || !action) errors.push(`${label}: needs exactly one action of ${[...ACTIONS, "hold"].join(", ")} (found ${actions.length})`);
	else {
		const problem = actionError(action, step[action], step);
		if (problem) errors.push(`${label}: ${problem}`);
		if (action !== "hold" && Object.hasOwn(step, "hold") && !(HELD.includes(action) && isMs(step.hold))) errors.push(`${label}: hold only times a spotlight, card or terminal`);
	}
	if (step && Object.hasOwn(step, "until") && !isText(step.until)) errors.push(`${label}: until must be a selector`);
	if (step && Object.hasOwn(step, "speech")) {
		if (!step.narration) errors.push(`${label}: speech needs narration`);
		for (const [language, text] of Object.entries(step.speech ?? {})) if (!LANGUAGES.includes(language) || !isText(text)) errors.push(`${label}: speech.${language} must be ko or en text`);
	}
	const allowed = ["id", "narration", "speech", "until", "hold", "label", "note", ...ACTIONS];
	const unknown = Object.keys(step ?? {}).filter((key) => !allowed.includes(key) || ((key === "label" || key === "note") && action !== "spotlight"));
	if (unknown.length) errors.push(`${label}: unknown field ${unknown.join(", ")}`);
	return errors;
}

/** Every problem in an episode, as "<where>: <problem>" lines; empty when valid. */
export function validateEpisode(episode) {
	const { title, chaptered, chapters } = normalizeEpisode(episode);
	if (chaptered && (!Array.isArray(chapters) || chapters.length === 0)) return ["an episode object needs a non-empty chapters array"];
	const errors = [];
	const seen = new Set();
	const chapterIds = new Set();
	for (const chapter of chapters) {
		if (chaptered && !/^[a-z0-9-]+$/.test(chapter?.id ?? "")) errors.push(`chapter ${chapter?.id}: id must be lowercase letters, digits and dashes`);
		else if (chapterIds.has(chapter.id)) errors.push(`chapter ${chapter.id}: duplicate id`);
		chapterIds.add(chapter?.id);
		if (chapter?.title !== undefined && chapter?.title !== null && !isPair(chapter.title)) errors.push(`chapter ${chapter.id}: title needs ko and en`);
		if (!Array.isArray(chapter?.steps) || chapter.steps.length === 0) {
			errors.push(chaptered ? `chapter ${chapter?.id}: needs steps` : "an episode is a non-empty array of steps");
			continue;
		}
		chapter.steps.forEach((step, index) => {
			const label = `step ${step?.id ?? `#${index + 1}`}`;
			if (!isText(step?.id)) errors.push(`${label}: id must be a non-empty string`);
			else if (seen.has(step.id)) errors.push(`${label}: duplicate id`);
			seen.add(step?.id);
			errors.push(...stepErrors(step, label));
			if (step?.card === "opening" && !isPair(title)) errors.push(`${label}: an opening card needs the episode title { ko, en }`);
		});
	}
	return errors;
}

/** Reading speed with no voice: Korean `say` measures 1.7-1.9 words/s, so 1.6 leaves room. */
export const DEFAULT_WPS = { ko: 1.6, en: 2.5 };

/**
 * 1.2 s to take in the new screen, then the words at that language's speed:
 * the video's own language, or the slower of the two when none is given.
 */
export function readingMs(text, wps, language = null) {
	const words = (value) => value.trim().split(/\s+/).filter(Boolean).length;
	return 1200 + Math.max(...(language ? [language] : LANGUAGES).map((name) => words(text[name]) / wps[name])) * 1000;
}

/** The ko/en texts joined, for reading time of a callout or card. */
export const joinTexts = (...pairs) => Object.fromEntries(LANGUAGES.map((language) => [language, pairs.filter(Boolean).map((pair) => pair[language]).join(" ")]));

/**
 * How long a cue stays on screen: its clip plus a 0.4 s breath when there is
 * voice, the reading estimate otherwise, and never less than its actions.
 * The epsilon keeps float noise (4.66 * 1000 = 4660.000000000001) from adding a millisecond.
 */
export const stepHoldMs = (actionMs, narration, wps, audioS = null, language = null) => Math.max(actionMs, audioS === null ? readingMs(narration, wps, language) : Math.ceil(audioS * 1000 - 1e-6) + 400);

/** dist/tutorial/<episode>/<nn>-<id>.<locale>.mp4 for chapter `index` (0-based). */
export const chapterFileName = (index, id, locale) => `${String(index + 1).padStart(2, "0")}-${id}.${locale}.mp4`;

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
