#!/usr/bin/env node
// Studio IK drag contact (src/motion/contact-project.js through clampDragTarget):
// with a second character standing beside the active one, a hand dragged with the
// real mouse into the other character's chest stops on its surface, the same drag
// twice lands on the same position, and an Alt drag passes through. Also measures
// what the projection costs per drag event in the page.
// Run: CDP_PORT=… QA_URL=… node tools/qa-browser.mjs -- node test/qa-ik-contact-browser.mjs

const port = Number(process.env.CDP_PORT || 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) throw new Error("no page target on the QA browser");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

let nextId = 1;
const pending = new Map(), pageErrors = [];
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (message.method === "Runtime.exceptionThrown") {
		pageErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
		return;
	}
	if (!message.id || !pending.has(message.id)) return;
	const { resolve, reject } = pending.get(message.id);
	pending.delete(message.id);
	if (message.error) reject(new Error(JSON.stringify(message.error)));
	else resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = nextId++;
	pending.set(id, { resolve, reject });
	ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (expression, timeoutMs = 10000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluate(expression)) return true;
		await sleep(50);
	}
	return false;
};
let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition || !detail ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

const ALT = 1, CTRL = 2;
const mouse = (type, x, y, modifiers = 0) => send("Input.dispatchMouseEvent", {
	type, x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, buttons: type === "mouseReleased" ? 0 : 1, modifiers,
});
const STEPS = 16;
/** The same pointer path every time: press, STEPS moves, release (Alt held throughout when asked). */
const drag = async (from, to, modifiers = 0) => {
	await mouse("mousePressed", from.x, from.y, modifiers);
	for (let i = 1; i <= STEPS; i++) {
		await mouse("mouseMoved", from.x + ((to.x - from.x) * i) / STEPS, from.y + ((to.y - from.y) * i) / STEPS, modifiers);
		await sleep(16);
	}
	await mouse("mouseReleased", to.x, to.y, modifiers);
	await sleep(200);
};
const key = async (code, keyName, vk, modifiers = 0) => {
	for (const type of ["rawKeyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: keyName, code, windowsVirtualKeyCode: vk, modifiers });
};
const undo = () => key("KeyZ", "z", 90, CTRL);

const ACTIVE = "char-a", OTHER = "qa-contact-b";
await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: process.env.QA_URL || "http://127.0.0.1:5180/app/" });
expect("app becomes ready", await waitFor("!!window.__cozyclay?.rigA && Array.isArray(window.__cozyclay?.characters)"));
const model = await evaluate(`window.__cozyclay.characters.find((c) => c.id === ${JSON.stringify(ACTIVE)})?.model`);
// The second body stands at the active character's right, turned toward it.
await evaluate(`window.__cozyclay.runStudioAction("character.add", { character: { id: ${JSON.stringify(OTHER)}, model: ${JSON.stringify(model)}, x: -0.55, z: 0, rot: 90, subject: "a person" } })`);
expect("second character mounts its rig (window.__cozyclay.rigs)", await waitFor(`!!window.__cozyclay.rigs?.[${JSON.stringify(OTHER)}]`, 20000));
expect("the active character stays the first one", await evaluate(`window.__cozyclay.rigA === window.__cozyclay.rigs[${JSON.stringify(ACTIVE)}]`));

// page helpers: the same capsules the projection reads (fix-collisions.js, measured radii)
await evaluate(`(async () => {
	const { buildCollisionCapsules } = await import("/src/motion/fix-collisions.js");
	const { closestPointsSegmentSegment } = await import("/src/motion/fix-collisions.js");
	const THREE = await import("/node_modules/.vite/deps/three.js");
	const caps = (rig) => [...buildCollisionCapsules(rig).values()].filter((c) => !c.def.handId && !c.def.optional);
	window.__qaContact = {
		THREE,
		// deepest overlap (m) of the active right arm into the other body; negative = clear by that much
		depth() {
			const mine = caps(window.__cozyclay.rigs[${JSON.stringify(ACTIVE)}]).filter((c) => c.def.movable?.chain === "rightHand");
			const theirs = caps(window.__cozyclay.rigs[${JSON.stringify(OTHER)}]);
			const a = new THREE.Vector3(), b = new THREE.Vector3();
			let worst = -Infinity, pair = null;
			for (const m of mine) for (const t of theirs) {
				const d = m.radius + t.radius - Math.sqrt(closestPointsSegmentSegment(m.a, m.b, t.a, t.b, a, b));
				if (d > worst) { worst = d; pair = m.def.id + " x " + t.def.id; }
			}
			return { worst, pair };
		},
		hand() { return window.__cozyclay.ikChains.get("rightHand").bones[2].getWorldPosition(new THREE.Vector3()).toArray(); },
		chest() {
			const rig = window.__cozyclay.rigs[${JSON.stringify(OTHER)}]; rig.updateMatrixWorld(true);
			const at = (name) => rig.getObjectByName(name).getWorldPosition(new THREE.Vector3());
			return at("mixamorigSpine1").add(at("mixamorigSpine2")).multiplyScalar(0.5);
		},
	};
	return true;
})()`);

await key("Digit2", "2", 50);
expect("Pose mode enters IK", await waitFor("window.__cozyclay?.ikMode === true && !!window.__cozyclay?.ikChains && !!window.__ikControlScreenPositions"));
await sleep(400);
const start = await evaluate("window.__qaContact.hand()");
const startDepth = await evaluate("window.__qaContact.depth()");
expect("the right arm starts clear of the other body", startDepth.worst < 0, JSON.stringify(startDepth));
const path = await evaluate(`(() => {
	const from = window.__ikControlScreenPositions().rightHand;
	const to = window.__ikProject(window.__qaContact.chest());
	return { from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } };
})()`);
console.log("drag path", JSON.stringify(path));
expect("the right hand handle is on screen", Number.isFinite(path.from.x) && Number.isFinite(path.to.x), JSON.stringify(path));

// every toast text shown from here on (a toast only stays up for a couple of seconds)
await evaluate(`(() => {
	window.__qaToasts = [];
	const seen = () => { for (const t of document.querySelectorAll(".toast")) if (!window.__qaToasts.includes(t.textContent)) window.__qaToasts.push(t.textContent); };
	new MutationObserver(seen).observe(document.body, { subtree: true, childList: true, characterData: true });
	return true;
})()`);
const dragOnce = async (modifiers = 0) => {
	await drag(path.from, path.to, modifiers);
	return { hand: await evaluate("window.__qaContact.hand()"), depth: await evaluate("window.__qaContact.depth()") };
};
const backToStart = async (label) => {
	await undo();
	const ok = await waitFor(`(() => { const h = window.__qaContact.hand(), s = ${JSON.stringify(start)}; return Math.hypot(h[0] - s[0], h[1] - s[1], h[2] - s[2]) < 1e-6; })()`, 4000);
	expect(`undo puts the hand back before the ${label} drag`, ok, JSON.stringify(await evaluate("window.__qaContact.hand()")));
};

// 1. stops at the surface
const first = await dragOnce();
const moved = Math.hypot(first.hand[0] - start[0], first.hand[1] - start[1], first.hand[2] - start[2]);
console.log("projected drag", JSON.stringify(first), "stored target", JSON.stringify(await evaluate("window.__cozyclay.ik.targets.get('rightHand')?.toArray()")));
expect("the drag moved the hand toward the other body", moved > 0.05, `moved ${moved.toFixed(4)} m`);
expect("the hand stops at the surface (overlap <= 5 mm)", first.depth.worst <= 0.005, JSON.stringify(first.depth));
expect("and touches it (within 2 cm of the surface)", first.depth.worst > -0.02, JSON.stringify(first.depth));
expect("a toast says how to pass through", await waitFor(`window.__qaToasts.some((text) => /Hold Alt|Alt를 누른 채/.test(text))`, 3000),
	JSON.stringify(await evaluate("window.__qaToasts")));

// 2. the same path twice gives the same position
await backToStart("repeat");
const second = await dragOnce();
const repeat = Math.hypot(second.hand[0] - first.hand[0], second.hand[1] - first.hand[1], second.hand[2] - first.hand[2]);
expect("the same drag path lands on the same position", repeat < 1e-6, `difference ${repeat} m: ${JSON.stringify({ first: first.hand, second: second.hand })}`);

// 3. Alt passes through
await backToStart("Alt");
const alt = await dragOnce(ALT);
console.log("Alt drag", JSON.stringify(alt));
expect("an Alt drag passes into the other body", alt.depth.worst > 0.05, JSON.stringify(alt.depth));
expect("the other character never moves", await evaluate(`(() => { const c = window.__qaContact.chest(); return Math.abs(c.x + 0.55) < 0.05 && Math.abs(c.z) < 0.05; })()`));

// 4. per-event cost: clampDragTarget (floor + projection, the probe IK solves included) on the live rigs
const cost = await evaluate(`(async () => {
	const { clampDragTarget } = await import("/src/motion/ik-drag.js");
	const THREE = window.__qaContact.THREE, chains = window.__cozyclay.ikChains;
	const open = () => ({ rigs: window.__cozyclay.rigs, activeId: ${JSON.stringify(ACTIVE)}, cast: window.__cozyclay.characters });
	const inside = window.__qaContact.chest();
	const args = (record) => ({ kind: "chain", trackId: "rightHand", targetWorld: inside, bodyContact: true, chains, record, open });
	const t0 = performance.now(); const record = {}; clampDragTarget(args(record)); const openMs = performance.now() - t0;
	const n = 200, t1 = performance.now();
	for (let i = 0; i < n; i++) clampDragTarget(args(record));
	const perEvent = (performance.now() - t1) / n;
	const t2 = performance.now();
	for (let i = 0; i < n; i++) clampDragTarget({ ...args({}), open: null });
	const floorOnly = (performance.now() - t2) / n;
	return { openMs, perEvent, floorOnly, blockers: record.contact?.projector ? "yes" : "no" };
})()`);
console.log(`projection cost per drag event: ${cost.perEvent.toFixed(3)} ms (floor clamp alone ${cost.floorOnly.toFixed(4)} ms; contact built once at drag open: ${cost.openMs.toFixed(2)} ms)`);
expect("per-event projection stays within the 2 ms budget", cost.perEvent < 2, JSON.stringify(cost));

expect("browser run has no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
ws.close();
if (failures) process.exit(1);
console.log("all IK contact browser checks PASS");
