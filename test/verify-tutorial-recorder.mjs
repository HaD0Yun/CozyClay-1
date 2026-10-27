#!/usr/bin/env node
// Tutorial recorder without a browser, `say` or ffmpeg: the episode schema,
// the hold rule and the srt writer (tools/tutorial/episode.mjs), the voice
// clip lookup (voice.mjs), the mux filter graph (mux.mjs), and the shipped episode.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import firstVideo from "../tools/tutorial/episodes/first-video.mjs";
import { DEFAULT_WPS, narrationMs, srtTime, stepHoldMs, toSrt, validateEpisode } from "../tools/tutorial/episode.mjs";
import { bandHeightFor, muxArgs } from "../tools/tutorial/mux.mjs";
import { speechText, userClip } from "../tools/tutorial/voice.mjs";

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};
const narration = { en: "one two three four five", ko: "하나 둘 셋" };
const step = (extra) => ({ id: "a", narration, ...extra });
const errorsFor = (extra) => validateEpisode([step(extra)]);

const FIXTURE = [
	{ id: "open", narration, wait: ".v2-start-screen" },
	{ id: "name", narration, type: { into: "[data-testid=start-project-name]", text: "my_first_video" } },
	{ id: "create", click: "[data-testid=start-create]", until: ".timeline" },
	{ id: "move", narration, drag: { from: { js: "window.__characterGizmoHandles()[0]" }, to: { dx: -120, dy: 45 } } },
	{ id: "setup", eval: "window.__cozyclay.runStudioAction('noop', {})" },
];
const fixtureErrors = validateEpisode(FIXTURE);
expect("an episode mixing narrated and silent steps is valid", fixtureErrors.length === 0, fixtureErrors.join("; "));
const shippedErrors = validateEpisode(firstVideo);
expect("the first-video episode is valid", shippedErrors.length === 0, shippedErrors.join("; "));
const shippedMs = firstVideo.filter((item) => item.narration).reduce((total, item) => total + stepHoldMs(0, item.narration, DEFAULT_WPS), 0);
expect("the first-video narration runs 60 to 120 seconds", shippedMs >= 60000 && shippedMs <= 120000, `${shippedMs}ms`);

for (const [label, extra] of [["click", { click: "#go" }], ["click list", { click: ["#a", "#b"] }], ["type", { type: "hello" }], ["key", { key: "Mod+B" }], ["drag to selector", { drag: { from: "#a", to: "#b" } }], ["drag by offset", { drag: { from: "#a", to: { dx: 10, dy: -5 } } }], ["wait selector", { wait: ".ready" }], ["wait ms", { wait: 500 }], ["hold", { hold: 800 }], ["until", { click: "#go", until: ".done" }], ["type into", { type: { into: "#name", text: "x" } }], ["drag from js", { drag: { from: { js: "({ x: 1, y: 2 })" }, to: { dx: 1, dy: 1 } } }], ["eval", { eval: "1 + 1" }]]) {
	const errors = errorsFor(extra);
	expect(`a ${label} step is valid`, errors.length === 0, errors.join("; "));
}
expect("an empty episode is rejected", validateEpisode([]).length === 1);
expect("a step without an action is rejected", /exactly one action/.test(errorsFor({}).join()));
expect("a step with two actions is rejected", /found 2/.test(errorsFor({ click: "#a", hold: 100 }).join()));
expect("the first step must be narrated", /first step needs narration/.test(validateEpisode([{ id: "a", hold: 1 }]).join()));
expect("a silent step after a narrated one is valid", validateEpisode([step({ hold: 1 }), { id: "b", hold: 1 }]).length === 0);
expect("a type into without text is rejected", /type needs/.test(errorsFor({ type: { into: "#name" } }).join()));
expect("an empty eval is rejected", /eval needs/.test(errorsFor({ eval: " " }).join()));
expect("a step missing Korean narration is rejected", /narration\.ko/.test(validateEpisode([{ id: "a", narration: { en: "hi" }, hold: 1 }]).join()));
expect("duplicate ids are rejected", /duplicate id/.test(validateEpisode([step({ hold: 1 }), step({ hold: 1 })]).join()));
expect("an unknown field is rejected", /unknown field speed/.test(errorsFor({ hold: 1, speed: 2 }).join()));
expect("a drag without a target is rejected", /drag needs/.test(errorsFor({ drag: { from: "#a" } }).join()));
expect("a negative hold is rejected", /hold needs/.test(errorsFor({ hold: -1 }).join()));
expect("an empty click list is rejected", /click needs/.test(errorsFor({ click: [] }).join()));

const even = { ko: 2.5, en: 2.5 };
expect("narration time is one second plus the slower language", narrationMs(narration, even) === 3000, String(narrationMs(narration, even)));
expect("each language reads at its own rate", narrationMs(narration, { ko: 1, en: 2.5 }) === 4000, String(narrationMs(narration, { ko: 1, en: 2.5 })));
expect("Korean defaults to 1.6 words per second", DEFAULT_WPS.ko === 1.6 && DEFAULT_WPS.en === 2.2);
expect("without a clip a step holds for its narration when the action is quick", stepHoldMs(300, narration, even) === 3000);
expect("a step holds for its action when the action is slow", stepHoldMs(4500, narration, even) === 4500 && stepHoldMs(4500, narration, even, 2) === 4500);
expect("with a clip the hold is the clip plus 0.4 s, rounded up", stepHoldMs(300, narration, even, 4.66) === 5060 && stepHoldMs(0, narration, even, 1.0001) === 1401);
expect("a clip overrides the words-per-second estimate", stepHoldMs(0, narration, { ko: 0.1, en: 0.1 }, 2) === 2400);
expect("speech overrides what the voice reads, not the caption", speechText({ narration, speech: { ko: "말" } }, "ko") === "말" && speechText({ narration, speech: { ko: "말" } }, "en") === narration.en);
expect("speech must be ko or en text", /speech\.fr/.test(errorsFor({ hold: 1, speech: { fr: "x" } }).join()) && errorsFor({ hold: 1, speech: { ko: "말" } }).length === 0);

// Voice lookup: the author's clip wins in wav, m4a, mp3, aiff order; nothing else is a clip.
const voiceDir = mkdtempSync(join(tmpdir(), "tutorial-voice-test-"));
mkdirSync(voiceDir, { recursive: true });
for (const name of ["create.ko.mp3", "create.ko.m4a", "create.en.aiff", "play.ko.txt"]) writeFileSync(join(voiceDir, name), "");
expect("a user clip is found by id and language", userClip(voiceDir, "create", "en") === join(voiceDir, "create.en.aiff"));
expect("m4a wins over mp3", userClip(voiceDir, "create", "ko") === join(voiceDir, "create.ko.m4a"));
expect("other extensions and missing steps have no clip", userClip(voiceDir, "play", "ko") === null && userClip(voiceDir, "export", "ko") === null);
rmSync(voiceDir, { recursive: true, force: true });

// Mux graph: three cues, the middle one silent.
const muxCues = [{ id: "a", startMs: 500, endMs: 3000 }, { id: "b", startMs: 3000, endMs: 5000 }, { id: "c", startMs: 5000, endMs: 9000 }];
const muxClips = new Map([["a", { path: "a.wav", audioS: 2 }], ["c", { path: "c.wav", audioS: 3.5 }]]);
const args = muxArgs({ base: "cap.mp4", output: "out.mp4", cues: muxCues, clips: muxClips, captions: ["0.png", "1.png", "2.png"], endMs: 9800, bandHeight: 130 });
const graph = args[args.indexOf("-filter_complex") + 1];
expect("inputs are the capture, a clip or silence per cue, then the captions", JSON.stringify(args.slice(4, 18)) === JSON.stringify(["-i", "cap.mp4", "-i", "a.wav", "-f", "lavfi", "-t", "2.000", "-i", "anullsrc=r=48000:cl=mono", "-i", "c.wav", "-i", "0.png"]), JSON.stringify(args.slice(4, 18)));
expect("the first clip waits for its cue and fills to the next cue", graph.includes("[1:a]aresample=48000,aformat=channel_layouts=mono,adelay=delays=500:all=1,apad=whole_dur=3.000,atrim=end=3.000[a0]"), graph);
expect("the last clip fills to the end of the video", graph.includes("apad=whole_dur=4.800,atrim=end=4.800[a2]") && graph.includes("[a0][a1][a2]concat=n=3:v=0:a=1[aout]"), graph);
expect("a caption band is added under the frame", graph.includes("[0:v]pad=iw:ih+130:0:0:color=0x111111[v]"), graph);
expect("each caption shows for its cue window", graph.includes("[v][4:v]overlay=0:H-h:enable='between(t,0.500,3.000)'[v0]") && graph.includes("[v1][6:v]overlay=0:H-h:enable='between(t,5.000,9.000)'[v2]"), graph);
expect("the output is h264 + aac, faststart, cut at the end", args.includes("[aout]") && args.includes("aac") && args.includes("libx264") && args.at(-4) === "9.800" && args.includes("+faststart"));
const silent = muxArgs({ base: "cap.mp4", output: "out.mp4", cues: muxCues, clips: new Map(), captions: ["0.png", "1.png", "2.png"], endMs: 9800, bandHeight: 130 });
expect("without clips the video has captions and no audio", !silent.includes("aac") && silent[silent.indexOf("-filter_complex") + 1].includes("[v][1:v]overlay"));
let tooLong = "";
try { muxArgs({ base: "cap.mp4", output: "out.mp4", cues: muxCues, clips: new Map([["b", { path: "b.wav", audioS: 2.5 }]]), captions: [], endMs: 9800, bandHeight: 130 }); } catch (error) { tooLong = error.message; }
expect("a clip longer than its cue stops the mux", /clip for b runs 2\.50 s, longer than its 2\.000 s cue/.test(tooLong), tooLong);
expect("the caption band is about 13% of the frame and even", bandHeightFor(1000) === 130 && bandHeightFor(1080) === 140);

expect("srt time pads every field", srtTime(3723004) === "01:02:03,004", srtTime(3723004));
expect("srt time clamps negatives to zero", srtTime(-20) === "00:00:00,000");
const cues = [{ startMs: 500, endMs: 2500, narration }, { startMs: 2500, endMs: 61000.4, narration: { en: "next", ko: "다음" } }];
const expectedEn = "1\n00:00:00,500 --> 00:00:02,500\none two three four five\n\n2\n00:00:02,500 --> 00:01:01,000\nnext\n";
expect("the srt writer numbers cues and spans each hold", toSrt(cues, "en") === expectedEn, JSON.stringify(toSrt(cues, "en")));
expect("the Korean track carries the Korean narration", toSrt(cues, "ko").includes("\n하나 둘 셋\n") && toSrt(cues, "ko").endsWith("다음\n"));

if (failures > 0) {
	console.error(`\n${failures} tutorial recorder check(s) failed`);
	process.exit(1);
}
console.log("\nAll tutorial recorder checks passed");
