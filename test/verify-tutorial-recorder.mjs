#!/usr/bin/env node
// Tutorial recorder without a browser: the episode schema, the step timing
// and the srt writer (tools/tutorial/episode.mjs), and the shipped episode.
import firstVideo from "../tools/tutorial/episodes/first-video.mjs";
import { narrationMs, srtTime, stepHoldMs, toSrt, validateEpisode } from "../tools/tutorial/episode.mjs";

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
const shippedMs = firstVideo.filter((item) => item.narration).reduce((total, item) => total + stepHoldMs(0, item.narration, 2.2), 0);
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

expect("narration time is one second plus the wordier language", narrationMs(narration, 2.5) === 3000, String(narrationMs(narration, 2.5)));
expect("a step holds for its narration when the action is quick", stepHoldMs(300, narration, 2.5) === 3000);
expect("a step holds for its action when the action is slow", stepHoldMs(4500, narration, 2.5) === 4500);
expect("words per second scales the hold", stepHoldMs(0, narration, 5) === 2000);

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
