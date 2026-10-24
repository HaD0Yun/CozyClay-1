// The checks every part of the validator shares: a bone, a scene object, a check point.
// Messages are exact (the agent fixes them in one edit). See validate.js.
import { didYouMean } from "./vocab.js";
import { partsOf } from "../object-pose.js";

export function boneOk(err, sk, at, bone) {
	if (!sk || sk.index[bone] !== undefined) return true;
	err(`${at} names unknown bone "${bone}"${didYouMean(String(bone), sk.names)}`);
	return false;
}

/**
 * A scene object id. A group (an Empty: no box of its own) passes only with { groups: true }
 * (carry, hinge, object: refs and object anchors take groups, see C3); elsewhere the message lists its parts.
 */
export function objectOk(err, scene, at, id, { groups = false } = {}) {
	const ids = Object.keys(scene?.objects ?? {});
	if (!ids.length || ids.includes(id)) return true;
	const parts = partsOf(scene, id);
	if (parts.length && groups) return true;
	if (parts.length) err(`${at} names "${id}", a group (Empty) with no body of its own; its parts are ${parts.join(", ")}. Name one part`);
	else if (scene?.others?.[id]) err(`${at} names "${id}", a ${scene.others[id].renderer ?? "record"} with no body (no size to stand on, hold or hit); name a scene body${didYouMean(String(id), ids)}`);
	else err(`${at} names object "${id}", which is not in the scene${didYouMean(String(id), [...new Set([...ids, ...ids.flatMap(k => scene.objects[k].ancestors ?? []), ...Object.keys(scene.others ?? {})])])}`);
	return false;
}

export function refOk(spec, err, sk, at, ref) {
	const [kind, rest] = String(ref).split(/:(.*)/s);
	if (kind === "joint") return boneOk(err, sk, at, rest);
	if (kind === "anchor") return spec.anchors?.[rest] ? true : err(`${at} "${ref}" names no anchor`);
	if (kind === "prop") { const [p, pt] = (rest ?? "").split("."); return spec.props?.[p]?.points?.[pt] || pt === "origin" ? true : err(`${at} "${ref}" names no prop point`); }
	err(`${at} "${ref}" must be joint:<Bone>, prop:<prop>.<point> or anchor:<name>`);
}
