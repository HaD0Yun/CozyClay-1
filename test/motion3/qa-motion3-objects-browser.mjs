#!/usr/bin/env node
// Browser QA for compiled object tracks: a hinged door keyed in a motion spec swings on the
// real scene object (and stays on its hinge).
//
// QA_URL=http://127.0.0.1:5190/app/ npm run qa:browser -- node test/motion3/qa-motion3-objects-browser.mjs
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { skeletonFor } from "../../src/motion3/rigs/index.js";

const port = Number(process.env.CDP_PORT || 9222);
const out = process.env.QA_OUT || "/tmp/cozyclay3-objects";
await mkdir(out, { recursive: true });
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === "page" && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map(), pageErrors = [];
ws.onmessage = event => {
	const m = JSON.parse(event.data);
	if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
	if (!m.id || !pending.has(m.id)) return;
	const item = pending.get(m.id); pending.delete(m.id);
	if (m.error) item.reject(new Error(JSON.stringify(m.error))); else item.resolve(m.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => {
	const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
	return r.result?.value;
};
const waitFor = async (expression, ms = 60_000) => {
	for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (await evaluate(expression).catch(() => false)) return true; await new Promise(r => setTimeout(r, 250)); }
	return false;
};
await send("Runtime.enable");

// A new project starts on an empty stage: cast the Y Bot these checks drive.
assert.ok(await waitFor("Boolean(window.__cozyclay?.runStudioAction)"), "Studio never exposed its actions");
await evaluate(`(async () => { if (!window.__cozyclay.characters?.length) await window.__cozyclay.runStudioAction("character.add", { character: { id: "char-a", model: "y-bot-tpose" } }); })()`);
assert.ok(await waitFor("Boolean(window.__cozyclay?.rigA && window.__cozyclay.runStudioAction)"), "Studio never exposed a rig");
const first = await evaluate(`(async () => {
	let doc = await window.__cozyclayProject.export();
	while (typeof doc === "string") doc = JSON.parse(doc);
	const find = node => { if (!node || typeof node !== "object") return null; if (Array.isArray(node.characters) && node.characters[0]?.model) return node.characters[0];
		for (const v of Object.values(node)) { const hit = find(v); if (hit) return hit; } return null; };
	const c = find(doc); return c && { id: c.id, model: c.model };
})()`);
const act = (id, args) => evaluate(`(async () => { const r = await window.__cozyclay.runStudioAction(${JSON.stringify(id)}, ${JSON.stringify(args)}); return r && { ok: r.ok, affectedIds: r.affectedIds, output: r.output ?? null }; })()`);
const added = await act("object.add", { kind: "cube", name: "Door", placement: { x: 1.5, z: 0 } });
assert.ok(added?.ok, "could not add the door");
const doorId = added.affectedIds[0];
assert.ok((await act("object.set", { id: doorId, set: { position: { x: 1.5, y: 0, z: 0 }, scale: { x: 0.05, y: 1.2, z: 0.9 } } }))?.ok, "could not size the door");
const sk = skeletonFor(first.model), I = sk.index, P = sk.restWorldPos, ank = P[I.LeftFoot][1];
const spec = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 60,
	keys: [{ f: 0, set: { root: [0, P[I.Hips][1] - 0.01, 0], yaw: 0, foot_l: [0.09, ank, -0.03], foot_r: [-0.09, ank, 0.03], door: 0 } }, { f: 48, set: { door: -70 } }],
	objects: { [doorId]: { pivot: [1.5, 0, 0.45], axis: [0, 1, 0], channel: "door" } } };
const compiled = await act("motion.compile", { characterId: first.id, spec });
console.log("compile", JSON.stringify(compiled?.output).slice(0, 300));
assert.ok(compiled?.ok, "motion.compile refused");
let worst = 0;
for (const f of [0, 24, 48, 59]) {
	await evaluate(`window.__cozyclay.setFrame(${f})`);
	await waitFor(`window.__cclayPropWorld?.[${JSON.stringify(doorId)}]?.frame === ${f}`, 5000);
	const w = await evaluate(`window.__cclayPropWorld[${JSON.stringify(doorId)}]`);
	const yaw = 2 * Math.atan2(w.quat.y, w.quat.w) * 180 / Math.PI;
	const want = f >= 48 ? -70 : null;
	// the door turns about its hinge edge, so its base pivot sweeps around (1.5, 0.45)
	const r = Math.hypot(w.x - 1.5, w.z - 0.45);
	console.log(`frame ${f}: door yaw ${yaw.toFixed(1)} deg, pivot (${w.x.toFixed(3)}, ${w.z.toFixed(3)}), radius ${r.toFixed(3)}`);
	worst = Math.max(worst, Math.abs(r - 0.45));
	if (want !== null) assert.ok(Math.abs(yaw - want) < 0.5, `door at frame ${f} is ${yaw} deg, compiled ${want}`);
	if (f === 0) assert.ok(Math.abs(yaw) < 0.5, "door should start closed");
	const shot = await send("Page.captureScreenshot", { format: "png" });
	await writeFile(`${out}/door-${String(f).padStart(3, "0")}.png`, Buffer.from(shot.data, "base64"));
}
assert.ok(worst < 0.005, `door left its hinge by ${worst} m`);
assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
console.log("PASS compiled door hinge plays on the scene object");
ws.close();
