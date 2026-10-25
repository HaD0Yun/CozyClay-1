// The physics overlay (physics-overlay.js) over the active character's take v3. It lives on SHOT_LAYER: the shot
// camera, the editor and pose views draw it, and so do captures, contact sheets and exports (the capture camera
// drops only GIZMO_LAYER), never the top view. Off by default; motion.physicsOverlay and the motion controls'
// Physics box turn it on (physics-overlay-settings.js). Every rendered frame poses it for the playhead; the export
// path poses it for the frame it records (syncPhysicsOverlays), so scrub, playback and export agree.
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { SHOT_LAYER } from "./dualview.jsx";
import { PhysicsOverlay, addPhysicsOverlaySync } from "./physics-overlay.js";
import { physicsView } from "./motion3/physics-view.js";
import { isTakeV3 } from "./motion3/playback.js";
import { playbackFrame } from "./motion/playback-frame-store.js";
import { physicsOverlayOn, physicsOverlaySettings, usePhysicsOverlaySettings } from "./physics-overlay-settings.js";

const compiled = new THREE.Matrix4(), placement = new THREE.Matrix4();

/** From where `take` was compiled (take.placement) to where the rig's parent (the character's placement) stands now. */
function placementOf(rig, take) {
	const at = take.placement?.position ?? [0, 0, 0];
	compiled.makeRotationY(((take.placement?.yaw ?? 0) * Math.PI) / 180).setPosition(at[0], at[1], at[2]).invert();
	rig.parent.updateWorldMatrix(true, false);
	return placement.multiplyMatrices(rig.parent.matrixWorld, compiled);
}

/** rig: the active character's live rig; take: its installed motion; objects: the authored records. */
export function PhysicsOverlayLayer({ rig, take, objects }) {
	const settings = usePhysicsOverlaySettings();
	const scene = useThree((state) => state.scene), invalidate = useThree((state) => state.invalidate);
	const overlay = useMemo(() => new PhysicsOverlay({ layer: SHOT_LAYER }), []);
	const on = physicsOverlayOn(settings) && !!rig && isTakeV3(take);
	const view = useMemo(() => (on ? physicsView(take, objects) : null), [on, take, objects]);
	const latest = useRef({});
	useEffect(() => { latest.current = { rig, take, view }; });
	useEffect(() => {
		if (!on) return undefined;
		scene.add(overlay.object);
		return () => { scene.remove(overlay.object); };
	}, [on, scene, overlay]);
	useEffect(() => () => overlay.dispose(), [overlay]);
	useEffect(() => { invalidate(); }, [invalidate, settings, view]);
	const sync = useMemo(() => (frame) => {
		const { rig: body, take: shown, view: measured } = latest.current;
		const ready = measured && body?.parent;
		return overlay.update({ view: ready ? measured : null, frame: frame ?? playbackFrame(), placement: ready ? placementOf(body, shown) : null, settings: physicsOverlaySettings() });
	}, [overlay]);
	useEffect(() => {
		// QA hook: the overlay, what it drew last, and a way to pose it for a frame
		if (typeof window !== "undefined") window.__cozyclayPhysics = { overlay, sync, drawn: () => overlay.last };
		return addPhysicsOverlaySync(sync);
	}, [overlay, sync]);
	useFrame(() => { sync(null); });
	return null;
}
