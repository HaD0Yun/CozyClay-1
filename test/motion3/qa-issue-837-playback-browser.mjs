#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { skeletonFor } from "../../src/motion3/rigs/index.js";

const port = Number(process.env.CDP_PORT || 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const pageTarget = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
assert.ok(pageTarget, "browser page unavailable");
const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	ws.onopen = resolve;
	ws.onerror = reject;
});
let nextId = 0;
const pending = new Map();
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (!message.id || !pending.has(message.id)) return;
	const request = pending.get(message.id);
	pending.delete(message.id);
	if (message.error) request.reject(new Error(JSON.stringify(message.error)));
	else request.resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = ++nextId;
	pending.set(id, { resolve, reject });
	ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
	return result.result?.value;
};
const waitFor = async (expression) => {
	for (let attempt = 0; attempt < 240; attempt += 1) {
		if (await evaluate(expression).catch(() => false)) return;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`timed out: ${expression}`);
};

await waitFor("Boolean(window.__cozyclay?.rigA && window.__cozyclay.runStudioAction)");
const first = await evaluate(`(async () => {
	let doc = await window.__cozyclayProject.export();
	while (typeof doc === "string") doc = JSON.parse(doc);
	const find = (node) => {
		if (!node || typeof node !== "object") return null;
		if (Array.isArray(node.characters) && node.characters[0]?.id) return node.characters[0];
		for (const value of Object.values(node)) { const hit = find(value); if (hit) return hit; }
		return null;
	};
	return find(doc);
})()`);
assert.ok(first, "scene character unavailable");
const skeleton = skeletonFor(first.model);
const hips = skeleton.index.Hips;
const ankle = skeleton.restWorldPos[skeleton.index.LeftFoot][1];
const spec = {
	schema: "cozyclay.motion-spec.v1",
	fps: 24,
	frames: 150,
	keys: [
		{ f: 0, set: { root: [0, skeleton.restWorldPos[hips][1] - 0.01, 0], yaw: 0, foot_l: [0.09, ankle, -0.03], foot_r: [-0.09, ankle, 0.03], fyaw_l: 0, fyaw_r: 0, armw_r: 0 } },
		{ f: 149, set: { root: [2, skeleton.restWorldPos[hips][1] - 0.01, 0], yaw: 0, foot_l: [0.09, ankle, -0.03], foot_r: [-0.09, ankle, 0.03], fyaw_l: 0, fyaw_r: 0, armw_r: 0 } },
	],
	generators: [{ type: "walk", f0: 6, steps: 5, heading: [0, 35] }],
};
const compile = await evaluate(`(async () => {
	const receipt = await window.__cozyclay.runStudioAction("motion.compile", { characterId: ${JSON.stringify(first.id)}, spec: ${JSON.stringify(spec)} });
	return receipt && { ok: receipt.ok, output: receipt.output ?? receipt.receipt?.output, error: receipt.error ?? null };
})()`);
assert.ok(compile?.ok || compile?.output?.installed, JSON.stringify(compile));
await waitFor("window.__cozyclay.motion?.schema === 'cozyclay.take.v3'");
await evaluate(`window.__cozyclay.runStudioAction("character.addWaypoint", { characterId: ${JSON.stringify(first.id)}, frame: 24, position: { x: 0.4, z: 0 } })`);
await evaluate(`window.__cozyclay.runStudioAction("character.addWaypoint", { characterId: ${JSON.stringify(first.id)}, frame: 120, position: { x: 2, z: 0 } })`);
const shotId = await evaluate(`(async () => {
	window.__cozyclay.runStudioAction("shot.create");
	let doc = await window.__cozyclayProject.export();
	while (typeof doc === "string") doc = JSON.parse(doc);
	const find = (node) => {
		if (!node || typeof node !== "object") return null;
		if (Array.isArray(node.shots) && node.shots[0]?.id) return node.shots[0].id;
		for (const value of Object.values(node)) { const hit = find(value); if (hit) return hit; }
		return null;
	};
	return find(doc);
})()`);
assert.ok(shotId, "shot unavailable");
await evaluate(`window.__cozyclay.runStudioAction("shot.setRange", { shotId: ${JSON.stringify(shotId)}, range: { startFrame: 0, endFrameExclusive: 150 } })`);
const mode = await evaluate(`(async () => {
	const receipt = await window.__cozyclay.runStudioAction("shot.setCameraMode", { shotId: ${JSON.stringify(shotId)}, mode: "follow" });
	return receipt && { ok: receipt.ok, output: receipt.output ?? receipt.receipt?.output, error: receipt.error ?? null };
})()`);
assert.ok(mode?.ok || mode?.output, JSON.stringify(mode));
await evaluate("window.__cozyclay.runStudioAction('timeline.play', { playing: false })");

const readFrame = async (frame) => {
	await evaluate(`window.__cozyclay.setFrame(${frame})`);
	await waitFor(`window.__cozyclay.tlFrame === ${frame}`);
	await evaluate("new Promise(requestAnimationFrame)");
	return evaluate(`(() => {
		const rig = window.__cozyclay.rigA;
		const camera = window.__cozyclay.shotCam;
		return {
			root: (() => {
				let hips = null;
				rig?.traverse(node => {
					if (!hips && node.isBone && node.name.replace(/^mixamorig:?/, "") === "Hips") hips = node;
				});
				return hips?.matrixWorld ? hips.matrixWorld.elements.slice(12, 15) : null;
			})(),
			camera: camera ? { position: camera.position.toArray(), quaternion: camera.quaternion.toArray() } : null,
		};
	})()`);
};
const samples = {};
for (const frame of [24, 72, 120]) samples[frame] = await readFrame(frame);
const before = await evaluate("window.__cozyclayRenders = 0; (window.__cozyclay.setPlaying ?? ((value) => window.__cozyclay.runStudioAction('timeline.play', { playing: value })))(true); window.__cozyclay.tlFrame");
await evaluate("new Promise(requestAnimationFrame)");
const screenshot = await send("Page.captureScreenshot", { format: "png" });
await mkdir(process.env.QA_OUT ?? "/tmp/issue837-playback", { recursive: true });
await writeFile(`${process.env.QA_OUT ?? "/tmp/issue837-playback"}/during-playback.png`, Buffer.from(screenshot.data, "base64"));
await new Promise((resolve) => setTimeout(resolve, 5000));
const renders = await evaluate("({ count: window.__cozyclayRenders, frame: window.__cozyclay.tlFrame })");
await evaluate("(window.__cozyclay.setPlaying ?? ((value) => window.__cozyclay.runStudioAction('timeline.play', { playing: value })))(false)");
console.log(`RESULT ${JSON.stringify({ before, samples, renders })}`);
console.log(`RATE ${renders.count}`);
assert.ok(samples[24].root && samples[120].root, "root samples unavailable");
assert.ok(renders.count <= 12, `App rendered too often: ${renders.count}`);
ws.close();
