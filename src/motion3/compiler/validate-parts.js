// Validation of the spec parts other than keys: anchors, props, fits, generators, checks and
// fix; objects (validate-objects.js) and goals (validate-goals.js) run from here too. Unknown
// fields go through opts.unknown, which ignores them on a lenient reload. See validate.js.
import { didYouMean, suggestField, CONVENTIONS, isVec3, fmt, GRASPS } from "./vocab.js";
import { FIX_KEYS } from "../fix/index.js";
import { QA_LIMITS } from "../qa/checks.js";
import { ANCHOR_FIELDS, PROP_FIELDS, FIT_FIELDS, WALK_FIELDS, CHECK_FIELDS, CHECK_ENTRY_FIELDS } from "../schema/fields.js";
import { boneOk, objectOk, refOk } from "./validate-common.js";
import { validateObjects } from "./validate-objects.js";
import { validateGoals } from "./validate-goals.js";
import { personJoint, peopleList } from "../people.js";
import { socketsOf, socketNamed } from "../sockets.js";

const SIDE = new Set(["l", "r"]);
const isObject = v => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Every field of obj not in fields goes to unknown, with a suggestion and the list. */
function fieldsOk(unknown, at, obj, fields) {
	if (!isObject(obj)) return;
	for (const f of Object.keys(obj)) if (!fields.includes(f)) unknown(`${at} has unknown field "${f}"${suggestField(f, fields)} (fields: ${fields.join(", ")})`);
}

function validateAnchors(spec, err, { sk, scene, unknown = err }) {
	for (const [name, a] of Object.entries(spec.anchors ?? {})) {
		const at = `anchors.${name}`;
		if (/_[lr]$/.test(name)) err(`${at}: an anchor name may not end in _l or _r (the weight channel w_${name}_l would read as anchor "${name.slice(0, -2)}"); the side goes on the weight channel, so name it "${name.slice(0, -2)}"`);
		if (!a || !ANCHOR_FIELDS[a.kind]) { err(`${at}.kind must be one of ${Object.keys(ANCHOR_FIELDS).join(", ")}, got ${fmt(a?.kind)}`); continue; }
		fieldsOk(unknown, `${at} (${a.kind})`, a, ["kind", ...ANCHOR_FIELDS[a.kind]]);
		for (const f of ["p", "offset", "local"]) if (a[f] !== undefined && !isVec3(a[f])) err(`${at}.${f} must be [x, y, z], got ${fmt(a[f])}`);
		if ((a.kind === "world" || a.kind === "body") && a.p === undefined) err(`${at} (${a.kind}) needs p: [x, y, z]${a.kind === "body" ? `, ${CONVENTIONS.pole}` : ""}`);
		if (a.kind === "bone") boneOk(err, sk, at, a.bone);
		if (a.kind === "segment") { boneOk(err, sk, `${at}.from`, a.from); boneOk(err, sk, `${at}.to`, a.to); if (a.reach !== undefined && !SIDE.has(a.reach)) err(`${at}.reach must be "l" or "r"`); }
		if (a.kind === "object" && objectOk(err, scene, at, a.object, { groups: true })) {
			if (a.grasp !== undefined && !GRASPS.includes(a.grasp)) err(`${at}.grasp must be one of ${GRASPS.join(", ")}, got ${fmt(a.grasp)}`);
			if (a.socket !== undefined && scene?.objects && !socketNamed(scene, a.object, a.socket)) err(`${at}.socket: "${a.object}" has no socket ${fmt(a.socket)} (sockets: ${socketsOf(scene, a.object).map(k => k.name).join(", ") || "none"})`);
			if (a.socket !== undefined && a.grasp === undefined) err(`${at}.socket needs grasp (${GRASPS.join(", ")}): the socket says how the hand takes it`);
		}
		if (a.kind === "person" && !personJoint(scene, a.person, a.bone ?? "", 0)) err(`${at} (person) needs person: the id of another character with an installed take (people: ${peopleList(scene)}) and bone: one of its joints, got ${fmt(a.person)} ${fmt(a.bone)}`);
		if (a.kind === "landmark" && a.name !== "mouth") err(`${at}: the only landmark is "mouth", got ${fmt(a.name)}`);
		if (a.kind === "prop" && !spec.props?.[a.prop]?.points?.[a.point] && a.point !== "origin") err(`${at} needs prop point ${a.prop}.${a.point}, which spec.props does not define`);
	}
}

function validateProps(spec, err, { sk, unknown = err }) {
	for (const [name, p] of Object.entries(spec.props ?? {})) {
		const at = `props.${name}`;
		fieldsOk(unknown, at, p, PROP_FIELDS);
		if (!SIDE.has(p?.hand)) err(`${at}.hand must be "l" or "r", got ${fmt(p?.hand)}`);
		if (!Array.isArray(p?.origin) || !p.origin.length) err(`${at}.origin must list one or more bones`);
		else p.origin.forEach(b => boneOk(err, sk, `${at}.origin`, b));
		for (const [pt, v] of Object.entries(p?.points ?? {})) if (!isVec3(v)) err(`${at}.points.${pt} must be [d, l, n] along the palm axes, got ${fmt(v)}`);
	}
	(spec.fits ?? []).forEach((fit, i) => {
		const at = `fits[${i}]`;
		fieldsOk(unknown, at, fit, FIT_FIELDS);
		if (!SIDE.has(fit?.side)) err(`${at}.side must be "l" or "r", got ${fmt(fit?.side)}`);
		if (!spec.anchors?.[fit?.anchor]) err(`${at}.anchor "${fit?.anchor}" is not in spec.anchors${didYouMean(String(fit?.anchor), Object.keys(spec.anchors ?? {}))}`);
		const e = fit?.effector;
		if (e?.prop !== undefined) {
			const p = spec.props?.[e.prop];
			if (!p) err(`${at}.effector.prop "${e.prop}" is not in spec.props${didYouMean(String(e.prop), Object.keys(spec.props ?? {}))}`);
			else if (e.point !== "origin" && !p.points?.[e.point]) err(`${at}.effector ${e.prop}.${e.point} is not a point of spec.props.${e.prop} (points: ${[...Object.keys(p.points ?? {}), "origin"].join(", ")})`);
		}
		else if (Array.isArray(e?.joints)) e.joints.forEach(j => boneOk(err, sk, `${at}.effector`, j));
		else err(`${at}.effector must be { prop, point } or { joints: [bone, ...] }`);
		if (fit?.offset !== undefined && !isVec3(fit.offset)) err(`${at}.offset must be [x, y, z]`);
		if (fit?.orient !== undefined && typeof fit.orient !== "boolean") err(`${at}.orient must be true or false (false: the hand takes no grip turn), got ${fmt(fit.orient)}`);
	});
}

function validateGenerators(spec, err, { frames, unknown = err, past = "" }) {
	(spec.generators ?? []).forEach((g, i) => {
		const at = `generators[${i}]`;
		if (g?.type !== "walk") return err(`${at}.type must be "walk", got ${fmt(g?.type)}`);
		fieldsOk(unknown, at, g, WALK_FIELDS);
		if (!Number.isInteger(g.f0) || g.f0 < 0 || g.f0 > frames - 1) err(`${at}.f0 must be an integer frame within 0..${frames - 1}, got ${fmt(g.f0)}${g.f0 > frames - 1 ? past : ""}`);
		if (g.heading !== undefined && !(Array.isArray(g.heading) && g.heading.length === 2 && g.heading.every(Number.isFinite))) err(`${at}.heading must be [h0, h1] in degrees (${CONVENTIONS.yaw}), got ${fmt(g.heading)}`);
		for (const f of WALK_FIELDS.slice(2)) if (f !== "heading" && g[f] !== undefined && !Number.isFinite(g[f])) err(`${at}.${f} must be a finite number, got ${fmt(g[f])}`);
		if (g.steps !== undefined && !(Number.isInteger(g.steps) && g.steps >= 1)) err(`${at}.steps must be an integer >= 1, got ${fmt(g.steps)}`);
		if (g.turnDistance !== undefined && !(g.turnDistance > 0)) err(`${at}.turnDistance must be > 0 m, got ${fmt(g.turnDistance)}`);
	});
}

function validateChecks(spec, err, { sk, scene, frames, unknown = err, past = "" }) {
	const c = spec.checks ?? {};
	for (const k of Object.keys(c)) if (!CHECK_FIELDS.includes(k)) unknown(`checks.${k} is not a check${didYouMean(k, CHECK_FIELDS)} (checks: ${CHECK_FIELDS.join(", ")})`);
	// each list entry is an object with known fields; a bad entry is named once and skipped
	const each = (name, check = () => {}) => {
		const v = c[name], shape = `{ ${CHECK_ENTRY_FIELDS[name].join(", ")} }`;
		if (v === undefined) return;
		if (!Array.isArray(v)) return err(`checks.${name} must be an array of ${shape}, got ${fmt(v)}`);
		v.forEach((k, i) => {
			if (!isObject(k)) return err(`checks.${name}[${i}] must be ${shape}, got ${fmt(k)}`);
			fieldsOk(unknown, `checks.${name}[${i}]`, k, CHECK_ENTRY_FIELDS[name]);
			check(k, i);
		});
	};
	const when = (at, w) => {
		if (w === undefined || typeof w === "string") return;
		if (!(Array.isArray(w) && w.length === 2 && w.every(Number.isInteger) && w[0] <= w[1] && w[0] >= 0 && w[1] <= frames - 1)) err(`${at}.when must be a weight channel or [f0, f1] within 0..${frames - 1}, got ${fmt(w)}${Array.isArray(w) && w[1] > frames - 1 ? past : ""}`);
	};
	each("contacts", (k, i) => { refOk(spec, err, sk, `checks.contacts[${i}].point`, k.point); refOk(spec, err, sk, `checks.contacts[${i}].target`, k.target); when(`checks.contacts[${i}]`, k.when); });
	each("orient", (k, i) => {
		refOk(spec, err, sk, `checks.orient[${i}].from`, k.from); refOk(spec, err, sk, `checks.orient[${i}].to`, k.to); when(`checks.orient[${i}]`, k.when);
		if (!(k.along === "face" || k.along === "up" || isVec3(k.along))) err(`checks.orient[${i}].along must be "face", "up" or [x, y, z]`);
	});
	each("below", (k, i) => { boneOk(err, sk, `checks.below[${i}].joint`, k.joint); boneOk(err, sk, `checks.below[${i}].ref`, k.ref); when(`checks.below[${i}]`, k.when); });
	each("clearance", (k, i) => { objectOk(err, scene, `checks.clearance[${i}]`, k.object); when(`checks.clearance[${i}]`, k.frames); });
	each("appear", (k, i) => { boneOk(err, sk, `checks.appear[${i}].joint`, k.joint); if (!spec.anchors?.[k.anchor]) err(`checks.appear[${i}].anchor "${k.anchor}" is not in spec.anchors`); });
	each("supports", (k, i) => objectOk(err, scene, `checks.supports[${i}]`, k.object));
	each("allow");
	for (const name of Object.keys(c.limits ?? {})) if (!(name in QA_LIMITS)) unknown(`checks.limits.${name} is not a QA limit${didYouMean(name, Object.keys(QA_LIMITS))}`);
	const fix = spec.fix;
	if (fix !== undefined && fix !== false && (typeof fix !== "object" || fix === null)) err(`spec.fix must be false or { ${FIX_KEYS.join(", ")} }`);
	else for (const k of Object.keys(fix || {})) if (!FIX_KEYS.includes(k)) unknown(`spec.fix.${k} is not a fix${didYouMean(k, FIX_KEYS)} (fixes: ${FIX_KEYS.join(", ")})`);
	if (fix && fix.grasp !== undefined && typeof fix.grasp !== "boolean") err(`spec.fix.grasp must be true (fingers close on what a hand holds, the default) or false (the preset grip, the object at its grab-frame offset), got ${fmt(fix.grasp)}`);
	if (fix && fix.person !== undefined && typeof fix.person !== "boolean") err(`spec.fix.person must be true (arms kept out of the other characters, the default) or false, got ${fmt(fix.person)}`);
}

/** opts = { sk, scene, frames, lenient, unknown: err for an unknown field (a no-op when lenient), past: the
 * advice a frame past the end gets (validate.js) }. */
export function validateParts(spec, err, opts) {
	validateAnchors(spec, err, opts);
	validateProps(spec, err, opts);
	validateObjects(spec, err, opts);
	validateGenerators(spec, err, opts);
	validateChecks(spec, err, opts);
	validateGoals(spec, err, opts);
}
