import assert from "node:assert/strict";
import { buildShotPrompt, lensWordFromFocalMm, shotSizeFromFov } from "../src/shot-prompt.js";
import { SENSOR_FORMATS, focalMmToFov } from "../src/shot.js";

const CAMERA_SENTENCE = "follow the reference clip's framing and camera motion exactly";
const MOTION_SENTENCE = "motion and blocking come from the reference; keep timing";

const meta = {
	focalMm: 35,
	fovDeg: 55,
	aspect: "16:9",
	size: { width: 1280, height: 720 },
	cameraMove: { dolly: true, crane: false, rail: false },
	keyLight: { intensity: 0.9, azimuthDeg: 45, elevationDeg: 60 },
	cast: [{ name: "Momo", model: "clay-hero" }, { name: "Pixel", model: "clay-side" }],
	frameRange: { start: 0, end: 119 },
	fps: 24,
	shotTitle: "Rooftop chase",
	intent: "moody clay rooftop at dusk",
};

// Image target, default options: the reference owns the camera.
const imagePrompt = buildShotPrompt(meta, { target: "image" });
const imageLines = imagePrompt.split("\n");
assert.equal(imageLines[0], "SHOT: Rooftop chase, 5s, 16:9", "SHOT line carries title, duration and aspect");
assert.equal(imageLines[1], "LENS: 35mm, normal shot", "LENS line carries focal mm and the fov-derived shot size");
assert.equal(imageLines[2], `CAMERA: ${CAMERA_SENTENCE}`, "referenceOwned camera emits the exact follow sentence");
assert.ok(imageLines[3].startsWith("LIGHT: high front right key light, strong"), `LIGHT line reads ${imageLines[3]}`);
assert.equal(imageLines[4], "CAST: Momo, Pixel", "CAST line lists names");
assert.equal(imageLines[5], "LOOK: moody clay rooftop at dusk", "LOOK line is the user's intent verbatim");
assert.equal(imageLines.length, 6, "image prompts carry no MOTION line");
assert.equal(imagePrompt.split(CAMERA_SENTENCE).length - 1, 1, "the camera path appears only in the CAMERA line");
console.log("PASS image prompt: labelled lines, default camera ownership, no MOTION line");

// Video target adds the MOTION line and keeps the camera sentence single.
const videoPrompt = buildShotPrompt(meta, { target: "video" });
const videoLines = videoPrompt.split("\n");
assert.equal(videoLines[videoLines.length - 1], `MOTION: ${MOTION_SENTENCE}`, "video prompts end with the MOTION line");
assert.equal(videoLines.length, 7, "video prompt has one more line than image");
assert.equal(videoPrompt.split(CAMERA_SENTENCE).length - 1, 1, "the camera sentence is never repeated");
const videoLook = videoLines.find((line) => line.startsWith("LOOK:"));
assert.equal(videoLook, "LOOK: moody clay rooftop at dusk", "LOOK stays verbatim even in video prompts");
assert.ok(!/\bdolly\b|\bcrane\b|\brail\b/i.test(videoLook), "the LOOK line never repeats the camera path");
console.log("PASS video prompt adds MOTION and never repeats the camera path in LOOK");

// referenceOwnsCamera: false hands the camera description to the prompt.
const movedPrompt = buildShotPrompt(meta, { target: "video", referenceOwnsCamera: false });
const movedCamera = movedPrompt.split("\n").find((line) => line.startsWith("CAMERA:"));
assert.ok(!movedCamera.includes("follow the reference"), "the follow sentence disappears when the shot owns the camera");
assert.match(movedCamera, /dolly/i, "the dolly move is described in plain words");
assert.equal(movedPrompt.split("dolly").length - 1, 1, "the move description appears exactly once in the prompt");
assert.equal(movedPrompt.split("\n").find((line) => line.startsWith("LOOK:")), "LOOK: moody clay rooftop at dusk", "LOOK still never repeats the camera path");

const craneMeta = { ...meta, cameraMove: { dolly: false, crane: true, rail: true } };
const craneCamera = buildShotPrompt(craneMeta, { target: "image", referenceOwnsCamera: false }).split("\n").find((line) => line.startsWith("CAMERA:"));
assert.match(craneCamera, /crane/i, "crane is described in plain words");
assert.match(craneCamera, /rail/i, "rail is described in plain words");

const stillMeta = { ...meta, cameraMove: { dolly: false, crane: false, rail: false } };
const stillCamera = buildShotPrompt(stillMeta, { target: "image", referenceOwnsCamera: false }).split("\n").find((line) => line.startsWith("CAMERA:"));
assert.match(stillCamera, /locked-off/i, "no moves means a locked-off camera");
console.log("PASS referenceOwnsCamera:false swaps the CAMERA line for plain move words");

// #848: the lens word follows the editor's own focal <-> fov calibration
// (shot.js), not a second 35mm-film conversion. The issue's measured fovs are
// the editor's Super 35 16:9 gate (7 mm half-height): 24 mm -> 32.52 deg, etc.
const EXPECTED_WORDS = [[24, 32.52, "wide"], [28, 28.07, "wide"], [35, 22.62, "normal"], [50, 15.94, "normal"]];
const super35 = { sensorId: "super35", aspectRatio: 16 / 9 };
for (const [mm, issueFovDeg, word] of EXPECTED_WORDS) {
	const editorFovDeg = (focalMmToFov(mm, super35.sensorId, super35.aspectRatio) * 180) / Math.PI;
	assert.ok(Math.abs(editorFovDeg - issueFovDeg) < 0.01, `${mm}mm is ${editorFovDeg} deg in the editor`);
	assert.equal(lensWordFromFocalMm(mm), word, `${mm}mm reads ${word}`);
	assert.equal(shotSizeFromFov(editorFovDeg, super35), word, `${mm}mm's fov on Super 35 reads ${word}`);
	for (const sensorId of Object.keys(SENSOR_FORMATS)) {
		const fovDeg = (focalMmToFov(mm, sensorId, 16 / 9) * 180) / Math.PI;
		assert.equal(shotSizeFromFov(fovDeg, { sensorId, aspectRatio: 16 / 9 }), word, `${mm}mm on ${sensorId} reads ${word}`);
	}
	const lensLine = buildShotPrompt({ ...meta, focalMm: mm, fovDeg: issueFovDeg }, { target: "image" }).split("\n")[1];
	assert.equal(lensLine, `LENS: ${mm}mm, ${word} shot`, `the exported LENS line agrees with the editor at ${mm}mm`);
	const fovOnly = buildShotPrompt({ ...meta, focalMm: null, fovDeg: editorFovDeg, sensorId: "super35" }, { target: "image" }).split("\n")[1];
	assert.ok(fovOnly.endsWith(`, ${word} shot`), `a fov-only meta falls back through the editor filmback at ${mm}mm`);
}
assert.equal(lensWordFromFocalMm(85), "long", "85mm reads long");
assert.equal(shotSizeFromFov(0), "normal", "a degenerate fov falls back to normal");
console.log("PASS lens word follows the editor's focal <-> fov calibration (24/28/35/50mm)");

// Fallbacks: empty intent, no key light, empty cast, partial-second shots.
const bare = buildShotPrompt(
	{
		...meta,
		shotTitle: "",
		intent: "   ",
		keyLight: null,
		cast: [],
		frameRange: { start: 24, end: 83 },
	},
	{ target: "video" },
);
const bareLines = bare.split("\n");
assert.equal(bareLines[0], "SHOT: untitled shot, 2.5s, 16:9", "untitled shots get a placeholder and durations keep fractions");
assert.equal(bareLines[3], "LIGHT: no key light, ambient fill", "a missing key light is stated, not dropped");
assert.equal(bareLines[4], "CAST: none", "an empty cast reads as none");
assert.equal(bareLines[5], "LOOK: clay previs, neutral look", "a whitespace-only intent falls back to the neutral look");

const padded = buildShotPrompt({ ...meta, intent: "  rain-slick alley, warm sodium glow  " }, { target: "image" });
assert.equal(padded.split("\n").find((line) => line.startsWith("LOOK:")), "LOOK: rain-slick alley, warm sodium glow", "a padded intent still reads as the user's words");
console.log("PASS fallbacks: empty intent, no key light, empty cast, fractional durations");
