import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const playback = await readFile(new URL("../src/domains/playback.js", import.meta.url), "utf8");
const characters = await readFile(new URL("../src/stage-characters.jsx", import.meta.url), "utf8");
const rigs = await readFile(new URL("../src/stage-canvas-rigs.jsx", import.meta.url), "utf8");
const ghosts = await readFile(new URL("../src/view-ghosts.jsx", import.meta.url), "utf8");

assert.match(app, /<PlaybackCharacter/);
assert.match(app, /entry=\{view\.entry\}/);
assert.match(characters, /PlaybackCharacter/);
assert.doesNotMatch(app, /followTrack\?\.\[tlFrame\]/);
assert.match(playback, /shared\.propFrameRef\.current = frame/);
assert.match(characters, /usePlaybackSnapshot\(playbackFrame\)/);
assert.match(characters, /placementAt\(entry, frame/);
assert.match(rigs, /playbackProbe\(playbackProbeInput, frame/);
assert.match(rigs, /playbackProbeInput\.frameRef/);
assert.match(ghosts, /usePlaybackSnapshot\(playbackFrame\)/);

console.log("playback render isolation: App-level frame consumers stay out of playback ticks");
