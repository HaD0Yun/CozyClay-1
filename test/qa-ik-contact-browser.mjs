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
		THREE, caps,
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

// 5. one fast pointer event (30 cm) across the other character's forearm: the
// endpoint is clear of the body, the way there is not. The hand moves in the
// drag plane (camera-facing, through the hand at the press), so the other
// character is placed for one of its forearms to cross that plane within the
// arm's reach; the crossing is then picked from the live capsules.
await backToStart("fast");
await evaluate(`(async () => {
	const { solveDragTarget } = await import("/src/motion/ik-drag.js");
	const { applyPose } = await import("/src/poses.js");
	const { THREE, caps } = window.__qaContact, at = (b) => b.getWorldPosition(new THREE.Vector3());
	const chain = window.__cozyclay.ikChains.get("rightHand"), hand = new THREE.Vector3(...window.__qaContact.hand()), shoulder = at(chain.bones[0]);
	const reach = shoulder.distanceTo(at(chain.bones[1])) + at(chain.bones[1]).distanceTo(at(chain.bones[2]));
	// the drag plane's normal: the null direction of __ikProject's Jacobian at the hand
	const p = (w) => window.__ikProject(w), h = 0.01, base = p(hand);
	const col = (x, y, z) => { const q = p(hand.clone().add(new THREE.Vector3(x, y, z).multiplyScalar(h))); return [(q.x - base.x) / h, (q.y - base.y) / h]; };
	const [jx, jy, jz] = [col(1, 0, 0), col(0, 1, 0), col(0, 0, 1)];
	const n = new THREE.Vector3(jx[0], jy[0], jz[0]).cross(new THREE.Vector3(jx[1], jy[1], jz[1])).normalize();
	const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, hand);
	const e1 = new THREE.Vector3().crossVectors(n, new THREE.Vector3(0, 1, 0)).normalize(), e2 = new THREE.Vector3().crossVectors(n, e1);
	const inReach = (point) => point.distanceTo(shoulder) < 0.85 * reach;
	const rigB = () => window.__cozyclay.rigs[${JSON.stringify(OTHER)}];
	window.__qaCross = {
		// the other character with its arms held straight out (rest = T-pose), so a
		// forearm is a thin blocker away from its torso
		armsOut() { applyPose(rigB(), { lArm: [0, 0, 0], rArm: [0, 0, 0], lForeArm: [0, 0, 0], rForeArm: [0, 0, 0] }); rigB().updateMatrixWorld(true); return true; },
		armsAreOut: () => caps(rigB()).filter((c) => /ForeArm$/.test(c.def.id)).every((c) => Math.abs(c.a.y - c.b.y) < 0.03),
		// the middle of forearm \`id\` as the other character stands now
		armPoint: (id) => { const arm = caps(rigB()).find((c) => c.def.id === id); return arm.a.clone().lerp(arm.b, 0.5).toArray(); },
		// where a forearm at height \`y\` should cross: in the drag plane, 0.2 m out to the arm's side of the shoulder
		spotAt(y) {
			const spot = new THREE.Vector3(shoulder.x, y, shoulder.z).addScaledVector(e1, e1.x < 0 ? 0.2 : -0.2);
			const across = new THREE.Vector3(n.x, 0, n.z).normalize();
			return spot.addScaledVector(across, -plane.distanceToPoint(spot) / n.dot(across)).toArray();
		},
		// the best 30 cm in-plane crossing of forearm \`id\`: scored by the hand's
		// clearance at both ends and along the approach (larger is better)
		search(id) {
			const arm = caps(window.__cozyclay.rigs[${JSON.stringify(OTHER)}]).find((c) => c.def.id === id);
			// how clear the whole right arm is with the handle at \`point\`: the drag's own solve
			// from the press pose, the same capsules depth() reads, then the pose put back
			const pose = chain.bones.map((b) => b.quaternion.clone());
			const clearance = (point) => {
				solveDragTarget("chain", chain, point);
				const { worst } = window.__qaContact.depth();
				chain.bones.forEach((b, i) => b.quaternion.copy(pose[i]));
				chain.bones[0].updateMatrixWorld(true);
				return -worst;
			};
			let best = null;
			for (let t = 0.1; t <= 0.91; t += 0.1) {
				const axis = arm.a.clone().lerp(arm.b, t), x = plane.projectPoint(axis, new THREE.Vector3());
				if (axis.distanceTo(x) > 0.02 || !inReach(x)) continue;
				for (let k = 0; k < 16; k++) {
					const u = e1.clone().multiplyScalar(Math.cos((k * Math.PI) / 8)).addScaledVector(e2, Math.sin((k * Math.PI) / 8));
					const near = x.clone().addScaledVector(u, -0.12), far = x.clone().addScaledVector(u, 0.18);
					if (!inReach(near) || !inReach(far)) continue;
					let score = Math.min(clearance(near), clearance(far));
					for (let i = 0; i < 10; i++) score = Math.min(score, clearance(hand.clone().lerp(near, i / 10)));
					if (!best || score > best.score) best = { id, t, score, x: x.toArray(), u: u.toArray(), near: near.toArray(), far: far.toArray(), nearXY: p(near), farXY: p(far) };
				}
			}
			return best;
		},
	};
	return true;
})()`);
const moveOther = async (x, z, rot) => {
	await evaluate(`window.__cozyclay.runStudioAction("character.move", { characterId: ${JSON.stringify(OTHER)}, x: ${x}, z: ${z}, rot: ${rot} })`);
	await waitFor(`(() => { const c = window.__qaContact.chest(); return Math.hypot(c.x - ${x}, c.z - ${z}) < 0.08; })()`, 3000);
	await sleep(150);
	await evaluate("window.__qaCross.armsOut()");
};
// every yaw (30 degree steps) x both forearms; the best-scored placement wins
let cross = null;
const PARK = { x: -1.5, z: 0 };
for (let rot = 0; rot < 360; rot += 30) {
	for (const id of ["rightForeArm", "leftForeArm"]) {
		await moveOther(PARK.x, PARK.z, rot);
		const arm = await evaluate(`window.__qaCross.armPoint(${JSON.stringify(id)})`), spot = await evaluate(`window.__qaCross.spotAt(${arm[1]})`);
		const x = PARK.x + spot[0] - arm[0], z = PARK.z + spot[2] - arm[2];
		await moveOther(x, z, rot);
		const found = await evaluate(`window.__qaCross.search(${JSON.stringify(id)})`);
		if (found && (!cross || found.score > cross.score)) cross = { ...found, placement: { x, z, rot } };
	}
}
if (cross) {
	await moveOther(cross.placement.x, cross.placement.z, cross.placement.rot);
	cross.handXY = await evaluate("window.__ikControlScreenPositions().rightHand");
	await sleep(300);
	expect("the other character holds its arms out", await evaluate("window.__qaCross.armsAreOut()"));
}
console.log("fast crossing", JSON.stringify(cross));
expect("a 30 cm crossing of the other's forearm is found within reach (hand clear by >= 1.5 cm along the way)", !!cross && cross.score >= 0.015, JSON.stringify(cross));
expect("the hand still starts clear of the placed character", (await evaluate("window.__qaContact.depth()")).worst < 0, JSON.stringify(await evaluate("window.__qaContact.depth()")));
if (cross && cross.score >= 0.015) {
	/** press on the handle, walk to the near side, then ONE pointer event to the far side */
	const fastDrag = async (modifiers = 0) => {
		await mouse("mousePressed", cross.handXY.x, cross.handXY.y, modifiers);
		for (let i = 1; i <= STEPS; i++) {
			await mouse("mouseMoved", cross.handXY.x + ((cross.nearXY.x - cross.handXY.x) * i) / STEPS, cross.handXY.y + ((cross.nearXY.y - cross.handXY.y) * i) / STEPS, modifiers);
			await sleep(16);
		}
		await sleep(100);
		const read = async () => {
			const hand = await evaluate("window.__qaContact.hand()");
			return { hand, side: cross.u.reduce((s, ui, i) => s + ui * (hand[i] - cross.x[i]), 0), depth: await evaluate("window.__qaContact.depth()") };
		};
		const before = await read();
		await mouse("mouseMoved", cross.farXY.x, cross.farXY.y, modifiers);
		await sleep(16);
		await mouse("mouseReleased", cross.farXY.x, cross.farXY.y, modifiers);
		await sleep(200);
		return { before, ...(await read()) };
	};
	const fast = await fastDrag();
	console.log("fast drag", JSON.stringify(fast));
	expect("before the fast event the arm is clear, on the near side", fast.before.depth.worst < -0.01 && fast.before.side < -0.1, JSON.stringify(fast.before));
	expect("the fast event moves the hand on toward the forearm", fast.side - fast.before.side > 0.02, JSON.stringify(fast));
	expect("and stops on the near side of it", fast.side < 0, JSON.stringify(fast));
	expect("touching the forearm (or its hand), not some other part", /x (left|right)(ForeArm|Hand)$/.test(fast.depth.pair) && fast.depth.worst > -0.02, JSON.stringify(fast.depth));
	expect("with the arm not inside the other body (overlap <= 5 mm)", fast.depth.worst <= 0.005, JSON.stringify(fast.depth));
	await undo();
	await sleep(300);
	const through = await fastDrag(ALT);
	console.log("fast Alt drag", JSON.stringify(through));
	expect("control: the same pointer path with Alt ends past the forearm", through.side > 0.05, JSON.stringify(through));
	expect("control: and there the arm is clear (only the way crosses the body)", through.depth.worst < 0, JSON.stringify(through.depth));

	// the crossing event's cost: a full sweep from the near side every time
	const sweep = await evaluate(`(async () => {
		const { clampDragTarget } = await import("/src/motion/ik-drag.js");
		const THREE = window.__qaContact.THREE, chains = window.__cozyclay.ikChains;
		const open = () => ({ rigs: window.__cozyclay.rigs, activeId: ${JSON.stringify(ACTIVE)}, cast: window.__cozyclay.characters });
		const near = new THREE.Vector3(...${JSON.stringify(cross.near)}), far = new THREE.Vector3(...${JSON.stringify(cross.far)});
		const record = {}; clampDragTarget({ kind: "chain", trackId: "rightHand", targetWorld: near, bodyContact: true, chains, record, open });
		const n = 200, t0 = performance.now();
		for (let i = 0; i < n; i++) {
			record.contact.lastGood = near.clone();
			clampDragTarget({ kind: "chain", trackId: "rightHand", targetWorld: far, bodyContact: true, chains, record, open });
		}
		return (performance.now() - t0) / n;
	})()`);
	console.log(`crossing event cost (30 cm sweep + passes): ${sweep.toFixed(3)} ms`);
	expect("the crossing event stays within the 2 ms budget", sweep < 2, String(sweep));
}

expect("browser run has no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
ws.close();
if (failures) process.exit(1);
console.log("all IK contact browser checks PASS");
