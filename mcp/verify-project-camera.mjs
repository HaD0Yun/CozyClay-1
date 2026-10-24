#!/usr/bin/env node
/**
 * verify-project-camera.mjs — the memory-only camera survives save -> open (#861).
 *
 * No editor is connected: the camera authored with set_camera must come back
 * from open_project both in the same process (over a later camera) and in a
 * fresh process (over the default camera). The fresh process is this file run
 * again with `--reopen <root>`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createToolHandlers, setLiveHub } from "./tool-handlers.mjs";

const SAVED = { x: 7, y: 2, z: 9, focalMm: 50 };
const FILE = "camera.cclayproject";

function handlersAt(root) {
	setLiveHub(null);
	// The handlers confine project paths to the cwd root, as server.mjs arranges.
	const projectRootPromise = realpath(root).then((resolved) => {
		process.chdir(resolved);
		return resolved;
	});
	const tools = createToolHandlers({ projectRootPromise });
	return async (name, args = {}) => {
		const result = await tools.find((tool) => tool.name === name).handler(args);
		assert.equal(result.isError, undefined, result.content[0].text);
		return result.content[0].text;
	};
}

const cameraOf = (body) => {
	const position = body.match(/position {3}x (\S+) {2}y (\S+) {2}z (\S+)/);
	const lens = body.match(/lens {7}(\S+)mm/);
	assert.ok(position && lens, body);
	return { x: Number(position[1]), y: Number(position[2]), z: Number(position[3]), focalMm: Number(lens[1]) };
};

async function reopenFresh(root) {
	const call = handlersAt(root);
	assert.match(await call("live_status"), /no live editor|not connected|memory-only/i);
	assert.match(await call("open_project", { path: FILE }), /^Opened/);
	const fresh = await call("describe_scene");
	assert.deepEqual(cameraOf(fresh), SAVED, "fresh-process open restores the saved camera");
	assert.ok(fresh.includes("Roundtrip character") && fresh.includes("Roundtrip cube"), fresh);
}

if (process.argv[2] === "--reopen") {
	await reopenFresh(process.argv[3]);
	process.exit(0);
}

// Inside the clone, like verify.mjs's outside directory, so realpath is stable.
const root = await mkdtemp(fileURLToPath(new URL("../.verify-project-camera-", import.meta.url)));
const origin = process.cwd();
try {
	const call = handlersAt(root);
	await call("place_character", { character: "A", subject: "Roundtrip character" });
	await call("place_object", { kind: "cube", name: "Roundtrip cube", x: 2, z: 1 });
	await call("set_camera", { x: 7, y: 2, z: 9, focal_mm: 50 });
	assert.deepEqual(cameraOf(await call("describe_scene")), SAVED);
	assert.match(await call("save_project", { path: FILE, name: "Roundtrip project" }), /^Saved/);
	await call("place_character", { character: "A", subject: "Changed character" });
	await call("set_camera", { x: -3, y: 4, z: 10, focal_mm: 24 });
	assert.match(await call("open_project", { path: FILE }), /^Opened/);
	const reopened = await call("describe_scene");
	assert.deepEqual(cameraOf(reopened), SAVED, "same-process open restores the saved camera");
	assert.ok(reopened.includes("Roundtrip character") && !reopened.includes("Changed character"), reopened);
	assert.ok(reopened.includes("Roundtrip cube"), reopened);

	execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--reopen", root], { stdio: "inherit" });
	console.log("verify-project-camera: memory-only camera survives same- and fresh-process open");
} finally {
	process.chdir(origin);
	await rm(root, { recursive: true, force: true });
}
