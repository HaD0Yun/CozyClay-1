// Skill library: parameterised spec builders the agent calls with spec.use instead of writing
// every key. use: [{ skill, args, f0 }] expands, in order, into keys, anchors, props, fits,
// objects, checks and channels (the extra channels a skill keys) before compile; each skill reads the pose the earlier keys leave at its
// f0. The agent's own keys come after the skill keys (a key of the agent wins on the same
// frame), and the agent's own anchors/props/fits replace a skill's of the same name.
import { stateAt } from "../compiler/walk.js";
import { didYouMean, suggestField, fmt } from "../compiler/vocab.js";
import { USE_FIELDS } from "../schema/fields.js";
import { SKILL_INFO } from "./info.js";
import { fixOptions } from "../fix/index.js";
import { standIdle, walkTo, reachGrip } from "./basic.js";
import { sitInSeat, exitCar } from "./car.js";
import { smokeCigarette } from "./smoke.js";
import { flip } from "./flip.js";
import { hitReaction } from "./impact.js";
import { throwObject } from "./throw.js";
import { catchObject } from "./catch.js";

const SKILLS = { standIdle, sitInSeat, exitCar, walkTo, reachGrip, smokeCigarette, flip, hitReaction, throwObject, catchObject };
export const SKILL_NAMES = Object.keys(SKILLS);
const bad = msg => { throw new Error(`MOTION_SPEC_INVALID: ${msg}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function mergeNamed(into, part, what, tag) {
	for (const [name, v] of Object.entries(part ?? {})) {
		if (into[name] && !same(into[name], v)) bad(`${tag} defines ${what}.${name} differently from an earlier skill; rename one or define it yourself in spec.${what}`);
		into[name] = v;
	}
}

/** Lists merge without duplicates; anything else (an unknown check, a non-list) passes on for the validator to name. */
function mergeChecks(into, part) {
	for (const [name, v] of Object.entries(part ?? {})) {
		if (name === "limits" && v && typeof v === "object" && !Array.isArray(v)) { into.limits = { ...into.limits, ...v }; continue; }
		if (!Array.isArray(v) || (into[name] !== undefined && !Array.isArray(into[name]))) { into[name] = v; continue; }
		const list = into[name] ?? (into[name] = []);
		for (const item of v) if (!list.some(x => same(x, item))) list.push(item);
	}
}

const isOpen = v => Boolean(v) && typeof v === "object" && !Array.isArray(v) && (v.range ?? v.search) !== undefined;
const said = t => (t.description ? ` (${t.description})` : "");

/** What is wrong with one skill arg against its schema fragment (skills/info.js): a value of the wrong kind, an enum miss; null when fine or not checked. */
function argProblem(at, v, t) {
	if (!t || v === undefined || isOpen(v)) return null;
	if (t.enum && !t.enum.includes(v)) return `${at} must be one of ${t.enum.map(e => JSON.stringify(e)).join(", ")}${said(t)}, got ${fmt(v)}${didYouMean(String(v), t.enum.map(String))}`;
	if ((t.type === "number" || t.type === "integer") && !Number.isFinite(v)) return `${at} must be a number${said(t)}, got ${fmt(v)}`;
	if (t.type === "string" && typeof v !== "string") return `${at} must be a string${said(t)}, got ${fmt(v)}`;
	if (t.type === "boolean" && typeof v !== "boolean") return `${at} must be true or false${said(t)}, got ${fmt(v)}`;
	if (t.type === "array" && t.items?.type === "number" && !(Array.isArray(v) && v.length >= (t.minItems ?? 0) && v.every(x => Number.isFinite(x) || isOpen(x))))
		return `${at} must be ${t.minItems === 2 ? "[x, z]" : t.minItems === 3 ? "[x, y, z]" : "an array of numbers"}${said(t)}, got ${fmt(v)}`;
	return null;
}

/**
 * Every problem of spec.use that needs no expansion, all at once: the entry's shape, the skill name, unknown fields
 * and args, args of the wrong kind, required args, f0. lenient (a saved take) checks only what expansion cannot do without.
 */
function usageProblems(spec, lenient = false) {
	if (!Array.isArray(spec.use)) return ["spec.use must be an array of { skill, args, f0 }"];
	const out = [];
	spec.use.forEach((u, i) => {
		if (!u || typeof u !== "object" || Array.isArray(u)) return out.push(`use[${i}] must be { skill, args, f0 }, got ${fmt(u)}`);
		if (!SKILLS[u.skill]) return out.push(`use[${i}].skill "${u.skill}" is not a skill${didYouMean(String(u.skill), SKILL_NAMES)} (skills: ${SKILL_NAMES.join(", ")})`);
		if (!lenient) for (const f of Object.keys(u)) if (!USE_FIELDS.includes(f)) out.push(`use[${i}] has unknown field "${f}"${suggestField(f, USE_FIELDS)}; an entry is { skill, args, f0 }`);
		if (u.args !== undefined && (!u.args || typeof u.args !== "object" || Array.isArray(u.args))) out.push(`use[${i}].args must be an object, got ${JSON.stringify(u.args)}`);
		else if (!lenient) {
			const info = SKILL_INFO[u.skill], known = Object.keys(info.args);
			for (const [a, v] of Object.entries(u.args ?? {})) {
				if (!known.includes(a)) out.push(`use[${i}].args.${a} is not an arg of ${u.skill}${suggestField(a, known)} (args: ${known.join(", ")})`);
				else { const p = argProblem(`use[${i}].args.${a}`, v, info.args[a]); if (p) out.push(p); }
			}
			for (const a of info.required ?? []) if (u.args?.[a] === undefined) out.push(`use[${i}] ${u.skill} needs args.${a}${said(info.args[a])}`);
		}
		// past the last frame is said in order below, beside what an earlier skill needs (set frames >= ...)
		if (!Number.isInteger(u.f0) || u.f0 < 0) out.push(`use[${i}].f0 must be an integer frame within 0..${spec.frames - 1}, got ${JSON.stringify(u.f0)}`);
	});
	return out;
}

/**
 * spec with `use` -> { spec: plain spec (no use), used: [{ skill, f0, end, paced?, cut?, placed?, adjust? }] }; every
 * problem of the use entries themselves is refused at once (usageProblems); lenient ignores unknown use[i] fields and
 * args. fit ({ refusals: [] }, correct.js fitWalks) lets a skill fit its own args to what they ask for (walkTo: the
 * stride to reach to), as adjust: { args, note }, or refuse into fit.refusals. auto (frames-auto.js) lets a skill
 * that holds to the last frame end where its own motion ends. A skill whose release or settle the last frame cuts ends
 * there holding (cut says so); one that needs frames past the last for its own motion is refused.
 */
export function expandUse(spec, { sk, scene, lenient = false, auto = false, fit }) {
	if (!spec.use?.length) return { spec, used: [] };
	const problems = usageProblems(spec, lenient);
	if (problems.length) bad(problems.join("\n"));
	const own = (spec.keys ?? []).map((k, i) => ({ ...k, src: `keys[${i}]` }));
	const merged = { anchors: {}, props: {}, objects: {}, fits: [], checks: {}, channels: [], fills: {}, goals: [] }, skillKeys = [], used = [];
	spec.use.forEach((u, i) => {
		const tag = `use[${i}] ${u.skill}`;
		if (u.f0 > spec.frames - 1) bad(`use[${i}].f0 must be an integer frame within 0..${spec.frames - 1}, got ${JSON.stringify(u.f0)}`);
		const keys = [...skillKeys, ...own];
		const ctx = { sk, scene, frames: spec.frames, fps: spec.fps ?? 24, auto, fit, props: { ...merged.props, ...spec.props }, self: spec.fix !== false && spec.fix?.self !== false, f0: u.f0, args: structuredClone(u.args ?? {}), tag, keys,
			use: spec.use, index: i, place: fixOptions(spec.fix).stance, state: structuredClone(stateAt(keys, u.f0)), anchors: { ...merged.anchors, ...spec.anchors }, objects: { ...merged.objects, ...spec.objects } };
		const part = SKILLS[u.skill](ctx), last = Math.max(part.end ?? u.f0, ...part.keys.map(k => k.f));
		if (last > spec.frames - 1) bad(`${tag} needs ${last - u.f0} frames from f${u.f0} (to f${last}), past the last frame f${spec.frames - 1}; set frames >= ${last + 1} or frames: "auto"`);
		skillKeys.push(...part.keys.map(k => ({ ...k, src: k.src ?? tag })));
		mergeNamed(merged.anchors, part.anchors, "anchors", tag);
		mergeNamed(merged.props, part.props, "props", tag);
		mergeNamed(merged.objects, part.objects, "objects", tag);
		for (const fit of part.fits ?? []) if (!merged.fits.some(x => same(x, fit))) merged.fits.push(fit);
		for (const ch of part.channels ?? []) if (!merged.channels.includes(ch)) merged.channels.push(ch);
		mergeChecks(merged.checks, part.checks);
		// fields a skill fills into an entry when it leaves them out (throwObject: a carry's release and fall)
		for (const [id, f] of Object.entries(part.fills ?? {})) merged.fills[id] = { ...merged.fills[id], ...f };
		merged.goals.push(...(part.goals ?? []));
		used.push({ skill: u.skill, f0: u.f0, end: part.end, ...(part.paced ? { paced: part.paced } : {}), ...(part.cut ? { cut: part.cut } : {}), ...(part.placed ? { placed: part.placed } : {}), ...(part.adjust ? { adjust: part.adjust } : {}) });
	});
	const out = { ...spec, keys: [...skillKeys, ...own], anchors: { ...merged.anchors, ...spec.anchors }, props: { ...merged.props, ...spec.props },
		objects: { ...merged.objects, ...spec.objects } };
	const channels = [...new Set([...merged.channels, ...(Array.isArray(spec.channels) ? spec.channels : [])])];
	if (channels.length) out.channels = channels;
	const mine = spec.fits ?? [];
	out.fits = [...merged.fits.filter(f => !mine.some(m => m.side === f.side && m.anchor === f.anchor)), ...mine];
	mergeChecks(merged.checks, spec.checks);
	out.checks = merged.checks;
	for (const [id, f] of Object.entries(merged.fills)) if (out.objects[id]) out.objects[id] = { ...f, ...out.objects[id] };
	if (merged.goals.length) out.goals = [...merged.goals, ...(spec.goals ?? [])];
	delete out.use;
	return { spec: out, used };
}
