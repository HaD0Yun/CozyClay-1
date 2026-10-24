// The viewport's onion-skin ghosts (ghost-set.js) of the active character's take v3. They live on
// GIZMO_LAYER: the working views draw them, while the shot preview card, PlayView, captures,
// contact sheets and exports never do. Off by default; view.setGhosts and the View menu's Ghosts
// group turn them on (view-ghosts.js holds that setting).
import { useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { GIZMO_LAYER } from "./dualview.jsx";
import { GhostSet } from "./ghost-set.js";
import { isTakeV3 } from "./motion3/playback.js";
import { playbackFrame, usePlaybackSnapshot } from "./motion/playback-frame-store.js";
import { ghostFrames, takeKeyFrames, useGhostSettings } from "./view-ghosts.js";

// Kit parts mount in the same commit as a take or record change, sometimes a frame later: the
// carried meshes are collected again on the next frames too.
const SOURCE_PASSES = 3;

/**
 * rig: the active character's live rig; take: its installed motion; frame: the playhead;
 * objects: the authored records; propTake: { frameCount, fps, objectTracks } as SetProps gets it.
 */
export function ViewGhosts({ rig, take, objects, propTake }) {
	const liveFrame = usePlaybackSnapshot(playbackFrame);
	const settings = useGhostSettings();
	const scene = useThree((state) => state.scene), gl = useThree((state) => state.gl), invalidate = useThree((state) => state.invalidate);
	const set = useMemo(() => new GhostSet({ layer: GIZMO_LAYER }), []);
	const on = settings.mode !== "off" && !!rig && isTakeV3(take);
	const keyFrames = useMemo(() => (on && settings.mode === "keys" ? takeKeyFrames(take, objects) : []), [on, settings.mode, take, objects]);
	const entries = useMemo(() => (on ? ghostFrames({ frame: liveFrame, last: take.frameCount - 1, ...settings, keyFrames }) : []),
		[on, liveFrame, take, settings, keyFrames]);
	useEffect(() => {
		if (!on) return undefined;
		scene.add(set.object);
		return () => { scene.remove(set.object); };
	}, [on, scene, set]);
	useEffect(() => () => set.dispose(), [set]);
	// The canvas may render on demand: a new ghost frame set is a reason to draw.
	useEffect(() => { invalidate(); }, [invalidate, on, entries]);
	useEffect(() => {
		// QA hook (test/qa-view-ghosts-browser.mjs): the live set and the renderer it draws with.
		if (typeof window !== "undefined") window.__cozyclayGhosts = { set, gl, scene, entries };
	}, [set, gl, scene, entries]);
	useFrame(() => {
		// A rig that left the stage (a hidden cast member) keeps no ghosts on it.
		if (!set.show(on && !!rig.parent)) return;
		set.setRig(rig);
		set.syncSources(scene, objects, take, SOURCE_PASSES);
		rig.parent.updateWorldMatrix(true, false);
		set.update({ entries, take, placement: rig.parent.matrixWorld, propTake, objects, count: settings.count });
	});
	return null;
}
