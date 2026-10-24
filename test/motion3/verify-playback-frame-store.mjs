import assert from "node:assert/strict";
import {
	advancePlaybackFrame,
	commitPlaybackFrame,
	createPlaybackFrameSetter,
	playbackFrame,
	setPlaybackFrame,
} from "../../src/motion/playback-frame-store.js";
import { shotIndexAtFrame } from "../../src/cuts.js";

setPlaybackFrame(0);
let reactFrame = 0;
const setFrame = createPlaybackFrameSetter({
	getFrameCount: () => 20,
	setReactFrame: (frame) => { reactFrame = frame; },
});
setFrame(4);
assert.equal(playbackFrame(), 4);
assert.equal(reactFrame, 4);

advancePlaybackFrame(20, 3);
assert.equal(playbackFrame(), 7);
assert.equal(reactFrame, 4);
commitPlaybackFrame((frame) => { reactFrame = frame; });
assert.equal(reactFrame, 7);

const shots = [
	{ startFrame: 0, endFrame: 4 },
	{ startFrame: 5, endFrame: 9 },
];
assert.equal(shotIndexAtFrame(shots, 4), 0);
assert.equal(shotIndexAtFrame(shots, 5), 1);
console.log("playback frame store: pause sync and cut boundary checks passed");
