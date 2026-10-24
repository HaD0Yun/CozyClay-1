// C21. Corrections: slips in a sent spec that have one reading, fixed before the spec is stored, each named
// in output.adjusted ("corrected: ...") so the compile goes on instead of being refused. A name is corrected
// only when exactly one known name matches it once case, "_", "-" and spaces are ignored (spinePitch ->
// spine_pitch, walk_to -> walkTo), when it is a plural or a singular of one (goal -> goals), or by the short
// alias lists below (arm_swing_l -> aswing_l, pos -> p on a world anchor), and the right name is not there
// already. Anything with two readings stays for the validator to refuse with every problem listed.
//   spec fields, use[i] skill names and fields, use[i].args names (an arg of the skill written beside args
//   moves into it, args.f0 moves out), key channels and finger presets, object key and fall fields, goal,
//   fit and check entry fields, anchor fields
//   generators[i] with to, arrive, a single heading or type "walkTo" -> a walkTo use entry (the walk that
//   heads for a point), placed in f0 order among the use entries
//   objects.<id> written as { free: {...} } (or carry, hinge, follow) -> the record itself
//   fitWalks: a walkTo with to and steps gets the stride, or the step count and cadence, that ends the steps at
//   to in a natural gait (skills/basic.js fitTo), stored with the spec; one it cannot fit is refused with what the
//   walk would do and needs
import { SPEC_FIELDS, USE_FIELDS, OBJECT_KEY_FIELDS, FALL_FIELDS, GOAL_FIELDS, FIT_FIELDS, ANCHOR_FIELDS, CHECK_ENTRY_FIELDS, OBJECT_FIELDS } from "./schema/fields.js";
import { VEC_CHANNELS, NUM_CHANNELS, MAP_CHANNELS, FINGER_PRESETS } from "./compiler/vocab.js";
import { SKILL_INFO } from "./skills/info.js";
import { SKILL_NAMES, expandUse } from "./skills/index.js";
import { customChannels } from "./compiler/validate.js";

const plain = v => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const squash = s => String(s).toLowerCase().replace(/[\s_-]/g, "");
/** Sided names: left / right / L / R at the end read as _l / _r. */
const sided = s => String(s).replace(/[_-]?(left|Left|LEFT)$/, "_l").replace(/[_-]?(right|Right|RIGHT)$/, "_r").replace(/[_-]?L$/, "_l").replace(/[_-]?R$/, "_r");
const CHANNEL_ALIASES = { arm_swing: "aswing", armswing: "aswing", elbow_bend: "abend", arm_bend: "abend", wrist_twist: "wtwist", wrist_flex: "wflex",
	foot_yaw: "fyaw", foot_pitch: "fpitch", arm_weight: "armw", ik_weight: "armw", hips: "root", pelvis: "root", finger: "fingers", hand_pole: "elbow", knee_pole: "knee" };
const FIELD_ALIASES = {
	objectKey: { position: "pos", rotation: "rot", quat: "rot", quaternion: "rot", frame: "f" },
	anchor: { pos: "p", position: "p", point: "p", id: "object", joint: "bone" },
	use: { frame: "f0", f: "f0" },
};

/** The one name of `names` that `name` stands for, or null: alias, case and separators, plural or singular. */
function nameFor(name, names, aliases = {}) {
	if (names.includes(name)) return name;
	const alias = aliases[name] ?? aliases[squash(name)];
	if (alias && names.includes(alias)) return alias;
	const hits = new Set(names.filter(n => squash(n) === squash(name) || n === `${name}s` || `${n}s` === name));
	return hits.size === 1 ? [...hits][0] : null;
}

/** obj with each unknown field that stands for exactly one free known field renamed; one note per rename. */
function renameFields(obj, fields, at, notes, aliases) {
	if (!plain(obj)) return obj;
	let out = obj;
	for (const f of Object.keys(obj)) {
		const to = fields.includes(f) ? null : nameFor(f, fields, aliases);
		if (!to || to in out) continue;
		out = Object.fromEntries(Object.entries(out).map(([k, v]) => (k === f ? [to, v] : [k, v])));
		notes.push(`corrected: ${at}.${f} -> ${at}.${to}`);
	}
	return out;
}

const mapList = (list, fn) => (Array.isArray(list) ? list.map(fn) : list);

/** A generator that is a walkTo: it heads for a point, plans to arrive, turns to one heading, or says so. */
const isWalkTo = g => plain(g) && (g.to !== undefined || g.arrive !== undefined || typeof g.heading === "number" || nameFor(String(g.type), ["walkTo"]) === "walkTo");

function moveGenerators(spec, notes) {
	if (!Array.isArray(spec.generators) || !spec.generators.some(isWalkTo)) return spec;
	const use = Array.isArray(spec.use) ? [...spec.use] : [], kept = [];
	spec.generators.forEach((g, i) => {
		if (!isWalkTo(g)) return kept.push(g);
		const { type, f0, ...args } = g, at = use.findIndex(u => plain(u) && Number.isFinite(u.f0) && u.f0 > f0);
		const j = at < 0 ? use.length : at;
		use.splice(j, 0, { skill: "walkTo", f0, args });
		const why = g.to !== undefined ? "to" : g.arrive !== undefined ? "arrive" : typeof g.heading === "number" ? "a single heading" : `type "${type}"`;
		notes.push(`corrected: generators[${i}] (a walk with ${why}) -> use[${j}] walkTo { ${Object.keys(args).join(", ")} }: a generator walks by steps and [h0, h1]; walkTo is the walk that heads for a point`);
	});
	const { generators, ...rest } = spec;
	return { ...rest, ...(kept.length ? { generators: kept } : {}), use };
}

function fixUse(u, i, notes) {
	if (!plain(u)) return u;
	let out = u;
	const skill = SKILL_NAMES.includes(u.skill) ? u.skill : nameFor(String(u.skill), SKILL_NAMES);
	if (skill && skill !== u.skill) { out = { ...out, skill }; notes.push(`corrected: use[${i}].skill "${u.skill}" -> "${skill}"`); }
	const info = SKILL_INFO[out.skill];
	if (!info) return out;
	const known = Object.keys(info.args);
	if (plain(out.args) || out.args === undefined) {
		const given = out.args ?? {};
		let args = renameFields(given, known, `use[${i}].args`, notes);
		// an enum arg written another way: "left" -> "l", "Back" -> "back"
		for (const [a, v] of Object.entries(args)) {
			const choices = info.args[a]?.enum, to = choices && typeof v === "string" && !choices.includes(v) ? nameFor(v, choices, { left: "l", right: "r" }) : null;
			if (to) { args = { ...args, [a]: to }; notes.push(`corrected: use[${i}].args.${a} "${v}" -> "${to}"`); }
		}
		if (args.f0 !== undefined && !known.includes("f0") && out.f0 === undefined) {
			const { f0, ...rest } = args;
			args = rest; out = { ...out, f0 };
			notes.push(`corrected: use[${i}].args.f0 -> use[${i}].f0`);
		}
		// an arg of the skill written beside args goes into args
		for (const f of Object.keys(out)) {
			const a = USE_FIELDS.includes(f) ? null : nameFor(f, known);
			if (!a || a in args) continue;
			args = { ...args, [a]: out[f] };
			out = Object.fromEntries(Object.entries(out).filter(([k]) => k !== f));
			notes.push(`corrected: use[${i}].${f} -> use[${i}].args.${a}`);
		}
		// an anchor a skill defines (reachGrip define) is an anchor like any other
		if (plain(args.define) && ANCHOR_FIELDS[args.define.kind]) {
			const define = renameFields(args.define, ["kind", ...ANCHOR_FIELDS[args.define.kind]], `use[${i}].args.define`, notes, FIELD_ALIASES.anchor);
			if (define !== args.define) args = { ...args, define };
		}
		if (args !== given) out = { ...out, args };
	}
	return renameFields(out, USE_FIELDS, `use[${i}]`, notes, FIELD_ALIASES.use);
}

/** The body's channels and the spec's own (spec.channels, object and check channels, validate.js). */
const knownChannels = spec => [...VEC_CHANNELS, ...NUM_CHANNELS, ...MAP_CHANNELS, ...customChannels(spec)];

function channelFor(ch, known) {
	const s = sided(ch), side = /_[lr]$/.exec(s)?.[0] ?? "", family = side ? s.slice(0, -2) : s;
	const alias = CHANNEL_ALIASES[family] ?? CHANNEL_ALIASES[squash(family)];
	if (alias && known.includes(alias + side)) return alias + side;
	return nameFor(s, known);
}

function fixKey(key, i, known, notes) {
	if (!plain(key) || !plain(key.set)) return key;
	let set = key.set, step = key.step;
	for (const ch of Object.keys(key.set)) {
		if (known.includes(ch) || ch.endsWith("_vis") || ch.startsWith("w_")) continue;
		const to = channelFor(ch, known);
		if (!to || to in set) continue;
		set = Object.fromEntries(Object.entries(set).map(([k, v]) => (k === ch ? [to, v] : [k, v])));
		if (Array.isArray(step)) step = step.map(s => (s === ch ? to : s));
		notes.push(`corrected: keys[${i}] (f${key.f}) channel "${ch}" -> "${to}"`);
	}
	for (const side of ["l", "r"]) {
		const map = set[`fingers_${side}`];
		if (!plain(map)) continue;
		const fixed = renameFields(map, FINGER_PRESETS, `keys[${i}] (f${key.f}) fingers_${side}`, notes);
		if (fixed !== map) set = { ...set, [`fingers_${side}`]: fixed };
	}
	return set === key.set ? key : { ...key, set, ...(step ? { step } : {}) };
}

/** objects.<id>: { free: { keys } } -> { keys }: a kind name used as a wrapper around the record's own fields. */
function unwrapObject(id, o, notes) {
	if (!plain(o)) return o;
	const wrap = Object.keys(o).filter(k => ["free", "carry", "hinge", "follow", "switch"].includes(k) && plain(o[k]));
	if (wrap.length !== 1) return o;
	const { [wrap[0]]: inner, ...rest } = o;
	if (Object.keys(inner).some(k => k in rest)) return o;
	notes.push(`corrected: objects.${id}.${wrap[0]} { ${Object.keys(inner).join(", ")} } -> objects.${id} { ${Object.keys(inner).join(", ")} }: an entry's kind is read from its fields, not named`);
	return { ...rest, ...inner };
}

function fixObject(id, o, notes) {
	const at = `objects.${id}`, rec = unwrapObject(id, o, notes);
	if (!plain(rec)) return rec;
	const all = [...new Set(Object.values(OBJECT_FIELDS).flat())];
	let out = renameFields(rec, all, at, notes);
	if (Array.isArray(out.keys)) out = { ...out, keys: out.keys.map((k, j) => renameFields(k, OBJECT_KEY_FIELDS, `${at}.keys[${j}]`, notes, FIELD_ALIASES.objectKey)) };
	if (plain(out.fall)) out = { ...out, fall: renameFields(out.fall, FALL_FIELDS, `${at}.fall`, notes) };
	else if (Array.isArray(out.fall)) out = { ...out, fall: out.fall.map((fl, j) => renameFields(fl, FALL_FIELDS, `${at}.fall[${j}]`, notes)) };
	return out;
}

const fixGoal = (g, i, notes) => renameFields(g, GOAL_FIELDS, `goals[${i}]`, notes);

function fixAnchors(anchors, notes) {
	if (!plain(anchors)) return anchors;
	return Object.fromEntries(Object.entries(anchors).map(([name, a]) => [name, plain(a) && ANCHOR_FIELDS[a.kind]
		? renameFields(a, ["kind", ...ANCHOR_FIELDS[a.kind]], `anchors.${name}`, notes, FIELD_ALIASES.anchor) : a]));
}

function fixChecks(checks, notes) {
	if (!plain(checks)) return checks;
	return Object.fromEntries(Object.entries(checks).map(([name, list]) => [name, CHECK_ENTRY_FIELDS[name] ? mapList(list, (k, j) => renameFields(k, CHECK_ENTRY_FIELDS[name], `checks.${name}[${j}]`, notes)) : list]));
}

/**
 * correctSpec(spec, notes) -> the spec with every correction above (a new object when one applied,
 * else spec itself); notes gets one "corrected: ..." line per correction. Run before the spec is stored (pipeline.js).
 */
function correctSpec(spec, notes = []) {
	if (!plain(spec)) return spec;
	const before = notes.length;
	let s = renameFields(spec, [...SPEC_FIELDS, "probes"], "spec", notes);
	s = moveGenerators(s, notes);
	if (Array.isArray(s.use)) s = { ...s, use: s.use.map((u, i) => fixUse(u, i, notes)) };
	if (s.anchors) s = { ...s, anchors: fixAnchors(s.anchors, notes) };
	if (Array.isArray(s.keys)) { const known = knownChannels(s); s = { ...s, keys: s.keys.map((k, i) => fixKey(k, i, known, notes)) }; }
	if (plain(s.objects)) s = { ...s, objects: Object.fromEntries(Object.entries(s.objects).map(([id, o]) => [id, fixObject(id, o, notes)])) };
	if (Array.isArray(s.goals)) s = { ...s, goals: s.goals.map((g, i) => fixGoal(g, i, notes)) };
	if (Array.isArray(s.fits)) s = { ...s, fits: s.fits.map((f, i) => renameFields(f, FIT_FIELDS, `fits[${i}]`, notes)) };
	if (s.checks) s = { ...s, checks: fixChecks(s.checks, notes) };
	return notes.length > before ? s : spec;
}

/**
 * fitWalks(spec, { sk, scene }, notes, refusals) -> spec with each walkTo's fitted args (skills/basic.js fitTo) written
 * into its use entry, so the stored spec walks where it says and compiles the same again; refusals gets one line per
 * walk it cannot fit (the validator lists them with its own, pipeline.js). A spec that does not expand is left as it is.
 */
function fitWalks(spec, { sk, scene } = {}, notes = [], refusals = []) {
	if (!plain(spec) || !Array.isArray(spec.use) || !spec.use.some(u => u?.skill === "walkTo" && plain(u.args) && u.args.to !== undefined)) return spec;
	// a walk may end later freely only in a frames "auto" spec with nothing after it, else into frames nothing uses
	// (skills/basic.js fitTo, roomAfter): busy lists the frames of the object keys, grabs and releases, last the take's last frame
	const busy = Object.values(plain(spec.objects) ? spec.objects : {}).flatMap(o => (plain(o) ? [o.grab, o.release, ...(Array.isArray(o.keys) ? o.keys.map(k => k?.f) : [])] : [])).filter(Number.isFinite);
	const expand = noStop => {
		const fit = { refusals: [], stretch: spec.frames === "auto", busy, last: Number.isFinite(spec.frames) ? spec.frames - 1 : Infinity, noStop, stopped: new Set() };
		try { return { used: expandUse({ ...spec, frames: 20000 }, { sk, scene, fit, auto: true }).used, fit }; } catch { return null; }
	};
	// a walk stopped before a body (walk-fit.js) moves where the next one starts: a stop is kept only while the spec has no
	// more refusals than with every walk on its to (bench replay: 3 of 692 specs refused a later walk), the earliest first
	let run = expand(new Set());
	if (!run) return spec;
	if (run.fit.stopped.size) {
		const off = new Set(run.fit.stopped), onTo = expand(off);
		if (onTo && onTo.fit.refusals.length < run.fit.refusals.length) {
			for (const i of [...run.fit.stopped].sort((a, b) => a - b)) {
				off.delete(i);
				const t = expand(off);
				if (!t || t.fit.refusals.length > onTo.fit.refusals.length) off.add(i);
			}
			run = expand(off) ?? onTo;
		}
	}
	const { used, fit } = run;
	refusals.push(...fit.refusals);
	if (!used.some(u => u.adjust)) return spec;
	for (const u of used) if (u.adjust) notes.push(`corrected: ${u.adjust.note}`);
	return { ...spec, use: spec.use.map((u, i) => (used[i]?.adjust ? { ...u, args: { ...u.args, ...used[i].adjust.args } } : u)) };
}

/** prepareSpec(spec, { sk, scene }, notes, refusals): correctSpec, then fitWalks: the spec as it is stored and compiled. */
export const prepareSpec = (spec, ctx, notes, refusals) => fitWalks(correctSpec(spec, notes), ctx, notes, refusals);
