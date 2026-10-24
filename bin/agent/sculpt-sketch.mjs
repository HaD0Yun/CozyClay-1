// The live sketch: while the model is still writing a tool call that builds sculpts, the parts it has written so
// far go to the browser as `sculpt.sketch` frames, which the viewport draws as translucent ghost clay
// (src/sculpt-sketch.jsx). A `script` call is cut to its longest runnable prefix (sketch-code.mjs) and dry-run with
// stub tools in a throwaway sandbox (sketch-sandbox.mjs); a direct run_action object.sculpt call is read from pi-ai's
// partially parsed arguments. A model writing an 8 KB script spends minutes on it; without this the stage stays
// empty until it runs. Frames only: nothing here reaches the model or the scene, and a failed sketch is no sketch.
import { declaredNames, runnablePrefix, streamedCode } from "./sketch-code.mjs";
import { dryRunSketch, SKETCH_MAX_PARTS } from "./sketch-sandbox.mjs";

/** How often a streaming call is sketched again, at most. */
const SKETCH_MS = 600;
/** Dry runs in flight across the sidecar: a sketch never competes with the turn for the machine. */
const MAX_RUNNING = 2;
const MAX_FRAME_CHARS = 48 * 1024;
const MAX_GROUPS = 16;
const MAX_RAW_CHARS = 512 * 1024;
const COLOR = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

let running = 0;
let sculptShapes = null;
// Lazy, like every src/ import of the sidecar: the shapes are read only once a call is sketched.
const loadShapes = () => (sculptShapes ??= import("../../src/sculpt-shapes.js")
	.then((module) => ({ shapes: module.SCULPT_SHAPES, keys: module.SCULPT_SHAPE_KEYS }), () => null));

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const tidy = (value) => Math.round(value * 1e4) / 1e4;
const text = (value, max) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);

/** [x, y, z] from an array of three numbers or an { x, y, z } object (a missing axis is 0), else null. */
function vector(value) {
	if (Array.isArray(value)) return value.length === 3 && value.every(finite) ? value.map(tidy) : null;
	if (!value || typeof value !== "object") return null;
	const axes = [value.x, value.y, value.z];
	return axes.some(finite) && axes.every((axis) => axis === undefined || finite(axis)) ? axes.map((axis) => tidy(axis ?? 0)) : null;
}

/** A part id the recipe accepts ("wheelF" -> "wheel-f"), or "" when nothing is left of it. */
const sketchId = (value) => typeof value !== "string" ? "" : value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()
	.replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").slice(0, 40);

/** A shape field cut to what a ghost needs: numbers rounded, strings and arrays capped, four levels deep. */
function plain(value, depth = 0) {
	if (finite(value)) return tidy(value);
	if (typeof value === "string") return value.slice(0, 40);
	if (typeof value === "boolean") return value;
	if (depth > 3 || !value || typeof value !== "object") return undefined;
	if (Array.isArray(value)) return value.slice(0, 256).map((entry) => plain(entry, depth + 1) ?? null);
	return Object.fromEntries(Object.entries(value).slice(0, 16).map(([key, entry]) => [key, plain(entry, depth + 1)]).filter(([, entry]) => entry !== undefined));
}

/** One part as a ghost draws it: geometry, place and colour; looks (material, detail, gradient) stay out, cutters too. */
function sketchPart(raw, fallbackId, { shapes, keys }) {
	if (!raw || typeof raw !== "object" || !shapes.includes(raw.shape) || raw.op) return null;
	const size = vector(raw.size);
	if (!size) return null;
	const part = { id: sketchId(raw.id) || fallbackId, shape: raw.shape, size };
	const position = vector(raw.position), rotation = vector(raw.rotation), parent = sketchId(raw.parent);
	if (position) part.position = position;
	if (rotation) part.rotation = rotation;
	if (typeof raw.color === "string" && COLOR.test(raw.color.trim())) part.color = raw.color.trim();
	if (parent) part.parent = parent;
	if (raw.mirror === true) part.mirror = true;
	for (const key of keys) {
		const value = plain(raw[key]);
		if (value !== undefined) part[key] = value;
	}
	return part;
}

/**
 * sculptSketchGroups(value, env) -> [{ key, name?, target?, placement?, parts }]: the dry run's (or a direct call's)
 * groups, loosely normalized and capped at SKETCH_MAX_PARTS parts and MAX_FRAME_CHARS of JSON (the last parts go
 * first). `target` is the sculpt an object.sculpt { id } call rebuilds; `placement` keeps { x, y, z, rot } numbers.
 */
export function sculptSketchGroups(value, env) {
	const groups = [], keys = new Set();
	let count = 0;
	for (const raw of (Array.isArray(value?.groups) ? value.groups : []).slice(0, MAX_GROUPS)) {
		const parts = [], ids = new Set();
		for (const entry of Array.isArray(raw?.parts) ? raw.parts : []) {
			if (count >= SKETCH_MAX_PARTS) break;
			const part = sketchPart(entry, `part-${count}`, env);
			if (!part) continue;
			for (let n = 2; ids.has(part.id); n += 1) part.id = `${part.id.replace(/-\d+$/, "").slice(0, 36)}-${n}`;
			ids.add(part.id);
			parts.push(part);
			count += 1;
		}
		if (!parts.length) continue;
		let key = text(raw.key, 16) ?? `g${groups.length}`;
		while (keys.has(key)) key += "+";
		keys.add(key);
		const placement = Object.fromEntries(["x", "y", "z", "rot"].filter((axis) => finite(raw.placement?.[axis])).map((axis) => [axis, tidy(raw.placement[axis])]));
		const name = text(raw.name, 80), target = text(raw.id, 80);
		groups.push({ key, ...(name ? { name } : {}), ...(target ? { target } : {}), ...(Object.keys(placement).length ? { placement } : {}), parts });
	}
	while (groups.length && JSON.stringify(groups).length > MAX_FRAME_CHARS) {
		const last = groups.at(-1);
		last.parts.splice(Math.floor(last.parts.length * 0.8));
		if (!last.parts.length) groups.pop();
	}
	return groups;
}

/** The groups a script's code shows so far: its longest runnable cut, dry-run. Undefined when there is nothing new. */
async function scriptGroups(state, env) {
	const code = streamedCode(state.call, state.raw);
	// The code only grows while it streams; anything else starts the cut over.
	if (state.cut && !code.startsWith(state.cutText)) state.cut = null;
	const cut = runnablePrefix(code, { after: state.cut?.end ?? 0, whole: state.complete }) ?? state.cut;
	if (!cut || cut.source === state.ran) return undefined;
	Object.assign(state, { cut, cutText: code.slice(0, cut.end), ran: cut.source });
	const value = await dryRunSketch(cut.source, declaredNames(cut.source), env);
	return value ? sculptSketchGroups(value, env) : undefined;
}

/** The groups a direct run_action object.sculpt call shows so far; while it streams, its last part may be half written. */
function directGroups(state, env) {
	const args = state.call.arguments;
	if (args?.action !== "object.sculpt") return undefined;
	const inner = args.args ?? {}, parts = Array.isArray(inner.recipe?.parts) ? inner.recipe.parts : [];
	return sculptSketchGroups({ groups: [{ key: "d", name: inner.name, id: inner.id, placement: inner.placement, parts: state.complete ? parts : parts.slice(0, -1) }] }, env);
}

/**
 * createSculptSketch(push, clock) -> { onMessageEvent(event), settled() }. onMessageEvent takes pi's assistant
 * message events, like turn-frames.mjs; push gets { type: "sculpt.sketch", index, callId?, groups } whenever what a
 * `script` or run_action call has written so far changes, at most every SKETCH_MS while it streams and once more
 * when it is complete, and with empty groups when its message fails or ends without running its tools. The browser
 * drops a call's sketch when its tool.done arrives. settled() resolves once no sketch is running (tests).
 */
export function createSculptSketch(push, clock = () => Date.now()) {
	const calls = new Map();
	const send = (state, groups) => {
		const json = JSON.stringify(groups);
		if (state.closed || json === (state.sent ?? "[]")) return;
		state.sent = json;
		try { push({ type: "sculpt.sketch", index: state.index, ...(state.callId ? { callId: state.callId } : {}), groups }); } catch { /* advisory */ }
	};
	const clearAll = () => {
		for (const state of calls.values()) { send(state, []); state.closed = true; }
		calls.clear();
	};
	const schedule = (state) => {
		if (state.closed) return;
		if (state.running) { state.again ||= state.complete; return; }
		if (!state.complete && (clock() - state.at < SKETCH_MS || running >= MAX_RUNNING)) return;
		state.at = clock();
		running += 1;
		state.running = (async () => {
			const env = await loadShapes();
			if (!env || state.closed) return;
			const groups = state.kind === "script" ? await scriptGroups(state, env) : directGroups(state, env);
			if (groups) send(state, groups);
		})().catch(() => { /* a failed sketch is no sketch */ }).finally(() => {
			running -= 1;
			state.running = null;
			if (state.again) { state.again = false; schedule(state); }
		});
	};
	const onEvent = (event) => {
		const type = event?.type;
		if (type === "error" || (type === "done" && event.reason !== "toolUse")) { clearAll(); return; }
		if (type !== "toolcall_start" && type !== "toolcall_delta" && type !== "toolcall_end") return;
		const call = (type === "toolcall_end" && event.toolCall) || event.partial?.content?.[event.contentIndex];
		if (call?.type !== "toolCall" || (call.name !== "script" && call.name !== "run_action")) return;
		// contentIndex restarts with every assistant message, so a start begins a new call
		let state = type === "toolcall_start" ? null : calls.get(event.contentIndex);
		if (!state || state.kind !== call.name) {
			// The call this one replaces at its index is over: a sketch of it still running sends nothing.
			if (calls.has(event.contentIndex)) calls.get(event.contentIndex).closed = true;
			state = { index: event.contentIndex, kind: call.name, callId: typeof call.id === "string" && call.id ? call.id : null, raw: "", at: clock() };
			calls.set(event.contentIndex, state);
		}
		state.call = call;
		// A provider that names the call only at its end: later frames carry the id (the browser drops the index-keyed one).
		if (!state.callId && typeof call.id === "string" && call.id) state.callId = call.id;
		if (type === "toolcall_delta" && typeof call.arguments?.code !== "string" && state.raw.length < MAX_RAW_CHARS) state.raw += event.delta ?? "";
		if (type === "toolcall_end") state.complete = true;
		schedule(state);
	};
	return {
		onMessageEvent(event) {
			try { onEvent(event); } catch { /* a sketch never stops a turn */ }
		},
		async settled() {
			while ([...calls.values()].some((state) => state.running)) await Promise.all([...calls.values()].map((state) => state.running));
		},
	};
}
