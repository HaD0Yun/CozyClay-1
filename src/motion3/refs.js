// C2. Point references, the one grammar goals, probes and the timeline use (spec.checks keep
// their older joint/prop/anchor subset, validate-common.js refOk):
//   joint:<Bone> | bone:<Bone>          the bone's joint (the two are the same; names go through bones.js)
//   prop:<prop>.<point>                 a point of a held prop (spec.props; "origin" always exists)
//   anchor:<name>                       a spec anchor, resolved as the compiler resolves it
//   landmark:mouth                      the measured face landmark
//   person:<id>.<Bone>                  another character's joint where its installed take has it (people.js)
//   object:<id>[.center|.top|.base|.rim] a body or a group (object-pose.js objectBoxesAt): the centre,
//                                       top-face centre or bottom-face centre of the world AABB of its
//                                       part boxes' corners (default center); .rim is its opening (a cup's,
//                                       a can's): the top face of its highest part in the part's own axes,
//                                       so it tilts with it, and measured against another point the edge of
//                                       that face nearest the point (where a lip meets a cup). A tilted cup's
//                                       .top is the box's highest corner height over its middle, not its rim
// Frames are absolute; a frame outside the compiled window (out.f0 ..) answers null.
import { REF_KINDS } from "./schema/fields.js";
import { resolveBone } from "./bones.js";
import { objectBoxesAt, partsOf } from "./object-pose.js";
import { objectOk } from "./compiler/validate-common.js";
import { resolveAnchor } from "./compiler/anchors.js";
import { bonePoint } from "./compiler/skeleton.js";
import { didYouMean } from "./compiler/vocab.js";
import { add, apply, sub, len } from "./compiler/math.js";
import { sdBox } from "./qa/geometry.js";
import { personJoint, peopleList } from "./people.js";

const SYNTAX = { joint: "joint:<Bone>", bone: "bone:<Bone>", prop: "prop:<prop>.<point>", anchor: "anchor:<name>", landmark: "landmark:mouth", object: "object:<id>[.center|.top|.base|.rim]", person: "person:<id>.<Bone>" };

function parse(ref) {
	const m = /^([a-z]+):(.+)$/s.exec(String(ref));
	if (!m) return null;
	const [, kind, rest] = m;
	if (kind === "prop") { const [name, point] = rest.split("."); return { kind, name, point: point ?? "" }; }
	if (kind === "object") { const o = /^(.+)\.(center|top|base|rim)$/s.exec(rest); return { kind, name: o ? o[1] : rest, point: o ? o[2] : null }; }
	if (kind === "person") { const dot = rest.lastIndexOf("."); return { kind, name: dot > 0 ? rest.slice(0, dot) : rest, point: dot > 0 ? rest.slice(dot + 1) : "" }; }
	return { kind, name: rest, point: null };
}

function boxesPoint(boxes, which) {
	const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
	for (const b of boxes) for (const x of [-1, 1]) for (const y of [0, 2]) for (const z of [-1, 1]) {
		const p = add(b.pos, apply(b.R, [x * b.half[0], y * b.half[1], z * b.half[2]]));
		for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
	}
	const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
	return which === "top" ? [c[0], hi[1], c[2]] : which === "base" ? [c[0], lo[1], c[2]] : c;
}

/** The opening of a body or group's boxes: { o, n, r }, the top face of the highest part in its own axes (centre, axis, the smaller half width). */
export function openingOf(boxes) {
	const tops = (boxes ?? []).map(b => ({ o: add(b.pos, apply(b.R, [0, 2 * b.half[1], 0])), n: [b.R[0][1], b.R[1][1], b.R[2][1]], r: Math.min(b.half[0], b.half[2]) }));
	return tops.length ? tops.reduce((p, q) => (q.o[1] > p.o[1] ? q : p)) : null;
}

/** The point of an opening's edge nearest p (its centre when p is on the axis). */
function rimNear(op, p) {
	const v = sub(p, op.o), along = v[0] * op.n[0] + v[1] * op.n[1] + v[2] * op.n[2], across = sub(v, op.n.map(x => x * along)), d = len(across);
	return d > 1e-6 ? add(op.o, across.map(x => (x * op.r) / d)) : op.o;
}

/** World point [x, y, z] of `ref` at absolute frame f of compile result out, or null. */
export function refPoint(out, f, ref) {
	const fr = out.frames?.[f - (out.f0 ?? 0)], r = parse(ref);
	if (!fr || !r) return null;
	const { s, diag, c } = fr, sk = out.ctx.sk;
	switch (r.kind) {
		case "joint": case "bone": { const { bone } = resolveBone(sk, r.name); return bone ? s.P[sk.index[bone]].slice() : null; }
		case "prop": { const p = diag.props?.[r.name]?.[r.point]; return Array.isArray(p) ? p.slice() : null; }
		case "anchor": return out.ctx.spec.anchors?.[r.name] ? resolveAnchor(out.ctx, r.name, s, { ...diag, frame: f }, c) : null;
		case "landmark": return sk.landmarks?.[r.name] ? bonePoint(s, sk.index.Head, sk.landmarks[r.name]) : null;
		case "object": { const boxes = objectBoxesAt(out, r.name, f); return boxes ? (r.point === "rim" ? openingOf(boxes).o.slice() : boxesPoint(boxes, r.point)) : null; }
		case "person": return personJoint(out.ctx.scene, r.name, r.point, f);
		default: return null;
	}
}

/**
 * Metres between refs a and b at absolute frame f, or null when either is unknown there. A bare
 * object:<id> (no .center/.top/.base) means "to the object's surface": the distance from the
 * other point to the nearest part box (sdBox, 0 inside); two bare objects measure a's centre to
 * b's surface. Any other pair is the distance between the two points.
 */
export function refDistance(out, f, a, b) {
	const bare = ref => { const r = parse(ref); return r?.kind === "object" && r.point === null ? r : null; };
	const surf = bare(b) ? [a, bare(b)] : bare(a) ? [b, bare(a)] : null;
	if (surf) {
		const p = refPoint(out, f, surf[0]), boxes = objectBoxesAt(out, surf[1].name, f);
		return p && boxes ? Math.max(0, Math.min(...boxes.map(box => sdBox(p, box)))) : null;
	}
	// an opening against another point: the edge of it nearest that point
	const rim = [a, b].map(ref => { const r = parse(ref); return r?.kind === "object" && r.point === "rim" ? r : null; });
	if (rim[0] || rim[1]) {
		const [own, other] = rim[0] ? [rim[0], b] : [rim[1], a], p = refPoint(out, f, other), op = openingOf(objectBoxesAt(out, own.name, f));
		return p && op ? len(sub(p, rimNear(op, p))) : null;
	}
	const p = refPoint(out, f, a), q = refPoint(out, f, b);
	return p && q ? len(sub(p, q)) : null;
}

/** The prefixed refs a bare name could mean in this spec, rig and scene (lenient.js takes the one when there is one). */
export function bareRefs(spec, { sk, scene }, ref, kinds = REF_KINDS) {
	if (typeof ref !== "string" || !ref) return [];
	const id = ref.replace(/\.(center|top|base|rim)$/, ""), [prop, point] = ref.split(".");
	const bone = sk && (kinds.includes("joint") || kinds.includes("bone")) ? resolveBone(sk, ref).bone : null;
	return [
		kinds.includes("object") && (scene?.objects?.[id] || partsOf(scene, id).length) && `object:${ref}`,
		bone && `${kinds.includes("joint") ? "joint" : "bone"}:${bone}`,
		kinds.includes("anchor") && spec.anchors?.[ref] && `anchor:${ref}`,
		kinds.includes("prop") && spec.props?.[prop] && (point === "origin" || spec.props[prop].points?.[point]) && `prop:${ref}`,
		kinds.includes("landmark") && ref === "mouth" && "landmark:mouth",
	].filter(Boolean);
}

/** `; did you mean "object:empty-2"?` for a bare name (bareRefs), or "". A field that takes more than one ref kind stays strict. */
function bareHint(spec, ctx, ref, kinds) {
	const known = bareRefs(spec, ctx, ref, kinds);
	return known.length ? `; did you mean ${known.map(k => `"${k}"`).join(" or ")}?` : "";
}

/**
 * Validates ref against the spec (props, anchors), the rig (bones) and the scene (objects and
 * groups). Reports one exact message through err, prefixed `${at} "${ref}"`, and answers whether
 * the ref is good. kinds limits the grammar (default all of REF_KINDS). A bare name (no kind:)
 * is refused with the forms it could mean (bareHint).
 */
export function checkRef(spec, err, { sk, scene }, at, ref, kinds = REF_KINDS) {
	const r = parse(ref), tag = `${at} "${ref}"`;
	if (!r || !kinds.includes(r.kind)) { err(`${tag} must be ${kinds.map(k => SYNTAX[k]).join(", ")}${r ? "" : bareHint(spec, { sk, scene }, ref, kinds)}`); return false; }
	if (r.kind === "joint" || r.kind === "bone") {
		const { bone, hint } = sk ? resolveBone(sk, r.name) : { bone: r.name };
		if (!bone) err(`${tag}: unknown bone${hint}`);
		return Boolean(bone);
	}
	if (r.kind === "prop") {
		const ok = Boolean(spec.props?.[r.name] && (r.point === "origin" || spec.props[r.name].points?.[r.point]));
		if (!ok) err(`${tag}: spec.props has no point ${r.name}.${r.point}`);
		return ok;
	}
	if (r.kind === "anchor") {
		if (!spec.anchors?.[r.name]) err(`${tag}: no anchor "${r.name}" in spec.anchors${didYouMean(r.name, Object.keys(spec.anchors ?? {}))}`);
		return Boolean(spec.anchors?.[r.name]);
	}
	if (r.kind === "landmark") {
		if (r.name !== "mouth") err(`${tag}: the only landmark is "mouth"`);
		return r.name === "mouth";
	}
	if (r.kind === "person") {
		const ok = Boolean(personJoint(scene, r.name, r.point, 0));
		if (!ok) err(`${tag}: no person "${r.name}" with joint "${r.point}" (people with an installed take: ${peopleList(scene)})`);
		return ok;
	}
	return objectOk(err, scene, tag, r.name, { groups: true });
}
