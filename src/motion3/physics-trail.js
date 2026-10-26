// The physics overlay's motion trail of spring objects (spec.objects[id].spring, compiler/spring.js): the path of
// each one's tip over the last TRAIL_FRAMES frames, read from the take's own track (what playback draws). The tip
// is the corner of the record's boxes (its parts, for a group) farthest from its anchor, the pose's origin the
// spring swings it about (compiler/spring.js swungPose). An object without a spring has no trail.
// Pure and cached per view (physics-view.js).
import { add, apply, sub, len, T } from "./compiler/math.js";
import { trackPose } from "./physics-frames.js";
import { groupsOf } from "./scene.js";
import { corners } from "./free-motion.js";
import { partsOf } from "./object-pose.js";

/** How many frames back a trail reaches (the playhead's frame included). */
export const TRAIL_FRAMES = 24;
const tips = new WeakMap();

/** [{ id, local }]: each spring object the take tracks, with its tip in its own frame. */
function springTips(view) {
	if (tips.has(view)) return tips.get(view);
	const { scene, spec } = view.out.ctx, groups = groupsOf(scene), list = [];
	for (const [id, o] of Object.entries(spec.objects ?? {})) {
		const rest = scene.objects[id] ?? groups[id];
		if (!o?.spring || !rest || !view.take.objects?.[id]?.pos) continue;
		let local = null;
		for (const c of partsOf(scene, id).flatMap(part => corners(scene.objects[part]))) {
			const q = apply(T(rest.R), sub(c, rest.pos));
			if (!local || len(q) > len(local) + 1e-9) local = q;
		}
		if (local) list.push({ id, local });
	}
	tips.set(view, list);
	return list;
}

/** [{ id, points: [[x, y, z], ...] }]: each spring object's tip from `length` - 1 frames before `frame` up to it, oldest first. */
export function tipTrails(view, frame, length = TRAIL_FRAMES) {
	const last = Math.max(0, Math.min(view.out.frames.length - 1, Math.round(frame) || 0));
	return springTips(view).map(({ id, local }) => {
		const points = [];
		for (let f = Math.max(0, last - length + 1); f <= last; f++) {
			const pose = trackPose(view.take.objects[id], f);
			if (pose) points.push(add(pose.pos, apply(pose.R, local)));
		}
		return { id, points };
	});
}
