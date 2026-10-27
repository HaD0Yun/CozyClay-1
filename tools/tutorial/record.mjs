#!/usr/bin/env node
// Records one tutorial episode from the real startup chooser: prepares the
// voice clips (tools/tutorial/voice.mjs), drives the Studio over CDP with each
// cue held for its clip, screencasts it, and writes <episode>.mp4 (burned-in
// captions, voice when there is any) plus a ko and an en srt under dist/tutorial/. Run it through tools/tutorial/launch.mjs
// (npm run tutorial:record -- <episode>) or inside tools/qa-browser.mjs with
// QA_URL pointing at a dev server. See tools/tutorial/README.md.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { encode, findFfmpeg } from "./assemble.mjs";
import { renderCaptions } from "./captions.mjs";
import { connectPage } from "./cdp.mjs";
import { createInput } from "./cursor.mjs";
import { DEFAULT_WPS, actionOf, stepHoldMs, toSrt, validateEpisode } from "./episode.mjs";
import { bandHeightFor, muxArgs } from "./mux.mjs";
import { prepareVoice } from "./voice.mjs";

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function parseArgs(argv) {
	const options = { episode: null, locale: "en", size: "1600x1000", "wps-ko": DEFAULT_WPS.ko, "wps-en": DEFAULT_WPS.en, voice: "on", fps: 30, out: "dist/tutorial" };
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (flag.startsWith("--")) options[flag.slice(2)] = argv[(index += 1)];
		else options.episode = flag;
	}
	const [width, height] = String(options.size).split("x").map(Number);
	if (!options.episode) throw new Error("usage: record.mjs <episode> [--locale en|ko] [--size 1600x1000|1920x1080] [--voice on|off] [--wps-ko 1.6] [--wps-en 2.2] [--fps 30] [--out dist/tutorial]");
	if (!["en", "ko"].includes(options.locale)) throw new Error(`--locale must be en or ko (got ${options.locale})`);
	if (!(width > 0 && height > 0)) throw new Error(`--size must look like 1600x1000 (got ${options.size})`);
	if (!["on", "off"].includes(options.voice)) throw new Error(`--voice must be on or off (got ${options.voice})`);
	return { ...options, width, height, wps: { ko: Number(options["wps-ko"]), en: Number(options["wps-en"]) }, fps: Number(options.fps) };
}

async function loadEpisode(name) {
	const base = existsSync(name) ? resolve(name) : resolve(import.meta.dirname, "episodes", name);
	const file = [base, `${base}.mjs`, `${base}.json`].find((candidate) => existsSync(candidate));
	if (!file) throw new Error(`no episode ${name} (looked in tools/tutorial/episodes/)`);
	const steps = file.endsWith(".json") ? JSON.parse(readFileSync(file, "utf8")) : (await import(pathToFileURL(file).href)).default;
	const errors = validateEpisode(steps);
	if (errors.length) throw new Error(`episode ${name} is invalid:\n  ${errors.join("\n  ")}`);
	return steps;
}

async function runAction(cdp, input, step) {
	const action = actionOf(step);
	const value = step[action];
	if (action === "click") for (const selector of [value].flat()) await input.click(selector);
	else if (action === "type") await input.type(value);
	else if (action === "key") await input.key(value);
	else if (action === "drag") await input.drag(value.from, value.to);
	else if (action === "hold") await sleep(value);
	else if (action === "eval") {
		const result = await cdp.evaluate(`(async () => (${value}))()`);
		if (result?.ok === false) throw new Error(`step ${step.id}: eval returned ${JSON.stringify(result)}`);
	}
	else if (typeof value === "number") await sleep(value);
	else if (!(await input.locate(value, 20000))) throw new Error(`step ${step.id}: ${value} never showed`);
	if (step.until && !(await cdp.waitFor(`document.querySelector(${JSON.stringify(step.until)})`, 20000))) {
		throw new Error(`step ${step.id}: ${step.until} never showed`);
	}
}

/** Empty origin storage (no project session, no saved projects), the chosen locale, then the Studio: the chooser a first-time author sees. */
async function openStudio(cdp, url, locale) {
	await cdp.send("Page.enable");
	const origin = new URL(url).origin;
	let loaded = cdp.once("Page.loadEventFired");
	await cdp.send("Page.navigate", { url: `${origin}/favicon.ico` });
	await loaded;
	await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
	await cdp.evaluate(`localStorage.setItem("cozyclay.locale", ${JSON.stringify(locale)})`);
	loaded = cdp.once("Page.loadEventFired");
	await cdp.send("Page.navigate", { url });
	await loaded;
}

const options = parseArgs(process.argv.slice(2));
const ffmpeg = findFfmpeg();
console.log(`ffmpeg: ${ffmpeg.path} (${ffmpeg.version})`);
const steps = await loadEpisode(options.episode);
const episodeName = options.episode.replace(/^.*\//, "").replace(/\.(mjs|json)$/, "");
const outputBase = join(options.out, options.locale === "en" ? episodeName : `${episodeName}-${options.locale}`);
const frameDir = mkdtempSync(join(tmpdir(), "cozyclay-tutorial-"));
// Voice first: each cue's hold comes from its clip, so the clips exist before the capture.
const clips = prepareVoice({ steps, language: options.locale, voiceDir: resolve(import.meta.dirname, "voice", episodeName), workDir: frameDir, ffprobe: ffmpeg.path.replace(/ffmpeg$/, "ffprobe"), useSay: options.voice === "on" });
const sources = [...clips.values()].map((clip) => clip.source);
console.log(clips.size ? `voice (${options.locale}): ${clips.size} clips (${sources.filter((source) => source === "user").length} user, ${sources.filter((source) => source === "say").length} say)` : `voice (${options.locale}): none, captions only`);
const cdp = await connectPage(Number(process.env.CDP_PORT || 9222));
try {
	// An export step's download lands in the scratch dir, never in the user's Downloads.
	await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: join(frameDir, "downloads") });
	await cdp.send("Emulation.setDeviceMetricsOverride", { width: options.width, height: options.height, deviceScaleFactor: 1, mobile: false });
	await openStudio(cdp, process.env.QA_URL || "http://127.0.0.1:5594/app/", options.locale);
	const input = createInput(cdp, { mac: (await cdp.evaluate("navigator.platform")).startsWith("Mac") });
	await input.install();

	const frames = [];
	let started = 0;
	cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
		void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
		const at = Date.now();
		if (!started) started = at;
		const file = `${String(frames.length).padStart(6, "0")}.jpg`;
		writeFileSync(join(frameDir, file), Buffer.from(data, "base64"));
		frames.push({ file, ms: at - started });
	});
	const firstFrame = cdp.once("Page.screencastFrame", 10000);
	await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: options.width, maxHeight: options.height, everyNthFrame: 1 });
	await firstFrame;
	const clock = () => Date.now() - started;
	await sleep(500);

	// A narrated step opens a cue; the silent steps after it run inside that cue,
	// and the cue closes once the narration has had its time.
	const cues = [];
	let open = null;
	const closeCue = async () => {
		await sleep(open.startMs + stepHoldMs(clock() - open.startMs, open.narration, options.wps, clips.get(open.id)?.audioS ?? null) - clock());
		cues.push({ ...open, endMs: clock() });
		console.log(`cue ${open.id}: ${((clock() - open.startMs) / 1000).toFixed(1)}s`);
	};
	for (const step of steps) {
		if (step.narration) {
			if (open) await closeCue();
			open = { id: step.id, startMs: clock(), narration: step.narration };
		}
		await runAction(cdp, input, step);
	}
	await closeCue();
	await sleep(800);
	const endMs = clock();
	await cdp.send("Page.stopScreencast");
	if (frames.length === 0) throw new Error("the screencast produced no frames");

	mkdirSync(options.out, { recursive: true });
	const base = join(frameDir, "capture.mp4");
	console.log(`ffmpeg command: ${await encode({ ffmpeg: ffmpeg.path, dir: frameDir, frames, endMs, fps: options.fps, output: base })}`);
	const bandHeight = bandHeightFor(options.height);
	const captions = await renderCaptions(cdp, { texts: cues.map((cue) => cue.narration[options.locale]), width: options.width, height: bandHeight, dir: frameDir, language: options.locale });
	const args = muxArgs({ base, output: `${outputBase}.mp4`, cues, clips, captions, endMs, bandHeight });
	const muxed = spawnSync(ffmpeg.path, args, { encoding: "utf8" });
	if (muxed.status !== 0) throw new Error(`ffmpeg mux failed (exit ${muxed.status}): ${muxed.stderr.trim()}`);
	console.log(`ffmpeg mux: ${clips.size ? "h264 + aac" : "h264, no audio"}, ${captions.length} captions, ${options.width}x${options.height + bandHeight}`);
	for (const language of ["ko", "en"]) writeFileSync(`${outputBase}.${language}.srt`, toSrt(cues, language));
	console.log(`wrote ${outputBase}.mp4 (${(endMs / 1000).toFixed(1)}s, ${frames.length} frames) and ${outputBase}.{ko,en}.srt`);
} finally {
	cdp.close();
	rmSync(frameDir, { recursive: true, force: true });
}
