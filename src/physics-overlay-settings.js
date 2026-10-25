// Which parts of the physics overlay (physics-overlay.js) the viewer wants: the centre of mass, the support
// polygon, the air runs' arcs and the spring objects' trails. Off by default; a viewer setting like the onion
// skin's (view-ghosts.js): never saved in the scene, never undone, gone with the session. motion.physicsOverlay
// (commands/physics.js) and the motion controls' Physics box (physics-toggle.jsx) both set it here.
import { useSyncExternalStore } from "react";

const PHYSICS_PARTS = Object.freeze(["com", "support", "arc", "trail"]);
const OFF = Object.freeze({ com: false, support: false, arc: false, trail: false });

let settings = OFF;
const listeners = new Set();

/** The current setting { com, support, arc, trail } (booleans). */
export const physicsOverlaySettings = () => settings;
/** True when any part is on. */
export const physicsOverlayOn = (value = settings) => PHYSICS_PARTS.some(part => value[part]);

/**
 * Apply args { all?, com?, support?, arc?, trail? }: `all` sets every part first, then each named part is set;
 * no field at all turns every part on. Answers the new setting.
 */
export function setPhysicsOverlay(args = {}) {
	const named = PHYSICS_PARTS.filter(part => typeof args[part] === "boolean");
	const base = typeof args.all === "boolean" ? Object.fromEntries(PHYSICS_PARTS.map(part => [part, args.all])) : named.length ? settings : { com: true, support: true, arc: true, trail: true };
	const next = Object.freeze({ ...base, ...Object.fromEntries(named.map(part => [part, args[part]])) });
	if (PHYSICS_PARTS.every(part => next[part] === settings[part])) return settings;
	settings = next;
	for (const listener of [...listeners]) listener();
	return settings;
}

/** "Physics overlay: centre of mass, support polygon on; arcs, trails off." */
export function describePhysicsOverlay(value = settings) {
	const words = { com: "centre of mass", support: "support polygon", arc: "air arcs", trail: "spring trails" };
	const on = PHYSICS_PARTS.filter(part => value[part]).map(part => words[part]), off = PHYSICS_PARTS.filter(part => !value[part]).map(part => words[part]);
	if (!on.length) return "Physics overlay off.";
	return `Physics overlay: ${on.join(", ")} on${off.length ? `; ${off.join(", ")} off` : ""}.`;
}

const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
export const usePhysicsOverlaySettings = () => useSyncExternalStore(subscribe, physicsOverlaySettings, physicsOverlaySettings);
